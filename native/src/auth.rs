//! Website account-session contract and response normalization.
//!
//! Cookies and the account object are intentionally process-local. The
//! JavaScript implementation persists them only through the platform keychain;
//! this module keeps the same boundary through `credentials` and never
//! silently downgrades it to a plain file.

use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};

use serde_json::{Map, Value, json};

use crate::{
    ServiceError,
    catalog::catalog_cover,
    credentials, metadata_protocol,
    transport::{checked_url, client, read_body},
};

const AUTH_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const PASSPORT_HOST: &str = "https://hongguoduanju.com";
const WEB_AID: &str = "513755";
const WEB_JSSDK_VERSION: &str = "3.4.10";

#[derive(Clone, Debug)]
struct Cookie {
    domain: String,
    name: String,
    value: String,
}

#[derive(Clone, Debug)]
struct User {
    user_id: String,
    nickname: String,
    avatar: String,
}

#[derive(Default)]
struct AuthState {
    cookies: HashMap<String, Cookie>,
    qr_jars: HashMap<String, HashMap<String, Cookie>>,
    user: Option<User>,
    pending_verification: bool,
    session_persisted: bool,
    restored_once: bool,
}

static STATE: OnceLock<Mutex<AuthState>> = OnceLock::new();

fn state() -> &'static Mutex<AuthState> {
    STATE.get_or_init(|| Mutex::new(AuthState::default()))
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

fn integer(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(value)) => value.as_i64().or_else(|| value.to_string().parse().ok()),
        Some(Value::String(value)) => value.trim().parse().ok(),
        _ => None,
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 30 && value.bytes().all(|byte| byte.is_ascii_digit())
}

/// Matches the website's mobile form accepted by `send_code` and `sms_login`.
pub(crate) fn normalize_mobile(value: Option<&Value>) -> Result<String, ServiceError> {
    let clean = text(value).replace([' ', '-'], "");
    if clean.len() == 11
        && clean.as_bytes().get(0) == Some(&b'1')
        && clean
            .as_bytes()
            .get(1)
            .is_some_and(|byte| (b'3'..=b'9').contains(byte))
        && clean.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Ok(format!("+86{clean}"));
    }
    if clean.starts_with('+')
        && clean.len() >= 8
        && clean.len() <= 16
        && clean[1..].bytes().all(|byte| byte.is_ascii_digit())
    {
        return Ok(clean);
    }
    Err(ServiceError::new("INVALID_REQUEST", "请输入有效的手机号"))
}

/// The passport web endpoints use a byte-wise XOR obfuscation before form
/// encoding.  This is not encryption and is kept here only for protocol
/// compatibility; the returned value must not be logged.
pub(crate) fn mix_encode(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| format!("{:02x}", byte ^ 5))
        .collect()
}

fn host_of(url: &str) -> Option<String> {
    let (_, rest) = url.split_once("://")?;
    let host = rest
        .split('/')
        .next()?
        .split(':')
        .next()?
        .trim()
        .to_ascii_lowercase();
    (!host.is_empty()).then_some(host)
}

fn allowed_url(value: &str) -> Result<reqwest::Url, ServiceError> {
    checked_url(
        value,
        &[
            "hongguoduanju.com",
            "douyin.com",
            "snssdk.com",
            "fqnovel.com",
        ],
    )
    .map_err(|_| ServiceError::new("AUTH_REDIRECT", "登录跳转目标地址不受支持"))
}

fn cookie_header_from(jar: &HashMap<String, Cookie>, url: &str) -> String {
    let Some(host) = host_of(url) else {
        return String::new();
    };
    jar.values()
        .filter(|cookie| host == cookie.domain || host.ends_with(&format!(".{}", cookie.domain)))
        .map(|cookie| format!("{}={}", cookie.name, cookie.value))
        .collect::<Vec<_>>()
        .join("; ")
}

fn store_cookies_in(jar: &mut HashMap<String, Cookie>, set_cookie: &[String], request_url: &str) {
    let Some(request_host) = host_of(request_url) else {
        return;
    };
    for raw in set_cookie {
        let mut parts = raw.split(';').map(str::trim);
        let Some(pair) = parts.next() else { continue };
        let Some((name, value)) = pair.split_once('=') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let mut domain = request_host.clone();
        let mut max_age: Option<i64> = None;
        for attr in parts {
            let Some((key, value)) = attr.split_once('=') else {
                continue;
            };
            if key.trim().eq_ignore_ascii_case("domain") && !value.trim().is_empty() {
                domain = value.trim().trim_start_matches('.').to_ascii_lowercase();
            } else if key.trim().eq_ignore_ascii_case("max-age") {
                max_age = value.trim().parse().ok();
            }
        }
        let key = format!("{domain}:{name}");
        if max_age.is_some_and(|age| age <= 0) {
            jar.remove(&key);
        } else {
            jar.insert(
                key,
                Cookie {
                    domain,
                    name: name.to_owned(),
                    value: value.trim().to_owned(),
                },
            );
        }
    }
}

