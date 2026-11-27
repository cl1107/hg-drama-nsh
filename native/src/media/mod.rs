// SPDX-License-Identifier: GPL-3.0-only

//! Media preparation primitives shared by the native service.
//!
//! The protocol/source layer owns signed requests and source-model parsing.
//! This module owns the media boundary after a source has been selected:
//! codec/quality ordering, bounded HTTP range assembly, CENC decryption and
//! local byte-range semantics.

mod cenc;
mod range;

pub(crate) use cenc::decrypt_mp4_buffer;
pub(crate) use range::parse_range;

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use reqwest::{
    Client, StatusCode,
    header::{HeaderMap, RANGE, USER_AGENT},
};
use serde_json::{Deserializer, Value, json};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::upstream::{
    DeviceIdentity,
    device::{build_registration_request, parse_registration_response},
    source::{
        PLAYER_HOSTS, SourceVariant, UpstreamRequest, build_legacy_play_request,
        build_v5_play_request, build_video_tab_request, select_all_variants,
    },
};
use crate::{ServiceError, transport};

pub(crate) const MAX_MEDIA_BYTES: usize = 256 * 1024 * 1024;
pub(crate) const CHUNK_BYTES: usize = 1024 * 1024;
pub(crate) const CHUNK_CONCURRENCY: usize = 6;

/// The result handed to the local media server. `metadata` contains only
/// playback metadata and never a content key or signed remote URL.
#[derive(Debug)]
pub(crate) struct Prepared {
    pub(crate) metadata: Value,
    pub(crate) data: Vec<u8>,
}

/// A source variant returned by the protocol layer.
///
/// The protocol agent can construct this from its verified play-model
/// response. Keeping this value object here avoids coupling MP4/download code
/// to the signed request implementation.
#[derive(Debug, Clone)]
pub(crate) struct Variant {
    pub(crate) url: String,
    pub(crate) codec: String,
    pub(crate) quality: String,
    pub(crate) user_agent: String,
    pub(crate) content_key: Option<[u8; 16]>,
}

impl Variant {
    pub(crate) fn from_json(value: &Value) -> Result<Self, ServiceError> {
        let object = value
            .as_object()
            .ok_or_else(|| ServiceError::new("INVALID_REQUEST", "片源参数格式无效"))?;
        let url = object
            .get("url")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| ServiceError::new("INVALID_REQUEST", "片源地址缺失"))?
            .to_owned();
        let codec = object
            .get("codec")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| ServiceError::new("INVALID_REQUEST", "片源编码缺失"))?
            .to_owned();
        let quality = object
            .get("quality")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .unwrap_or("auto")
            .to_owned();
        let user_agent = object
            .get("userAgent")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .unwrap_or("Mozilla/5.0")
            .to_owned();
        let content_key = match object.get("contentKey") {
            None | Some(Value::Null) => None,
            Some(Value::String(hex_key)) if hex_key.is_empty() => None,
            Some(Value::String(hex_key)) => {
                let bytes = hex::decode(hex_key)
                    .map_err(|_| ServiceError::new("INVALID_REQUEST", "片源内容密钥格式无效"))?;
                let key: [u8; 16] = bytes
                    .try_into()
                    .map_err(|_| ServiceError::new("INVALID_REQUEST", "片源内容密钥长度无效"))?;
                Some(key)
            }
            _ => return Err(ServiceError::new("INVALID_REQUEST", "片源内容密钥格式无效")),
        };
        Ok(Self {
            url,
            codec,
            quality,
            user_agent,
            content_key,
        })
    }
}

pub(crate) fn parse_variants_input(value: Option<&Value>) -> Result<Option<Vec<Variant>>, ServiceError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let items = value
        .as_array()
        .filter(|items| !items.is_empty() && items.len() <= 32)
        .ok_or_else(|| ServiceError::new("INVALID_REQUEST", "片源列表无效"))?;
    let variants = items
        .iter()
        .map(Variant::from_json)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(variants))
}

impl TryFrom<SourceVariant> for Variant {
    type Error = ServiceError;

    fn try_from(source: SourceVariant) -> Result<Self, Self::Error> {
        let content_key = source
            .content_key
            .map(|value| {
                let bytes = hex::decode(value)
                    .map_err(|_| ServiceError::new("INVALID_RESPONSE", "片源内容密钥格式无效"))?;
                bytes
                    .try_into()
                    .map_err(|_| ServiceError::new("INVALID_RESPONSE", "片源内容密钥长度无效"))
            })
            .transpose()?;
        Ok(Self {
            url: source.url,
            codec: source.codec,
            quality: source.quality,
            user_agent: source.user_agent,
            content_key,
        })
    }
}

fn codec_rank(codec: &str) -> Option<u8> {
    match codec {
        "h264" => Some(0),
        "hevc" => Some(1),
        "bytevc2" => Some(2),
        _ => None,
    }
}

