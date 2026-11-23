import { Buffer } from "buffer";
import { createHash } from "crypto";
import { gzipSync } from "zlib";
import { NativeCrypto } from "hg-drama/native";
import { servicePost } from "../../service-client";
import { getPlaybackDevice, registerPlaybackDevice } from "./device";
import { signPlayer } from "./signature";
import { signPlaybackV5 } from "./v5";
import {
  type DeviceIdentity,
  type ResolvedVariant,
  type UpstreamFetchRequest,
  type UpstreamFetchResponse,
  type UpstreamTransport,
  SourceResolverError,
  isAbortError,
  throwIfAborted,
} from "./types";

export { clearCachedDevice } from "./device";
export {
  type DeviceIdentity,
  type ResolvedVariant,
  type UpstreamFetchRequest,
  type UpstreamFetchResponse,
  type UpstreamTransport,
  SourceResolverError,
} from "./types";

const PRELOAD_HOSTS = [
  "reading.snssdk.com",
  "api5-normal-sinfonlineb.fqnovel.com",
  "api5-normal-sinfonlinea.fqnovel.com",
];

const PLAYER_HOSTS = [
  "api5-normal-sinfonlineb.fqnovel.com",
  "api5-normal-sinfonlinea.fqnovel.com",
  "api5-normal-sinfonlinec.fqnovel.com",
  "api5-normal.fqnovel.com",
  "api3-normal.fqnovel.com",
];

const VIDEO_UA =
  "com.phoenix.read/71332 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)";
const PLAYBACK_UA =
  "com.phoenix.read/74332 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)";
const PRELOAD_UA = "okhttp/4.12.0";
const URL_KDF_SALT = Buffer.from(
  "4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58",
  "hex",
);

const LEGACY_DEVICE_BASE: Record<string, string> = {
  aid: "8662",
  app_name: "novelread",
  version_code: "71332",
  version_name: "7.1.3.32",
  manifest_version_code: "71332",
  update_version_code: "71332",
  pv_player: "71332",
  channel: "update_64",
  device_platform: "android",
  device_type: "25053RT47C",
  device_brand: "Redmi",
  os: "android",
  os_api: "36",
  os_version: "16",
  resolution: "1280*2772",
  dpi: "520",
  language: "zh",
  ac: "wifi",
  ssmix: "a",
};

type PlayMode = "preload" | "tab" | "v5" | "v1";
let preferredPlayMode: "preload" | "tab" | "v5" = "preload";

export const defaultUpstreamTransport: UpstreamTransport = async (
  request: UpstreamFetchRequest,
  signal?: AbortSignal,
): Promise<UpstreamFetchResponse> => {
  const payload = await servicePost<{
    status: number;
    headers: Record<string, string>;
    bodyBase64: string;
  }>(
    "/upstream/fetch",
    {
      method: request.method,
      url: request.url,
      headers: request.headers,
      ...(request.body && request.body.length > 0
        ? { bodyBase64: Buffer.from(request.body).toString("base64") }
        : {}),
      ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
    },
    signal,
  );
  return {
    status: payload.status,
    headers: payload.headers || {},
    body: Buffer.from(payload.bodyBase64 || "", "base64"),
  };
};

