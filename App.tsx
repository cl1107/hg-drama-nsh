import { mount, signal, Text, View, Video, cleanup, setColorScheme, colorScheme, type VideoRef } from "nsh";
import { Input } from "nsh/base";
import { Button, PageHeader, SidebarItem } from "./src/ui/controls";
import { cancelCatalog } from "./src/catalog-store";
import { Player } from "./src/features/player/Player";
import { cancelPlayback, startOfflinePlayback, startPlayback } from "./src/features/player/session";
import { DiscoverView } from "./src/features/discover/DiscoverView";
import { HistoryView } from "./src/features/history/HistoryView";
import { DownloadsView } from "./src/features/downloads/DownloadsView";
import { currentAccount, LoginView, refreshAccountStatus } from "./src/features/auth/LoginView";
import { SettingsView } from "./src/features/settings/SettingsView";
import { getSavedProgress, loadUserData, preferences } from "./src/stores/user-data";

const DISCOVER_NAV = [
  { key: "推荐", short: "推" },
  { key: "找剧", short: "找" },
  { key: "排行榜", short: "榜" },
  { key: "新剧", short: "新" },
  { key: "上新日历", short: "历" },
];

const MINE_NAV = [
  { key: "历史/收藏/点赞", short: "史" },
  { key: "追更/预约", short: "追" },
  { key: "下载", short: "下" },
];

