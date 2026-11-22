import { setColorScheme, signal, Storage } from "nsh";

export type QualityOption = "auto" | "1080p" | "720p" | "540p" | "480p" | "360p";
export type DanmakuArea = "top" | "half" | "full";
export type DanmakuFontWeight = 300 | 400 | 600 | 700;
export type DanmakuSpeed = "slow" | "normal" | "fast";

const ALLOWED_DANMAKU_COLORS = new Set(["", "#ffffff", "#ffe14d", "#5ce1ff", "#7dff8a", "#ff9ec7", "#ff9f43", "rainbow"]);
const ALLOWED_DANMAKU_WEIGHTS = new Set<DanmakuFontWeight>([300, 400, 600, 700]);

export interface HistoryItem {
  seriesId: string;
  title: string;
  cover: string;
  episodeId: string;
  episodeIndex: number;
  totalEpisodes: number;
  positionSec: number;
  durationSec: number;
  updatedAt: number;
  completed: boolean;
}

export interface DramaSummary {
  seriesId: string;
  title: string;
  cover: string;
  episodes: number;
  addedAt: number;
}

export interface AppPreferences {
  defaultQuality: QualityOption;
  autoPlayNext: boolean;
  colorScheme: "dark" | "light";
  sidebarCollapsed: boolean;
  danmakuEnabled: boolean;
  danmakuOpacity: number;
  danmakuFontSize: number;
  danmakuScaleWithVideo: boolean;
  danmakuFontWeight: DanmakuFontWeight;
  danmakuColor: string;
  danmakuLanes: number;
  danmakuArea: DanmakuArea;
  danmakuSpeed: DanmakuSpeed;
  danmakuShowInFullscreen: boolean;
  danmakuMergeDup: boolean;
  danmakuBlockWords: string[];
}

const PREFS_KEY = "hg:prefs:v1";

const DEFAULT_PREFS: AppPreferences = {
  defaultQuality: "auto",
  autoPlayNext: true,
  colorScheme: "dark",
  sidebarCollapsed: false,
  danmakuEnabled: true,
  danmakuOpacity: 0.85,
  danmakuFontSize: 20,
  danmakuScaleWithVideo: true,
  danmakuFontWeight: 600,
  danmakuColor: "",
  danmakuLanes: 8,
  danmakuArea: "half",
  danmakuSpeed: "normal",
  danmakuShowInFullscreen: true,
  danmakuMergeDup: true,
  danmakuBlockWords: [],
};

const activeAccountKey = signal("guest");
const historyList = signal<HistoryItem[]>([]);
const favoriteList = signal<DramaSummary[]>([]);
const likeList = signal<DramaSummary[]>([]);
const subscriptionList = signal<DramaSummary[]>([]);
const prefsState = signal<AppPreferences>({ ...DEFAULT_PREFS });

function scopeKey(kind: string, account = activeAccountKey()): string {
  return `hg:${account}:${kind}:v1`;
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await Storage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  try {
    await Storage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore quota errors on non-critical local history writes.
  }
}

export async function loadUserData(accountKey = "guest"): Promise<void> {
  activeAccountKey.set(accountKey);
  const [h, f, l, s, p] = await Promise.all([
    readJson<HistoryItem[]>(scopeKey("history", accountKey), []),
    readJson<DramaSummary[]>(scopeKey("favorites", accountKey), []),
    readJson<DramaSummary[]>(scopeKey("likes", accountKey), []),
    readJson<DramaSummary[]>(scopeKey("subscriptions", accountKey), []),
    readJson<AppPreferences>(PREFS_KEY, DEFAULT_PREFS),
  ]);
  historyList.set(Array.isArray(h) ? h : []);
  favoriteList.set(Array.isArray(f) ? f : []);
  likeList.set(Array.isArray(l) ? l : []);
  subscriptionList.set(Array.isArray(s) ? s : []);
  const nextPrefs: AppPreferences = {
    defaultQuality: p?.defaultQuality || "auto",
    autoPlayNext: typeof p?.autoPlayNext === "boolean" ? p.autoPlayNext : true,
    colorScheme: p?.colorScheme === "light" ? "light" : "dark",
    sidebarCollapsed: Boolean(p?.sidebarCollapsed),
    danmakuEnabled: typeof p?.danmakuEnabled === "boolean" ? p.danmakuEnabled : DEFAULT_PREFS.danmakuEnabled,
    danmakuOpacity:
      typeof p?.danmakuOpacity === "number" && Number.isFinite(p.danmakuOpacity) && p.danmakuOpacity >= 0.2 && p.danmakuOpacity <= 1
        ? p.danmakuOpacity
        : DEFAULT_PREFS.danmakuOpacity,
    danmakuFontSize:
      typeof p?.danmakuFontSize === "number" && Number.isFinite(p.danmakuFontSize) && p.danmakuFontSize >= 12 && p.danmakuFontSize <= 36
        ? Math.round(p.danmakuFontSize)
        : DEFAULT_PREFS.danmakuFontSize,
    danmakuScaleWithVideo:
      typeof p?.danmakuScaleWithVideo === "boolean" ? p.danmakuScaleWithVideo : DEFAULT_PREFS.danmakuScaleWithVideo,
    danmakuFontWeight:
      typeof p?.danmakuFontWeight === "number" && ALLOWED_DANMAKU_WEIGHTS.has(p.danmakuFontWeight as DanmakuFontWeight)
        ? (p.danmakuFontWeight as DanmakuFontWeight)
        : DEFAULT_PREFS.danmakuFontWeight,
    danmakuColor:
      typeof p?.danmakuColor === "string" && ALLOWED_DANMAKU_COLORS.has(p.danmakuColor)
        ? p.danmakuColor
        : DEFAULT_PREFS.danmakuColor,
    danmakuLanes:
      typeof p?.danmakuLanes === "number" && Number.isFinite(p.danmakuLanes) && p.danmakuLanes >= 2 && p.danmakuLanes <= 16
        ? Math.round(p.danmakuLanes)
        : DEFAULT_PREFS.danmakuLanes,
    danmakuArea: p?.danmakuArea === "top" || p?.danmakuArea === "half" || p?.danmakuArea === "full" ? p.danmakuArea : DEFAULT_PREFS.danmakuArea,
    danmakuSpeed: p?.danmakuSpeed === "slow" || p?.danmakuSpeed === "normal" || p?.danmakuSpeed === "fast" ? p.danmakuSpeed : DEFAULT_PREFS.danmakuSpeed,
    danmakuShowInFullscreen:
      typeof p?.danmakuShowInFullscreen === "boolean" ? p.danmakuShowInFullscreen : DEFAULT_PREFS.danmakuShowInFullscreen,
    danmakuMergeDup:
      typeof p?.danmakuMergeDup === "boolean" ? p.danmakuMergeDup : DEFAULT_PREFS.danmakuMergeDup,
    danmakuBlockWords: Array.isArray(p?.danmakuBlockWords)
      ? Array.from(new Set(p.danmakuBlockWords.filter((w): w is string => typeof w === "string").map(w => w.trim()).filter(Boolean)))
      : DEFAULT_PREFS.danmakuBlockWords,
  };
  prefsState.set(nextPrefs);
  setColorScheme(nextPrefs.colorScheme);
}

