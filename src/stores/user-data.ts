import { signal, Storage } from "nsh";

export type QualityOption = "auto" | "1080p" | "720p" | "540p" | "480p" | "360p";

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
}

const PREFS_KEY = "hg:prefs:v1";

const activeAccountKey = signal("guest");
const historyList = signal<HistoryItem[]>([]);
const favoriteList = signal<DramaSummary[]>([]);
const likeList = signal<DramaSummary[]>([]);
const subscriptionList = signal<DramaSummary[]>([]);
const prefsState = signal<AppPreferences>({
  defaultQuality: "auto",
  autoPlayNext: true,
});

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
    readJson<AppPreferences>(PREFS_KEY, { defaultQuality: "auto", autoPlayNext: true }),
  ]);
  historyList.set(Array.isArray(h) ? h : []);
  favoriteList.set(Array.isArray(f) ? f : []);
  likeList.set(Array.isArray(l) ? l : []);
  subscriptionList.set(Array.isArray(s) ? s : []);
  prefsState.set({
    defaultQuality: p?.defaultQuality || "auto",
    autoPlayNext: typeof p?.autoPlayNext === "boolean" ? p.autoPlayNext : true,
  });
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

export function updatePreferences(patch: Partial<AppPreferences>) {
  const next = { ...prefsState(), ...patch };
  prefsState.set(next);
  void writeJson(PREFS_KEY, next);
}