struct AuthResponse {
    status: reqwest::StatusCode,
    text: String,
}

async fn auth_request(
    url: &str,
    method: reqwest::Method,
    body: Option<String>,
    content_type: Option<&str>,
    jar: &mut HashMap<String, Cookie>,
) -> Result<AuthResponse, ServiceError> {
    let mut current = allowed_url(url)?;
    let mut method = method;
    let mut body = body;
    for _ in 0..6 {
        let cookie = cookie_header_from(jar, current.as_str());
        let mut request = client()?
            .request(method.clone(), current.clone())
            .header(reqwest::header::USER_AGENT, AUTH_UA)
            .header(reqwest::header::ACCEPT, "application/json, text/javascript")
            .header(reqwest::header::REFERER, format!("{PASSPORT_HOST}/"))
            .header(reqwest::header::ORIGIN, PASSPORT_HOST);
        if !cookie.is_empty() {
            request = request.header(reqwest::header::COOKIE, cookie);
        }
        if let Some(content_type) = content_type {
            request = request.header(reqwest::header::CONTENT_TYPE, content_type);
        }
        if let Some(value) = body.take() {
            request = request.body(value);
        }
        let response = request
            .send()
            .await
            .map_err(|error| ServiceError::new("AUTH_NETWORK", format!("登录请求失败：{error}")))?;
        let status = response.status();
        let request_url = current.to_string();
        let cookies = response
            .headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok().map(str::to_owned))
            .collect::<Vec<_>>();
        store_cookies_in(jar, &cookies, &request_url);
        if status.is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| ServiceError::new("AUTH_REDIRECT", "登录跳转缺少目标地址"))?;
            let next = current
                .join(location)
                .map_err(|_| ServiceError::new("AUTH_REDIRECT", "登录跳转地址无效"))?;
            current = allowed_url(next.as_str())?;
            method = reqwest::Method::GET;
            body = None;
            continue;
        }
        let body = read_body(response, 256 * 1024).await?;
        let text = String::from_utf8(body)
            .map_err(|_| ServiceError::new("AUTH_NETWORK", "登录响应不是 UTF-8"))?;
        return Ok(AuthResponse { status, text });
    }
    Err(ServiceError::new("AUTH_REDIRECT_LIMIT", "登录跳转次数过多"))
}

fn account_cookie() -> String {
    let guard = state().lock().expect("auth state lock");
    let cookies = &guard.cookies;
    let api_cookie = cookie_header_from(cookies, metadata_protocol::SEARCH_HOST);
    if api_cookie.is_empty() {
        cookie_header_from(cookies, PASSPORT_HOST)
    } else {
        api_cookie
    }
}

fn has_session() -> bool {
    let guard = state().lock().expect("auth state lock");
    guard.cookies.values().any(|cookie| {
        (cookie.name == "sessionid" || cookie.name == "sessionid_ss") && !cookie.value.is_empty()
    })
}

fn user_value(user: &User) -> Value {
    json!({ "userId": user.user_id, "nickname": user.nickname, "avatar": user.avatar })
}

pub(crate) fn account_status() -> Value {
    let guard = state().lock().expect("auth state lock");
    let mut value = json!({
        "loggedIn": guard.user.is_some(),
        "persistent": if guard.user.is_some() {
            guard.session_persisted
        } else {
            credentials::available()
        },
        "pendingVerification": guard.pending_verification,
    });
    if let Some(user) = &guard.user {
        value["user"] = user_value(user);
    }
    value
}

fn set_user(user: User, cookies: Option<HashMap<String, Cookie>>) -> Value {
    let value = user_value(&user);
    let mut guard = state().lock().expect("auth state lock");
    if let Some(cookies) = cookies {
        guard.cookies = cookies;
    }
    guard.user = Some(user);
    guard.pending_verification = false;
    guard.restored_once = true;
    // Persistence is reported only after the credential adapter confirms a save.
    guard.session_persisted = false;
    value
}

