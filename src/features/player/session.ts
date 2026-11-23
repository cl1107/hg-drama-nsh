import { signal } from "nsh";
import { serviceConfig, servicePost } from "../../service-client";
import type { QualityOption } from "../../stores/user-data";
import {
  resolveEpisodeVariants,
  SourceResolverError,
  type ResolvedVariant,
} from "../../providers/source-resolver";

export interface Episode {
  episodeId: string;
  index: number;
}

export interface Playback {
  seriesId: string;
  title: string;
  cover?: string;
  intro?: string;
  episode: Episode;
  episodes: Episode[];
  codec: string;
  quality: string;
  encrypted: boolean;
  mediaUrl: string;
  initialPositionSec?: number;
  isOffline?: boolean;
}

type State =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "ready"; playback: Playback }
  | { kind: "error"; message: string; code?: string };

const state = signal<State>({ kind: "idle" });
let pending: AbortController | undefined;
let prefetchController: AbortController | undefined;
let prefetchTimer: ReturnType<typeof setTimeout> | undefined;
let currentSeries: string | undefined;
let currentEpisode: string | undefined;
let currentQuality: QualityOption = "auto";
let currentDownloadId: string | undefined;

export const playbackState = () => state();

function cancelPrefetch(): void {
  if (prefetchTimer) {
    clearTimeout(prefetchTimer);
    prefetchTimer = undefined;
  }
  prefetchController?.abort();
  prefetchController = undefined;
}

function scheduleNextPrefetch(playback: Playback, quality: QualityOption): void {
  cancelPrefetch();
  if (playback.isOffline || !serviceConfig.baseUrl) return;
  const idx = playback.episodes.findIndex((e) => e.episodeId === playback.episode.episodeId);
  const next = idx >= 0 ? playback.episodes[idx + 1] : undefined;
  if (!next) return;
  const controller = new AbortController();
  prefetchController = controller;
  prefetchTimer = setTimeout(() => {
    prefetchTimer = undefined;
    void (async () => {
      try {
        const cached = await tryCheckCache(playback.seriesId, next.episodeId, quality, controller.signal);
        if (cached || controller.signal.aborted) return;
        const variants = await resolveEpisodeVariants(next.episodeId, quality, { signal: controller.signal });
        if (controller.signal.aborted) return;
        await servicePost(
          "/play/prefetch",
          { seriesId: playback.seriesId, episodeId: next.episodeId, quality, variants },
          controller.signal,
        );
      } catch {
        // Silent background prefetch failure
      }
    })();
  }, 150);
}

async function tryCheckCache(
  seriesId: string,
  episodeId: string,
  quality: QualityOption,
  signal: AbortSignal,
): Promise<Playback | null> {
  try {
    const res = await fetch(serviceConfig.baseUrl + "/play/cache", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + serviceConfig.token,
      },
      body: JSON.stringify({ seriesId, episodeId, quality }),
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { hit?: boolean; playback?: unknown };
    if (data?.hit && data.playback) {
      return parsePlayback(data.playback, serviceConfig.baseUrl, seriesId, episodeId);
    }
  } catch {
    // Ignore when cache probe is unavailable (e.g., mocked UI tests)
  }
  return null;
}

async function tryResolveDetailEpisode(
  seriesId: string,
  episodeId: string | undefined,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const res = await fetch(serviceConfig.baseUrl + "/detail", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + serviceConfig.token,
      },
      body: JSON.stringify({ seriesId }),
      signal,
    });
    if (!res.ok) return null;
    const detail = (await res.json()) as { episodes?: Array<{ episodeId?: string }> };
    const list = Array.isArray(detail?.episodes) ? detail.episodes : [];
    if (episodeId) {
      return list.some((e) => e?.episodeId === episodeId) ? episodeId : null;
    }
    const first = list[0]?.episodeId;
    return typeof first === "string" && /^\d{1,30}$/.test(first) ? first : null;
  } catch {
    return null;
  }
}

