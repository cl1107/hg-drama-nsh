//! Timeline danmaku response handling.
//!
//! Parsing is kept independent of the request signer so recorded upstream
//! responses can be tested without network access. The live signed request is
//! an explicit protocol boundary, matching the catalog/auth modules.

use std::collections::HashSet;

use serde_json::{Map, Value, json};

use crate::{ServiceError, metadata_protocol};

const DEFAULT_WINDOW_MS: i64 = 30_000;
const DEFAULT_DURATION_MS: i64 = 120_000;

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

fn number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(value)) => value.as_f64().or_else(|| value.to_string().parse().ok()),
        Some(Value::String(value)) => value.trim().parse().ok(),
        _ => None,
    }
}

fn integer(value: Option<&Value>) -> Option<i64> {
    number(value)
        .filter(|value| value.is_finite())
        .map(f64::floor)
        .and_then(|value| i64::try_from(value as i128).ok())
}

fn id(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.trim().to_owned(),
        Some(Value::Number(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn cursor(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(Value::Object(value)) => Some(Value::Object(value.clone())),
        Some(Value::String(value)) if !value.trim().is_empty() => {
            serde_json::from_str(value).ok().filter(Value::is_object)
        }
        _ => None,
    }
}

fn safe_start(value: Option<&Value>) -> i64 {
    integer(value).unwrap_or(0).max(0)
}

fn parse_response(payload: &Value, start_ms: i64) -> Result<Value, ServiceError> {
    let root = object(Some(payload))
        .ok_or_else(|| ServiceError::new("INVALID_RESPONSE", "弹幕接口返回格式异常"))?;
    if !matches!(root.get("code"), Some(Value::Number(value)) if value.as_i64() == Some(0)) {
        let message = text(root.get("message"));
        return Err(ServiceError::new(
            "UPSTREAM_ERROR",
            if message.is_empty() {
                "弹幕接口返回异常"
            } else {
                &message
            },
        ));
    }
    let data = object(root.get("data"));
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    for entry in array(data.and_then(|data| data.get("data_list")))
        .into_iter()
        .flatten()
    {
        let Some(entry) = entry.as_object() else {
            continue;
        };
        let Some(comment) = object(entry.get("comment")) else {
            continue;
        };
        let comment_id = id(comment.get("comment_id"));
        let content = object(comment.get("common"))
            .and_then(|common| object(common.get("content")))
            .map(|content| text(content.get("text")))
            .unwrap_or_default();
        let Some(time) =
            number(object(comment.get("expand")).and_then(|expand| expand.get("offset_time")))
        else {
            continue;
        };
        if comment_id.is_empty()
            || content.is_empty()
            || !time.is_finite()
            || time < 0.0
            || !seen.insert(comment_id.clone())
        {
            continue;
        }
        let like_count =
            integer(object(comment.get("stat")).and_then(|stat| stat.get("digg_count")))
                .unwrap_or(0)
                .max(0);
        items.push((time.floor() as i64, comment_id.clone(), json!({ "id": comment_id, "text": content, "timeMs": time.floor() as i64, "likeCount": like_count })));
    }
    items.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    let item_values: Vec<Value> = items.into_iter().map(|(_, _, value)| value).collect();
    let info = data.and_then(|data| object(data.get("common_list_info")));
    let cursor = cursor(info.and_then(|info| info.get("cursor")));
    let extra_next = integer(
        data.and_then(|data| object(data.get("extra")))
            .and_then(|extra| extra.get("next_query_danmaku_list_time")),
    );
    let cursor_end = integer(
        cursor
            .as_ref()
            .and_then(|cursor| cursor.get("end_offset_time")),
    );
    let next_ms = extra_next
        .filter(|value| *value > start_ms)
        .or_else(|| cursor_end.filter(|value| *value > start_ms))
        .unwrap_or(start_ms.saturating_add(DEFAULT_WINDOW_MS));
    let total = integer(
        cursor
            .as_ref()
            .and_then(|cursor| cursor.get("danmaku_count")),
    )
    .filter(|value| *value >= 0)
    .or_else(|| integer(info.and_then(|info| info.get("total"))).filter(|value| *value >= 0))
    .unwrap_or(item_values.len() as i64);
    Ok(json!({ "items": item_values, "nextMs": next_ms, "total": total }))
}

fn valid_id(value: Option<&Value>) -> bool {
    let value = text(value);
    !value.is_empty() && value.len() <= 30 && value.bytes().all(|byte| byte.is_ascii_digit())
}

#[cfg(test)]
fn fixture(input: &Value) -> Option<&Value> {
    input.get("_payload").or_else(|| input.get("payload"))
}

#[cfg(not(test))]
fn fixture(_: &Value) -> Option<&Value> {
    None
}

/// Handles `POST /danmaku`. A `_payload`/`payload` field is accepted only as a
/// test fixture; release requests use the signed metadata transport.
pub(crate) async fn handle(path: &str, input: Value) -> Result<Value, ServiceError> {
    if path != "/danmaku" {
        return Err(ServiceError::new("NOT_FOUND", "请求地址不存在"));
    }
    if !valid_id(input.get("seriesId")) || !valid_id(input.get("episodeId")) {
        return Err(ServiceError::new("INVALID_REQUEST", "剧集或分集编号无效"));
    }
    let start_ms = safe_start(input.get("startMs"));
    if let Some(payload) = fixture(&input) {
        return parse_response(payload, start_ms);
    }
    let series_id = text(input.get("seriesId"));
    let episode_id = text(input.get("episodeId"));
    let duration_ms = safe_start(input.get("durationMs"));
    let duration_ms = if duration_ms > 0 {
        duration_ms
    } else {
        DEFAULT_DURATION_MS
    };
    let payload = json!({
        "comment_source": 601,
        "server_channel": 1000,
        "group_id": episode_id,
        "group_type": 30,
        "comment_type": 20,
        "sort": 1,
        "business_param": {
            "book_id": series_id,
            "start_offset_time": start_ms,
            "playlet_item_duration": duration_ms,
            "need_danmaku_guide_type": [48]
        },
        "count": 90,
        "cursor": "0",
        "aid": 8662,
        "compliance_status": 0
    });
    let response = metadata_protocol::metadata(
        &format!("/novel/commentapi/comment/list/{episode_id}/v1/"),
        vec![
            ("comment-source".into(), "601".into()),
            ("server-channel".into(), "1000".into()),
        ],
        Some(payload),
        reqwest::header::HeaderMap::new(),
    )
    .await?;
    parse_response(&response, start_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn parses_and_deduplicates_timeline_comments() {
        let payload = json!({
            "code": 0,
            "data": {
                "data_list": [
                    {"comment":{"comment_id":"c2","common":{"content":{"text":"晚安"}},"expand":{"offset_time":1000.9},"stat":{"digg_count":3}}},
                    {"comment":{"comment_id":"c1","common":{"content":{"text":"先到"}},"expand":{"offset_time":1000},"stat":{"digg_count":-1}}},
                    {"comment":{"comment_id":"c1","common":{"content":{"text":"重复"}},"expand":{"offset_time":900}}}
                ],
                "extra":{"next_query_danmaku_list_time":30000},
                "common_list_info":{"cursor":"{\"end_offset_time\":5000,\"danmaku_count\":9}"}
            }
        });
        let value = handle(
            "/danmaku",
            json!({"seriesId":"10","episodeId":"11","startMs":0,"_payload":payload}),
        )
        .await
        .unwrap();
        assert_eq!(value["items"].as_array().unwrap().len(), 2);
        assert_eq!(value["items"][0]["id"], "c1");
        assert_eq!(value["nextMs"], 30000);
        assert_eq!(value["total"], 9);
    }

    #[tokio::test]
    async fn rejects_bad_ids_before_protocol() {
        let error = handle("/danmaku", json!({"seriesId":"1e2","episodeId":"2"}))
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "剧集或分集编号无效");
    }
}
