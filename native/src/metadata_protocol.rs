// SPDX-License-Identifier: GPL-3.0-only
//! Directory and account signing for the 7.2/7.3 App profiles.

use super::{
    crypto::{b64_encode, hex_encode, md5_bytes, sm3},
    device::DeviceIdentity,
    v5::{HASH_TABLE, branch, encode_component, xmxor},
};
use crate::{ServiceError, transport};
use reqwest::{
    Method,
    header::{HeaderMap, HeaderValue},
};
use serde_json::Value;
use std::{
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};

const DOMAINS: &[&str] = &["fqnovel.com", "snssdk.com"];
pub(crate) const SEARCH_HOST: &str = "https://api5-normal-sinfonlinea.fqnovel.com";
const METADATA_HOST: &str = "https://api5-normal-sinfonlineb.fqnovel.com";
const SEARCH_UA: &str =
    "com.phoenix.read/72232 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3)";
const METADATA_UA: &str = "com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)";
const LEGACY_MAGIC: [u8; 16] = [
    0xf7, 0xe8, 0x5f, 0xfa, 0xd7, 0xd7, 0xdc, 0x3b, 0xd6, 0x2a, 0xc8, 0x70, 0x57, 0xcf, 0x61, 0x18,
];
const FLAGS: [u8; 8] = [0x40, 1, 0, 0, 0, 0, 0, 0];
const SIGN_KEY: [u8; 32] = [
    0x8e, 0xbd, 0xfa, 0x38, 0x06, 0xec, 0xc5, 0xce, 0xe7, 0x94, 0x23, 0xe6, 0x02, 0x9e, 0xd8, 0x25,
    0x40, 0xbc, 0x22, 0x18, 0xbb, 0x7e, 0xae, 0xf7, 0x1c, 0xb6, 0x91, 0xf7, 0xaa, 0x8a, 0xa2, 0xf5,
];

type Fields = Vec<(String, String)>;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock")
        .as_millis() as u64
}

fn insert(fields: &mut Fields, key: &str, value: impl Into<String>) {
    if let Some((_, previous)) = fields.iter_mut().find(|(existing, _)| existing == key) {
        *previous = value.into();
    } else {
        fields.push((key.into(), value.into()));
    }
}

fn device_fields(device: &DeviceIdentity, metadata: bool) -> Fields {
    let (version, version_name) = if metadata {
        ("73532", "7.3.5.32")
    } else {
        ("72232", "7.2.2.32")
    };
    let mut result = [
        ("ac", "wifi"),
        ("channel", "update_64"),
        ("aid", "8662"),
        ("app_name", "novelread"),
        ("version_code", version),
        ("version_name", version_name),
        ("device_platform", "android"),
        ("os", "android"),
        ("ssmix", "a"),
        ("device_type", "25053RT47C"),
        ("device_brand", "Redmi"),
        ("language", "zh"),
        ("os_api", "36"),
        ("os_version", "16"),
        ("manifest_version_code", version),
        ("resolution", "1280*2772"),
        ("dpi", "520"),
        ("update_version_code", version),
        ("host_abi", "arm64-v8a"),
        ("dragon_device_type", "phone"),
        ("pv_player", version),
        ("compliance_status", "0"),
        ("need_personal_recommend", "1"),
        ("player_so_load", "1"),
        ("is_android_pad_screen", "0"),
        ("iid", &device.iid),
        ("device_id", &device.device_id),
    ]
    .into_iter()
    .map(|(key, value)| (key.into(), value.into()))
    .collect();
    if !metadata {
        insert(&mut result, "cdid", &device.cdid);
    }
    result
}

fn metadata_device() -> &'static DeviceIdentity {
    static DEVICE: OnceLock<DeviceIdentity> = OnceLock::new();
    let next_id = || (1_000_000_000_000_000_u64 + rand::random_range(0..(1_u64 << 48))).to_string();
    DEVICE.get_or_init(|| DeviceIdentity {
        device_id: next_id(),
        iid: next_id(),
        cdid: String::new(),
    })
}

