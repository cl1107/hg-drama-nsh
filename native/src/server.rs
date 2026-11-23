use crate::{ServiceConnection, ServiceError, auth, catalog, danmaku, downloads::Downloads, media};
use axum::{
    Router,
    body::{Body, Bytes, to_bytes},
    extract::{Request, State},
    http::{Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    net::{Ipv4Addr, TcpListener},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

static CONNECTION: OnceLock<ServiceConnection> = OnceLock::new();
static START: Mutex<()> = Mutex::new(());

pub(crate) fn connection() -> Result<ServiceConnection, String> {
    let _start = START.lock().expect("local service start lock");
    if let Some(value) = CONNECTION.get() {
        return Ok(value.clone());
    }

    let listener =
        TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|error| error.to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let host = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .to_string();
    let token = random_token::<32>();
    let result = ServiceConnection {
        base_url: format!("http://{host}"),
        token: token.clone(),
    };
    let app = Router::new().fallback(handle).with_state(Arc::new(Service {
        host,
        authorization: format!("Bearer {token}"),
        cache: Mutex::new(VecDeque::new()),
        active: Mutex::new(None),
        prefetch: Mutex::new(None),
        downloads: Downloads::open().map_err(|error| {
            ServiceError::new("SERVICE_ERROR", format!("无法读取离线下载：{error}"))
        }),
        awake: Mutex::new(None),
    }));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    std::thread::Builder::new()
        .name("hg-local-service".into())
        .spawn(move || {
            runtime.block_on(async move {
                let listener = tokio::net::TcpListener::from_std(listener)
                    .expect("nonblocking loopback listener");
                if let Err(error) = axum::serve(listener, app).await {
                    eprintln!("本机服务已退出：{error}");
                }
            })
        })
        .map_err(|error| error.to_string())?;
    let _ = CONNECTION.set(result.clone());
    Ok(result)
}

pub(crate) fn random_token<const N: usize>() -> String {
    use std::fmt::Write;
    let mut token = String::with_capacity(N * 2);
    for byte in rand::random::<[u8; N]>() {
        write!(&mut token, "{byte:02x}").expect("write to string");
    }
    token
}

struct Service {
    host: String,
    authorization: String,
    cache: Mutex<VecDeque<MediaEntry>>,
    active: Mutex<Option<CancellationToken>>,
    prefetch: Mutex<Option<Prefetch>>,
    downloads: Result<Downloads, ServiceError>,
    awake: Mutex<Option<std::process::Child>>,
}

type MediaKey = (String, String, String);

struct Prefetch {
    key: MediaKey,
    cancel: CancellationToken,
    result: tokio::sync::watch::Receiver<Option<Result<Value, ServiceError>>>,
}

struct MediaEntry {
    path: String,
    key: Option<MediaKey>,
    data: Bytes,
    metadata: Value,
    expires: Instant,
}

impl Service {
    fn cache_media(&self, data: Bytes, mut metadata: Value, quality: Option<&str>) -> Value {
        let path = random_token::<32>();
        let key = quality.and_then(|quality| {
            Some((
                metadata["seriesId"].as_str()?.into(),
                metadata["episode"]["episodeId"].as_str()?.into(),
                quality.into(),
            ))
        });
        metadata["mediaUrl"] = json!(format!("http://{}/media/{path}", self.host));
        let mut cache = self.cache.lock().expect("media cache lock");
        cache.retain(|entry| entry.expires > Instant::now() && (key.is_none() || entry.key != key));
        if cache.len() >= 4 {
            cache.pop_front();
        }
        cache.push_back(MediaEntry {
            path,
            key,
            data,
            metadata: metadata.clone(),
            expires: Instant::now() + Duration::from_secs(30 * 60),
        });
        metadata
    }

    fn cached_playback(&self, series: &str, episode: &str, quality: &str) -> Option<Value> {
        let mut cache = self.cache.lock().expect("media cache lock");
        cache.retain(|entry| entry.expires > Instant::now());
        let index = cache.iter().position(|entry| {
            entry
                .key
                .as_ref()
                .is_some_and(|(s, e, q)| s == series && e == episode && q == quality)
        })?;
        let entry = cache.remove(index)?;
        let result = entry.metadata.clone();
        cache.push_back(entry);
        Some(result)
    }

    fn media(&self, path: &str) -> Option<Bytes> {
        let cache = self.cache.lock().expect("media cache lock");
        cache
            .iter()
            .find(|entry| entry.path == path && entry.expires > Instant::now())
            .map(|entry| entry.data.clone())
    }

    fn take_prefetch(
        &self,
        series: &str,
        episode: Option<&str>,
        quality: &str,
    ) -> Option<Prefetch> {
        let previous = self.prefetch.lock().expect("prefetch lock").take()?;
        let (s, e, q) = &previous.key;
        if s == series && Some(e.as_str()) == episode && q == quality {
            return Some(previous);
        }
        previous.cancel.cancel();
        None
    }

    fn prefetch_with_variants(
        self: &Arc<Self>,
        series: &str,
        episode: &str,
        quality: &str,
        variants: Vec<media::Variant>,
    ) {
        let key = (series.to_owned(), episode.to_owned(), quality.to_owned());
        let mut slot = self.prefetch.lock().expect("prefetch lock");
        if slot.as_ref().is_some_and(|existing| existing.key == key) {
            return;
        }
        let cancel = CancellationToken::new();
        let (send, result) = tokio::sync::watch::channel(None);
        if let Some(previous) = slot.replace(Prefetch {
            key: key.clone(),
            cancel: cancel.clone(),
            result,
        }) {
            previous.cancel.cancel();
        }
        let service = Arc::clone(self);
        tokio::spawn(async move {
            let (series, episode, quality) = key;
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {}
                result = media::prepare_with_variants(&series, Some(&episode), &quality, variants) => {
                    let result = result.map(|prepared| {
                        service.cache_media(prepared.data.into(), prepared.metadata, Some(&quality))
                    });
                    let _ = send.send(Some(result));
                }
            }
        });
    }

    fn prefetch_next(self: &Arc<Self>, metadata: &Value, quality: &str) {
        let Some(series) = metadata["seriesId"].as_str() else {
            return;
        };
        let Some(current) = metadata["episode"]["episodeId"].as_str() else {
            return;
        };
        let Some(episodes) = metadata["episodes"].as_array() else {
            return;
        };
        let Some(next) = episodes
            .iter()
            .skip_while(|episode| episode["episodeId"].as_str() != Some(current))
            .nth(1)
            .and_then(|episode| episode["episodeId"].as_str())
        else {
            return;
        };
        if self.cached_playback(series, next, quality).is_some() {
            return;
        }
        let key = (series.to_owned(), next.to_owned(), quality.to_owned());
        let mut slot = self.prefetch.lock().expect("prefetch lock");
        if slot.as_ref().is_some_and(|existing| existing.key == key) {
            return;
        }
        let cancel = CancellationToken::new();
        let (send, result) = tokio::sync::watch::channel(None);
        if let Some(previous) = slot.replace(Prefetch {
            key: key.clone(),
            cancel: cancel.clone(),
            result,
        }) {
            previous.cancel.cancel();
        }
        let service = Arc::clone(self);
        tokio::spawn(async move {
            let (series, next, quality) = key;
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {}
                result = async {
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    media::prepare(&series, Some(&next), &quality).await
                } => {
                    let result = result.map(|prepared| {
                        service.cache_media(prepared.data.into(), prepared.metadata, Some(&quality))
                    });
                    let _ = send.send(Some(result));
                }
            }
        });
    }

    fn keep_awake(&self, enabled: bool) -> Result<Value, ServiceError> {
        if cfg!(target_os = "macos") {
            let mut awake = self.awake.lock().expect("power assertion lock");
            if awake
                .as_mut()
                .is_some_and(|child| matches!(child.try_wait(), Ok(Some(_))))
            {
                *awake = None;
            }
            if enabled && awake.is_none() {
                *awake = Some(
                    std::process::Command::new("/usr/bin/caffeinate")
                        .args(["-dis", "-w", &std::process::id().to_string()])
                        .stdin(std::process::Stdio::null())
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .spawn()
                        .map_err(|error| ServiceError::new("SERVICE_ERROR", error.to_string()))?,
                );
            } else if !enabled && let Some(mut child) = awake.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        Ok(json!({"active": enabled}))
    }
}

async fn handle(State(service): State<Arc<Service>>, request: Request) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let headers = request.headers();
    let response = if headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        != Some(&service.host)
        || headers.contains_key(header::ORIGIN)
    {
        StatusCode::FORBIDDEN.into_response()
    } else if let Some(data) = path
        .strip_prefix("/media/")
        .filter(|_| method == Method::GET || method == Method::HEAD)
        .and_then(|key| service.media(key))
    {
        serve_media(data, headers.get(header::RANGE), method == Method::HEAD)
    } else if headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        != Some(&service.authorization)
    {
        StatusCode::UNAUTHORIZED.into_response()
    } else {
        dispatch(&service, &method, &path, request.into_body())
            .await
            .map_or_else(error_response, |value| axum::Json(value).into_response())
    };
    let (mut parts, body) = response.into_parts();
    parts.headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    parts.headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        header::HeaderValue::from_static("nosniff"),
    );
    Response::from_parts(parts, body)
}