fn parse_user(payload: &Value) -> Result<User, ServiceError> {
    let root = object(Some(payload))
        .ok_or_else(|| ServiceError::new("AUTH_VERIFY_INVALID", "未能确认账号身份"))?;
    let data = object(root.get("data")).unwrap_or(root);
    let user_id = text(data.get("user_id_str").or_else(|| data.get("user_id")));
    if !valid_id(&user_id) {
        let expired = text(root.get("message")).eq_ignore_ascii_case("error")
            && integer(data.get("error_code")).is_some_and(|code| code == 8 || code == 10_008);
        return Err(ServiceError::new(
            if expired {
                "AUTH_SESSION_EXPIRED"
            } else {
                "AUTH_VERIFY_INVALID"
            },
            "未能确认账号身份",
        ));
    }
    let nickname = text(data.get("name"));
    Ok(User {
        user_id: user_id.clone(),
        nickname: if nickname.is_empty() {
            format!("用户 {}", &user_id[user_id.len().saturating_sub(4)..])
        } else {
            nickname
        },
        avatar: text(data.get("avatar_url")),
    })
}

fn parse_qr_response(payload: &Value) -> Result<Value, ServiceError> {
    let data = object(Some(payload))
        .and_then(|root| object(root.get("data")))
        .ok_or_else(|| ServiceError::new("AUTH_QR_FAILED", "未能获取登录二维码"))?;
    let token = text(data.get("token"));
    if token.is_empty() {
        return Err(ServiceError::new("AUTH_QR_FAILED", "未能获取登录二维码"));
    }
    Ok(json!({
        "token": token,
        "qrcode": text(data.get("qrcode")),
        "qrcodeIndexUrl": text(data.get("qrcode_index_url")),
        "expireTime": integer(data.get("expire_time")).unwrap_or(0),
    }))
}

fn parse_json(
    text: &str,
    code: &'static str,
    message: &'static str,
) -> Result<Value, ServiceError> {
    serde_json::from_str(text).map_err(|_| ServiceError::new(code, message))
}

fn passport_url(path: &str, extra: &[(&str, &str)]) -> Result<String, ServiceError> {
    let mut url = reqwest::Url::parse(&format!("{PASSPORT_HOST}{path}"))
        .map_err(|_| ServiceError::new("AUTH_NETWORK", "登录地址格式无效"))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("aid", WEB_AID);
        query.append_pair("passport_jssdk_version", WEB_JSSDK_VERSION);
        query.append_pair("passport_jssdk_type", "normal");
        query.append_pair("account_sdk_source", "web");
        query.append_pair("is_from_ttaccountsdk", "1");
        query.append_pair("language", "zh");
        for (key, value) in extra {
            query.append_pair(key, value);
        }
    }
    Ok(url.to_string())
}

fn cookie_values(jar: &HashMap<String, Cookie>) -> Vec<Value> {
    jar.values()
        .map(
            |cookie| json!({ "domain": cookie.domain, "name": cookie.name, "value": cookie.value }),
        )
        .collect()
}

fn persist_session() -> Result<bool, ServiceError> {
    let (user, cookies) = {
        let guard = state().lock().expect("auth state lock");
        (guard.user.clone(), guard.cookies.clone())
    };
    let Some(user) = user else { return Ok(false) };
    if cookies.is_empty() {
        return Ok(false);
    }
    let raw = json!({
        "user": { "userId": user.user_id, "nickname": user.nickname, "avatar": user.avatar },
        "cookies": cookie_values(&cookies),
    })
    .to_string();
    match credentials::save(&raw) {
        Ok(saved) => {
            state().lock().expect("auth state lock").session_persisted = saved;
            Ok(saved)
        }
        Err(_) => {
            state().lock().expect("auth state lock").session_persisted = false;
            Ok(false)
        }
    }
}

fn restore_user(raw: &Value) -> Option<User> {
    let user = object(Some(raw))?.get("user")?.as_object()?;
    let user_id = text(
        user.get("userId")
            .or_else(|| user.get("user_id_str"))
            .or_else(|| user.get("user_id")),
    );
    if !valid_id(&user_id) {
        return None;
    }
    let nickname = text(user.get("nickname").or_else(|| user.get("name")));
    Some(User {
        user_id: user_id.clone(),
        nickname: if nickname.is_empty() {
            format!("用户 {}", &user_id[user_id.len().saturating_sub(4)..])
        } else {
            nickname
        },
        avatar: text(user.get("avatar").or_else(|| user.get("avatar_url"))),
    })
}