/// Orders variants within the selected quality tier, preferring codecs the
/// platform player can decode before the application software decoder.
pub(crate) fn order_variants(
    variants: impl IntoIterator<Item = Variant>,
    quality: &str,
) -> Result<Vec<Variant>, ServiceError> {
    let mut compatible: Vec<Variant> = variants
        .into_iter()
        .filter(|variant| codec_rank(&variant.codec).is_some())
        .filter(|variant| quality == "auto" || variant.quality == quality)
        .collect();
    compatible.sort_by_key(|variant| (codec_rank(&variant.codec), variant.quality.clone()));
    if compatible.is_empty() {
        return Err(ServiceError::new(
            "NO_COMPATIBLE_SOURCE",
            "本集没有当前画质的可播放片源",
        ));
    }
    Ok(compatible)
}

const DETAIL_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const DETAIL_CACHE_MAX: usize = 32;
const DETAIL_MAX_BYTES: usize = 4 * 1024 * 1024;
const PLAY_MODEL_MAX_BYTES: usize = 8 * 1024 * 1024;

struct DetailCache {
    entries: VecDeque<(String, Instant, Value)>,
}

static DETAILS: OnceLock<Mutex<DetailCache>> = OnceLock::new();
static DETAIL_INFLIGHT: OnceLock<
    tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::OnceCell<Result<Value, ServiceError>>>>>,
> = OnceLock::new();
static DEVICE: OnceLock<tokio::sync::Mutex<Option<DeviceIdentity>>> = OnceLock::new();

fn detail_cache() -> &'static Mutex<DetailCache> {
    DETAILS.get_or_init(|| {
        Mutex::new(DetailCache {
            entries: VecDeque::new(),
        })
    })
}

fn device_cache() -> &'static tokio::sync::Mutex<Option<DeviceIdentity>> {
    DEVICE.get_or_init(|| tokio::sync::Mutex::new(None))
}

fn detail_inflight() -> &'static tokio::sync::Mutex<
    HashMap<String, Arc<tokio::sync::OnceCell<Result<Value, ServiceError>>>>,
> {
    DETAIL_INFLIGHT.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 30 && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn cached_detail(series_id: &str) -> Option<Value> {
    let mut cache = detail_cache().lock().expect("detail cache lock");
    let position = cache
        .entries
        .iter()
        .position(|(id, expires, _)| id == series_id && *expires > Instant::now())?;
    let value = cache.entries.remove(position)?.2;
    cache.entries.push_back((
        series_id.to_owned(),
        Instant::now() + DETAIL_CACHE_TTL,
        value.clone(),
    ));
    Some(value)
}

fn cache_detail(series_id: &str, value: &Value) {
    let mut cache = detail_cache().lock().expect("detail cache lock");
    cache
        .entries
        .retain(|(id, expires, _)| id != series_id && *expires > Instant::now());
    while cache.entries.len() >= DETAIL_CACHE_MAX {
        cache.entries.pop_front();
    }
    cache.entries.push_back((
        series_id.to_owned(),
        Instant::now() + DETAIL_CACHE_TTL,
        value.clone(),
    ));
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn router_data(body: &[u8]) -> Result<Value, ServiceError> {
    let marker = b"_ROUTER_DATA";
    let marker_at = find_bytes(body, marker)
        .ok_or_else(|| ServiceError::new("INVALID_DETAIL", "剧集页面缺少路由数据"))?;
    let equals_at = body[marker_at + marker.len()..]
        .iter()
        .position(|byte| *byte == b'=')
        .map(|offset| marker_at + marker.len() + offset)
        .ok_or_else(|| ServiceError::new("INVALID_DETAIL", "剧集页面路由数据格式异常"))?;
    let start = body[equals_at + 1..]
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .map(|offset| equals_at + 1 + offset)
        .ok_or_else(|| ServiceError::new("INVALID_DETAIL", "剧集页面路由数据为空"))?;
    let mut stream = Deserializer::from_slice(&body[start..]).into_iter::<Value>();
    stream
        .next()
        .transpose()
        .map_err(|_| ServiceError::new("INVALID_DETAIL", "剧集页面路由数据无效"))?
        .ok_or_else(|| ServiceError::new("INVALID_DETAIL", "剧集页面路由数据为空"))
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn parse_detail(series_id: &str, body: &[u8]) -> Result<Value, ServiceError> {
    let root = router_data(body)?;
    let page = root
        .get("loaderData")
        .and_then(Value::as_object)
        .and_then(|loader| loader.get("player_(series_id)/page"))
        .and_then(Value::as_object)
        .ok_or_else(|| ServiceError::new("INVALID_DETAIL", "剧集页面详情缺失"))?;
    let detail = page
        .get("seriesDetail")
        .and_then(Value::as_object)
        .ok_or_else(|| ServiceError::new("INVALID_DETAIL", "剧集页面详情缺失"))?;
    if page.get("isSuccess").and_then(Value::as_bool) != Some(true)
        || detail.get("series_id").and_then(Value::as_str) != Some(series_id)
    {
        return Err(ServiceError::new("INVALID_DETAIL", "剧集详情格式变化"));
    }
    let title = detail
        .get("series_name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ServiceError::new("INVALID_DETAIL", "剧集标题缺失"))?;
    let raw_episodes = detail
        .get("vid_list")
        .and_then(Value::as_array)
        .filter(|episodes| !episodes.is_empty())
        .ok_or_else(|| ServiceError::new("INVALID_DETAIL", "剧集分集列表缺失"))?;
    let mut episodes = Vec::with_capacity(raw_episodes.len());
    for (index, episode) in raw_episodes.iter().enumerate() {
        let episode_id = episode
            .as_str()
            .filter(|value| valid_id(value))
            .ok_or_else(|| ServiceError::new("INVALID_DETAIL", "剧集分集编号无效"))?;
        episodes.push(json!({"episodeId": episode_id, "index": index + 1}));
    }
    let celebrities = detail
        .get("celebrities")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let object = item.as_object()?;
                    let nickname = object
                        .get("nickname")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())?;
                    Some(json!({
                        "nickname": nickname,
                        "role": object.get("sub_title").and_then(Value::as_str).unwrap_or(""),
                        "avatar": object.get("avatar").and_then(Value::as_str).unwrap_or(""),
                    }))
                })
                .take(8)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(json!({
        "seriesId": series_id,
        "title": title,
        "cover": detail.get("series_cover").and_then(Value::as_str).unwrap_or(""),
        "intro": detail.get("series_intro").and_then(Value::as_str).unwrap_or(""),
        "tags": string_array(detail.get("tags")),
        "episodeText": detail.get("episode_right_text").and_then(Value::as_str).unwrap_or(""),
        "recordNumber": detail.get("record_number").and_then(Value::as_str).unwrap_or(""),
        "celebrities": celebrities,
        "episodes": episodes,
    }))
}

fn now_millis() -> Result<u64, ServiceError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ServiceError::new("ERR_NETWORK", "系统时间无效"))
        .and_then(|duration| {
            u64::try_from(duration.as_millis())
                .map_err(|_| ServiceError::new("ERR_NETWORK", "系统时间超出范围"))
        })
}

