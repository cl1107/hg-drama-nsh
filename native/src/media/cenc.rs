// SPDX-License-Identifier: GPL-3.0-only
//
// MP4 CENC sample traversal adapted from jackotom/hongguo-drama,
// commit 782fb21cbddf1be46f88e97af5e788c99e30beae, src/native/hongguo.js.
// Changes in this Rust port: checked offsets and sizes, 8/16-byte IVs,
// subsamples, co64, and size-preserving metadata replacement. Only
// non-fragmented cenc/AES-CTR is supported.

use aes::Aes128;
use ctr::cipher::{KeyIvInit, StreamCipher};

use crate::ServiceError;

type Result<T> = std::result::Result<T, ServiceError>;

const INVALID_CENC_MP4: &str = "INVALID_CENC_MP4";

#[derive(Debug, Clone, Copy)]
struct BoxInfo {
    typ: [u8; 4],
    off: usize,
    size: usize,
    header: usize,
    payload: usize,
    end: usize,
}

#[derive(Debug, Clone, Copy)]
struct Sample {
    offset: usize,
    size: usize,
}

#[derive(Debug, Clone)]
struct Subsample {
    clear: usize,
    encrypted: usize,
}

#[derive(Debug, Clone)]
struct SampleEncryption {
    iv: [u8; 16],
    parts: Vec<Subsample>,
}

#[derive(Debug, Clone, Copy)]
struct Protection {
    entry: BoxInfo,
    sinf: BoxInfo,
    original: [u8; 4],
    iv_size: usize,
}

#[derive(Debug)]
struct Plan {
    protection: Protection,
    samples: Vec<Sample>,
    encryption: Vec<SampleEncryption>,
    metadata: Vec<BoxInfo>,
}

fn error(message: impl Into<String>) -> ServiceError {
    ServiceError::new(INVALID_CENC_MP4, message)
}

fn need(data: &[u8], offset: usize, length: usize, end: usize) -> Result<()> {
    let valid_end = end <= data.len();
    let in_bounds = offset <= end
        && length <= end.saturating_sub(offset)
        && offset <= data.len()
        && length <= data.len().saturating_sub(offset);
    if !valid_end || !in_bounds {
        return Err(error("MP4 数据截断或偏移越界"));
    }
    Ok(())
}

fn u16(data: &[u8], offset: usize, end: usize) -> Result<u16> {
    need(data, offset, 2, end)?;
    Ok(u16::from_be_bytes([data[offset], data[offset + 1]]))
}

fn u32(data: &[u8], offset: usize, end: usize) -> Result<u32> {
    need(data, offset, 4, end)?;
    Ok(u32::from_be_bytes([
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
    ]))
}

fn u64(data: &[u8], offset: usize, end: usize) -> Result<u64> {
    need(data, offset, 8, end)?;
    Ok(u64::from_be_bytes([
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
        data[offset + 4],
        data[offset + 5],
        data[offset + 6],
        data[offset + 7],
    ]))
}

fn checked_add(left: usize, right: usize) -> Result<usize> {
    left.checked_add(right)
        .ok_or_else(|| error("MP4 偏移超出安全范围"))
}

fn checked_mul(left: usize, right: usize) -> Result<usize> {
    left.checked_mul(right)
        .ok_or_else(|| error("MP4 数量超出安全范围"))
}

fn boxes(data: &[u8], start: usize, end: usize) -> Result<Vec<BoxInfo>> {
    if start > end || end > data.len() {
        return Err(error("MP4 box 范围越界"));
    }
    let mut out = Vec::new();
    let mut off = start;
    while off < end {
        need(data, off, 8, end)?;
        let raw_size = u32(data, off, end)?;
        let (size, header) = match raw_size {
            0 => (end - off, 8),
            1 => {
                need(data, off, 16, end)?;
                let wide = u64(data, off + 8, end)?;
                let size = usize::try_from(wide).map_err(|_| error("MP4 box 大小超出安全范围"))?;
                (size, 16)
            }
            value => (value as usize, 8),
        };
        if size < header {
            return Err(error("MP4 box 大小无效"));
        }
        let box_end = checked_add(off, size)?;
        if box_end > end {
            return Err(error("MP4 数据截断或偏移越界"));
        }
        let mut typ = [0_u8; 4];
        typ.copy_from_slice(&data[off + 4..off + 8]);
        out.push(BoxInfo {
            typ,
            off,
            size,
            header,
            payload: off + header,
            end: box_end,
        });
        off = box_end;
    }
    Ok(out)
}