async fn dispatch(
    service: &Arc<Service>,
    method: &Method,
    path: &str,
    body: Body,
) -> Result<Value, ServiceError> {
    if method == Method::GET {
        return match path {
            "/auth/status" | "/auth/cloud-history" | "/auth/cloud-bookshelf" => {
                auth::handle(path, json!({})).await
            }
            "/downloads" => Ok(service.downloads.as_ref().map_err(Clone::clone)?.list()),
            _ => Err(ServiceError::new("NOT_FOUND", "请求地址不存在")),
        };
    }
    if method != Method::POST {
        return Err(ServiceError::new("NOT_FOUND", "请求地址不存在"));
    }

    let body_limit = match path {
        "/upstream/fetch" => 2 * 1024 * 1024,
        "/play" | "/play/prefetch" | "/downloads/start" | "/downloads/retry" => 256 * 1024,
        _ => 4096,
    };
    let bytes = to_bytes(body, body_limit)
        .await
        .map_err(|_| ServiceError::new("INVALID_REQUEST", "请求过大"))?;
    let input = if bytes.iter().all(u8::is_ascii_whitespace) {
        json!({})
    } else {
        serde_json::from_slice::<Value>(&bytes)
            .ok()
            .filter(Value::is_object)
            .ok_or_else(|| ServiceError::new("INVALID_REQUEST", "请求 JSON 格式无效"))?
    };

    match path {
        "/upstream/fetch" => upstream_fetch(&input).await,
        "/play/cache" => {
            let (series, episode, quality) = playback_input(&input)?;
            let hit = episode.and_then(|ep| service.cached_playback(series, ep, quality));
            Ok(match hit {
                Some(playback) => json!({ "hit": true, "playback": playback }),
                None => json!({ "hit": false }),
            })
        }
        "/play/prefetch" => {
            let (series, episode, quality) = playback_input(&input)?;
            let Some(episode) = episode else {
                return Err(ServiceError::new("INVALID_REQUEST", "预取需要指定分集编号"));
            };
            let variants = media::parse_variants_input(input.get("variants"))?
                .ok_or_else(|| ServiceError::new("INVALID_REQUEST", "预取缺少片源列表"))?;
            if service.cached_playback(series, episode, quality).is_some() {
                return Ok(json!({ "cached": true }));
            }
            service.prefetch_with_variants(series, episode, quality, variants);
            Ok(json!({ "started": true }))
        }
        "/play" => {
            let (series, episode, quality) = playback_input(&input)?;
            let provided_variants = media::parse_variants_input(input.get("variants"))?;
            let has_provided = provided_variants.is_some();
            let cancel = CancellationToken::new();
            if let Some(previous) = service
                .active
                .lock()
                .expect("active playback lock")
                .replace(cancel.clone())
            {
                previous.cancel();
            }
            let _closed = cancel.clone().drop_guard();
            let prefetch = service.take_prefetch(series, episode, quality);
            let metadata = if let Some(cached) =
                episode.and_then(|episode| service.cached_playback(series, episode, quality))
            {
                cached
            } else {
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err(ServiceError::new("ERR_CANCELED", "已取消")),
                    result = async {
                        if let Some(mut prefetch) = prefetch {
                            let _cancel_prefetch = prefetch.cancel.drop_guard();
                            if let Ok(result) = prefetch.result.wait_for(|result| result.is_some()).await
                                && let Some(Ok(metadata)) = result.as_ref() {
                                return Ok(metadata.clone());
                            }
                        }
                        let prepared = match provided_variants {
                            Some(variants) => media::prepare_with_variants(series, episode, quality, variants).await?,
                            None => media::prepare(series, episode, quality).await?,
                        };
                        Ok(service.cache_media(prepared.data.into(), prepared.metadata, Some(quality)))
                    } => result?,
                }
            };
            if !has_provided {
                service.prefetch_next(&metadata, quality);
            }
            Ok(metadata)
        }
        "/detail" => media::details(identifier(&input["seriesId"], "剧集编号无效")?).await,
        "/search" | "/discover/category" | "/discover/rank" => catalog::handle(path, input).await,
        "/danmaku" => danmaku::handle(path, input).await,
        "/auth/qr" | "/auth/poll" | "/auth/sms/send" | "/auth/sms/login" | "/auth/logout" => {
            auth::handle(path, input).await
        }
        "/keep-awake" => service.keep_awake(input["active"] == true),
        "/downloads/play" => {
            let (data, metadata) = service
                .downloads
                .as_ref()
                .map_err(Clone::clone)?
                .play(&input)
                .await?;
            Ok(service.cache_media(data, metadata, None))
        }
        "/downloads/start" | "/downloads/retry" | "/downloads/cancel" | "/downloads/delete"
        | "/downloads/clear" => {
            let downloads = service.downloads.as_ref().map_err(Clone::clone)?.clone();
            let runtime = tokio::runtime::Handle::current();
            let path = path.to_owned();
            tokio::task::spawn_blocking(move || {
                let _runtime = runtime.enter();
                downloads.change(&path, &input)
            })
            .await
            .map_err(|error| ServiceError::new("SERVICE_ERROR", error.to_string()))?
        }
        _ => Err(ServiceError::new("NOT_FOUND", "请求地址不存在")),
    }
}

