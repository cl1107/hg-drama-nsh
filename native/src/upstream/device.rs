//! Anonymous Android playback-device registration.
//!
//! The network worker owns retries and cancellation.  This module builds the
//! exact registration envelope and validates the small, safe identity returned
//! by the service; it never retains cookies, account tokens, or response blobs.

use std::collections::BTreeMap;

use crate::ServiceError;
use rand::RngCore;
use serde::Serialize;

use super::crypto::{aes128_cbc_encrypt, hex_encode, md5_bytes, pkcs7_pad, sha512_bytes};

pub const REGISTER_URL: &str = "https://log5-applog-lf.fqnovel.com/service/2/device_register/?tt_data=a&cronet_version=8d40f833_2026-03-03&ttnet_version=4.2.243.31-douyin&use_store_region_cookie=1";
const KDF_SALT: [u8; 64] = [
    0x4d, 0xd4, 0xc2, 0xe6, 0xb8, 0x31, 0x62, 0x09, 0x0e, 0x52, 0xb3, 0xc7, 0xa6, 0x73, 0x3b, 0xa4,
    0x1c, 0xb2, 0x46, 0x2b, 0x82, 0x9a, 0xb5, 0x8a, 0x19, 0x6b, 0x39, 0xdb, 0x57, 0x17, 0x75, 0x24,
    0xf4, 0x9b, 0xaf, 0x7f, 0x08, 0xe8, 0xd6, 0x8d, 0x26, 0xa7, 0x2e, 0x37, 0xc1, 0xa9, 0x5a, 0x2f,
    0x1f, 0x05, 0xa5, 0x18, 0x92, 0xae, 0xf2, 0x94, 0x97, 0x32, 0xb6, 0x2a, 0x38, 0xaa, 0xdd, 0x58,
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceIdentity {
    pub device_id: String,
    pub iid: String,
    pub cdid: String,
}

#[derive(Clone, Debug)]
pub struct DeviceRegistration {
    pub url: String,
    pub method: &'static str,
    pub body: Vec<u8>,
    pub headers: BTreeMap<String, String>,
    pub cdid: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceRegistrationResponse {
    pub identity: DeviceIdentity,
}

#[derive(Serialize)]
struct RegistrationEnvelope {
    magic_tag: &'static str,
    header: RegistrationHeader,
    _gen_time: i64,
}

#[derive(Serialize)]
struct RegistrationHeader {
    display_name: &'static str,
    update_version_code: i64,
    manifest_version_code: i64,
    app_version_minor: &'static str,
    aid: i64,
    channel: &'static str,
    package: &'static str,
    app_version: &'static str,
    version_code: i64,
    sdk_version: &'static str,
    sdk_target_version: i64,
    git_hash: &'static str,
    os: &'static str,
    os_version: &'static str,
    os_api: i64,
    device_model: &'static str,
    device_brand: &'static str,
    device_manufacturer: &'static str,
    cpu_abi: &'static str,
    release_build: &'static str,
    density_dpi: i64,
    display_density: &'static str,
    resolution: &'static str,
    language: &'static str,
    timezone: i64,
    access: &'static str,
    not_request_sender: i64,
    carrier: &'static str,
    mcc_mnc: &'static str,
    rom: &'static str,
    rom_version: &'static str,
    cdid: String,
    sig_hash: &'static str,
    openudid: String,
    clientudid: String,
    ipv6_list: Vec<String>,
    region: &'static str,
    tz_name: &'static str,
    tz_offset: i64,
    sim_region: &'static str,
    sim_serial_number: Vec<String>,
    oaid_may_support: bool,
    req_id: String,
    device_platform: &'static str,
    custom: RegistrationCustom,
    pre_installed_channel: &'static str,
    apk_first_install_time: i64,
    is_system_app: i64,
    sdk_flavor: &'static str,
    guest_mode: i64,
}

#[derive(Serialize)]
struct RegistrationCustom {
    account_region_src: &'static str,
    account_region: &'static str,
    host_bit: i64,
    dragon_device_type: &'static str,
}

fn uuid_from_bytes(bytes: &[u8; 16]) -> String {
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

fn random_uuid(rng: &mut impl RngCore) -> String {
    let mut bytes = [0_u8; 16];
    rng.fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid_from_bytes(&bytes)
}

fn default_header(now: i64, cdid: String, rng: &mut impl RngCore) -> RegistrationHeader {
    RegistrationHeader {
        display_name: "红果免费短剧",
        update_version_code: 73932,
        manifest_version_code: 73932,
        app_version_minor: "7.3.9.32",
        aid: 8662,
        channel: "update_64",
        package: "com.phoenix.read",
        app_version: "7.3.9.32",
        version_code: 73932,
        sdk_version: "3.7.0-rc.34-fanqie-xiaoshuo",
        sdk_target_version: 29,
        git_hash: "3a88f4e",
        os: "Android",
        os_version: "16",
        os_api: 36,
        device_model: "25053RT47C",
        device_brand: "Redmi",
        device_manufacturer: "Redmi",
        cpu_abi: "arm64-v8a",
        release_build: "b5e187f",
        density_dpi: 520,
        display_density: "mdpi",
        resolution: "1280x2772",
        language: "zh",
        timezone: 8,
        access: "wifi",
        not_request_sender: 0,
        carrier: "CHINA MOBILE",
        mcc_mnc: "46000",
        rom: "eng.root.20231116.160340",
        rom_version: "W528JS release-keys",
        cdid,
        sig_hash: "56a962410c494bbaf0b58dba20cae56f",
        openudid: {
            let mut value = [0_u8; 8];
            rng.fill_bytes(&mut value);
            hex_encode(&value)
        },
        clientudid: random_uuid(rng),
        ipv6_list: Vec::new(),
        region: "CN",
        tz_name: "Asia/Shanghai",
        tz_offset: 28800,
        sim_region: "cn",
        sim_serial_number: Vec::new(),
        oaid_may_support: false,
        req_id: random_uuid(rng),
        device_platform: "android",
        custom: RegistrationCustom {
            account_region_src: "fallback",
            account_region: "cn",
            host_bit: 64,
            dragon_device_type: "phone",
        },
        pre_installed_channel: "",
        apk_first_install_time: now,
        is_system_app: 0,
        sdk_flavor: "china",
        guest_mode: 0,
    }
}

fn gzip_store(data: &[u8]) -> Vec<u8> {
    // A valid gzip stream with stored DEFLATE blocks is sufficient for the
    // registration endpoint and avoids a second runtime dependency in the
    // native worker.  The service only requires gzip framing, not compression.
    let mut output = vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3];
    let mut offset = 0;
    while offset < data.len() {
        let length = (data.len() - offset).min(65_535);
        let final_block = offset + length == data.len();
        output.push(if final_block { 1 } else { 0 });
        output.extend_from_slice(&(length as u16).to_le_bytes());
        output.extend_from_slice(&(!(length as u16)).to_le_bytes());
        output.extend_from_slice(&data[offset..offset + length]);
        offset += length;
    }
    if data.is_empty() {
        output.extend_from_slice(&[1, 0, 0, 0xff, 0xff]);
    }
    output.extend_from_slice(&crc32(data).to_le_bytes());
    output.extend_from_slice(&(data.len() as u32).to_le_bytes());
    output
}

fn crc32(input: &[u8]) -> u32 {
    let mut crc = 0xffff_ffff_u32;
    for byte in input {
        crc ^= *byte as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

/// Build a registration request.  Supplying entropy is useful for deterministic
/// tests; production callers should pass `None`.
pub fn build_registration_request(
    now_millis: i64,
    cdid: Option<String>,
    entropy: Option<[u8; 32]>,
) -> Result<DeviceRegistration, ServiceError> {
    if now_millis < 0 {
        return Err(ServiceError::new("APP_INPUT", "设备注册时间无效"));
    }
    let mut rng = rand::rng();
    let cdid = cdid.unwrap_or_else(|| random_uuid(&mut rng));
    let header = default_header(now_millis, cdid.clone(), &mut rng);
    let envelope = RegistrationEnvelope {
        magic_tag: "ss_app_log",
        header,
        _gen_time: now_millis,
    };
    let json = serde_json::to_vec(&envelope)
        .map_err(|_| ServiceError::new("INVALID_RESPONSE", "设备注册参数序列化失败"))?;
    let compressed = gzip_store(&json);
    let random = entropy.unwrap_or_else(|| {
        let mut value = [0_u8; 32];
        rng.fill_bytes(&mut value);
        value
    });
    let inner = sha512_bytes(&random);
    let mut kdf = Vec::with_capacity(96);
    kdf.extend_from_slice(&inner);
    kdf.extend_from_slice(&KDF_SALT);
    let derived = sha512_bytes(&kdf);
    let plaintext_hash = sha512_bytes(&compressed);
    let mut plaintext = Vec::with_capacity(64 + compressed.len());
    plaintext.extend_from_slice(&plaintext_hash);
    plaintext.extend_from_slice(&compressed);
    let mut key = [0_u8; 16];
    let mut iv = [0_u8; 16];
    key.copy_from_slice(&derived[..16]);
    iv.copy_from_slice(&derived[16..32]);
    let encrypted = aes128_cbc_encrypt(&pkcs7_pad(&plaintext, 16), &key, &iv);
    let mut body = vec![0x74, 0x63, 0x05, 0x10, 0, 0];
    body.extend_from_slice(&random);
    body.extend_from_slice(&encrypted);
    let stub = md5_bytes(&body);
    let mut headers = BTreeMap::new();
    headers.insert("User-Agent".to_owned(), "com.phoenix.read/72232 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3)".to_owned());
    headers.insert("Accept".to_owned(), "application/json".to_owned());
    headers.insert(
        "Content-Type".to_owned(),
        "application/octet-stream;tt-data=a".to_owned(),
    );
    headers.insert("log-encode-type".to_owned(), "gzip".to_owned());
    headers.insert("x-ss-dp".to_owned(), "8662".to_owned());
    headers.insert("x-ss-req-ticket".to_owned(), now_millis.to_string());
    headers.insert(
        "x-vc-bdturing-sdk-version".to_owned(),
        "4.0.3.cn".to_owned(),
    );
    headers.insert("lc".to_owned(), "101".to_owned());
    headers.insert("sdk-version".to_owned(), "2".to_owned());
    headers.insert("passport-sdk-version".to_owned(), "5051452".to_owned());
    headers.insert(
        "x-neptune".to_owned(),
        "-8|50:51:59:30:40:47:49:39".to_owned(),
    );
    headers.insert("x-ss-stub".to_owned(), hex_encode(&stub).to_uppercase());
    Ok(DeviceRegistration {
        url: REGISTER_URL.to_owned(),
        method: "POST",
        body,
        headers,
        cdid,
    })
}

fn valid_id(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text)
            if (1..=30).contains(&text.len())
                && text.bytes().all(|byte| byte.is_ascii_digit())
                && text.bytes().any(|byte| byte != b'0') =>
        {
            Some(text.clone())
        }
        serde_json::Value::Number(number) => {
            let value = number.as_f64()?;
            if !value.is_finite()
                || value <= 0.0
                || value.fract() != 0.0
                || value > 9_007_199_254_740_991.0
            {
                return None;
            }
            Some(format!("{value:.0}"))
        }
        _ => None,
    }
}

fn response_id(response: &serde_json::Value, name: &str) -> Option<String> {
    let preferred = response.get(format!("{name}_str"));
    let use_fallback = match preferred {
        None | Some(serde_json::Value::Null) => true,
        Some(serde_json::Value::String(text)) => text.is_empty(),
        Some(_) => false,
    };
    let value = if use_fallback {
        response.get(name)
    } else {
        preferred
    };
    value.and_then(valid_id)
}

pub fn parse_registration_response(
    response: &serde_json::Value,
) -> Result<DeviceRegistrationResponse, ServiceError> {
    parse_registration_response_with_cdid(response, None)
}

/// Parse the registration response while retaining the request's generated cdid.
/// The service normally returns only `device_id`/`install_id`; JavaScript keeps
/// the request cdid in that case, so callers should pass `DeviceRegistration::cdid`.
pub fn parse_registration_response_with_cdid(
    response: &serde_json::Value,
    request_cdid: Option<&str>,
) -> Result<DeviceRegistrationResponse, ServiceError> {
    let code = response
        .get("code")
        .or_else(|| response.get("Code"))
        .and_then(|value| match value {
            serde_json::Value::Number(number) => number.as_f64(),
            serde_json::Value::String(text) => text.parse::<f64>().ok(),
            _ => None,
        })
        .unwrap_or(0.0);
    if code != 0.0 {
        return Err(ServiceError::new(
            "BUSINESS_REJECTED",
            "匿名播放设备注册被服务端拒绝",
        ));
    }
    let device_id = response_id(response, "device_id")
        .ok_or_else(|| ServiceError::new("INVALID_RESPONSE", "设备注册响应缺少有效 device_id"))?;
    let iid = response_id(response, "install_id")
        .ok_or_else(|| ServiceError::new("INVALID_RESPONSE", "设备注册响应缺少有效 install_id"))?;
    let cdid = request_cdid
        .filter(|value| !value.is_empty())
        .or_else(|| response.get("cdid").and_then(serde_json::Value::as_str))
        .unwrap_or_default();
    Ok(DeviceRegistrationResponse {
        identity: DeviceIdentity {
            device_id,
            iid,
            cdid: cdid.to_owned(),
        },
    })
}

/// Ordered legacy-player query fields.  Argus binds the exact query bytes, so
/// this preserves JavaScript object insertion order instead of relying on a
/// sorted map.
pub(crate) fn playback_profile_pairs(
    identity: &DeviceIdentity,
) -> Result<Vec<(String, String)>, ServiceError> {
    validate_identity(identity)?;
    Ok(vec![
        ("ac".to_owned(), "wifi".to_owned()),
        ("channel".to_owned(), "update_64".to_owned()),
        ("aid".to_owned(), "8662".to_owned()),
        ("app_name".to_owned(), "novelread".to_owned()),
        ("version_code".to_owned(), "74332".to_owned()),
        ("version_name".to_owned(), "7.4.3.32".to_owned()),
        ("device_platform".to_owned(), "android".to_owned()),
        ("os".to_owned(), "android".to_owned()),
        ("ssmix".to_owned(), "a".to_owned()),
        ("device_type".to_owned(), "25053RT47C".to_owned()),
        ("device_brand".to_owned(), "Redmi".to_owned()),
        ("language".to_owned(), "zh".to_owned()),
        ("os_api".to_owned(), "36".to_owned()),
        ("os_version".to_owned(), "16".to_owned()),
        ("manifest_version_code".to_owned(), "74332".to_owned()),
        ("resolution".to_owned(), "1280*2772".to_owned()),
        ("dpi".to_owned(), "520".to_owned()),
        ("update_version_code".to_owned(), "74332".to_owned()),
        ("host_abi".to_owned(), "arm64-v8a".to_owned()),
        ("dragon_device_type".to_owned(), "phone".to_owned()),
        ("pv_player".to_owned(), "74332".to_owned()),
        ("compliance_status".to_owned(), "0".to_owned()),
        ("need_personal_recommend".to_owned(), "1".to_owned()),
        ("player_so_load".to_owned(), "1".to_owned()),
        ("is_android_pad_screen".to_owned(), "0".to_owned()),
        ("iid".to_owned(), identity.iid.clone()),
        ("device_id".to_owned(), identity.device_id.clone()),
        ("cdid".to_owned(), identity.cdid.clone()),
    ])
}

pub fn validate_identity(identity: &DeviceIdentity) -> Result<(), ServiceError> {
    for (name, value) in [("device_id", &identity.device_id), ("iid", &identity.iid)] {
        if !(1..=30).contains(&value.len())
            || !value.bytes().all(|byte| byte.is_ascii_digit())
            || !value.bytes().any(|byte| byte != b'0')
        {
            return Err(ServiceError::new(
                "APP_INPUT",
                format!("设备身份 {name} 无效"),
            ));
        }
    }
    if identity.cdid.is_empty() || identity.cdid.len() > 128 {
        return Err(ServiceError::new("APP_INPUT", "设备身份 cdid 无效"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_registration_is_gzip_and_has_safe_headers() {
        let request = build_registration_request(
            1_700_000_000_000,
            Some("00000000-0000-4000-8000-000000000001".into()),
            Some([7; 32]),
        )
        .unwrap();
        assert_eq!(request.method, "POST");
        assert!(request.body.starts_with(b"tc\x05\x10"));
        let compressed = gzip_store(br#"{"magic_tag":"ss_app_log"}"#);
        assert_eq!(&compressed[..3], &[0x1f, 0x8b, 8]);
        assert_eq!(
            u32::from_le_bytes(compressed[compressed.len() - 4..].try_into().unwrap()),
            26
        );
        assert_eq!(request.headers["x-ss-stub"].len(), 32);
    }

    #[test]
    fn response_ids_preserve_large_decimal_strings() {
        let rejected = serde_json::json!({"code": "1"});
        assert_eq!(
            parse_registration_response(&rejected)
                .unwrap_err()
                .to_string(),
            "匿名播放设备注册被服务端拒绝"
        );
        let value =
            serde_json::json!({"code":0,"device_id":1.0,"install_id_str":"9007199254741993"});
        let result = parse_registration_response(&value).unwrap();
        assert_eq!(result.identity.device_id, "1");
        let value =
            serde_json::json!({"code":0,"device_id_str":"9007199254740993","install_id":1_000_000});
        let result = parse_registration_response(&value).unwrap();
        assert_eq!(result.identity.device_id, "9007199254740993");
        assert_eq!(result.identity.iid, "1000000");

        let value = serde_json::json!({
            "code": 0,
            "device_id_str": "not-an-id",
            "device_id": "2000000",
            "install_id": "3000000"
        });
        assert_eq!(
            parse_registration_response(&value).unwrap_err().to_string(),
            "设备注册响应缺少有效 device_id"
        );

        let result = parse_registration_response_with_cdid(
            &serde_json::json!({
                "code": 0,
                "device_id_str": "9007199254740993",
                "install_id": 1_000_000
            }),
            Some("request-cdid"),
        )
        .unwrap();
        assert_eq!(result.identity.cdid, "request-cdid");
    }
}
