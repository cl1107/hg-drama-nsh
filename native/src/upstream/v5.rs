//! Android v5 playback signer used by `player/v1` and `video_tab`.

use std::collections::BTreeMap;

use crate::ServiceError;
use rand::RngCore;
use url::Url;

use super::crypto::{
    b64_encode, b64_urlsafe_nopad, hex_decode, hex_encode, md5_bytes, rol32, ror32, ror64, sm3,
};

const MAGIC: [u8; 16] = [
    0x2d, 0x4b, 0x4f, 0xca, 0x49, 0x75, 0x0d, 0x43, 0x3f, 0xb5, 0xae, 0x2c, 0x22, 0x6d, 0xcc, 0x56,
];
const SIGN_KEY: [u8; 32] = [
    0xb2, 0x3c, 0x2a, 0x47, 0x0a, 0x20, 0xd1, 0x05, 0xdc, 0x3f, 0x8c, 0x44, 0x38, 0xf8, 0x27, 0x2e,
    0xd4, 0x6d, 0x6c, 0x89, 0xff, 0xdc, 0xde, 0xdd, 0x51, 0x08, 0x69, 0x8d, 0x26, 0xe9, 0x48, 0x9d,
];
pub(crate) const HASH_TABLE: [u32; 64] = [
    0xebb6_4faf,
    0x07aa_dcc2,
    0xcf31_87bf,
    0xe011_38ff,
    0x6d0b_fcff,
    0x5a30_a3be,
    0xb41a_d638,
    0x3418_0eb8,
    0xf233_eb6f,
    0xb1a5_84cc,
    0xccc3_0dc7,
    0x47d1_db51,
    0xd556_53de,
    0x70a8_4fa1,
    0x5747_3c12,
    0xf76f_0288,
    0x2c07_7f0a,
    0xda0d_cad0,
    0xfbb8_6f6c,
    0xfdc4_cf00,
    0x688a_020d,
    0xe676_c6a6,
    0x8cd6_338b,
    0x1a3c_8d0e,
    0xcce8_b06b,
    0x6ad0_ed0b,
    0xa052_2717,
    0xdc71_ac83,
    0x2285_db71,
    0xd5b4_dda6,
    0x736f_8650,
    0x6560_306c,
    0x617c_e2a6,
    0xe423_417e,
    0x0a40_e143,
    0x544e_4032,
    0x88df_fb2a,
    0x716c_1ae0,
    0x4c46_7a88,
    0x05b2_3bb3,
    0xe1d0_b866,
    0xbaa3_dcb8,
    0xae33_74d3,
    0xc338_1a50,
    0x1702_f75b,
    0xfe6d_a368,
    0xf0b4_cf48,
    0x4e0f_fbb8,
    0x72aa_d10d,
    0x26c5_3a3d,
    0xf2bc_e0f6,
    0xb455_7581,
    0x4a25_7fdd,
    0x8c31_82a2,
    0xab0b_3b86,
    0x3d5d_fb14,
    0x4f10_3634,
    0xd37b_52d7,
    0x444e_ff16,
    0xeb0a_33d1,
    0x6ca8_6f6e,
    0x0028_4ba7,
    0x0838_7cfa,
    0x5fb3_7586,
];
const SBOX_HEX: &str = "53290fe9e51f316f90f74a7e034d367784ab49237cd0135cdc632c322fd3be0e2624a417ecd9151a7ff64f60730a87f9445ec6ada2f865d22b696c4188f24c0df37b75510b939f6bc2fe6883e68bc8c722181ba0bdb08c9871b50c9a16b46eea8eed20ba4b8a14e0fcf1468dbbef05a93e5a9d7dcf06898635c1fd99f5de287a80c594daaab19b6279fbd75070cb52eb2555c456e39e7839853874e2f0013ac0b64742d8ca10e4b79c955de8b843ce4ed464a6a72ed508091c92e7b3eedd1e1dd12afac321618fa3d65f9167c982f43d66a53c6a1997585b346dbf9672ff37cdbc073b2dae11453304df00815476b2a13fccdb30b957a8acafe127400248591238922563e36406d37a24100b7902a028044e218453c2a399199c9d13dc40c55ba67e502273850ebdc1a2e2188b8f2d9e3cb909b8c46a2a9f4a6dd93007eafa65b7b3a881aa908cc74f0ad76bbbb58617c37012ca05a469fd44e62eecf1e4272ce860c0ae5eadf99b20d8f0234174006f3f110d7657d01645d4eff8f71471cbfe1cb2f52648727bf3c9de55153e031b4d61757db63dbf7782eeafe9018a8891362fb14759ac32bab03b349aeb5a377c5156be4c8dfbe13a684bda39cf836697c894545fe0f2491acea9fc6252f4ff1e0fe72bd2df6e67a7f635e5bcc6d1a5dd951d89960887a18eb40c785cdb1f80ed42299333ab98cdd67f316cd54346585dccd759fb722789b08807cc0fda293f7e5e1819bb0353517020b31d3d00374952bea2c421e862040a9ec892a05b266b7a0d0cc316f483b81af39715657ffe32ad8de0c13077646035236ee5363e5f900e9a7cf850a81cd9960b6df73317226f99eaa6fff15cec34acb98246639b918ab2851466a7cdfc4ad1b52c2ae95a58d3734e47ddd5b7560193f644ef9c408b7dee39b4d6aabf4de761e3252d4c7ba3843187745d55e6a5db05d42b45caed43c0c5d0b64bfa9d94a4a9d8f2f0e1a108dcfd288fd2bc1fc7bd675412138169cb09249875ba3b68cfb11180afae104fc9789571c6dfce02413886796ae21e3c488cc21b9f423a066c2eabf98e2fdeeb5776e4f5d09a515ba58cbbab3e37b09fd4f6d9244df80512e84cd7956be301cf64f1429d58577cc241f3a2c655144f81aaf95a4e108da894b38970561ae9002619fbbac91fa922ed202bfc62cb08e0de2a7f3631435f8b47c8a3c563b4db4071ce74c46da6fa696a9e282d1e825d663b93bfd56c48dce1884bb10fccea063929f746443fd830a4232e53da21a1f2d1bdfebc3a02c10a1b8ad31d04fd616590d272ac737e98eb33af60528716bee78ec0ee8699031177277d9cff32542c67caf5f44591681335ae0e178f3409a7803db83892dde5b9b7f0c750e24aef077badd678a09b850b84ec1597e4963cb5e675df1c0d6fb618496ecd76c35c798325590c2fb27a5e";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct V5Values {
    pub fields: Vec<(String, String)>,
}

