'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { decryptMp4Buffer } = require('./cenc.cjs');
const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const word = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const short = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const wide = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
function box(type, ...parts) { const body = Buffer.concat(parts); return Buffer.concat([word(body.length + 8), Buffer.from(type), body]); }
function fixture({ ivSize = 8, subsample = true, co64 = false, scheme = 'cenc' } = {}) {
 const samples = [Buffer.from('aabbccddeeff00112233445566778899aabbccddeeff', 'hex'), Buffer.from('fedcba98765432100123456789abcdef', 'hex')];
 const ivs = samples.map((_, i) => { const b = Buffer.alloc(16); b.writeUInt32BE(i + 1, 0); b[15] = ivSize === 16 ? 7 : 0; return b; });
 const pairs = samples.map(s => subsample ? [{ clear: 2, encrypted: 5 }, { clear: 1, encrypted: s.length - 8 }] : [{ clear: 0, encrypted: s.length }]);
 const encrypted = samples.map((sample, i) => {
  const cipher = crypto.createCipheriv('aes-128-ctr', key, ivs[i]), output = Buffer.from(sample);
  let at = 0;
  for (const pair of pairs[i]) { at += pair.clear; cipher.update(sample.subarray(at, at + pair.encrypted)).copy(output, at); at += pair.encrypted; }
  cipher.final(); return output;
 });
 const tenc = box('tenc', word(0), Buffer.from([0, 0, 1, ivSize]), Buffer.alloc(16));
 const sinf = box('sinf', box('frma', Buffer.from('avc1')), box('schm', word(0), Buffer.from(scheme), word(0x10000)), box('schi', tenc));
 const stsd = box('stsd', word(0), word(1), box('encv', Buffer.alloc(78), box('avcC', Buffer.from([1, 2, 3])), sinf));
 const senc = box('senc', word(subsample ? 2 : 0), word(samples.length), ...samples.map((_, i) => Buffer.concat([
  ivs[i].subarray(0, ivSize), ...(subsample ? [short(pairs[i].length), ...pairs[i].flatMap(p => [short(p.clear), word(p.encrypted)])] : []),
 ])));
 function moov(offset) {
  return box('moov', box('trak', box('mdia', box('minf', box('stbl', stsd,
   box('stsz', word(0), word(0), word(2), ...samples.map(s => word(s.length))),
   box(co64 ? 'co64' : 'stco', word(0), word(1), (co64 ? wide : word)(offset)),
   box('stsc', word(0), word(1), word(1), word(2), word(1)), senc,
   box('saio', word(0), word(0)), box('saiz', word(0), Buffer.alloc(5)),
  )))));
 }
 const ftyp = box('ftyp', Buffer.from('isom'), word(0)), metadata = moov(0);
 const dataOffset = ftyp.length + metadata.length + 8;
 return { input: Buffer.concat([ftyp, moov(dataOffset), box('mdat', ...encrypted)]), clear: Buffer.concat(samples), dataOffset };
}
for (const options of [{ ivSize: 8, subsample: true }, { ivSize: 16, subsample: false }, { ivSize: 16, subsample: true, co64: true }]) {
 test(`decrypts sample boundaries ${JSON.stringify(options)}`, () => {
  const { input, clear, dataOffset } = fixture(options), before = Buffer.from(input);
  const result = decryptMp4Buffer(input, key);
  assert.deepEqual(input, before, 'input must remain unchanged');
  assert.equal(result.length, input.length, 'chunk offsets remain valid');
  assert.deepEqual(result.subarray(dataOffset), clear);
  assert.equal(result.includes(Buffer.from('encv')), false);
  assert.equal(result.includes(Buffer.from('senc')), false);
  assert.equal(result.includes(Buffer.from('sinf')), false);
  assert.ok(result.includes(Buffer.from('avc1')));
 });
}
test('rejects unsupported scheme before mutating input', () => {
 const { input } = fixture({ scheme: 'cbcs' }), before = Buffer.from(input);
 assert.throws(() => decryptMp4Buffer(input, key), /只支持 cenc/);
 assert.deepEqual(input, before);
});
test('rejects truncated boxes, broken sample mapping, and mismatched senc count', () => {
 const { input } = fixture();
 assert.throws(() => decryptMp4Buffer(input.subarray(0, input.length - 1), key), /截断|越界/);
 const invalidChunk = Buffer.from(input); invalidChunk.writeUInt32BE(1, invalidChunk.indexOf('stco') + 12);
 assert.throws(() => decryptMp4Buffer(invalidChunk, key), /mdat/);
 const invalidCount = Buffer.from(input); invalidCount.writeUInt32BE(1, invalidCount.indexOf('senc') + 8);
 assert.throws(() => decryptMp4Buffer(invalidCount, key), /数量不匹配/);
});
test('rejects subsample ranges beyond a sample', () => {
 const { input } = fixture();
 const at = input.indexOf('senc'); input.writeUInt32BE(999, at + 24);
 assert.throws(() => decryptMp4Buffer(input, key), /subsample/);
});
test('rejects fragmented media and invalid keys', () => {
 const { input } = fixture();
 assert.throws(() => decryptMp4Buffer(Buffer.concat([input, box('moof')]), key), /fragmented/);
 assert.throws(() => decryptMp4Buffer(input, Buffer.alloc(8)), /16 字节/);
});
