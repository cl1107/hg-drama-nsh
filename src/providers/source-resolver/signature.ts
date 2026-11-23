import { Buffer } from "buffer";
import { createHash, randomBytes } from "crypto";
import { NativeCrypto } from "hg-drama/native";
import { sm3 } from "./sm3";

const LICENSE_ID = 1611921764n;
const SIGN_KEY = Buffer.from("fc78e0a9657a0c748ce51559903ccf03510e51d3cff232d71343e88a321c5304", "hex");
const AES_KEY = Buffer.from("d31e3718288a1027baab59f146a09a9c", "hex");
const AES_IV = Buffer.from("ea180a0336ed352fcd24e4d50018ae54", "hex");
const MAGIC8 = Buffer.from("f2f7fcfff2f7fcff", "hex");
const TAIL9 = Buffer.from("eafb2cfe8568519154", "hex");

const u64 = (value: bigint) => BigInt.asUintN(64, value);
const rol64 = (value: bigint, bits: number) => u64((u64(value) << BigInt(bits)) | (u64(value) >> BigInt(64 - bits)));
const ror64 = (value: bigint, bits: number) => rol64(value, 64 - bits);

function integer(value: number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isSafeInteger(value)) throw new TypeError("Safe integer or BigInt required");
  return BigInt(value);
}

function readU64LE(buf: Uint8Array, offset: number): bigint {
  let out = 0n;
  for (let i = 7; i >= 0; i--) {
    out = (out << 8n) | BigInt(buf[offset + i]);
  }
  return out;
}

function writeU64LE(buf: Uint8Array, value: bigint, offset: number): void {
  let n = u64(value);
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number(n & 0xffn);
    n >>= 8n;
  }
}

function le64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  writeU64LE(out, value, 0);
  return out;
}

function varint(value: number | bigint): Buffer {
  let n = BigInt.asUintN(32, integer(value));
  const out: number[] = [];
  while (n >= 128n) {
    out.push(Number(n & 127n) | 128);
    n >>= 7n;
  }
  out.push(Number(n));
  return Buffer.from(out);
}

class ProtoBuf {
  private readonly parts: Buffer[] = [];
  putVarint(tag: number, value: number | bigint): this {
    this.parts.push(varint(BigInt(tag) << 3n), varint(value));
    return this;
  }
  putBytes(tag: number, bytes: Uint8Array): this {
    const value = Buffer.from(bytes);
    this.parts.push(varint((BigInt(tag) << 3n) | 2n), varint(value.length), value);
    return this;
  }
  putUtf8(tag: number, value: string): this {
    return this.putBytes(tag, Buffer.from(value, "utf8"));
  }
  putProtobuf(tag: number, value: ProtoBuf): this {
    return this.putBytes(tag, value.toBuf());
  }
  toBuf(): Buffer {
    return Buffer.concat(this.parts);
  }
}

function simonKeyExpansion(key: bigint[]): bigint[] {
  const expanded = key.map((v) => u64(v));
  for (let i = 4; i < 72; i++) {
    let tmp = ror64(expanded[i - 1], 3) ^ expanded[i - 3];
    tmp ^= ror64(tmp, 1);
    const bit = (0x3dc94c3a046d678bn >> BigInt((i - 4) % 62)) & 1n;
    expanded.push(u64(~expanded[i - 4] ^ tmp ^ bit ^ 3n));
  }
  return expanded;
}

function simonEncrypt(left: bigint, right: bigint, key: bigint[]): [bigint, bigint] {
  let x = u64(left);
  let y = u64(right);
  for (const roundKey of simonKeyExpansion(key)) {
    const previous = y;
    y = u64(x ^ (rol64(y, 1) & rol64(y, 8)) ^ rol64(y, 2) ^ roundKey);
    x = previous;
  }
  return [x, y];
}

const pad16 = (data: Buffer) => Buffer.concat([data, Buffer.alloc(16 - (data.length % 16), 16 - (data.length % 16))]);

function queryParam(query: string, name: string): string | null {
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value.replace(/\+/g, " "));
    } catch {
      return value;
    }
  };
  for (const part of query.split("&")) {
    const at = part.indexOf("=");
    const key = at < 0 ? part : part.slice(0, at);
    if (decode(key) === name) return decode(at < 0 ? "" : part.slice(at + 1));
  }
  return null;
}

function argusBodyHash(stubHex: string): Buffer {
  if (!stubHex) return sm3(Buffer.alloc(16)).subarray(0, 6);
  const bytes = /^(?:[a-f\d]{2})+$/i.test(stubHex) ? Buffer.from(stubHex, "hex") : Buffer.alloc(0);
  return sm3(bytes).subarray(0, 6);
}

function argusQueryHash(query: string): Buffer {
  return sm3(query ? Buffer.from(query, "utf8") : Buffer.alloc(16)).subarray(0, 6);
}

