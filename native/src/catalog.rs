//! App catalog/search response handling.
//!
//! The original CommonJS adapter (`service/discover.cjs`) does two separate
//! things: it builds a signed request and it validates/normalizes the response.
//! This module owns the latter and exposes the same route-shaped entry point to
//! the native loopback server.  The signer is deliberately not reimplemented
//! here: sending an unsigned request to these endpoints is indistinguishable
//! from a protocol failure and would hide an upstream contract problem.

use serde_json::{Map, Value, json};

use crate::{ServiceError, metadata_protocol};

const GENRE_SCENES: &[(&str, &str)] = &[
    ("short_play", "default"),
    ("comic_series", "comic_series"),
    ("ai_series", "ai_series"),
];

const SELECTOR_LABELS: &[(&str, &str)] = &[
    ("genre", "类型"),
    ("category_dim_theme", "题材"),
    ("category_dim_role", "设定"),
    ("category_dim_epoch", "背景"),
    ("sort", "排序"),
    ("gender", "受众"),
    ("online_time", "时间"),
];

#[derive(Clone)]
struct RankConfig {
    outer: String,
    sub: String,
    content_types: &'static [i64],
}

const ALL_TYPES: &[i64] = &[1, 1004];
const HUMAN_TYPES: &[i64] = &[1];
const COMIC_TYPES: &[i64] = &[1004];

fn rank_config(name: &str) -> Option<RankConfig> {
    Some(match name {
        "hot-drama" => RankConfig {
            outer: "all".into(),
            sub: "ranklist_hot_play_sc".into(),
            content_types: ALL_TYPES,
        },
        "hot-real-drama" => RankConfig {
            outer: "human".into(),
            sub: "human_hot_play".into(),
            content_types: HUMAN_TYPES,
        },
        "hot-comic-drama" => RankConfig {
            outer: "comic_series_rank".into(),
            sub: "comic_series_hot_play".into(),
            content_types: COMIC_TYPES,
        },
        "hot-ai-drama" => RankConfig {
            outer: "ai_playlet".into(),
            sub: "ai_playlet_hot_play".into(),
            content_types: COMIC_TYPES,
        },
        _ => return None,
    })
}

fn text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.trim().to_owned(),
        Some(Value::Number(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn array(value: Option<&Value>) -> Option<&Vec<Value>> {
    value.and_then(Value::as_array)
}

fn integer(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(value)) => value.as_i64().or_else(|| value.to_string().parse().ok()),
        Some(Value::String(value)) => value.trim().parse().ok(),
        _ => None,
    }
}

fn non_negative_integer(value: Option<&Value>) -> Option<i64> {
    integer(value).filter(|value| *value >= 0)
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 30 && value.bytes().all(|byte| byte.is_ascii_digit())
}

/// Converts the official HEIC thumbnail form to the JPEG form accepted by the
/// NSH image view.  Other HTTP URLs are retained only when HTTPS, matching the
/// Node adapter's security boundary.
pub(crate) fn catalog_cover(value: Option<&Value>) -> String {
    let raw = text(value);
    if raw.is_empty() || raw.chars().any(char::is_whitespace) {
        return String::new();
    }
    let Some((scheme, rest)) = raw.split_once("://") else {
        return String::new();
    };
    let Some((host_port, path_and_query)) = rest.split_once('/') else {
        return String::new();
    };
    let host = host_port
        .split(':')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let (path, suffix) = path_and_query
        .split_once('?')
        .map_or((path_and_query, ""), |v| v);
    if path.to_ascii_lowercase().ends_with(".heic") {
        let trusted_host = host == "fqnovelpic.com"
            || host.ends_with(".fqnovelpic.com")
            || host == "byteimg.com"
            || host.ends_with(".byteimg.com");
        if !trusted_host || !path.starts_with("novel-pic/") || !path.contains('~') {
            return String::new();
        }
        let base = path.split('~').next().unwrap_or_default();
        return format!("https://p3-novel.byteimg.com/{base}~tplv-shrink:640:0.image");
    }
    if scheme.eq_ignore_ascii_case("https") {
        let suffix = if suffix.is_empty() {
            String::new()
        } else {
            format!("?{suffix}")
        };
        return format!("https://{host_port}/{path}{suffix}");
    }
    String::new()
}