async fn restore_session() -> Result<Value, ServiceError> {
    if state().lock().expect("auth state lock").restored_once {
        return Ok(account_status());
    }
    let stored = credentials::read()?;
    let mut restored_cookies = None;
    {
        let mut guard = state().lock().expect("auth state lock");
        guard.restored_once = true;
        if let Some(raw) = stored {
            let parsed = serde_json::from_str::<Value>(&raw).ok();
            let Some(parsed) = parsed else {
                drop(guard);
                let _ = credentials::delete();
                return Ok(account_status());
            };
            let Some(user) = restore_user(&parsed) else {
                drop(guard);
                let _ = credentials::delete();
                return Ok(account_status());
            };
            let mut cookies = HashMap::new();
            if let Some(list) = parsed.get("cookies").and_then(Value::as_array) {
                for cookie in list {
                    let Some(cookie) = cookie.as_object() else {
                        continue;
                    };
                    let domain = text(cookie.get("domain"));
                    let name = text(cookie.get("name"));
                    let value = text(cookie.get("value"));
                    if !domain.is_empty() && !name.is_empty() {
                        cookies.insert(
                            format!("{domain}:{name}"),
                            Cookie {
                                domain,
                                name,
                                value,
                            },
                        );
                    }
                }
            }
            guard.cookies = cookies.clone();
            guard.user = Some(user);
            guard.session_persisted = true;
            guard.pending_verification = true;
            restored_cookies = Some(cookies);
        }
    }
    if let Some(mut cookies) = restored_cookies {
        if verify_account(&mut cookies).await.is_err() {
            state()
                .lock()
                .expect("auth state lock")
                .pending_verification = true;
        }
    }
    Ok(account_status())
}

async fn create_qr_login() -> Result<Value, ServiceError> {
    let url = passport_url(
        "/passport/web/get_qrcode/",
        &[("next", "https://hongguoduanju.com/")],
    )?;
    let mut jar = HashMap::new();
    let response = auth_request(&url, reqwest::Method::GET, None, None, &mut jar).await?;
    if response.status != reqwest::StatusCode::OK {
        return Err(ServiceError::new(
            "AUTH_QR_HTTP",
            format!("获取二维码失败（HTTP {}）", response.status.as_u16()),
        ));
    }
    let body = parse_json(&response.text, "AUTH_QR_FAILED", "二维码响应格式异常")?;
    let result = parse_qr_response(&body)?;
    if let Some(token) = result.get("token").and_then(Value::as_str) {
        let mut guard = state().lock().expect("auth state lock");
        guard.qr_jars.clear();
        guard.qr_jars.insert(token.to_owned(), jar);
    }
    Ok(result)
}

async fn verify_account(jar: &mut HashMap<String, Cookie>) -> Result<User, ServiceError> {
    let url = passport_url("/passport/account/info/v2/", &[])?;
    let response = auth_request(&url, reqwest::Method::GET, None, None, jar).await?;
    if response.status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(ServiceError::new("AUTH_VERIFY_INVALID", "登录会话已失效"));
    }
    if response.status != reqwest::StatusCode::OK {
        return Err(ServiceError::new(
            "AUTH_VERIFY_HTTP",
            format!("账号验证失败（HTTP {}）", response.status.as_u16()),
        ));
    }
    let body = parse_json(
        &response.text,
        "AUTH_VERIFY_INVALID",
        "账号验证响应格式异常",
    )?;
    let user = parse_user(&body)?;
    let value = set_user(user.clone(), Some(jar.clone()));
    let _ = value;
    let _ = persist_session();
    Ok(user)
}

