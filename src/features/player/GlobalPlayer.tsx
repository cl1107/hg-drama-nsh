import { signal, View, Text, Image, List, Scroll, cleanup, effect, untracked, keymap, Clipboard, token, type ListRef } from "nsh";
import { currentWindow, isAvailable, type WindowMode } from "nsh/desktop";
import { Button as BaseButton, Slider, Sheet, Input } from "nsh/base";
import { Button, FilterChip } from "../../ui/controls";
import { Icon, IconButton, type IconName } from "../../ui/icons";
import * as playbackSession from "./session";
import type { Playback } from "./session";
import { preferences, updatePreferences, subscriptions, isFavorite, isLiked, isSubscribed, recordWatchProgress, toggleFavorite, toggleLike, toggleSubscription, type QualityOption, type DanmakuFontWeight, type DanmakuSpeed } from "../../stores/user-data";
import { servicePost } from "../../service-client";
import { startEpisodeDownload } from "./session";
import { createRecommendationFeed, type Recommendation, type RecommendationChannel } from "../recommend/feed";
import { PlayerVideo, type PlayerVideoRef } from "./PlayerVideo";
import { DanmakuLayer, DANMAKU_COLORS, resolveDanmakuFontSize } from "./DanmakuLayer";

const videoFullscreen = signal(false);
export const isVideoFullscreen = () => videoFullscreen();
const FULLSCREEN_IDLE_HIDE_MS = 3000;