fn tags(value: Option<&Value>) -> Vec<String> {
    array(value)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    item.as_str()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn subtitle_tags(value: Option<&Value>) -> Vec<String> {
    array(value)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let value = object(Some(item))
                        .and_then(|row| row.get("content"))
                        .map(|content| text(Some(content)))
                        .unwrap_or_default();
                    (!value.is_empty()).then_some(value)
                })
                .take(4)
                .collect()
        })
        .unwrap_or_default()
}

fn parse_search_item(raw: &Value) -> Option<Value> {
    let row = object(Some(raw))?;
    let book = array(row.get("video_data"))
        .and_then(|items| items.first())
        .and_then(Value::as_object)
        .or_else(|| {
            array(row.get("book_data"))
                .and_then(|items| items.first())
                .and_then(Value::as_object)
        })
        .or_else(|| object(row.get("series_info")))
        .unwrap_or(row);
    let id = text(book.get("series_id").or_else(|| book.get("book_id")));
    let title = text(
        book.get("series_name")
            .or_else(|| book.get("book_name"))
            .or_else(|| book.get("series_title"))
            .or_else(|| book.get("title")),
    );
    if !valid_id(&id) || title.is_empty() {
        return None;
    }
    let episode_count = non_negative_integer(
        book.get("episode_cnt")
            .or_else(|| book.get("serial_count"))
            .or_else(|| book.get("total_episode")),
    )
    .unwrap_or(0);
    let tag_values = if array(book.get("tags")).is_some() {
        tags(book.get("tags"))
    } else {
        subtitle_tags(book.get("sub_title_list"))
    };
    Some(json!({
        "id": id,
        "title": title,
        "cover": catalog_cover(book.get("cover").or_else(|| book.get("thumb_url")).or_else(|| book.get("series_cover"))),
        "episodes": if episode_count > 0 { episode_count } else { 0 },
        "score": text(book.get("score")),
        "tags": tag_values,
    }))
}

fn parse_search_response(payload: &Value) -> Result<Value, ServiceError> {
    let root = object(Some(payload))
        .ok_or_else(|| ServiceError::new("INVALID_RESPONSE", "App 搜索返回格式异常"))?;
    let tabs = array(root.get("search_tabs"))
        .or_else(|| object(root.get("data")).and_then(|data| array(data.get("search_tabs"))));
    let mut items = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut has_more = false;
    let mut next_cursor = Value::Null;
    if let Some(tabs) = tabs {
        for tab in tabs {
            let Some(tab) = tab.as_object() else { continue };
            if tab.get("has_more").and_then(Value::as_bool) == Some(true) {
                has_more = true;
            }
            if tab.contains_key("search_id")
                || tab.contains_key("passback")
                || tab.contains_key("next_offset")
            {
                let mut cursor = Map::new();
                if let Some(value) = tab.get("search_id") {
                    let value = text(Some(value));
                    if !value.is_empty() {
                        cursor.insert("search_id".into(), Value::String(value));
                    }
                }
                if let Some(value) = tab.get("passback") {
                    let value = text(Some(value));
                    if !value.is_empty() {
                        cursor.insert("passback".into(), Value::String(value));
                    }
                }
                if let Some(value) = non_negative_integer(tab.get("next_offset")) {
                    cursor.insert("next_offset".into(), json!(value));
                }
                next_cursor = Value::Object(cursor);
            }
            if let Some(list) = array(tab.get("data")) {
                for entry in list {
                    if let Some(item) = parse_search_item(entry) {
                        let id = item.get("id").and_then(Value::as_str).unwrap_or_default();
                        if seen.insert(id.to_owned()) {
                            items.push(item);
                        }
                    }
                }
            }
        }
    }
    if items.is_empty() {
        if let Some(data) = object(root.get("data")) {
            if let Some(list) = array(data.get("book_list")) {
                for entry in list {
                    if let Some(item) = parse_search_item(entry) {
                        let id = item.get("id").and_then(Value::as_str).unwrap_or_default();
                        if seen.insert(id.to_owned()) {
                            items.push(item);
                        }
                    }
                }
            }
            has_more |= data
                .get("has_more")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        }
    }
    Ok(json!({ "items": items, "hasMore": has_more, "cursor": next_cursor }))
}