async fn request_upstream(
    method: reqwest::Method,
    raw_url: &str,
    domains: &[&str],
    headers: &std::collections::BTreeMap<String, String>,
    body: Option<Vec<u8>>,
    max_bytes: usize,
) -> Result<(StatusCode, HeaderMap, Vec<u8>), ServiceError> {
    let url = transport::checked_url(raw_url, domains)?;
    let client = transport::client()?.clone();
    let mut request = client.request(method, url).timeout(Duration::from_secs(15));
    for (name, value) in headers {
        request = request.header(name.as_str(), value.as_str());
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    let response = request.send().await.map_err(|error| {
        ServiceError::new(
            if error.is_timeout() {
                "ETIMEDOUT"
            } else {
                "ERR_NETWORK"
            },
            if error.is_timeout() {
                "上游请求超时"
            } else {
                "上游请求失败"
            },
        )
    })?;
    let status = response.status();
    let headers = response.headers().clone();
    let body = transport::read_body(response, max_bytes).await?;
    Ok((status, headers, body))
}

async fn register_device() -> Result<DeviceIdentity, ServiceError> {
    let request = build_registration_request(now_millis()? as i64, None, None)?;
    let (status, _, body) = request_upstream(
        reqwest::Method::POST,
        &request.url,
        &["log5-applog-lf.fqnovel.com"],
        &request.headers,
        Some(request.body),
        2 * 1024 * 1024,
    )
    .await?;
    if status != StatusCode::OK {
        return Err(ServiceError::new(
            "DEVICE_REGISTRATION_FAILED",
            format!("匿名播放设备注册失败（HTTP {status}）"),
        ));
    }
    let value: Value = serde_json::from_slice(&body)
        .map_err(|_| ServiceError::new("INVALID_RESPONSE", "设备注册响应不是有效 JSON"))?;
    let mut registration = parse_registration_response(&value)?.identity;
    // The JS baseline keeps the locally generated registration cdid. Some
    // successful responses omit `cdid`, and a later playback request must use
    // the same value that was bound into the registration envelope.
    registration.cdid = request.cdid;
    Ok(registration)
}

pub(crate) async fn playback_device() -> Result<DeviceIdentity, ServiceError> {
    let mut cache = device_cache().lock().await;
    if let Some(identity) = cache.as_ref() {
        return Ok(identity.clone());
    }
    let identity = register_device().await?;
    *cache = Some(identity.clone());
    Ok(identity)
}

fn parse_play_model(response: &Value, vid: &str) -> Result<Value, ServiceError> {
    let code = response
        .get("Code")
        .or_else(|| response.get("code"))
        .and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse().ok()))
        .unwrap_or(0);
    if code != 0 {
        return Err(ServiceError::new(
            "BUSINESS_REJECTED",
            "App 接口暂未提供本集播放信息",
        ));
    }
    let entries = response
        .get("data")
        .and_then(Value::as_object)
        .and_then(|data| data.get("1004").or_else(|| data.get("video_model_data")))
        .or_else(|| response.get("data"))
        .unwrap_or(response);
    let entry = entries
        .get(vid)
        .ok_or_else(|| ServiceError::new("MISSING_MODEL", "App 接口未返回所选分集"))?;
    let model = entry.get("video_model").unwrap_or(entry);
    if let Some(model) = model.as_str() {
        serde_json::from_str(model)
            .map_err(|_| ServiceError::new("INVALID_RESPONSE", "App 片源模型 JSON 无效"))
    } else if model.is_object() {
        Ok(model.clone())
    } else {
        Err(ServiceError::new(
            "INVALID_RESPONSE",
            "App 接口片源模型格式异常",
        ))
    }
}

