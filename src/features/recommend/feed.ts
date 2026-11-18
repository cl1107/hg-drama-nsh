import { signal } from "nsh";
import { servicePost } from "../../service-client";
export type RecommendationChannel = "推荐" | "真人剧" | "漫剧";
export interface Recommendation { id: string; title: string; cover: string; episodes: number; tags: string[] }
interface Page { items: Recommendation[]; hasMore: boolean; nextOffset: number; sessionId: string }
function object(value: unknown): Record<string, unknown> {
 if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("推荐内容格式异常");
 return value as Record<string, unknown>;
}
export function parseRecommendationPage(value: unknown): Page {
 const page = object(value);
 if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean" || typeof page.nextOffset !== "number" || !Number.isSafeInteger(page.nextOffset) || page.nextOffset < 0 || typeof page.sessionId !== "string") throw new Error("推荐分页信息不完整");
 const seen = new Set<string>();
 const items = page.items.map(value => {
  const row = object(value);
  if (typeof row.id !== "string" || !/^\d{1,30}$/.test(row.id) || typeof row.title !== "string" || !row.title.trim() || typeof row.cover !== "string" || typeof row.episodes !== "number" || !Number.isInteger(row.episodes) || row.episodes < 0) throw new Error("推荐剧集信息不完整");
  if (row.tags !== undefined && (!Array.isArray(row.tags) || row.tags.some(tag => typeof tag !== "string"))) throw new Error("推荐标签格式异常");
  const tags = Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === "string") : [];
  return { id: row.id, title: row.title, cover: row.cover, episodes: row.episodes, tags };
 }).filter(item => !seen.has(item.id) && !!seen.add(item.id));
 return { items, hasMore: page.hasMore, nextOffset: page.nextOffset, sessionId: page.sessionId };
}
export function createRecommendationFeed(loadPage = (body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => servicePost("/discover/rank", body, signal)) {
 const items = signal<Recommendation[]>([]), loading = signal(false), error = signal("");
 let request: AbortController | undefined, generation = 0, offset = 0, sessionId = "", hasMore = true;
 let channel: RecommendationChannel = "推荐";
 async function load(nextChannel: RecommendationChannel, append = false): Promise<boolean> {
  if (append && (!hasMore || loading())) return false;
  request?.abort(); const controller = new AbortController(); request = controller; const gen = ++generation;
  channel = nextChannel; loading.set(true); error.set("");
  if (!append) { items.set([]); offset = 0; sessionId = ""; hasMore = true; }
  try {
   const page = parseRecommendationPage(await loadPage({ rankType: nextChannel === "真人剧" ? "hot-real-drama" : nextChannel === "漫剧" ? "hot-comic-drama" : "hot-drama", offset, sessionId, limit: 20 }, controller.signal));
   if (gen !== generation || controller.signal.aborted) return false;
   const existing = new Set(append ? items().map(item => item.id) : []);
   items.set(append ? [...items(), ...page.items.filter(item => !existing.has(item.id))] : page.items);
   offset = page.nextOffset; sessionId = page.sessionId; hasMore = page.hasMore;
   return true;
  } catch (failure) {
   if (gen === generation && !controller.signal.aborted) error.set(failure instanceof Error ? failure.message : "推荐内容加载失败");
   return false;
  } finally { if (gen === generation) loading.set(false); }
 }
 function cancel() { ++generation; request?.abort(); request = undefined; loading.set(false); error.set(""); }
 return { items, loading, error, load, cancel, more: () => hasMore, channel: () => channel };
}
