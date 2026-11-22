import { View, Text, signal, effect, cleanup, createAnimatedValue, Easing, type AnimatedValue, type Signal } from "nsh";
import { servicePost } from "../../service-client";
import type { DanmakuFontWeight, DanmakuSpeed } from "../../stores/user-data";

export interface DanmakuItem {
  id: string;
  text: string;
  timeMs: number;
  likeCount: number;
}

interface DanmakuResponse {
  items: DanmakuItem[];
  nextMs: number;
  total?: number;
}

export interface DanmakuLayerProps {
  seriesId: string;
  episodeId: string;
  positionSec: number;
  durationSec: number;
  paused: boolean;
  enabled: boolean;
  opacity: number;
  fontSize: number;
  scaleWithVideo: boolean;
  fontWeight: DanmakuFontWeight;
  color: string;
  lanes: number;
  speed: DanmakuSpeed;
  mergeDup: boolean;
  blockWords: readonly string[];
  onStageSize?: (size: { width: number; height: number }) => void;
}

interface LaneRecord {
  launchedAtPlayMs: number;
  width: number;
  speedPxPerMs: number;
}

interface ActiveBullet {
  uid: number;
  id: string;
  text: string;
  dupKey: string;
  dupCount: Signal<number>;
  top: number;
  fontSize: number;
  boxWidth: number;
  endX: number;
  speedPxPerMs: number;
  x: AnimatedValue;
  currentX: number;
  runId: number;
  laneRecord: LaneRecord;
}

export const DANMAKU_COLORS = [
  { value: "", label: "原色", hex: "#ffffff" },
  { value: "#ffffff", label: "白色", hex: "#ffffff" },
  { value: "#ffe14d", label: "黄色", hex: "#ffe14d" },
  { value: "#5ce1ff", label: "青色", hex: "#5ce1ff" },
  { value: "#7dff8a", label: "绿色", hex: "#7dff8a" },
  { value: "#ff9ec7", label: "粉色", hex: "#ff9ec7" },
  { value: "#ff9f43", label: "橙色", hex: "#ff9f43" },
  { value: "rainbow", label: "彩色", hex: "#ff9ec7" },
] as const;

const RAINBOW_PALETTE = ["#ffffff", "#ffe14d", "#5ce1ff", "#7dff8a", "#ff9ec7", "#ff9f43"];
const SPEED_DURATION_MS: Record<DanmakuSpeed, number> = { slow: 11500, normal: 8500, fast: 6000 };
const MAX_ACTIVE_BULLETS = 48;
const PREFETCH_AHEAD_MS = 10000;
const FETCH_COOLDOWN_MS = 8000;
const MERGE_WINDOW_MS = 15000;
const LANE_GAP_PX = 44;
const TOP_SAFE_PADDING = 48;
const BOTTOM_SAFE_PADDING = 96;

export function resolveDanmakuFontSize(baseSize: number, scaleWithVideo: boolean, stageHeight: number): number {
  if (!scaleWithVideo || stageHeight <= 0) return baseSize;
  const factor = Math.min(2, Math.max(0.6, stageHeight / 720));
  return Math.max(12, Math.min(48, Math.round(baseSize * factor)));
}

export function normalizeDupKey(text: string): string {
  return (text || "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "") || (text || "").trim();
}

export function matchesBlockWord(text: string, words: readonly string[]): boolean {
  if (!words.length) return false;
  const lower = text.toLowerCase();
  return words.some(word => {
    const trimmed = word.trim();
    return trimmed.length > 0 && lower.includes(trimmed.toLowerCase());
  });
}

function resolveBulletColor(id: string, colorPref: string): string {
  if (colorPref === "rainbow") {
    let hash = 0;
    for (let i = 0; i < id.length; i += 1) {
      hash = (hash * 31 + id.charCodeAt(i)) | 0;
    }
    return RAINBOW_PALETTE[Math.abs(hash) % RAINBOW_PALETTE.length];
  }
  return colorPref || "#ffffff";
}

function estimateBulletWidth(text: string, fontSize: number, hasDupSpace: boolean): number {
  let width = 28 + (hasDupSpace ? 48 : 0);
  for (let i = 0; i < text.length; i += 1) {
    width += text.charCodeAt(i) > 0x7f ? fontSize * 1.15 : fontSize * 0.68;
  }
  return Math.ceil(width);
}

function mergeRange(ranges: [number, number][], start: number, end: number): [number, number][] {
  if (end <= start) return ranges;
  const next = [...ranges, [start, end] as [number, number]].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of next) {
    const last = merged[merged.length - 1];
    if (!last || s > last[1]) {
      merged.push([s, e]);
    } else if (e > last[1]) {
      last[1] = e;
    }
  }
  return merged;
}