async fn poll_qr_login(token: &str) -> Result<Value, ServiceError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(ServiceError::new("INVALID_REQUEST", "二维码令牌无效"));
    }
    let mut jar = state()
        .lock()
        .expect("auth state lock")
        .qr_jars
        .get(token)
        .cloned()
        .unwrap_or_default();
    let url = passport_url(
        "/passport/web/check_qrconnect/",
        &[("token", token), ("next", "https://hongguoduanju.com/")],
    )?;
    let response = auth_request(&url, reqwest::Method::GET, None, None, &mut jar).await?;
    state()
        .lock()
        .expect("auth state lock")
        .qr_jars
        .insert(token.to_owned(), jar.clone());
    if response.status != reqwest::StatusCode::OK {
        return Err(ServiceError::new(
            "AUTH_POLL_HTTP",
            format!("扫码状态检查失败（HTTP {}）", response.status.as_u16()),
        ));
    }
    let body = parse_json(&response.text, "AUTH_POLL_HTTP", "扫码状态响应格式异常")?;
    let data = object(Some(&body))
        .and_then(|root| object(root.get("data")))
        .ok_or_else(|| ServiceError::new("AUTH_POLL_HTTP", "扫码状态响应格式异常"))?;
    let status = text(data.get("status")).to_ascii_lowercase();
    if status == "5" || status == "expired" {
        state()
            .lock()
            .expect("auth state lock")
            .qr_jars
            .remove(token);
        return Ok(json!({ "status": "expired" }));
    }
    if status == "2" || status == "scanned" {
        return Ok(json!({ "status": "scanned" }));
    }
    if status != "3" && status != "confirmed" {
        return Ok(json!({ "status": "waiting" }));
    }
    if let Some(redirect) = data
        .get("redirect_url")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        let _ = auth_request(redirect, reqwest::Method::GET, None, None, &mut jar).await?;
    }
    if !jar.values().any(|cookie| {
        (cookie.name == "sessionid" || cookie.name == "sessionid_ss") && !cookie.value.is_empty()
    }) {
        return Ok(json!({ "status": "waiting" }));
    }
    let user = verify_account(&mut jar).await?;
    state()
        .lock()
        .expect("auth state lock")
        .qr_jars
        .remove(token);
    Ok(
        json!({ "status": "confirmed", "user": user_value(&user), "persistent": account_status()["persistent"] }),
    )
}