fn is_type(box_info: BoxInfo, typ: &[u8; 4]) -> bool {
    box_info.typ == *typ
}

fn one(boxes: &[BoxInfo], typ: &[u8; 4]) -> Result<BoxInfo> {
    let mut matches = boxes.iter().copied().filter(|item| is_type(*item, typ));
    let first = matches
        .next()
        .ok_or_else(|| error(format!("MP4 必需 box {} 缺失或重复", type_name(typ))))?;
    if matches.next().is_some() {
        return Err(error(format!("MP4 必需 box {} 缺失或重复", type_name(typ))));
    }
    Ok(first)
}

fn type_name(typ: &[u8; 4]) -> String {
    String::from_utf8_lossy(typ).into_owned()
}

fn fullbox(data: &[u8], box_info: BoxInfo, supported_flags: u32) -> Result<u32> {
    let version_flags = u32(data, box_info.payload, box_info.end)?;
    let version = version_flags >> 24;
    let flags = version_flags & 0x00ff_ffff;
    if version != 0 || flags & !supported_flags != 0 {
        return Err(error(format!(
            "{} 的版本或标志暂不支持",
            type_name(&box_info.typ)
        )));
    }
    Ok(flags)
}

fn grouping_uses_seig(data: &[u8], box_info: BoxInfo) -> Result<bool> {
    need(data, box_info.payload, 8, box_info.end)?;
    Ok(&data[box_info.payload + 4..box_info.payload + 8] == b"seig")
}

fn parse_protection(data: &[u8], stsd: BoxInfo) -> Result<Option<Protection>> {
    fullbox(data, stsd, 0)?;
    let count = u32(data, stsd.payload + 4, stsd.end)? as usize;
    let entries = boxes(data, stsd.payload + 8, stsd.end)?;
    if entries.len() != count || count != 1 {
        return Err(error("暂不支持多个 sample description"));
    }
    let entry = entries[0];
    let encv = *b"encv";
    let enca = *b"enca";
    if entry.typ != encv && entry.typ != enca {
        return Ok(None);
    }
    let fields = if entry.typ == encv { 78 } else { 28 };
    need(data, entry.payload, fields, entry.end)?;
    if entry.typ == enca && u16(data, entry.payload + 8, entry.end)? != 0 {
        return Err(error("暂不支持扩展音频 sample entry"));
    }
    let children = boxes(data, entry.payload + fields, entry.end)?;
    let sinf = one(&children, b"sinf")?;
    let protections = boxes(data, sinf.payload, sinf.end)?;
    let frma = one(&protections, b"frma")?;
    if frma.size != frma.header + 4 {
        return Err(error("frma 格式无效"));
    }
    let mut original = [0_u8; 4];
    original.copy_from_slice(&data[frma.payload..frma.end]);
    if entry.typ == encv {
        let config = match &original {
            b"avc1" | b"avc3" => b"avcC",
            b"hvc1" | b"hev1" => b"hvcC",
            b"bvc2" => b"bv2C",
            _ => return Err(error("不支持该加密视频编码")),
        };
        one(&children, config)?;
    } else if original != *b"mp4a" {
        return Err(error("不支持该加密音频编码"));
    }
    let schm = one(&protections, b"schm")?;
    fullbox(data, schm, 1)?;
    need(data, schm.payload, 12, schm.end)?;
    if &data[schm.payload + 4..schm.payload + 8] != b"cenc" {
        return Err(error("只支持 cenc/AES-CTR，不支持 cbcs 等其他加密方式"));
    }
    let schi = one(&protections, b"schi")?;
    let tenc = one(&boxes(data, schi.payload, schi.end)?, b"tenc")?;
    need(data, tenc.payload, 24, tenc.end)?;
    let version_flags = u32(data, tenc.payload, tenc.end)?;
    let version = version_flags >> 24;
    if version > 1 || version_flags & 0x00ff_ffff != 0 {
        return Err(error("暂不支持 tenc pattern/未知版本"));
    }
    if data[tenc.payload + 4] != 0 || data[tenc.payload + 5] != 0 {
        return Err(error("暂不支持 tenc pattern/未知版本"));
    }
    if data[tenc.payload + 6] != 1 {
        return Err(error("加密轨道 tenc 的保护标志无效"));
    }
    let iv_size = data[tenc.payload + 7] as usize;
    if iv_size != 8 && iv_size != 16 {
        return Err(error("只支持 8 或 16 字节的逐 sample IV"));
    }
    Ok(Some(Protection {
        entry,
        sinf,
        original,
        iv_size,
    }))
}