function time(value: number) { const seconds = Math.max(0, Math.floor(value)); return `${String(Math.floor(seconds / 60)).padStart(2,"0")}:${String(seconds % 60).padStart(2,"0")}`; }
export function GlobalPlayer(props: { recommend?: boolean; active?: boolean; onNotify: (message: string) => void; onFind: () => void; onBack?: () => void }) {
 const { playbackState, startPlayback, cancelPlayback, retryPlayback } = props.recommend
  ? playbackSession.createPlaybackSession()
  : playbackSession;
 const active = () => props.active ?? true;
 const feed = createRecommendationFeed();
 const tab = signal<RecommendationChannel | "关注">("推荐"), current = signal<Recommendation | null>(null);
 const paused = signal(false), muted = signal(false), rate = signal(1), position = signal(0), duration = signal(0), failure = signal("");
 const panel = signal<"episodes" | "settings" | "danmaku" | null>(null), expanded = signal(false), busyAction = signal(false);
 const episodeOrder = signal<"asc" | "desc">("asc");
 const playerStageHeight = signal(540);
 const danmakuBlockView = signal(false);
 const blockWordInput = signal("");
 const quality = signal<QualityOption>(preferences().defaultQuality);
 const hidden = new Set<string>();
 const hovered = signal(false);
 const fullscreenControlsVisible = signal(true);
 const hostWindow = isAvailable ? currentWindow() : null;
 let previousWindowMode: WindowMode = "normal";
 let managedWindowFullscreen = false;
 let player: PlayerVideoRef | undefined, episodesList: ListRef | undefined, episodesViewportReady = false, pendingEpisodeCenter = false, disposed = false, lastSaved = 0, lastPlayback: Playback | null = null, ended = "", wheel = 0, lastWheel = 0;
 let idleTimer: ReturnType<typeof setTimeout> | undefined;
 let episodeScrollTimer: ReturnType<typeof setTimeout> | undefined;
 let lastMousePos: { x: number; y: number } | null = null;
 let hiddenAt = 0;
 const fullscreen = () => active() && videoFullscreen();
 const clearIdleTimer = () => {
  if (idleTimer !== undefined) {
   clearTimeout(idleTimer);
   idleTimer = undefined;
  }
 };
 const scheduleFullscreenHide = () => {
  clearIdleTimer();
  if (!fullscreen() || panel() !== null || disposed) return;
  idleTimer = setTimeout(() => {
   idleTimer = undefined;
   if (!fullscreen() || panel() !== null || disposed) return;
   hiddenAt = Date.now();
   fullscreenControlsVisible.set(false);
  }, FULLSCREEN_IDLE_HIDE_MS);
 };
 const revealFullscreenControls = () => {
  if (!fullscreen()) return;
  if (!fullscreenControlsVisible()) fullscreenControlsVisible.set(true);
  scheduleFullscreenHide();
 };
 const showControls = () => panel() !== null || (fullscreen() ? fullscreenControlsVisible() : hovered());
 const setFullscreen = (next: boolean) => {
  if (next === videoFullscreen()) return;
  if (next) {
   const currentMode = hostWindow?.state()?.mode ?? "normal";
   if (hostWindow && currentMode !== "fullScreen") {
    previousWindowMode = currentMode;
    managedWindowFullscreen = true;
    hostWindow.setMode("fullScreen");
   } else {
    managedWindowFullscreen = false;
   }
   fullscreenControlsVisible.set(true);
   videoFullscreen.set(true);
   return;
  }
  clearIdleTimer();
  fullscreenControlsVisible.set(true);
  videoFullscreen.set(false);
  if (managedWindowFullscreen && hostWindow?.state()?.mode === "fullScreen") {
   hostWindow.setMode(previousWindowMode === "fullScreen" ? "normal" : previousWindowMode);
  }
  managedWindowFullscreen = false;
 };
 const toggleFullscreen = () => setFullscreen(!videoFullscreen());
 const stopModeListener = hostWindow?.on("modeChange", event => {
  if (event.mode !== "fullScreen" && videoFullscreen() && managedWindowFullscreen) {
   managedWindowFullscreen = false;
   clearIdleTimer();
   fullscreenControlsVisible.set(true);
   videoFullscreen.set(false);
  }
 });
 const candidates = () => tab() === "关注"
  ? subscriptions().map(item => ({ id:item.seriesId, title:item.title, cover:item.cover, episodes:item.episodes, tags:[] }))
  : feed.items();
 const visible = () => candidates().filter(item => !hidden.has(item.id));
 const ready = () => { const state = playbackState(); return state.kind === "ready" && (!props.recommend || state.playback.seriesId === current()?.id) ? state.playback : null; };
 const orderedEpisodes = () => {
  const list = ready()?.episodes ?? [];
  return episodeOrder() === "desc" ? [...list].reverse() : list;
 };
 const clearEpisodeScrollTimer = () => {
  if (episodeScrollTimer !== undefined) {
   clearTimeout(episodeScrollTimer);
   episodeScrollTimer = undefined;
  }
 };
 const scrollToCurrentEpisode = (animated: boolean) => {
  const list = episodesList;
  const activeId = ready()?.episode.episodeId;
  if (!list || !activeId) return false;
  const index = orderedEpisodes().findIndex(item => item.episodeId === activeId);
  if (index < 0) return false;
  list.scrollToIndex({ index, viewPosition: 0.5, animated });
  return true;
 };
 const scheduleCenterCurrentEpisode = (animated = false) => {
  clearEpisodeScrollTimer();
  if (panel() !== "episodes" || disposed) return;
  pendingEpisodeCenter = true;
  episodeScrollTimer = setTimeout(() => {
   episodeScrollTimer = undefined;
   if (panel() !== "episodes" || disposed) return;
   if (episodesViewportReady && scrollToCurrentEpisode(animated)) {
    pendingEpisodeCenter = false;
   }
  }, 0);
 };
 const setEpisodeOrder = (next: "asc" | "desc") => {
  if (episodeOrder() === next) return;
  episodeOrder.set(next);
  scheduleCenterCurrentEpisode(false);
 };
 const scrollEpisodesToEdge = (edge: "start" | "end") => {
  const list = episodesList;
  if (!list || orderedEpisodes().length === 0) return;
  pendingEpisodeCenter = false;
  clearEpisodeScrollTimer();
  if (edge === "start") {
   list.scrollToIndex({ index: 0, viewPosition: 0, animated: true });
  } else {
   list.scrollToEnd({ animated: true });
  }
 };
 const playbackError = () => { const state = playbackState(); return state.kind === "error" ? state.message : failure(); };
 const summary = () => { const item = ready(); return item ? { seriesId:item.seriesId, title:item.title, cover:item.cover ?? current()?.cover ?? "", episodes:item.episodes.length } : null; };
 const flush = () => {
  const item = lastPlayback;
  if (!item || duration() <= 0 || position() <= 0) return;
  recordWatchProgress({seriesId:item.seriesId,title:item.title,cover:item.cover ?? current()?.cover ?? "",episodeId:item.episode.episodeId,episodeIndex:item.episode.index,totalEpisodes:item.episodes.length,positionSec:position(),durationSec:duration()});
 };
 function play(item: Recommendation, episodeId?: string) {
  flush(); current.set(item); position.set(0); duration.set(0); failure.set(""); paused.set(false); ended = ""; lastPlayback = null;
  void startPlayback(item.id, episodeId, quality());
 }
 async function changeTab(next: RecommendationChannel | "关注") {
  flush(); feed.cancel(); cancelPlayback(); current.set(null); lastPlayback = null; tab.set(next); expanded.set(false); hidden.clear();
  if (next === "关注") { const item = visible()[0]; if (item) play(item); return; }
  if (await feed.load(next) && !disposed && tab() === next) { const item = visible()[0]; if (item) play(item); }
 }
 async function step(direction: number) {
  if (panel() || disposed) return;
  let rows = visible(); const index = rows.findIndex(item => item.id === current()?.id); let target = index + direction;
  if (target < 0) { props.onNotify("已经是第一部"); return; }
  if (target >= rows.length && tab() !== "关注" && feed.more()) {
   const channel = tab();
   if (channel === "关注" || !await feed.load(channel, true) || disposed || tab() !== channel) return;
   rows = visible();
  }
  if (rows[target]) play(rows[target]); else props.onNotify("暂时没有更多短剧");
 }
 const selectEpisode = (episodeId: string) => { const active=ready();if(!active)return;panel.set(null);if(props.recommend){const item=current();if(item)play(item,episodeId);}else{flush();position.set(0);duration.set(0);ended="";void startPlayback(active.seriesId,episodeId,quality());} };
 const openPanel = (next: "episodes" | "settings" | "danmaku" | null) => {
  if (next !== "danmaku") danmakuBlockView.set(false);
  panel.set(next);
 };
 const addBlockWord = () => {
  const word = blockWordInput().trim();
  if (!word) return;
  const currentWords = preferences().danmakuBlockWords;
  if (!currentWords.includes(word)) {
   updatePreferences({ danmakuBlockWords: [...currentWords, word] });
  }
  blockWordInput.set("");
 };
 const removeBlockWord = (word: string) => {
  updatePreferences({ danmakuBlockWords: preferences().danmakuBlockWords.filter(item => item !== word) });
 };
 const clearBlockWords = () => {
  updatePreferences({ danmakuBlockWords: [] });
 };
 const currentEpisodeIdx = () => {
  const active = ready();
  if (!active) return -1;
  return active.episodes.findIndex(ep => ep.episodeId === active.episode.episodeId);
 };
 const prevEpisode = () => {
  const active = ready();
  const idx = currentEpisodeIdx();
  return active && idx > 0 ? active.episodes[idx - 1] ?? null : null;
 };
 const nextEpisode = () => {
  const active = ready();
  const idx = currentEpisodeIdx();
  return active && idx >= 0 && idx < active.episodes.length - 1 ? active.episodes[idx + 1] ?? null : null;
 };
 const stepEpisode = (delta: -1 | 1) => {
  const target = delta < 0 ? prevEpisode() : nextEpisode();
  if (!target) {
   props.onNotify(delta < 0 ? "已经是第一集" : "已经是最后一集");
   return;
  }
  revealFullscreenControls();
  selectEpisode(target.episodeId);
 };
 const togglePlay = () => { if (!panel() && ready() && !playbackError()) paused.set(!paused()); };
 const download = async () => {
  const item = ready(); if (!item || busyAction()) return;
  busyAction.set(true);
  try { await startEpisodeDownload(item.seriesId, item.episode.episodeId, quality()); props.onNotify("已加入下载队列"); }
  catch (error) { props.onNotify(error instanceof Error ? error.message : "下载失败，请重试"); }
  finally { busyAction.set(false); }
 };
 effect(() => {
  if (!active()) {
   untracked(() => {
    setFullscreen(false);
    openPanel(null);
    hovered.set(false);
    wheel = 0;
    flush();
   });
   return;
  }
  return keymap.bind({
   escape: () => {if(fullscreen())toggleFullscreen();}, f: () => {if(ready() && isAvailable)toggleFullscreen();}, space: () => { revealFullscreenControls(); togglePlay(); }, down: () => { revealFullscreenControls(); void step(1); }, up: () => { revealFullscreenControls(); void step(-1); },
   right: () => { revealFullscreenControls(); player?.seek(Math.min(duration(),position()+5)); }, left: () => { revealFullscreenControls(); player?.seek(Math.max(0,position()-5)); },
   m: () => { revealFullscreenControls(); muted.set(!muted()); },
   p: () => { if (!panel() && ready()) stepEpisode(-1); },
   n: () => { if (!panel() && ready()) stepEpisode(1); },
   d: () => { if (ready()) { revealFullscreenControls(); updatePreferences({ danmakuEnabled: !preferences().danmakuEnabled }); } },
  }, {when:"notEditing"});
 });
 // 全屏无操作时自动隐藏控制 UI，打开面板或退出全屏时暂停/清除计时。
 effect(() => {
  const isFs = fullscreen();
  const hasPanel = panel() !== null;
  if (!isFs) {
   clearIdleTimer();
   fullscreenControlsVisible.set(true);
   return;
  }
  if (hasPanel) {
   clearIdleTimer();
   return;
  }
  if (fullscreenControlsVisible()) {
   scheduleFullscreenHide();
  }
 });
 // 打开选集面板时自动将当前集滚动到居中位置。
 effect(() => {
  if (panel() === "episodes") {
   scheduleCenterCurrentEpisode(false);
  } else {
   clearEpisodeScrollTimer();
   pendingEpisodeCenter = false;
   episodesViewportReady = false;
   episodesList = undefined;
  }
 });
 // 播放期间请服务持有防息屏断言，暂停/出错/退出即释放。
 const mediaPaused = () => !active() || paused();
 const playing = () => !mediaPaused() && ready() !== null && !playbackError();
 effect(() => { const active = playing(); void servicePost("/keep-awake", { active }).catch(() => {}); });
 cleanup(() => { disposed = true; clearIdleTimer(); clearEpisodeScrollTimer(); stopModeListener?.(); setFullscreen(false); flush(); feed.cancel(); cancelPlayback(); void servicePost("/keep-awake", { active: false }).catch(() => {}); });
 if(props.recommend)void changeTab("推荐");
 function Action(action: { icon: IconName; label: string; active?: boolean; onPress: () => void; disabled?: boolean }) {
  return <View class="items-center gap-0.5"><IconButton icon={action.icon} label={action.label} active={action.active} media size={48} onPress={action.onPress} disabled={action.disabled} /><Text class="text-xs text-media-foreground">{action.label}</Text></View>;
 }
 function Surface() { return <View
  onMouseEnter={() => { hovered.set(true); revealFullscreenControls(); }}
  onMouseMove={event => {
   if (!hovered()) hovered.set(true);
   const pos = event.pagePosition;
   const samePos = lastMousePos !== null && lastMousePos.x === pos.x && lastMousePos.y === pos.y;
   lastMousePos = { x: pos.x, y: pos.y };
   if (fullscreen()) {
    if (!fullscreenControlsVisible() && samePos && Date.now() - hiddenAt < 150) return;
    revealFullscreenControls();
   }
  }}
  onMouseLeave={() => hovered.set(false)}
  onPressDown={() => revealFullscreenControls()}
  onMouseUp={() => revealFullscreenControls()}
  style={{ cursor: fullscreen() && !showControls() ? "none" : "default" }}
  testID={props.recommend ? "recommendation-page" : "global-player"}
  class="flex-1 relative overflow-hidden bg-media-background"
  onWheel={event => {
   revealFullscreenControls();
   if (!props.recommend || Math.abs(event.delta.x) > Math.abs(event.delta.y) || panel()) return;
   const now = Date.now(); if (now-lastWheel < 900) return;
   wheel += event.delta.y * (event.deltaMode === "lines" ? 30 : 1);
   if (Math.abs(wheel)>80) { lastWheel=now; const direction=wheel>0?1:-1;wheel=0;void step(direction); }
  }}>
  <If when={!!current()?.cover && !ready()}><Image src={current()?.cover ?? ""} class="absolute inset-0 opacity-25" style={{width:"100%",height:"100%",objectFit:"contain"}} /></If>
  <If when={ready()}>{item => <PlayerVideo testID="global-video" codec={item().codec} ref={node => player=node} src={item().mediaUrl} paused={mediaPaused()} muted={muted()} rate={rate()} class="absolute inset-0" style={{width:"100%",height:"100%"}}
   onLoad={event => {duration.set(event.duration);failure.set("");lastPlayback=item();const initial=item().initialPositionSec;if(typeof initial === "number" && initial>0 && initial<event.duration-2)player?.seek(initial);}}
   onProgress={event => {position.set(event.currentTime);duration.set(event.duration);lastPlayback=item();if(Date.now()-lastSaved>2500){lastSaved=Date.now();flush();}}}
   onError={event => { failure.set("本集播放失败，请重试或切换短剧");paused.set(true); }}
   onEnd={() => {const active=item();if(ended===active.episode.episodeId)return;ended=active.episode.episodeId;flush();const next=nextEpisode();if(preferences().autoPlayNext && next)selectEpisode(next.episodeId);else paused.set(true);}}
  />}</If>
  <If when={ready() !== null && !playbackError()}>
   <View
    testID="video-surface-tap"
    focusable={false}
    class="absolute inset-0"
    onPress={() => {
     revealFullscreenControls();
     togglePlay();
    }}
   />
  </If>
  <If when={ready()}>
   {item => (
    <DanmakuLayer
     seriesId={item().seriesId}
     episodeId={item().episode.episodeId}
     positionSec={position()}
     durationSec={duration()}
     paused={mediaPaused() || !!playbackError()}
     enabled={preferences().danmakuEnabled && (!fullscreen() || preferences().danmakuShowInFullscreen)}
     opacity={preferences().danmakuOpacity}
     fontSize={preferences().danmakuFontSize}
     scaleWithVideo={preferences().danmakuScaleWithVideo}
     fontWeight={preferences().danmakuFontWeight}
     color={preferences().danmakuColor}
     lanes={preferences().danmakuLanes}
     speed={preferences().danmakuSpeed}
     mergeDup={preferences().danmakuMergeDup}
     blockWords={preferences().danmakuBlockWords}
     onStageSize={({ height }) => {
      if (height > 0 && height !== playerStageHeight()) playerStageHeight.set(height);
     }}
    />
   )}
  </If>
  <If when={ready() !== null && paused() && !playbackError()}>
   <View testID="video-paused-indicator" style={{pointerEvents:"none"}} class="absolute inset-0 items-center justify-center">
    <View class="size-16 rounded-full bg-media-panel items-center justify-center">
     <Icon name="play" size={28} color="media-foreground" />
    </View>
   </View>
  </If>
  <If when={showControls()}>
  <If when={!fullscreen() && props.recommend}>
  <View class="absolute top-0 left-0 right-0 h-28" style={{backgroundImage:`linear-gradient(to bottom, ${token("media-scrim")}, transparent)`,pointerEvents:"none"}} />
  <View class="absolute top-4 self-center rounded-full bg-media-panel flex-row px-1 py-1">
   <Each of={["关注","真人剧","漫剧","推荐"] as const}>{name => <BaseButton testID={`recommend-tab-${name()}`} selected={tab()===name()} onPress={() => void changeTab(name())} class={tab()===name()?"rounded-full bg-media-muted/25 px-4 py-2":"rounded-full px-4 py-2 hover:bg-media-muted/15"}><Text class={tab()===name()?"text-sm font-semibold text-media-foreground":"text-sm text-media-muted"}>{name()}</Text></BaseButton>}</Each>
  </View>
  <View class="absolute top-4 left-4 gap-1" style={{maxWidth:"28%"}}><Text class="text-sm text-media-foreground" style={{numberOfLines:1}}>{current()?.title ?? ""}</Text><If when={ready()}>{item=><Text class="text-xs text-media-muted">第{item().episode.index}集</Text>}</If></View>
  <View class="absolute top-4 right-4"><IconButton icon="search" label="找剧" media onPress={props.onFind} /></View>
  </If>
  <If when={!props.recommend || fullscreen()}><View class="absolute top-3 left-3 flex-row gap-2 items-center" style={{maxWidth:"70%"}}><IconButton icon="chevron-left" label={fullscreen()?"退出视频全屏":"返回"} media onPress={()=>fullscreen()?toggleFullscreen():props.onBack?.()} /><Text class="text-sm text-media-foreground" style={{numberOfLines:1,flexShrink:1}}>{ready()?.title ?? ""}</Text><If when={ready()}>{item=><Text testID="player-header-episode" class="text-xs text-media-muted">第{item().episode.index}集</Text>}</If></View></If>
  </If>
  <If when={props.recommend && !current() && !feed.loading() && !feed.error()}><View style={{pointerEvents:"box-none"}} class="absolute inset-0 items-center justify-center gap-4"><Text class="text-sm text-media-muted">{tab()==="关注"?"还没有追更的短剧":"暂时没有推荐内容"}</Text><Button label="去找剧" variant="outline" onPress={props.onFind} /></View></If>
  <If when={props.recommend && feed.loading() && !current()}><View style={{pointerEvents:"box-none"}} class="absolute inset-0 items-center justify-center"><Text class="text-sm text-media-muted">正在加载推荐…</Text></View></If>
  <If when={props.recommend && !!feed.error() && !current()}><View style={{pointerEvents:"box-none"}} class="absolute inset-0 items-center justify-center gap-4 px-16"><Text class="text-sm text-media-foreground">{feed.error()}</Text><View class="flex-row gap-3"><Button label="重试推荐" variant="primary" onPress={() => { const channel=tab();if(channel!=="关注")void changeTab(channel); }} /><Button label="去找剧" variant="outline" onPress={props.onFind} /></View></View></If>
  <If when={playbackState().kind==="preparing"}><View style={{pointerEvents:"box-none"}} class="absolute inset-0 items-center justify-center gap-2"><Text class="text-sm text-media-foreground">正在加载本集…</Text><Text class="text-xs text-media-muted">上下切换短剧</Text></View></If>
  <If when={!!playbackError()}>
   <View style={{pointerEvents:"box-none"}} class="absolute inset-0 items-center justify-center gap-3 px-16">
    <Text class="text-sm text-media-foreground">{playbackError()}</Text>
    <View class="flex-row flex-wrap justify-center gap-3">
     <Button label="重试播放" variant="primary" onPress={()=>{failure.set("");paused.set(false);retryPlayback();}} />
     <If when={props.recommend}><Button label="下一部" variant="outline" onPress={() => void step(1)} /></If>
     <If when={!props.recommend && !!props.onBack}><Button label="返回" variant="outline" onPress={()=>props.onBack?.()} /></If>
    </View>
   </View>
  </If>
  <If when={showControls() && (ready() !== null || current() !== null)}>
   <View class="absolute bottom-0 left-0 right-0 h-72" style={{backgroundImage:`linear-gradient(to top, ${token("media-background")}, transparent)`,pointerEvents:"none"}} />
   <View class="absolute right-3 top-24 items-center gap-3">
    <Action icon="heart" label={isLiked(ready()?.seriesId ?? current()?.id ?? "")?"已点赞":"点赞"} active={isLiked(ready()?.seriesId ?? current()?.id ?? "")} disabled={!ready()} onPress={() => {const item=summary();if(item)toggleLike(item);}} />
    <Action icon="star" label={isFavorite(ready()?.seriesId ?? current()?.id ?? "")?"已收藏":"收藏"} active={isFavorite(ready()?.seriesId ?? current()?.id ?? "")} disabled={!ready()} onPress={() => {const item=summary();if(item)toggleFavorite(item);}} />
    <Action icon="bell" label={isSubscribed(ready()?.seriesId ?? current()?.id ?? "")?"已追更":"追更"} active={isSubscribed(ready()?.seriesId ?? current()?.id ?? "")} disabled={!ready()} onPress={() => {const item=summary();if(item)toggleSubscription(item);}} />
    <Action icon="share" label="分享" onPress={() => {const id=ready()?.seriesId ?? current()?.id;if(id)void Clipboard.writeText(`https://hongguoduanju.com/player/${id}`).then(()=>props.onNotify("剧集链接已复制"),()=>props.onNotify("无法复制链接，请重试"));}} />
    <Action icon="download" label="下载" disabled={!ready() || busyAction()} onPress={() => void download()} />
   </View>
   <View class="absolute bottom-24 left-4 gap-2 pr-4" style={{width:"52%",maxWidth:560}}>
    <View class="flex-row items-center gap-2">
     <Text class="text-lg font-semibold text-media-foreground" style={{numberOfLines:1,flexShrink:1}}>@{ready()?.title ?? current()?.title ?? ""}</Text>
     <If when={ready()}>{item=><View class="rounded bg-media-panel px-2 py-0.5"><Text testID="player-title-episode" class="text-xs font-medium text-media-foreground">第{item().episode.index}集</Text></View>}</If>
    </View>
    <View class="flex-row gap-2"><Each of={current()?.tags.slice(0,4) ?? []}>{tag=><View class="rounded bg-media-panel px-2 py-1"><Text class="text-xs text-media-foreground">{tag()}</Text></View>}</Each></View>
    <If when={!!ready()?.intro}><Text class="text-sm text-media-muted" style={{numberOfLines:expanded()?0:2}}>{ready()?.intro ?? ""}</Text><BaseButton onPress={()=>expanded.set(!expanded())}><Text class="text-xs text-media-foreground">{expanded()?"收起":"展开"}</Text></BaseButton></If>
   </View>
   <If when={props.recommend && !fullscreen()}><View class="absolute right-4 bottom-28 gap-1 bg-media-panel rounded-full py-1"><IconButton icon="chevron-up" label="上一部" media onPress={()=>void step(-1)} /><IconButton icon="chevron-down" label="下一部" media onPress={()=>void step(1)} /></View></If>
   <View class="absolute bottom-0 left-0 right-0 px-3 pb-2 pt-8" style={{backgroundImage:`linear-gradient(to top, ${token("media-background")}, transparent)`}}>
    <Slider accessibilityLabel="播放进度" value={position()} min={0} max={duration()>0?duration():1} step={0.1} disabled={!ready()} onChange={event=>{if(typeof event.value==="number")position.set(event.value);}} onChangeEnd={event=>{if(typeof event.value==="number")player?.seek(event.value);}} trackClass="h-5 justify-center" indicatorClass="h-0.5 rounded-full bg-media-muted/60" rangeClass="bg-primary rounded-full" thumbClass="size-2 rounded-full bg-media-foreground" />
    <View class="flex-row items-center justify-between gap-2">
     <View class="flex-row items-center gap-1">
      <IconButton testID="player-prev-episode" icon="skip-prev" label="上一集" media onPress={() => stepEpisode(-1)} disabled={!prevEpisode()} />
      <IconButton icon={paused()?"play":"pause"} label={paused()?"继续播放":"暂停播放"} media onPress={togglePlay} disabled={!ready()}/>
      <IconButton testID="player-next-episode" icon="skip-next" label="下一集" media onPress={() => stepEpisode(1)} disabled={!nextEpisode()} />
      <Text class="text-xs text-media-foreground ml-1">{time(position())} / {time(duration())}</Text>
     </View>
     <View class="flex-row items-center gap-2">
      <BaseButton
       testID="player-danmaku-toggle"
       accessibilityLabel={preferences().danmakuEnabled ? "关闭弹幕" : "开启弹幕"}
       selected={preferences().danmakuEnabled}
       disabled={!ready()}
       onPress={() => {
        revealFullscreenControls();
        updatePreferences({ danmakuEnabled: !preferences().danmakuEnabled });
       }}
       class={preferences().danmakuEnabled ? "rounded-md bg-primary/25 px-2.5 py-1.5" : "rounded-md px-2.5 py-1.5 hover:bg-media-muted/15"}
      >
       <Text class={preferences().danmakuEnabled ? "text-xs font-medium text-primary" : "text-xs text-media-muted"}>
        {preferences().danmakuEnabled ? "弹幕 开" : "弹幕 关"}
       </Text>
      </BaseButton>
      <BaseButton testID="player-danmaku-settings-btn" accessibilityLabel="弹幕设置" onPress={()=>openPanel("danmaku")} disabled={!ready()} class="px-2 py-2 hover:bg-media-muted/15 rounded-md"><Text class="text-xs text-media-foreground">弹幕设置</Text></BaseButton>
      <BaseButton onPress={()=>openPanel("episodes")} disabled={!ready()} class="px-2 py-2"><Text class="text-xs text-media-foreground">选集{ready()?` · 全${ready()?.episodes.length}集`:""}</Text></BaseButton>
      <BaseButton testID="player-settings-btn" onPress={()=>openPanel("settings")} disabled={!ready()} class="px-2 py-2"><Text class="text-xs text-media-foreground">{ready()?.quality || "清晰度"} · {rate()}x</Text></BaseButton>
      <IconButton icon={muted()?"mute":"volume"} label={muted()?"开启声音":"静音"} media onPress={()=>muted.set(!muted())}/>
      <If when={isAvailable}><IconButton icon="expand" label={fullscreen()?"退出视频全屏":"视频全屏"} media onPress={toggleFullscreen} /></If>
     </View>
    </View>
   </View>
  </If>
  <Sheet open={panel()!==null} side="right" onOpenChange={event=>{if(!event.open)openPanel(null);}} popupClass="bg-card p-5 gap-4" popupStyle={{width:360,maxWidth:"90%"}} backdropClass="bg-media-scrim">
   <View class="flex-row items-center justify-between gap-2">
    <View class="flex-row items-center gap-2">
     <Text class="text-lg font-semibold text-foreground">{panel()==="episodes"?"选集":panel()==="danmaku"?(danmakuBlockView()?"屏蔽词管理":"弹幕设置"):"播放设置"}</Text>
     <If when={panel()==="episodes" && ready()!==null}>
      <BaseButton testID="episodes-locate-current" accessibilityLabel="定位到当前集" onPress={()=>scrollToCurrentEpisode(true)} class="rounded-full bg-selection px-2.5 py-0.5 hover:opacity-85 active:opacity-70 focus:border-ring">
       <Text class="text-xs font-medium text-primary">第{ready()?.episode.index}集</Text>
      </BaseButton>
     </If>
    </View>
    <IconButton icon="close" label="关闭播放面板" onPress={()=>openPanel(null)} />
   </View>
   <If when={panel()==="episodes"}>
    <View class="flex-row items-center justify-between gap-2">
     <View class="flex-row items-center gap-1 rounded-lg bg-muted/40 p-0.5">
      <BaseButton testID="episodes-order-asc" selected={episodeOrder()==="asc"} onPress={()=>setEpisodeOrder("asc")} class={episodeOrder()==="asc"?"rounded-md bg-selection px-2.5 py-1 focus:border-ring":"rounded-md px-2.5 py-1 hover:bg-muted focus:border-ring"}>
       <Text class={episodeOrder()==="asc"?"text-xs font-medium text-primary":"text-xs text-muted-foreground"}>正序</Text>
      </BaseButton>
      <BaseButton testID="episodes-order-desc" selected={episodeOrder()==="desc"} onPress={()=>setEpisodeOrder("desc")} class={episodeOrder()==="desc"?"rounded-md bg-selection px-2.5 py-1 focus:border-ring":"rounded-md px-2.5 py-1 hover:bg-muted focus:border-ring"}>
       <Text class={episodeOrder()==="desc"?"text-xs font-medium text-primary":"text-xs text-muted-foreground"}>倒序</Text>
      </BaseButton>
     </View>
     <View class="flex-row items-center gap-1">
      <BaseButton testID="episodes-scroll-top" accessibilityLabel="滚动到顶部" onPress={()=>scrollEpisodesToEdge("start")} class="rounded-md border border-border px-2.5 py-1 hover:bg-muted active:opacity-70 focus:border-ring">
       <Text class="text-xs text-foreground">到头</Text>
      </BaseButton>
      <BaseButton testID="episodes-scroll-bottom" accessibilityLabel="滚动到底部" onPress={()=>scrollEpisodesToEdge("end")} class="rounded-md border border-border px-2.5 py-1 hover:bg-muted active:opacity-70 focus:border-ring">
       <Text class="text-xs text-foreground">到底</Text>
      </BaseButton>
     </View>
    </View>
    <List
     testID="episodes-list"
     ref={node=>{
      episodesList = node;
      if (pendingEpisodeCenter && episodesViewportReady && scrollToCurrentEpisode(false)) {
       pendingEpisodeCenter = false;
      }
     }}
     onLayout={event=>{
      if (event.bounds.size.height > 0) {
       episodesViewportReady = true;
       if (pendingEpisodeCenter && scrollToCurrentEpisode(false)) {
        pendingEpisodeCenter = false;
       }
      }
     }}
     each={orderedEpisodes()}
     keyExtractor={item=>item.episodeId}
     estimatedItemSize={44}
     numColumns={3}
     class="flex-1"
    >{item=><Button testID={`episode-item-${item().index}`} label={`${item().index}`} selected={item().episodeId===ready()?.episode.episodeId} onPress={()=>selectEpisode(item().episodeId)} />}</List>
   </If>
   <If when={panel()==="danmaku" && !danmakuBlockView()}>
    <Scroll class="flex-1" contentClass="gap-4">
     <View class="flex-row items-center justify-between gap-2">
      <Text class="text-sm text-foreground">弹幕开关</Text>
      <View class="flex-row gap-2">
       <FilterChip testID="settings-danmaku-on" label="开启" selected={preferences().danmakuEnabled} onPress={()=>updatePreferences({ danmakuEnabled: true })} />
       <FilterChip testID="settings-danmaku-off" label="关闭" selected={!preferences().danmakuEnabled} onPress={()=>updatePreferences({ danmakuEnabled: false })} />
      </View>
     </View>
     <View class="gap-1.5">
      <View class="flex-row items-center justify-between">
       <Text class="text-sm text-foreground">不透明度</Text>
       <Text class="text-xs text-muted-foreground">{Math.round(preferences().danmakuOpacity * 100)}%</Text>
      </View>
      <Slider
       testID="settings-danmaku-opacity-slider"
       accessibilityLabel="弹幕不透明度"
       value={Math.round(preferences().danmakuOpacity * 100)}
       min={20}
       max={100}
       step={5}
       onChange={event => {
        if (typeof event.value === "number") {
         updatePreferences({ danmakuOpacity: Math.round(event.value) / 100 });
        }
       }}
       trackClass="h-5 justify-center"
       indicatorClass="h-1.5 rounded-full bg-muted"
       rangeClass="bg-primary rounded-full"
       thumbClass="size-3.5 rounded-full bg-foreground"
      />
     </View>
     <View class="gap-1.5">
      <View class="flex-row items-center justify-between">
       <Text class="text-sm text-foreground">字号</Text>
       <Text class="text-xs text-muted-foreground">{preferences().danmakuFontSize}px</Text>
      </View>
      <Slider
       testID="settings-danmaku-size-slider"
       accessibilityLabel="弹幕字号"
       value={preferences().danmakuFontSize}
       min={12}
       max={36}
       step={1}
       onChange={event => {
        if (typeof event.value === "number") {
         updatePreferences({ danmakuFontSize: Math.round(event.value) });
        }
       }}
       trackClass="h-5 justify-center"
       indicatorClass="h-1.5 rounded-full bg-muted"
       rangeClass="bg-primary rounded-full"
       thumbClass="size-3.5 rounded-full bg-foreground"
      />
     </View>
     <BaseButton
      testID="settings-danmaku-scale"
      accessibilityLabel="字号随画面大小缩放"
      selected={preferences().danmakuScaleWithVideo}
      onPress={() => updatePreferences({ danmakuScaleWithVideo: !preferences().danmakuScaleWithVideo })}
      class="flex-row items-center justify-between gap-2 py-1 rounded-md hover:bg-muted/40 px-1 focus:border-ring"
     >
      <View class="flex-row items-center gap-2">
       <View class={preferences().danmakuScaleWithVideo ? "size-4 rounded bg-primary items-center justify-center" : "size-4 rounded border border-border items-center justify-center"}>
        <If when={preferences().danmakuScaleWithVideo}><Text class="text-xs font-bold text-primary-foreground">✓</Text></If>
       </View>
       <Text class="text-sm text-foreground">字号随画面大小缩放</Text>
      </View>
      <Text class="text-xs text-muted-foreground">现在 {resolveDanmakuFontSize(preferences().danmakuFontSize, preferences().danmakuScaleWithVideo, playerStageHeight())}px</Text>
     </BaseButton>
     <View class="gap-2">
      <Text class="text-sm text-foreground">粗细</Text>
      <View class="flex-row gap-2 flex-wrap">
       <Each of={[{weight:300 as DanmakuFontWeight,label:"细"},{weight:400 as DanmakuFontWeight,label:"常规"},{weight:600 as DanmakuFontWeight,label:"粗 (默认)"},{weight:700 as DanmakuFontWeight,label:"特粗"}]}>
        {opt=><FilterChip testID={`settings-danmaku-weight-${opt().weight}`} label={opt().label} selected={preferences().danmakuFontWeight===opt().weight} onPress={()=>updatePreferences({ danmakuFontWeight: opt().weight })} />}
       </Each>
      </View>
     </View>
     <View class="gap-2">
      <Text class="text-sm text-foreground">颜色</Text>
      <View class="flex-row gap-2.5 flex-wrap items-center">
       <Each of={DANMAKU_COLORS}>
        {opt => (
         <BaseButton
          testID={`settings-danmaku-color-${opt().value ? opt().value.replace("#", "") : "original"}`}
          accessibilityLabel={`弹幕颜色 ${opt().label}`}
          selected={preferences().danmakuColor === opt().value}
          onPress={() => updatePreferences({ danmakuColor: opt().value })}
          class={preferences().danmakuColor === opt().value ? "size-7 rounded-full border-2 border-primary items-center justify-center" : "size-7 rounded-full border border-border items-center justify-center hover:opacity-85"}
          style={{
           backgroundColor: opt().value === "" ? "#282830" : opt().value === "rainbow" ? undefined : opt().hex,
           ...(opt().value === "rainbow"
            ? { backgroundImage: "linear-gradient(135deg, #ff6b81, #ffe14d, #5ce1ff, #7dff8a)" }
            : {}),
          }}
         >
          <If when={opt().value === "" || opt().value === "rainbow"}>
           <Text class="text-xs font-semibold" style={{ color: opt().value === "" ? "#ffffff" : "#111116" }}>
            {opt().value === "" ? "原" : "彩"}
           </Text>
          </If>
         </BaseButton>
        )}
       </Each>
      </View>
     </View>
     <View class="gap-2">
      <View class="flex-row items-center justify-between gap-2">
       <Text class="text-sm text-foreground">显示行数</Text>
       <View class="flex-row items-center gap-2">
        <Button testID="settings-danmaku-lanes-dec" label="-" variant="outline" size="sm" disabled={preferences().danmakuLanes <= 2} onPress={()=>updatePreferences({ danmakuLanes: Math.max(2, preferences().danmakuLanes - 1) })} />
        <Text testID="settings-danmaku-lanes-value" class="text-sm font-medium text-foreground w-10 text-center">{preferences().danmakuLanes} 行</Text>
        <Button testID="settings-danmaku-lanes-inc" label="+" variant="outline" size="sm" disabled={preferences().danmakuLanes >= 16} onPress={()=>updatePreferences({ danmakuLanes: Math.min(16, preferences().danmakuLanes + 1) })} />
       </View>
      </View>
      <View class="flex-row gap-2 flex-wrap">
       <Each of={[4,6,8,12]}>{n=><FilterChip testID={`settings-danmaku-lanes-${n()}`} label={`${n()}行`} selected={preferences().danmakuLanes===n()} onPress={()=>updatePreferences({ danmakuLanes: n() })} />}</Each>
      </View>
     </View>
     <View class="gap-2">
      <Text class="text-sm text-foreground">滚动速度</Text>
      <View class="flex-row gap-2 flex-wrap">
       <Each of={[{value:"slow" as DanmakuSpeed,label:"慢"},{value:"normal" as DanmakuSpeed,label:"正常"},{value:"fast" as DanmakuSpeed,label:"快"}]}>{opt=><FilterChip testID={`settings-danmaku-speed-${opt().value}`} label={opt().label} selected={preferences().danmakuSpeed===opt().value} onPress={()=>updatePreferences({ danmakuSpeed: opt().value })} />}</Each>
      </View>
     </View>
     <BaseButton
      testID="settings-danmaku-fullscreen"
      accessibilityLabel="全屏时显示弹幕"
      selected={preferences().danmakuShowInFullscreen}
      onPress={() => updatePreferences({ danmakuShowInFullscreen: !preferences().danmakuShowInFullscreen })}
      class="flex-row items-center gap-2 py-1 rounded-md hover:bg-muted/40 px-1 focus:border-ring"
     >
      <View class={preferences().danmakuShowInFullscreen ? "size-4 rounded bg-primary items-center justify-center" : "size-4 rounded border border-border items-center justify-center"}>
       <If when={preferences().danmakuShowInFullscreen}><Text class="text-xs font-bold text-primary-foreground">✓</Text></If>
      </View>
      <Text class="text-sm text-foreground">全屏时显示弹幕</Text>
     </BaseButton>
     <BaseButton
      testID="settings-danmaku-mergedup"
      accessibilityLabel="合并重复弹幕"
      selected={preferences().danmakuMergeDup}
      onPress={() => updatePreferences({ danmakuMergeDup: !preferences().danmakuMergeDup })}
      class="flex-row items-center gap-2 py-1 rounded-md hover:bg-muted/40 px-1 focus:border-ring"
     >
      <View class={preferences().danmakuMergeDup ? "size-4 rounded bg-primary items-center justify-center" : "size-4 rounded border border-border items-center justify-center"}>
       <If when={preferences().danmakuMergeDup}><Text class="text-xs font-bold text-primary-foreground">✓</Text></If>
      </View>
      <Text class="text-sm text-foreground">合并重复弹幕</Text>
     </BaseButton>
     <View class="border-t border-border pt-3 flex-row items-center justify-between gap-2">
      <View class="flex-row items-center gap-2">
       <Text class="text-sm text-foreground">屏蔽词</Text>
       <Text testID="settings-danmaku-block-summary" class="text-xs text-muted-foreground">
        {preferences().danmakuBlockWords.length ? `已设 ${preferences().danmakuBlockWords.length} 个` : "未设置"}
       </Text>
      </View>
      <Button testID="settings-danmaku-block-manage" label="管理 ›" variant="ghost" size="sm" onPress={()=>danmakuBlockView.set(true)} />
     </View>
    </Scroll>
   </If>
   <If when={panel()==="danmaku" && danmakuBlockView()}>
    <View class="flex-1 gap-3">
     <View class="flex-row items-center justify-between gap-2">
      <Button testID="settings-danmaku-block-back" label="‹ 返回弹幕设置" variant="ghost" size="sm" onPress={()=>danmakuBlockView.set(false)} />
      <Button testID="settings-danmaku-block-clear" label="清空" variant="ghost" size="sm" disabled={preferences().danmakuBlockWords.length===0} onPress={clearBlockWords} />
     </View>
     <View class="flex-row items-center gap-2">
      <Input
       testID="danmaku-block-input"
       class="flex-1 bg-background border border-input rounded-lg px-3 py-2 text-sm text-foreground focus:border-ring"
       value={blockWordInput()}
       onChange={({ value }) => blockWordInput.set(value)}
       placeholder="输入屏蔽词，回车添加"
       returnKeyType="done"
       submitBehavior="submit"
       onSubmit={addBlockWord}
      />
      <Button testID="danmaku-block-add" label="添加" variant="primary" size="sm" onPress={addBlockWord} />
     </View>
     <If when={preferences().danmakuBlockWords.length === 0}>
      <View class="py-8 items-center justify-center"><Text class="text-xs text-muted-foreground">暂无屏蔽词</Text></View>
     </If>
     <If when={preferences().danmakuBlockWords.length > 0}>
      <Scroll class="flex-1" contentClass="flex-row flex-wrap gap-2">
       <Each of={preferences().danmakuBlockWords}>
        {word => (
         <BaseButton
          testID={`danmaku-block-word-${word()}`}
          accessibilityLabel={`移除屏蔽词 ${word()}`}
          onPress={() => removeBlockWord(word())}
          class="flex-row items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1 hover:bg-muted"
         >
          <Text class="text-xs text-foreground">{word()}</Text>
          <Text class="text-xs text-muted-foreground">×</Text>
         </BaseButton>
        )}
       </Each>
      </Scroll>
     </If>
    </View>
   </If>
   <If when={panel()==="settings"}>
    <Scroll class="flex-1" contentClass="gap-4">
     <View class="gap-2">
      <Text class="text-sm text-foreground">倍速</Text>
      <View class="flex-row gap-2 flex-wrap"><Each of={[0.75,1,1.25,1.5,2]}>{value=><FilterChip label={`${value()}x`} selected={rate()===value()} onPress={()=>rate.set(value())} />}</Each></View>
     </View>
     <View class="gap-2">
      <Text class="text-sm text-foreground">清晰度</Text>
      <View class="flex-row gap-2 flex-wrap"><Each of={["auto","1080p","720p"] as const}>{value=><FilterChip label={value()==="auto"?"自动":value()} selected={quality()===value()} onPress={()=>{const active=ready();quality.set(value());if(active){flush();void startPlayback(active.seriesId,active.episode.episodeId,value(),position());openPanel(null);}}} />}</Each></View>
     </View>
     <View class="border-t border-border pt-3 flex-row items-center justify-between gap-2">
      <Text class="text-sm text-foreground">弹幕外观与屏蔽词</Text>
      <Button label="弹幕设置 ›" variant="outline" size="sm" onPress={()=>openPanel("danmaku")} />
     </View>
    </Scroll>
   </If>
  </Sheet>
 </View>; }
 return <View class="flex-1" style={{ display: active() ? "flex" : "none" }}><Surface /></View>;
}
