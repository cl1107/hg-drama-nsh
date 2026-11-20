import { mount, signal, Text, View, cleanup, colorScheme } from "nsh";
import { Button, PageHeader, SidebarItem } from "./src/ui/controls";
import { IconButton, type IconName } from "./src/ui/icons";
import { cancelCatalog } from "./src/catalog-store";
import { Player } from "./src/features/player/Player";
import { isVideoFullscreen } from "./src/features/player/GlobalPlayer";
import { cancelPlayback, startOfflinePlayback, startPlayback } from "./src/features/player/session";
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
  cleanup(() => { cancelCatalog(); cancelPlayback(); if (toastTimer) clearTimeout(toastTimer); });
  const hasOwnHeading = () => ["推荐", "找剧", "排行榜", "新剧", "上新日历", "登录"].includes(page());
  return <View class="flex-1 flex-row bg-background">
    <If when={!isVideoFullscreen()}>
      <View style={{ width: collapsed() ? 64 : 208 }} class="bg-sidebar border-r border-border px-2 py-3 gap-1">
        <Button label={collapsed() ? "展开" : "收起"} size="sm" class="items-start mb-4" onPress={() => updatePreferences({ sidebarCollapsed: !collapsed() })} />
        <If when={!collapsed()}><Text class="text-muted-foreground text-xs px-2 pt-3 pb-2">发现</Text></If>
        <Each of={DISCOVER_NAV}>{item => <SidebarItem label={item().key} shortLabel={item().key.slice(0,1)} icon={item().icon} collapsed={collapsed()} selected={page() === item().key || item().key === "新剧" && page() === "上新日历"} onPress={() => navigate(item().key)} />}</Each>
        <If when={!collapsed()}><Text class="text-muted-foreground text-xs px-2 pt-5 pb-2">我的</Text></If>
        <Each of={MINE_NAV}>{item => <SidebarItem label={item().key} shortLabel={item().key.slice(0,1)} icon={item().icon} collapsed={collapsed()} selected={page() === item().key} onPress={() => navigate(item().key)} />}</Each>
        <View class="flex-1" />
        <View class="flex-row items-center justify-between mb-2">
          <SidebarItem label="设置" shortLabel="设" icon="settings" collapsed={collapsed()} selected={page() === "设置"} onPress={() => navigate("设置")} />
          <If when={!collapsed()}><IconButton icon={colorScheme() === "dark" ? "sun" : "moon"} label={colorScheme() === "dark" ? "切换到浅色模式" : "切换到深色模式"} onPress={() => updatePreferences({ colorScheme: colorScheme() === "dark" ? "light" : "dark" })} /></If>
        </View>
        <SidebarItem label={currentAccount()?.nickname ?? "我的 / 登录"} shortLabel="我" icon="user" collapsed={collapsed()} selected={page() === "登录"} onPress={() => navigate("登录")} />
      </View>
    </If>
    <View class="flex-1 relative">
      <If when={page() === "推荐"}><RecommendView onNotify={notify} onFind={() => navigate("找剧")} onLogin={() => navigate("登录")} /></If>
      <If when={page() !== "推荐"}>
        <View class={isVideoFullscreen() ? "flex-1" : "flex-1 p-6 gap-4"}>
          <If when={!hasOwnHeading() && !isVideoFullscreen()}><PageHeader title={page()} /></If>
          <If when={page() === "找剧"}><DiscoverView mode="discover" onPlay={openPlayer} /></If>
          <If when={page() === "排行榜"}><DiscoverView mode="rank" onPlay={openPlayer} /></If>
          <If when={page() === "新剧"}><DiscoverView mode="new" onPlay={openPlayer} onCalendar={() => navigate("上新日历")} onNew={() => navigate("新剧")} /></If>
          <If when={page() === "上新日历"}><DiscoverView mode="calendar" onPlay={openPlayer} onNew={() => navigate("新剧")} /></If>
          <If when={page() === "历史/收藏/点赞"}><HistoryView initialTab="history" onPlay={openPlayer} /></If>
          <If when={page() === "追更/预约"}><HistoryView initialTab="subscriptions" onPlay={openPlayer} /></If>
          <If when={page() === "下载"}><DownloadsView onPlayOffline={openOfflinePlayer} /></If>
          <If when={page() === "登录"}><LoginView /></If>
          <If when={page() === "设置"}><SettingsView onNotify={notify} /></If>
          <If when={page() === "短剧播放"}><Player onBack={() => navigate(previousPage())} onNotify={notify} /></If>
        </View>
      </If>
      <If when={!!toast()}><View class="absolute bottom-20 self-center rounded-lg bg-card border border-border px-4 py-3"><Text class="text-sm text-foreground">{toast()}</Text></View></If>
    </View>
  </View>;
}
mount(App);
