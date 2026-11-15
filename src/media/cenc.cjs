// SPDX-License-Identifier: GPL-3.0-only
// MP4 CENC sample traversal adapted from jackotom/hongguo-drama,
// commit 782fb21cbddf1be46f88e97af5e788c99e30beae, src/native/hongguo.js.
// Changes: strict bounds, 8/16-byte IVs, subsamples, co64, and size-preserving
// metadata replacement. Only non-fragmented cenc/AES-CTR is supported.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');

function fail(message) {
  throw Object.assign(new Error(message), { code: 'INVALID_CENC_MP4' });
}
function need(data, offset, length, end = data.length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > end || end > data.length) fail('MP4 数据截断或偏移越界');
}
function u32(data, offset, end) { need(data, offset, 4, end); return data.readUInt32BE(offset); }
function boxes(data, start = 0, end = data.length) {
  const out = [];
  for (let off = start; off < end;) {
    need(data, off, 8, end);
    let size = data.readUInt32BE(off), header = 8;
    if (size === 1) {
      need(data, off, 16, end);
      const wide = data.readBigUInt64BE(off + 8);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) fail('MP4 box 大小超出安全范围');
      size = Number(wide); header = 16;
    } else if (size === 0) size = end - off;
    if (size < header) fail('MP4 box 大小无效');
    need(data, off, size, end);
    out.push({ type: data.toString('latin1', off + 4, off + 8), off, size, header, payload: off + header, end: off + size });
    off += size;
  }
  return out;
}
function one(list, type) {
  const matches = list.filter(b => b.type === type);
  if (matches.length !== 1) fail(`MP4 必需 box ${type} 缺失或重复`);
  return matches[0];
}
function fullbox(data, box, supportedFlags = 0) {
  const v = u32(data, box.payload, box.end);
  if ((v >>> 24) !== 0 || ((v & 0xffffff) & ~supportedFlags)) fail(`${box.type} 的版本或标志暂不支持`);
  return v & 0xffffff;
}
function groupingUsesSeig(data, box) {
  need(data, box.payload, 8, box.end);
  return data.toString('latin1', box.payload + 4, box.payload + 8) === 'seig';
}
function parseProtection(data, stsd) {
  fullbox(data, stsd);
  const count = u32(data, stsd.payload + 4, stsd.end);
  const entries = boxes(data, stsd.payload + 8, stsd.end);
  if (entries.length !== count || count !== 1) fail('暂不支持多个 sample description');
  const entry = entries[0];
  if (!['encv', 'enca'].includes(entry.type)) return null;
  const fields = entry.type === 'encv' ? 78 : 28;
  need(data, entry.payload, fields, entry.end);
  if (entry.type === 'enca' && data.readUInt16BE(entry.payload + 8) !== 0) fail('暂不支持扩展音频 sample entry');
  const children = boxes(data, entry.payload + fields, entry.end);
  const sinf = one(children, 'sinf'), protections = boxes(data, sinf.payload, sinf.end);
  const frma = one(protections, 'frma');
  if (frma.size !== frma.header + 4) fail('frma 格式无效');
  const original = data.toString('latin1', frma.payload, frma.end);
  if (entry.type === 'encv') {
    if (!['avc1', 'avc3', 'hvc1', 'hev1'].includes(original)) fail('不支持该加密视频编码');
    one(children, original.startsWith('avc') ? 'avcC' : 'hvcC');
  } else if (original !== 'mp4a') fail('不支持该加密音频编码');
  const schm = one(protections, 'schm'); fullbox(data, schm, 1);
  need(data, schm.payload, 12, schm.end);
  if (data.toString('latin1', schm.payload + 4, schm.payload + 8) !== 'cenc') fail('只支持 cenc/AES-CTR，不支持 cbcs 等其他加密方式');
  const schi = one(protections, 'schi'), tenc = one(boxes(data, schi.payload, schi.end), 'tenc');
  need(data, tenc.payload, 24, tenc.end);
  const versionFlags = u32(data, tenc.payload, tenc.end), version = versionFlags >>> 24;
  if (version > 1 || (versionFlags & 0xffffff) !== 0 || data[tenc.payload + 4] !== 0 || data[tenc.payload + 5] !== 0) fail('暂不支持 tenc pattern/未知版本');
  if (data[tenc.payload + 6] !== 1) fail('加密轨道 tenc 的保护标志无效');
  const ivSize = data[tenc.payload + 7];
  if (![8, 16].includes(ivSize)) fail('只支持 8 或 16 字节的逐 sample IV');
  return { entry, sinf, original, ivSize };
}
function sampleLayout(data, list, mdats) {
  const stsz = one(list, 'stsz'); fullbox(data, stsz);
  const fixed = u32(data, stsz.payload + 4, stsz.end), count = u32(data, stsz.payload + 8, stsz.end);
  if (!count || count > Math.min(data.length, 10000000)) fail('sample 数量无效或超限');
  if (!fixed) need(data, stsz.payload + 12, count * 4, stsz.end);
  const sizes = Array.from({ length: count }, (_, i) => fixed || u32(data, stsz.payload + 12 + i * 4, stsz.end));
  const chunkBoxes = list.filter(b => b.type === 'stco' || b.type === 'co64');
  if (chunkBoxes.length !== 1) fail('缺少唯一 chunk offset 表');
  const chunks = chunkBoxes[0]; fullbox(data, chunks);
  const chunkCount = u32(data, chunks.payload + 4, chunks.end), wide = chunks.type === 'co64';
  need(data, chunks.payload + 8, chunkCount * (wide ? 8 : 4), chunks.end);
  const offsets = Array.from({ length: chunkCount }, (_, i) => {
    const at = chunks.payload + 8 + i * (wide ? 8 : 4);
    if (!wide) return data.readUInt32BE(at);
    const n = data.readBigUInt64BE(at); if (n > BigInt(Number.MAX_SAFE_INTEGER)) fail('co64 偏移超出安全范围');
    return Number(n);
  });
  const stsc = one(list, 'stsc'); fullbox(data, stsc);
  const rows = u32(data, stsc.payload + 4, stsc.end); need(data, stsc.payload + 8, rows * 12, stsc.end);
  if (!rows || !chunkCount) fail('空的 sample/chunk 映射');
  const mapping = [];
  for (let i = 0; i < rows; i++) {
    const at = stsc.payload + 8 + i * 12;
    const first = u32(data, at, stsc.end), perChunk = u32(data, at + 4, stsc.end), desc = u32(data, at + 8, stsc.end);
    if (desc !== 1 || !perChunk || first > chunkCount || (i === 0 ? first !== 1 : first <= mapping[i - 1].first)) fail('sample/chunk 映射无效');
    mapping.push({ first, perChunk });
  }
  const samples = []; let row = 0;
  for (let chunk = 1; chunk <= chunkCount; chunk++) {
    if (row + 1 < rows && chunk >= mapping[row + 1].first) row++;
    let at = offsets[chunk - 1];
    for (let i = 0; i < mapping[row].perChunk; i++) {
      if (samples.length >= count) fail('sample/chunk 数量不匹配');
      const size = sizes[samples.length];
      if (!size || !mdats.some(b => at >= b.payload && at + size <= b.end)) fail('sample 超出 mdat 范围');
      samples.push({ offset: at, size }); at += size;
    }
  }
  if (samples.length !== count) fail('sample 数量不完整');
  return samples;
}
function parseEncryption(data, senc, samples, ivSize) {
  const flags = fullbox(data, senc, 2), count = u32(data, senc.payload + 4, senc.end);
  if (count !== samples.length) fail('senc/sample 数量不匹配');
  let at = senc.payload + 8;
  const encryption = samples.map(sample => {
    need(data, at, ivSize, senc.end);
    const iv = Buffer.alloc(16); data.copy(iv, 0, at, at + ivSize); at += ivSize;
    const parts = [];
    if (flags & 2) {
      need(data, at, 2, senc.end); const n = data.readUInt16BE(at); at += 2;
      if (!n) fail('subsample 列表为空');
      let total = 0;
      for (let i = 0; i < n; i++) {
        need(data, at, 6, senc.end);
        const clear = data.readUInt16BE(at), encrypted = data.readUInt32BE(at + 2); at += 6;
        total += clear + encrypted; if (total > sample.size) fail('subsample 长度越过 sample');
        parts.push({ clear, encrypted });
      }
      if (total !== sample.size) fail('subsample 总长度与 sample 不符');
    } else parts.push({ clear: 0, encrypted: sample.size });
    return { iv, parts };
  });
  if (at !== senc.end) fail('senc 包含多余或不支持的数据');
  return encryption;
}