fn parse_catalog_card(raw: &Value, allowed: Option<&[i64]>) -> Option<Value> {
    let row = raw.as_object()?;
    let id = text(row.get("series_id"));
    let title = text(
        row.get("title")
            .or_else(|| row.get("series_title"))
            .or_else(|| row.get("series_name")),
    );
    if !valid_id(&id) || title.is_empty() {
        return None;
    }
    if let Some(types) = allowed {
        if !types.contains(&integer(row.get("content_type")).unwrap_or_default()) {
            return None;
        }
    }
    let tags = subtitle_tags(row.get("sub_title_list"));
    let badge = text(object(row.get("tag_info")).and_then(|tag| tag.get("text")));
    let mut item = json!({
        "id": id,
        "title": title,
        "cover": catalog_cover(row.get("cover").or_else(|| row.get("series_cover"))),
        "episodes": non_negative_integer(row.get("episode_cnt")).unwrap_or(0),
        "score": text(row.get("score")),
        "tags": tags,
    });
    if !badge.is_empty() {
        item["badge"] = Value::String(badge);
    }
    Some(item)
}

fn selector_groups(rows: Option<&Value>) -> Vec<Value> {
    let mut groups = Vec::new();
    for row in array(rows).into_iter().flatten() {
        let Some(row) = row.as_object() else { continue };
        let kind = text(row.get("type"));
        let Some(label) = SELECTOR_LABELS
            .iter()
            .find(|(key, _)| *key == kind)
            .map(|(_, label)| *label)
        else {
            continue;
        };
        let mut seen = std::collections::HashSet::new();
        let mut items = Vec::new();
        for entry in array(row.get("items")).into_iter().flatten() {
            let Some(entry) = entry.as_object() else {
                continue;
            };
            let id = text(entry.get("selector_item_id"));
            let item_label = text(entry.get("show_name"));
            if id.is_empty() || item_label.is_empty() || !seen.insert(id.clone()) {
                continue;
            }
            items.push(json!({ "id": id, "label": item_label }));
        }
        if !items.is_empty() {
            groups.push(json!({ "type": kind, "label": label, "items": items }));
        }
    }
    groups
}

fn parse_category_response(payload: &Value) -> Result<Value, ServiceError> {
    let root = object(Some(payload))
        .ok_or_else(|| ServiceError::new("INVALID_RESPONSE", "App 分类目录返回异常"))?;
    if integer(root.get("code")) != Some(0) {
        return Err(ServiceError::new(
            "INVALID_RESPONSE",
            "App 分类目录返回异常",
        ));
    }
    let data = object(root.get("data"))
        .ok_or_else(|| ServiceError::new("INVALID_RESPONSE", "App 分类目录结构异常"))?;
    let list = array(data.get("video_data"))
        .ok_or_else(|| ServiceError::new("INVALID_RESPONSE", "App 分类目录结构异常"))?;
    let mut items = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in list {
        if let Some(item) = parse_catalog_card(row, None) {
            let id = item.get("id").and_then(Value::as_str).unwrap_or_default();
            if seen.insert(id.to_owned()) {
                items.push(item);
            }
        }
    }
    Ok(json!({
        "items": items,
        "selectors": selector_groups(data.get("selector_rows")),
        "hasMore": data.get("has_more").and_then(Value::as_bool).unwrap_or(false),
        "nextOffset": non_negative_integer(data.get("next_offset")).unwrap_or(0),
        "sessionId": text(data.get("session_id")),
    }))
}