export async function startEpisodeDownload(
  seriesId: string,
  episodeId: string | undefined,
  quality: QualityOption,
): Promise<void> {
  let variants: ResolvedVariant[] | undefined;
  let targetEpisodeId = episodeId;
  const controller = new AbortController();
  const resolvedEpisode = await tryResolveDetailEpisode(seriesId, episodeId, controller.signal);
  if (resolvedEpisode) {
    targetEpisodeId = resolvedEpisode;
    variants = await resolveEpisodeVariants(resolvedEpisode, quality, { signal: controller.signal });
  }
  await servicePost("/downloads/start", {
    seriesId,
    ...(targetEpisodeId ? { episodeId: targetEpisodeId } : {}),
    quality,
    ...(variants ? { variants } : {}),
  });
}

export async function retryEpisodeDownload(task: {
  id: string;
  seriesId: string;
  episodeId: string;
  quality: string;
}): Promise<void> {
  let variants: ResolvedVariant[] | undefined;
  if (task.episodeId) {
    const controller = new AbortController();
    variants = await resolveEpisodeVariants(task.episodeId, task.quality || "auto", {
      signal: controller.signal,
    });
  }
  await servicePost("/downloads/retry", {
    id: task.id,
    ...(variants ? { variants } : {}),
  });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("播放服务返回格式异常");
  return value as Record<string, unknown>;
}

function episode(value: unknown): Episode {
  const item = record(value);
  if (
    typeof item.episodeId !== "string" ||
    !/^\d{1,30}$/.test(item.episodeId) ||
    !Number.isInteger(item.index) ||
    typeof item.index !== "number" ||
    item.index < 1
  ) {
    throw new Error("分集信息无效");
  }
  return { episodeId: item.episodeId, index: item.index };
}

export function parsePlayback(value: unknown, baseUrl: string, seriesId: string, episodeId?: string): Playback {
  const row = record(value),
    selected = episode(row.episode);
  if (
    row.seriesId !== seriesId ||
    (episodeId && selected.episodeId !== episodeId) ||
    typeof row.title !== "string" ||
    !row.title.trim() ||
    !Array.isArray(row.episodes) ||
    typeof row.mediaUrl !== "string" ||
    typeof row.codec !== "string" ||
    !["h264", "hevc"].includes(row.codec) ||
    typeof row.quality !== "string" ||
    typeof row.encrypted !== "boolean"
  ) {
    throw new Error("播放信息不完整或集数不匹配");
  }
  const episodes = row.episodes.map(episode),
    url = new URL(row.mediaUrl),
    base = new URL(baseUrl);
  if (
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    !/^\/media\/[a-f0-9]{64}$/.test(url.pathname) ||
    url.search ||
    url.hash ||
    !episodes.some(e => e.episodeId === selected.episodeId && e.index === selected.index)
  ) {
    throw new Error("播放资源不属于当前会话");
  }
  return {
    seriesId,
    title: row.title,
    ...(typeof row.cover === "string" && row.cover ? { cover: row.cover } : {}),
    ...(typeof row.intro === "string" && row.intro ? { intro: row.intro } : {}),
    episode: selected,
    episodes,
    codec: row.codec,
    quality: row.quality,
    encrypted: row.encrypted,
    mediaUrl: url.href,
  };
}

