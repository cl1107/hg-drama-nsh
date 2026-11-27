import { Buffer } from "buffer";
import { createHash } from "crypto";
import { gzipSync } from "zlib";
import { Storage, signal } from "nsh";
import { NativeCrypto, NativeVideo } from "hg-drama/native";
import { servicePost } from "../../service-client";
import { clearCachedDevice, getPlaybackDevice, registerPlaybackDevice } from "./device";
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

const VIDEO_UA =
  "com.phoenix.read/71332 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)";
const PLAYBACK_UA =
  "com.phoenix.read/74332 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)";
const COMPAT_UA =
  "com.phoenix.read/73932 (Linux; U; Android 12; zh_CN_#Hans; PGT-AN10; Build/V417IR;tt-ok/3.12.13.20)";
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

export type PlayMode = "video_model" | "preload" | "tab" | "v5" | "v1";
export type ProfileId = "modern_745" | "compat_743" | "cronet_739";

export interface PlaybackStrategy {
  mode: PlayMode;
  host: string;
  profile: ProfileId;
  field21?: number;
}

export interface ResolverDiagnostics {
  activeStrategy: PlaybackStrategy;
  lastHealedAt: number;
  healCount: number;
  lastUsedMode: PlayMode;
  lastError: string;
}

const STRATEGY_STORAGE_KEY = "hg:resolver:strategy:v1";

const DEFAULT_STRATEGY: PlaybackStrategy = {
  mode: "video_model",
  host: "api5-normal-sinfonlinea.fqnovel.com",
  profile: "modern_745",
  field21: 312,
};

const VALID_MODES = new Set<PlayMode>(["video_model", "preload", "tab", "v5", "v1"]);
const VALID_PROFILES = new Set<ProfileId>(["modern_745", "compat_743", "cronet_739"]);
const ALLOWED_UPSTREAM_HOSTS = new Set<string>([
  "api5-normal-sinfonlinea.fqnovel.com",
  "api5-normal-sinfonlineb.fqnovel.com",
  "api5-normal-sinfonlinec.fqnovel.com",
  "reading.snssdk.com",
  "api5-normal-lf.fqnovel.com",
  "api5-normal.fqnovel.com",
  "api3-normal.fqnovel.com",
]);

const diagnosticsSignal = signal<ResolverDiagnostics>({
  activeStrategy: { ...DEFAULT_STRATEGY },
  lastHealedAt: 0,
  healCount: 0,
  lastUsedMode: DEFAULT_STRATEGY.mode,
  lastError: "",
});

let strategyLoadedFromStorage = false;
let strategyLoadPromise: Promise<void> | undefined;

export function resolverDiagnostics(): ResolverDiagnostics {
  return diagnosticsSignal();
}

export function strategyKey(strategy: PlaybackStrategy): string {
  return `${strategy.mode}@${strategy.host}|${strategy.profile}|${strategy.field21 ?? 0}`;
}

export function formatStrategyLabel(strategy: PlaybackStrategy): string {
  const modeName: Record<PlayMode, string> = {
    video_model: "video_model/v1",
    preload: "preload/v1",
    tab: "video_tab/v1",
    v5: "player/v1",
    v1: "legacy/v1",
  };
  const hostShort = strategy.host.replace(/\.fqnovel\.com$/, "");
  return strategy.field21
    ? `${modeName[strategy.mode]} · ${hostShort} · f${strategy.field21}`
    : `${modeName[strategy.mode]} · ${hostShort}`;
}

function isValidStrategy(value: unknown): value is PlaybackStrategy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.mode !== "string" || !VALID_MODES.has(row.mode as PlayMode)) return false;
  if (typeof row.host !== "string" || !ALLOWED_UPSTREAM_HOSTS.has(row.host)) return false;
  if (typeof row.profile !== "string" || !VALID_PROFILES.has(row.profile as ProfileId)) return false;
  if (row.field21 !== undefined && (!Number.isInteger(row.field21) || Number(row.field21) < 0 || Number(row.field21) > 0xffff)) {
    return false;
  }
  return true;
}