async fn request_source_model(request: UpstreamRequest, vid: &str) -> Result<Value, ServiceError> {
    let method = if request.method == "GET" {
        reqwest::Method::GET
    } else {
        reqwest::Method::POST
    };
    let (status, _, body) = request_upstream(
        method.clone(),
        &request.url,
        &["fqnovel.com"],
        &request.headers,
        request.body,
        PLAY_MODEL_MAX_BYTES,
    )
    .await?;
    if status != StatusCode::OK {
        return Err(ServiceError::new(
            "UPSTREAM_HTTP",
            format!("App 播放请求失败（HTTP {status}）"),
        ));
    }
    if body.is_empty() {
        return Err(ServiceError::new("EMPTY_RESPONSE", "App 接口返回空响应"));
    }
    let response: Value = serde_json::from_slice(&body)
        .map_err(|_| ServiceError::new("INVALID_RESPONSE", "App 播放响应不是有效 JSON"))?;
    parse_play_model(&response, vid)
}

async fn fetch_source_attempt(
    identity: &DeviceIdentity,
    vid: &str,
    quality: &str,
    payload: &str,
) -> Result<Vec<Variant>, ServiceError> {
    let mut last_error = None;

    // Keep trying every official host and both current request families. A
    // 200 response with an empty body or a model for another episode is a
    // candidate failure, not a terminal result for the whole source lookup.
    for host in PLAYER_HOSTS {
        let timestamp = match now_millis() {
            Ok(timestamp) => timestamp,
            Err(error) => {
                last_error = Some(error);
                continue;
            }
        };
        let routes: [Result<UpstreamRequest, ServiceError>; 2] = [
            build_video_tab_request(identity, vid, host, timestamp),
            build_v5_play_request(identity, vid, payload, host, timestamp).map(
                |(request, body)| UpstreamRequest {
                    method: "POST".into(),
                    url: request.url,
                    headers: request.headers,
                    body: Some(body),
                },
            ),
        ];
        for route in routes {
            let request = match route {
                Ok(request) => request,
                Err(error) => {
                    last_error = Some(error);
                    continue;
                }
            };
            let model = match request_source_model(request, vid).await {
                Ok(model) => model,
                Err(error) => {
                    last_error = Some(error);
                    continue;
                }
            };
            let selected = match select_all_variants(&model, vid, Some(quality), false, true, 0) {
                Ok(selected) => selected,
                Err(error) => {
                    last_error = Some(error);
                    continue;
                }
            };
            match selected
                .into_iter()
                .map(Variant::try_from)
                .collect::<Result<Vec<_>, _>>()
            {
                Ok(variants) if !variants.is_empty() => return Ok(variants),
                Ok(_) => {
                    last_error = Some(ServiceError::new(
                        "NO_COMPATIBLE_SOURCE",
                        "本集没有兼容 H.264/HEVC 片源",
                    ));
                }
                Err(error) => last_error = Some(error),
            }
        }
    }

    // The old player endpoint remains a bounded fallback for deployments
    // where v5/video_tab return an empty 200. It uses the same registered
    // identity and the same payload, but a separate legacy signature family.
    for host in PLAYER_HOSTS {
        let timestamp = match now_millis() {
            Ok(timestamp) => timestamp,
            Err(error) => {
                last_error = Some(error);
                continue;
            }
        };
        let request = match build_legacy_play_request(
            identity,
            payload,
            vid,
            host,
            timestamp,
            rand::random::<u64>() as i128,
            rand::random::<[u8; 4]>(),
        ) {
            Ok(request) => request,
            Err(error) => {
                last_error = Some(error);
                continue;
            }
        };
        let model = match request_source_model(request, vid).await {
            Ok(model) => model,
            Err(error) => {
                last_error = Some(error);
                continue;
            }
        };
        let selected = match select_all_variants(&model, vid, Some(quality), false, true, 0) {
            Ok(selected) => selected,
            Err(error) => {
                last_error = Some(error);
                continue;
            }
        };
        match selected
            .into_iter()
            .map(Variant::try_from)
            .collect::<Result<Vec<_>, _>>()
        {
            Ok(variants) if !variants.is_empty() => return Ok(variants),
            Ok(_) => {
                last_error = Some(ServiceError::new(
                    "NO_COMPATIBLE_SOURCE",
                    "本集没有兼容 H.264/HEVC 片源",
                ));
            }
            Err(error) => last_error = Some(error),
        }
    }

    Err(last_error.unwrap_or_else(|| ServiceError::new("EMPTY_RESPONSE", "App 接口返回空响应")))
}

