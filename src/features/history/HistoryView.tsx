import { signal, View, Text, List } from "nsh";
import { Button, DramaListRow, FilterChip, SearchField, StatusView } from "../../ui/controls";
import { serviceGet } from "../../service-client";
import { currentAccount } from "../auth/LoginView";
import {
  favorites,
  likes,
  removeHistoryItems,
  subscriptions,
  toggleFavorite,
  toggleLike,
  toggleSubscription,
  watchHistory,
} from "../../stores/user-data";

interface CloudHistoryItem {
  seriesId: string;
  title: string;
  cover: string;
  episodeId: string;
  episodeIndex: number;
  totalEpisodes: number;
}

export function HistoryView(props: {
  initialTab?: "history" | "cloud" | "favorites" | "likes" | "subscriptions";
  onPlay: (seriesId: string, episodeId?: string, positionSec?: number) => void;
}) {
  const tab = signal<"history" | "cloud" | "favorites" | "likes" | "subscriptions">(props.initialTab ?? "history");
  const filter = signal<"all" | "watching" | "completed">("all");
  const query = signal("");
  const managing = signal(false);
  const selectedIds = signal<string[]>([]);
  const cloudItems = signal<CloudHistoryItem[]>([]);
  const cloudLoading = signal(false);
  const cloudError = signal("");

  const loadCloudHistory = async () => {
    cloudLoading.set(true);
    cloudError.set("");
    try {
      const res = await serviceGet<{ items: CloudHistoryItem[] }>("/auth/cloud-history");
      cloudItems.set(Array.isArray(res.items) ? res.items : []);
    } catch (e) {
      cloudError.set(e instanceof Error ? e.message : "读取云端历史失败");
    } finally {
      cloudLoading.set(false);
    }
  };

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

  const filteredSummary = (list: ReturnType<typeof favorites>) => {
    const kw = query().trim();
    return kw ? list.filter(i => i.title.includes(kw)) : list;
  };

  const deleteSelectedHistory = () => {
    if (!selectedIds().length) return;
    removeHistoryItems(selectedIds());
    selectedIds.set([]);
    managing.set(false);
  };

  return (
    <View class="flex-1 gap-4">
      <View class="flex-row items-center justify-between gap-3 flex-wrap">
        <View class="flex-row gap-2">
          <FilterChip label={`历史 (${watchHistory().length})`} selected={tab() === "history"} onPress={() => tab.set("history")} />
          <FilterChip
            label="云端历史"
            selected={tab() === "cloud"}
            onPress={() => {
              tab.set("cloud");
              if (currentAccount()) void loadCloudHistory();
            }}
          />
          <FilterChip label={`收藏 (${favorites().length})`} selected={tab() === "favorites"} onPress={() => tab.set("favorites")} />
          <FilterChip label={`点赞 (${likes().length})`} selected={tab() === "likes"} onPress={() => tab.set("likes")} />
          <FilterChip label={`追更/预约 (${subscriptions().length})`} selected={tab() === "subscriptions"} onPress={() => tab.set("subscriptions")} />
        </View>
        <If when={tab() === "history" && watchHistory().length > 0}>
          <View class="flex-row gap-2">
            <If when={managing()}>
              <Button
                label={`删除所选 (${selectedIds().length})`}
                variant="destructive"
                size="sm"
                disabled={selectedIds().length === 0}
                onPress={deleteSelectedHistory}
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
        placeholder="搜索当前本地记录"
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
          <If when={!!currentAccount() && !cloudLoading() && !cloudError() && cloudItems().length === 0}>
            <StatusView kind="empty" message="暂无云端观看记录" />
          </If>
          <If when={!!currentAccount() && cloudItems().length > 0}>
            <List each={cloudItems()} keyExtractor={i => i.seriesId} estimatedItemSize={124} class="flex-1">
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
        <If when={filteredSummary(favorites()).length === 0}>
          <StatusView kind="empty" message="暂无本地收藏短剧" />
        </If>
        <If when={filteredSummary(favorites()).length > 0}>
          <List each={filteredSummary(favorites())} keyExtractor={i => i.seriesId} estimatedItemSize={124} class="flex-1">
            {item => (
              <DramaListRow
                title={item().title}
                cover={item().cover}
                subtitle={`全${item().episodes}集 · 本地收藏`}
                actionLabel="播放"
                onAction={() => props.onPlay(item().seriesId)}
                secondaryLabel="取消收藏"
                onSecondary={() =>
                  toggleFavorite({
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

      <If when={tab() === "likes"}>
        <If when={filteredSummary(likes()).length === 0}>
          <StatusView kind="empty" message="暂无本地点赞记录" />
        </If>
        <If when={filteredSummary(likes()).length > 0}>
          <List each={filteredSummary(likes())} keyExtractor={i => i.seriesId} estimatedItemSize={124} class="flex-1">
            {item => (
              <DramaListRow
                title={item().title}
                cover={item().cover}
                subtitle={`全${item().episodes}集 · 本地点赞`}
                actionLabel="播放"
                onAction={() => props.onPlay(item().seriesId)}
                secondaryLabel="取消点赞"
                onSecondary={() =>
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
        <If when={filteredSummary(subscriptions()).length === 0}>
          <StatusView kind="empty" message="暂无本地追更或预约记录" />
        </If>
        <If when={filteredSummary(subscriptions()).length > 0}>
          <List each={filteredSummary(subscriptions())} keyExtractor={i => i.seriesId} estimatedItemSize={124} class="flex-1">
            {item => (
              <DramaListRow
                title={item().title}
                cover={item().cover}
                subtitle={`全${item().episodes}集 · 本地追更`}
                actionLabel="播放"
                onAction={() => props.onPlay(item().seriesId)}
                secondaryLabel="取消追更"
                onSecondary={() =>
                  toggleSubscription({
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
    </View>
  );
}