async function ensureStrategyLoaded(): Promise<void> {
  if (strategyLoadedFromStorage) return;
  strategyLoadPromise ??= (async () => {
    try {
      const raw = await Storage.getItem(STRATEGY_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          activeStrategy?: unknown;
          lastHealedAt?: unknown;
          healCount?: unknown;
        };
        if (isValidStrategy(parsed.activeStrategy)) {
          diagnosticsSignal.set({
            activeStrategy: parsed.activeStrategy,
            lastHealedAt: typeof parsed.lastHealedAt === "number" ? parsed.lastHealedAt : 0,
            healCount: typeof parsed.healCount === "number" ? parsed.healCount : 0,
            lastUsedMode: parsed.activeStrategy.mode,
            lastError: "",
          });
        }
      }
    } catch {
      // Storage may be unavailable in headless tests; keep defaults.
    } finally {
      strategyLoadedFromStorage = true;
    }
  })();
  await strategyLoadPromise;
}

function persistStrategy(next: ResolverDiagnostics): void {
  try {
    void Storage.setItem(
      STRATEGY_STORAGE_KEY,
      JSON.stringify({
        activeStrategy: next.activeStrategy,
        lastHealedAt: next.lastHealedAt,
        healCount: next.healCount,
      }),
    );
  } catch {
    // Ignore persistence failures in restricted environments.
  }
}

export function resetResolverStrategy(clearDevice = false): void {
  strategyLoadedFromStorage = true;
  if (clearDevice) clearCachedDevice();
  const next: ResolverDiagnostics = {
    activeStrategy: { ...DEFAULT_STRATEGY },
    lastHealedAt: 0,
    healCount: 0,
    lastUsedMode: DEFAULT_STRATEGY.mode,
    lastError: "",
  };
  diagnosticsSignal.set(next);
  persistStrategy(next);
}

function recordStrategySuccess(strategy: PlaybackStrategy, healed: boolean): void {
  const prev = diagnosticsSignal();
  const changed = strategyKey(prev.activeStrategy) !== strategyKey(strategy);
  const next: ResolverDiagnostics = {
    activeStrategy: { ...strategy },
    lastHealedAt: healed || changed ? Date.now() : prev.lastHealedAt,
    healCount: healed || changed ? prev.healCount + 1 : prev.healCount,
    lastUsedMode: strategy.mode,
    lastError: "",
  };
  diagnosticsSignal.set(next);
  if (changed || healed) {
    persistStrategy(next);
  }
}

function recordResolverFailure(message: string): void {
  const prev = diagnosticsSignal();
  diagnosticsSignal.set({ ...prev, lastError: message });
}

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

function profileParams(profile: ProfileId, identity: DeviceIdentity): {
  values: Record<string, string>;
  userAgent: string;
} {
  if (profile === "compat_743") {
    return {
      values: {
        aid: "8662",
        app_name: "novelread",
        version_code: "74332",
        version_name: "7.4.3.32",
        channel: "vivo_8662_64",
        device_platform: "android",
        device_type: "PGT-AN10",
        device_brand: "HONOR",
        os_version: "12",
        update_version_code: "74332",
        iid: identity.iid,
        cdid: identity.cdid,
        device_id: identity.device_id,
      },
      userAgent: COMPAT_UA,
    };
  }
  if (profile === "cronet_739") {
    return {
      values: {
        aid: "8662",
        app_name: "novelread",
        version_code: "74332",
        version_name: "7.4.3.32",
        channel: "vivo_8662_64",
        device_platform: "android",
        device_type: "PGT-AN10",
        device_brand: "HONOR",
        os_version: "12",
        update_version_code: "74332",
        iid: identity.iid,
        cdid: identity.cdid,
        device_id: identity.device_id,
      },
      userAgent: VIDEO_UA.replace("71332", "73932"),
    };
  }
  return {
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
    userAgent: PRELOAD_UA,
  };
}