async fn fetch_source_variants(vid: &str, quality: &str) -> Result<Vec<Variant>, ServiceError> {
    let payload = serde_json::to_string(&json!({
        "biz_param": {
            "detail_page_version": 0,
            "device_level": 3,
            "disable_digg_stat": false,
            "disable_video_relate_book": false,
            "need_all_video_definition": true,
            "need_mp4_align": false,
            "use_os_player": false,
            "use_server_dns": false,
            "video_platform": 1024,
        },
        "mixed_video_id_map": {"1004": [vid]},
        "dr_scene": "player",
    }))
    .map_err(|_| ServiceError::new("APP_INPUT", "播放请求参数序列化失败"))?;
    let identity = playback_device().await?;
    match fetch_source_attempt(&identity, vid, quality, &payload).await {
        Ok(variants) => Ok(variants),
        Err(first_error) => {
            // Match the Node baseline: after all candidates return an empty
            // result, register one fresh device and repeat the bounded set.
            let mut cache = device_cache().lock().await;
            *cache = None;
            drop(cache);
            let identity = playback_device().await?;
            fetch_source_attempt(&identity, vid, quality, &payload)
                .await
                .map_err(|_| first_error)
        }
    }
}

async fn fetch_detail_uncached(series_id: &str) -> Result<Value, ServiceError> {
    let url = format!("https://hongguoduanju.com/player/{series_id}");
    let (status, _, body) = request_upstream(
        reqwest::Method::GET,
        &url,
        &["hongguoduanju.com"],
        &std::collections::BTreeMap::new(),
        None,
        DETAIL_MAX_BYTES,
    )
    .await?;
    if status != StatusCode::OK {
        return Err(ServiceError::new(
            "DETAIL_HTTP",
            format!("剧集页面请求失败（HTTP {status}）"),
        ));
    }
    let value = parse_detail(series_id, &body)?;
    cache_detail(series_id, &value);
    Ok(value)
}

/// Loads and validates a series detail page, retaining only the metadata
/// required by the UI and media cache. Concurrent requests for the same
/// series share one in-flight page request.
pub(crate) async fn details(series_id: &str) -> Result<Value, ServiceError> {
    if !valid_id(series_id) {
        return Err(ServiceError::new("INVALID_ID", "剧集编号无效"));
    }
    if let Some(value) = cached_detail(series_id) {
        return Ok(value);
    }
    let cell = {
        let mut inflight = detail_inflight().lock().await;
        inflight
            .entry(series_id.to_owned())
            .or_insert_with(|| Arc::new(tokio::sync::OnceCell::new()))
            .clone()
    };
    let key = series_id.to_owned();
    let value = cell
        .get_or_init(|| async move { fetch_detail_uncached(&key).await })
        .await
        .clone();
    let mut inflight = detail_inflight().lock().await;
    if inflight
        .get(series_id)
        .is_some_and(|current| Arc::ptr_eq(current, &cell))
    {
        inflight.remove(series_id);
    }
    value
}

/// Prepares one episode using variants already resolved by the OTA-updatable TSX layer.
pub(crate) async fn prepare_with_variants(
    series_id: &str,
    episode_id: Option<&str>,
    quality: &str,
    variants: Vec<Variant>,
) -> Result<Prepared, ServiceError> {
    let detail = details(series_id).await?;
    let episodes = detail
        .get("episodes")
        .and_then(Value::as_array)
        .ok_or_else(|| ServiceError::new("INVALID_DETAIL", "剧集分集列表缺失"))?;
    let episode = match episode_id {
        Some(episode_id) => episodes
            .iter()
            .find(|episode| episode.get("episodeId").and_then(Value::as_str) == Some(episode_id))
            .cloned(),
        None => episodes.first().cloned(),
    }
    .ok_or_else(|| ServiceError::new("INVALID_EPISODE", "所选分集不属于本剧"))?;
    let metadata = {
        let mut metadata = detail;
        metadata
            .as_object_mut()
            .ok_or_else(|| ServiceError::new("INVALID_DETAIL", "剧集详情格式异常"))?
            .insert("episode".into(), episode);
        metadata
    };
    prepare_from_variants(metadata, variants, quality).await
}

