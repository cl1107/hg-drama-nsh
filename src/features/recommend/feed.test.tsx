import { expect, test } from "nsh/test";
import { createRecommendationFeed, parseRecommendationPage } from "./feed";
const page = (items: unknown[], hasMore = false, nextOffset = 0) => ({ items, hasMore, nextOffset, sessionId: "fixture-session" });
const drama = (id: string) => ({ id, title: `剧集${id}`, cover: "", episodes: 12, tags: ["都市"] });
test("recommendation contracts preserve IDs, deduplicate, and reject missing main fields", () => {
 const data = parseRecommendationPage(page([drama("7503745441910017049"),drama("7503745441910017049")]));
 expect(data.items.length).toBe(1);
 expect(data.items[0].id).toBe("7503745441910017049");
 expect(() => parseRecommendationPage(page([{...drama("1"),episodes:undefined}]))).toThrow();
 expect(() => parseRecommendationPage({...page([]),hasMore:undefined})).toThrow();
 expect(() => parseRecommendationPage(page([{...drama("1"),tags:[1]}]))).toThrow();
});
test("late previous channel response cannot replace current real-drama feed", async () => {
 let resolveOld: ((value: unknown) => void) | undefined;
 let oldSignal: AbortSignal | undefined;
 const feed = createRecommendationFeed((body, signal) => {
  if(body.rankType === "hot-drama") { oldSignal = signal; return new Promise(resolve => resolveOld = resolve); }
  return Promise.resolve(page([drama("2")]));
 });
 const old = feed.load("推荐");
 await feed.load("真人剧");
 expect(oldSignal?.aborted).toBe(true);
 resolveOld?.(page([drama("1")])); await old;
 expect(feed.items().map(item => item.id)).toEqual(["2"]);
 expect(feed.channel()).toBe("真人剧");
});
test("appending follows cursor, deduplicates, and cancellation leaves no stale loading", async () => {
 const offsets: unknown[] = [];
 const feed = createRecommendationFeed(async body => {
  offsets.push(body.offset);
  return body.offset === 0 ? page([drama("1")],true,20) : page([drama("1"),drama("2")]);
 });
 await feed.load("推荐"); await feed.load("推荐",true);
 expect(offsets).toEqual([0,20]);
 expect(feed.items().map(item => item.id)).toEqual(["1","2"]);
 expect(feed.more()).toBe(false);
 feed.cancel();expect(feed.loading()).toBe(false);
});
test("source failure stays visible rather than looking like an empty successful feed", async () => {
 const feed = createRecommendationFeed(async () => {throw new Error("推荐源暂不可用");});
 expect(await feed.load("推荐")).toBe(false);
 expect(feed.error()).toBe("推荐源暂不可用");
 expect(feed.loading()).toBe(false);
 feed.cancel(); expect(feed.error()).toBe("");
});