async fn upstream_fetch(input: &Value) -> Result<Value, ServiceError> {
    use base64::{Engine as _, engine::general_purpose::STANDARD as B64};

    let method = match input["method"].as_str().unwrap_or("GET") {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        _ => return Err(ServiceError::new("INVALID_REQUEST", "仅支持 GET/POST 上游请求")),
    };
    let raw_url = input["url"]
        .as_str()
        .ok_or_else(|| ServiceError::new("INVALID_REQUEST", "缺少上游请求地址"))?;
    let url = crate::transport::checked_public_https_url(raw_url)?;
    let timeout_ms = input["timeoutMs"]
        .as_u64()
        .unwrap_or(15_000)
        .clamp(1_000, 30_000);
    let client = crate::transport::client()?.clone();
    let mut request = client
        .request(method, url)
        .timeout(Duration::from_millis(timeout_ms));
    if let Some(headers) = input.get("headers").and_then(Value::as_object) {
        if headers.len() > 64 {
            return Err(ServiceError::new("INVALID_REQUEST", "请求头数量超出限制"));
        }
        for (name, value) in headers {
            let Some(value) = value.as_str() else {
                continue;
            };
            request = request.header(name.as_str(), value);
        }
    }
    if let Some(body_b64) = input.get("bodyBase64").and_then(Value::as_str)
        && !body_b64.is_empty()
    {
        let decoded = B64
            .decode(body_b64)
            .map_err(|_| ServiceError::new("INVALID_REQUEST", "请求体 Base64 无效"))?;
        request = request.body(decoded);
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
    let status = response.status().as_u16();
    let mut response_headers = serde_json::Map::new();
    for (name, value) in response.headers() {
        if let Ok(text) = value.to_str() {
            response_headers.insert(name.as_str().to_owned(), Value::String(text.to_owned()));
        }
    }
    let body = crate::transport::read_body(response, 8 * 1024 * 1024).await?;
    Ok(json!({
        "status": status,
        "headers": response_headers,
        "bodyBase64": B64.encode(&body),
    }))
}

pub(crate) fn identifier<'a>(value: &'a Value, message: &str) -> Result<&'a str, ServiceError> {
    value
        .as_str()
        .filter(|id| {
            !id.is_empty() && id.len() <= 30 && id.bytes().all(|byte| byte.is_ascii_digit())
        })
        .ok_or_else(|| ServiceError::new("INVALID_REQUEST", message))
}

