import { signal } from "nsh";
import { serviceConfig } from "../../service-client";
import type { QualityOption } from "../../stores/user-data";

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
let currentSeries: string | undefined;
let currentEpisode: string | undefined;
let currentQuality: QualityOption = "auto";
let currentDownloadId: string | undefined;

export const playbackState = () => state();

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
    state.set({ kind: "error", message: "请先运行 ./tools/dev 启动本机播放服务" });
    return;
  }
  const controller = new AbortController();
  pending = controller;
  state.set({ kind: "preparing" });
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(serviceConfig.baseUrl + "/play", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + serviceConfig.token,
      },
      body: JSON.stringify({
        seriesId,
        ...(episodeId ? { episodeId } : {}),
        quality,
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
    const playback = parsePlayback(value, serviceConfig.baseUrl, seriesId, episodeId);
    if (initialPositionSec > 2) playback.initialPositionSec = initialPositionSec;
    if (pending === controller) state.set({ kind: "ready", playback });
  } catch (error) {
    if (pending === controller) {
      state.set({
        kind: "error",
        ...(error instanceof Error && "code" in error && typeof error.code === "string" ? {code:error.code} : {}),
        message: controller.signal.aborted
          ? "播放准备超时，请重试"
          : error instanceof Error
            ? error.message
            : "播放准备失败",
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
    state.set({ kind: "error", message: "请先运行 ./tools/dev 启动本机播放服务" });
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
  pending?.abort();
  pending = undefined;
  state.set({ kind: "idle" });
}