impl V5Values {
    pub fn new(fields: impl IntoIterator<Item = (impl Into<String>, impl Into<String>)>) -> Self {
        Self {
            fields: fields
                .into_iter()
                .map(|(key, value)| (key.into(), value.into()))
                .collect(),
        }
    }

    pub fn insert(&mut self, key: impl Into<String>, value: impl Into<String>) {
        let key = key.into();
        if let Some(existing) = self.fields.iter_mut().find(|(name, _)| *name == key) {
            existing.1 = value.into();
        } else {
            self.fields.push((key, value.into()));
        }
    }

    fn get(&self, key: &str) -> Option<&str> {
        self.fields
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    }
}

#[derive(Clone, Debug)]
pub struct PlaybackV5Input {
    pub base: String,
    pub values: V5Values,
    pub body: Option<Vec<u8>>,
    pub now_millis: u64,
    pub allow_empty_body: bool,
    pub field21: Option<u16>,
    pub process_nonce: Option<[u8; 18]>,
    pub process_started_millis: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlaybackV5Request {
    pub url: String,
    pub headers: BTreeMap<String, String>,
}

fn append_varint(output: &mut Vec<u8>, mut value: u64) {
    while value > 127 {
        output.push((value as u8 & 127) | 128);
        value >>= 7;
    }
    output.push(value as u8);
}

fn zigzag(value: i128) -> u64 {
    if value < 0 {
        ((-value) as u64).wrapping_mul(2).wrapping_sub(1)
    } else {
        (value as u64).wrapping_mul(2)
    }
}

#[derive(Default)]
struct V5Proto(Vec<u8>);

impl V5Proto {
    fn sint(mut self, tag: u32, value: i128) -> Self {
        append_varint(&mut self.0, (tag as u64) << 3);
        append_varint(&mut self.0, zigzag(value));
        self
    }

    fn text(mut self, tag: u32, value: &str) -> Self {
        if value.is_empty() {
            return self;
        }
        self = self.bytes(tag, value.as_bytes());
        self
    }

    fn bytes(mut self, tag: u32, value: &[u8]) -> Self {
        append_varint(&mut self.0, ((tag as u64) << 3) | 2);
        append_varint(&mut self.0, value.len() as u64);
        self.0.extend_from_slice(value);
        self
    }

    fn message(self, tag: u32, value: &V5Proto) -> Self {
        self.bytes(tag, &value.0)
    }

    fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

fn get_iv(initial: u32, bytes: &[u8]) -> u32 {
    let mut value = initial;
    for (index, byte) in bytes.iter().enumerate() {
        value = if index & 1 == 0 {
            (value >> 4) ^ value ^ value.wrapping_shl(6) ^ *byte as u32
        } else {
            !((value >> 7) ^ value ^ ((*byte as u32) | value.wrapping_shl(12)))
        };
    }
    value
}

pub fn branch(query: &[u8], body: &[u8], timestamp: u32) -> u32 {
    get_iv(
        get_iv(get_iv(0x2023_0928, query), body),
        &timestamp.to_le_bytes(),
    ) & 15
}

fn sum_md5(bytes: &[u8]) -> u32 {
    let mut check = 0x2022_0420_u32;
    for index in 0..12 {
        let temp = if index & 1 == 0 {
            (check >> 3) ^ check
        } else {
            (check >> 5) ^ check
        };
        check = if index & 1 == 0 {
            bytes[index] as u32 ^ check.wrapping_shl(7)
        } else {
            !(bytes[index] as u32 | check.wrapping_shl(11))
        } ^ temp;
    }
    (check | 4) ^ 0x0100_0000
}

pub fn hash_f13(query: &[u8], body: &[u8], timestamp: u32) -> Result<[u8; 20], ServiceError> {
    if branch(query, body, timestamp) != 12 {
        return Err(ServiceError::new("APP_INPUT", "不支持的 v5 hash branch"));
    }
    let seed = 0x9d4a_97c2_u32;
    let count = seed.wrapping_add(timestamp);
    let table: Vec<u32> = HASH_TABLE
        .iter()
        .map(|value| ror32(*value, count.wrapping_add(1)))
        .collect();
    let shift = (count.wrapping_add(2) & 7) as u32;
    let pad = [0xfa_u8, 0x45, 0x61, 0xd7]
        .map(|value| (((value as u16 | (value as u16) << 8) >> shift) & 255) as u8);
    let mut data = Vec::new();
    data.extend_from_slice(query);
    data.extend_from_slice(body);
    data.extend_from_slice(&timestamp.to_le_bytes());
    data.extend_from_slice(&pad);
    data.extend_from_slice(&hex_decode("00000000000001a0").expect("f13 tail"));
    let mut schedule = Vec::with_capacity(128);
    for chunk in data.chunks_exact(4) {
        schedule.push(u32::from_be_bytes(chunk.try_into().expect("f13 word")));
    }
    for index in 0..112 {
        let x = schedule[index + 1];
        let y = schedule[index + 14];
        schedule.push(
            schedule[index]
                .wrapping_add(schedule[index + 9])
                .wrapping_add(rol32(x, 14) ^ rol32(x, 25) ^ (x >> 3))
                .wrapping_add(rol32(y, 13) ^ rol32(y, 15) ^ (y >> 10)),
        );
    }
    let initial = [
        0x7aba_4fc8,
        0x6716_6507,
        0x6403_fa00,
        0x340f_512f,
        984_304_912,
        3_005_047_866,
        2_874_125_293,
        2_152_413_264,
    ]
    .map(|value| ror32(value, count));
    let mut state = initial;
    for index in 0..96 {
        let base = seed.wrapping_add(index as u32);
        let n1 = ((state[4] ^ state[0]) & state[1]) ^ state[4];
        let n2 = rol32(state[1], 26) ^ rol32(state[1], 21) ^ rol32(state[1], 7);
        let n4 = schedule[(base & 127) as usize]
            .wrapping_add(n1)
            .wrapping_add(n2)
            .wrapping_add(table[(base & 63) as usize])
            .wrapping_add(state[6]);
        let n5 = rol32(state[3], 30) ^ rol32(state[3], 19) ^ rol32(state[3], 10);
        let n6 = (state[3] & state[5]) | ((state[3] | state[5]) & state[2]);
        let old = state[7];
        state.rotate_right(1);
        state[7] = n5.wrapping_add(n6).wrapping_add(n4);
        state[0] = old.wrapping_add(n4);
    }
    let mut output = [0_u8; 32];
    for index in 0..8 {
        output[index * 4..index * 4 + 4]
            .copy_from_slice(&state[index].wrapping_add(initial[index]).to_be_bytes());
    }
    let mut result = [0_u8; 20];
    for index in 0..16 {
        result[index] = output[index] ^ output[index + 16];
    }
    let checksum = (sum_md5(&result[..16]) | 0x20).to_le_bytes();
    result[16..].copy_from_slice(&checksum);
    Ok(result)
}

pub(crate) struct CarrierV5 {
    box_: Vec<u8>,
    con: [usize; 4],
    order: [usize; 16],
    keys: Vec<[u8; 4]>,
}

impl CarrierV5 {
    pub(crate) fn new(key: &[u8], timestamp: u32) -> Self {
        let sbox = hex_decode(SBOX_HEX).expect("v5 SBOX");
        let word = (timestamp & 3) as usize;
        let box_ = sbox[word * 256..(word + 1) * 256].to_vec();
        let con = [[2, 0, 3, 1], [1, 3, 2, 0], [3, 2, 1, 0], [2, 3, 1, 0]][word];
        let order = [
            [0, 9, 14, 15, 4, 13, 2, 7, 8, 1, 6, 3, 12, 5, 10, 11],
            [0, 9, 14, 11, 4, 13, 2, 3, 8, 1, 6, 15, 12, 5, 10, 7],
            [0, 9, 14, 3, 4, 13, 2, 15, 8, 1, 6, 11, 12, 5, 10, 7],
            [0, 9, 14, 15, 4, 13, 2, 3, 8, 1, 6, 11, 12, 5, 10, 7],
        ][word];
        let initial: u32 = [0xbbb5_de72, 0xd463_8d5b, 0x92a5_f73b, 0x89f8_a1c9][word];
        let mut expanded = Vec::with_capacity(48);
        for index in 0..16 {
            expanded.push(initial.to_le_bytes()[index & 3] ^ key[index % key.len()]);
        }
        expanded.resize(48, 0);
        let mut rounds = 8;
        for index in 4..12 {
            let at = 4 * (index - 1);
            let mut a = expanded[at];
            let mut b = expanded[at + 1];
            let mut c = expanded[at + 2];
            let mut d = expanded[at + 3];
            if index & 3 == 0 {
                let temp = ((initial >> (rounds & 24)) as u8 ^ box_[b as usize]) & 255;
                b = box_[c as usize];
                c = box_[d as usize];
                d = box_[a as usize];
                a = temp;
            }
            rounds += 2;
            expanded[at + 4] = a ^ expanded[at - 12];
            expanded[at + 5] = b ^ expanded[at - 11];
            expanded[at + 6] = c ^ expanded[at - 10];
            expanded[at + 7] = d ^ expanded[at - 9];
        }
        let keys = expanded
            .chunks_exact(4)
            .map(|chunk| [chunk[0], chunk[1], chunk[2], chunk[3]])
            .collect();
        Self {
            box_,
            con,
            order,
            keys,
        }
    }