fn f13(query: &[u8; 32], body: &[u8; 16], time: u32, low: u32) -> [u8; 20] {
    const SEEDS: [u32; 6] = [
        0xc4a7_8580,
        0xb3c0_fd39,
        0xc58c_5686,
        0xc9aa_3ba7,
        0xf5a7_adf2,
        0x963c_2ed1,
    ];
    const ORDERS: [[usize; 11]; 6] = [
        [101, 5, 7, 6, 3, 2, 1, 0, 5, 4, 3],
        [96, 0, 6, 7, 5, 3, 2, 1, 5, 4, 4],
        [96, 7, 6, 2, 1, 4, 0, 5, 4, 3, 5],
        [99, 3, 6, 2, 4, 5, 1, 0, 0, 7, 6],
        [96, 0, 5, 6, 7, 3, 1, 2, 5, 4, 4],
        [100, 2, 0, 3, 5, 4, 6, 7, 2, 1, 5],
    ];
    let seed = SEEDS[(low / 3) as usize];
    let order = ORDERS[(low / 3) as usize];
    let rounds = seed.wrapping_add(time);
    let table = HASH_TABLE.map(|word| word.rotate_right(rounds.wrapping_add(1)));
    let pad = [0xfa_u8, 0x45, 0x61, 0xd7]
        .map(|byte| (byte as u16 * 257 >> (rounds.wrapping_add(2) & 7)) as u8);
    let mut block = [0_u8; 64];
    block[..32].copy_from_slice(query);
    block[32..48].copy_from_slice(body);
    block[48..52].copy_from_slice(&time.to_le_bytes());
    block[52..56].copy_from_slice(&pad);
    block[62..].copy_from_slice(&[1, 160]);
    let mut schedule = [0_u32; 128];
    for (word, bytes) in schedule.iter_mut().zip(block.chunks_exact(4)) {
        *word = u32::from_be_bytes(bytes.try_into().expect("word"));
    }
    for index in 0..112 {
        let x = schedule[index + 1];
        let y = schedule[index + 14];
        schedule[index + 16] = schedule[index]
            .wrapping_add(schedule[index + 9])
            .wrapping_add(x.rotate_left(14) ^ x.rotate_left(25) ^ (x >> 3))
            .wrapping_add(y.rotate_left(13) ^ y.rotate_left(15) ^ (y >> 10));
    }
    let initial: [u32; 8] = [
        0x7aba4fc8, 0x67166507, 0x6403fa00, 0x340f512f, 984304912, 3005047866, 2874125293,
        2152413264,
    ];
    let initial = initial.map(|word| word.rotate_right(rounds));
    let mut state = initial;
    for index in 0..order[0] {
        let base = seed.wrapping_add(index as u32) as usize;
        let [_, x, y, a, b, c, d, e, out_x, old, out_y] = order;
        let mix = ((state[a] ^ state[b]) & state[x]) ^ state[a];
        let rotated = state[x].rotate_left(26) ^ state[x].rotate_left(21) ^ state[x].rotate_left(7);
        let first = schedule[base & 127]
            .wrapping_add(mix)
            .wrapping_add(rotated)
            .wrapping_add(table[base & 63])
            .wrapping_add(state[c]);
        let shifted =
            state[y].rotate_left(30) ^ state[y].rotate_left(19) ^ state[y].rotate_left(10);
        let majority = (state[y] & state[d]) | ((state[y] | state[d]) & state[e]);
        let old_word = state[old];
        state.rotate_right(1);
        state[out_y] = shifted.wrapping_add(majority).wrapping_add(first);
        state[out_x] = old_word.wrapping_add(first);
    }
    let mut result = [0_u8; 20];
    for index in 0..4 {
        let low = state[index].wrapping_add(initial[index]);
        let high = state[index + 4].wrapping_add(initial[index + 4]);
        result[index * 4..index * 4 + 4].copy_from_slice(&(low ^ high).to_be_bytes());
    }
    let mut checksum = 0x2022_0420_u32;
    for (index, &byte) in result[..12].iter().enumerate() {
        checksum = if index % 2 == 0 {
            u32::from(byte) ^ (checksum << 7) ^ (checksum >> 3) ^ checksum
        } else {
            !(u32::from(byte) | (checksum << 11)) ^ (checksum >> 5) ^ checksum
        };
    }
    result[16..].copy_from_slice(&((checksum | 4) ^ 0x0100_0000).to_le_bytes());
    result
}