/** Decrypts non-fragmented cenc MP4. Returns a new Buffer; never mutates input. */
function decryptMp4Buffer(input, key) {
  if (!Buffer.isBuffer(input) || !Buffer.isBuffer(key) || key.length !== 16) fail('需要 MP4 Buffer 和 16 字节内容密钥');
  const top = boxes(input);
  if (top.some(b => b.type === 'moof')) fail('暂不支持 fragmented MP4');
  const moov = one(top, 'moov'), mdats = top.filter(b => b.type === 'mdat');
  if (!mdats.length) fail('缺少 mdat');
  const plans = [];
  for (const trak of boxes(input, moov.payload, moov.end).filter(b => b.type === 'trak')) {
    const mdia = one(boxes(input, trak.payload, trak.end), 'mdia');
    const minf = one(boxes(input, mdia.payload, mdia.end), 'minf');
    const stbl = one(boxes(input, minf.payload, minf.end), 'stbl');
    const list = boxes(input, stbl.payload, stbl.end), protection = parseProtection(input, one(list, 'stsd'));
    if (!protection) continue;
    if (list.some(b => ['sgpd', 'sbgp'].includes(b.type) && groupingUsesSeig(input, b))) fail('暂不支持 seig key rotation');
    const samples = sampleLayout(input, list, mdats);
    const encryption = parseEncryption(input, one(list, 'senc'), samples, protection.ivSize);
    plans.push({ protection, samples, encryption, metadata: list.filter(b => ['senc', 'saio', 'saiz'].includes(b.type)) });
  }
  if (!plans.length) fail('未找到支持的 CENC 加密轨道');
  // Reject overlapping sample maps before modifying bytes.
  const ranges = plans.flatMap(p => p.samples).sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ranges.length; i++) if (ranges[i].offset < ranges[i - 1].offset + ranges[i - 1].size) fail('加密 sample 范围重叠');
  const output = Buffer.from(input);
  for (const plan of plans) {
    plan.samples.forEach((sample, index) => {
      const encrypted = plan.encryption[index], decipher = crypto.createDecipheriv('aes-128-ctr', key, encrypted.iv);
      let at = sample.offset;
      for (const part of encrypted.parts) {
        at += part.clear;
        if (part.encrypted) decipher.update(input.subarray(at, at + part.encrypted)).copy(output, at);
        at += part.encrypted;
      }
      decipher.final();
    });
    output.write(plan.protection.original, plan.protection.entry.off + 4, 4, 'latin1');
    for (const box of [plan.protection.sinf, ...plan.metadata]) output.write('free', box.off + 4, 4, 'latin1');
  }
  return output;
}
function decryptMp4File(source, destination, key) {
  const output = decryptMp4Buffer(fs.readFileSync(source), key);
  fs.writeFileSync(destination, output, { flag: 'wx', mode: 0o600 });
}
module.exports = { decryptMp4Buffer, decryptMp4File };