    fn block(&self, value: &[u8]) -> [u8; 16] {
        let mut rows = [[0_u8; 4]; 4];
        for row in 0..4 {
            rows[row].copy_from_slice(&value[row * 4..row * 4 + 4]);
        }
        let add = |rows: &mut [[u8; 4]; 4], offset: usize| {
            for row in 0..4 {
                for col in 0..4 {
                    rows[row][col] ^= self.keys[offset + row][self.con[col]];
                }
            }
        };
        add(&mut rows, 0);
        for round in 1..=2 {
            let before = rows;
            let mut flat = [0_u8; 16];
            for row in 0..4 {
                for col in 0..4 {
                    flat[row * 4 + col] = self.box_[before[self.con[row]][col] as usize];
                }
            }
            let mut next = [[0_u8; 4]; 4];
            for row in 0..4 {
                for col in 0..4 {
                    next[row][col] = flat[self.order[row * 4 + col]];
                }
            }
            rows = next;
            if round == 1 {
                let old = rows;
                for row in 0..4 {
                    for col in 0..4 {
                        rows[row][col] = old[row][self.con[col]];
                    }
                }
                for col in 0..4 {
                    let t = rows[0][col] ^ rows[1][col] ^ rows[2][col] ^ rows[3][col];
                    let u = rows[0][col];
                    rows[0][col] ^= t ^ xtime(rows[0][col] ^ rows[1][col]);
                    rows[1][col] ^= t ^ xtime(rows[1][col] ^ rows[2][col]);
                    rows[2][col] ^= t ^ xtime(rows[2][col] ^ rows[3][col]);
                    rows[3][col] ^= t ^ xtime(rows[3][col] ^ u);
                }
            }
            add(&mut rows, round * 4);
        }
        for row in 0..4 {
            for col in 0..4 {
                rows[row][col] ^= self.keys[4 + row][col];
            }
        }
        let mut output = [0_u8; 16];
        for row in 0..4 {
            output[row * 4..row * 4 + 4].copy_from_slice(&rows[row]);
        }
        output
    }