fn rank_selectors(cell_selector: Option<&Value>) -> Vec<Value> {
    let Some(outer) = object(cell_selector)
        .and_then(|row| object(row.get("outer_row")))
        .and_then(|row| array(row.get("items")))
    else {
        return Vec::new();
    };
    let mut groups = Vec::new();
    for row in outer {
        let Some(row) = row.as_object() else { continue };
        let id = text(row.get("selector_item_id"));
        let label = text(row.get("show_name"));
        if id.is_empty() || label.is_empty() {
            continue;
        }
        let mut items = Vec::new();
        if let Some(sub) = object(row.get("sub_cell_selector"))
            .and_then(|value| object(value.get("outer_row")))
            .and_then(|value| array(value.get("items")))
        {
            for item in sub {
                let Some(item) = item.as_object() else {
                    continue;
                };
                let sub_id = text(item.get("selector_item_id"));
                let sub_label = text(item.get("show_name"));
                if !sub_id.is_empty() && !sub_label.is_empty() {
                    items.push(json!({ "id": sub_id, "label": sub_label, "subTitle": text(item.get("sub_title")) }));
                }
            }
        }
        if !items.is_empty() {
            groups.push(json!({ "id": id, "label": label, "items": items }));
        }
    }
    groups
}

fn parse_rank_response(payload: &Value, config: RankConfig) -> Result<Value, ServiceError> {
    let root = object(Some(payload))
        .ok_or_else(|| ServiceError::new("INVALID_RESPONSE", "App 榜单返回异常"))?;
    if integer(root.get("code")) != Some(0) {
        return Err(ServiceError::new("INVALID_RESPONSE", "App 榜单返回异常"));
    }
    let view = object(root.get("data"))
        .and_then(|data| object(data.get("cell_view")))
        .ok_or_else(|| ServiceError::new("INVALID_RESPONSE", "App 榜单结构异常"))?;
    if array(view.get("cell_data")).is_none() {
        return Err(ServiceError::new("INVALID_RESPONSE", "App 榜单结构异常"));
    }
    let selected = object(view.get("cell_selector"))
        .and_then(|value| object(value.get("outer_row")))
        .and_then(|value| array(value.get("items")))
        .and_then(|items| {
            items.iter().find(|item| {
                object(Some(item))
                    .and_then(|row| row.get("is_selected"))
                    .and_then(Value::as_bool)
                    == Some(true)
            })
        });
    let child = object(selected)
        .and_then(|value| object(value.get("sub_cell_selector")))
        .and_then(|value| object(value.get("outer_row")))
        .and_then(|value| array(value.get("items")))
        .and_then(|items| {
            items.iter().find(|item| {
                object(Some(item))
                    .and_then(|row| row.get("is_selected"))
                    .and_then(Value::as_bool)
                    == Some(true)
            })
        });
    if let Some(selected) = selected {
        let selected_id =
            text(object(Some(selected)).and_then(|value| value.get("selector_item_id")));
        let child_id = child
            .and_then(|child| object(Some(child)))
            .map(|value| text(value.get("selector_item_id")))
            .unwrap_or_default();
        if selected_id != config.outer || child_id != config.sub {
            return Err(ServiceError::new("INVALID_RESPONSE", "App 返回了其他榜单"));
        }
    }
    let mut rows = Vec::new();
    if let Some(cells) = array(view.get("cell_data")) {
        for cell in cells {
            if let Some(data) = object(Some(cell)).and_then(|value| value.get("video_data")) {
                if let Some(data) = data.as_array() {
                    rows.extend(data.iter());
                } else {
                    rows.push(data);
                }
            }
        }
    }
    let mut items = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        if let Some(item) = parse_catalog_card(row, Some(config.content_types)) {
            let id = item.get("id").and_then(Value::as_str).unwrap_or_default();
            if seen.insert(id.to_owned()) {
                items.push(item);
            }
        }
    }
    Ok(json!({
        "items": items,
        "selectors": rank_selectors(view.get("cell_selector")),
        "subTitle": text(object(child).and_then(|value| value.get("sub_title"))),
        "hasMore": view.get("has_more").and_then(Value::as_bool).unwrap_or(false),
        "nextOffset": non_negative_integer(view.get("next_offset")).unwrap_or(0),
        "sessionId": text(view.get("session_id")),
    }))
}

