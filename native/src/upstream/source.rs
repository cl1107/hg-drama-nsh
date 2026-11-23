//! App playback model parsing and request assembly.

use std::collections::{BTreeMap, HashSet};

use crate::ServiceError;
use serde_json::Value;
use url::Url;

use super::crypto::{
    aes128_cbc_decrypt, b64_urlsafe_decode, hex_decode, hex_encode, pkcs7_unpad, sha512_bytes,
};
use super::device::{DeviceIdentity, playback_profile_pairs};
use super::signature::sign_player;
use super::v5::{PlaybackV5Input, PlaybackV5Request, V5Values, sign_playback_v5};

pub const PLAYER_HOSTS: [&str; 5] = [
    "api5-normal-sinfonlineb.fqnovel.com",
    "api5-normal-sinfonlinea.fqnovel.com",
    "api5-normal-sinfonlinec.fqnovel.com",
    "api5-normal.fqnovel.com",
    "api3-normal.fqnovel.com",
];
pub const VIDEO_UA: &str = "com.phoenix.read/71332 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)";
pub const PLAYBACK_UA: &str = "com.phoenix.read/74332 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)";
const URL_KDF_SALT: [u8; 64] = [
    0x4d, 0xd4, 0xc2, 0xe6, 0xb8, 0x31, 0x62, 0x09, 0x0e, 0x52, 0xb3, 0xc7, 0xa6, 0x73, 0x3b, 0xa4,
    0x1c, 0xb2, 0x46, 0x2b, 0x82, 0x9a, 0xb5, 0x8a, 0x19, 0x6b, 0x39, 0xdb, 0x57, 0x17, 0x75, 0x24,
    0xf4, 0x9b, 0xaf, 0x7f, 0x08, 0xe8, 0xd6, 0x8d, 0x26, 0xa7, 0x2e, 0x37, 0xc1, 0xa9, 0x5a, 0x2f,
    0x1f, 0x05, 0xa5, 0x18, 0x92, 0xae, 0xf2, 0x94, 0x97, 0x32, 0xb6, 0x2a, 0x38, 0xaa, 0xdd, 0x58,
];