/// Prepares one episode by selecting a verified source, downloading it into
/// bounded memory, and decrypting non-fragmented CENC samples when required.
pub(crate) async fn prepare(
    series_id: &str,
    episode_id: Option<&str>,
    quality: &str,
) -> Result<Prepared, ServiceError> {
    let detail = details(series_id).await?;
    let episodes = detail
        .get("episodes")
        .and_then(Value::as_array)
        .ok_or_else(|| ServiceError::new("INVALID_DETAIL", "剧集分集列表缺失"))?;
    let episode = match episode_id {
        Some(episode_id) => episodes
            .iter()
            .find(|episode| episode.get("episodeId").and_then(Value::as_str) == Some(episode_id))
            .cloned(),
        None => episodes.first().cloned(),
    }
    .ok_or_else(|| ServiceError::new("INVALID_EPISODE", "所选分集不属于本剧"))?;
    let episode_id = episode
        .get("episodeId")
        .and_then(Value::as_str)
        .ok_or_else(|| ServiceError::new("INVALID_EPISODE", "分集编号无效"))?;
    let variants = fetch_source_variants(episode_id, quality).await?;
    let metadata = {
        let mut metadata = detail;
        metadata
            .as_object_mut()
            .ok_or_else(|| ServiceError::new("INVALID_DETAIL", "剧集详情格式异常"))?
            .insert("episode".into(), episode);
        metadata
    };
    prepare_from_variants(metadata, variants, quality).await
}

#[derive(Debug)]
struct HttpBytes {
    status: StatusCode,
    headers: HeaderMap,
    data: Vec<u8>,
}

#[derive(Debug)]
struct Probe {
    candidate: Variant,
    complete: Option<Vec<u8>>,
    first_chunk: Option<Vec<u8>>,
    total_bytes: usize,
}

fn media_error(message: impl Into<String>) -> ServiceError {
    ServiceError::new("MEDIA_HTTP", message)
}

fn canceled_error() -> ServiceError {
    ServiceError::new("ERR_CANCELED", "已取消")
}

async fn request_bytes(
    client: &Client,
    candidate: &Variant,
    range: Option<(usize, usize)>,
    max_bytes: usize,
) -> Result<HttpBytes, ServiceError> {
    let url = crate::transport::checked_public_https_url(&candidate.url)?;
    let mut request = client.get(url).timeout(Duration::from_secs(90));
    let user_agent = reqwest::header::HeaderValue::from_str(&candidate.user_agent)
        .map_err(|_| ServiceError::new("SECURITY_BLOCKED", "媒体 User-Agent 无效"))?;
    request = request.header(USER_AGENT, user_agent);
    if let Some((start, end)) = range {
        request = request.header(RANGE, format!("bytes={start}-{end}"));
    }
    let response = request.send().await.map_err(|error| {
        ServiceError::new(
            if error.is_timeout() {
                "ETIMEDOUT"
            } else {
                "ERR_NETWORK"
            },
            if error.is_timeout() {
                "媒体请求超时"
            } else {
                "媒体请求失败"
            },
        )
    })?;
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = crate::transport::read_body(response, max_bytes).await?;
    if bytes.is_empty() || bytes.len() > max_bytes {
        return Err(media_error("媒体响应为空或超出大小限制"));
    }
    Ok(HttpBytes {
        status,
        headers,
        data: bytes,
    })
}

fn content_range(headers: &HeaderMap) -> Option<(usize, usize, usize)> {
    let value = headers.get("content-range")?.to_str().ok()?;
    let value = value.strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let start = decimal(start)?;
    let end = decimal(end)?;
    let total = decimal(total)?;
    (start <= end && end < total && total > 0 && total <= MAX_MEDIA_BYTES)
        .then_some((start, end, total))
}

fn decimal(value: &str) -> Option<usize> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