export const watchHistory = () => historyList();
export const favorites = () => favoriteList();
export const likes = () => likeList();
export const subscriptions = () => subscriptionList();
export const preferences = () => prefsState();

export function recordWatchProgress(entry: Omit<HistoryItem, "updatedAt" | "completed">) {
  const completed = entry.durationSec > 0 && entry.positionSec >= entry.durationSec - 2;
  const nextItem: HistoryItem = { ...entry, updatedAt: Date.now(), completed };
  const next = [nextItem, ...historyList().filter(i => i.seriesId !== entry.seriesId)].slice(0, 100);
  historyList.set(next);
  void writeJson(scopeKey("history"), next);
}

export function getSavedProgress(seriesId: string): HistoryItem | undefined {
  return historyList().find(i => i.seriesId === seriesId);
}

export function removeHistoryItems(seriesIds: string[]) {
  const removeSet = new Set(seriesIds);
  const next = historyList().filter(i => !removeSet.has(i.seriesId));
  historyList.set(next);
  void writeJson(scopeKey("history"), next);
}

export function isFavorite(seriesId: string): boolean {
  return favoriteList().some(i => i.seriesId === seriesId);
}

export function toggleFavorite(drama: Omit<DramaSummary, "addedAt">) {
  const exists = isFavorite(drama.seriesId);
  const next = exists
    ? favoriteList().filter(i => i.seriesId !== drama.seriesId)
    : [{ ...drama, addedAt: Date.now() }, ...favoriteList()];
  favoriteList.set(next);
  void writeJson(scopeKey("favorites"), next);
}

export function removeFavorites(seriesIds: string[]) {
  const removeSet = new Set(seriesIds);
  const next = favoriteList().filter(i => !removeSet.has(i.seriesId));
  favoriteList.set(next);
  void writeJson(scopeKey("favorites"), next);
}

export function isLiked(seriesId: string): boolean {
  return likeList().some(i => i.seriesId === seriesId);
}

export function toggleLike(drama: Omit<DramaSummary, "addedAt">) {
  const exists = isLiked(drama.seriesId);
  const next = exists
    ? likeList().filter(i => i.seriesId !== drama.seriesId)
    : [{ ...drama, addedAt: Date.now() }, ...likeList()];
  likeList.set(next);
  void writeJson(scopeKey("likes"), next);
}

export function removeLikes(seriesIds: string[]) {
  const removeSet = new Set(seriesIds);
  const next = likeList().filter(i => !removeSet.has(i.seriesId));
  likeList.set(next);
  void writeJson(scopeKey("likes"), next);
}

export function isSubscribed(seriesId: string): boolean {
  return subscriptionList().some(i => i.seriesId === seriesId);
}

export function toggleSubscription(drama: Omit<DramaSummary, "addedAt">) {
  const exists = isSubscribed(drama.seriesId);
  const next = exists
    ? subscriptionList().filter(i => i.seriesId !== drama.seriesId)
    : [{ ...drama, addedAt: Date.now() }, ...subscriptionList()];
  subscriptionList.set(next);
  void writeJson(scopeKey("subscriptions"), next);
}

export function removeSubscriptions(seriesIds: string[]) {
  const removeSet = new Set(seriesIds);
  const next = subscriptionList().filter(i => !removeSet.has(i.seriesId));
  subscriptionList.set(next);
  void writeJson(scopeKey("subscriptions"), next);
}

export function updatePreferences(patch: Partial<AppPreferences>) {
  const next = { ...prefsState(), ...patch };
  prefsState.set(next);
  if (patch.colorScheme) setColorScheme(patch.colorScheme);
  void writeJson(PREFS_KEY, next);
}

export function resetPreferences() {
  const next = { ...DEFAULT_PREFS };
  prefsState.set(next);
  setColorScheme(next.colorScheme);
  void writeJson(PREFS_KEY, next);
}