export function DanmakuLayer(props: DanmakuLayerProps) {
  const activeBullets = signal<ActiveBullet[]>([]);
  let bullets: ActiveBullet[] = [];
  let stageWidth = 960;
  let stageHeight = 540;
  let disposed = false;
  let nextUid = 1;
  let activeKey = "";
  let pool: DanmakuItem[] = [];
  let idSet = new Set<string>();
  let emittedIds = new Set<string>();
  let fetchedRanges: [number, number][] = [];
  let inFlightController: AbortController | null = null;
  let fetching = false;
  let cooldownUntil = 0;
  let lastTimeMs = -1;
  let laneHistory: (LaneRecord | undefined)[] = [];
  let recentDupMap = new Map<string, { atPlayMs: number; bullet: ActiveBullet }>();
  let prevPaused = props.paused;
  let pausedAt: number | null = props.paused ? Date.now() : null;
  let totalPausedMs = 0;

  const nowPlayMs = () => (pausedAt ?? Date.now()) - totalPausedMs;

  const syncView = () => {
    activeBullets.set([...bullets]);
  };

  const removeBullet = (uid: number) => {
    const idx = bullets.findIndex(item => item.uid === uid);
    if (idx < 0) return;
    const [removed] = bullets.splice(idx, 1);
    const dupEntry = recentDupMap.get(removed.dupKey);
    if (dupEntry && dupEntry.bullet.uid === uid) {
      recentDupMap.delete(removed.dupKey);
    }
    syncView();
  };

  const stopAllBullets = () => {
    if (bullets.length > 0) {
      for (const bullet of bullets) {
        bullet.runId += 1;
        void bullet.x.stop().catch(() => {});
      }
      bullets = [];
      syncView();
    }
    laneHistory = [];
    recentDupMap.clear();
  };

  const resetEpisodeState = () => {
    inFlightController?.abort();
    inFlightController = null;
    fetching = false;
    cooldownUntil = 0;
    pool = [];
    idSet.clear();
    emittedIds.clear();
    fetchedRanges = [];
    lastTimeMs = -1;
    stopAllBullets();
  };

  const startBulletAnimation = (bullet: ActiveBullet) => {
    if (disposed || props.paused || !props.enabled) return;
    const distance = bullet.currentX - bullet.endX;
    if (distance <= 0) {
      removeBullet(bullet.uid);
      return;
    }
    const duration = Math.max(200, Math.round(distance / bullet.speedPxPerMs));
    const expectedRunId = ++bullet.runId;
    void bullet.x
      .timing(bullet.endX, { duration, easing: Easing.linear })
      .then(({ finished }) => {
        if (finished && !disposed && bullet.runId === expectedRunId) {
          removeBullet(bullet.uid);
        }
      })
      .catch(() => {});
  };

  const pauseAllBullets = () => {
    for (const bullet of bullets) {
      bullet.runId += 1;
      void bullet.x
        .stop()
        .then(({ value }) => {
          bullet.currentX = value;
        })
        .catch(() => {});
    }
  };

  const resumeAllBullets = () => {
    for (const bullet of [...bullets]) {
      if (bullet.currentX <= bullet.endX) {
        removeBullet(bullet.uid);
      } else {
        startBulletAnimation(bullet);
      }
    }
  };

  const pickLane = (bulletWidth: number, speedPxPerMs: number, effectiveSize: number): { lane: number; record: LaneRecord } | null => {
    const laneHeight = Math.round(effectiveSize * 1.45) + 10;
    const usableHeight = Math.max(laneHeight, stageHeight - TOP_SAFE_PADDING - BOTTOM_SAFE_PADDING);
    const maxFit = Math.max(1, Math.floor(usableHeight / laneHeight));
    const laneCount = Math.max(1, Math.min(props.lanes, maxFit));
    const playNow = nowPlayMs();

    for (let lane = 0; lane < laneCount; lane += 1) {
      const prev = laneHistory[lane];
      if (!prev || (playNow - prev.launchedAtPlayMs) * prev.speedPxPerMs >= prev.width + LANE_GAP_PX) {
        const record: LaneRecord = { launchedAtPlayMs: playNow, width: bulletWidth, speedPxPerMs };
        laneHistory[lane] = record;
        return { lane, record };
      }
    }
    return null;
  };

  const launchBullet = (item: DanmakuItem) => {
    if (disposed || !props.enabled || bullets.length >= MAX_ACTIVE_BULLETS) return;
    const cleanText = item.text.replace(/[\r\n]+/g, " ").trim();
    if (!cleanText || matchesBlockWord(cleanText, props.blockWords)) return;

    const dupKey = normalizeDupKey(cleanText);
    const playNow = nowPlayMs();
    if (props.mergeDup && dupKey) {
      const existing = recentDupMap.get(dupKey);
      if (existing && playNow - existing.atPlayMs <= MERGE_WINDOW_MS && bullets.some(b => b.uid === existing.bullet.uid)) {
        const nextCount = existing.bullet.dupCount() + 1;
        existing.bullet.dupCount.set(nextCount);
        existing.bullet.laneRecord.width = Math.max(
          existing.bullet.laneRecord.width,
          estimateBulletWidth(existing.bullet.text, existing.bullet.fontSize, true),
        );
        emittedIds.add(item.id);
        return;
      }
    }

    const effectiveSize = resolveDanmakuFontSize(props.fontSize, props.scaleWithVideo, stageHeight);
    const contentWidth = estimateBulletWidth(cleanText, effectiveSize, false);
    const boxWidth = estimateBulletWidth(cleanText, effectiveSize, props.mergeDup);
    const speedPxPerMs = stageWidth / SPEED_DURATION_MS[props.speed];
    const picked = pickLane(contentWidth, speedPxPerMs, effectiveSize);
    if (!picked) return;

    const laneHeight = Math.round(effectiveSize * 1.45) + 10;
    const top = TOP_SAFE_PADDING + picked.lane * laneHeight;
    const endX = -boxWidth - 24;
    const x = createAnimatedValue(stageWidth);
    const bullet: ActiveBullet = {
      uid: nextUid++,
      id: item.id,
      text: cleanText,
      dupKey,
      dupCount: signal(1),
      top,
      fontSize: effectiveSize,
      boxWidth,
      endX,
      speedPxPerMs,
      x,
      currentX: stageWidth,
      runId: 0,
      laneRecord: picked.record,
    };
    emittedIds.add(item.id);
    if (props.mergeDup && dupKey) {
      recentDupMap.set(dupKey, { atPlayMs: playNow, bullet });
    }
    bullets.push(bullet);
    syncView();
    if (!props.paused) {
      startBulletAnimation(bullet);
    }
  };

  const syncBullets = (overrideStartMs?: number) => {
    if (disposed || !props.enabled || !props.seriesId || !props.episodeId) return;
    const currentMs = Math.max(0, Math.floor(props.positionSec * 1000));
    let windowStart: number;

    if (overrideStartMs !== undefined) {
      windowStart = overrideStartMs;
    } else if (lastTimeMs < 0) {
      windowStart = currentMs <= 500 ? -1 : Math.max(0, currentMs - 500);
    } else if (currentMs < lastTimeMs - 800 || currentMs > lastTimeMs + 3000) {
      stopAllBullets();
      emittedIds.clear();
      windowStart = currentMs <= 500 ? -1 : Math.max(0, currentMs - 500);
    } else {
      windowStart = lastTimeMs;
    }

    lastTimeMs = currentMs;
    if (props.paused) return;

    for (const item of pool) {
      if (item.timeMs > windowStart && item.timeMs <= currentMs && !emittedIds.has(item.id)) {
        launchBullet(item);
      }
    }
  };

  const fetchWindow = (seriesId: string, episodeId: string, startMs: number, durationMs: number) => {
    const requestKey = `${seriesId}:${episodeId}`;
    if (fetching || Date.now() < cooldownUntil || disposed) return;
    fetching = true;
    const controller = new AbortController();
    inFlightController = controller;

    void servicePost<DanmakuResponse>(
      "/danmaku",
      { seriesId, episodeId, startMs, durationMs },
      controller.signal,
    )
      .then(res => {
        if (disposed || controller.signal.aborted || activeKey !== requestKey) return;
        const nextMs = typeof res?.nextMs === "number" && res.nextMs > startMs ? Math.floor(res.nextMs) : startMs + 30000;
        fetchedRanges = mergeRange(fetchedRanges, startMs, nextMs);
        const incoming = Array.isArray(res?.items) ? res.items : [];
        let added = false;
        for (const item of incoming) {
          if (!item || typeof item.id !== "string" || typeof item.text !== "string" || typeof item.timeMs !== "number") continue;
          if (!idSet.has(item.id)) {
            idSet.add(item.id);
            pool.push(item);
            added = true;
          }
        }
        if (added) {
          pool.sort((a, b) => (a.timeMs !== b.timeMs ? a.timeMs - b.timeMs : a.id.localeCompare(b.id)));
        }
        const nowMs = Math.max(0, Math.floor(props.positionSec * 1000));
        syncBullets(nowMs <= 500 ? -1 : Math.max(0, nowMs - 500));
      })
      .catch(() => {
        if (!controller.signal.aborted && activeKey === requestKey) {
          cooldownUntil = Date.now() + FETCH_COOLDOWN_MS;
        }
      })
      .finally(() => {
        if (inFlightController === controller) inFlightController = null;
        fetching = false;
      });
  };

  const ensureFetched = (currentMs: number) => {
    if (disposed || !props.enabled || !props.seriesId || !props.episodeId || fetching || Date.now() < cooldownUntil) return;
    const durationMs = props.durationSec > 0 ? Math.floor(props.durationSec * 1000) : 0;
    const covered = fetchedRanges.find(([start, end]) => start <= currentMs && currentMs < end);
    if (!covered) {
      fetchWindow(props.seriesId, props.episodeId, currentMs, durationMs);
      return;
    }
    const end = covered[1];
    if (end - currentMs <= PREFETCH_AHEAD_MS && (durationMs === 0 || end < durationMs)) {
      fetchWindow(props.seriesId, props.episodeId, end, durationMs);
    }
  };

  effect(() => {
    const key = `${props.seriesId}:${props.episodeId}`;
    if (key !== activeKey) {
      activeKey = key;
      resetEpisodeState();
    }
  });

  effect(() => {
    if (!props.enabled) {
      inFlightController?.abort();
      inFlightController = null;
      fetching = false;
      emittedIds.clear();
      lastTimeMs = -1;
      stopAllBullets();
      return;
    }
    const currentMs = Math.max(0, Math.floor(props.positionSec * 1000));
    ensureFetched(currentMs);
    syncBullets();
  });

  // Only pause/resume on real state transitions; never read positionSec or activeBullets here.
  effect(() => {
    const isPaused = props.paused;
    const isEnabled = props.enabled;
    if (isPaused === prevPaused) return;
    prevPaused = isPaused;
    if (isPaused) {
      if (pausedAt === null) pausedAt = Date.now();
      if (isEnabled) pauseAllBullets();
    } else {
      if (pausedAt !== null) {
        totalPausedMs += Math.max(0, Date.now() - pausedAt);
        pausedAt = null;
      }
      if (isEnabled) resumeAllBullets();
    }
  });

  // Immediately clear any on-screen bullet matching updated block words.
  effect(() => {
    const words = props.blockWords;
    if (!words.length || !bullets.length) return;
    const filtered = bullets.filter(bullet => {
      if (matchesBlockWord(bullet.text, words)) {
        bullet.runId += 1;
        void bullet.x.stop().catch(() => {});
        const dupEntry = recentDupMap.get(bullet.dupKey);
        if (dupEntry && dupEntry.bullet.uid === bullet.uid) {
          recentDupMap.delete(bullet.dupKey);
        }
        return false;
      }
      return true;
    });
    if (filtered.length !== bullets.length) {
      bullets = filtered;
      syncView();
    }
  });

  cleanup(() => {
    disposed = true;
    inFlightController?.abort();
    inFlightController = null;
    stopAllBullets();
  });

  return (
    <View
      testID="danmaku-layer"
      style={{ pointerEvents: "none", opacity: props.opacity }}
      class="absolute inset-0 overflow-hidden"
      onLayout={event => {
        const w = event.bounds.size.width;
        const h = event.bounds.size.height;
        if (w > 0) stageWidth = w;
        if (h > 0) stageHeight = h;
        if (w > 0 && h > 0) props.onStageSize?.({ width: w, height: h });
      }}
    >
      <Each of={activeBullets()}>
        {bullet => (
          <View
            testID={`danmaku-bullet-${bullet().id}`}
            onLayout={event => {
              const measured = event.bounds.size.width;
              if (measured > bullet().laneRecord.width) {
                bullet().laneRecord.width = measured;
              }
            }}
            style={{
              position: "absolute",
              left: 0,
              top: bullet().top,
              width: bullet().boxWidth,
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              transform: [{ translateX: bullet().x }],
            }}
          >
            <Text
              style={{
                fontSize: bullet().fontSize,
                fontWeight: props.fontWeight,
                color: resolveBulletColor(bullet().id, props.color),
                numberOfLines: 1,
                textShadow: [{ x: 1, y: 1, blur: 2, color: "rgba(0, 0, 0, 0.85)" }],
              }}
            >
              {bullet().text}
            </Text>
            <If when={bullet().dupCount() > 1}>
              <Text
                style={{
                  fontSize: Math.max(11, Math.round(bullet().fontSize * 0.78)),
                  fontWeight: "700",
                  color: "#ffe14d",
                  textShadow: [{ x: 1, y: 1, blur: 2, color: "rgba(0, 0, 0, 0.85)" }],
                }}
              >
                {`×${bullet().dupCount()}`}
              </Text>
            </If>
          </View>
        )}
      </Each>
    </View>
  );
}
