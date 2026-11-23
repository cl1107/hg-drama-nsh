//! Small protocol-only crypto helpers.
//!
//! The upstream wire formats use MD5/SHA-512/SM3 and AES-128-CBC.  These are
//! protocol primitives, not password storage; callers must not use them for
//! new application security features.

use aes::Aes128;
use aes::cipher::generic_array::GenericArray;
use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit};
use base64::{Engine as _, engine::general_purpose};
use md5::{Digest, Md5};
use sha2::Sha512;

pub(crate) fn md5_bytes(input: &[u8]) -> [u8; 16] {
    let mut digest = Md5::new();
    digest.update(input);
    let output = digest.finalize();
    let mut result = [0_u8; 16];
    result.copy_from_slice(&output);
    result
}

pub(crate) fn sha512_bytes(input: &[u8]) -> [u8; 64] {
    let mut digest = Sha512::new();
    digest.update(input);
    let output = digest.finalize();
    let mut result = [0_u8; 64];
    result.copy_from_slice(&output);
    result
}

pub(crate) fn aes128_cbc_encrypt(data: &[u8], key: &[u8; 16], iv: &[u8; 16]) -> Vec<u8> {
    assert_eq!(data.len() % 16, 0, "AES-CBC input must be block aligned");
    let cipher = Aes128::new(GenericArray::from_slice(key));
    let mut previous = *iv;
    let mut result = Vec::with_capacity(data.len());
    for chunk in data.chunks_exact(16) {
        let mut block = [0_u8; 16];
        for i in 0..16 {
            block[i] = chunk[i] ^ previous[i];
        }
        cipher.encrypt_block(GenericArray::from_mut_slice(&mut block));
        result.extend_from_slice(&block);
        previous = block;
    }
    result
}

pub(crate) fn aes128_cbc_decrypt(data: &[u8], key: &[u8; 16], iv: &[u8; 16]) -> Vec<u8> {
    assert_eq!(data.len() % 16, 0, "AES-CBC input must be block aligned");
    let cipher = Aes128::new(GenericArray::from_slice(key));
    let mut previous = *iv;
    let mut result = Vec::with_capacity(data.len());
    for chunk in data.chunks_exact(16) {
        let mut encrypted = [0_u8; 16];
        encrypted.copy_from_slice(chunk);
        let mut block = encrypted;
        cipher.decrypt_block(GenericArray::from_mut_slice(&mut block));
        for i in 0..16 {
            block[i] ^= previous[i];
        }
        result.extend_from_slice(&block);
        previous = encrypted;
    }
    result
}

pub(crate) fn b64_decode(value: &str) -> Result<Vec<u8>, String> {
    general_purpose::STANDARD
        .decode(value)
        .map_err(|_| "Base64 数据格式无效".to_owned())
}

pub(crate) fn b64_urlsafe_decode(value: &str) -> Result<Vec<u8>, String> {
    let mut normalized = value.replace('-', "+").replace('_', "/");
    while normalized.len() % 4 != 0 {
        normalized.push('=');
    }
    b64_decode(&normalized)
}

pub(crate) fn b64_encode(value: &[u8]) -> String {
    general_purpose::STANDARD.encode(value)
}

pub(crate) fn b64_urlsafe_nopad(value: &[u8]) -> String {
    general_purpose::URL_SAFE_NO_PAD.encode(value)
}

#[inline]
pub(crate) fn rol32(value: u32, count: u32) -> u32 {
    value.rotate_left(count & 31)
}

#[inline]
pub(crate) fn ror32(value: u32, count: u32) -> u32 {
    value.rotate_right(count & 31)
}

#[inline]
#[inline]
pub(crate) fn ror64(value: u64, count: u32) -> u64 {
    value.rotate_right(count & 63)
}

pub(crate) fn le64(value: u64) -> [u8; 8] {
    value.to_le_bytes()
}