function buildSingleVideoModelRequest(
  identity: DeviceIdentity,
  episodeId: string,
  strategy: PlaybackStrategy,
): UpstreamFetchRequest {
  const payload = JSON.stringify({
    biz_param: {
      detail_page_version: 0,
      device_level: 3,
      disable_digg_stat: false,
      from_video_id: "",
      need_all_video_definition: true,
      need_mp4_align: false,
      source: 9,
      use_os_player: false,
      use_server_dns: false,
      video_platform: 3,
    },
    content_type: 1004,
    video_id: episodeId,
  });
  const body = gzipSync(Buffer.from(payload, "utf8"));
  const { values, userAgent } = profileParams(strategy.profile, identity);
  const signed = signPlaybackV5({
    base: `https://${strategy.host}/novel/player/video_model/v1/`,
    values,
    body,
    now: Date.now(),
    field21: strategy.field21 ?? 312,
  });
  return {
    method: "POST",
    url: signed.url,
    headers: {
      ...signed.headers,
      "User-Agent": userAgent,
      Accept: "application/json",
      "Content-Type": "application/json; charset=UTF-8",
      "Content-Encoding": "gzip",
    },
    body,
  };
}

function buildPreloadPlayRequest(
  identity: DeviceIdentity,
  episodeId: string,
  strategy: PlaybackStrategy,
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
  const { values, userAgent } = profileParams(strategy.profile, identity);
  const signed = signPlaybackV5({
    base: `https://${strategy.host}/novel/player/multi_video_model/preload/v1`,
    values,
    body,
    now: Date.now(),
    field21: strategy.field21 ?? 312,
  });
  return {
    method: "POST",
    url: signed.url,
    headers: {
      ...signed.headers,
      "User-Agent": userAgent,
      Accept: "application/json",
      "Content-Type": "application/json; charset=UTF-8",
      "Content-Encoding": "gzip",
    },
    body,
  };
}