    pub(crate) fn encrypt(&self, source: &[u8], iv: &[u8; 16]) -> Vec<u8> {
        if source.len() < 248 {
            return Vec::new();
        }
        let wire = [6, 5, 3, 4, 2, 7, 1, 0];
        let compact = [1, 7, 3, 6, 2, 0, 4, 5];
        let mut plaintext = [0_u8; 32];
        for index in 0..31 {
            for bit in 0..8 {
                plaintext[index] |= ((source[index * 8 + bit] >> wire[bit]) & 1) << compact[bit];
            }
        }
        plaintext[31] = 1;
        let mut first_input = [0_u8; 16];
        for index in 0..16 {
            first_input[index] = plaintext[index] ^ iv[index];
        }
        let first = self.block(&first_input);
        let mut second_input = [0_u8; 16];
        for index in 0..16 {
            second_input[index] = plaintext[index + 16] ^ first[index];
        }
        let second = self.block(&second_input);
        let mut key = [0_u8; 32];
        key[..16].copy_from_slice(&first);
        key[16..].copy_from_slice(&second);
        let mut output = source.to_vec();
        for index in 0..31 {
            for bit in 0..8 {
                let at = index * 8 + bit;
                output[at] = (output[at] & !(1 << wire[bit]))
                    | (((key[index] >> compact[bit]) & 1) << wire[bit]);
            }
        }
        let mut result = vec![key[31]];
        result.extend_from_slice(&output);
        result
    }
}

fn xtime(value: u8) -> u8 {
    (value << 1) ^ if value & 0x80 != 0 { 0x1b } else { 0 }
}

pub(crate) fn xmxor(data: &[u8], key: &[u8]) -> Vec<u8> {
    let mut encoded = vec![0_u8; data.len()];
    for (index, byte) in data.iter().enumerate() {
        let at = (index * 4) & 28;
        let d0 = key[at];
        let d1 = key[at + 1];
        let mut value = (!(((byte.rotate_left(4) as u16 + d0 as u16) & 255) as u8)) ^ d1;
        value = value.rotate_left(3);
        encoded[data.len() - index - 1] = !((value.wrapping_add(d1) ^ d0) & 255);
    }
    let last = encoded[encoded.len() - 1] ^ encoded[encoded.len() - 2];
    let first = encoded[0];
    encoded[0] = (!last).wrapping_add(first);
    encoded[1] = (encoded[0] ^ *encoded.last().expect("xmxor") ^ 254).wrapping_add(encoded[1]);
    encoded[2] =
        encoded[2].wrapping_add((last.wrapping_sub(first)) ^ encoded[1].rotate_left(3) ^ 2);
    for index in 0..encoded.len().saturating_sub(4) {
        let temp =
            encoded[index + 2].rotate_left(3) ^ encoded[index + 1] ^ (index as u8).wrapping_add(3);
        encoded[index + 3] = (!temp).wrapping_add(encoded[index + 3]);
    }
    let last_index = encoded.len() - 1;
    encoded[last_index] ^= encoded[last_index - 1];
    let sum = encoded
        .iter()
        .skip(1)
        .fold(0_u8, |sum, value| sum.wrapping_add(*value));
    encoded[0] = (encoded[0] ^ encoded[1]).wrapping_add(sum);
    encoded
}

fn random32(rng: &mut impl RngCore) -> u32 {
    rng.next_u32()
}

fn medusa(
    query: &[u8],
    f13: &[u8; 20],
    timestamp: u32,
    values: &V5Values,
    field21: u16,
    process_nonce: &str,
    process_started: u64,
    rng: &mut impl RngCore,
) -> String {
    let device_id = values.get("device_id").unwrap_or_default();
    let os_version = values.get("os_version").unwrap_or_default();
    let device_type = values.get("device_type").unwrap_or_default();
    let device_brand = values.get("device_brand").unwrap_or("HONOR");
    let channel = values.get("channel").unwrap_or_default();
    let version_name = values.get("version_name").unwrap_or_default();
    let flags = [0_u8; 8];
    let device = V5Proto::default()
        .sint(1, 1)
        .sint(2, 2)
        .text(3, "8662")
        .text(4, device_id)
        .text(5, process_nonce)
        .text(6, "!noperm!")
        .text(12, "Asia/Shanghai,8")
        .text(13, "zh_CN")
        .text(22, os_version)
        .sint(25, process_started as i128)
        .text(30, device_type)
        .text(31, device_brand)
        .text(32, device_type)
        .text(34, device_brand);
    let env = V5Proto::default()
        .text(6, "v04.10.03.04-bugfix")
        .text(8, channel)
        .message(12, &device)
        .text(14, version_name);
    let message = V5Proto::default()
        .bytes(1, &MAGIC)
        .sint(2, 5)
        .sint(3, random32(rng) as i128)
        .text(4, "8662")
        .text(5, device_id)
        .text(6, "646637794")
        .text(7, version_name)
        .text(8, "v04.10.03-ml-android")
        .sint(9, 0x040a_0300)
        .bytes(10, &flags)
        .sint(12, timestamp as i128)
        .bytes(13, f13)
        .bytes(14, &query[..6])
        .message(
            15,
            &V5Proto::default()
                .sint(1, 1)
                .sint(2, 1)
                .sint(3, 1)
                .sint(5, 1),
        )
        .sint(17, timestamp as i128)
        .text(20, "none")
        .sint(21, i128::from(field21))
        .message(23, &env)
        .text(24, "{\"cmr\":16777216,\"cmr2\":16777216,\"un_h\":11,\"vpn\":0,\"kd\":0,\"dyn\":\"\",\"do\":1,\"tk\":true}");
    let nonce = random32(rng);
    let high = ((nonce >> 16) & 255) as u32;
    let mut hash_input = Vec::with_capacity(68);
    hash_input.extend_from_slice(&SIGN_KEY);
    hash_input.extend_from_slice(&nonce.to_le_bytes());
    hash_input.extend_from_slice(&SIGN_KEY);
    let hash = sm3(&hash_input);
    let seed_value = !(((high << 11) | (nonce >> 24)) ^ (high >> 5) ^ high);
    let seed = seed_value.to_le_bytes();
    let mut transformed = Vec::with_capacity(8 + message.as_bytes().len());
    transformed.extend_from_slice(&flags);
    transformed.extend_from_slice(&xmxor(message.as_bytes(), &hash));
    transformed.reverse();
    for (index, byte) in transformed.iter_mut().enumerate() {
        *byte ^= seed[(!index) & 3];
    }
    let check = 0x1800_0001 | ((query[0] as u32 & 63) << 14) | ((f13[0] as u32 & 63) << 8);
    let mut packed = vec![0xca];
    packed.extend_from_slice(&random32(rng).to_le_bytes());
    packed.extend_from_slice(&check.to_le_bytes());
    packed.extend_from_slice(&transformed);
    packed.extend_from_slice(&[(nonce >> 16) as u8, (nonce >> 24) as u8]);
    let first_key = md5_bytes(&SIGN_KEY[..16]);
    let second_key = md5_bytes(&SIGN_KEY[16..]);
    let encrypted = CarrierV5::new(&first_key, timestamp).encrypt(&packed, &second_key);
    let mut prefix = Vec::with_capacity(20);
    prefix.extend_from_slice(&5_u32.to_le_bytes());
    prefix.extend_from_slice(&MAGIC);
    let time = timestamp.to_le_bytes();
    for index in 0..prefix.len() {
        prefix[index] ^= time[index & 3];
    }
    let mut output = prefix;
    output.extend_from_slice(&[nonce as u8, (nonce >> 8) as u8, 0, 1]);
    output.extend_from_slice(&encrypted);
    b64_encode(&output)
}

fn helios(timestamp: u32, rng: &mut impl RngCore) -> String {
    let nonce = random32(rng).to_le_bytes();
    let mut input = nonce.to_vec();
    input.extend_from_slice(b"8662");
    let digest = md5_bytes(&input);
    let ascii = hex_encode(&digest);
    let mut words = [0_u64; 4];
    for index in 0..4 {
        words[index] = u64::from_le_bytes(
            ascii.as_bytes()[index * 8..index * 8 + 8]
                .try_into()
                .expect("Helios word"),
        );
    }
    let mut table = vec![words[0]];
    let mut b0 = words[0];
    let mut b8 = words[1];
    let mut queue = std::collections::VecDeque::from([words[2], words[3]]);
    for index in 0..34 {
        let mut value = ror64(b8, 8).wrapping_add(b0) ^ index as u64;
        queue.push_back(value);
        value ^= ror64(b0, 61);
        table.push(value);
        b0 = value;
        b8 = queue.pop_front().expect("Helios queue");
    }
    let text = format!("{}-646637794-8662", timestamp);
    let padding = 16 - text.len() % 16;
    let mut data = text.into_bytes();
    data.extend(std::iter::repeat_n(padding as u8, padding));
    let mut output = nonce.to_vec();
    for chunk in data.chunks_exact(16) {
        let mut a = u64::from_le_bytes(chunk[..8].try_into().expect("Helios block"));
        let mut b = u64::from_le_bytes(chunk[8..].try_into().expect("Helios block"));
        for key in table.iter().take(34) {
            b = *key ^ a.wrapping_add(ror64(b, 8));
            a = b ^ ror64(a, 61);
        }
        output.extend_from_slice(&a.to_le_bytes());
        output.extend_from_slice(&b.to_le_bytes());
    }
    b64_encode(&output)
}

pub(crate) fn encode_component(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut output = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.' | b'~' | b'*') {
            output.push(*byte as char);
        } else {
            output.push('%');
            output.push(HEX[(byte >> 4) as usize] as char);
            output.push(HEX[(byte & 15) as usize] as char);
        }
    }
    output
}