#[cfg(test)]
fn fixture(input: &Value) -> Option<&Value> {
    input.get("_payload").or_else(|| input.get("payload"))
}

#[cfg(not(test))]
fn fixture(_: &Value) -> Option<&Value> {
    None
}

/// Dispatches catalog routes. Tests may pass a response fixture as `_payload`;
/// release builds always use the signed metadata transport.
pub(crate) async fn handle(path: &str, input: Value) -> Result<Value, ServiceError> {
    match path {
        "/search" => {
            let keyword = text(input.get("keyword"));
            if keyword.is_empty() {
                return Err(ServiceError::new("APP_INPUT", "请输入搜索关键词"));
            }
            // The web adapter caps the signed query at 80 UTF-16 units. Rust
            // keeps the same practical bound in Unicode scalar values.
            let keyword = keyword.chars().take(80).collect::<String>();
            if let Some(payload) = fixture(&input) {
                return parse_search_response(payload);
            }
            let page = non_negative_integer(input.get("page")).unwrap_or(1);
            if !(1..=50).contains(&page) {
                return Err(ServiceError::new(
                    "APP_INPUT",
                    "App 搜索页码需为 1 至 50 的整数",
                ));
            }
            let cursor = input.get("cursor").and_then(Value::as_object);
            let offset = cursor
                .and_then(|cursor| non_negative_integer(cursor.get("next_offset")))
                .unwrap_or((page - 1) * 20) as usize;
            let search_id = cursor
                .map(|cursor| text(cursor.get("search_id")))
                .unwrap_or_default();
            let passback = cursor
                .map(|cursor| text(cursor.get("passback")))
                .unwrap_or_default();
            let response =
                metadata_protocol::search(&keyword, offset, &search_id, &passback).await?;
            parse_search_response(&response)
        }
        "/discover/category" => {
            let genre = text(input.get("genre"));
            if let Some(payload) = fixture(&input) {
                return parse_category_response(payload);
            }
            let genre = if GENRE_SCENES.iter().any(|(key, _)| *key == genre) {
                genre
            } else {
                "short_play".to_owned()
            };
            let offset = non_negative_integer(input.get("offset")).unwrap_or(0);
            let limit = non_negative_integer(input.get("limit"))
                .unwrap_or(20)
                .clamp(1, 50);
            let scene = GENRE_SCENES
                .iter()
                .find(|(key, _)| *key == genre.as_str())
                .map(|(_, scene)| *scene)
                .unwrap_or("default");
            let mut selections = Map::new();
            selections.insert("genre".into(), json!([genre]));
            let sort = text(input.get("sort"));
            selections.insert(
                "sort".into(),
                json!([if sort.is_empty() {
                    "hot_score".to_owned()
                } else {
                    sort
                }]),
            );
            for (field, key) in [
                ("theme", "category_dim_theme"),
                ("role", "category_dim_role"),
                ("epoch", "category_dim_epoch"),
                ("gender", "gender"),
                ("onlineTime", "online_time"),
            ] {
                let value = text(input.get(field));
                selections.insert(
                    key.into(),
                    if value.is_empty() {
                        json!([])
                    } else {
                        json!([value])
                    },
                );
            }
            selections.insert("creation_status".into(), json!([]));
            let payload = json!({
                "filter_ids": "", "req_scene": scene, "offset": offset,
                "need_selector_panel": input.get("needSelectorPanel").and_then(Value::as_bool).unwrap_or(true) && offset == 0,
                "limit": limit, "select_items": selections,
                "session_id": text(input.get("sessionId")), "req_type": if offset > 0 { "only_content" } else { "default" }, "client_req_type": 3
            });
            let response = metadata_protocol::metadata(
                "/reading/distribution/category/landpage/v/",
                vec![],
                Some(payload),
                reqwest::header::HeaderMap::new(),
            )
            .await?;
            parse_category_response(&response)
        }
        "/discover/rank" => {
            let rank_type = text(input.get("rankType"));
            let outer = text(input.get("outerTab"));
            let sub = text(input.get("subTab"));
            let config = if !outer.is_empty() && !sub.is_empty() {
                if !outer
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_')
                    || !sub.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
                {
                    return Err(ServiceError::new("APP_INPUT", "不支持的榜单类型"));
                }
                // Dynamic selector IDs are allowed; content type follows outer tab.
                RankConfig {
                    outer: outer.clone(),
                    sub,
                    content_types: match outer.as_str() {
                        "human" => HUMAN_TYPES,
                        "comic_series_rank" | "ai_playlet" => COMIC_TYPES,
                        _ => ALL_TYPES,
                    },
                }
            } else {
                rank_config(if rank_type.is_empty() {
                    "hot-drama"
                } else {
                    &rank_type
                })
                .ok_or_else(|| ServiceError::new("APP_INPUT", "不支持的榜单类型"))?
            };
            if let Some(payload) = fixture(&input) {
                return parse_rank_response(payload, config);
            }
            let offset = non_negative_integer(input.get("offset")).unwrap_or(0);
            let limit = non_negative_integer(input.get("limit"))
                .unwrap_or(20)
                .clamp(1, 50);
            let values = vec![
                (
                    "tab_type".into(),
                    if offset == 0 { "26" } else { "18" }.into(),
                ),
                ("client_req_type".into(), "2".into()),
                ("client_template".into(), "2".into()),
                ("background_selected_items".into(), "".into()),
                ("category_id".into(), "0".into()),
                ("limit".into(), limit.to_string()),
                ("cell_sub_id".into(), "0".into()),
                ("gender".into(), "2".into()),
                ("cell_id".into(), "7470092475068071998".into()),
                ("selected_items".into(), config.outer.clone()),
                ("sub_selected_items".into(), config.sub.clone()),
                ("panel_selected_items".into(), "".into()),
                ("offset".into(), offset.to_string()),
                ("session_id".into(), text(input.get("sessionId"))),
                ("filter_ids".into(), "".into()),
                ("unlimited_selector_change_type".into(), "0".into()),
            ];
            let response = metadata_protocol::metadata(
                "/reading/bookapi/bookmall/cell/change/v",
                values,
                None,
                reqwest::header::HeaderMap::new(),
            )
            .await?;
            parse_rank_response(&response, config)
        }
        _ => Err(ServiceError::new("NOT_FOUND", "请求地址不存在")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_only_trusted_heic_covers() {
        assert_eq!(
            catalog_cover(Some(&Value::String(
                "https://p1.byteimg.com/novel-pic/a~x.heic".into()
            ))),
            "https://p3-novel.byteimg.com/novel-pic/a~tplv-shrink:640:0.image"
        );
        assert!(
            catalog_cover(Some(&Value::String(
                "https://evil.example/novel-pic/a~x.heic".into()
            )))
            .is_empty()
        );
        assert!(
            catalog_cover(Some(&Value::String("http://p1.byteimg.com/a.jpg".into()))).is_empty()
        );
    }

    #[tokio::test]
    async fn parses_search_fixture_without_number_loss() {
        let payload = json!({"search_tabs":[{"data":[{"series_info":{"series_id":12345678901234567890u128,"series_name":"剧"}}]}]});
        let value = handle("/search", json!({"keyword":"剧", "_payload":payload}))
            .await
            .unwrap();
        assert_eq!(value["items"][0]["id"], "12345678901234567890");
    }
}