fn sample_layout(data: &[u8], list: &[BoxInfo], mdats: &[BoxInfo]) -> Result<Vec<Sample>> {
    let stsz = one(list, b"stsz")?;
    fullbox(data, stsz, 0)?;
    let fixed = u32(data, stsz.payload + 4, stsz.end)? as usize;
    let count = u32(data, stsz.payload + 8, stsz.end)? as usize;
    if count == 0 || count > data.len().min(10_000_000) {
        return Err(error("sample 数量无效或超限"));
    }
    if fixed == 0 {
        need(data, stsz.payload + 12, checked_mul(count, 4)?, stsz.end)?;
    }
    let mut sizes = Vec::with_capacity(count);
    for i in 0..count {
        sizes.push(if fixed != 0 {
            fixed
        } else {
            let at = checked_add(stsz.payload + 12, checked_mul(i, 4)?)?;
            u32(data, at, stsz.end)? as usize
        });
    }

    let chunk_boxes: Vec<_> = list
        .iter()
        .copied()
        .filter(|item| is_type(*item, b"stco") || is_type(*item, b"co64"))
        .collect();
    if chunk_boxes.len() != 1 {
        return Err(error("缺少唯一 chunk offset 表"));
    }
    let chunks = chunk_boxes[0];
    fullbox(data, chunks, 0)?;
    let chunk_count = u32(data, chunks.payload + 4, chunks.end)? as usize;
    let wide = is_type(chunks, b"co64");
    let offset_width = if wide { 8 } else { 4 };
    need(
        data,
        chunks.payload + 8,
        checked_mul(chunk_count, offset_width)?,
        chunks.end,
    )?;
    let mut offsets = Vec::with_capacity(chunk_count);
    for i in 0..chunk_count {
        let at = checked_add(chunks.payload + 8, checked_mul(i, offset_width)?)?;
        let offset = if wide {
            usize::try_from(u64(data, at, chunks.end)?)
                .map_err(|_| error("co64 偏移超出安全范围"))?
        } else {
            u32(data, at, chunks.end)? as usize
        };
        offsets.push(offset);
    }

    let stsc = one(list, b"stsc")?;
    fullbox(data, stsc, 0)?;
    let rows = u32(data, stsc.payload + 4, stsc.end)? as usize;
    need(data, stsc.payload + 8, checked_mul(rows, 12)?, stsc.end)?;
    if rows == 0 || chunk_count == 0 {
        return Err(error("空的 sample/chunk 映射"));
    }
    let mut mapping = Vec::with_capacity(rows);
    for i in 0..rows {
        let at = checked_add(stsc.payload + 8, checked_mul(i, 12)?)?;
        let first = u32(data, at, stsc.end)? as usize;
        let per_chunk = u32(data, at + 4, stsc.end)? as usize;
        let description = u32(data, at + 8, stsc.end)?;
        let previous_first = mapping.last().map(|item: &(usize, usize)| item.0);
        if description != 1
            || per_chunk == 0
            || first > chunk_count
            || (i == 0 && first != 1)
            || (i != 0 && Some(first) <= previous_first)
        {
            return Err(error("sample/chunk 映射无效"));
        }
        mapping.push((first, per_chunk));
    }

    let mut samples = Vec::with_capacity(count);
    let mut row = 0;
    for chunk in 1..=chunk_count {
        if row + 1 < rows && chunk >= mapping[row + 1].0 {
            row += 1;
        }
        let mut at = offsets[chunk - 1];
        for _ in 0..mapping[row].1 {
            if samples.len() >= count {
                return Err(error("sample/chunk 数量不匹配"));
            }
            let size = sizes[samples.len()];
            let end = checked_add(at, size)?;
            if size == 0
                || !mdats
                    .iter()
                    .any(|mdat| at >= mdat.payload && end <= mdat.end)
            {
                return Err(error("sample 超出 mdat 范围"));
            }
            samples.push(Sample { offset: at, size });
            at = end;
        }
    }
    if samples.len() != count {
        return Err(error("sample 数量不完整"));
    }
    Ok(samples)
}

