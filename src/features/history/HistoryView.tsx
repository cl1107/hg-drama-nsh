import { signal, View, Text, List } from "nsh";
import { Button, DramaListRow, FilterChip, SearchField, StatusView } from "../../ui/controls";
import { serviceGet } from "../../service-client";
import { currentAccount } from "../auth/LoginView";
import {
  favorites,
  likes,
  removeFavorites,
  removeHistoryItems,
  removeLikes,
  removeSubscriptions,
  subscriptions,
  toggleFavorite,
  toggleLike,
  toggleSubscription,
  watchHistory,
  type DramaSummary,
} from "../../stores/user-data";

interface CloudHistoryItem {
  seriesId: string;
  title: string;
  cover: string;
  episodeId: string;
  episodeIndex: number;
  totalEpisodes: number;
}

interface CloudBookshelfItem {
  seriesId: string;
  title: string;
  cover: string;
  episodes: number;
  collectTime?: number;
}

export function HistoryView(props: {
  initialTab?: "history" | "cloud" | "favorites" | "likes" | "subscriptions";
  onPlay: (seriesId: string, episodeId?: string, positionSec?: number) => void;
}) {
  const defaultTab =
    props.initialTab && props.initialTab !== "history"
      ? props.initialTab
      : currentAccount() && watchHistory().length === 0
        ? "cloud"
        : (props.initialTab ?? "history");

  const tab = signal<"history" | "cloud" | "favorites" | "likes" | "subscriptions">(defaultTab);
  const filter = signal<"all" | "watching" | "completed">("all");
  const query = signal("");
  const managing = signal(false);
  const selectedIds = signal<string[]>([]);
  const cloudItems = signal<CloudHistoryItem[]>([]);
  const cloudLoading = signal(false);
  const cloudError = signal("");
  const cloudShelf = signal<CloudBookshelfItem[]>([]);
  const shelfLoading = signal(false);
  const shelfError = signal("");
  let cloudAccountId = "";
  let cloudGen = 0;
  let shelfAccountId = "";
  let shelfGen = 0;

  const loadCloudHistory = async () => {
    const accountId = currentAccount()?.userId ?? "";
    if (!accountId) {
      cloudItems.set([]);
      cloudAccountId = "";
      return;
    }
    if (cloudAccountId && cloudAccountId !== accountId) {
      cloudItems.set([]);
    }
    cloudAccountId = accountId;
    const gen = ++cloudGen;
    cloudLoading.set(true);
    cloudError.set("");
    try {
      const res = await serviceGet<{ items: CloudHistoryItem[] }>("/auth/cloud-history");
      if (gen !== cloudGen || currentAccount()?.userId !== accountId) return;
      cloudItems.set(Array.isArray(res.items) ? res.items : []);
    } catch (e) {
      if (gen !== cloudGen) return;
      cloudError.set(e instanceof Error ? e.message : "读取云端历史失败");
    } finally {
      if (gen === cloudGen) cloudLoading.set(false);
    }
  };

  const loadCloudBookshelf = async () => {
    const accountId = currentAccount()?.userId ?? "";
    if (!accountId) {
      cloudShelf.set([]);
      shelfAccountId = "";
      return;
    }
    if (shelfAccountId && shelfAccountId !== accountId) {
      cloudShelf.set([]);
    }
    shelfAccountId = accountId;
    const gen = ++shelfGen;
    shelfLoading.set(true);
    shelfError.set("");
    try {
      const res = await serviceGet<{ items: CloudBookshelfItem[] }>("/auth/cloud-bookshelf");
      if (gen !== shelfGen || currentAccount()?.userId !== accountId) return;
      cloudShelf.set(Array.isArray(res.items) ? res.items : []);
    } catch (e) {
      if (gen !== shelfGen) return;
      shelfError.set(e instanceof Error ? e.message : "读取云端追更/收藏失败");
    } finally {
      if (gen === shelfGen) shelfLoading.set(false);
    }
  };

  if (currentAccount()) {
    void loadCloudHistory();
    void loadCloudBookshelf();
  }

  const toggleSelect = (id: string) => {
    const cur = selectedIds();
    selectedIds.set(cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]);
  };

  const filteredHistory = () => {
    const kw = query().trim();
    return watchHistory().filter(item => {
      if (filter() === "watching" && item.completed) return false;
      if (filter() === "completed" && !item.completed) return false;
      if (kw && !item.title.includes(kw)) return false;
      return true;
    });
  };

  const filteredCloudHistory = () => {
    const kw = query().trim();
    return kw ? cloudItems().filter(i => i.title.includes(kw)) : cloudItems();
  };

  const filteredSummary = (list: DramaSummary[]) => {
    const kw = query().trim();
    return kw ? list.filter(i => i.title.includes(kw)) : list;
  };

  const mergedShelfAndLocal = (localList: DramaSummary[], tag: string) => {
    const kw = query().trim();
    const seen = new Set<string>();
    const combined: { seriesId: string; title: string; cover: string; episodes: number; source: "cloud" | "local"; label: string }[] = [];
    for (const item of localList) {
      if (kw && !item.title.includes(kw)) continue;
      seen.add(item.seriesId);
      combined.push({ ...item, source: "local", label: `本地${tag}` });
    }
    if (currentAccount()) {
      for (const item of cloudShelf()) {
        if (seen.has(item.seriesId)) continue;
        if (kw && !item.title.includes(kw)) continue;
        seen.add(item.seriesId);
        combined.push({ ...item, source: "cloud", label: "云端书架" });
      }
    }
    return combined;
  };

  const deleteSelected = () => {
    const ids = selectedIds();
    if (!ids.length) return;
    if (tab() === "history") removeHistoryItems(ids);
    else if (tab() === "favorites") removeFavorites(ids);
    else if (tab() === "likes") removeLikes(ids);
    else if (tab() === "subscriptions") removeSubscriptions(ids);
    selectedIds.set([]);
    managing.set(false);
  };

  const currentLocalCount = () => {
    if (tab() === "history") return watchHistory().length;
    if (tab() === "favorites") return favorites().length;
    if (tab() === "likes") return likes().length;
    if (tab() === "subscriptions") return subscriptions().length;
    return 0;
  };

  const switchTab = (next: "history" | "cloud" | "favorites" | "likes" | "subscriptions") => {
    tab.set(next);
    managing.set(false);
    selectedIds.set([]);
    if (next === "cloud" && currentAccount()) void loadCloudHistory();
    if ((next === "favorites" || next === "subscriptions") && currentAccount()) void loadCloudBookshelf();
  };

  return (
    <View class="flex-1 gap-4">
      <View class="flex-row items-center justify-between gap-3 flex-wrap">
        <View class="flex-row gap-2 flex-wrap">
          <FilterChip label={`历史 (${watchHistory().length})`} selected={tab() === "history"} onPress={() => switchTab("history")} />
          <FilterChip
            label={currentAccount() && cloudItems().length > 0 ? `云端历史 (${cloudItems().length})` : "云端历史"}
            selected={tab() === "cloud"}
            onPress={() => switchTab("cloud")}
          />
          <FilterChip
            label={`收藏 (${favorites().length + (currentAccount() ? cloudShelf().filter(c => !favorites().some(f => f.seriesId === c.seriesId)).length : 0)})`}
            selected={tab() === "favorites"}
            onPress={() => switchTab("favorites")}
          />
          <FilterChip label={`点赞 (${likes().length})`} selected={tab() === "likes"} onPress={() => switchTab("likes")} />
          <FilterChip
            label={`追更/预约 (${subscriptions().length + (currentAccount() ? cloudShelf().filter(c => !subscriptions().some(s => s.seriesId === c.seriesId)).length : 0)})`}
            selected={tab() === "subscriptions"}
            onPress={() => switchTab("subscriptions")}
          />
        </View>
        <If when={tab() !== "cloud" && currentLocalCount() > 0}>
          <View class="flex-row gap-2">
            <If when={managing()}>
              <Button
                label={`删除所选 (${selectedIds().length})`}
                variant="destructive"
                size="sm"
                disabled={selectedIds().length === 0}
                onPress={deleteSelected}
              />
            </If>
            <Button
              label={managing() ? "完成" : "管理"}
              variant="outline"
              size="sm"
              onPress={() => {
                managing.set(!managing());
                selectedIds.set([]);
              }}
            />
          </View>
        </If>
      </View>

      <SearchField
        value={query()}
        onChange={val => query.set(val)}
        onClear={() => query.set("")}
        placeholder="搜索当前记录"
      />

      <If when={tab() === "history"}>
        <View class="flex-row items-center justify-between">
          <View class="flex-row gap-2">
            <FilterChip label="全部" selected={filter() === "all"} onPress={() => filter.set("all")} />
            <FilterChip label="未看完" selected={filter() === "watching"} onPress={() => filter.set("watching")} />
            <FilterChip label="已看完" selected={filter() === "completed"} onPress={() => filter.set("completed")} />
          </View>
          <Text class="text-xs text-muted-foreground">本地播放记录（删除不影响云端）</Text>
        </View>
        <If when={filteredHistory().length === 0}>
          <StatusView kind="empty" message="暂无本地观看历史" />
        </If>
        <If when={filteredHistory().length > 0}>
          <List each={filteredHistory()} keyExtractor={i => i.seriesId} estimatedItemSize={124} class="flex-1">
            {item => (
              <DramaListRow
                title={item().title}
                cover={item().cover}
                subtitle={`看到第 ${item().episodeIndex}/${item().totalEpisodes} 集 · ${Math.floor(item().positionSec)}秒${item().completed ? " · 已看完" : ""}`}
                actionLabel={managing() ? (selectedIds().includes(item().seriesId) ? "已选" : "选择") : "继续播放"}
                onAction={() =>
                  managing()
                    ? toggleSelect(item().seriesId)
                    : props.onPlay(item().seriesId, item().episodeId, item().positionSec)
                }
              />
            )}
          </List>
        </If>
      </If>

      <If when={tab() === "cloud"}>
        <View class="flex-1 gap-2">
          <View class="flex-row items-center justify-between">
            <Text class="text-xs text-muted-foreground">云端观看记录（只读同步，不影响本地记录）</Text>
            <If when={!!currentAccount()}>
              <Button label={cloudLoading() ? "同步中…" : "刷新"} variant="outline" size="sm" onPress={() => void loadCloudHistory()} />
            </If>
          </View>
          <If when={!currentAccount()}>
            <StatusView kind="empty" message="请先在“我的 / 登录”中登录账号后再查看云端历史" />
          </If>
          <If when={!!currentAccount() && cloudLoading() && cloudItems().length === 0}>
            <StatusView kind="loading" message="正在读取云端观看历史…" />
          </If>
          <If when={!!currentAccount() && !!cloudError()}>
            <StatusView kind="error" message={cloudError()} actionLabel="重试" onAction={() => void loadCloudHistory()} />
          </If>
          <If when={!!currentAccount() && !cloudLoading() && !cloudError() && filteredCloudHistory().length === 0}>
            <StatusView kind="empty" message="暂无云端观看记录" />
          </If>
          <If when={!!currentAccount() && filteredCloudHistory().length > 0}>
            <List each={filteredCloudHistory()} keyExtractor={i => i.seriesId} estimatedItemSize={124} class="flex-1">
              {item => (
                <DramaListRow
                  title={item().title}
                  cover={item().cover}
                  subtitle={`云端记录：第 ${item().episodeIndex}${item().totalEpisodes ? `/${item().totalEpisodes}` : ""} 集`}
                  actionLabel="播放"
                  onAction={() => props.onPlay(item().seriesId, item().episodeId || undefined)}
                />
              )}
            </List>
          </If>
        </View>
      </If>

      <If when={tab() === "favorites"}>
        <View class="flex-1 gap-2">
          <If when={!!currentAccount()}>
            <View class="flex-row items-center justify-between">
              <Text class="text-xs text-muted-foreground">展示本地收藏与云端书架短剧</Text>
              <Button label={shelfLoading() ? "同步中…" : "刷新云端"} variant="outline" size="sm" onPress={() => void loadCloudBookshelf()} />
            </View>
          </If>
          <If when={!!shelfError()}>
            <Text class="text-xs text-destructive">{shelfError()}</Text>
          </If>
          <If when={shelfLoading() && mergedShelfAndLocal(favorites(), "收藏").length === 0}>
            <StatusView kind="loading" message="正在读取云端收藏…" />
          </If>
          <If when={!shelfLoading() && mergedShelfAndLocal(favorites(), "收藏").length === 0}>
            <StatusView kind="empty" message="暂无收藏短剧" />
          </If>
          <If when={mergedShelfAndLocal(favorites(), "收藏").length > 0}>
            <List each={mergedShelfAndLocal(favorites(), "收藏")} keyExtractor={i => i.seriesId} estimatedItemSize={124} class="flex-1">
              {item => (
                <DramaListRow
                  title={item().title}
                  cover={item().cover}
                  subtitle={`${item().episodes ? `全${item().episodes}集 · ` : ""}${item().label}`}
                  actionLabel={managing() && item().source === "local" ? (selectedIds().includes(item().seriesId) ? "已选" : "选择") : "播放"}
                  onAction={() =>
                    managing() && item().source === "local"
                      ? toggleSelect(item().seriesId)
                      : props.onPlay(item().seriesId)
                  }
                  secondaryLabel={!managing() && item().source === "local" ? "取消收藏" : undefined}
                  onSecondary={
                    !managing() && item().source === "local"
                      ? () =>
                          toggleFavorite({
                            seriesId: item().seriesId,
                            title: item().title,
                            cover: item().cover,
                            episodes: item().episodes,
                          })
                      : undefined
                  }
                />
              )}
            </List>
          </If>
        </View>
      </If>

      <If when={tab() === "likes"}>
        <If when={filteredSummary(likes()).length === 0}>
          <StatusView kind="empty" message="暂无本地点赞记录（云端点赞列表接口待补全）" />
        </If>
        <If when={filteredSummary(likes()).length > 0}>
          <List each={filteredSummary(likes())} keyExtractor={i => i.seriesId} estimatedItemSize={124} class="flex-1">
            {item => (
              <DramaListRow
                title={item().title}
                cover={item().cover}
                subtitle={`全${item().episodes}集 · 本地点赞`}
                actionLabel={managing() ? (selectedIds().includes(item().seriesId) ? "已选" : "选择") : "播放"}
                onAction={() => (managing() ? toggleSelect(item().seriesId) : props.onPlay(item().seriesId))}
                secondaryLabel={managing() ? undefined : "取消点赞"}
                onSecondary={
                  managing()
                    ? undefined
                    : () =>
                        toggleLike({
                          seriesId: item().seriesId,
                          title: item().title,
                          cover: item().cover,
                          episodes: item().episodes,
                        })
                }
              />
            )}
          </List>
        </If>
      </If>

      <If when={tab() === "subscriptions"}>
        <View class="flex-1 gap-2">
          <If when={!!currentAccount()}>
            <View class="flex-row items-center justify-between">
              <Text class="text-xs text-muted-foreground">展示本地追更/预约与云端书架短剧</Text>
              <Button label={shelfLoading() ? "同步中…" : "刷新云端"} variant="outline" size="sm" onPress={() => void loadCloudBookshelf()} />
            </View>
          </If>
          <If when={!!shelfError()}>
            <Text class="text-xs text-destructive">{shelfError()}</Text>
          </If>
          <If when={shelfLoading() && mergedShelfAndLocal(subscriptions(), "追更").length === 0}>
            <StatusView kind="loading" message="正在读取云端追更…" />
          </If>
          <If when={!shelfLoading() && mergedShelfAndLocal(subscriptions(), "追更").length === 0}>
            <StatusView kind="empty" message="暂无追更或预约记录" />
          </If>
          <If when={mergedShelfAndLocal(subscriptions(), "追更").length > 0}>
            <List each={mergedShelfAndLocal(subscriptions(), "追更")} keyExtractor={i => i.seriesId} estimatedItemSize={124} class="flex-1">
              {item => (
                <DramaListRow
                  title={item().title}
                  cover={item().cover}
                  subtitle={`${item().episodes ? `全${item().episodes}集 · ` : ""}${item().label}`}
                  actionLabel={managing() && item().source === "local" ? (selectedIds().includes(item().seriesId) ? "已选" : "选择") : "播放"}
                  onAction={() =>
                    managing() && item().source === "local"
                      ? toggleSelect(item().seriesId)
                      : props.onPlay(item().seriesId)
                  }
                  secondaryLabel={!managing() && item().source === "local" ? "取消追更" : undefined}
                  onSecondary={
                    !managing() && item().source === "local"
                      ? () =>
                          toggleSubscription({
                            seriesId: item().seriesId,
                            title: item().title,
                            cover: item().cover,
                            episodes: item().episodes,
                          })
                      : undefined
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