async fn probe_first_chunk(client: &Client, candidate: Variant) -> Result<Probe, ServiceError> {
    let response = request_bytes(
        client,
        &candidate,
        Some((0, CHUNK_BYTES - 1)),
        MAX_MEDIA_BYTES,
    )
    .await?;
    if response.status == StatusCode::OK {
        return Ok(Probe {
            candidate,
            total_bytes: response.data.len(),
            complete: Some(response.data),
            first_chunk: None,
        });
    }
    if response.status != StatusCode::PARTIAL_CONTENT {
        return Err(media_error(format!(
            "媒体请求失败（HTTP {}）",
            response.status
        )));
    }
    if let Some((start, end, total)) = content_range(&response.headers) {
        if start != 0 || end < response.data.len().saturating_sub(1) {
            return Err(media_error("媒体 Range 响应范围异常"));
        }
        if response.data.len() >= total {
            return Ok(Probe {
                candidate,
                total_bytes: total,
                complete: Some(response.data[..total].to_vec()),
                first_chunk: None,
            });
        }
        return Ok(Probe {
            candidate,
            total_bytes: total,
            complete: None,
            first_chunk: Some(response.data),
        });
    }
    // A 206 without a valid total cannot be safely reassembled. Use one
    // bounded full GET, matching the Node fallback path.
    let full = request_bytes(client, &candidate, None, MAX_MEDIA_BYTES).await?;
    if full.status == StatusCode::OK {
        return Ok(Probe {
            candidate,
            total_bytes: full.data.len(),
            complete: Some(full.data),
            first_chunk: None,
        });
    }
    Err(media_error(format!("媒体请求失败（HTTP {}）", full.status)))
}

async fn probe_group(client: &Client, candidates: Vec<Variant>) -> Result<Probe, ServiceError> {
    if candidates.is_empty() {
        return Err(media_error("媒体请求失败"));
    }
    let mut jobs = JoinSet::new();
    for candidate in candidates {
        let client = client.clone();
        jobs.spawn(async move { probe_first_chunk(&client, candidate).await });
    }
    let mut last_error = None;
    while let Some(result) = jobs.join_next().await {
        match result {
            Ok(Ok(probe)) => {
                jobs.abort_all();
                return Ok(probe);
            }
            Ok(Err(error)) => last_error = Some(error),
            Err(error) => last_error = Some(media_error(format!("媒体探测任务失败：{error}"))),
        }
    }
    Err(last_error.unwrap_or_else(|| media_error("媒体请求失败")))
}

