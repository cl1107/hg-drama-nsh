import { signal } from "nsh";
import { servicePost } from "../../service-client";

export interface SearchDramaItem {
  id: string;
  title: string;
  cover: string;
  episodes: number;
  score?: string;
  tags?: string[];
  badge?: string;
}

export interface SelectorOption {
  id: string;
  label: string;
}

export interface SelectorGroup {
  type: string;
  label: string;
  items: SelectorOption[];
}

export interface DramaDetail {
  seriesId: string;
  title: string;
  cover: string;
  intro: string;
  tags: string[];
  episodes: { episodeId: string; index: number }[];
}

export type DetailState =
  | { kind: "closed" }
  | { kind: "loading"; title: string }
  | { kind: "ready"; detail: DramaDetail }
  | { kind: "error"; message: string; seriesId: string };

export const discoverQuery = signal("");
export const discoverSection = signal("全部");
export const discoverSearchMode = signal<"catalog" | "online" | "app-category" | "app-rank">("catalog");
export const onlineResults = signal<SearchDramaItem[]>([]);
export const onlineLoading = signal(false);
export const onlineError = signal("");
export const onlineHasMore = signal(false);
export const onlinePage = signal(1);
export const onlineCursor = signal<Record<string, unknown> | null>(null);
export const detailState = signal<DetailState>({ kind: "closed" });

// App category / new-release state
export type RankType = "hot-drama" | "hot-real-drama" | "hot-comic-drama" | "hot-ai-drama";
export const categoryItems = signal<SearchDramaItem[]>([]);
export const categorySelectors = signal<SelectorGroup[]>([]);
export const categoryLoading = signal(false);
export const categoryError = signal("");
export const categoryHasMore = signal(false);
export const categoryOffset = signal(0);
export const categorySessionId = signal("");
export const categoryFilters = signal<{
  genre: string;
  theme: string;
  role: string;
  epoch: string;
  sort: string;
  gender: string;
  onlineTime: string;
}>({
  genre: "short_play",
  theme: "",
  role: "",
  epoch: "",
  sort: "hot_score",
  gender: "",
  onlineTime: "",
});

// App rank state
export const rankType = signal<RankType>("hot-drama");
export const rankItems = signal<SearchDramaItem[]>([]);
export const rankLoading = signal(false);
export const rankError = signal("");
export const rankHasMore = signal(false);
export const rankOffset = signal(0);
export const rankSessionId = signal("");

let searchGen = 0;
let searchController: AbortController | undefined;
let detailGen = 0;
let detailController: AbortController | undefined;
let categoryGen = 0;
let categoryController: AbortController | undefined;
let rankGen = 0;
let rankController: AbortController | undefined;

export function cancelOnlineSearch() {
  searchGen += 1;
  searchController?.abort();
  searchController = undefined;
  onlineLoading.set(false);
}

export function clearOnlineSearch() {
  cancelOnlineSearch();
  onlineResults.set([]);
  onlineError.set("");
  onlineHasMore.set(false);
  onlinePage.set(1);
  onlineCursor.set(null);
}

export async function runOnlineSearch(append = false) {
  const kw = discoverQuery().trim();
  if (!kw) {
    onlineError.set("请输入搜索关键词");
    return;
  }
  searchController?.abort();
  const controller = new AbortController();
  searchController = controller;
  const gen = ++searchGen;
  const nextPage = append ? onlinePage() + 1 : 1;
  onlineLoading.set(true);
  onlineError.set("");
  try {
    const res = await servicePost<{
      items: SearchDramaItem[];
      hasMore: boolean;
      cursor: Record<string, unknown> | null;
    }>(
      "/search",
      {
        keyword: kw,
        page: nextPage,
        cursor: append ? onlineCursor() : null,
      },
      controller.signal,
    );
    if (gen !== searchGen || controller.signal.aborted) return;
    onlinePage.set(nextPage);
    onlineHasMore.set(Boolean(res.hasMore));
    onlineCursor.set(res.cursor ?? null);
    onlineResults.set(append ? [...onlineResults(), ...res.items] : res.items);
  } catch (e) {
    if (gen !== searchGen || controller.signal.aborted) return;
    onlineError.set(e instanceof Error ? e.message : "在线搜索失败");
  } finally {
    if (gen === searchGen) {
      onlineLoading.set(false);
      if (searchController === controller) searchController = undefined;
    }
  }
}