function argusSign(
  query: string,
  stubHex: string,
  ts: bigint,
  aid: bigint,
  licenseId: bigint,
  deviceId: string,
  installId: string,
  randField: number,
): string {
  const bean = new ProtoBuf()
    .putVarint(1, 1077940818)
    .putVarint(2, 2)
    .putVarint(3, randField)
    .putUtf8(4, String(aid === 0n ? 1967n : aid))
    .putUtf8(5, deviceId)
    .putUtf8(6, String(licenseId === 0n ? LICENSE_ID : licenseId))
    .putUtf8(7, queryParam(query, "version_name") || "")
    .putUtf8(8, "v04.04.05-ov-android")
    .putVarint(9, 134744640)
    .putBytes(10, Buffer.alloc(8))
    .putVarint(11, 0)
    .putVarint(12, ts << 1n)
    .putBytes(13, argusBodyHash(stubHex))
    .putBytes(14, argusQueryHash(query))
    .putProtobuf(15, new ProtoBuf().putVarint(1, 1).putVarint(2, 1).putVarint(3, 1).putVarint(7, 0xc792eccc))
    .putUtf8(16, installId)
    .putUtf8(20, "none")
    .putVarint(21, 738)
    .putProtobuf(23, new ProtoBuf().putUtf8(1, "NX551J").putVarint(2, 8196).putVarint(4, 0x80e0d800))
    .putVarint(25, 2);
  const protobuf = pad16(bean.toBuf());
  const key = Array.from({ length: 4 }, (_, i) => readU64LE(SIGN_KEY, i * 8));
  const blocks: Buffer[] = [];
  for (let at = 0; at < protobuf.length; at += 16) {
    const encrypted = simonEncrypt(readU64LE(protobuf, at), readU64LE(protobuf, at + 8), key);
    blocks.push(le64(encrypted[0]), le64(encrypted[1]));
  }
  const framed = Buffer.concat([MAGIC8, ...blocks, TAIL9]);
  for (let i = 8; i < framed.length; i++) framed[i] ^= MAGIC8[i % 8];
  const padded = pad16(Buffer.concat([framed.reverse(), Buffer.from("ao", "ascii")]));
  const encrypted = Buffer.from(NativeCrypto.aes128CbcEncrypt(AES_KEY, AES_IV, padded, false));
  return Buffer.concat([Buffer.from("f281", "hex"), encrypted]).toString("base64");
}

function ladonEncrypt(ts: bigint, licenseId: bigint, aid: bigint, rand: Buffer): string {
  const aidText = aid.toString();
  const digest = createHash("md5").update(Buffer.concat([rand, Buffer.from(aidText)])).digest("hex");
  const ascii = Buffer.from(digest, "ascii");
  const words = Array.from({ length: 4 }, (_, i) => readU64LE(ascii, i * 8));
  const table: bigint[] = [words[0]];
  const queue = words.slice(2);
  let b0 = words[0];
  let b8 = words[1];
  for (let i = 0; i < 34; i++) {
    let x8 = u64(ror64(b8, 8) + b0) ^ BigInt(i);
    queue.push(x8);
    x8 ^= rol64(b0, 3);
    table.push(u64(x8));
    b0 = u64(x8);
    b8 = queue.shift() ?? 0n;
  }
  const input = pad16(Buffer.from(`${ts}-${licenseId}-${aidText}`, "ascii"));
  const out = Buffer.alloc(input.length);
  for (let at = 0; at < input.length; at += 16) {
    let a = readU64LE(input, at);
    let b = readU64LE(input, at + 8);
    for (let i = 0; i < 34; i++) {
      b = table[i] ^ u64(a + ror64(b, 8));
      a = b ^ rol64(a, 3);
    }
    writeU64LE(out, a, at);
    writeU64LE(out, b, at + 8);
  }
  return Buffer.concat([rand, out]).toString("base64");
}

export function signPlayer(input: {
  query: string;
  body?: Buffer | null;
  ts: number | bigint;
  randField?: number;
  ladonRandom?: Buffer;
}): Record<string, string> {
  const { query, body = null, ts } = input;
  const aidValue = queryParam(query, "aid");
  let aid = 1967n;
  if (/^[+-]?\d+$/.test(aidValue || "")) {
    const candidate = BigInt(aidValue as string);
    if (candidate >= -(1n << 63n) && candidate < 1n << 63n) aid = candidate;
  }
  const timestamp = integer(ts);
  const stub = body?.length ? createHash("md5").update(body).digest("hex") : "";
  const randField = input.randField ?? randomBytes(4).readInt32LE();
  const ladonRandom = input.ladonRandom ?? randomBytes(4);
  const headers: Record<string, string> = {
    "x-ss-req-ticket": String(timestamp * 1000n),
    "x-khronos": String(timestamp),
    "x-ladon": ladonEncrypt(timestamp, LICENSE_ID, aid, ladonRandom),
    "x-argus": argusSign(query, stub, timestamp, aid, LICENSE_ID, queryParam(query, "device_id") || "", "", randField),
  };
  if (stub) headers["x-ss-stub"] = stub;
  return headers;
}