fn parse_encryption(
    data: &[u8],
    senc: BoxInfo,
    samples: &[Sample],
    iv_size: usize,
) -> Result<Vec<SampleEncryption>> {
    let flags = fullbox(data, senc, 2)?;
    let count = u32(data, senc.payload + 4, senc.end)? as usize;
    if count != samples.len() {
        return Err(error("senc/sample 数量不匹配"));
    }
    let mut at = senc.payload + 8;
    let mut encryption = Vec::with_capacity(count);
    for sample in samples {
        need(data, at, iv_size, senc.end)?;
        let mut iv = [0_u8; 16];
        iv[..iv_size].copy_from_slice(&data[at..at + iv_size]);
        at += iv_size;
        let mut parts = Vec::new();
        if flags & 2 != 0 {
            let number = u16(data, at, senc.end)? as usize;
            at += 2;
            if number == 0 {
                return Err(error("subsample 列表为空"));
            }
            let mut total = 0_usize;
            for _ in 0..number {
                need(data, at, 6, senc.end)?;
                let clear = u16(data, at, senc.end)? as usize;
                let encrypted = u32(data, at + 2, senc.end)? as usize;
                at += 6;
                total = total
                    .checked_add(clear)
                    .and_then(|value| value.checked_add(encrypted))
                    .ok_or_else(|| error("subsample 长度超出安全范围"))?;
                if total > sample.size {
                    return Err(error("subsample 长度越过 sample"));
                }
                parts.push(Subsample { clear, encrypted });
            }
            if total != sample.size {
                return Err(error("subsample 总长度与 sample 不符"));
            }
        } else {
            parts.push(Subsample {
                clear: 0,
                encrypted: sample.size,
            });
        }
        encryption.push(SampleEncryption { iv, parts });
    }
    if at != senc.end {
        return Err(error("senc 包含多余或不支持的数据"));
    }
    Ok(encryption)
}