fn gorgon(query: &[u8], body: [u8; 16], time: u32, random: u16) -> String {
    let [lo, hi] = random.to_le_bytes();
    let mut payload = [0_u8; 20];
    payload[..4].copy_from_slice(&md5_bytes(query)[..4]);
    payload[4..8].copy_from_slice(&body[..4]);
    payload[12..16].copy_from_slice(&67_503_104_u32.to_le_bytes());
    payload[16..].copy_from_slice(&time.to_be_bytes());
    let key = [0x4a, 0x40, 0x16, hi, 0x47, 0x6c, 0x01, lo];
    let mut state = std::array::from_fn::<u8, 256, _>(|index| index as u8);
    let mut j = 0_u8;
    for index in 0..256 {
        j = j
            .wrapping_add(state[index])
            .wrapping_add(key[index % key.len()]);
        state[index] = state[j as usize];
    }
    j = 0;
    for (index, byte) in payload.iter_mut().enumerate() {
        j = j.wrapping_add(state[index + 1]);
        let next = state[j as usize];
        state[index + 1] = next;
        *byte ^= state[next.wrapping_add(next) as usize];
    }
    for index in 0..payload.len() {
        let next = payload[(index + 1) % payload.len()];
        payload[index] = !((next ^ payload[index].rotate_left(4)).reverse_bits() ^ 20);
    }
    hex_encode(&[[0x84, 4, lo, hi, 0x40, 1].as_slice(), &payload].concat())
}

#[derive(Default)]
struct Proto(Vec<u8>);

impl Proto {
    fn append(&mut self, mut value: u64) {
        while value > 127 {
            self.0.push(value as u8 | 128);
            value >>= 7;
        }
        self.0.push(value as u8);
    }

    fn signed(mut self, tag: u64, value: i64) -> Self {
        self.append(tag << 3);
        self.append(((value << 1) ^ (value >> 63)) as u64);
        self
    }

    fn bytes(mut self, tag: u64, value: impl AsRef<[u8]>) -> Self {
        let value = value.as_ref();
        self.append((tag << 3) | 2);
        self.append(value.len() as u64);
        self.0.extend_from_slice(value);
        self
    }

    fn zero_float(mut self, tag: u64) -> Self {
        self.append((tag << 3) | 5);
        self.0.extend_from_slice(&[0; 4]);
        self
    }
}