pub(crate) fn hex_encode(input: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(input.len() * 2);
    for byte in input {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

pub(crate) fn hex_decode(input: &str) -> Result<Vec<u8>, String> {
    if input.len() % 2 != 0 {
        return Err("十六进制数据长度无效".to_owned());
    }
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len() / 2);
    for index in (0..bytes.len()).step_by(2) {
        let high = hex_nibble(bytes[index]).ok_or_else(|| "十六进制数据无效".to_owned())?;
        let low = hex_nibble(bytes[index + 1]).ok_or_else(|| "十六进制数据无效".to_owned())?;
        output.push((high << 4) | low);
    }
    Ok(output)
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

/// SM3 (GB/T 32905), matching the upstream JavaScript implementation.
pub(crate) fn sm3(input: &[u8]) -> [u8; 32] {
    let bit_len = (input.len() as u64).wrapping_mul(8);
    let padded_len = (input.len() + 9).next_multiple_of(64);
    let mut data = vec![0_u8; padded_len];
    data[..input.len()].copy_from_slice(input);
    data[input.len()] = 0x80;
    data[padded_len - 8..].copy_from_slice(&bit_len.to_be_bytes());

    let mut state = [
        0x7380_166f_u32,
        0x4914_b2b9,
        0x1724_42d7,
        0xda8a_0600,
        0xa96f_30bc,
        0x1631_38aa,
        0xe38d_ee4d,
        0xb0fb_0e4e,
    ];
    let mut words = [0_u32; 68];
    for chunk in data.chunks_exact(64) {
        for index in 0..16 {
            words[index] = u32::from_be_bytes([
                chunk[index * 4],
                chunk[index * 4 + 1],
                chunk[index * 4 + 2],
                chunk[index * 4 + 3],
            ]);
        }
        for index in 16..68 {
            let x = words[index - 16] ^ words[index - 9] ^ rol32(words[index - 3], 15);
            words[index] =
                x ^ rol32(x, 15) ^ rol32(x, 23) ^ rol32(words[index - 13], 7) ^ words[index - 6];
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for index in 0..64 {
            let a12 = rol32(a, 12);
            let constant = if index < 16 { 0x79cc_4519 } else { 0x7a87_9d8a };
            let s1 = rol32(
                a12.wrapping_add(e)
                    .wrapping_add(rol32(constant, index as u32)),
                7,
            );
            let s2 = s1 ^ a12;
            let ff = if index < 16 {
                a ^ b ^ c
            } else {
                (a & b) | (a & c) | (b & c)
            };
            let gg = if index < 16 {
                e ^ f ^ g
            } else {
                (e & f) | ((!e) & g)
            };
            let t1 = ff
                .wrapping_add(d)
                .wrapping_add(s2)
                .wrapping_add(words[index] ^ words[index + 4]);
            let t2 = gg
                .wrapping_add(h)
                .wrapping_add(s1)
                .wrapping_add(words[index]);
            d = c;
            c = rol32(b, 9);
            b = a;
            a = t1;
            h = g;
            g = rol32(f, 19);
            f = e;
            e = t2 ^ rol32(t2, 9) ^ rol32(t2, 17);
        }
        let next = [a, b, c, d, e, f, g, h];
        for index in 0..8 {
            state[index] ^= next[index];
        }
    }
    let mut digest = [0_u8; 32];
    for (index, word) in state.iter().enumerate() {
        digest[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    digest
}

pub(crate) fn pkcs7_pad(input: &[u8], block: usize) -> Vec<u8> {
    let padding = block - input.len() % block;
    let mut output = Vec::with_capacity(input.len() + padding);
    output.extend_from_slice(input);
    output.extend(std::iter::repeat_n(padding as u8, padding));
    output
}

pub(crate) fn pkcs7_unpad(mut input: Vec<u8>, block: usize) -> Vec<u8> {
    if let Some(&last) = input.last() {
        let padding = last as usize;
        if (1..=block).contains(&padding)
            && padding <= input.len()
            && input[input.len() - padding..]
                .iter()
                .all(|value| *value as usize == padding)
        {
            input.truncate(input.len() - padding);
        }
    }
    input
}
