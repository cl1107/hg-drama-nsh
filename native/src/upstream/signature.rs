//! Android 551 playback signer (Argus/Ladon).
//!
//! The byte layout follows the GPL-3.0-only upstream implementation shipped
//! under `service/vendor/hongguo/playback-signature.js`.  Inputs are kept as
//! bytes/strings all the way to the final cipher so query ordering and body
//! binding remain observable and testable.

use std::collections::BTreeMap;

use crate::ServiceError;

use super::crypto::{aes128_cbc_encrypt, b64_encode, hex_decode, hex_encode, le64, md5_bytes, sm3};

const LICENSE_ID: u64 = 1_611_921_764;
const SIGN_KEY: [u8; 32] = [
    0xfc, 0x78, 0xe0, 0xa9, 0x65, 0x7a, 0x0c, 0x74, 0x8c, 0xe5, 0x15, 0x59, 0x90, 0x3c, 0xcf, 0x03,
    0x51, 0x0e, 0x51, 0xd3, 0xcf, 0xf2, 0x32, 0xd7, 0x13, 0x43, 0xe8, 0x8a, 0x32, 0x1c, 0x53, 0x04,
];
const AES_KEY: [u8; 16] = [
    0xd3, 0x1e, 0x37, 0x18, 0x28, 0x8a, 0x10, 0x27, 0xba, 0xab, 0x59, 0xf1, 0x46, 0xa0, 0x9a, 0x9c,
];
const AES_IV: [u8; 16] = [
    0xea, 0x18, 0x0a, 0x03, 0x36, 0xed, 0x35, 0x2f, 0xcd, 0x24, 0xe4, 0xd5, 0x00, 0x18, 0xae, 0x54,
];
const MAGIC8: [u8; 8] = [0xf2, 0xf7, 0xfc, 0xff, 0xf2, 0xf7, 0xfc, 0xff];
const TAIL9: [u8; 9] = [0xea, 0xfb, 0x2c, 0xfe, 0x85, 0x68, 0x51, 0x91, 0x54];

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SignHeaders {
    pub ss_req_ticket: String,
    pub khronos: String,
    pub ladon: String,
    pub argus: String,
    pub ss_stub: Option<String>,
}