function App() {
  const page = signal("找剧");
  const previousPage = signal("找剧");
  const collapsed = signal(false);
  const toast = signal("");

  // Media probe state (kept for direct HTTPS stream testing)
  const videoUrl = signal("");
  const draftUrl = signal("");
  const videoError = signal("");
  const paused = signal(false);
  const position = signal(0);
  const duration = signal(0);
  let probePlayer: VideoRef | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  void loadUserData("guest");
  void refreshAccountStatus();

  const notify = (msg: string) => {
    toast.set(msg);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.set(""), 3500);
  };

  const navigate = (next: string) => {
    if (page() === "短剧播放" && next !== "短剧播放") {
      cancelPlayback();
    }
    if (next !== "短剧播放") {
      previousPage.set(next);
    }
    page.set(next);
    paused.set(true);
  };

  const openPlayer = (seriesId: string, episodeId?: string, positionSec?: number) => {
    if (page() !== "短剧播放") {
      previousPage.set(page());
    }
    page.set("短剧播放");
    const saved = !episodeId ? getSavedProgress(seriesId) : undefined;
    const targetEpisode = episodeId ?? saved?.episodeId;
    const targetPos = positionSec ?? (saved && !saved.completed ? saved.positionSec : 0);
    void startPlayback(seriesId, targetEpisode, preferences().defaultQuality, targetPos);
  };

  const openOfflinePlayer = (downloadId: string, seriesId: string, episodeId: string) => {
    if (page() !== "短剧播放") {
      previousPage.set(page());
    }
    page.set("短剧播放");
    void startOfflinePlayback(downloadId, seriesId, episodeId);
  };

  cleanup(() => {
    cancelCatalog();
    cancelPlayback();
    if (toastTimer) clearTimeout(toastTimer);
  });

  const playProbe = () => {
    try {
      const url = new URL(draftUrl().trim());
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new Error("请输入 HTTPS 视频地址");
      }
      videoError.set("");
      videoUrl.set(url.href);
      paused.set(false);
    } catch {
      videoError.set("请输入有效的 HTTPS 视频地址");
    }
  };

  return (
    <View class="flex-1 flex-row bg-background">
      <View style={{ width: collapsed() ? 68 : 208 }} class="bg-sidebar border-r border-border p-3 gap-1.5">
        <Button
          label={collapsed() ? "展开" : "‹ 收起"}
          variant="outline"
          size="sm"
          onPress={() => collapsed.set(!collapsed())}
        />
        <Text class="text-muted-foreground text-xs px-3 pt-3 pb-1">{collapsed() ? "·" : "发现"}</Text>
        <Each of={DISCOVER_NAV}>
          {item => (
            <SidebarItem
              label={item().key}
              shortLabel={item().short}
              collapsed={collapsed()}
              selected={page() === item().key}
              onPress={() => navigate(item().key)}
            />
          )}
        </Each>

        <Text class="text-muted-foreground text-xs px-3 pt-3 pb-1">{collapsed() ? "·" : "我的"}</Text>
        <Each of={MINE_NAV}>
          {item => (
            <SidebarItem
              label={item().key}
              shortLabel={item().short}
              collapsed={collapsed()}
              selected={page() === item().key}
              onPress={() => navigate(item().key)}
            />
          )}
        </Each>

        <View class="flex-1" />

        <SidebarItem
          label="播放探针"
          shortLabel="播"
          collapsed={collapsed()}
          selected={page() === "播放探针"}
          onPress={() => navigate("播放探针")}
        />
        <SidebarItem
          label="设置"
          shortLabel="设"
          collapsed={collapsed()}
          selected={page() === "设置"}
          onPress={() => navigate("设置")}
        />
        <SidebarItem
          label={currentAccount()?.nickname ?? "我的 / 登录"}
          shortLabel="我"
          collapsed={collapsed()}
          selected={page() === "登录"}
          onPress={() => navigate("登录")}
        />
      </View>

      <View class="flex-1 p-6 gap-4">
        <PageHeader
          title={page()}
          actions={
            <View class="flex-row items-center gap-2">
              <If when={!!toast()}>
                <Text class="text-xs text-primary px-2">{toast()}</Text>
              </If>
              <Button
                label={colorScheme() === "dark" ? "浅色" : "深色"}
                variant="outline"
                size="sm"
                onPress={() => setColorScheme(colorScheme() === "dark" ? "light" : "dark")}
              />
            </View>
          }
        />

        <If when={page() === "推荐"}>
          <DiscoverView mode="recommend" onPlay={openPlayer} />
        </If>
        <If when={page() === "找剧"}>
          <DiscoverView mode="discover" onPlay={openPlayer} />
        </If>
        <If when={page() === "排行榜"}>
          <DiscoverView mode="rank" onPlay={openPlayer} />
        </If>
        <If when={page() === "新剧"}>
          <DiscoverView mode="new" onPlay={openPlayer} />
        </If>
        <If when={page() === "上新日历"}>
          <DiscoverView mode="calendar" onPlay={openPlayer} />
        </If>
        <If when={page() === "历史/收藏/点赞"}>
          <HistoryView initialTab="history" onPlay={openPlayer} />
        </If>
        <If when={page() === "追更/预约"}>
          <HistoryView initialTab="subscriptions" onPlay={openPlayer} />
        </If>
        <If when={page() === "下载"}>
          <DownloadsView onPlayOffline={openOfflinePlayer} />
        </If>
        <If when={page() === "登录"}>
          <LoginView />
        </If>
        <If when={page() === "设置"}>
          <SettingsView onNotify={notify} />
        </If>
        <If when={page() === "短剧播放"}>
          <Player onBack={() => navigate(previousPage())} onNotify={notify} />
        </If>
        <If when={page() === "播放探针"}>
          <View class="flex-1 gap-4">
            <View class="flex-row gap-3">
              <Input
                class="flex-1 bg-card border border-input rounded-lg px-3.5 py-2.5 text-sm text-foreground"
                value={draftUrl()}
                onChange={({ value }) => draftUrl.set(value)}
                placeholder="HTTPS 视频地址"
              />
              <Button label="播放" variant="primary" onPress={playProbe} />
            </View>
            <If when={!!videoUrl()}>
              <Video
                ref={node => {
                  probePlayer = node;
                }}
                src={videoUrl()}
                paused={paused()}
                controls
                class="flex-1"
                onProgress={e => {
                  position.set(e.currentTime);
                  duration.set(e.duration);
                }}
                onError={e => videoError.set(e.message)}
              />
            </If>
            <If when={!!videoError()}>
              <Text class="text-sm text-destructive">{videoError()}</Text>
            </If>
            <View class="flex-row gap-3 items-center">
              <Button label={paused() ? "继续" : "暂停"} variant="outline" size="sm" onPress={() => paused.set(!paused())} />
              <Button
                label="前进 10 秒"
                variant="outline"
                size="sm"
                onPress={() => probePlayer?.seek(Math.min(duration(), position() + 10))}
              />
              <Text class="text-xs text-muted-foreground">
                {Math.floor(position())} / {Math.floor(duration())} 秒
              </Text>
            </View>
          </View>
        </If>
      </View>
    </View>
  );
}

mount(App);