#[derive(Clone, Debug, PartialEq)]
pub struct SourceVariant {
    pub url: String,
    pub content_key: Option<String>,
    pub codec: String,
    pub source: String,
    pub vid: String,
    pub user_agent: String,
    pub quality: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SourceModel {
    pub video_id: Option<String>,
    pub video_duration: Option<f64>,
    pub key_seed: Option<String>,
    pub video_list: Vec<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DownloadQuality {
    Auto,
    P1080,
    P720,
}

impl DownloadQuality {
    pub fn parse(value: Option<&str>) -> Result<Self, ServiceError> {
        match value.unwrap_or("auto") {
            "auto" => Ok(Self::Auto),
            "1080p" => Ok(Self::P1080),
            "720p" => Ok(Self::P720),
            _ => Err(ServiceError::new(
                "APP_INPUT",
                "下载清晰度无效，请选择自动、1080p 或 720p",
            )),
        }
    }

    fn minimum_pixels(self) -> u32 {
        match self {
            Self::Auto => 0,
            Self::P1080 => 1080,
            Self::P720 => 720,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::P1080 => "1080p",
            Self::P720 => "720p",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpstreamRequest {
    pub method: String,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub body: Option<Vec<u8>>,
}

fn string_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.trim().to_owned(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(boolean)) => boolean.to_string(),
        _ => String::new(),
    }
}

fn number_value(value: Option<&Value>) -> Option<f64> {
    value.and_then(|value| match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.parse().ok(),
        _ => None,
    })
}

fn positive_dimension(value: Option<&Value>) -> Option<u32> {
    let value = number_value(value)?;
    if value.is_finite() && value > 0.0 && value <= u32::MAX as f64 {
        Some(value as u32)
    } else {
        None
    }
}

fn pair_from(row: &Value, key: &str) -> Option<(u32, u32)> {
    let object = row.as_object()?;
    let metadata = object.get("video_meta").and_then(Value::as_object);
    for (width_key, height_key) in [("vwidth", "vheight"), ("width", "height")] {
        if let (Some(width), Some(height)) = (
            positive_dimension(object.get(width_key)),
            positive_dimension(object.get(height_key)),
        ) {
            return Some((width, height));
        }
        if let Some(metadata) = metadata {
            if let (Some(width), Some(height)) = (
                positive_dimension(metadata.get(width_key)),
                positive_dimension(metadata.get(height_key)),
            ) {
                return Some((width, height));
            }
        }
    }
    if key.is_empty() { None } else { None }
}

fn row_codec(row: &Value) -> String {
    let object = row.as_object();
    let metadata = object
        .and_then(|object| object.get("video_meta"))
        .and_then(Value::as_object);
    object
        .and_then(|object| object.get("codec_type"))
        .map(|value| string_value(Some(value)))
        .filter(|value| !value.is_empty())
        .or_else(|| {
            metadata
                .and_then(|object| object.get("codec_type"))
                .map(|value| string_value(Some(value)))
        })
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn row_quality(row: &Value) -> String {
    let object = row.as_object();
    let metadata = object
        .and_then(|object| object.get("video_meta"))
        .and_then(Value::as_object);
    ["quality_desc", "definition"]
        .iter()
        .find_map(|key| {
            object
                .and_then(|object| object.get(*key))
                .map(|value| string_value(Some(value)))
                .filter(|value| !value.is_empty())
        })
        .or_else(|| {
            metadata
                .and_then(|object| object.get("definition"))
                .map(|value| string_value(Some(value)))
                .filter(|value| !value.is_empty())
        })
        .or_else(|| {
            ["height", "vheight"].iter().find_map(|key| {
                object
                    .and_then(|object| object.get(*key))
                    .map(|value| string_value(Some(value)))
                    .filter(|value| !value.is_empty())
            })
        })
        .unwrap_or_default()
}

fn row_pixels(row: &Value, quality: &str) -> u32 {
    pair_from(row, quality)
        .map(|(width, height)| width.min(height))
        .or_else(|| {
            let digits: String = quality
                .chars()
                .filter(|value| value.is_ascii_digit())
                .collect();
            digits.parse().ok()
        })
        .unwrap_or(0)
}

fn codec_rank(codec: &str) -> u8 {
    match codec {
        "h264" | "avc" | "avc1" => 0,
        "hevc" | "h265" | "hvc1" | "hev1" | "bytevc1" => 1,
        "bytevc2" => 2,
        _ => 3,
    }
}

fn has_url(row: &Value) -> bool {
    let Some(object) = row.as_object() else {
        return false;
    };
    object
        .get("main_url")
        .is_some_and(|value| !string_value(Some(value)).is_empty())
        || object
            .get("backup_url")
            .is_some_and(|value| !string_value(Some(value)).is_empty())
        || object.get("backup_url_list").is_some_and(Value::is_array)
}

pub fn source_model(value: &Value) -> Result<SourceModel, ServiceError> {
    let object = value
        .as_object()
        .ok_or_else(|| ServiceError::new("INVALID_RESPONSE", "App 接口未返回本集片源模型"))?;
    let list = object
        .get("video_list")
        .and_then(Value::as_object)
        .map(|list| {
            list.values()
                .filter(|row| row.is_object())
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    Ok(SourceModel {
        video_id: object
            .get("video_id")
            .map(|value| string_value(Some(value)))
            .filter(|value| !value.is_empty()),
        video_duration: number_value(object.get("video_duration")),
        key_seed: object
            .get("key_seed")
            .map(|value| string_value(Some(value)))
            .filter(|value| !value.is_empty()),
        video_list: list,
    })
}

pub fn derive_content_key(value: &str) -> Result<[u8; 16], ServiceError> {
    let raw = b64_urlsafe_decode(&value.replace('-', "+").replace('_', "/"))
        .map_err(|_| ServiceError::new("INVALID_RESPONSE", "spade_a 格式无效"))?;
    if raw.len() < 3 {
        return Err(ServiceError::new("INVALID_RESPONSE", "spade_a 太短"));
    }
    let mut v8 = raw.len() as isize - (raw[0] ^ raw[1] ^ raw[2]) as isize + 47;
    v8 = v8.min(raw.len() as isize - 1);
    if v8 < 33 {
        return Err(ServiceError::new(
            "INVALID_RESPONSE",
            "spade_a 密钥长度无效",
        ));
    }
    let v8 = v8 as usize;
    let mut work = raw[1..1 + v8].to_vec();
    let mut a = 85_u8;
    let mut b = 246_u8;
    for (index, byte) in work.iter_mut().enumerate() {
        let old = *byte;
        let previous = if index & 1 != 0 { a } else { b };
        if index & 1 != 0 {
            a = old;
        } else {
            b = old;
        }
        let pop = (index as u32).count_ones() as u8;
        *byte = 0_u8
            .wrapping_sub(21)
            .wrapping_sub(pop)
            .wrapping_add(previous ^ old);
    }
    let key_ascii = std::str::from_utf8(&work[1..33])
        .map_err(|_| ServiceError::new("INVALID_RESPONSE", "App 视频密钥格式无效"))?;
    let key = hex_decode(key_ascii)
        .map_err(|_| ServiceError::new("INVALID_RESPONSE", "App 视频密钥格式无效"))?;
    key.try_into()
        .map_err(|_| ServiceError::new("INVALID_RESPONSE", "App 视频密钥长度无效"))
}

pub fn decrypt_spade_url(value: &str, seed: &[u8]) -> Result<String, ServiceError> {
    if value.trim().is_empty() {
        return Ok(String::new());
    }
    let raw = b64_urlsafe_decode(value)
        .map_err(|_| ServiceError::new("INVALID_RESPONSE", "spade URL 编码无效"))?;
    if raw.len() < 5 || raw[0] != 0xa8 || raw[2] != 1 || raw[3] != 0 {
        return Err(ServiceError::new(
            "INVALID_RESPONSE",
            "spade URL 头格式无效",
        ));
    }
    let cipher_length = ((raw.len() - 4) / 16) * 16;
    if cipher_length == 0 {
        return Err(ServiceError::new(
            "INVALID_RESPONSE",
            "spade URL 没有完整密文块",
        ));
    }
    let first = sha512_bytes(seed);
    let mut kdf = Vec::with_capacity(128);
    kdf.extend_from_slice(&first);
    kdf.extend_from_slice(&URL_KDF_SALT);
    let derived = sha512_bytes(&kdf);
    let mut key = [0_u8; 16];
    let mut iv = [0_u8; 16];
    key.copy_from_slice(&derived[..16]);
    iv.copy_from_slice(&derived[16..32]);
    let plaintext = aes128_cbc_decrypt(&raw[4..4 + cipher_length], &key, &iv);
    let plaintext = pkcs7_unpad(plaintext, 16);
    let mut end = plaintext.len();
    while end > 0 && plaintext[end - 1] == 0 {
        end -= 1;
    }
    Ok(String::from_utf8_lossy(&plaintext[..end]).into_owned())
}

pub fn clean_url(value: &str) -> String {
    value
        .trim()
        .replace("\\/", "/")
        .replace("\\u0026", "&")
        .replace("&amp;", "&")
}

pub fn checked_media_url(value: &str, domains: &[&str]) -> Result<String, ServiceError> {
    let parsed = Url::parse(value)
        .map_err(|_| ServiceError::new("INVALID_RESPONSE", "App 片源地址格式无效"))?;
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let accepted = domains
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")));
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some_and(|port| port != 443)
        || !accepted
    {
        return Err(ServiceError::new(
            "SECURITY_BLOCKED",
            "App 片源返回了不受支持的服务地址",
        ));
    }
    Ok(parsed.to_string())
}

fn fallback_urls(row: &Value) -> Vec<String> {
    let Some(object) = row.as_object() else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for key in ["main_url", "backup_url"] {
        if let Some(Value::String(value)) = object.get(key)
            && !value.is_empty()
        {
            result.push(value.clone());
        }
    }
    if let Some(values) = object.get("backup_url_list").and_then(Value::as_array) {
        result.extend(values.iter().filter_map(|value| match value {
            Value::String(value) if !value.is_empty() => Some(value.clone()),
            _ => None,
        }));
    }
    result
}

fn selected_spade(row: &Value) -> Option<String> {
    let object = row.as_object()?;
    object
        .get("spade_a")
        .map(|value| string_value(Some(value)))
        .filter(|value| !value.is_empty())
        .or_else(|| {
            object
                .get("encrypt_info")
                .and_then(Value::as_object)
                .and_then(|info| info.get("spade_a"))
                .map(|value| string_value(Some(value)))
                .filter(|value| !value.is_empty())
        })
}

fn encryption_value(row: &Value) -> Option<&Value> {
    row.as_object()
        .and_then(|object| object.get("encrypt_info"))
        .and_then(Value::as_object)
        .and_then(|info| info.get("encrypt"))
        .or_else(|| row.as_object().and_then(|object| object.get("encrypt")))
}

fn is_explicit_clear(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(false)) => true,
        Some(Value::Number(number)) => number.as_i64() == Some(0),
        Some(Value::String(text)) => matches!(text.as_str(), "0" | "false"),
        _ => false,
    }
}

pub fn select_all_variants(
    value: &Value,
    vid: &str,
    quality: Option<&str>,
    allow_lower_quality: bool,
    require_encryption_metadata: bool,
    minimum_pixels: u32,
) -> Result<Vec<SourceVariant>, ServiceError> {
    if !vid.bytes().all(|byte| byte.is_ascii_digit()) || vid.is_empty() || vid.len() > 30 {
        return Err(ServiceError::new("APP_INPUT", "分集编号无效"));
    }
    let quality = DownloadQuality::parse(quality)?;
    let model = source_model(value)?;
    let mut rows: Vec<(Value, u8, String, u32, Option<(u32, u32)>)> = model
        .video_list
        .into_iter()
        .filter(|row| has_url(row))
        .filter_map(|row| {
            let codec = row_codec(&row);
            let rank = codec_rank(&codec);
            if rank >= 3 {
                return None;
            }
            let quality_text = row_quality(&row);
            let pair = pair_from(&row, &quality_text);
            let pixels = pair
                .map(|(width, height)| width.min(height))
                .unwrap_or_else(|| row_pixels(&row, &quality_text));
            if minimum_pixels > 0
                && pair.map(|(width, height)| width.min(height)).unwrap_or(0) < minimum_pixels
            {
                return None;
            }
            if rank == 2
                && (pair.is_none()
                    || model.video_id.as_deref().unwrap_or_default().is_empty()
                    || model.video_duration.unwrap_or(0.0) <= 0.0)
            {
                return None;
            }
            Some((row, rank, quality_text, pixels, pair))
        })
        .collect();
    rows.sort_by(|a, b| {
        if quality == DownloadQuality::Auto {
            a.1.cmp(&b.1).then_with(|| b.3.cmp(&a.3))
        } else {
            let a_meets =
                a.4.map(|(w, h)| w.min(h) >= quality.minimum_pixels())
                    .unwrap_or(false);
            let b_meets =
                b.4.map(|(w, h)| w.min(h) >= quality.minimum_pixels())
                    .unwrap_or(false);
            b_meets
                .cmp(&a_meets)
                .then_with(|| {
                    if a_meets && (a.1 == 2) != (b.1 == 2) {
                        (a.1 == 2).cmp(&(b.1 == 2))
                    } else if a_meets {
                        a.3.cmp(&b.3)
                    } else {
                        b.3.cmp(&a.3)
                    }
                })
                .then_with(|| a.1.cmp(&b.1))
        }
    });
    let best_pixels = rows.first().map(|row| row.3).unwrap_or(0);
    if quality != DownloadQuality::Auto && !allow_lower_quality {
        rows.retain(|row| {
            row.4
                .map(|(w, h)| w.min(h) >= quality.minimum_pixels())
                .unwrap_or(false)
        });
    }
    if quality == DownloadQuality::Auto && best_pixels > 0 {
        rows.retain(|row| row.3 == best_pixels);
    }
    if rows.is_empty() {
        return Err(ServiceError::new(
            "NO_COMPATIBLE_SOURCE",
            "本集暂未提供兼容的 H.264/HEVC 片源",
        ));
    }
    let mut last_error = None;
    let mut variants = Vec::new();
    let mut seen = HashSet::new();
    for (row, rank, quality_text, _pixels, pair) in rows {
        let spade = selected_spade(&row);
        let encryption = encryption_value(&row);
        if require_encryption_metadata && spade.is_none() && !is_explicit_clear(encryption) {
            last_error = Some(ServiceError::new(
                "INVALID_RESPONSE",
                "本集片源缺少有效解密信息",
            ));
            continue;
        }
        let content_key = match spade.as_deref() {
            Some(value) => match derive_content_key(value) {
                Ok(key) => Some(hex_encode(&key)),
                Err(error) => {
                    last_error = Some(error);
                    continue;
                }
            },
            None => None,
        };
        for candidate in fallback_urls(&row) {
            let media = match model.key_seed.as_deref() {
                Some(seed) => match super::crypto::b64_urlsafe_decode(seed).and_then(|seed| {
                    decrypt_spade_url(&candidate, &seed).map_err(|error| error.to_string())
                }) {
                    Ok(value) => value,
                    Err(error) => {
                        last_error = Some(ServiceError::new("INVALID_RESPONSE", error.to_string()));
                        continue;
                    }
                },
                None => clean_url(&candidate),
            };
            let url = match checked_media_url(
                &media,
                &["qznovelvod.com", "fqnovelvod.com", "douyinvod.com"],
            ) {
                Ok(value) => value,
                Err(error) => {
                    last_error = Some(error);
                    continue;
                }
            };
            let identity = format!("{url}:{}", content_key.as_deref().unwrap_or_default());
            if !seen.insert(identity) {
                continue;
            }
            let codec = if row_codec(&row) == "bytevc1" {
                "hevc".to_owned()
            } else {
                row_codec(&row)
            };
            let quality_output = if allow_lower_quality && quality != DownloadQuality::Auto {
                pair.map(|(w, h)| format!("{}p", w.min(h)))
                    .unwrap_or_default()
            } else if quality == DownloadQuality::Auto {
                quality_text.clone()
            } else {
                quality.label().to_owned()
            };
            variants.push(SourceVariant {
                url,
                content_key: content_key.clone(),
                codec,
                source: "app".to_owned(),
                vid: vid.to_owned(),
                user_agent: if require_encryption_metadata {
                    PLAYBACK_UA.to_owned()
                } else {
                    VIDEO_UA.to_owned()
                },
                quality: quality_output,
                width: pair.map(|(w, _)| w),
                height: pair.map(|(_, h)| h),
                duration: (rank == 2).then_some(model.video_duration.unwrap_or_default()),
            });
        }
    }
    if variants.is_empty() {
        Err(last_error
            .unwrap_or_else(|| ServiceError::new("INVALID_RESPONSE", "本集片源地址或密钥无法解析")))
    } else {
        Ok(variants)
    }
}

pub fn select_variants(
    value: &Value,
    vid: &str,
    quality: Option<&str>,
    allow_lower_quality: bool,
    require_encryption_metadata: bool,
    minimum_pixels: u32,
) -> Result<SourceVariant, ServiceError> {
    select_all_variants(
        value,
        vid,
        quality,
        allow_lower_quality,
        require_encryption_metadata,
        minimum_pixels,
    )?
    .into_iter()
    .next()
    .ok_or_else(|| ServiceError::new("INVALID_RESPONSE", "本集片源地址或密钥无法解析"))
}

fn gzip_store(data: &[u8]) -> Vec<u8> {
    let mut result = vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3];
    let mut offset = 0;
    while offset < data.len() {
        let length = (data.len() - offset).min(65_535);
        result.push(if offset + length == data.len() { 1 } else { 0 });
        result.extend_from_slice(&(length as u16).to_le_bytes());
        result.extend_from_slice(&(!(length as u16)).to_le_bytes());
        result.extend_from_slice(&data[offset..offset + length]);
        offset += length;
    }
    if data.is_empty() {
        result.extend_from_slice(&[1, 0, 0, 0xff, 0xff]);
    }
    result.extend_from_slice(&crc32(data).to_le_bytes());
    result.extend_from_slice(&(data.len() as u32).to_le_bytes());
    result
}

fn approved_player_host(host: &str) -> bool {
    PLAYER_HOSTS.contains(&host)
}

fn crc32(input: &[u8]) -> u32 {
    let mut crc = 0xffff_ffff_u32;
    for byte in input {
        crc ^= *byte as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                crc >> 1 ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn encode_query(pairs: &[(String, String)]) -> String {
    pairs
        .iter()
        .map(|(key, value)| format!("{}={}", query_component(key), query_component(value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn query_component(value: &str) -> String {
    let mut output = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.' | b'~' | b'*') {
            output.push(*byte as char);
        } else {
            output.push_str(&format!("%{:02X}", byte));
        }
    }
    output
}

pub fn build_v5_play_request(
    identity: &DeviceIdentity,
    video_id: &str,
    payload: &str,
    host: &str,
    now_millis: u64,
) -> Result<(PlaybackV5Request, Vec<u8>), ServiceError> {
    super::device::validate_identity(identity)?;
    if video_id.is_empty()
        || video_id.len() > 30
        || !video_id.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(ServiceError::new("APP_INPUT", "分集编号无效"));
    }
    if !approved_player_host(host) {
        return Err(ServiceError::new(
            "SECURITY_BLOCKED",
            "播放主机不在允许范围",
        ));
    }
    let body = gzip_store(payload.as_bytes());
    let values = V5Values::new([
        ("aid", "8662"),
        ("app_name", "novelread"),
        ("version_code", "74332"),
        ("version_name", "7.4.3.32"),
        ("channel", "vivo_8662_64"),
        ("device_platform", "android"),
        ("device_type", "PGT-AN10"),
        ("os_version", "12"),
        ("update_version_code", "74332"),
        ("iid", &identity.iid),
        ("cdid", &identity.cdid),
        ("device_id", &identity.device_id),
    ]);
    let signed = sign_playback_v5(PlaybackV5Input {
        base: format!("https://{host}/novel/player/multi_video_model/player/v1"),
        values,
        body: Some(body.clone()),
        now_millis,
        allow_empty_body: false,
        process_nonce: None,
        process_started_millis: None,
    })?;
    let mut headers = signed.headers.clone();
    headers.insert("User-Agent".to_owned(), "com.phoenix.read/73932 (Linux; U; Android 12; zh_CN_#Hans; PGT-AN10; Build/V417IR;tt-ok/3.12.13.20)".to_owned());
    headers.insert("Accept".to_owned(), "application/json".to_owned());
    headers.insert(
        "Content-Type".to_owned(),
        "application/json; charset=utf-8".to_owned(),
    );
    headers.insert("Content-Encoding".to_owned(), "gzip".to_owned());
    Ok((
        PlaybackV5Request {
            url: signed.url,
            headers,
        },
        body,
    ))
}

pub fn build_video_tab_request(
    identity: &DeviceIdentity,
    video_id: &str,
    host: &str,
    now_millis: u64,
) -> Result<UpstreamRequest, ServiceError> {
    super::device::validate_identity(identity)?;
    if video_id.is_empty() || !video_id.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(ServiceError::new("APP_INPUT", "分集编号无效"));
    }
    if !approved_player_host(host) {
        return Err(ServiceError::new(
            "SECURITY_BLOCKED",
            "播放主机不在允许范围",
        ));
    }
    let values = V5Values::new([
        ("aid", "8662"),
        ("app_name", "novelread"),
        ("version_code", "74332"),
        ("version_name", "7.4.3.32"),
        ("channel", "vivo_8662_64"),
        ("device_platform", "android"),
        ("device_type", "PGT-AN10"),
        ("os_version", "12"),
        ("update_version_code", "74332"),
        ("iid", &identity.iid),
        ("cdid", &identity.cdid),
        ("device_id", &identity.device_id),
        ("video_id", video_id),
        ("video_id_type", "0"),
        ("device_level", "1"),
        ("need_all_video_definition", "1"),
        ("need_mp4_align", "0"),
        ("use_os_player", "0"),
        ("video_platform", "1024"),
        ("source", "0"),
        ("from_video_id", ""),
    ]);
    let signed = sign_playback_v5(PlaybackV5Input {
        base: format!("https://{host}/reading/bookapi/video_tab/multi_video_model/v1/"),
        values,
        body: None,
        now_millis,
        allow_empty_body: true,
        process_nonce: None,
        process_started_millis: None,
    })?;
    let mut headers = signed.headers;
    headers.insert("User-Agent".to_owned(), VIDEO_UA.replace("71332", "73932"));
    headers.insert("Accept".to_owned(), "application/json".to_owned());
    Ok(UpstreamRequest {
        method: "GET".to_owned(),
        url: signed.url,
        headers,
        body: None,
    })
}

pub fn build_legacy_play_request(
    identity: &DeviceIdentity,
    payload: &str,
    video_id: &str,
    host: &str,
    now_millis: u64,
    rand_field: i128,
    ladon_random: [u8; 4],
) -> Result<UpstreamRequest, ServiceError> {
    if video_id.is_empty()
        || video_id.len() > 30
        || !video_id.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(ServiceError::new("APP_INPUT", "分集编号无效"));
    }
    if !approved_player_host(host) {
        return Err(ServiceError::new(
            "SECURITY_BLOCKED",
            "播放主机不在允许范围",
        ));
    }
    let timestamp = now_millis / 1000;
    let mut pairs = playback_profile_pairs(identity)?;
    pairs.push(("ts".to_owned(), timestamp.to_string()));
    pairs.push(("_rticket".to_owned(), now_millis.to_string()));
    let query = encode_query(&pairs);
    let body = gzip_store(payload.as_bytes());
    let signature = sign_player(
        &query,
        Some(&body),
        timestamp as i128,
        rand_field,
        ladon_random,
    )?;
    let mut headers = signature.as_map();
    headers.insert("User-Agent".to_owned(), PLAYBACK_UA.to_owned());
    headers.insert(
        "Accept".to_owned(),
        "application/json; charset=utf-8,application/x-protobuf".to_owned(),
    );
    headers.insert(
        "Content-Type".to_owned(),
        "application/json; charset=UTF-8".to_owned(),
    );
    headers.insert("Content-Encoding".to_owned(), "gzip".to_owned());
    headers.insert("x-ss-dp".to_owned(), "8662".to_owned());
    headers.insert("sdk-version".to_owned(), "2".to_owned());
    headers.insert("x-xs-from-web".to_owned(), "0".to_owned());
    headers.insert("x-tt-dt".to_owned(), String::new());
    headers.insert("x-tt-store-region".to_owned(), "cn".to_owned());
    headers.insert("x-tt-store-region-src".to_owned(), "did".to_owned());
    Ok(UpstreamRequest {
        method: "POST".to_owned(),
        url: format!("https://{host}/novel/player/multi_video_model/v1/?{query}"),
        headers,
        body: Some(body),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_derivation_rejects_short_spade() {
        assert!(derive_content_key("AQID").is_err());
    }

    #[test]
    fn source_url_whitelist_rejects_credentials_and_wrong_host() {
        assert!(
            checked_media_url("https://user@example.com/video.mp4", &["qznovelvod.com"]).is_err()
        );
        assert!(checked_media_url("http://qznovelvod.com/video.mp4", &["qznovelvod.com"]).is_err());
        assert!(checked_media_url("https://qznovelvod.com/video.mp4", &["qznovelvod.com"]).is_ok());
    }

    #[test]
    fn source_model_filters_null_rows() {
        let value = serde_json::json!({"video_id":"123","video_duration":10,"video_list":{"a":null,"b":{"codec_type":"h264","main_url":"https://qznovelvod.com/a.mp4","vwidth":720,"vheight":1280,"encrypt":false}}});
        let selected = select_variants(&value, "123", Some("auto"), false, false, 0).unwrap();
        assert_eq!(selected.codec, "h264");
        assert_eq!(selected.width, Some(720));
    }
}
