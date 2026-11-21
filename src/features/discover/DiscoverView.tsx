import { signal, View, Text, List, Image, Scroll } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Button, DramaListRow, FilterChip, PosterCard, SearchField, StatusView } from "../../ui/controls";
import { catalog, refreshCatalog } from "../../catalog-store";
import { hasService } from "../../service-client";
import { isSubscribed, subscriptions, toggleSubscription } from "../../stores/user-data";
import {
  categoryError, categoryFilters, categoryHasMore, categoryItems, categoryLoading, categorySelectors,
  clearOnlineSearch, discoverQuery, discoverSearchMode, discoverSection, loadCategoryFeed,
  loadRankFeed, onlineError, onlineHasMore, onlineLoading, onlineResults,
  rankError, rankHasMore, rankItems, rankLoading, rankOuterTab, rankSelectors, rankSubTab, rankSubTitle, runOnlineSearch,
  type SearchDramaItem,
} from "./discover-store";

export type { SearchDramaItem } from "./discover-store";

type SearchMode = "catalog" | "online" | "app-category" | "app-rank";
// 热门搜词：均为 App 分类接口真实存在的题材/角色枚举，点击即按该词在线搜索。
const HOT_SEARCHES = ["都市", "逆袭", "悬疑", "甜宠", "古装", "战神"];

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
  onHome: (seriesId: string, title: string) => void;
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
  const isDiscover = props.mode === "discover";
  const localSearchMode = signal<SearchMode>(defaultMode());
  const searchMode = (): SearchMode => isDiscover ? (discoverSearchMode() === "online" ? "online" : defaultMode()) : localSearchMode();
  const setSearchMode = (next: SearchMode) => {
    if (isDiscover) discoverSearchMode.set(next);
    else localSearchMode.set(next);
  };
  const dates = getShanghaiDates();
  const selectedDate = signal(dates[7].key);
  const filtersExpanded = signal(true);
  const availableWidth = signal(1100);
  const availableHeight = signal(760);
  // 筛选面板最多占视口高度的 45%（封顶 460、保底 120），窗口再小也让结果区保有一席之地。
  const filtersMaxHeight = () => Math.max(120, Math.min(460, Math.floor(availableHeight() * 0.45)));
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
    if (hasService() && query().trim()) { setSearchMode("online"); void runOnlineSearch(false); }
    else { setSearchMode(defaultMode()); if (searchMode() === "app-category") void loadCategoryFeed(false); }
  };
  const backToFilters = () => {
    query.set("");
    clearOnlineSearch();
    setSearchMode(defaultMode());
    if (searchMode() === "app-category" && !categoryItems().length && !categoryLoading()) void loadCategoryFeed(false);
  };
  const openHome = (seriesId: string, title: string) => props.onHome(seriesId, title);
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
  const currentRankGroup = () => rankSelectors().find(g => g.id === rankOuterTab()) ?? rankSelectors()[0];
  const currentRankSub = () => currentRankGroup()?.items.find(s => s.id === rankSubTab()) ?? currentRankGroup()?.items[0];
  const selectRankOuter = (outerId: string) => {
    const group = rankSelectors().find(g => g.id === outerId);
    if (!group || !group.items.length) return;
    const prevLabel = currentRankSub()?.label;
    const nextSub = group.items.find(s => s.label === prevLabel)
      ?? group.items.find(s => s.id.includes("hot_play"))
      ?? group.items[0];
    setSearchMode("app-rank");
    void loadRankFeed(false, { outerTab: group.id, subTab: nextSub.id });
  };
  const subtitle = (item: SearchDramaItem) => item.tags?.length ? item.tags.slice(0, 4).join(" · ") : `全${item.episodes}集`;

  return <View class="flex-1 gap-4" onLayout={({ bounds }) => { availableWidth.set(Math.max(1, bounds.size.width)); availableHeight.set(Math.max(1, bounds.size.height)); }}>
    <View class="flex-row items-center justify-between gap-4 flex-wrap">
      <View class="flex-row items-center gap-4">
        <Text class="text-xl font-semibold text-foreground">{props.mode === "rank" ? "排行榜" : props.mode === "new" || props.mode === "calendar" ? "新剧" : "找剧"}</Text>
        <If when={props.mode === "rank"}>
          <View class="flex-row gap-2">
            <Each of={rankSelectors()}>{group => <PageTab label={group().label} selected={rankOuterTab() === group().id} onPress={() => selectRankOuter(group().id)} />}</Each>
          </View>
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
          <SearchField value={query()} onChange={value => query.set(value)} placeholder="输入剧名 / 关键词" submitLabel="搜索" onSubmit={search} onClear={backToFilters} />
        </View>
      </If>
      <If when={props.mode === "new"}>
        <View class="flex-row gap-1"><FilterChip label="全部" selected={filterSelected("gender", "")} onPress={() => selectFilter("gender", "")} /><Each of={categorySelectors().find(group => group.type === "gender")?.items ?? []}>{item => <FilterChip label={item().label} selected={filterSelected("gender", item().id)} onPress={() => selectFilter("gender", item().id)} />}</Each></View>
      </If>
    </View>
    <If when={searchMode() === "online" && (props.mode === "discover" || props.mode === "recommend")}>
      <View class="flex-row items-center gap-2 flex-wrap">
        <Text class="text-sm text-foreground">搜索 "{query().trim()}"</Text>
        <Button label="返回筛选" variant="ghost" size="sm" onPress={backToFilters} />
        <Text class="text-xs text-muted-foreground ml-2">热门:</Text>
        <Each of={HOT_SEARCHES}>{kw => <FilterChip label={kw()} selected={query().trim() === kw()} onPress={() => { query.set(kw()); setSearchMode("online"); void runOnlineSearch(false); }} />}</Each>
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
        <Scroll style={{ maxHeight: filtersMaxHeight(), minHeight: 120, flexShrink: 1 }}>
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
    </If>

    <View class="flex-1 flex-row gap-5" style={{ minHeight: 0, flexShrink: 1 }}>
      <If when={props.mode === "rank"}>
        <View class="w-40 shrink-0 gap-1">
          <Each of={currentRankGroup()?.items ?? []}>{item => <BaseButton onPress={() => { setSearchMode("app-rank"); void loadRankFeed(false, { outerTab: rankOuterTab(), subTab: item().id }); }} class={rankSubTab() === item().id ? "rounded-lg bg-selection px-3 h-10 flex-row items-center" : "rounded-lg px-3 h-10 flex-row items-center hover:bg-muted"}>
            <Text class={rankSubTab() === item().id ? "text-sm font-medium text-primary" : "text-sm text-muted-foreground"}>{item().label}</Text>
          </BaseButton>}</Each>
          <View class="pt-2"><Button label="刷新" size="sm" variant="outline" onPress={refresh} disabled={loading()} /></View>
        </View>
      </If>
      <View class="flex-1 gap-3">
        <If when={props.mode === "rank"}><View class="flex-row items-center justify-between gap-3"><Text class="text-base font-semibold text-foreground">{currentRankSub()?.label ?? "热播榜"}</Text><Text class="text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>{rankSubTitle() || currentRankGroup()?.label || "全部"}</Text></View></If>
        <If when={loading() && rows().length === 0}><StatusView kind="loading" message="正在加载…" /></If>
        <If when={!!error()}>
          <View class="gap-2"><StatusView kind="error" message={error()} actionLabel="重试" onAction={refresh} />
            <If when={searchMode() !== "catalog"}><Button label="浏览公开片库" size="sm" onPress={() => { setSearchMode("catalog"); void refreshCatalog(); }} /></If>
          </View>
        </If>
        <If when={!loading() && !error() && rows().length === 0}>
          <StatusView kind="empty" message={props.mode === "calendar" ? "暂无本地预约" : "没有匹配的短剧"} />
        </If>
        <If when={rows().length > 0 && isGrid()}>
          <List testID="discover-grid" each={rows()} keyExtractor={item => item.id} numColumns={gridColumns()} estimatedItemSize={posterWidth() * 1.5 + 92} class="flex-1">
            {item => <View style={{ paddingRight: 16, paddingBottom: 20 }}>
              <PosterCard width={posterWidth()} title={item().title} cover={item().cover} subtitle={subtitle(item())} badge={item().score ? `${item().score}分` : item().badge} tagsLine={item().tags?.slice(0, 4).join(" · ")} actionLabel="播放" actionTestID={`play-${item().id}`} onAction={() => props.onPlay(item().id)} onHome={() => openHome(item().id, item().title)} />
            </View>}
          </List>
        </If>
        <If when={rows().length > 0 && !isGrid()}>
          <List testID="discover-list" each={rows()} keyExtractor={item => item.id} estimatedItemSize={150} class="flex-1">
            {(item, index) => <DramaListRow rank={props.mode === "rank" ? index() + 1 : undefined} title={item().title} cover={item().cover} subtitle={`${item().episodes ? `全${item().episodes}集` : "短剧"}${item().tags?.length ? ` · ${item().tags?.slice(0, 4).join(" · ")}` : ""}`} rating={item().score ? `${item().score}分` : item().badge} actionLabel="播放" actionTestID={`play-${item().id}`} onAction={() => props.onPlay(item().id)} secondaryLabel={props.mode === "calendar" ? "取消预约" : "详情"} onSecondary={() => props.mode === "calendar" ? toggleSubscription({ seriesId: item().id, title: item().title, cover: item().cover, episodes: item().episodes }) : openHome(item().id, item().title)} />}
          </List>
        </If>
        <If when={hasMore()}><Button label={loading() ? "加载中…" : "加载更多"} size="sm" disabled={loading()} onPress={loadMore} /></If>
      </View>
    </View>
  </View>;
}