async fn fetch_chunk_with_retry(
    client: &Client,
    candidate: &Variant,
    start: usize,
    end: usize,
    total_bytes: usize,
) -> Result<Vec<u8>, ServiceError> {
    let expected = end - start + 1;
    let mut last_error = None;
    for _attempt in 0..2 {
        match request_bytes(client, candidate, Some((start, end)), CHUNK_BYTES + 1024).await {
            Ok(response)
                if response.status == StatusCode::PARTIAL_CONTENT
                    && response.data.len() == expected =>
            {
                if let Some((actual_start, actual_end, actual_total)) =
                    content_range(&response.headers)
                    && (actual_start != start || actual_end != end || actual_total != total_bytes)
                {
                    last_error = Some(media_error("媒体 Range 响应范围异常"));
                    continue;
                }
                return Ok(response.data);
            }
            Ok(response) => {
                last_error = Some(media_error(format!(
                    "分片请求异常（HTTP {}）",
                    response.status
                )));
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| media_error("分片请求失败")))
}

async fn download_remaining_chunks(client: &Client, probe: Probe) -> Result<Vec<u8>, ServiceError> {
    let Probe {
        candidate,
        first_chunk,
        total_bytes,
        complete,
    } = probe;
    if let Some(data) = complete {
        return Ok(data);
    }
    let first_chunk = first_chunk.ok_or_else(|| media_error("媒体首分片缺失"))?;
    if first_chunk.len() > total_bytes || total_bytes > MAX_MEDIA_BYTES {
        return Err(media_error("媒体总大小无效"));
    }
    let mut output = vec![0_u8; total_bytes];
    output[..first_chunk.len()].copy_from_slice(&first_chunk);
    let semaphore = Arc::new(Semaphore::new(CHUNK_CONCURRENCY));
    let mut jobs = JoinSet::new();
    for start in (first_chunk.len()..total_bytes).step_by(CHUNK_BYTES) {
        let end = (start + CHUNK_BYTES - 1).min(total_bytes - 1);
        let semaphore = semaphore.clone();
        let client = client.clone();
        let candidate = candidate.clone();
        jobs.spawn(async move {
            let _permit = semaphore
                .acquire_owned()
                .await
                .map_err(|_| canceled_error())?;
            let data = fetch_chunk_with_retry(&client, &candidate, start, end, total_bytes).await?;
            Ok::<_, ServiceError>((start, data))
        });
    }
    while let Some(result) = jobs.join_next().await {
        match result {
            Ok(Ok((start, data))) => output[start..start + data.len()].copy_from_slice(&data),
            Ok(Err(error)) => {
                jobs.abort_all();
                return Err(error);
            }
            Err(error) => {
                jobs.abort_all();
                return Err(media_error(format!("媒体分片任务失败：{error}")));
            }
        }
    }
    Ok(output)
}

async fn download_single_fallback(
    client: &Client,
    candidate: &Variant,
) -> Result<Vec<u8>, ServiceError> {
    let response = request_bytes(client, candidate, None, MAX_MEDIA_BYTES).await?;
    if response.status == StatusCode::OK {
        return Ok(response.data);
    }
    Err(media_error(format!(
        "媒体请求失败（HTTP {}）",
        response.status
    )))
}

/// Races up to two CDN candidates for each codec tier, then assembles the
/// winning response with bounded 1 MiB chunks and six concurrent requests.
pub(crate) async fn download_from_variants(
    ordered: &[Variant],
) -> Result<(Variant, Vec<u8>), ServiceError> {
    let client = crate::transport::client()?.clone();
    let mut last_error = None;
    for codec in ["h264", "hevc", "bytevc2"] {
        let group: Vec<_> = ordered
            .iter()
            .filter(|variant| variant.codec == codec)
            .cloned()
            .collect();
        let mut offset = 0;
        while offset < group.len() {
            let batch_len = if offset == 0 { 2 } else { 1 }.min(group.len() - offset);
            let batch = group[offset..offset + batch_len].to_vec();
            offset += batch_len;
            let probe = match probe_group(&client, batch).await {
                Ok(probe) => probe,
                Err(error) => {
                    last_error = Some(error);
                    continue;
                }
            };
            let candidate = probe.candidate.clone();
            match download_remaining_chunks(&client, probe).await {
                Ok(data) => return Ok((candidate, data)),
                Err(_error) => match download_single_fallback(&client, &candidate).await {
                    Ok(data) => return Ok((candidate, data)),
                    Err(fallback_error) => last_error = Some(fallback_error),
                },
            }
        }
    }
    Err(last_error.unwrap_or_else(|| media_error("媒体请求失败")))
}

/// Finishes preparation after the protocol layer has validated a detail
/// response and returned source variants. This is the integration seam used
/// by `prepare`; keeping it separate makes downloader/CENC behavior testable
/// without network or signed request fixtures.
pub(crate) async fn prepare_from_variants(
    mut metadata: Value,
    variants: impl IntoIterator<Item = Variant>,
    quality: &str,
) -> Result<Prepared, ServiceError> {
    let supported = variants
        .into_iter()
        .filter(|variant| variant.codec != "bytevc2" || crate::NativeVideo::bytevc2_available());
    let ordered = order_variants(supported, quality)?;
    let (variant, raw) = download_from_variants(&ordered).await?;
    let data = match variant.content_key {
        Some(key) => tokio::task::spawn_blocking(move || decrypt_mp4_buffer(&raw, &key))
            .await
            .map_err(|_| ServiceError::new("SERVICE_ERROR", "媒体解密任务失败"))??,
        None => raw,
    };
    let object = metadata
        .as_object_mut()
        .ok_or_else(|| ServiceError::new("INVALID_DETAIL", "剧集详情格式异常"))?;
    object.insert("codec".into(), Value::String(variant.codec));
    object.insert("quality".into(), Value::String(variant.quality));
    object.insert(
        "encrypted".into(),
        Value::Bool(variant.content_key.is_some()),
    );
    Ok(Prepared { metadata, data })
}

#[cfg(test)]
mod tests {
    use super::{Variant, order_variants, parse_detail};

    fn variant(codec: &str, quality: &str) -> Variant {
        Variant {
            url: format!("https://qznovelvod.com/{codec}-{quality}.mp4"),
            codec: codec.into(),
            quality: quality.into(),
            user_agent: "test".into(),
            content_key: None,
        }
    }

    #[test]
    fn prefers_platform_decoders_and_filters_quality() {
        let variants = order_variants(
            [
                variant("hevc", "720p"),
                variant("hevc", "1080p"),
                variant("bytevc2", "1080p"),
                variant("h264", "1080p"),
            ],
            "1080p",
        )
        .expect("compatible variants");
        assert_eq!(
            variants
                .iter()
                .map(|variant| variant.codec.as_str())
                .collect::<Vec<_>>(),
            ["h264", "hevc", "bytevc2"]
        );
    }

    #[test]
    fn rejects_when_no_compatible_quality_exists() {
        let error = order_variants([variant("hevc", "1080p")], "720p")
            .expect_err("must preserve the requested quality");
        assert_eq!(error.to_string(), "本集没有当前画质的可播放片源");
    }

    #[test]
    fn parses_router_data_without_executing_trailing_script() {
        let body = r#"<script>_ROUTER_DATA = {"loaderData":{"player_(series_id)/page":{"isSuccess":true,"seriesDetail":{"series_id":"123","series_name":"测试剧","vid_list":["456"],"tags":["甜宠"],"celebrities":[{"nickname":"演员","sub_title":"主角"}]}}}}; console.log("ignored")</script>"#;
        let detail = parse_detail("123", body.as_bytes()).expect("detail");
        assert_eq!(detail["title"], "测试剧");
        assert_eq!(detail["episodes"][0]["episodeId"], "456");
        assert_eq!(detail["celebrities"][0]["role"], "主角");
    }
}