function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function encodeQuery(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function buildPreloadPlayRequest(
  identity: DeviceIdentity,
  episodeId: string,
  host: string,
): UpstreamFetchRequest {
  const preloadPayload = JSON.stringify({
    biz_param: {
      detail_page_version: 0,
      device_level: 2,
      disable_digg_stat: false,
      disable_video_relate_book: false,
      need_all_video_definition: true,
      need_mp4_align: false,
      use_os_player: false,
      use_server_dns: false,
      video_platform: 1024,
    },
    mixed_video_id_map: { "1004": [episodeId] },
    dr_scene: "preload",
  });
  const body = gzipSync(Buffer.from(preloadPayload, "utf8"));
  const now = Date.now();
  const signed = signPlaybackV5({
    base: `https://${host}/novel/player/multi_video_model/preload/v1`,
    values: {
      aid: "8662",
      app_name: "novelread",
      version_code: "74532",
      version_name: "7.4.5.32",
      update_version_code: "74532",
      manifest_version_code: "74532",
      os: "android",
      ssmix: "a",
      channel: "update_64",
      device_platform: "android",
      device_type: "25053RT47C",
      device_brand: "Redmi",
      os_version: "16",
      os_api: "36",
      ac: "wifi",
      language: "zh",
      host_abi: "arm64-v8a",
      iid: identity.iid,
      cdid: identity.cdid,
      device_id: identity.device_id,
    },
    body,
    now,
  });
  return {
    method: "POST",
    url: signed.url,
    headers: {
      ...signed.headers,
      "User-Agent": PRELOAD_UA,
      Accept: "application/json",
      "Content-Type": "application/json; charset=UTF-8",
      "Content-Encoding": "gzip",
    },
    body,
  };
}

function buildVideoTabRequest(identity: DeviceIdentity, videoId: string, host: string): UpstreamFetchRequest {
  const signed = signPlaybackV5({
    base: `https://${host}/reading/bookapi/video_tab/multi_video_model/v1/`,
    values: {
      aid: "8662",
      app_name: "novelread",
      version_code: "74332",
      version_name: "7.4.3.32",
      channel: "vivo_8662_64",
      device_platform: "android",
      device_type: "PGT-AN10",
      os_version: "12",
      update_version_code: "74332",
      iid: identity.iid,
      cdid: identity.cdid,
      device_id: identity.device_id,
      video_id: videoId,
      video_id_type: "0",
      device_level: "1",
      need_all_video_definition: "1",
      need_mp4_align: "0",
      use_os_player: "0",
      video_platform: "1024",
      source: "0",
      from_video_id: "",
    },
    body: null,
    allowEmptyBody: true,
    now: Date.now(),
  });
  return {
    method: "GET",
    url: signed.url,
    headers: {
      ...signed.headers,
      "User-Agent": VIDEO_UA.replace("71332", "73932"),
      Accept: "application/json",
    },
    body: null,
  };
}

function buildV5PlayRequest(
  identity: DeviceIdentity,
  videoId: string,
  payload: string,
  host: string,
): UpstreamFetchRequest {
  const body = gzipSync(Buffer.from(payload, "utf8"));
  const now = Date.now();
  const signed = signPlaybackV5({
    base: `https://${host}/novel/player/multi_video_model/player/v1`,
    values: {
      aid: "8662",
      app_name: "novelread",
      version_code: "74332",
      version_name: "7.4.3.32",
      channel: "vivo_8662_64",
      device_platform: "android",
      device_type: "PGT-AN10",
      os_version: "12",
      update_version_code: "74332",
      iid: identity.iid,
      cdid: identity.cdid,
      device_id: identity.device_id,
      ts: String(Math.floor(now / 1000)),
      video_id: videoId,
    },
    body,
    now,
  });
  return {
    method: "POST",
    url: signed.url,
    headers: {
      ...signed.headers,
      "User-Agent": PLAYBACK_UA,
      Accept: "application/json",
      "Content-Type": "application/json; charset=UTF-8",
      "Content-Encoding": "gzip",
      "x-ss-dp": "8662",
      "sdk-version": "2",
      "passport-sdk-version": "5051452",
      "x-tt-dt": "",
      "x-tt-store-region": "cn",
      "x-tt-store-region-src": "did",
    },
    body,
  };
}

function buildLegacyPlayRequest(
  identity: DeviceIdentity,
  payload: string,
  host: string,
): UpstreamFetchRequest {
  const body = gzipSync(Buffer.from(payload, "utf8"));
  const ts = Math.floor(Date.now() / 1000);
  const query = encodeQuery({
    ...LEGACY_DEVICE_BASE,
    iid: identity.iid,
    device_id: identity.device_id,
    cdid: identity.cdid,
    ts: String(ts),
    _rticket: String(Date.now()),
  });
  const signature = signPlayer({ query, body, ts });
  return {
    method: "POST",
    url: `https://${host}/novel/player/multi_video_model/v1/?${query}`,
    headers: {
      "User-Agent": VIDEO_UA,
      Accept: "application/json",
      "Content-Type": "application/json; charset=UTF-8",
      "Content-Encoding": "gzip",
      "sdk-version": "2",
      "passport-sdk-version": "5051452",
      "x-ss-dp": "8662",
      "x-tt-dt": "",
      "x-tt-store-region": "cn",
      "x-tt-store-region-src": "did",
      ...signature,
    },
    body,
  };
}

export function deriveContentKeyHex(spadeA: string): string {
  const raw = Buffer.from(spadeA.trim().replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (raw.length < 3) throw new SourceResolverError("INVALID_RESPONSE", "spade_a 长度无效");
  let v8 = raw.length - (raw[0] ^ raw[1] ^ raw[2]) + 47;
  v8 = Math.min(v8, raw.length - 1);
  if (v8 < 33) throw new SourceResolverError("INVALID_RESPONSE", "spade_a 密钥长度无效");
  const work = Buffer.from(raw.subarray(1, 1 + v8));
  let a = 85;
  let b = 246;
  for (let i = 0; i < v8; i += 1) {
    const old = work[i];
    const previous = i & 1 ? a : b;
    if (i & 1) a = old;
    else b = old;
    let pop = 0;
    let n = i;
    while (n > 0) {
      pop += n & 1;
      n >>>= 1;
    }
    work[i] = (-21 - pop + (previous ^ old)) & 255;
  }
  const hex = work.subarray(1, 33).toString("ascii").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new SourceResolverError("INVALID_RESPONSE", "App 视频密钥格式无效");
  }
  return hex;
}

export function decryptSpadeUrl(encoded: string, seed: string): string {
  const value = encoded.trim();
  if (!value) return "";
  const raw = Buffer.from(value, "base64");
  if (raw.length < 5) throw new SourceResolverError("INVALID_RESPONSE", "片源地址密文过短");
  if (raw[0] !== 0xa8 || raw[2] !== 0x01 || raw[3] !== 0x00) {
    throw new SourceResolverError("INVALID_RESPONSE", "片源地址密文头无效");
  }
  const cipherLength = Math.floor((raw.length - 4) / 16) * 16;
  if (!cipherLength) throw new SourceResolverError("INVALID_RESPONSE", "片源地址密文缺少完整块");
  const h1 = createHash("sha512").update(seed).digest();
  const h2 = createHash("sha512").update(Buffer.concat([h1, URL_KDF_SALT])).digest();
  let plaintext = Buffer.from(
    NativeCrypto.aes128CbcDecrypt(
      h2.subarray(0, 16),
      h2.subarray(16, 32),
      raw.subarray(4, 4 + cipherLength),
      false,
    ),
  );
  if (plaintext.length) {
    const padding = plaintext[plaintext.length - 1];
    if (padding >= 1 && padding <= 16 && padding <= plaintext.length) {
      plaintext = plaintext.subarray(0, plaintext.length - padding);
    }
  }
  while (plaintext.length && plaintext[plaintext.length - 1] === 0) {
    plaintext = plaintext.subarray(0, plaintext.length - 1);
  }
  return plaintext.toString("utf8");
}

function decodeCandidateUrl(candidate: string, keySeed: string): string {
  if (keySeed) {
    return decryptSpadeUrl(candidate, keySeed);
  }
  if (/^https:\/\//i.test(candidate)) return candidate;
  const decoded = Buffer.from(candidate, "base64").toString("utf8").trim();
  if (/^https:\/\//i.test(decoded)) return decoded;
  throw new SourceResolverError("INVALID_RESPONSE", "片源地址解码失败");
}

function normalizeQualityLabel(raw: string, pixels: number): string {
  const lower = raw.toLowerCase();
  if (lower.includes("1080") || pixels >= 1080) return "1080p";
  if (lower.includes("720") || pixels >= 720) return "720p";
  if (lower.includes("540") || pixels >= 540) return "540p";
  if (lower.includes("480") || pixels >= 480) return "480p";
  if (lower.includes("360") || pixels >= 360) return "360p";
  return raw || "auto";
}

function minimumPixelsFor(quality: string): number {
  if (quality === "1080p") return 1080;
  if (quality === "720p") return 720;
  if (quality === "540p") return 540;
  if (quality === "480p") return 480;
  if (quality === "360p") return 360;
  return 0;
}

export function parsePlayModelVariants(
  info: Record<string, unknown>,
  requestedQuality = "auto",
  requireEncryptionMetadata = true,
): ResolvedVariant[] {
  const videoList = info.video_list;
  if (!videoList || typeof videoList !== "object") {
    throw new SourceResolverError("MISSING_MODEL", "App 接口未返回本集片源模型");
  }
  const keySeed = str(info.key_seed);
  const rawItems = Object.values(videoList as Record<string, unknown>).filter(
    (item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)),
  );

  interface CandidateRow {
    item: Record<string, unknown>;
    codec: "h264" | "hevc";
    codecRank: number;
    quality: string;
    pixels: number;
  }

  const compatible: CandidateRow[] = [];
  let sawBytevc2 = false;
  for (const item of rawItems) {
    const meta = (item.video_meta && typeof item.video_meta === "object"
      ? item.video_meta
      : {}) as Record<string, unknown>;
    const rawCodec = str(item.codec_type || meta.codec_type).toLowerCase();
    let codec: "h264" | "hevc" | null = null;
    let codecRank = 9;
    if (["h264", "avc", "avc1"].includes(rawCodec)) {
      codec = "h264";
      codecRank = 0;
    } else if (["hevc", "h265", "hvc1", "hev1", "bytevc1"].includes(rawCodec)) {
      codec = "hevc";
      codecRank = 1;
    } else if (rawCodec === "bytevc2") {
      sawBytevc2 = true;
    }
    if (!codec) continue;
    const dims = [
      [item.vwidth, item.vheight],
      [item.width, item.height],
      [meta.vwidth, meta.vheight],
      [meta.width, meta.height],
    ]
      .map(([w, h]) => [Number(w), Number(h)])
      .find(([w, h]) => Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) ?? [0, 0];
    const qualityRaw = str(item.quality_desc || item.definition || meta.definition || item.height || item.vheight);
    const pixels = dims[0] && dims[1] ? Math.min(dims[0], dims[1]) : Number(qualityRaw.match(/\d+/)?.[0] || 0);
    const quality = normalizeQualityLabel(qualityRaw, pixels);
    compatible.push({ item, codec, codecRank, quality, pixels });
  }

  const minPx = minimumPixelsFor(requestedQuality);
  const filtered = compatible
    .filter((row) => requestedQuality === "auto" || row.quality === requestedQuality || (minPx > 0 && row.pixels >= minPx))
    .sort((a, b) => a.codecRank - b.codecRank || b.pixels - a.pixels);

  if (!filtered.length) {
    throw new SourceResolverError(
      compatible.length > 0 && requestedQuality !== "auto" ? "QUALITY_UNAVAILABLE" : "NO_COMPATIBLE_SOURCE",
      sawBytevc2
        ? "本集仅提供播放器不支持的 ByteVC2 编码，当前无法播放或下载"
        : "本集没有兼容 H.264/HEVC 片源",
    );
  }

  const bestPixels = filtered[0].pixels;
  const selectedRows =
    requestedQuality === "auto"
      ? bestPixels > 0
        ? filtered.filter((row) => row.pixels === bestPixels)
        : filtered.slice(0, 1)
      : filtered;

  const variants: ResolvedVariant[] = [];
  const seen = new Set<string>();
  let lastError: SourceResolverError | undefined;

  for (const row of selectedRows) {
    try {
      const encInfo = (row.item.encrypt_info && typeof row.item.encrypt_info === "object"
        ? row.item.encrypt_info
        : {}) as Record<string, unknown>;
      const spade = str(row.item.spade_a || encInfo.spade_a);
      const encryptFlag = encInfo.encrypt ?? row.item.encrypt;
      if (requireEncryptionMetadata && !spade && ![false, 0, "0", "false"].includes(encryptFlag as string | number | boolean)) {
        throw new SourceResolverError("INVALID_RESPONSE", "本集片源缺少有效解密信息", {
          incompleteEncryptionMetadata: encryptFlag == null,
          minimumPixels: row.pixels,
        });
      }
      const contentKey = spade ? deriveContentKeyHex(spade) : undefined;
      const urls = [
        row.item.main_url,
        row.item.backup_url,
        ...(Array.isArray(row.item.backup_url_list) ? row.item.backup_url_list : []),
      ].filter((u): u is string => typeof u === "string" && u.length > 0);

      for (const candidate of urls) {
        try {
          const decodedUrl = decodeCandidateUrl(candidate, keySeed);
          const parsedUrl = new URL(decodedUrl);
          if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password) continue;
          if (seen.has(parsedUrl.href)) continue;
          seen.add(parsedUrl.href);
          variants.push({
            url: parsedUrl.href,
            codec: row.codec,
            quality: row.quality,
            userAgent: VIDEO_UA,
            ...(contentKey ? { contentKey } : {}),
          });
        } catch (err) {
          lastError = err instanceof SourceResolverError ? err : new SourceResolverError("INVALID_RESPONSE", "片源地址解析失败");
        }
      }
    } catch (err) {
      lastError = err instanceof SourceResolverError ? err : new SourceResolverError("INVALID_RESPONSE", "片源解析失败");
    }
  }

  if (!variants.length) {
    throw lastError ?? new SourceResolverError("NO_COMPATIBLE_SOURCE", "本集没有兼容 H.264/HEVC 片源");
  }
  return variants;
}

function extractVideoModel(response: Record<string, unknown>, vid: string): Record<string, unknown> {
  const code = Number(response.Code ?? response.code ?? 0);
  if (code !== 0) {
    throw new SourceResolverError("BUSINESS_REJECTED", "App 接口暂未提供本集播放信息");
  }
  const data = response.data && typeof response.data === "object" ? (response.data as Record<string, unknown>) : undefined;
  const entries = (data?.["1004"] ?? data?.video_model_data ?? data ?? response) as Record<string, unknown>;
  const entry = entries?.[vid] as Record<string, unknown> | undefined;
  if (!entry || typeof entry !== "object") {
    throw new SourceResolverError("MISSING_MODEL", "App 接口未返回所选分集");
  }
  const rawModel = entry.video_model ?? entry;
  if (typeof rawModel === "string") {
    try {
      const parsed = JSON.parse(rawModel) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      throw new SourceResolverError("INVALID_RESPONSE", "App 片源模型 JSON 无效");
    }
  }
  if (rawModel && typeof rawModel === "object" && !Array.isArray(rawModel)) {
    return rawModel as Record<string, unknown>;
  }
  throw new SourceResolverError("INVALID_RESPONSE", "App 接口片源模型格式异常");
}

async function requestJson(
  transport: UpstreamTransport,
  request: UpstreamFetchRequest,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await transport(request, signal);
  throwIfAborted(signal);
  if (response.status !== 200) {
    throw new SourceResolverError("UPSTREAM_HTTP", `App 播放请求失败（HTTP ${response.status}）`, {
      status: response.status,
    });
  }
  const text = Buffer.from(response.body).toString("utf8").trim();
  if (!text) {
    throw new SourceResolverError("EMPTY_RESPONSE", "App 接口返回空响应", { status: 200 });
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SourceResolverError("INVALID_RESPONSE", "App 播放响应不是有效 JSON");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SourceResolverError) throw err;
    throw new SourceResolverError("INVALID_RESPONSE", "App 播放响应不是有效 JSON");
  }
}