export function closeDetail() {
  detailGen += 1;
  detailController?.abort();
  detailController = undefined;
  detailState.set({ kind: "closed" });
}

export async function openDramaDetail(seriesId: string, title: string) {
  detailController?.abort();
  const controller = new AbortController();
  detailController = controller;
  const gen = ++detailGen;
  detailState.set({ kind: "loading", title });
  try {
    const detail = await servicePost<DramaDetail>("/detail", { seriesId }, controller.signal);
    if (gen !== detailGen || controller.signal.aborted) return;
    detailState.set({ kind: "ready", detail });
  } catch (e) {
    if (gen !== detailGen || controller.signal.aborted) return;
    detailState.set({
      kind: "error",
      message: e instanceof Error ? e.message : "详情加载失败",
      seriesId,
    });
  } finally {
    if (detailController === controller) detailController = undefined;
  }
}

export async function loadCategoryFeed(append = false, overrideFilters?: Partial<ReturnType<typeof categoryFilters>>) {
  if (overrideFilters) {
    categoryFilters.set({ ...categoryFilters(), ...overrideFilters });
  }
  categoryController?.abort();
  const controller = new AbortController();
  categoryController = controller;
  const gen = ++categoryGen;
  const f = categoryFilters();
  const offset = append ? categoryOffset() : 0;
  const sessionId = append ? categorySessionId() : "";
  categoryLoading.set(true);
  categoryError.set("");
  try {
    const res = await servicePost<{
      items: SearchDramaItem[];
      selectors: SelectorGroup[];
      hasMore: boolean;
      nextOffset: number;
      sessionId: string;
    }>(
      "/discover/category",
      {
        genre: f.genre,
        theme: f.theme,
        role: f.role,
        epoch: f.epoch,
        sort: f.sort,
        gender: f.gender,
        onlineTime: f.onlineTime,
        offset,
        sessionId,
        needSelectorPanel: offset === 0,
        limit: 20,
      },
      controller.signal,
    );
    if (gen !== categoryGen || controller.signal.aborted) return;
    if (res.selectors?.length) categorySelectors.set(res.selectors);
    categoryHasMore.set(Boolean(res.hasMore));
    categoryOffset.set(res.nextOffset ?? 0);
    categorySessionId.set(res.sessionId ?? "");
    categoryItems.set(append ? [...categoryItems(), ...res.items] : res.items);
  } catch (e) {
    if (gen !== categoryGen || controller.signal.aborted) return;
    categoryError.set(e instanceof Error ? e.message : "App 分类加载失败");
  } finally {
    if (gen === categoryGen) {
      categoryLoading.set(false);
      if (categoryController === controller) categoryController = undefined;
    }
  }
}

export async function loadRankFeed(append = false, nextType?: RankType) {
  if (nextType) rankType.set(nextType);
  rankController?.abort();
  const controller = new AbortController();
  rankController = controller;
  const gen = ++rankGen;
  const offset = append ? rankOffset() : 0;
  const sessionId = append ? rankSessionId() : "";
  rankLoading.set(true);
  rankError.set("");
  try {
    const res = await servicePost<{
      items: SearchDramaItem[];
      hasMore: boolean;
      nextOffset: number;
      sessionId: string;
    }>(
      "/discover/rank",
      {
        rankType: rankType(),
        offset,
        sessionId,
        limit: 20,
      },
      controller.signal,
    );
    if (gen !== rankGen || controller.signal.aborted) return;
    rankHasMore.set(Boolean(res.hasMore));
    rankOffset.set(res.nextOffset ?? 0);
    rankSessionId.set(res.sessionId ?? "");
    rankItems.set(append ? [...rankItems(), ...res.items] : res.items);
  } catch (e) {
    if (gen !== rankGen || controller.signal.aborted) return;
    rankError.set(e instanceof Error ? e.message : "App 榜单加载失败");
  } finally {
    if (gen === rankGen) {
      rankLoading.set(false);
      if (rankController === controller) rankController = undefined;
    }
  }
}
