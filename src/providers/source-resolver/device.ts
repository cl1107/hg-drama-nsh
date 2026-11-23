import { Buffer } from "buffer";
import { createHash, randomBytes, randomUUID } from "crypto";
import { gzipSync } from "zlib";
import { NativeCrypto } from "hg-drama/native";
import {
  type DeviceIdentity,
  type UpstreamTransport,
  SourceResolverError,
  isAbortError,
  throwIfAborted,
} from "./types";

const REGISTER_URL =
  "https://log5-applog-lf.fqnovel.com/service/2/device_register/?tt_data=a&cronet_version=8d40f833_2026-03-03&ttnet_version=4.2.243.31-douyin&use_store_region_cookie=1";
const KDF_SALT = Buffer.from(
  "4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58",
  "hex",
);

let cachedRegistration: Promise<DeviceIdentity> | undefined;
let retryAfter = 0;
let registrationRetryAfter = 0;

function responseId(response: Record<string, unknown>, name: string): string {
  const preferred = response[`${name}_str`];
  const value = preferred === undefined || preferred === null || preferred === "" ? response[name] : preferred;
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : "";
  return typeof value === "string" && /^\d{1,30}$/.test(value) && /[1-9]/.test(value) ? value : "";
}

export function clearCachedDevice(): void {
  cachedRegistration = undefined;
  retryAfter = 0;
  registrationRetryAfter = 0;
}

export async function registerPlaybackDevice(
  transport: UpstreamTransport,
  signal?: AbortSignal,
): Promise<DeviceIdentity> {
  throwIfAborted(signal);
  if (Date.now() < registrationRetryAfter) {
    throw new SourceResolverError("DEVICE_REGISTRATION_FAILED", "匿名播放设备注册失败，请检查网络，10 秒后重试");
  }
  try {
    const now = Date.now();
    const cdid = randomUUID();
    const header = {
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
      openudid: randomBytes(8).toString("hex"),
      clientudid: randomUUID(),
      ipv6_list: [],
      region: "CN",
      tz_name: "Asia/Shanghai",
      tz_offset: 28800,
      sim_region: "cn",
      sim_serial_number: [],
      oaid_may_support: false,
      req_id: randomUUID(),
      device_platform: "android",
      custom: {
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
    };
    const compressed = gzipSync(Buffer.from(JSON.stringify({ magic_tag: "ss_app_log", header, _gen_time: now })));
    const random = randomBytes(32);
    const derived = createHash("sha512")
      .update(Buffer.concat([createHash("sha512").update(random).digest(), KDF_SALT]))
      .digest();
    const plaintext = Buffer.concat([createHash("sha512").update(compressed).digest(), compressed]);
    const encrypted = Buffer.from(
      NativeCrypto.aes128CbcEncrypt(derived.subarray(0, 16), derived.subarray(16, 32), plaintext, true),
    );
    const data = Buffer.concat([Buffer.from("746305100000", "hex"), random, encrypted]);
    const response = await transport(
      {
        method: "POST",
        url: REGISTER_URL,
        headers: {
          "User-Agent": "com.phoenix.read/72232 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3)",
          Accept: "application/json",
          "Content-Type": "application/octet-stream;tt-data=a",
          "log-encode-type": "gzip",
          "x-ss-dp": "8662",
          "x-ss-req-ticket": String(now),
          "x-vc-bdturing-sdk-version": "4.0.3.cn",
          lc: "101",
          "sdk-version": "2",
          "passport-sdk-version": "5051452",
          "x-neptune": "-8|50:51:59:30:40:47:49:39",
          "x-ss-stub": createHash("md5").update(data).digest("hex").toUpperCase(),
        },
        body: data,
        timeoutMs: 8000,
      },
      signal,
    );
    throwIfAborted(signal);
    if (response.status !== 200) {
      throw new SourceResolverError(
        "DEVICE_REGISTRATION_FAILED",
        `匿名播放设备注册失败（HTTP ${response.status}）`,
        { status: response.status },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(response.body).toString("utf8"));
    } catch {
      throw new SourceResolverError("INVALID_RESPONSE", "设备注册响应不是有效 JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SourceResolverError("INVALID_RESPONSE", "设备注册响应格式无效");
    }
    const record = parsed as Record<string, unknown>;
    if (Number(record.code ?? record.Code ?? 0) !== 0) {
      throw new SourceResolverError("BUSINESS_REJECTED", "设备注册被上游拒绝");
    }
    const device_id = responseId(record, "device_id");
    const iid = responseId(record, "install_id");
    if (!device_id || !iid) {
      throw new SourceResolverError("INVALID_RESPONSE", "设备注册响应缺少设备编号");
    }
    registrationRetryAfter = 0;
    return Object.freeze({ device_id, iid, cdid });
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      throw new SourceResolverError("ERR_CANCELED", "已取消");
    }
    registrationRetryAfter = Date.now() + 10000;
    if (error instanceof SourceResolverError) throw error;
    throw new SourceResolverError("DEVICE_REGISTRATION_FAILED", "匿名播放设备注册失败，请检查网络，10 秒后重试");
  }
}

export function getPlaybackDevice(transport: UpstreamTransport): Promise<DeviceIdentity> {
  if (retryAfter && Date.now() >= retryAfter) {
    cachedRegistration = undefined;
    retryAfter = 0;
  }
  cachedRegistration ??= Promise.resolve()
    .then(() => registerPlaybackDevice(transport))
    .catch((error) => {
      if (isAbortError(error)) {
        cachedRegistration = undefined;
      } else {
        retryAfter = Date.now() + 10000;
      }
      throw error;
    });
  return cachedRegistration;
}