async fn send_sms_code(mobile: &Value, captcha: &Value) -> Result<Value, ServiceError> {
    let mobile = normalize_mobile(Some(mobile))?;
    let mut form = vec![
        ("mobile", mix_encode(&mobile)),
        ("type", "3731".to_owned()),
        ("mix_mode", "1".to_owned()),
    ];
    let captcha = text(Some(captcha));
    if !captcha.is_empty() {
        form.push(("captcha", captcha));
    }
    let body = form
        .iter()
        .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    let url = passport_url("/passport/web/send_code/", &[])?;
    let mut jar = state().lock().expect("auth state lock").cookies.clone();
    let response = auth_request(
        &url,
        reqwest::Method::POST,
        Some(body),
        Some("application/x-www-form-urlencoded"),
        &mut jar,
    )
    .await?;
    state().lock().expect("auth state lock").cookies = jar;
    if response.status != reqwest::StatusCode::OK {
        return Err(ServiceError::new(
            "AUTH_SMS_HTTP",
            format!("发送验证码失败（HTTP {}）", response.status.as_u16()),
        ));
    }
    let payload = parse_json(&response.text, "AUTH_SMS_SEND_FAILED", "短信响应格式异常")?;
    if payload.get("message").and_then(Value::as_str) == Some("success") {
        return Ok(
            json!({ "sent": true, "retryAfter": integer(object(payload.get("data")).and_then(|data| data.get("retry_time"))).unwrap_or(60) }),
        );
    }
    if let Some(captcha) = object(payload.get("data"))
        .and_then(|data| data.get("captcha"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        let description =
            text(object(payload.get("data")).and_then(|data| data.get("description")));
        return Ok(
            json!({ "sent": false, "captcha": captcha, "message": if description.is_empty() { "请输入图形验证码".to_owned() } else { description } }),
        );
    }
    let description = text(object(payload.get("data")).and_then(|data| data.get("description")));
    if description.contains("滑块")
        || object(payload.get("data"))
            .and_then(|data| data.get("verify_center_decision_conf"))
            .is_some()
    {
        return Err(ServiceError::new(
            "AUTH_SMS_SLIDER",
            "官网短信接口触发了滑块风控（滑动滑块进行验证），请使用上方“扫码登录”",
        ));
    }
    Err(ServiceError::new(
        "AUTH_SMS_SEND_FAILED",
        if description.is_empty() {
            "发送验证码失败"
        } else {
            &description
        },
    ))
}

fn percent_encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

async fn sms_login(mobile: &Value, code: &Value, captcha: &Value) -> Result<Value, ServiceError> {
    let mobile = normalize_mobile(Some(mobile))?;
    let code = text(Some(code));
    if code.len() < 4 || code.len() > 8 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(ServiceError::new(
            "INVALID_REQUEST",
            "请输入 4–8 位短信验证码",
        ));
    }
    let mut form = vec![
        ("mobile", mix_encode(&mobile)),
        ("code", mix_encode(&code)),
        ("mix_mode", "1".to_owned()),
        ("next", format!("{PASSPORT_HOST}/")),
    ];
    let captcha = text(Some(captcha));
    if !captcha.is_empty() {
        form.push(("captcha", captcha));
    }
    let body = form
        .iter()
        .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    let url = passport_url("/passport/web/sms_login/", &[])?;
    let mut jar = state().lock().expect("auth state lock").cookies.clone();
    let response = auth_request(
        &url,
        reqwest::Method::POST,
        Some(body),
        Some("application/x-www-form-urlencoded"),
        &mut jar,
    )
    .await?;
    if response.status != reqwest::StatusCode::OK {
        return Err(ServiceError::new(
            "AUTH_SMS_LOGIN_HTTP",
            format!("短信登录失败（HTTP {}）", response.status.as_u16()),
        ));
    }
    let payload = parse_json(
        &response.text,
        "AUTH_SMS_LOGIN_FAILED",
        "短信登录响应格式异常",
    )?;
    if let Some(captcha) = object(payload.get("data"))
        .and_then(|data| data.get("captcha"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        && payload.get("message").and_then(Value::as_str) != Some("success")
    {
        let description =
            text(object(payload.get("data")).and_then(|data| data.get("description")));
        return Ok(
            json!({ "loggedIn": false, "captcha": captcha, "message": if description.is_empty() { "请输入图形验证码".to_owned() } else { description } }),
        );
    }
    if payload.get("message").and_then(Value::as_str) != Some("success") {
        let description =
            text(object(payload.get("data")).and_then(|data| data.get("description")));
        if description.contains("滑块")
            || object(payload.get("data"))
                .and_then(|data| data.get("verify_center_decision_conf"))
                .is_some()
        {
            return Err(ServiceError::new(
                "AUTH_SMS_SLIDER",
                "官网短信登录接口触发了滑块风控，请使用上方“扫码登录”",
            ));
        }
        return Err(ServiceError::new(
            "AUTH_SMS_LOGIN_FAILED",
            if description.is_empty() {
                "短信登录失败"
            } else {
                &description
            },
        ));
    }
    if let Some(redirect) = object(payload.get("data"))
        .and_then(|data| data.get("redirect_url"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        let _ = auth_request(redirect, reqwest::Method::GET, None, None, &mut jar).await?;
    }
    let user = verify_account(&mut jar).await?;
    Ok(
        json!({ "loggedIn": true, "user": user_value(&user), "persistent": account_status()["persistent"] }),
    )
}

fn parse_poll_response(payload: &Value) -> Result<Value, ServiceError> {
    let Some(data) = object(Some(payload)).and_then(|root| object(root.get("data"))) else {
        return Ok(json!({ "status": "waiting" }));
    };
    let status = text(data.get("status")).to_ascii_lowercase();
    if status == "5" || status == "expired" {
        return Ok(json!({ "status": "expired" }));
    }
    if status == "2" || status == "scanned" {
        return Ok(json!({ "status": "scanned" }));
    }
    if status != "3" && status != "confirmed" {
        return Ok(json!({ "status": "waiting" }));
    }
    let Some(user_payload) = data.get("user") else {
        return Ok(json!({ "status": "waiting" }));
    };
    let user = parse_user(user_payload)?;
    let user_value = set_user(user, None);
    Ok(json!({ "status": "confirmed", "user": user_value, "persistent": false }))
}

fn cloud_history(payload: &Value) -> Value {
    let list = object(Some(payload))
        .and_then(|root| object(root.get("data")))
        .and_then(|data| data.get("data_list"))
        .and_then(Value::as_array);
    let mut items = Vec::new();
    for row in list.into_iter().flatten() {
        let Some(row) = row.as_object() else { continue };
        if row.get("is_delete").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let series_id = text(
            row.get("book_id_str")
                .or_else(|| row.get("series_id"))
                .or_else(|| row.get("book_id")),
        );
        let title = text(
            row.get("series_title")
                .or_else(|| row.get("book_name"))
                .or_else(|| row.get("series_name"))
                .or_else(|| row.get("title")),
        );
        if !valid_id(&series_id) || title.is_empty() {
            continue;
        }
        let episode_id = text(
            row.get("vid")
                .or_else(|| row.get("item_id"))
                .or_else(|| row.get("video_id")),
        );
        items.push(json!({
            "seriesId": series_id,
            "title": title,
            "cover": catalog_cover(row.get("series_cover_url").or_else(|| row.get("thumb_url"))),
            "episodeId": if valid_id(&episode_id) { episode_id } else { String::new() },
            "episodeIndex": integer(row.get("vid_index").or_else(|| row.get("episode_index")).or_else(|| row.get("read_index"))).unwrap_or(1),
            "totalEpisodes": integer(row.get("episode_cnt").or_else(|| row.get("episode_count")).or_else(|| row.get("serial_count"))).unwrap_or(0),
        }));
    }
    json!({ "items": items })
}

fn cloud_bookshelf(payload: &Value) -> Value {
    let root = object(Some(payload));
    let shelf_rows = root
        .and_then(|root| object(root.get("data")))
        .and_then(|data| data.get("video_shelf_info"))
        .and_then(Value::as_array);
    let details = root
        .and_then(|root| root.get("details"))
        .and_then(Value::as_array);
    let mut detail_map = HashMap::new();
    for row in details.into_iter().flatten() {
        let Some(row) = row.as_object() else { continue };
        let id = text(row.get("book_id").or_else(|| row.get("series_id")));
        if valid_id(&id) {
            detail_map.insert(id, row);
        }
    }
    let mut items = Vec::new();
    for row in shelf_rows.into_iter().flatten() {
        let Some(row) = row.as_object() else { continue };
        let id = text(row.get("series_id"));
        if !valid_id(&id) {
            continue;
        }
        let detail = detail_map.get(&id).copied().unwrap_or(row);
        let title = text(
            detail
                .get("book_name")
                .or_else(|| detail.get("series_name"))
                .or_else(|| detail.get("title")),
        );
        if title.is_empty() {
            continue;
        }
        items.push(json!({
            "seriesId": id,
            "title": title,
            "cover": catalog_cover(detail.get("thumb_url").or_else(|| detail.get("series_cover"))),
            "episodes": integer(detail.get("serial_count").or_else(|| detail.get("episode_cnt"))).filter(|value| *value > 0).unwrap_or(0),
            "collectTime": integer(row.get("collect_time").or_else(|| row.get("modify_time"))).unwrap_or(0),
        }));
    }
    json!({ "items": items })
}

async fn fetch_cloud_history() -> Result<Value, ServiceError> {
    let cookie = account_cookie();
    let payload = metadata_protocol::account(
        "/reading/bookapi/read_history/list/v1/",
        vec![
            ("book_type".into(), "2".into()),
            ("limit".into(), "0".into()),
            ("offset".into(), "0".into()),
            ("last_min_read_timestamp_ms".into(), "0".into()),
            ("full_field".into(), "true".into()),
            ("is_first_load".into(), "true".into()),
            ("query_soft_deleted".into(), "false".into()),
        ],
        &cookie,
    )
    .await?;
    Ok(cloud_history(&payload))
}

async fn fetch_cloud_bookshelf() -> Result<Value, ServiceError> {
    let cookie = account_cookie();
    let shelf_payload = metadata_protocol::account(
        "/reading/bookapi/bookshelf/video/list/v",
        vec![
            ("book_type".into(), "2".into()),
            ("limit".into(), "50".into()),
            ("offset".into(), "0".into()),
        ],
        &cookie,
    )
    .await?;
    let mut ids = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if let Some(rows) = shelf_payload
        .get("data")
        .and_then(|data| data.get("video_shelf_info"))
        .and_then(Value::as_array)
    {
        for row in rows {
            let Some(row) = row.as_object() else { continue };
            let id = text(row.get("series_id"));
            if valid_id(&id) && seen.insert(id.clone()) {
                ids.push(id);
            }
        }
    }
    let mut details = Vec::new();
    for chunk in ids.chunks(20) {
        let detail_payload = metadata_protocol::account(
            "/reading/bookapi/multi-detail/v1/",
            vec![("book_id".into(), chunk.join(","))],
            &cookie,
        )
        .await?;
        if let Some(rows) = detail_payload.get("data").and_then(Value::as_array) {
            details.extend(rows.iter().cloned());
        }
    }
    let combined = json!({
        "data": shelf_payload.get("data").cloned().unwrap_or(Value::Null),
        "details": details,
    });
    Ok(cloud_bookshelf(&combined))
}

#[cfg(test)]
fn fixture(input: &Value) -> Option<&Value> {
    input.get("_payload").or_else(|| input.get("payload"))
}

#[cfg(not(test))]
fn fixture(_: &Value) -> Option<&Value> {
    None
}

fn clear_session() -> Value {
    let mut guard = state().lock().expect("auth state lock");
    guard.cookies.clear();
    guard.qr_jars.clear();
    guard.user = None;
    guard.pending_verification = false;
    guard.session_persisted = false;
    guard.restored_once = true;
    let _ = credentials::delete();
    json!({ "loggedIn": false, "persistent": credentials::available(), "pendingVerification": false })
}

/// Handles the same account routes as `service/server.cjs`. Response fixtures
/// are compiled only into tests; release builds always use the live transport.
pub(crate) async fn handle(path: &str, input: Value) -> Result<Value, ServiceError> {
    match path {
        "/auth/status" => restore_session().await,
        "/auth/logout" => Ok(clear_session()),
        "/auth/qr" => {
            if let Some(payload) = fixture(&input) {
                return parse_qr_response(payload);
            }
            create_qr_login().await
        }
        "/auth/poll" => {
            let token = text(input.get("token"));
            if token.is_empty() {
                return Err(ServiceError::new("INVALID_REQUEST", "二维码令牌无效"));
            }
            if let Some(payload) = fixture(&input) {
                return parse_poll_response(payload);
            }
            poll_qr_login(&token).await
        }
        "/auth/sms/send" => {
            if let Some(payload) = fixture(&input) {
                return Ok(payload.clone());
            }
            let mobile = input.get("mobile").cloned().unwrap_or(Value::Null);
            let captcha = input.get("captcha").cloned().unwrap_or(Value::Null);
            send_sms_code(&mobile, &captcha).await
        }
        "/auth/sms/login" => {
            if let Some(payload) = fixture(&input) {
                if payload.get("message").and_then(Value::as_str) == Some("success") {
                    let user = parse_user(payload)?;
                    let value = set_user(user, None);
                    return Ok(json!({ "loggedIn": true, "user": value, "persistent": false }));
                }
                return Ok(payload.clone());
            }
            let mobile = input.get("mobile").cloned().unwrap_or(Value::Null);
            let code = input.get("code").cloned().unwrap_or(Value::Null);
            let captcha = input.get("captcha").cloned().unwrap_or(Value::Null);
            sms_login(&mobile, &code, &captcha).await
        }
        "/auth/cloud-history" => {
            if let Some(payload) = fixture(&input) {
                return Ok(cloud_history(payload));
            }
            let _ = restore_session().await;
            if !account_status()["loggedIn"].as_bool().unwrap_or(false) || !has_session() {
                return Err(ServiceError::new(
                    "AUTH_REQUIRED",
                    "请先登录后再读取云端历史",
                ));
            }
            fetch_cloud_history().await
        }
        "/auth/cloud-bookshelf" => {
            if let Some(payload) = fixture(&input) {
                return Ok(cloud_bookshelf(payload));
            }
            let _ = restore_session().await;
            if !account_status()["loggedIn"].as_bool().unwrap_or(false) || !has_session() {
                return Err(ServiceError::new(
                    "AUTH_REQUIRED",
                    "请先登录后再读取云端追更/收藏",
                ));
            }
            fetch_cloud_bookshelf().await
        }
        _ => Err(ServiceError::new("NOT_FOUND", "请求地址不存在")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_mobile_and_mixes_without_logging() {
        assert_eq!(
            normalize_mobile(Some(&Value::String("138-0013 8000".into()))).unwrap(),
            "+8613800138000"
        );
        assert_eq!(mix_encode("+8613"), "2e3d333436");
        assert!(normalize_mobile(Some(&Value::String("123".into()))).is_err());
    }

    #[tokio::test]
    async fn parses_qr_and_logout_status() {
        let qr = handle(
            "/auth/qr",
            json!({"_payload":{"data":{"token":"t","qrcode":"img","expire_time":30}}}),
        )
        .await
        .unwrap();
        assert_eq!(qr["token"], "t");
        assert!(
            !handle("/auth/status", json!({})).await.unwrap()["loggedIn"]
                .as_bool()
                .unwrap()
        );
        assert!(
            !handle("/auth/logout", json!({})).await.unwrap()["loggedIn"]
                .as_bool()
                .unwrap()
        );
    }

    #[test]
    fn keeps_cookie_domains_separate() {
        let mut jar = HashMap::new();
        store_cookies_in(
            &mut jar,
            &["sessionid=abc; Domain=example.com".into()],
            "https://example.com/",
        );
        assert_eq!(
            cookie_header_from(&jar, "https://sub.example.com/"),
            "sessionid=abc"
        );
        assert!(cookie_header_from(&jar, "https://evil-example.com/").is_empty());
    }
}