export async function startPlayback(
  seriesId: string,
  episodeId?: string,
  quality: QualityOption = "auto",
  initialPositionSec = 0,
) {
  cancelPlayback();
  currentSeries = seriesId;
  currentEpisode = episodeId;
  currentQuality = quality;
  currentDownloadId = undefined;
  if (!serviceConfig.baseUrl) {
    state.set({ kind: "error", message: "本机播放服务未启动" });
    return;
  }
  const controller = new AbortController();
  pending = controller;
  state.set({ kind: "preparing" });
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    if (episodeId) {
      const cached = await tryCheckCache(seriesId, episodeId, quality, controller.signal);
      if (cached) {
        if (initialPositionSec > 2) cached.initialPositionSec = initialPositionSec;
        if (pending === controller) {
          state.set({ kind: "ready", playback: cached });
          scheduleNextPrefetch(cached, quality);
        }
        return;
      }
    }

    let resolvedVariants: ResolvedVariant[] | undefined;
    let resolvedEpisodeId = episodeId;
    const detailEpisodeId = await tryResolveDetailEpisode(seriesId, episodeId, controller.signal);
    if (detailEpisodeId) {
      resolvedEpisodeId = detailEpisodeId;
      resolvedVariants = await resolveEpisodeVariants(detailEpisodeId, quality, {
        signal: controller.signal,
      });
    }

    const response = await fetch(serviceConfig.baseUrl + "/play", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + serviceConfig.token,
      },
      body: JSON.stringify({
        seriesId,
        ...(resolvedEpisodeId ? { episodeId: resolvedEpisodeId } : {}),
        quality,
        ...(resolvedVariants ? { variants: resolvedVariants } : {}),
      }),
      signal: controller.signal,
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      const failure = record(value);
      throw Object.assign(
        new Error(failure.code === "EMPTY_RESPONSE" ? "上游暂未提供本集正片片源" : typeof failure.message === "string" ? failure.message : `播放准备失败（HTTP ${response.status}）`),
        { code: typeof failure.code === "string" ? failure.code : "PLAYBACK_FAILED" },
      );
    }
    const playback = parsePlayback(value, serviceConfig.baseUrl, seriesId, resolvedEpisodeId);
    if (initialPositionSec > 2) playback.initialPositionSec = initialPositionSec;
    if (pending === controller) {
      state.set({ kind: "ready", playback });
      if (resolvedVariants) {
        scheduleNextPrefetch(playback, quality);
      }
    }
  } catch (error) {
    if (pending === controller) {
      const code =
        error instanceof SourceResolverError
          ? error.code
          : error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string"
            ? (error as { code: string }).code
            : undefined;
      const message = controller.signal.aborted
        ? "播放准备超时，请重试"
        : code === "EMPTY_RESPONSE"
          ? "上游暂未提供本集正片片源"
          : error instanceof Error
            ? error.message
            : "播放准备失败";
      state.set({
        kind: "error",
        ...(code ? { code } : {}),
        message,
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function startOfflinePlayback(downloadId: string, seriesId: string, episodeId: string) {
  cancelPlayback();
  currentSeries = seriesId;
  currentEpisode = episodeId;
  currentDownloadId = downloadId;
  if (!serviceConfig.baseUrl) {
    state.set({ kind: "error", message: "本机播放服务未启动" });
    return;
  }
  const controller = new AbortController();
  pending = controller;
  state.set({ kind: "preparing" });
  try {
    const response = await fetch(serviceConfig.baseUrl + "/downloads/play", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + serviceConfig.token,
      },
      body: JSON.stringify({ id: downloadId }),
      signal: controller.signal,
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      const failure = record(value);
      throw new Error(typeof failure.message === "string" ? failure.message : `离线播放失败（HTTP ${response.status}）`);
    }
    const playback = parsePlayback(value, serviceConfig.baseUrl, seriesId, episodeId);
    playback.isOffline = true;
    if (pending === controller) state.set({ kind: "ready", playback });
  } catch (error) {
    if (pending === controller) {
      state.set({
        kind: "error",
        message: error instanceof Error ? error.message : "离线播放失败",
      });
    }
  }
}

export function retryPlayback() {
  if (currentDownloadId && currentSeries && currentEpisode) {
    void startOfflinePlayback(currentDownloadId, currentSeries, currentEpisode);
    return;
  }
  if (currentSeries) void startPlayback(currentSeries, currentEpisode, currentQuality);
}

export function cancelPlayback() {
  cancelPrefetch();
  pending?.abort();
  pending = undefined;
  state.set({ kind: "idle" });
}
