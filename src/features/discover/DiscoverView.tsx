import { signal, View, Text, List, Image, Scroll } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Button, DramaListRow, FilterChip, PosterCard, SearchField, StatusView } from "../../ui/controls";
import { catalog, refreshCatalog } from "../../catalog-store";
import { hasService } from "../../service-client";
import { isFavorite, isSubscribed, subscriptions, toggleFavorite, toggleSubscription } from "../../stores/user-data";
import {
  categoryError, categoryFilters, categoryHasMore, categoryItems, categoryLoading, categorySelectors,
  clearOnlineSearch, closeDetail, detailState, discoverQuery, discoverSection, loadCategoryFeed,
  loadRankFeed, onlineError, onlineHasMore, onlineLoading, onlineResults, openDramaDetail,
  rankError, rankHasMore, rankItems, rankLoading, rankType, runOnlineSearch,
  type RankType, type SearchDramaItem,
} from "./discover-store";

export type { SearchDramaItem } from "./discover-store";

type SearchMode = "catalog" | "online" | "app-category" | "app-rank";
const RANK_TYPES = [
  { id: "hot-drama", label: "全部" },
  { id: "hot-real-drama", label: "真人剧" },
  { id: "hot-comic-drama", label: "漫剧" },
  { id: "hot-ai-drama", label: "AI剧" },
] satisfies { id: RankType; label: string }[];