async function raceRoutes(
  routes: Array<[PlayMode, string]>,
  callApi: (mode: PlayMode, host: string, subSignal: AbortSignal) => Promise<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  throwIfAborted(signal);
  const controllers = routes.map(() => new AbortController());
  const abortAll = () => {
    for (const c of controllers) {
      if (!c.signal.aborted) c.abort();
    }
  };
  const onParentAbort = () => abortAll();
  signal?.addEventListener("abort", onParentAbort, { once: true });
  let nonEmptyError: unknown = null;
  try {
    return await new Promise<Record<string, unknown> | null>((resolve, reject) => {
      let remaining = routes.length;
      let settled = false;
      if (remaining === 0) {
        resolve(null);
        return;
      }
      routes.forEach(([mode, host], idx) => {
        callApi(mode, host, controllers[idx].signal).then(
          (res) => {
            if (settled) return;
            settled = true;
            abortAll();
            if (mode === "preload" || mode === "tab" || mode === "v5") preferredPlayMode = mode;
            resolve(res);
          },
          (err) => {
            if (settled) return;
            if (signal?.aborted) {
              settled = true;
              abortAll();
              reject(new SourceResolverError("ERR_CANCELED", "已取消"));
              return;
            }
            if (!isAbortError(err)) {
              const code = err instanceof SourceResolverError ? err.code : undefined;
              if (code !== "EMPTY_RESPONSE" && !nonEmptyError) nonEmptyError = err;
            }
            remaining -= 1;
            if (remaining === 0) {
              settled = true;
              if (nonEmptyError) reject(nonEmptyError);
              else resolve(null);
            }
          },
        );
      });
    });
  } finally {
    signal?.removeEventListener("abort", onParentAbort);
    abortAll();
  }
}