fn medusa(
    query: &[u8],
    hash: &[u8; 32],
    body: [u8; 16],
    f13: &[u8; 20],
    time: u32,
    device: &DeviceIdentity,
    version: &str,
) -> String {
    static PROCESS: OnceLock<(String, i64)> = OnceLock::new();
    let (process_nonce, start) = PROCESS.get_or_init(|| {
        use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
        (
            URL_SAFE_NO_PAD.encode(rand::random::<[u8; 18]>()),
            now_ms() as i64,
        )
    });
    let ts = i64::from(time);
    let device_proto = Proto::default()
        .signed(1, 1)
        .signed(2, 2)
        .bytes(3, "8662")
        .bytes(4, &device.device_id)
        .bytes(5, process_nonce)
        .bytes(6, "!noperm!")
        .signed(7, -888888)
        .signed(8, -888888)
        .signed(9, 3)
        .signed(10, -888888)
        .bytes(11, "!notset!")
        .bytes(12, "Asia/Shanghai,8")
        .bytes(13, "zh_CN")
        .signed(14, 4)
        .zero_float(16)
        .zero_float(17)
        .zero_float(18)
        .zero_float(19)
        .zero_float(20)
        .zero_float(21)
        .bytes(22, "16")
        .signed(23, 41)
        .signed(24, 36)
        .signed(25, *start)
        .signed(26, *start)
        .signed(27, *start)
        .signed(28, *start)
        .signed(29, -1)
        .bytes(30, "25053RT47C")
        .bytes(31, "Redmi")
        .bytes(32, "25053RT47C")
        .bytes(33, "25053RT47C")
        .bytes(34, "Xiaomi")
        .bytes(35, "Redmi")
        .bytes(36, "Redmi")
        .signed(38, 31);
    let now = Proto::default().signed(1, ts).signed(2, -2).signed(4, 200);
    let environment = Proto::default()
        .signed(1, rand::random_range(100..=120))
        .signed(2, 146331399)
        .signed(3, 146331396)
        .signed(5, 7)
        .bytes(6, "v04.06.04.03-bugfix")
        .signed(7, rand::random_range(10001..12001))
        .bytes(12, device_proto.0)
        .bytes(13, now.0)
        .bytes(14, version);
    let nested = Proto::default()
        .signed(1, 111)
        .signed(2, 10)
        .signed(3, 694367)
        .signed(5, 586952199);
    let query_hash = sm3(&[query, &body, b"none"].concat());
    let message = Proto::default().bytes(1, LEGACY_MAGIC).signed(2, 3)
        .signed(3, i64::from(rand::random::<u32>())).bytes(4, "8662").bytes(5, &device.device_id)
        .bytes(6, "1588093228").bytes(7, version).bytes(8, "v04.06.04-ml-android")
        .signed(9, 67503104).bytes(10, FLAGS).signed(12, ts).bytes(13, f13)
        .bytes(14, &hash[..6]).bytes(15, nested.0).bytes(16, process_nonce).signed(17, ts)
        .bytes(19, query_hash).bytes(20, "none").signed(21, 312).bytes(23, environment.0)
        .bytes(24, r#"{"cmr":16777216,"cmr2":16777216,"un_h":1879194040,"vpn":0,"kd":0,"fkd":3672518972,"pd":-1872573247,"dyn":"","do":0,"tk":true}"#);
    let nonce = rand::random::<u32>();
    let digest = sm3(&[SIGN_KEY.as_slice(), &nonce.to_le_bytes(), &SIGN_KEY].concat());
    let high = (nonce >> 16) & 255;
    let seed = !(((high << 11) | (nonce >> 24)) ^ (high >> 5) ^ high);
    let seed = seed.to_le_bytes();
    let mut transformed = [FLAGS.as_slice(), &xmxor(&message.0, &digest)].concat();
    transformed.reverse();
    for (index, byte) in transformed.iter_mut().enumerate() {
        *byte ^= seed[(!index) & 3];
    }
    let check = (u32::from(hash[0] & 63) << 14) | 0x1800_0001 | (u32::from(f13[0] & 63) << 8);
    let packed = [
        &[0x35][..],
        &rand::random::<u32>().to_le_bytes(),
        &check.to_le_bytes(),
        &transformed,
        &nonce.to_le_bytes()[2..],
    ]
    .concat();
    let encrypted = LegacyCarrier::new(time).encrypt(packed);
    let mut prefix = [&3_u32.to_le_bytes()[..], &LEGACY_MAGIC].concat();
    for (index, byte) in prefix.iter_mut().enumerate() {
        *byte ^= time.to_le_bytes()[index & 3];
    }
    prefix.extend_from_slice(&[nonce as u8, (nonce >> 8) as u8, 0, 1]);
    prefix.extend_from_slice(&encrypted);
    b64_encode(&prefix)
}

const LEGACY_SBOX: &str = "+n0Ia5xZs0sEXznQOEqRmQBnpiCf9U2Ccybu3xhmgzOAAxn72f6uqqmwUsYL83klTni0NqxdGieeiNu9PGPsSRXBMB/cuFbUbM3KCUPINaPvHvSW0vwOcnuUhNHqRVpiAj/TEoE0K91+5ijypUYTATsh9mE3KSoN7Yyvv51cuyR2D3XkU4nhmI2xmmVwT1RMWKtub4sjxAcRDLrPoKSO2AU9FLLadMPX577Wf95IFj6FkKFVt3dCIsmGUC4X+WQxLJvxbRxEaOPpqJOXyzJX6+Vxaq3AzMfF/WAdoi1Hp+JRaV56zgpBtpWP97mH4DoGEIq1+FvV8LyS/3wvwugbQOwb2r26mJEMsiuDQTRn+wrYdrVGBVlhI3WQhyrjUBVMrLF5667llUcEaPCGPVGLD8qO5LlO8hKCvA7V9+8oJc9bXelqVQLhM76T5/WtnT45JKji+hdX0HoNCDDWuKON/QeaxB5uImSX0h2wv0VmP2zd2yeApxHcpsVS+MC2yFwAc2B7oBkTqsk1SEvTpM2fmfMQREBUfin0Bh+iq6EvPPavhWI2IX9e3yAas7Tm/3KEj2UmlFp36kN4x0rMLBRrxuh0U/zUHM4xcAMYjJY4MonxOl/X+alpt2M3WMI7w3HLnpIBigtNiJu7T21v4P6lSd5WFgntnMEt7oF92XzRLkJbTcGmXepE/UVOG6E/0YnhfS+q26utWcuxzpooyeD2cDlK1/8w9d28VzsRjbLuALbmGlp8+d7EzS6Au7lMpZ+ECMZvQmzwJ+eLOpxR+2chdUExp8ogQyq3v9l68rX4jCwjg0+PYKAEEzcU4wHFY2ZcdIHfWL1okD3SszT0GZMyKdZJrg1L2AeerB4tC0C4crp2EHGo5FYdSP7lwkeR2ocmnR+Ia8CYviUJlzOjhRZef9xuVOn3qcjow3fQgivsAmKKkg4+sA8F8/GWeDiGNhg8JM8KtFPMYWWkx5TVFX5t73kiNRJqjlIGVXtGZFCV4gzt0xcDopuZ6xz8r9Rzafpf9ywev8jh8592gHFIqpStZPuJxmDDMrNN0uBE3V+oscdoIzTJbRJ/t+sVvqnReJOgDJKk10fjisJwqyZBmnmn2BSFj8BvVtCMEbkuPOKdzw7eA11GPs04Qw8zWtkaZWwiO/wwpojqN6K0jY5RnNZA7vn4hPSul+nKCkVnVwQvg1zVxcSCtqORmB9KrJaBbssbCQivGJVJfVTt+hYxOtq4ZvWl8f4QAQZ0zGPffCgl9s6yT4vlvIdpu4YhBwA25wtQWZsc6GJYGWHyvSdeuh3mmUI9DSq13Fsp8C1MU3tqc04/df9LoTUXVXI5INOw/e8C7Hd+5CvbkMEFnnrUUmskEw==";

struct LegacyCarrier {
    permutation: [usize; 4],
    order: [usize; 16],
    sbox: [u8; 256],
    keys: [[u8; 4]; 12],
}

impl LegacyCarrier {
    fn new(time: u32) -> Self {
        const BOX_PERMUTATIONS: [[usize; 4]; 4] =
            [[1, 0, 2, 3], [2, 0, 3, 1], [0, 1, 3, 2], [1, 0, 2, 3]];
        const ORDERS: [[usize; 16]; 4] = [
            [0, 9, 14, 11, 4, 13, 2, 7, 8, 1, 6, 15, 12, 5, 10, 3],
            [0, 9, 14, 15, 4, 13, 2, 7, 8, 1, 6, 3, 12, 5, 10, 11],
            [0, 9, 14, 7, 4, 13, 2, 11, 8, 1, 6, 3, 12, 5, 10, 15],
            [0, 9, 14, 11, 4, 13, 2, 7, 8, 1, 6, 15, 12, 5, 10, 3],
        ];
        const HEAD: [u32; 4] = [0xca025ddc, 0x823dc546, 0xc9420583, 0xc298225f];
        const AES_KEY: [u8; 16] = [
            0xf1, 0x59, 0x33, 0x76, 0x76, 0x6e, 0xa9, 0x8d, 0x34, 0xf3, 0x1b, 0x05, 0x7a, 0x9d,
            0x5b, 0xe4,
        ];
        static BOXES: OnceLock<Vec<u8>> = OnceLock::new();
        let boxes = BOXES.get_or_init(|| {
            use base64::{Engine as _, engine::general_purpose::STANDARD};
            STANDARD.decode(LEGACY_SBOX).expect("fixed carrier S-boxes")
        });
        let variant = (time & 3) as usize;
        let sbox: [u8; 256] = boxes[variant * 256..(variant + 1) * 256]
            .try_into()
            .expect("carrier S-box");
        let head = HEAD[variant];
        let mut expanded = [0_u8; 48];
        for (index, byte) in AES_KEY.iter().enumerate() {
            expanded[index] = byte ^ head.to_le_bytes()[index % 4];
        }
        let mut rounds = 8;
        for index in 4..12 {
            let offset = 4 * (index - 1);
            let [mut a, mut b, mut c, mut d] =
                expanded[offset..offset + 4].try_into().expect("key word");
            if index % 4 == 0 {
                let key = (head >> (rounds & 24)) as u8 ^ sbox[b as usize];
                b = sbox[c as usize];
                c = sbox[d as usize];
                d = sbox[a as usize];
                a = key;
            }
            rounds += 2;
            for (column, value) in [a, b, c, d].into_iter().enumerate() {
                expanded[offset + 4 + column] = value ^ expanded[offset - 12 + column];
            }
        }
        Self {
            permutation: BOX_PERMUTATIONS[variant],
            order: ORDERS[variant],
            sbox,
            keys: std::array::from_fn(|index| {
                expanded[index * 4..index * 4 + 4]
                    .try_into()
                    .expect("key round")
            }),
        }
    }

    fn add(&self, output: &mut [u8; 16], base: usize, permute: bool) {
        for (index, byte) in output.iter_mut().enumerate() {
            let column = index % 4;
            let column = if permute {
                self.permutation[column]
            } else {
                column
            };
            *byte ^= self.keys[base + index / 4][column];
        }
    }

    fn block(&self, mut data: [u8; 16]) -> [u8; 16] {
        self.add(&mut data, 0, true);
        for round in 1..=2 {
            let previous = data.map(|byte| self.sbox[byte as usize]);
            for row in 0..4 {
                data[row * 4..row * 4 + 4].copy_from_slice(
                    &previous[self.permutation[row] * 4..self.permutation[row] * 4 + 4],
                );
            }
            data = self.order.map(|index| data[index]);
            if round == 1 {
                for row in data.chunks_exact_mut(4) {
                    row.copy_from_slice(&self.permutation.map(|column| row[column]));
                }
                for column in 0..4 {
                    let values = [
                        data[column],
                        data[column + 4],
                        data[column + 8],
                        data[column + 12],
                    ];
                    let xored = values.into_iter().fold(0, |xor, byte| xor ^ byte);
                    for row in 0..4 {
                        let delta = values[row] ^ values[(row + 1) % 4];
                        let shifted = (delta << 1) ^ if delta & 128 != 0 { 0x1b } else { 0 };
                        data[row * 4 + column] = values[row] ^ xored ^ shifted;
                    }
                }
            }
            self.add(&mut data, round * 4, true);
        }
        self.add(&mut data, 4, false);
        data
    }

    fn encrypt(&self, mut data: Vec<u8>) -> Vec<u8> {
        let mut previous = [
            0x1f, 0xe1, 0x09, 0xa4, 0x12, 0x52, 0x83, 0xf4, 0x18, 0xde, 0x9e, 0x05, 0x1a, 0x96,
            0x9e, 0x12,
        ];
        let mut plane = [0_u8; 32];
        for (index, chunk) in data.chunks_exact(8).take(31).enumerate() {
            plane[index] = ((chunk[0] >> 4) & 2)
                | (chunk[1] & 64)
                | ((chunk[2] >> 2) & 1)
                | ((chunk[3] << 3) & 128)
                | ((chunk[4] >> 1) & 4)
                | ((chunk[5] << 3) & 16)
                | ((chunk[6] << 5) & 32)
                | ((chunk[7] >> 4) & 8);
        }
        plane[31] = 1;
        let mut key = [0_u8; 32];
        for (index, chunk) in plane.chunks_exact(16).enumerate() {
            let xor = std::array::from_fn(|column| chunk[column] ^ previous[column]);
            previous = self.block(xor);
            key[index * 16..index * 16 + 16].copy_from_slice(&previous);
        }
        for (patch, chunk) in key.into_iter().zip(data.chunks_exact_mut(8)).take(31) {
            chunk[0] = (chunk[0] & 0xdf) | ((patch << 4) & 32);
            chunk[1] = (chunk[1] & 0xbf) | (patch & 64);
            chunk[2] = (chunk[2] & 0xfb) | ((patch << 2) & 4);
            chunk[3] = (chunk[3] & 0xef) | ((patch >> 3) & 16);
            chunk[4] = (chunk[4] & 0xf7) | ((patch << 1) & 8);
            chunk[5] = (chunk[5] & 0xfd) | ((patch >> 3) & 2);
            chunk[6] = (chunk[6] & 0xfe) | ((patch >> 5) & 1);
            chunk[7] = (chunk[7] & 0x7f) | ((patch << 4) & 128);
        }
        data.insert(0, previous[15]);
        data
    }
}

fn helios(time: u32) -> String {
    use std::collections::VecDeque;
    let nonce = rand::random::<u32>().to_le_bytes();
    let hash = hex_encode(&md5_bytes(&[nonce.as_slice(), b"8662"].concat()));
    let words: [u64; 4] = std::array::from_fn(|index| {
        u64::from_le_bytes(
            hash.as_bytes()[index * 8..index * 8 + 8]
                .try_into()
                .expect("eight-byte digest word"),
        )
    });
    let mut a = words[0];
    let mut b = words[1];
    let mut queue = VecDeque::from([words[2], words[3]]);
    let mut table = vec![a];
    for index in 0..34 {
        let next = b.rotate_right(8).wrapping_add(a) ^ index;
        queue.push_back(next);
        a = next ^ a.rotate_right(61);
        table.push(a);
        b = queue.pop_front().expect("Helios word");
    }
    let mut input = format!("{time}-1588093228-8662").into_bytes();
    let padding = 16 - input.len() % 16;
    input.extend(std::iter::repeat_n(padding as u8, padding));
    let mut output = nonce.to_vec();
    for block in input.chunks_exact(16) {
        let mut a = u64::from_le_bytes(block[..8].try_into().expect("Helios low word"));
        let mut b = u64::from_le_bytes(block[8..].try_into().expect("Helios high word"));
        for word in &table[..34] {
            b = word ^ a.wrapping_add(b.rotate_right(8));
            a = b ^ a.rotate_right(61);
        }
        output.extend_from_slice(&a.to_le_bytes());
        output.extend_from_slice(&b.to_le_bytes());
    }
    b64_encode(&output)
}

async fn request(
    api: &str,
    mut fields: Fields,
    payload: Option<Value>,
    mut headers: HeaderMap,
    device: &DeviceIdentity,
    metadata: bool,
) -> Result<Value, ServiceError> {
    let body = payload
        .map(|value| serde_json::to_vec(&value))
        .transpose()
        .map_err(|_| ServiceError::new("APP_INPUT", "请求内容格式无效"))?;
    let body_hash = body.as_deref().map(md5_bytes).unwrap_or([0; 16]);
    let now = now_ms();
    let time = (now / 1000) as u32;
    insert(&mut fields, "ts", time.to_string());
    let (query, hash, low, ticket) = (now..now + 128)
        .find_map(|ticket| {
            insert(&mut fields, "_rticket", ticket.to_string());
            let query = fields
                .iter()
                .map(|(key, value)| {
                    format!("{}={}", encode_component(key), encode_component(value))
                })
                .collect::<Vec<_>>()
                .join("&");
            let hash = sm3(query.as_bytes());
            let low = branch(&hash, &body_hash, time);
            (low % 3 == 0).then_some((query, hash, low, ticket))
        })
        .ok_or_else(|| ServiceError::new("SIGNATURE_FAILED", "无法生成 App 请求签名"))?;
    let f13 = f13(&hash, &body_hash, time, low);
    let host = if metadata { METADATA_HOST } else { SEARCH_HOST };
    let url = transport::checked_url(&format!("{host}{api}?{query}"), DOMAINS)?;
    headers.insert(
        "user-agent",
        HeaderValue::from_static(if metadata { METADATA_UA } else { SEARCH_UA }),
    );
    headers.insert(
        "accept",
        HeaderValue::from_static(if metadata {
            "application/json"
        } else {
            "application/json; charset=utf-8,application/x-protobuf"
        }),
    );
    headers.insert("sdk-version", HeaderValue::from_static("2"));
    headers.insert("x-xs-from-web", HeaderValue::from_static("0"));
    headers.insert("x-tt-dt", HeaderValue::from_static(""));
    if metadata {
        headers.insert("accept-encoding", HeaderValue::from_static("identity"));
        headers.insert("x-ss-dp", HeaderValue::from_static("8662"));
        headers.insert("x-tt-store-region", HeaderValue::from_static("cn"));
        headers.insert("x-tt-store-region-src", HeaderValue::from_static("did"));
    } else {
        headers.insert("x-tt-request-tag", HeaderValue::from_static("t=0;n=0"));
        headers.insert("passport-sdk-version", HeaderValue::from_static("50561"));
    }
    let version = if metadata { "7.3.5.32" } else { "7.2.2.32" };
    for (key, value) in [
        ("x-ss-req-ticket", ticket.to_string()),
        ("x-khronos", time.to_string()),
        (
            "x-gorgon",
            gorgon(query.as_bytes(), body_hash, time, rand::random()),
        ),
        ("x-ladon", b64_encode(&time.to_be_bytes())),
        ("x-argus", b64_encode(&time.to_le_bytes())),
        ("x-helios", helios(time)),
        (
            "x-medusa",
            medusa(
                query.as_bytes(),
                &hash,
                body_hash,
                &f13,
                time,
                device,
                version,
            ),
        ),
    ] {
        headers.insert(key, HeaderValue::from_str(&value).expect("ASCII signature"));
    }
    let request = if let Some(body) = body {
        headers.insert(
            "content-type",
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
        headers.insert(
            "x-ss-stub",
            HeaderValue::from_str(&hex_encode(&body_hash).to_uppercase()).expect("hex digest"),
        );
        transport::client()?
            .request(Method::POST, url)
            .headers(headers)
            .body(body)
    } else {
        transport::client()?
            .request(Method::GET, url)
            .headers(headers)
    };
    let response = request.send().await.map_err(|error| {
        ServiceError::new(
            if error.is_timeout() {
                "ETIMEDOUT"
            } else {
                "ERR_NETWORK"
            },
            "App 服务请求失败",
        )
    })?;
    let status = response.status();
    if !status.is_success() {
        let code = if status.as_u16() == 401 {
            "AUTH_REQUIRED"
        } else {
            "APP_HTTP"
        };
        return Err(ServiceError::new(
            code,
            format!("App 服务返回 HTTP {}", status.as_u16()),
        ));
    }
    let bytes = transport::read_body(response, 2 * 1024 * 1024).await?;
    if bytes.is_empty() {
        return Err(ServiceError::new("EMPTY_RESPONSE", "App 服务返回空响应"));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| ServiceError::new("INVALID_RESPONSE", "App 服务返回的响应格式无效"))
}

pub(crate) async fn search(
    keyword: &str,
    offset: usize,
    search_id: &str,
    passback: &str,
) -> Result<Value, ServiceError> {
    let device = crate::media::playback_device().await?;
    let mut fields = device_fields(&device, false);
    for (key, value) in [
        ("query", keyword),
        ("count", "20"),
        ("tab_type", "11"),
        ("bookshelf_search_plan", "4"),
        ("use_correct", "true"),
        ("user_is_login", "0"),
    ] {
        insert(&mut fields, key, value);
    }
    if !search_id.is_empty() {
        insert(&mut fields, "search_id", search_id);
    }
    if !passback.is_empty() {
        insert(&mut fields, "passback", passback);
    }
    insert(&mut fields, "offset", offset.to_string());
    request(
        "/reading/bookapi/search/tab/v",
        fields,
        None,
        HeaderMap::new(),
        &device,
        false,
    )
    .await
}

pub(crate) async fn metadata(
    api: &str,
    mut fields: Fields,
    payload: Option<Value>,
    headers: HeaderMap,
) -> Result<Value, ServiceError> {
    let comment = api
        .strip_prefix("/novel/commentapi/comment/list/")
        .and_then(|path| path.strip_suffix("/v1/"))
        .is_some_and(|id| {
            !id.is_empty() && id.len() <= 30 && id.bytes().all(|byte| byte.is_ascii_digit())
        });
    if !comment
        && !matches!(
            api,
            "/reading/distribution/category/landpage/v/"
                | "/reading/bookapi/bookmall/cell/change/v"
        )
    {
        return Err(ServiceError::new("APP_INPUT", "不支持的 App 目录接口"));
    }
    let device = metadata_device();
    for (key, value) in device_fields(device, true) {
        insert(&mut fields, &key, value);
    }
    request(api, fields, payload, headers, device, true).await
}

pub(crate) async fn account(
    api: &str,
    mut fields: Fields,
    cookie: &str,
) -> Result<Value, ServiceError> {
    if !matches!(
        api,
        "/reading/user/info/v1/"
            | "/reading/bookapi/read_history/list/v1/"
            | "/reading/bookapi/read_progress/list/v1/"
            | "/reading/bookapi/multi-detail/v1/"
            | "/reading/bookapi/bookshelf/video/list/v"
            | "/reading/bookapi/bookshelf/video/info/v"
    ) {
        return Err(ServiceError::new("APP_INPUT", "不支持的账号接口"));
    }
    let device = crate::media::playback_device().await?;
    for (key, value) in device_fields(&device, false) {
        insert(&mut fields, &key, value);
    }
    let mut headers = HeaderMap::new();
    if !cookie.is_empty() {
        let mut cookie = HeaderValue::from_str(cookie)
            .map_err(|_| ServiceError::new("INVALID_REQUEST", "会话凭证格式无效"))?;
        cookie.set_sensitive(true);
        headers.insert("cookie", cookie);
    }
    request(api, fields, None, headers, &device, false).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn signed_hash_and_carrier_match_recorded_legacy_vectors() {
        let time = 1_800_000_000;
        let query = b"query=abc&_rticket=2";
        let hash = sm3(query);
        let body = [0; 16];
        let low = branch(&hash, &body, time);
        assert_eq!(low % 3, 0);
        assert_eq!(
            hex_encode(&f13(&hash, &body, time, low)),
            "b7d91ecd0503b9b68f2c7abd689b489f4f58d425"
        );
        assert_eq!(
            gorgon(query, body, time, 0x1267),
            "84046712400166ee390681c24a64d90c8c55ca370d8b78eb6919"
        );
        let expected = [
            "b3ebd13b343f74f1a9820c65f9d240d32a724afa63150e2c02b50a89a2750322",
            "d95ec5e51c23212f5c776cd483ffabef7313e067d66cefa51bd71e49872bb58d",
            "81973dbb2139e40b4c762ff6b293df40d795cb87c36bf5611a98810bf632bc42",
            "a3aab96955d77d6b083075ba1ce44d0ff4f1e78208f3ee016f41bb426ceaab3b",
        ];
        for (variant, expected) in expected.into_iter().enumerate() {
            let bytes = (0..270).map(|offset| (offset * 9 + 7) as u8).collect();
            let actual = LegacyCarrier::new(variant as u32).encrypt(bytes);
            assert_eq!(hex_encode(&Sha256::digest(actual)), expected);
        }
    }
}
