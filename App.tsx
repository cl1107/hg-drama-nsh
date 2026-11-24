import { mount, signal, Text, View, cleanup, colorScheme } from "nsh";
import { PageHeader, SidebarIconButton, SidebarItem } from "./src/ui/controls";
import { type IconName } from "./src/ui/icons";
import { cancelCatalog } from "./src/catalog-store";
import { Player } from "./src/features/player/Player";
import { isVideoFullscreen } from "./src/features/player/GlobalPlayer";
import { cancelPlayback, startOfflinePlayback, startPlayback } from "./src/features/player/session";
import { openDramaDetail } from "./src/features/discover/discover-store";
import { DramaHomeView } from "./src/features/discover/DramaHomeView";
import { RecommendView } from "./src/features/recommend/RecommendView";
import { DiscoverView } from "./src/features/discover/DiscoverView";
import { HistoryView } from "./src/features/history/HistoryView";
import { DownloadsView } from "./src/features/downloads/DownloadsView";
import { currentAccount, LoginView, refreshAccountStatus } from "./src/features/auth/LoginView";
import { SettingsView } from "./src/features/settings/SettingsView";
import { getSavedProgress, loadUserData, preferences, updatePreferences } from "./src/stores/user-data";

const DISCOVER_NAV: { key: string; icon: IconName }[] = [
  { key: "推荐", icon: "compass" }, { key: "找剧", icon: "search" },
  { key: "排行榜", icon: "cup" }, { key: "新剧", icon: "spark" },
];
const MINE_NAV: { key: string; icon: IconName }[] = [
  { key: "历史/收藏/点赞", icon: "history" }, { key: "追更/预约", icon: "bell" }, { key: "下载", icon: "download" },
];
function App() {
  const page = signal("推荐");
  const previousPage = signal("推荐");
  const collapsed = () => preferences().sidebarCollapsed;
  const toast = signal("");
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  void loadUserData("guest").then(() => refreshAccountStatus());
  const notify = (message: string) => {
    toast.set(message);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.set(""), 3500);
  };
  const navigate = (next: string) => {
    if (page() === "短剧播放" && next !== "短剧播放") cancelPlayback();
    if (next !== "短剧播放") previousPage.set(next);
    page.set(next);
  };
  const openPlayer = (seriesId: string, episodeId?: string, positionSec?: number) => {
    if (page() !== "短剧播放") previousPage.set(page());
    page.set("短剧播放");
    const saved = !episodeId ? getSavedProgress(seriesId) : undefined;
    void startPlayback(seriesId, episodeId ?? saved?.episodeId, preferences().defaultQuality,
      positionSec ?? (saved && !saved.completed ? saved.positionSec : 0));
  };
  const openOfflinePlayer = (downloadId: string, seriesId: string, episodeId: string) => {
    if (page() !== "短剧播放") previousPage.set(page());
    page.set("短剧播放");
    void startOfflinePlayback(downloadId, seriesId, episodeId);
  };
  const openHome = (seriesId: string, title?: string) => {
    if (page() !== "剧集主页") previousPage.set(page());
    page.set("剧集主页");
    void openDramaDetail(seriesId, title ?? "");
  };
  cleanup(() => { cancelCatalog(); cancelPlayback(); if (toastTimer) clearTimeout(toastTimer); });
  const hasOwnHeading = () => ["推荐", "找剧", "排行榜", "新剧", "上新日历", "登录", "剧集主页"].includes(page());
  return <View class="flex-1 flex-row bg-background">
    <If when={!isVideoFullscreen()}>
      <View
        style={{ width: collapsed() ? 64 : 220 }}
        class={`bg-sidebar border-r border-border pb-3 ${collapsed() ? "px-2.5" : "px-3"}`}
      >
        <View desktop={{ windowDrag: true }} class="h-9 shrink-0" />
        <View class={collapsed() ? "mb-2" : "h-9 flex-row items-center justify-between pl-2.5 mb-2"}>
          <If when={!collapsed()}>
            <View class="flex-row items-center gap-2.5">
              <View class="items-center justify-center" style={{ width: 18, height: 18 }}>
                <View class="rounded-full bg-primary" style={{ width: 8, height: 8 }} />
              </View>
              <Text class="text-sm font-medium text-foreground">红果短剧</Text>
            </View>
          </If>
          <SidebarIconButton
            icon={collapsed() ? "chevron-right" : "chevron-left"}
            label={collapsed() ? "展开侧栏" : "收起侧栏"}
            testID="sidebar-toggle"
            collapsed={collapsed()}
            onPress={() => updatePreferences({ sidebarCollapsed: !collapsed() })}
          />
        </View>
        <View class="gap-0.5">
          <If when={!collapsed()}>
            <Text class="text-xs font-medium text-muted-foreground opacity-65 px-2.5 pt-2 pb-1.5">发现</Text>
          </If>
          <Each of={DISCOVER_NAV}>
            {item => (
              <SidebarItem
                label={item().key}
                shortLabel={item().key.slice(0, 1)}
                icon={item().icon}
                collapsed={collapsed()}
                selected={page() === item().key || (item().key === "新剧" && page() === "上新日历")}
                onPress={() => navigate(item().key)}
              />
            )}
          </Each>
        </View>
        <If when={collapsed()}>
          <View class="mx-2 my-2 bg-border opacity-60" style={{ height: 1 }} />
        </If>
        <View class="gap-0.5">
          <If when={!collapsed()}>
            <Text class="text-xs font-medium text-muted-foreground opacity-65 px-2.5 pt-5 pb-1.5">我的</Text>
          </If>
          <Each of={MINE_NAV}>
            {item => (
              <SidebarItem
                label={item().key}
                shortLabel={item().key.slice(0, 1)}
                icon={item().icon}
                collapsed={collapsed()}
                selected={page() === item().key}
                onPress={() => navigate(item().key)}
              />
            )}
          </Each>
        </View>
        <View class="flex-1" />
        <View class="border-t border-border/60 pt-2.5 mt-2 gap-1">
          <View class={collapsed() ? "gap-1" : "flex-row items-center gap-1.5"}>
            <SidebarItem
              label="设置"
              shortLabel="设"
              icon="settings"
              collapsed={collapsed()}
              selected={page() === "设置"}
              class={collapsed() ? undefined : "flex-1"}
              onPress={() => navigate("设置")}
            />
            <SidebarIconButton
              icon={colorScheme() === "dark" ? "sun" : "moon"}
              label={colorScheme() === "dark" ? "切换到浅色模式" : "切换到深色模式"}
              collapsed={collapsed()}
              onPress={() => updatePreferences({ colorScheme: colorScheme() === "dark" ? "light" : "dark" })}
            />
          </View>
          <SidebarItem
            label={currentAccount()?.nickname ?? "我的 / 登录"}
            shortLabel="我"
            icon="user"
            collapsed={collapsed()}
            selected={page() === "登录"}
            onPress={() => navigate("登录")}
          />
        </View>
      </View>
    </If>
    <View class="flex-1 relative">
      <If when={!isVideoFullscreen()}><View desktop={{ windowDrag: true }} class="absolute top-0 left-0 right-0 h-6" /></If>
      <If when={page() === "推荐"}><RecommendView onNotify={notify} onFind={() => navigate("找剧")} onLogin={() => navigate("登录")} /></If>
      <If when={page() !== "推荐"}>
        <View class={isVideoFullscreen() ? "flex-1" : "flex-1 p-6 gap-4"}>
          <If when={!hasOwnHeading() && !isVideoFullscreen()}><PageHeader title={page()} /></If>
          <If when={page() === "找剧"}><DiscoverView mode="discover" onPlay={openPlayer} onHome={openHome} /></If>
          <If when={page() === "排行榜"}><DiscoverView mode="rank" onPlay={openPlayer} onHome={openHome} /></If>
          <If when={page() === "新剧"}><DiscoverView mode="new" onPlay={openPlayer} onHome={openHome} onCalendar={() => navigate("上新日历")} onNew={() => navigate("新剧")} /></If>
          <If when={page() === "上新日历"}><DiscoverView mode="calendar" onPlay={openPlayer} onHome={openHome} onNew={() => navigate("新剧")} /></If>
          <If when={page() === "历史/收藏/点赞"}><HistoryView initialTab="history" onPlay={openPlayer} /></If>
          <If when={page() === "追更/预约"}><HistoryView initialTab="subscriptions" onPlay={openPlayer} /></If>
          <If when={page() === "下载"}><DownloadsView onPlayOffline={openOfflinePlayer} /></If>
          <If when={page() === "登录"}><LoginView /></If>
          <If when={page() === "设置"}><SettingsView onNotify={notify} /></If>
          <If when={page() === "短剧播放"}><Player onBack={() => navigate(previousPage())} onNotify={notify} /></If>
          <If when={page() === "剧集主页"}><DramaHomeView onPlay={openPlayer} onBack={() => navigate(previousPage())} onNotify={notify} /></If>
        </View>
      </If>
      <If when={!!toast()}><View class="absolute bottom-20 self-center rounded-lg bg-card border border-border px-4 py-3"><Text class="text-sm text-foreground">{toast()}</Text></View></If>
    </View>
  </View>;
}
mount(App);