function parseFallbackApiUrl(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as { fallback_api?: unknown };
        return typeof parsed?.fallback_api === "string" ? parsed.fallback_api.trim() : "";
      } catch {
        return "";
      }
    }
    return trimmed;
  }
  if (Array.isArray(value)) return str(value[0]);
  if (value && typeof value === "object") {
    return str((value as Record<string, unknown>).fallback_api);
  }
  return "";
}

async function resolveFallbackCodecVariants(
  model: Record<string, unknown>,
  quality: string,
  transport: UpstreamTransport,
  signal?: AbortSignal,
): Promise<ResolvedVariant[] | null> {
  const rawFallback = parseFallbackApiUrl(model.fallback_api);
  if (!rawFallback) return null;
  let parsedBase: URL;
  try {
    parsedBase = new URL(rawFallback);
  } catch {
    return null;
  }
  if (parsedBase.protocol !== "https:" || parsedBase.username || parsedBase.password) return null;

  for (const codecType of ["1", "3"]) {
    throwIfAborted(signal);
    const url = new URL(parsedBase.href);
    url.searchParams.set("codec_type", codecType);
    try {
      const outer = await requestJson(
        transport,
        {
          method: "GET",
          url: url.href,
          headers: { Accept: "application/json", "User-Agent": VIDEO_UA },
          body: null,
        },
        signal,
      );
      const videoInfo =
        outer.video_info && typeof outer.video_info === "object"
          ? (outer.video_info as Record<string, unknown>)
          : undefined;
      const data =
        videoInfo?.data && typeof videoInfo.data === "object"
          ? (videoInfo.data as Record<string, unknown>)
          : undefined;
      if (!data) continue;
      const variants = parsePlayModelVariants(data, quality, false);
      if (variants.length > 0) return variants;
    } catch (err) {
      if (isAbortError(err)) throw err;
    }
  }
  return null;
}