impl SignHeaders {
    pub fn as_map(&self) -> BTreeMap<String, String> {
        let mut result = BTreeMap::new();
        result.insert("x-ss-req-ticket".to_owned(), self.ss_req_ticket.clone());
        result.insert("x-khronos".to_owned(), self.khronos.clone());
        result.insert("x-ladon".to_owned(), self.ladon.clone());
        result.insert("x-argus".to_owned(), self.argus.clone());
        if let Some(value) = &self.ss_stub {
            result.insert("x-ss-stub".to_owned(), value.clone());
        }
        result
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProtoBuf {
    bytes: Vec<u8>,
}

impl ProtoBuf {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn put_varint(mut self, tag: u32, value: i128) -> Self {
        append_varint(&mut self.bytes, (tag as u64) << 3);
        append_varint(&mut self.bytes, value as u32 as u64);
        self
    }

    pub fn put_bytes(mut self, tag: u32, value: &[u8]) -> Self {
        append_varint(&mut self.bytes, ((tag as u64) << 3) | 2);
        append_varint(&mut self.bytes, value.len() as u64);
        self.bytes.extend_from_slice(value);
        self
    }

    pub fn put_utf8(self, tag: u32, value: &str) -> Self {
        self.put_bytes(tag, value.as_bytes())
    }

    pub fn put_protobuf(self, tag: u32, value: &ProtoBuf) -> Self {
        self.put_bytes(tag, &value.bytes)
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        self.bytes.clone()
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

fn append_varint(output: &mut Vec<u8>, mut value: u64) {
    while value >= 128 {
        output.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    output.push(value as u8);
}

fn pad16(data: &[u8]) -> Vec<u8> {
    let padding = 16 - data.len() % 16;
    let mut output = Vec::with_capacity(data.len() + padding);
    output.extend_from_slice(data);
    output.extend(std::iter::repeat_n(padding as u8, padding));
    output
}

fn u64(value: u128) -> u64 {
    value as u64
}

fn rol64(value: u64, bits: u32) -> u64 {
    value.rotate_left(bits & 63)
}

fn ror64(value: u64, bits: u32) -> u64 {
    value.rotate_right(bits & 63)
}

fn integer_text(value: i128) -> String {
    value.to_string()
}

fn parse_query_param(query: &str, wanted: &str) -> Option<String> {
    for part in query.split('&') {
        let (key, value) = part.split_once('=').unwrap_or((part, ""));
        if percent_decode(key).as_deref() == Some(wanted) {
            return Some(
                percent_decode(&value.replace('+', " ")).unwrap_or_else(|| value.to_owned()),
            );
        }
    }
    None
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let high = hex(input.as_bytes()[index + 1])?;
            let low = hex(input.as_bytes()[index + 2])?;
            output.push((high << 4) | low);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).ok()
}

fn hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn body_hash(stub_hex: &str) -> [u8; 6] {
    let bytes = if stub_hex.is_empty() {
        Vec::new()
    } else if stub_hex.len() % 2 == 0 && stub_hex.bytes().all(|value| value.is_ascii_hexdigit()) {
        hex_decode(stub_hex).unwrap_or_default()
    } else {
        Vec::new()
    };
    let input = if stub_hex.is_empty() || bytes.is_empty() && !stub_hex.is_empty() {
        if stub_hex.is_empty() {
            vec![0_u8; 16]
        } else {
            Vec::new()
        }
    } else {
        bytes
    };
    let digest = sm3(&input);
    digest[..6].try_into().expect("SM3 digest has six bytes")
}

fn query_hash(query: &str) -> [u8; 6] {
    let input = if query.is_empty() {
        vec![0_u8; 16]
    } else {
        query.as_bytes().to_vec()
    };
    let digest = sm3(&input);
    digest[..6].try_into().expect("SM3 digest has six bytes")
}

fn simon_expand(key: [u64; 4]) -> [u64; 72] {
    let mut expanded = [0_u64; 72];
    expanded[..4].copy_from_slice(&key);
    for index in 4..72 {
        let mut temp = ror64(expanded[index - 1], 3) ^ expanded[index - 3];
        temp ^= ror64(temp, 1);
        let bit = (0x3dc9_4c3a_046d_678b_u64 >> ((index - 4) % 62)) & 1;
        expanded[index] =
            u64((!(expanded[index - 4]) as u128) ^ (temp as u128) ^ (bit as u128) ^ 3);
    }
    expanded
}

pub fn simon_encrypt(left: u64, right: u64, key: [u64; 4]) -> (u64, u64) {
    let mut x = left;
    let mut y = right;
    for round_key in simon_expand(key) {
        let previous = y;
        y = x ^ (rol64(y, 1) & rol64(y, 8)) ^ rol64(y, 2) ^ round_key;
        x = previous;
    }
    (x, y)
}

pub struct Argus;

impl Argus {
    pub fn sign(
        query: &str,
        stub_hex: &str,
        timestamp: i128,
        aid: i128,
        license_id: i128,
        device_id: &str,
        install_id: &str,
        rand_field: i128,
    ) -> String {
        let aid = if aid == 0 { 1967 } else { aid };
        let license_id = if license_id == 0 {
            LICENSE_ID as i128
        } else {
            license_id
        };
        let version_name = parse_query_param(query, "version_name").unwrap_or_default();
        let bean = ProtoBuf::new()
            .put_varint(1, 1_077_940_818)
            .put_varint(2, 2)
            .put_varint(3, rand_field)
            .put_utf8(4, &integer_text(aid))
            .put_utf8(5, device_id)
            .put_utf8(6, &integer_text(license_id))
            .put_utf8(7, &version_name)
            .put_utf8(8, "v04.04.05-ov-android")
            .put_varint(9, 134_744_640)
            .put_bytes(10, &[0; 8])
            .put_varint(11, 0)
            .put_varint(12, timestamp << 1)
            .put_bytes(13, &body_hash(stub_hex))
            .put_bytes(14, &query_hash(query))
            .put_protobuf(
                15,
                &ProtoBuf::new()
                    .put_varint(1, 1)
                    .put_varint(2, 1)
                    .put_varint(3, 1)
                    .put_varint(7, 0xc792_eccc_u32 as i128),
            )
            .put_utf8(16, install_id)
            .put_utf8(20, "none")
            .put_varint(21, 738)
            .put_protobuf(
                23,
                &ProtoBuf::new()
                    .put_utf8(1, "NX551J")
                    .put_varint(2, 8196)
                    .put_varint(4, 0x80e0_d800_u32 as i128),
            )
            .put_varint(25, 2);
        let padded = pad16(bean.as_bytes());
        let mut key = [0_u64; 4];
        for index in 0..4 {
            key[index] = u64::from_le_bytes(
                SIGN_KEY[index * 8..index * 8 + 8]
                    .try_into()
                    .expect("key word"),
            );
        }
        let mut framed = Vec::with_capacity(8 + padded.len() + 9);
        framed.extend_from_slice(&MAGIC8);
        for chunk in padded.chunks_exact(16) {
            let left = u64::from_le_bytes(chunk[..8].try_into().expect("Simon block"));
            let right = u64::from_le_bytes(chunk[8..].try_into().expect("Simon block"));
            let (encrypted_left, encrypted_right) = simon_encrypt(left, right, key);
            framed.extend_from_slice(&le64(encrypted_left));
            framed.extend_from_slice(&le64(encrypted_right));
        }
        framed.extend_from_slice(&TAIL9);
        for index in 8..framed.len() {
            framed[index] ^= MAGIC8[index % 8];
        }
        framed.reverse();
        framed.extend_from_slice(b"ao");
        let padded = pad16(&framed);
        let ciphertext = aes128_cbc_encrypt(&padded, &AES_KEY, &AES_IV);
        let mut output = b"\xf2\x81".to_vec();
        output.extend_from_slice(&ciphertext);
        b64_encode(&output)
    }
}

pub struct Ladon;

impl Ladon {
    pub fn encrypt(timestamp: i128, license_id: i128, aid: i128, random: [u8; 4]) -> String {
        let aid_text = integer_text(aid);
        let mut md5_input = random.to_vec();
        md5_input.extend_from_slice(aid_text.as_bytes());
        let digest = md5_bytes(&md5_input);
        let ascii = hex_encode(&digest);
        let mut words = [0_u64; 4];
        for index in 0..4 {
            words[index] = u64::from_le_bytes(
                ascii.as_bytes()[index * 8..index * 8 + 8]
                    .try_into()
                    .expect("Ladon word"),
            );
        }
        let mut table = Vec::with_capacity(35);
        table.push(words[0]);
        let mut queue = std::collections::VecDeque::from([words[2], words[3]]);
        let mut b0 = words[0];
        let mut b8 = words[1];
        for index in 0..34 {
            let mut x8 = ror64(b8, 8).wrapping_add(b0) ^ index as u64;
            queue.push_back(x8);
            x8 ^= rol64(b0, 3);
            table.push(x8);
            b0 = x8;
            b8 = queue.pop_front().expect("Ladon queue");
        }
        let input = pad16(format!("{}-{}-{}", timestamp, license_id, aid_text).as_bytes());
        let mut output = vec![0_u8; input.len()];
        for (offset, chunk) in input.chunks_exact(16).enumerate() {
            let mut a = u64::from_le_bytes(chunk[..8].try_into().expect("Ladon block"));
            let mut b = u64::from_le_bytes(chunk[8..].try_into().expect("Ladon block"));
            for index in 0..34 {
                b = table[index] ^ a.wrapping_add(ror64(b, 8));
                a = b ^ rol64(a, 3);
            }
            output[offset * 16..offset * 16 + 8].copy_from_slice(&a.to_le_bytes());
            output[offset * 16 + 8..offset * 16 + 16].copy_from_slice(&b.to_le_bytes());
        }
        let mut framed = random.to_vec();
        framed.extend_from_slice(&output);
        b64_encode(&framed)
    }
}

pub fn sign_player(
    query: &str,
    body: Option<&[u8]>,
    timestamp: i128,
    rand_field: i128,
    ladon_random: [u8; 4],
) -> Result<SignHeaders, ServiceError> {
    if query.is_empty() {
        return Err(ServiceError::new("APP_INPUT", "签名 query 不能为空"));
    }
    let mut aid = 1967_i128;
    if let Some(value) = parse_query_param(query, "aid")
        && let Ok(parsed) = value.parse::<i128>()
        && (-(1_i128 << 63)..(1_i128 << 63)).contains(&parsed)
    {
        aid = parsed;
    }
    let stub = body.map(md5_bytes);
    let stub_hex = stub
        .as_ref()
        .map(|value| hex_encode(value))
        .unwrap_or_default();
    let device_id = parse_query_param(query, "device_id").unwrap_or_default();
    let argus = Argus::sign(
        query,
        &stub_hex,
        timestamp,
        aid,
        LICENSE_ID as i128,
        &device_id,
        "",
        rand_field,
    );
    let ladon = Ladon::encrypt(timestamp, LICENSE_ID as i128, aid, ladon_random);
    Ok(SignHeaders {
        ss_req_ticket: (timestamp * 1000).to_string(),
        khronos: timestamp.to_string(),
        ladon,
        argus,
        ss_stub: stub.map(|value| hex_encode(&value)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protobuf_matches_upstream_vector() {
        let bytes = ProtoBuf::new()
            .put_varint(1, 1_077_940_818)
            .put_varint(2, 2)
            .put_varint(3, 305_419_896)
            .put_utf8(4, "1967")
            .put_utf8(5, "test_device_id")
            .put_utf8(6, "1611921764")
            .put_utf8(7, "")
            .put_utf8(8, "")
            .put_varint(9, 0)
            .put_utf8(10, "")
            .put_utf8(11, "")
            .put_varint(12, 3_400_000_000)
            .put_bytes(13, &hex_decode("106e34a2b8c7").unwrap())
            .put_bytes(14, &hex_decode("ac5095fc674e").unwrap())
            .put_protobuf(
                15,
                &ProtoBuf::new()
                    .put_varint(1, 1)
                    .put_varint(2, 1)
                    .put_varint(3, 1)
                    .put_varint(7, 0xc792_eccc_u32 as i128),
            )
            .put_utf8(16, "")
            .put_utf8(20, "none")
            .put_varint(21, 738)
            .put_protobuf(
                23,
                &ProtoBuf::new()
                    .put_utf8(1, "NX551J")
                    .put_varint(2, 8196)
                    .put_varint(4, 0x80e0_d800_u32 as i128),
            )
            .put_varint(25, 2)
            .to_bytes();
        assert_eq!(
            hex_encode(&bytes),
            "08d2a4808204100218f8acd191012204313936372a0e746573745f6465766963655f6964320a313631313932313736343a004200480052005a006080c49fd50c6a06106e34a2b8c77206ac5095fc674e7a0c08011001180138ccd9cbbc0c820100a201046e6f6e65a801e205ba01110a064e583535314a1084402080b0838708c80102"
        );
    }

    #[test]
    fn simon_and_ladon_vectors_match() {
        let key = [
            1_111_111_111_111_111_111,
            2_222_222_222_222_222_222,
            3_333_333_333_333_333_333,
            4_444_444_444_444_444_444,
        ];
        assert_eq!(
            simon_encrypt(1_234_567_890_123_456_789, 9_876_543_210_987_654_321, key),
            (6_071_150_433_487_837_324, 2_027_321_285_990_159_935)
        );
        assert_eq!(
            Ladon::encrypt(1_700_000_000, 1_611_921_764, 1967, [1, 2, 3, 4]),
            "AQIDBKM7Y7bWnOIUXmTybD6/MpGbuge4sBwUJsyHVivhtMsH"
        );
    }

    #[test]
    fn argus_vector_matches() {
        let output = Argus::sign(
            "aid=1967&device_id=dev_aaaaaaaa&iid=111",
            "",
            1_700_000_000,
            1967,
            LICENSE_ID as i128,
            "dev_aaaaaaaa",
            "",
            659_662_259,
        );
        assert_eq!(
            output,
            "8oHyrVYEy1xDCDlx64ko40qC6JC9VYY/ZkjJzEl50iSFDw8Yfph1hupLxfKrA9GswSEz0Yi4goA7OQ4u+H8ECdOaQDL4GduQ3LULSq9Q4iSEGbS3L6G24GXChtnmPr6n46M2PLlKpXvF7uE0lhH4yD+X69FpdM41gQwx5Y5U3NdwXFaxlqYFszyp7dlUE6BEBWqwDsiAH8Jk9TGKr/jfHt4fVmMc9zRyNRdGeV0x6aP//x7aV+8Po8a/9KK3UNG5KEpmIgzRT6NUttkBP9gRNUh3"
        );
    }
}