/// Decrypts a non-fragmented CENC MP4 using a 16-byte AES content key.
///
/// The input is never mutated. Sample/chunk offsets remain valid because the
/// encrypted sample descriptions and auxiliary boxes are replaced with
/// same-size `free` boxes after the sample bytes are decrypted.
pub(crate) fn decrypt_mp4_buffer(input: &[u8], key: &[u8]) -> Result<Vec<u8>> {
    if key.len() != 16 {
        return Err(error("需要 MP4 数据和 16 字节内容密钥"));
    }
    let top = boxes(input, 0, input.len())?;
    if top.iter().any(|item| is_type(*item, b"moof")) {
        return Err(error("暂不支持 fragmented MP4"));
    }
    let moov = one(&top, b"moov")?;
    let mdats: Vec<_> = top
        .iter()
        .copied()
        .filter(|item| is_type(*item, b"mdat"))
        .collect();
    if mdats.is_empty() {
        return Err(error("缺少 mdat"));
    }

    let mut plans = Vec::new();
    let moov_children = boxes(input, moov.payload, moov.end)?;
    for trak in moov_children
        .iter()
        .copied()
        .filter(|item| is_type(*item, b"trak"))
    {
        let mdia = one(&boxes(input, trak.payload, trak.end)?, b"mdia")?;
        let minf = one(&boxes(input, mdia.payload, mdia.end)?, b"minf")?;
        let stbl = one(&boxes(input, minf.payload, minf.end)?, b"stbl")?;
        let list = boxes(input, stbl.payload, stbl.end)?;
        let protection = match parse_protection(input, one(&list, b"stsd")?)? {
            Some(value) => value,
            None => continue,
        };
        for grouping in list
            .iter()
            .copied()
            .filter(|item| is_type(*item, b"sgpd") || is_type(*item, b"sbgp"))
        {
            if grouping_uses_seig(input, grouping)? {
                return Err(error("暂不支持 seig key rotation"));
            }
        }
        let samples = sample_layout(input, &list, &mdats)?;
        let senc = one(&list, b"senc")?;
        let encryption = parse_encryption(input, senc, &samples, protection.iv_size)?;
        let metadata = list
            .iter()
            .copied()
            .filter(|item| {
                is_type(*item, b"senc") || is_type(*item, b"saio") || is_type(*item, b"saiz")
            })
            .collect();
        plans.push(Plan {
            protection,
            samples,
            encryption,
            metadata,
        });
    }
    if plans.is_empty() {
        return Err(error("未找到支持的 CENC 加密轨道"));
    }

    let mut ranges: Vec<Sample> = plans
        .iter()
        .flat_map(|plan| plan.samples.iter().copied())
        .collect();
    ranges.sort_by_key(|sample| sample.offset);
    for pair in ranges.windows(2) {
        let previous_end = checked_add(pair[0].offset, pair[0].size)?;
        if pair[1].offset < previous_end {
            return Err(error("加密 sample 范围重叠"));
        }
    }

    let mut output = input.to_vec();
    for plan in plans {
        for (sample, encrypted) in plan.samples.iter().zip(plan.encryption.iter()) {
            let mut cipher = ctr::Ctr128BE::<Aes128>::new_from_slices(key, &encrypted.iv)
                .map_err(|_| error("AES-CTR 初始化失败"))?;
            let mut at = sample.offset;
            for part in &encrypted.parts {
                at = checked_add(at, part.clear)?;
                let end = checked_add(at, part.encrypted)?;
                let sample_end = checked_add(sample.offset, sample.size)?;
                need(input, at, part.encrypted, sample_end)?;
                cipher.apply_keystream(&mut output[at..end]);
                at = end;
            }
        }
        output[plan.protection.entry.off + 4..plan.protection.entry.off + 8]
            .copy_from_slice(&plan.protection.original);
        for metadata in std::iter::once(plan.protection.sinf).chain(plan.metadata) {
            output[metadata.off + 4..metadata.off + 8].copy_from_slice(b"free");
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use aes::Aes128;
    use ctr::cipher::{KeyIvInit, StreamCipher};

    use super::decrypt_mp4_buffer;

    const KEY: [u8; 16] = [
        0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
        0x0f,
    ];

    fn word(value: u32) -> Vec<u8> {
        value.to_be_bytes().to_vec()
    }

    fn wide(value: u64) -> Vec<u8> {
        value.to_be_bytes().to_vec()
    }

    fn box_(typ: &[u8; 4], parts: &[Vec<u8>]) -> Vec<u8> {
        let payload = parts.iter().map(Vec::as_slice).collect::<Vec<_>>().concat();
        let size = (payload.len() + 8) as u32;
        [word(size), typ.to_vec(), payload].concat()
    }

    fn encrypted_fixture(
        iv_size: usize,
        subsample: bool,
        co64: bool,
        scheme: &[u8; 4],
    ) -> (Vec<u8>, Vec<u8>, usize) {
        let samples = vec![
            hex::decode("aabbccddeeff00112233445566778899aabbccddeeff").unwrap(),
            hex::decode("fedcba98765432100123456789abcdef").unwrap(),
        ];
        let mut ivs = Vec::new();
        for index in 0..samples.len() {
            let mut iv = [0_u8; 16];
            iv[..4].copy_from_slice(&((index + 1) as u32).to_be_bytes());
            if iv_size == 16 {
                iv[15] = 7;
            }
            ivs.push(iv);
        }
        let pairs: Vec<Vec<(usize, usize)>> = samples
            .iter()
            .map(|sample| {
                if subsample {
                    vec![(2, 5), (1, sample.len() - 8)]
                } else {
                    vec![(0, sample.len())]
                }
            })
            .collect();
        let mut encrypted = Vec::new();
        for (sample, (iv, sample_pairs)) in samples.iter().zip(ivs.iter().zip(pairs.iter())) {
            let mut output = sample.clone();
            let mut cipher = ctr::Ctr128BE::<Aes128>::new_from_slices(&KEY, iv).unwrap();
            let mut at = 0;
            for (clear, encrypted_size) in sample_pairs {
                at += clear;
                cipher.apply_keystream(&mut output[at..at + encrypted_size]);
                at += encrypted_size;
            }
            encrypted.push(output);
        }
        let tenc = box_(
            b"tenc",
            &[word(0), vec![0, 0, 1, iv_size as u8], vec![0; 16]],
        );
        let sinf = box_(
            b"sinf",
            &[
                box_(b"frma", &[b"avc1".to_vec()]),
                box_(b"schm", &[word(0), scheme.to_vec(), word(0x10000)]),
                box_(b"schi", &[tenc]),
            ],
        );
        let stsd = box_(
            b"stsd",
            &[
                word(0),
                word(1),
                box_(
                    b"encv",
                    &[vec![0; 78], box_(b"avcC", &[vec![1, 2, 3]]), sinf],
                ),
            ],
        );
        let mut senc_parts = vec![
            word(if subsample { 2 } else { 0 }),
            word(samples.len() as u32),
        ];
        for (iv, sample_pairs) in ivs.iter().zip(pairs.iter()) {
            senc_parts.push(iv[..iv_size].to_vec());
            if subsample {
                senc_parts.push((sample_pairs.len() as u16).to_be_bytes().to_vec());
                for (clear, encrypted_size) in sample_pairs {
                    senc_parts.push((*clear as u16).to_be_bytes().to_vec());
                    senc_parts.push((*encrypted_size as u32).to_be_bytes().to_vec());
                }
            }
        }
        let senc = box_(b"senc", &senc_parts);
        let ftyp = box_(b"ftyp", &[b"isom".to_vec(), word(0)]);
        let make_moov = |offset: u64| {
            let offsets = if co64 {
                box_(b"co64", &[word(0), word(1), wide(offset)])
            } else {
                box_(b"stco", &[word(0), word(1), word(offset as u32)])
            };
            box_(
                b"moov",
                &[box_(
                    b"trak",
                    &[box_(
                        b"mdia",
                        &[box_(
                            b"minf",
                            &[box_(
                                b"stbl",
                                &[
                                    stsd.clone(),
                                    box_(
                                        b"stsz",
                                        &[
                                            word(0),
                                            word(0),
                                            word(samples.len() as u32),
                                            word(samples[0].len() as u32),
                                            word(samples[1].len() as u32),
                                        ],
                                    ),
                                    offsets,
                                    box_(b"stsc", &[word(0), word(1), word(1), word(2), word(1)]),
                                    senc.clone(),
                                    box_(b"saio", &[word(0), word(0)]),
                                    box_(b"saiz", &[word(0), vec![0; 5]]),
                                ],
                            )],
                        )],
                    )],
                )],
            )
        };
        let metadata = make_moov(0);
        let data_offset = ftyp.len() + metadata.len() + 8;
        let moov = make_moov(data_offset as u64);
        let mdat = box_(b"mdat", &encrypted);
        let clear = samples.concat();
        ([ftyp, moov, mdat].concat(), clear, data_offset)
    }

    #[test]
    fn rejects_invalid_key_before_parsing() {
        let error = decrypt_mp4_buffer(b"not an mp4", &[0; 8]).expect_err("must reject key");
        assert_eq!(error.to_string(), "需要 MP4 数据和 16 字节内容密钥");
    }

    #[test]
    fn decrypts_subsamples_and_preserves_offsets() {
        for (iv_size, subsample, co64) in [(8, true, false), (16, false, false), (16, true, true)] {
            let (input, clear, data_offset) = encrypted_fixture(iv_size, subsample, co64, b"cenc");
            let original = input.clone();
            let result = decrypt_mp4_buffer(&input, &KEY).expect("fixture decrypts");
            assert_eq!(input, original);
            assert_eq!(result.len(), input.len());
            assert_eq!(
                &result[data_offset..data_offset + clear.len()],
                clear.as_slice()
            );
            assert!(!result.windows(4).any(|part| part == b"encv"));
            assert!(!result.windows(4).any(|part| part == b"senc"));
            assert!(!result.windows(4).any(|part| part == b"sinf"));
            assert!(result.windows(4).any(|part| part == b"avc1"));
        }
    }

    #[test]
    fn rejects_unsupported_scheme_and_fragmented_media() {
        let (input, _, _) = encrypted_fixture(8, true, false, b"cbcs");
        let original = input.clone();
        assert!(decrypt_mp4_buffer(&input, &KEY).is_err());
        assert_eq!(input, original);
        let (input, _, _) = encrypted_fixture(8, true, false, b"cenc");
        let fragmented = [input, box_(b"moof", &[])].concat();
        assert!(decrypt_mp4_buffer(&fragmented, &KEY).is_err());
    }

    #[test]
    fn decrypts_bytevc2_and_preserves_its_decoder_config() {
        let (mut input, clear, data_offset) = encrypted_fixture(8, true, false, b"cenc");
        let original = input.windows(4).position(|part| part == b"avc1").unwrap();
        let config = input.windows(4).position(|part| part == b"avcC").unwrap();
        input[original..original + 4].copy_from_slice(b"bvc2");
        assert!(decrypt_mp4_buffer(&input, &KEY).is_err());
        input[config..config + 4].copy_from_slice(b"bv2C");

        let result = decrypt_mp4_buffer(&input, &KEY).expect("ByteVC2 fixture decrypts");
        assert_eq!(&result[data_offset..], &clear);
        assert_eq!(&result[config..config + 7], b"bv2C\x01\x02\x03");
        assert!(!result.windows(4).any(|part| part == b"encv"));
        assert!(result.windows(4).any(|part| part == b"bvc2"));
    }
}