fn validate_values(values: &V5Values) -> Result<V5Values, ServiceError> {
    if values.fields.len() > 128 {
        return Err(ServiceError::new("APP_INPUT", "V5 query 字段过多"));
    }
    let result = values.clone();
    for (key, value) in &result.fields {
        if key.is_empty()
            || key.len() > 128
            || value.len() > 8192
            || key
                .bytes()
                .any(|byte| byte < 0x20 || (0x7f..=0x9f).contains(&byte))
            || value
                .bytes()
                .any(|byte| byte < 0x20 || (0x7f..=0x9f).contains(&byte))
        {
            return Err(ServiceError::new("APP_INPUT", "V5 query 字段格式无效"));
        }
        if !key.is_ascii() && std::str::from_utf8(key.as_bytes()).is_err()
            || std::str::from_utf8(value.as_bytes()).is_err()
        {
            return Err(ServiceError::new("APP_INPUT", "V5 query 字段编码无效"));
        }
    }
    for key in ["device_id", "iid"] {
        let Some(value) = result.get(key) else {
            return Err(ServiceError::new("APP_INPUT", format!("V5 {key} 缺失")));
        };
        if !(1..=30).contains(&value.len())
            || !value.bytes().all(|byte| byte.is_ascii_digit())
            || !value.bytes().any(|byte| byte != b'0')
        {
            return Err(ServiceError::new("APP_INPUT", format!("V5 {key} 无效")));
        }
    }
    for key in [
        "cdid",
        "version_name",
        "channel",
        "os_version",
        "device_type",
    ] {
        let Some(value) = result.get(key) else {
            return Err(ServiceError::new("APP_INPUT", format!("V5 {key} 缺失")));
        };
        if value.trim().is_empty() || value.len() > 128 {
            return Err(ServiceError::new("APP_INPUT", format!("V5 {key} 无效")));
        }
    }
    if let Some(aid) = result.get("aid")
        && aid != "8662"
    {
        return Err(ServiceError::new("APP_INPUT", "V5 aid 无效"));
    }
    Ok(result)
}