pub(crate) fn playback_input(input: &Value) -> Result<(&str, Option<&str>, &str), ServiceError> {
    let series = identifier(&input["seriesId"], "剧集编号无效")?;
    let episode = input
        .get("episodeId")
        .map(|value| identifier(value, "分集编号无效"))
        .transpose()?;
    let quality = input["quality"]
        .as_str()
        .filter(|quality| matches!(*quality, "1080p" | "720p" | "540p" | "480p" | "360p"))
        .unwrap_or("auto");
    Ok((series, episode, quality))
}

fn error_response(error: ServiceError) -> Response {
    let status = match error.code {
        "INVALID_REQUEST" | "APP_INPUT" => StatusCode::BAD_REQUEST,
        "NOT_FOUND" => StatusCode::NOT_FOUND,
        "ERR_CANCELED" => StatusCode::from_u16(499).expect("valid status"),
        _ => StatusCode::BAD_GATEWAY,
    };
    (
        status,
        axum::Json(json!({"code": error.code, "message": error.message})),
    )
        .into_response()
}

fn serve_media(data: Bytes, range: Option<&header::HeaderValue>, head: bool) -> Response {
    let size = data.len();
    let (status, start, end) = match range {
        None => (StatusCode::OK, 0, size),
        Some(range) => {
            let parsed = range
                .to_str()
                .ok()
                .and_then(|range| media::parse_range(Some(range), size))
                .map(|range| (range.start, range.end + 1));
            let Some((start, end)) = parsed else {
                return (
                    StatusCode::RANGE_NOT_SATISFIABLE,
                    [(header::CONTENT_RANGE, format!("bytes */{size}"))],
                )
                    .into_response();
            };
            (StatusCode::PARTIAL_CONTENT, start, end)
        }
    };
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "video/mp4")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, end - start);
    if range.is_some() {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{}/{size}", end - 1),
        );
    }
    builder
        .body(if head {
            Body::empty()
        } else {
            Body::from(data.slice(start..end))
        })
        .expect("static media headers")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn loopback_rejects_browser_origins_and_unauthenticated_requests() {
        let service = connection().expect("start Rust service");
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let url = format!("{}/downloads", service.base_url);
        let no_token = client.get(&url).send().await.unwrap();
        assert_eq!(no_token.status(), StatusCode::UNAUTHORIZED);
        let browser = client
            .get(&url)
            .header(header::ORIGIN, "https://example.test")
            .bearer_auth(&service.token)
            .send()
            .await
            .unwrap();
        assert_eq!(browser.status(), StatusCode::FORBIDDEN);

        let blocked = client
            .post(format!("{}/upstream/fetch", service.base_url))
            .bearer_auth(&service.token)
            .json(&json!({"method": "GET", "url": "http://127.0.0.1:80/secret"}))
            .send()
            .await
            .unwrap();
        assert_eq!(blocked.status(), StatusCode::BAD_GATEWAY);
        let blocked_body: Value = blocked.json().await.unwrap();
        assert_eq!(blocked_body["code"], "SECURITY_BLOCKED");

        let cache_miss = client
            .post(format!("{}/play/cache", service.base_url))
            .bearer_auth(&service.token)
            .json(&json!({"seriesId": "123", "episodeId": "456", "quality": "auto"}))
            .send()
            .await
            .unwrap();
        assert_eq!(cache_miss.status(), StatusCode::OK);
        let cache_body: Value = cache_miss.json().await.unwrap();
        assert_eq!(cache_body["hit"], false);
    }

    #[tokio::test]
    #[ignore = "requires the public upstream catalogue and playback APIs"]
    async fn live_native_playback_serves_an_official_episode() {
        let service = connection().expect("start Rust service");
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(90))
            .build()
            .unwrap();
        let episode = match std::env::var("HG_LIVE_SERIES_ID") {
            Ok(series) => json!({"seriesId": series}),
            Err(_) => {
                json!({"seriesId": "7503745441910017049", "episodeId": "7503780574541122622"})
            }
        };
        let response = client
            .post(format!("{}/play", service.base_url))
            .bearer_auth(&service.token)
            .json(&episode)
            .send()
            .await
            .unwrap();
        let status = response.status();
        let payload: Value = response.json().await.unwrap();
        assert_eq!(
            status,
            StatusCode::OK,
            "{:?}: {:?}",
            payload["code"],
            payload["message"]
        );
        if let Some(expected) = episode.get("episodeId") {
            assert_eq!(&payload["episode"]["episodeId"], expected);
        }
        assert!(identifier(&payload["episode"]["episodeId"], "playback episode").is_ok());
        assert_eq!(payload["seriesId"], episode["seriesId"]);
        let media = payload["mediaUrl"].as_str().expect("playback URL");
        assert!(media.starts_with(&format!("{}/media/", service.base_url)));
        let response = client
            .get(media)
            .header(header::RANGE, "bytes=0-1023")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.bytes().await.unwrap().len(), 1024);
    }

    #[tokio::test]
    #[ignore = "requires the public upstream catalogue APIs"]
    async fn live_native_catalog_serves_rank_and_search() {
        let service = connection().expect("start Rust service");
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(45))
            .build()
            .unwrap();
        for (route, request) in [
            ("/discover/rank", json!({"rankType": "hot-drama"})),
            ("/search", json!({"keyword": "宴律"})),
        ] {
            let response = client
                .post(format!("{}{route}", service.base_url))
                .bearer_auth(&service.token)
                .json(&request)
                .send()
                .await
                .unwrap();
            let status = response.status();
            let payload: Value = response.json().await.unwrap();
            assert_eq!(
                status,
                StatusCode::OK,
                "{route} {:?}: {:?}",
                payload["code"],
                payload["message"]
            );
            assert!(
                payload["items"]
                    .as_array()
                    .is_some_and(|items| !items.is_empty()),
                "{route} returned no results"
            );
        }
    }

    #[tokio::test]
    async fn serves_seek_ranges_and_head_without_leaking_other_bytes() {
        let payload = Bytes::from_static(b"012345");
        let range = header::HeaderValue::from_static("bytes=2-4");
        let response = serve_media(payload.clone(), Some(&range), false);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 2-4/6");
        assert_eq!(to_bytes(response.into_body(), 6).await.unwrap(), "234");

        let response = serve_media(payload.clone(), Some(&range), true);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "3");
        assert!(to_bytes(response.into_body(), 6).await.unwrap().is_empty());

        let invalid = header::HeaderValue::from_static("bytes=8-");
        let response = serve_media(payload, Some(&invalid), false);
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */6");
    }
}
