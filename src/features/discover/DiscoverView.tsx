import { signal, View, Text, List, Image } from "nsh";
import { Button, DramaListRow, FilterChip, SearchField, StatusView } from "../../ui/controls";
import { catalog, refreshCatalog } from "../../catalog-store";
import { servicePost } from "../../service-client";
import { isFavorite, isSubscribed, toggleFavorite, toggleSubscription } from "../../stores/user-data";

export interface SearchDramaItem {
  id: string;
  title: string;
  cover: string;
  episodes: number;
  score?: string;
  tags?: string[];
}

interface DramaDetail {
  seriesId: string;
  title: string;
  cover: string;
  intro: string;
  tags: string[];
  episodes: { episodeId: string; index: number }[];
}

function getShanghaiDates(count = 7): { key: string; label: string }[] {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const result: { key: string; label: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    const dt = new Date(now + i * dayMs + 8 * 60 * 60 * 1000);
    const m = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    const key = `${dt.getUTCFullYear()}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    result.push({ key, label: i === 0 ? `今天 ${m}/${d}` : `${m}/${d}` });
  }
  return result;
}

export function DiscoverView(props: {
  mode: "recommend" | "discover" | "rank" | "new" | "calendar";
  onPlay: (seriesId: string, episodeId?: string) => void;
}) {
  const query = signal("");
  const section = signal("全部");
  const searchMode = signal<"catalog" | "online">("catalog");
  const onlineResults = signal<SearchDramaItem[]>([]);
  const onlineLoading = signal(false);
  const onlineError = signal("");
  const onlineHasMore = signal(false);
  const onlinePage = signal(1);
  const onlineCursor = signal<Record<string, unknown> | null>(null);
  const selectedDate = signal(getShanghaiDates(1)[0].key);

  const detailState = signal<
    | { kind: "closed" }
    | { kind: "loading"; title: string }
    | { kind: "ready"; detail: DramaDetail }
    | { kind: "error"; message: string; seriesId: string }
  >({ kind: "closed" });

  let searchGen = 0;

  const sections = () => {
    const current = catalog();
    return current.kind === "ready" ? current.sections : [];
  };

  const catalogRows = () => {
    const seen = new Set<string>();
    const kw = query().trim();
    return sections()
      .filter(s => section() === "全部" || s.name === section())
      .flatMap(s => s.dramas)
      .filter(d => !seen.has(d.id) && !!seen.add(d.id) && (!kw || d.title.includes(kw)));
  };

  const runOnlineSearch = async (append = false) => {
    const kw = query().trim();
    if (!kw) {
      onlineError.set("请输入搜索关键词");
      return;
    }
    const gen = ++searchGen;
    const nextPage = append ? onlinePage() + 1 : 1;
    onlineLoading.set(true);
    onlineError.set("");
    try {
      const res = await servicePost<{
        items: SearchDramaItem[];
        hasMore: boolean;
        cursor: Record<string, unknown> | null;
      }>("/search", {
        keyword: kw,
        page: nextPage,
        cursor: append ? onlineCursor() : null,
      });
      if (gen !== searchGen) return;
      onlinePage.set(nextPage);
      onlineHasMore.set(Boolean(res.hasMore));
      onlineCursor.set(res.cursor ?? null);
      onlineResults.set(append ? [...onlineResults(), ...res.items] : res.items);
    } catch (e) {
      if (gen !== searchGen) return;
      onlineError.set(e instanceof Error ? e.message : "在线搜索失败");
    } finally {
      if (gen === searchGen) onlineLoading.set(false);
    }
  };

  const openDetail = async (seriesId: string, title: string) => {
    detailState.set({ kind: "loading", title });
    try {
      const detail = await servicePost<DramaDetail>("/detail", { seriesId });
      detailState.set({ kind: "ready", detail });
    } catch (e) {
      detailState.set({
        kind: "error",
        message: e instanceof Error ? e.message : "详情加载失败",
        seriesId,
      });
    }
  };

  const dates = getShanghaiDates(7);

  return (
    <View class="flex-1 gap-4">
      <If when={detailState().kind !== "closed"}>
        <View class="bg-card border border-border rounded-xl p-4 gap-3">
          <If when={detailState().kind === "loading"}>
            <View class="flex-row items-center justify-between">
              <Text class="text-sm text-muted-foreground">正在加载剧集详情…</Text>
              <Button label="关闭" variant="ghost" size="sm" onPress={() => detailState.set({ kind: "closed" })} />
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
                    <Button label="关闭" variant="ghost" size="sm" onPress={() => detailState.set({ kind: "closed" })} />
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
                        <Button label="关闭" variant="ghost" size="sm" onPress={() => detailState.set({ kind: "closed" })} />
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
                            detailState.set({ kind: "closed" });
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
                </View>
              );
            }}
          </If>
        </View>
      </If>

      <If when={props.mode === "calendar"}>
        <View class="gap-2">
          <View class="flex-row gap-2 flex-wrap">
            <Each of={dates}>
              {d => (
                <FilterChip
                  label={d().label}
                  selected={selectedDate() === d().key}
                  onPress={() => selectedDate.set(d().key)}
                />
              )}
            </Each>
          </View>
          <Text class="text-xs text-muted-foreground">
            当前展示官网公开剧集与本地预约状态（云端上新日历接口待补全）
          </Text>
        </View>
      </If>

      <View class="flex-row items-center gap-2">
        <View class="flex-1">
          <SearchField
            value={query()}
            onChange={val => query.set(val)}
            onClear={() => {
              query.set("");
              onlineResults.set([]);
              onlineError.set("");
            }}
            onSubmit={searchMode() === "online" ? () => void runOnlineSearch(false) : undefined}
            placeholder={searchMode() === "online" ? "输入关键词进行 App 在线搜索" : "搜索已加载的官网目录"}
            submitLabel="在线搜索"
          />
        </View>
        <Button label="加载官网目录" variant="outline" onPress={() => void refreshCatalog()} />
      </View>

      <View class="flex-row items-center justify-between gap-2 flex-wrap">
        <View class="flex-row gap-2 flex-wrap">
          <FilterChip
            label="全部"
            selected={searchMode() === "catalog" && section() === "全部"}
            onPress={() => {
              searchMode.set("catalog");
              section.set("全部");
            }}
          />
          <Each of={sections()} key={s => s.name}>
            {s => (
              <FilterChip
                label={s().name}
                selected={searchMode() === "catalog" && section() === s().name}
                onPress={() => {
                  searchMode.set("catalog");
                  section.set(s().name);
                }}
              />
            )}
          </Each>
        </View>
        <View class="flex-row gap-1.5">
          <FilterChip
            label="目录筛选"
            selected={searchMode() === "catalog"}
            onPress={() => searchMode.set("catalog")}
          />
          <FilterChip
            label="App 搜索"
            selected={searchMode() === "online"}
            onPress={() => searchMode.set("online")}
          />
        </View>
      </View>

      <If when={searchMode() === "online"}>
        <View class="flex-1 gap-2">
          <If when={onlineLoading() && onlineResults().length === 0}>
            <StatusView kind="loading" message="正在搜索 App 片库…" />
          </If>
          <If when={!!onlineError()}>
            <StatusView kind="error" message={onlineError()} actionLabel="重试" onAction={() => void runOnlineSearch(false)} />
          </If>
          <If when={!onlineLoading() && !onlineError() && onlineResults().length === 0}>
            <StatusView kind="empty" message="输入关键词后点击“在线搜索”查询 App 片库" />
          </If>
          <If when={onlineResults().length > 0}>
            <List each={onlineResults()} keyExtractor={d => d.id} estimatedItemSize={124} class="flex-1">
              {item => (
                <DramaListRow
                  title={item().title}
                  cover={item().cover}
                  subtitle={`${item().episodes ? `全${item().episodes}集` : "短剧"}${item().tags?.length ? ` · ${item().tags!.slice(0, 3).join(" / ")}` : ""}`}
                  rating={item().score ? `${item().score} 分` : undefined}
                  actionLabel="播放"
                  actionTestID={`play-${item().id}`}
                  onAction={() => props.onPlay(item().id)}
                  secondaryLabel="详情"
                  onSecondary={() => void openDetail(item().id, item().title)}
                />
              )}
            </List>
          </If>
          <If when={onlineHasMore()}>
            <Button
              label={onlineLoading() ? "加载中…" : "加载更多"}
              variant="outline"
              disabled={onlineLoading()}
              onPress={() => void runOnlineSearch(true)}
            />
          </If>
        </View>
      </If>

      <If when={searchMode() === "catalog"}>
        <View class="flex-1">
          <If when={catalog().kind === "idle"}>
            <StatusView
              kind="empty"
              message="加载红果官网公开目录，查看当前短剧"
            />
          </If>
          <If when={catalog().kind === "loading"}>
            <StatusView kind="loading" message="正在加载…" />
          </If>
          <If when={catalog().kind === "error"}>
            {() => {
              const current = catalog();
              return (
                <StatusView
                  kind="error"
                  message={current.kind === "error" ? current.message : "目录加载失败"}
                  actionLabel="重试"
                  onAction={() => void refreshCatalog()}
                />
              );
            }}
          </If>
          <If when={catalog().kind === "ready" && catalogRows().length === 0}>
            <StatusView kind="empty" message="没有匹配的短剧" />
          </If>
          <If when={catalog().kind === "ready" && catalogRows().length > 0}>
            <List each={catalogRows()} keyExtractor={d => d.id} estimatedItemSize={124} class="flex-1">
              {(drama, index) => (
                <DramaListRow
                  rank={props.mode === "rank" ? index() + 1 : undefined}
                  title={drama().title}
                  cover={drama().cover}
                  subtitle={`全${drama().episodes}集`}
                  actionLabel="播放"
                  actionTestID={`play-${drama().id}`}
                  onAction={() => props.onPlay(drama().id)}
                  secondaryLabel={props.mode === "calendar" ? (isSubscribed(drama().id) ? "已预约" : "预约") : "详情"}
                  onSecondary={() =>
                    props.mode === "calendar"
                      ? toggleSubscription({
                          seriesId: drama().id,
                          title: drama().title,
                          cover: drama().cover,
                          episodes: drama().episodes,
                        })
                      : void openDetail(drama().id, drama().title)
                  }
                />
              )}
            </List>
          </If>
        </View>
      </If>
    </View>
  );
}