function getShanghaiDates() {
  const result: { key: string; label: string; week: string }[] = [];
  for (let i = -7; i < 8; i++) {
    const date = new Date(Date.now() + i * 86400000 + 8 * 3600000);
    result.push({
      key: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`,
      label: `${date.getUTCMonth() + 1}/${date.getUTCDate()}`,
      week: i === 0 ? "今天" : ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getUTCDay()],
    });
  }
  return result;
}

function PageTab(props: { label: string; selected: boolean; onPress: () => void }) {
  return <BaseButton onPress={props.onPress} class={props.selected ? "px-3 py-2 border-b-2 border-primary focus:border-ring" : "px-3 py-2 border-b-2 border-background hover:opacity-80 focus:border-ring"}>
    <Text class={props.selected ? "text-sm font-semibold text-foreground" : "text-sm text-muted-foreground"}>{props.label}</Text>
  </BaseButton>;
}

export function DiscoverView(props: {
  mode: "recommend" | "discover" | "rank" | "new" | "calendar";
  onPlay: (seriesId: string, episodeId?: string) => void;
  onCalendar?: () => void;
  onNew?: () => void;
}) {
  const query = discoverQuery;
  const section = discoverSection;
  const defaultMode = (): SearchMode => {
    if (props.mode === "rank") return "app-rank";
    if (props.mode === "new") return "app-category";
    if (hasService() && props.mode === "discover") return "app-category";
    return "catalog";
  };
  const searchMode = signal<SearchMode>(defaultMode());
  const dates = getShanghaiDates();
  const selectedDate = signal(dates[7].key);
  const filtersExpanded = signal(true);
  const availableWidth = signal(1100);
  const gridColumns = () => Math.max(1, Math.floor((availableWidth() + 16) / 160));
  const posterWidth = () => Math.max(100, Math.floor(availableWidth() / gridColumns()) - 16);
  const isGrid = () => props.mode !== "rank" && props.mode !== "calendar";

  if (searchMode() === "app-rank") {
    if (!rankItems().length && !rankLoading()) void loadRankFeed(false);
  } else if (searchMode() === "app-category") {
    if (props.mode === "new") void loadCategoryFeed(false, { sort: "online_time", onlineTime: "days_7" });
    else if (!categoryItems().length && !categoryLoading()) void loadCategoryFeed(false, { sort: "hot_score", onlineTime: "" });
  } else if (props.mode !== "calendar" && catalog().kind === "idle") void refreshCatalog();

  const sections = () => { const state = catalog(); return state.kind === "ready" ? state.sections : []; };
  const catalogRows = (): SearchDramaItem[] => {
    const seen = new Set<string>();
    return sections().filter(item => section() === "全部" || item.name === section()).flatMap(item => item.dramas)
      .filter(item => !seen.has(item.id) && !!seen.add(item.id) && item.title.includes(query().trim()));
  };
  const rows = (): SearchDramaItem[] => {
    if (props.mode === "calendar") return subscriptions().map(item => ({ id: item.seriesId, title: item.title, cover: item.cover, episodes: item.episodes }));
    if (searchMode() === "online") return onlineResults();
    if (searchMode() === "app-category") return categoryItems();
    if (searchMode() === "app-rank") return rankItems();
    return catalogRows();
  };
  const loading = () => searchMode() === "online" ? onlineLoading() : searchMode() === "app-category" ? categoryLoading() : searchMode() === "app-rank" ? rankLoading() : catalog().kind === "loading";
  const error = () => {
    if (props.mode === "calendar") return "";
    if (searchMode() === "online") return onlineError();
    if (searchMode() === "app-category") return categoryError();
    if (searchMode() === "app-rank") return rankError();
    const state = catalog(); return state.kind === "error" ? state.message : "";
  };
  const hasMore = () => searchMode() === "online" ? onlineHasMore() : searchMode() === "app-category" ? categoryHasMore() : searchMode() === "app-rank" ? rankHasMore() : false;
  const refresh = () => {
    if (searchMode() === "online") void runOnlineSearch(false);
    else if (searchMode() === "app-category") void loadCategoryFeed(false);
    else if (searchMode() === "app-rank") void loadRankFeed(false);
    else void refreshCatalog();
  };
  const loadMore = () => {
    if (searchMode() === "online") void runOnlineSearch(true);
    else if (searchMode() === "app-category") void loadCategoryFeed(true);
    else if (searchMode() === "app-rank") void loadRankFeed(true);
  };
  const search = () => {
    if (hasService() && query().trim()) { searchMode.set("online"); void runOnlineSearch(false); }
    else { searchMode.set(defaultMode()); if (searchMode() === "app-category") void loadCategoryFeed(false); }
  };
  const openDetail = (seriesId: string, title: string) => void openDramaDetail(seriesId, title);
  const selectFilter = (type: string, value: string) => {
    if (type === "genre") void loadCategoryFeed(false, { genre: value });
    else if (type === "sort") void loadCategoryFeed(false, { sort: value });
    else if (type === "category_dim_theme") void loadCategoryFeed(false, { theme: value });
    else if (type === "category_dim_role") void loadCategoryFeed(false, { role: value });
    else if (type === "category_dim_epoch") void loadCategoryFeed(false, { epoch: value });
    else if (type === "gender") void loadCategoryFeed(false, { gender: value });
    else if (type === "online_time") void loadCategoryFeed(false, { onlineTime: value });
  };
  const filterSelected = (type: string, value: string) => {
    const filters = categoryFilters();
    if (type === "genre") return filters.genre === value;
    if (type === "sort") return filters.sort === value;
    if (type === "category_dim_theme") return filters.theme === value;
    if (type === "category_dim_role") return filters.role === value;
    if (type === "category_dim_epoch") return filters.epoch === value;
    if (type === "gender") return filters.gender === value;
    if (type === "online_time") return filters.onlineTime === value;
    return false;
  };
  const subtitle = (item: SearchDramaItem) => item.tags?.length ? item.tags.slice(0, 4).join(" · ") : `全${item.episodes}集`;

  return <View class="flex-1 gap-4" onLayout={({ bounds }) => availableWidth.set(Math.max(1, bounds.size.width))}>
    <View class="flex-row items-center justify-between gap-4 flex-wrap">
      <View class="flex-row items-center gap-4">
        <Text class="text-xl font-semibold text-foreground">{props.mode === "rank" ? "排行榜" : props.mode === "new" || props.mode === "calendar" ? "新剧" : "找剧"}</Text>
        <If when={props.mode === "rank"}>
          <View class="flex-row gap-2"><Each of={RANK_TYPES}>{item => <PageTab label={item().label} selected={rankType() === item().id} onPress={() => { searchMode.set("app-rank"); void loadRankFeed(false, item().id); }} />}</Each></View>
        </If>
        <If when={props.mode === "new" || props.mode === "calendar"}>
          <View class="flex-row gap-2">
            <PageTab label="新剧推荐" selected={props.mode === "new"} onPress={() => props.onNew?.()} />
            <PageTab label="上新日历" selected={props.mode === "calendar"} onPress={() => props.onCalendar?.()} />
          </View>
        </If>
      </View>
      <If when={props.mode === "discover" || props.mode === "recommend"}>
        <View style={{ width: Math.min(480, Math.max(240, availableWidth() * 0.45)) }}>
          <SearchField value={query()} onChange={value => query.set(value)} placeholder="输入剧名 / 关键词" submitLabel="搜索" onSubmit={search} onClear={() => { query.set(""); clearOnlineSearch(); searchMode.set(defaultMode()); }} />
        </View>
      </If>
      <If when={props.mode === "new"}>
        <View class="flex-row gap-1"><FilterChip label="全部" selected={filterSelected("gender", "")} onPress={() => selectFilter("gender", "")} /><Each of={categorySelectors().find(group => group.type === "gender")?.items ?? []}>{item => <FilterChip label={item().label} selected={filterSelected("gender", item().id)} onPress={() => selectFilter("gender", item().id)} />}</Each></View>
      </If>
    </View>
      <If when={detailState().kind !== "closed"}>
        <View class="bg-card border border-border rounded-xl p-4 gap-3">
          <If when={detailState().kind === "loading"}>
            <View class="flex-row items-center justify-between">
              <Text class="text-sm text-muted-foreground">正在加载剧集详情…</Text>
              <Button label="关闭" variant="ghost" size="sm" onPress={closeDetail} />
            </View>
          </If>
          <If when={detailState().kind === "error"}>
            {() => {
              const st = detailState();
              const msg = st.kind === "error" ? st.message : "";
              const sid = st.kind === "error" ? st.seriesId : "";
              return (
                <View class="flex-row items-center justify-between gap-2">
                  <Text class="text-sm text-destructive">{msg}</Text>
                  <View class="flex-row gap-2">
                    <Button label="直接播放" variant="primary" size="sm" onPress={() => props.onPlay(sid)} />
                    <Button label="关闭" variant="ghost" size="sm" onPress={closeDetail} />
                  </View>
                </View>
              );
            }}
          </If>
          <If when={detailState().kind === "ready"}>
            {() => {
              const st = detailState();
              if (st.kind !== "ready") return <View />;
              const d = st.detail;
              return (
                <View class="gap-3">
                  <View class="flex-row gap-4">
                    <If when={!!d.cover}>
                      <Image src={d.cover} style={{ width: 84, height: 120, borderRadius: 8 }} />
                    </If>
                    <View class="flex-1 gap-1.5">
                      <View class="flex-row items-center justify-between">
                        <Text class="text-base font-semibold text-foreground">{d.title}</Text>
                        <Button label="关闭" variant="ghost" size="sm" onPress={closeDetail} />
                      </View>
                      <Text class="text-xs text-muted-foreground">
                        全{d.episodes.length}集 {d.tags.length ? `· ${d.tags.slice(0, 4).join(" / ")}` : ""}
                      </Text>
                      <If when={!!d.intro}>
                        <Text class="text-xs text-muted-foreground">{d.intro}</Text>
                      </If>
                      <View class="flex-row items-center gap-2 pt-1">
                        <Button
                          label="立即播放第1集"
                          variant="primary"
                          size="sm"
                          onPress={() => {
                            closeDetail();
                            props.onPlay(d.seriesId, d.episodes[0]?.episodeId);
                          }}
                        />
                        <Button
                          label={isFavorite(d.seriesId) ? "已收藏" : "收藏"}
                          variant="outline"
                          size="sm"
                          onPress={() =>
                            toggleFavorite({
                              seriesId: d.seriesId,
                              title: d.title,
                              cover: d.cover,
                              episodes: d.episodes.length,
                            })
                          }
                        />
                        <Button
                          label={isSubscribed(d.seriesId) ? "已追更" : "追更"}
                          variant="outline"
                          size="sm"
                          onPress={() =>
                            toggleSubscription({
                              seriesId: d.seriesId,
                              title: d.title,
                              cover: d.cover,
                              episodes: d.episodes.length,
                            })
                          }
                        />
                      </View>
                    </View>
                  </View>
                  <If when={d.episodes.length > 0}>
                    <View class="gap-1.5 pt-1 border-t border-border">
                      <Text class="text-xs text-muted-foreground">选集快捷播放（共 {d.episodes.length} 集）</Text>
                      <List
                        horizontal
                        each={d.episodes}
                        keyExtractor={ep => ep.episodeId}
                        estimatedItemSize={72}
                        style={{ height: 36 }}
                      >
                        {ep => (
                          <Button
                            label={`第${ep().index}集`}
                            variant="outline"
                            size="sm"
                            class="mr-1.5"
                            onPress={() => {
                              closeDetail();
                              props.onPlay(d.seriesId, ep().episodeId);
                            }}
                          />
                        )}
                      </List>
                    </View>
                  </If>
                </View>
              );
            }}
          </If>
        </View>
      </If>

    <If when={props.mode === "calendar"}>
      <View class="gap-4">
        <Scroll horizontal scrollbar={false} style={{ height: 60 }}>
          <View class="flex-row gap-2"><Each of={dates}>{date => <BaseButton onPress={() => selectedDate.set(date().key)} class={selectedDate() === date().key ? "w-16 rounded-lg bg-primary border border-primary py-2 gap-1 items-center" : "w-16 rounded-lg bg-card border border-border py-2 gap-1 items-center hover:bg-muted"}>
            <Text class={selectedDate() === date().key ? "text-xs text-primary-foreground" : "text-xs text-muted-foreground"}>{date().week}</Text>
            <Text class={selectedDate() === date().key ? "text-sm font-semibold text-primary-foreground" : "text-sm font-semibold text-foreground"}>{date().label}</Text>
          </BaseButton>}</Each></View>
        </Scroll>
        <Text class="text-sm text-muted-foreground">该日期的上新信息暂不可用</Text>
        <If when={rows().length > 0}><Text class="text-base font-semibold text-foreground">我的预约</Text></If>
      </View>
    </If>

    <If when={props.mode === "discover" || props.mode === "recommend"}>
      <View class="flex-row items-center justify-end">
        <Button label={filtersExpanded() ? "收起筛选" : "展开筛选"} size="sm" onPress={() => filtersExpanded.set(!filtersExpanded())} />
      </View>
      <If when={filtersExpanded() && searchMode() === "app-category"}>
        <Scroll style={{ maxHeight: 460 }}>
          <View class="gap-1">
            <Each of={categorySelectors()} key={group => group.type}>{group => <View class="flex-row items-start gap-3">
              <Text class="text-xs text-muted-foreground w-10 pt-2">{group().label}</Text>
              <View class="flex-1 flex-row flex-wrap gap-1">
                <If when={group().type !== "genre" && group().type !== "sort"}><FilterChip label="全部" selected={filterSelected(group().type, "")} onPress={() => selectFilter(group().type, "")} /></If>
                <Each of={group().items} key={item => item.id}>{item => <FilterChip label={item().label} selected={filterSelected(group().type, item().id)} onPress={() => selectFilter(group().type, item().id)} />}</Each>
              </View>
            </View>}</Each>
          </View>
        </Scroll>
      </If>
      <If when={filtersExpanded() && searchMode() === "catalog"}>
        <View class="flex-row items-start gap-3">
          <Text class="text-xs text-muted-foreground w-10 pt-2">分类</Text>
          <View class="flex-1 flex-row flex-wrap gap-1"><FilterChip label="全部" selected={section() === "全部"} onPress={() => section.set("全部")} /><Each of={sections()} key={item => item.name}>{item => <FilterChip label={item().name} selected={section() === item().name} onPress={() => section.set(item().name)} />}</Each></View>
        </View>
      </If>
      <If when={searchMode() === "online"}>
        <View class="flex-row items-center justify-between"><Text class="text-sm text-muted-foreground">搜索结果</Text><Button label="返回片库" size="sm" onPress={() => { query.set(""); clearOnlineSearch(); searchMode.set(defaultMode()); }} /></View>
      </If>
    </If>

    <View class="flex-1 flex-row gap-5">
      <If when={props.mode === "rank"}>
        <View class="w-24 gap-2 pt-1">
          <BaseButton class="rounded-lg bg-selection px-3 py-3 items-center" onPress={() => { searchMode.set("app-rank"); refresh(); }}><Text class="text-sm font-semibold text-primary">热播榜</Text></BaseButton>
          <Button label="刷新" size="sm" onPress={refresh} disabled={loading()} />
        </View>
      </If>
      <View class="flex-1 gap-3">
        <If when={props.mode === "rank"}><View class="flex-row items-center justify-between"><Text class="text-base font-semibold text-foreground">热播榜</Text><Text class="text-xs text-muted-foreground">{RANK_TYPES.find(item => item.id === rankType())?.label ?? "全部"}</Text></View></If>
        <If when={loading() && rows().length === 0}><StatusView kind="loading" message="正在加载…" /></If>
        <If when={!!error()}>
          <View class="gap-2"><StatusView kind="error" message={error()} actionLabel="重试" onAction={refresh} />
            <If when={searchMode() !== "catalog"}><Button label="浏览公开片库" size="sm" onPress={() => { searchMode.set("catalog"); void refreshCatalog(); }} /></If>
          </View>
        </If>
        <If when={!loading() && !error() && rows().length === 0}>
          <StatusView kind="empty" message={props.mode === "calendar" ? "暂无本地预约" : "没有匹配的短剧"} />
        </If>
        <If when={rows().length > 0 && isGrid()}>
          <List testID="discover-grid" each={rows()} keyExtractor={item => item.id} numColumns={gridColumns()} estimatedItemSize={posterWidth() * 1.5 + 84} class="flex-1">
            {item => <View style={{ paddingRight: 16, paddingBottom: 20 }}>
              <PosterCard width={posterWidth()} title={item().title} cover={item().cover} subtitle={subtitle(item())} badge={item().score ? `${item().score}分` : item().badge} actionLabel="播放" actionTestID={`play-${item().id}`} onAction={() => props.onPlay(item().id)} secondaryLabel="详情" onSecondary={() => openDetail(item().id, item().title)} />
            </View>}
          </List>
        </If>
        <If when={rows().length > 0 && !isGrid()}>
          <List testID="discover-list" each={rows()} keyExtractor={item => item.id} estimatedItemSize={150} class="flex-1">
            {(item, index) => <DramaListRow rank={props.mode === "rank" ? index() + 1 : undefined} title={item().title} cover={item().cover} subtitle={`${item().episodes ? `全${item().episodes}集` : "短剧"}${item().tags?.length ? ` · ${item().tags?.slice(0, 4).join(" · ")}` : ""}`} rating={item().score ? `${item().score}分` : item().badge} actionLabel="播放" actionTestID={`play-${item().id}`} onAction={() => props.onPlay(item().id)} secondaryLabel={props.mode === "calendar" ? "取消预约" : "详情"} onSecondary={() => props.mode === "calendar" ? toggleSubscription({ seriesId: item().id, title: item().title, cover: item().cover, episodes: item().episodes }) : openDetail(item().id, item().title)} />}
          </List>
        </If>
        <If when={hasMore()}><Button label={loading() ? "加载中…" : "加载更多"} size="sm" disabled={loading()} onPress={loadMore} /></If>
      </View>
    </View>
  </View>;
}