function buildVideoTabRequest(
  identity: DeviceIdentity,
  videoId: string,
  strategy: PlaybackStrategy,
): UpstreamFetchRequest {
  const { values, userAgent } = profileParams(strategy.profile, identity);
  const signed = signPlaybackV5({
    base: `https://${strategy.host}/reading/bookapi/video_tab/multi_video_model/v1/`,
    values: {
      ...values,
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
    field21: strategy.field21 ?? 312,
  });
  return {
    method: "GET",
    url: signed.url,
    headers: {
      ...signed.headers,
      "User-Agent": strategy.profile === "modern_745" ? VIDEO_UA.replace("71332", "73932") : userAgent,
      Accept: "application/json",
    },
    body: null,
  };
}

function buildV5PlayRequest(
  identity: DeviceIdentity,
  videoId: string,
  payload: string,
  strategy: PlaybackStrategy,
): UpstreamFetchRequest {
  const body = gzipSync(Buffer.from(payload, "utf8"));
  const now = Date.now();
  const { values, userAgent } = profileParams(strategy.profile, identity);
  const signed = signPlaybackV5({
    base: `https://${strategy.host}/novel/player/multi_video_model/player/v1`,
    values: {
      ...values,
      ts: String(Math.floor(now / 1000)),
      video_id: videoId,
    },
    body,
    now,
    field21: strategy.field21 ?? 312,
  });
  return {
    method: "POST",
    url: signed.url,
    headers: {
      ...signed.headers,
      "User-Agent": strategy.profile === "modern_745" ? PLAYBACK_UA : userAgent,
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

export function decryptSpadeUrl(encoded: string, seed: Uint8Array): string {
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

function decodeCandidateUrl(candidate: string, keySeed?: Uint8Array): string {
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
  bytevc2Available = NativeVideo.bytevc2Available(),
): ResolvedVariant[] {
  const videoList = info.video_list;
  if (!videoList || typeof videoList !== "object") {
    throw new SourceResolverError("MISSING_MODEL", "App 接口未返回本集片源模型");
  }
  const rawItems = Object.values(videoList as Record<string, unknown>).filter(
    (item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)),
  );

  interface CandidateRow {
    item: Record<string, unknown>;
    codec: ResolvedVariant["codec"];
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
    let codec: ResolvedVariant["codec"] | null = null;
    let codecRank = 9;
    if (["h264", "avc", "avc1"].includes(rawCodec)) {
      codec = "h264";
      codecRank = 0;
    } else if (["hevc", "h265", "hvc1", "hev1", "bytevc1"].includes(rawCodec)) {
      codec = "hevc";
      codecRank = 1;
    } else if (rawCodec === "bytevc2") {
      sawBytevc2 = true;
      if (bytevc2Available) {
        codec = "bytevc2";
        codecRank = -1;
      }
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

  const encodedSeed = str(info.key_seed);
  let keySeed: Uint8Array | undefined;
  if (encodedSeed) {
    try {
      keySeed = Buffer.from(encodedSeed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    } catch {
      throw new SourceResolverError("INVALID_RESPONSE", "片源地址密钥种子编码无效");
    }
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

function parseRawVideoModel(rawModel: unknown): Record<string, unknown> {
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

function extractVideoModel(response: Record<string, unknown>, vid: string, singleEpisodeEndpoint: boolean): Record<string, unknown> {
  const code = Number(response.Code ?? response.code ?? 0);
  if (code !== 0) {
    throw new SourceResolverError("BUSINESS_REJECTED", "App 接口暂未提供本集播放信息");
  }
  const data = response.data && typeof response.data === "object" && !Array.isArray(response.data)
    ? (response.data as Record<string, unknown>)
    : undefined;

  // 1. Multi-video bucket formats: data["1004"][vid], data.video_model_data[vid], data[vid], or any bucket holding [vid].
  const bucketCandidates: Array<Record<string, unknown> | undefined> = [
    data?.["1004"] as Record<string, unknown> | undefined,
    data?.video_model_data as Record<string, unknown> | undefined,
    data,
    response,
  ];
  if (data) {
    for (const value of Object.values(data)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        bucketCandidates.push(value as Record<string, unknown>);
      }
    }
  }
  for (const bucket of bucketCandidates) {
    if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) continue;
    const entry = bucket[vid];
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const row = entry as Record<string, unknown>;
      return parseRawVideoModel(row.video_model ?? row);
    }
  }

  // 2. Single-episode endpoint format (/novel/player/video_model/v1/): data.video_model or data.video_list.
  if (singleEpisodeEndpoint && data) {
    if (data.video_model !== undefined) {
      return parseRawVideoModel(data.video_model);
    }
    if (data.video_list !== undefined) {
      return data;
    }
  }

  throw new SourceResolverError("MISSING_MODEL", "App 接口未返回所选分集");
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
  bytevc2Available = NativeVideo.bytevc2Available(),
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
      const variants = parsePlayModelVariants(data, quality, false, bytevc2Available);
      if (variants.length > 0) return variants;
    } catch (err) {
      if (isAbortError(err)) throw err;
    }
  }
  return null;
}

interface StrategyWin {
  strategy: PlaybackStrategy;
  variants: ResolvedVariant[];
}

async function raceStrategies(
  strategies: PlaybackStrategy[],
  execute: (strategy: PlaybackStrategy, subSignal: AbortSignal) => Promise<ResolvedVariant[]>,
  signal?: AbortSignal,
): Promise<{ win: StrategyWin | null; lastError: unknown }> {
  throwIfAborted(signal);
  if (strategies.length === 0) return { win: null, lastError: null };

  const controllers = strategies.map(() => new AbortController());
  const abortAll = () => {
    for (const c of controllers) {
      if (!c.signal.aborted) c.abort();
    }
  };
  const onParentAbort = () => abortAll();
  signal?.addEventListener("abort", onParentAbort, { once: true });

  let lastError: unknown = null;
  let nonEmptyError: unknown = null;

  try {
    const win = await new Promise<StrategyWin | null>((resolve, reject) => {
      let remaining = strategies.length;
      let settled = false;

      strategies.forEach((strategy, idx) => {
        execute(strategy, controllers[idx].signal).then(
          (variants) => {
            if (settled) return;
            settled = true;
            abortAll();
            resolve({ strategy, variants });
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
              lastError = err;
              const code = err instanceof SourceResolverError ? err.code : undefined;
              if (code !== "EMPTY_RESPONSE" && !nonEmptyError) nonEmptyError = err;
            }
            remaining -= 1;
            if (remaining === 0) {
              settled = true;
              resolve(null);
            }
          },
        );
      });
    });
    return { win, lastError: nonEmptyError ?? lastError };
  } finally {
    signal?.removeEventListener("abort", onParentAbort);
    abortAll();
  }
}

function dedupeStrategies(list: PlaybackStrategy[], tried: Set<string>): PlaybackStrategy[] {
  const out: PlaybackStrategy[] = [];
  for (const item of list) {
    const key = strategyKey(item);
    if (tried.has(key)) continue;
    tried.add(key);
    out.push(item);
  }
  return out;
}

function buildStrategyWaves(active: PlaybackStrategy): {
  fastWave: PlaybackStrategy[];
  healWaves: PlaybackStrategy[][];
  freshDeviceWave: PlaybackStrategy[];
} {
  const tried = new Set<string>();

  const secondaryFast: PlaybackStrategy =
    active.mode === "video_model"
      ? { mode: "preload", host: "reading.snssdk.com", profile: "modern_745", field21: 312 }
      : { ...DEFAULT_STRATEGY };

  const fastWave = dedupeStrategies([active, secondaryFast], tried);

  const healWaves: PlaybackStrategy[][] = [
    // Wave 1: alternate primary endpoints & hosts under current f21=312
    dedupeStrategies(
      [
        { mode: "video_model", host: "api5-normal-sinfonlineb.fqnovel.com", profile: "modern_745", field21: 312 },
        { mode: "video_model", host: "reading.snssdk.com", profile: "modern_745", field21: 312 },
        { mode: "tab", host: "api5-normal-sinfonlineb.fqnovel.com", profile: "cronet_739", field21: 312 },
      ],
      tried,
    ),
    // Wave 2: secondary multi_video endpoints + sinfonlinec
    dedupeStrategies(
      [
        { mode: "preload", host: "api5-normal-sinfonlineb.fqnovel.com", profile: "modern_745", field21: 312 },
        { mode: "v5", host: "api5-normal-sinfonlineb.fqnovel.com", profile: "compat_743", field21: 312 },
        { mode: "video_model", host: "api5-normal-sinfonlinec.fqnovel.com", profile: "modern_745", field21: 312 },
      ],
      tried,
    ),
    // Wave 3: automatic cross-field21 & client profile probe (handles upstream field21 rollbacks/switches)
    dedupeStrategies(
      [
        { mode: "video_model", host: "api5-normal-sinfonlinea.fqnovel.com", profile: "compat_743", field21: 377 },
        { mode: "tab", host: "api5-normal-sinfonlineb.fqnovel.com", profile: "compat_743", field21: 377 },
        { mode: "v5", host: "api5-normal-sinfonlineb.fqnovel.com", profile: "compat_743", field21: 377 },
      ],
      tried,
    ),
    // Wave 4: alternate regional hosts & profiles
    dedupeStrategies(
      [
        { mode: "video_model", host: "api5-normal-lf.fqnovel.com", profile: "modern_745", field21: 312 },
        { mode: "preload", host: "api5-normal-sinfonlinea.fqnovel.com", profile: "compat_743", field21: 312 },
        { mode: "tab", host: "api5-normal-sinfonlinea.fqnovel.com", profile: "cronet_739", field21: 312 },
      ],
      tried,
    ),
  ].filter((wave) => wave.length > 0);

  const freshDeviceWave: PlaybackStrategy[] = [
    { mode: "video_model", host: "api5-normal-sinfonlinea.fqnovel.com", profile: "modern_745", field21: 312 },
    { mode: "preload", host: "reading.snssdk.com", profile: "modern_745", field21: 312 },
    { mode: "tab", host: "api5-normal-sinfonlineb.fqnovel.com", profile: "cronet_739", field21: 312 },
  ];

  return { fastWave, healWaves, freshDeviceWave };
}

export async function resolveEpisodeVariants(
  episodeId: string,
  quality = "auto",
  options?: { signal?: AbortSignal; transport?: UpstreamTransport; allowBytevc2?: boolean },
): Promise<ResolvedVariant[]> {
  const signal = options?.signal;
  const transport = options?.transport ?? defaultUpstreamTransport;
  const bytevc2Available = options?.allowBytevc2 !== false && NativeVideo.bytevc2Available();
  throwIfAborted(signal);
  if (!/^\d{1,30}$/.test(episodeId)) {
    throw new SourceResolverError("INVALID_REQUEST", "分集编号无效");
  }

  await ensureStrategyLoaded();
  throwIfAborted(signal);

  const multiPayload = JSON.stringify({
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

  const executeStrategy = async (
    strategy: PlaybackStrategy,
    subSignal: AbortSignal,
    currentIdentity: DeviceIdentity,
  ): Promise<ResolvedVariant[]> => {
    const req =
      strategy.mode === "video_model"
        ? buildSingleVideoModelRequest(currentIdentity, episodeId, strategy)
        : strategy.mode === "preload"
          ? buildPreloadPlayRequest(currentIdentity, episodeId, strategy)
          : strategy.mode === "tab"
            ? buildVideoTabRequest(currentIdentity, episodeId, strategy)
            : strategy.mode === "v5"
              ? buildV5PlayRequest(currentIdentity, episodeId, multiPayload, strategy)
              : buildLegacyPlayRequest(currentIdentity, multiPayload, strategy.host);

    const response = await requestJson(transport, req, subSignal);
    const model = extractVideoModel(response, episodeId, strategy.mode === "video_model");
    try {
      return parsePlayModelVariants(model, quality, true, bytevc2Available);
    } catch (err) {
      if (
        err instanceof SourceResolverError &&
        (err.code === "NO_COMPATIBLE_SOURCE" || err.code === "MISSING_MODEL" || err.incompleteEncryptionMetadata)
      ) {
        const negotiated = await resolveFallbackCodecVariants(model, quality, transport, subSignal, bytevc2Available);
        if (negotiated && negotiated.length > 0) return negotiated;
      }
      throw err;
    }
  };

  const active = diagnosticsSignal().activeStrategy;
  const { fastWave, healWaves, freshDeviceWave } = buildStrategyWaves(active);

  // Tier 1: fast path using remembered healthy strategy + heterogeneous backup.
  let lastError: unknown = null;
  const fastResult = await raceStrategies(
    fastWave,
    (strategy, subSignal) => executeStrategy(strategy, subSignal, identity),
    signal,
  );
  if (fastResult.win) {
    recordStrategySuccess(fastResult.win.strategy, false);
    return fastResult.win.variants;
  }
  if (fastResult.lastError) lastError = fastResult.lastError;

  // Tier 2: bounded adaptive self-healing probes across endpoints, hosts, profiles, and field21.
  for (const wave of healWaves) {
    throwIfAborted(signal);
    const probeResult = await raceStrategies(
      wave,
      (strategy, subSignal) => executeStrategy(strategy, subSignal, identity),
      signal,
    );
    if (probeResult.win) {
      recordStrategySuccess(probeResult.win.strategy, true);
      return probeResult.win.variants;
    }
    if (probeResult.lastError) lastError = probeResult.lastError;
  }

  // Tier 3: rotate anonymous device identity and retry core routes, then legacy Argus/Ladon fallback.
  throwIfAborted(signal);
  try {
    identity = await registerPlaybackDevice(transport, signal);
    const rotatedResult = await raceStrategies(
      freshDeviceWave,
      (strategy, subSignal) => executeStrategy(strategy, subSignal, identity),
      signal,
    );
    if (rotatedResult.win) {
      recordStrategySuccess(rotatedResult.win.strategy, true);
      return rotatedResult.win.variants;
    }
    if (rotatedResult.lastError) lastError = rotatedResult.lastError;
  } catch (err) {
    if (isAbortError(err)) throw err;
    if (!lastError) lastError = err;
  }

  throwIfAborted(signal);
  const legacyStrategy: PlaybackStrategy = {
    mode: "v1",
    host: "api5-normal-sinfonlineb.fqnovel.com",
    profile: "cronet_739",
  };
  try {
    const legacyVariants = await executeStrategy(
      legacyStrategy,
      signal ?? new AbortController().signal,
      identity,
    );
    recordStrategySuccess(legacyStrategy, true);
    return legacyVariants;
  } catch (err) {
    if (isAbortError(err)) throw err;
    if (!lastError || (lastError instanceof SourceResolverError && lastError.code === "EMPTY_RESPONSE")) {
      lastError = err;
    }
  }

  const finalError =
    lastError instanceof SourceResolverError
      ? lastError
      : new SourceResolverError("EMPTY_RESPONSE", "App 接口返回空响应", { status: 200 });
  recordResolverFailure(`${finalError.code}: ${finalError.message}`);
  throw finalError;
}