fn valid_base(base: &str) -> Result<Url, ServiceError> {
    if base.len() > 8192
        || base.chars().any(|value| value.is_whitespace())
        || base.contains(['?', '#'])
    {
        return Err(ServiceError::new(
            "APP_INPUT",
            "V5 base 必须是不带 query/fragment 的 HTTPS 地址",
        ));
    }
    let parsed =
        Url::parse(base).map_err(|_| ServiceError::new("APP_INPUT", "V5 base 地址无效"))?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some_and(|port| port != 443)
    {
        return Err(ServiceError::new(
            "APP_INPUT",
            "V5 base 必须使用 HTTPS 且不能包含凭证",
        ));
    }
    Ok(parsed)
}

pub fn sign_playback_v5(input: PlaybackV5Input) -> Result<PlaybackV5Request, ServiceError> {
    let parsed = valid_base(&input.base)?;
    if input.now_millis > i64::MAX as u64 || input.now_millis / 1000 > 0x7fff_ffff {
        return Err(ServiceError::new("APP_INPUT", "V5 时间戳无效"));
    }
    let mut values = validate_values(&input.values)?;
    let has_body = !(input.allow_empty_body && input.body.is_none());
    let body = if has_body {
        let Some(body) = input.body.as_deref() else {
            return Err(ServiceError::new(
                "APP_INPUT",
                "V5 body 必须是原始 gzip 字节",
            ));
        };
        if body.len() < 18
            || body.len() > 2 * 1024 * 1024
            || body.get(0..3) != Some(&[0x1f, 0x8b, 8])
        {
            return Err(ServiceError::new(
                "APP_INPUT",
                "V5 body 必须是受限 gzip 字节",
            ));
        }
        body
    } else {
        &[]
    };
    let timestamp = (input.now_millis / 1000) as u32;
    let body_hash = md5_bytes(body);
    if values.get("ts").is_some() {
        values.insert("ts", timestamp.to_string());
    }
    let process_started = input.process_started_millis.unwrap_or(input.now_millis);
    let process_nonce = input.process_nonce.unwrap_or_else(|| {
        let mut rng = rand::rng();
        let mut bytes = [0_u8; 18];
        rng.fill_bytes(&mut bytes);
        bytes
    });
    let process_nonce = b64_urlsafe_nopad(&process_nonce);
    let mut rng = rand::rng();
    for offset in 0..1024_u64 {
        let ticket = input.now_millis + offset;
        let mut query = String::new();
        for (index, (key, value)) in values.fields.iter().enumerate() {
            if index > 0 {
                query.push('&');
            }
            query.push_str(&encode_component(key));
            query.push('=');
            query.push_str(&encode_component(value));
        }
        if !query.is_empty() {
            query.push('&');
        }
        query.push_str("_rticket=");
        query.push_str(&ticket.to_string());
        let query_hash = sm3(query.as_bytes());
        if branch(&query_hash, &body_hash, timestamp) != 12 {
            continue;
        }
        let f13 = hash_f13(&query_hash, &body_hash, timestamp)?;
        let medusa_value = medusa(
            &query_hash,
            &f13,
            timestamp,
            &values,
            input.field21.unwrap_or(312),
            &process_nonce,
            process_started,
            &mut rng,
        );
        let helios_value = helios(timestamp, &mut rng);
        let mut headers = BTreeMap::new();
        headers.insert("x-khronos".to_owned(), timestamp.to_string());
        headers.insert("x-helios".to_owned(), helios_value);
        headers.insert("x-medusa".to_owned(), medusa_value);
        if has_body {
            headers.insert("x-ss-req-ticket".to_owned(), ticket.to_string());
            headers.insert(
                "x-ss-stub".to_owned(),
                hex_encode(&body_hash).to_uppercase(),
            );
        }
        return Ok(PlaybackV5Request {
            url: format!("{}?{query}", parsed.as_str()),
            headers,
        });
    }
    Err(ServiceError::new(
        "SIGNATURE_FAILED",
        "无法在 1024 次尝试内生成 v5 播放签名",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn f13_matches_all_fixture_branches_in_known_vector_shape() {
        let query =
            hex_decode("97f67a81cea547c71c76702cc529330762c14971d85f3c335467579d1e9c15e3").unwrap();
        let body = hex_decode("0ff85a33ee8c8aa4f59a843d5199909f").unwrap();
        assert_eq!(branch(&query, &body, 1_800_000_000), 12);
        let digest = hash_f13(&query, &body, 1_800_000_000).unwrap();
        assert_eq!(
            hex_encode(&digest),
            "ca03ec7a0c2444b3dcccf33453d0257936dbddf9"
        );
    }

    #[test]
    fn carrier_roundtrip_shape_is_stable() {
        let source = vec![0x13_u8; 256];
        let carrier = CarrierV5::new(
            &hex_decode("000102030405060708090a0b0c0d0e0f").unwrap(),
            1_800_000_000,
        );
        let output = carrier.encrypt(
            &source,
            &hex_decode("101112131415161718191a1b1c1d1e1f")
                .unwrap()
                .try_into()
                .unwrap(),
        );
        assert_eq!(output.len(), source.len() + 1);
        assert_eq!(
            hex_encode(&output),
            "3753131b131793111313131b031393131213331b131793131213331b031313131213131b1313931113531313131313131213131303179311135333130317931313533313131713111253331b03139313125333130313931313133313131393131313131b131793131213331b03131311135333130317931112533313031313111253131b131313131213331b031713131313331b031713111213131b13139311131313130313131312533313031793131313131b1317931312133313031793131213131b031393111253331313171311125333131317131312133313131393111253131b031393131313131b031713131313131b13139313121313131313131313"
        );
    }

    #[test]
    fn query_encoding_preserves_upstream_star_and_tilde() {
        assert_eq!(
            encode_component("中文 !*'()~ +&=%"),
            "%E4%B8%AD%E6%96%87%20%21*%27%28%29~%20%2B%26%3D%25"
        );
    }

    #[test]
    fn xmxor_and_carrier_match_js_reference_vectors() {
        let d = hex_decode("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f").unwrap();
        let k = hex_decode("f0e1d2c3b4a5968778695a4b3c2d1e0f00112233445566778899aabbccddeeff").unwrap();
        assert_eq!(
            hex_encode(&xmxor(&d, &k)),
            "fd33e9f5a27c8e434961ac613de0b52c1da8a6ee17162cfa1a46ca6d23f43760",
            "xmxor mismatch"
        );
        let src = vec![0x13_u8; 256];
        let ck = hex_decode("000102030405060708090a0b0c0d0e0f").unwrap();
        let iv: [u8; 16] = hex_decode("101112131415161718191a1b1c1d1e1f").unwrap().try_into().unwrap();
        let expected = [
            "3753131b131793111313131b031393131213331b13179313",
            "bf53331b1317931313533313131713111353331b03131311",
            "495333131313931312531313031793131353131303171313",
            "d71313130313131112131313131713111253331303139313",
        ];
        for (ts, exp) in expected.iter().enumerate() {
            let out = CarrierV5::new(&ck, ts as u32).encrypt(&src, &iv);
            assert_eq!(&hex_encode(&out)[..48], *exp, "carrier ts={ts} mismatch");
        }

        struct FixedRng(u8);
        impl RngCore for FixedRng {
            fn next_u32(&mut self) -> u32 { u32::from_le_bytes([self.0; 4]) }
            fn next_u64(&mut self) -> u64 { u64::from_le_bytes([self.0; 8]) }
            fn fill_bytes(&mut self, dest: &mut [u8]) { dest.fill(self.0); }
        }
        let values = V5Values::new([
            ("aid", "8662"), ("app_name", "novelread"), ("version_code", "74332"),
            ("version_name", "7.4.3.32"), ("channel", "vivo_8662_64"), ("device_platform", "android"),
            ("device_type", "PGT-AN10"), ("os_version", "12"), ("update_version_code", "74332"),
            ("iid", "2234567890123456789"), ("cdid", "synthetic-device"), ("device_id", "1234567890123456789"),
        ]);
        let query = "aid=8662&app_name=novelread&version_code=74332&version_name=7.4.3.32&channel=vivo_8662_64&device_platform=android&device_type=PGT-AN10&os_version=12&update_version_code=74332&iid=2234567890123456789&cdid=synthetic-device&device_id=1234567890123456789&_rticket=1800000000011";
        let body = hex_decode("1f8b0800000000000013ab564a54b232ac0500afac1b5607000000").unwrap();
        let query_hash = sm3(query.as_bytes());
        let body_hash = md5_bytes(&body);
        assert_eq!(branch(&query_hash, &body_hash, 1_800_000_000), 12);
        let f13 = hash_f13(&query_hash, &body_hash, 1_800_000_000).unwrap();
        assert_eq!(hex_encode(&query_hash[..6]), "407518d247bc", "query_hash mismatch");
        assert_eq!(hex_encode(&f13), "e6f93fe7d46106349d7e7581d105beb67d93d9dd", "f13 mismatch");
        let nonce_b64 = b64_urlsafe_nopad(&[0x80_u8; 18]);
        assert_eq!(nonce_b64, "gICAgICAgICAgICAgICAgICA", "nonce_b64 mismatch");
        let mut rng = FixedRng(0x80);
        let actual = medusa(&query_hash, &f13, 1_800_000_000, &values, 377, &nonce_b64, 1_800_000_000_000, &mut rng);
        assert_eq!(&actual[..80], "BdJJay2ZBqFJp0QoP2fnRyK/hT2AgAABFIqgiICAASYBGGjqqxZtSjVVjIov6E2uq8opLb1Fk0d/+TFq");
        assert_eq!(&actual[actual.len()-40..], "TK+ouYbribiUfOe3SC2ddzei+//7//v/+/+AgA==");
    }
}