export async function resolveEpisodeVariants(
  episodeId: string,
  quality = "auto",
  options?: { signal?: AbortSignal; transport?: UpstreamTransport },
): Promise<ResolvedVariant[]> {
  const signal = options?.signal;
  const transport = options?.transport ?? defaultUpstreamTransport;
  throwIfAborted(signal);
  if (!/^\d{1,30}$/.test(episodeId)) {
    throw new SourceResolverError("INVALID_REQUEST", "分集编号无效");
  }

  const payload = JSON.stringify({
    biz_param: {
      detail_page_version: 0,
      device_level: 2,
      disable_digg_stat: false,
      disable_video_relate_book: false,
      need_all_video_definition: true,
      need_mp4_align: false,
      use_os_player: false,
      use_server_dns: false,
      video_platform: 1024,
    },
    mixed_video_id_map: { "1004": [episodeId] },
    dr_scene: "player",
  });

  let identity = await getPlaybackDevice(transport);
  throwIfAborted(signal);

  const callApi = async (mode: PlayMode, host: string, subSignal: AbortSignal) => {
    const req =
      mode === "preload"
        ? buildPreloadPlayRequest(identity, episodeId, host)
        : mode === "tab"
          ? buildVideoTabRequest(identity, episodeId, host)
          : mode === "v5"
            ? buildV5PlayRequest(identity, episodeId, payload, host)
            : buildLegacyPlayRequest(identity, payload, host);
    return requestJson(transport, req, subSignal);
  };

  const primaryRoutes: Array<[PlayMode, string]> =
    preferredPlayMode === "preload"
      ? [
          ["preload", PRELOAD_HOSTS[0]],
          ["tab", PLAYER_HOSTS[0]],
        ]
      : [
          [preferredPlayMode, PLAYER_HOSTS[0]],
          ["preload", PRELOAD_HOSTS[0]],
        ];

  let response = await raceRoutes(primaryRoutes, callApi, signal);

  if (!response) {
    response = await raceRoutes(
      [
        ["preload", PRELOAD_HOSTS[1]],
        ["v5", PLAYER_HOSTS[0]],
        ["tab", PLAYER_HOSTS[1]],
      ],
      callApi,
      signal,
    );
  }

  if (!response) {
    try {
      identity = await registerPlaybackDevice(transport, signal);
    } catch (err) {
      if (isAbortError(err)) throw err;
    }
    response = await raceRoutes(
      [
        ["preload", PRELOAD_HOSTS[0]],
        ["tab", PLAYER_HOSTS[0]],
        ["v5", PLAYER_HOSTS[0]],
      ],
      callApi,
      signal,
    );
  }

  if (!response) {
    try {
      response = await callApi("v1", PLAYER_HOSTS[0], signal ?? new AbortController().signal);
    } catch (err) {
      if (isAbortError(err)) throw err;
      if (!(err instanceof SourceResolverError && err.code === "EMPTY_RESPONSE")) throw err;
    }
  }

  if (!response) {
    throw new SourceResolverError("EMPTY_RESPONSE", "App 接口返回空响应", { status: 200 });
  }

  const model = extractVideoModel(response, episodeId);
  try {
    return parsePlayModelVariants(model, quality, true);
  } catch (err) {
    if (
      err instanceof SourceResolverError &&
      (err.code === "NO_COMPATIBLE_SOURCE" || err.code === "MISSING_MODEL" || err.incompleteEncryptionMetadata)
    ) {
      const negotiated = await resolveFallbackCodecVariants(model, quality, transport, signal);
      if (negotiated && negotiated.length > 0) return negotiated;
    }
    throw err;
  }
}
