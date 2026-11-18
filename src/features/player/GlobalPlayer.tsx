import { signal, View, Text, Video, Image, List, cleanup, keymap, Clipboard, token, type VideoRef } from "nsh";
import { Window, isAvailable } from "nsh/desktop";
import { Button as BaseButton, Slider, Sheet } from "nsh/base";
import { Button, FilterChip } from "../../ui/controls";
import { IconButton, type IconName } from "../../ui/icons";
import { playbackState, startPlayback, cancelPlayback, retryPlayback, type Playback } from "../player/session";
import { preferences, subscriptions, isFavorite, isLiked, isSubscribed, recordWatchProgress, toggleFavorite, toggleLike, toggleSubscription, type QualityOption } from "../../stores/user-data";
import { servicePost } from "../../service-client";
import { createRecommendationFeed, type Recommendation, type RecommendationChannel } from "../recommend/feed";

function time(value: number) { const seconds = Math.max(0, Math.floor(value)); return `${String(Math.floor(seconds / 60)).padStart(2,"0")}:${String(seconds % 60).padStart(2,"0")}`; }
export function GlobalPlayer(props: { recommend?: boolean; onNotify: (message: string) => void; onFind: () => void; onBack?: () => void }) {
 const feed = createRecommendationFeed();
 const tab = signal<RecommendationChannel | "关注">("推荐"), current = signal<Recommendation | null>(null);
 const paused = signal(false), muted = signal(false), rate = signal(1), position = signal(0), duration = signal(0), failure = signal("");
 const panel = signal<"episodes" | "settings" | null>(null), expanded = signal(false), busyAction = signal(false);
 const quality = signal<QualityOption>(preferences().defaultQuality);
 const hidden = new Set<string>();
 const fullscreen = signal(false), hovered = signal(false);
 let transferPosition = 0;
 const showControls = () => hovered() || panel() !== null;
 const toggleFullscreen = () => { transferPosition = position(); fullscreen.set(!fullscreen()); hovered.set(false); };
 let player: VideoRef | undefined, disposed = false, lastSaved = 0, lastPlayback: Playback | null = null, ended = "", wheel = 0, lastWheel = 0;
 const candidates = () => tab() === "关注"
  ? subscriptions().map(item => ({ id:item.seriesId, title:item.title, cover:item.cover, episodes:item.episodes, tags:[] }))
  : feed.items();
 const visible = () => candidates().filter(item => !hidden.has(item.id));
 const ready = () => { const state = playbackState(); return state.kind === "ready" && (!props.recommend || state.playback.seriesId === current()?.id) ? state.playback : null; };
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
 const togglePlay = () => { if (!panel() && ready()) paused.set(!paused()); };
 const download = async () => {
  const item = ready(); if (!item || busyAction()) return;
  busyAction.set(true);
  try { await servicePost("/downloads/start", {seriesId:item.seriesId,episodeId:item.episode.episodeId,quality:quality()}); props.onNotify("已加入下载队列"); }
  catch (error) { props.onNotify(error instanceof Error ? error.message : "下载失败，请重试"); }
  finally { busyAction.set(false); }
 };
 keymap.bind({
  escape: () => {if(fullscreen())toggleFullscreen();}, f: () => {if(ready() && isAvailable)toggleFullscreen();}, space: togglePlay, down: () => void step(1), up: () => void step(-1),
  right: () => player?.seek(Math.min(duration(),position()+5)), left: () => player?.seek(Math.max(0,position()-5)),
  m: () => muted.set(!muted()),
 }, {when:"notEditing"});
 cleanup(() => { disposed = true; flush(); feed.cancel(); cancelPlayback(); });
 if(props.recommend)void changeTab("推荐");
 function Action(action: { icon: IconName; label: string; active?: boolean; onPress: () => void; disabled?: boolean }) {
  return <View class="items-center gap-0.5"><IconButton icon={action.icon} label={action.label} active={action.active} media size={48} onPress={action.onPress} disabled={action.disabled} /><Text class="text-xs text-media-foreground">{action.label}</Text></View>;
 }
 function Surface() { return <View onMouseEnter={()=>hovered.set(true)} onMouseLeave={()=>hovered.set(false)} testID={props.recommend ? "recommendation-page" : "global-player"} class="flex-1 relative overflow-hidden bg-media-background" onWheel={event => {
  if (!props.recommend || Math.abs(event.delta.x) > Math.abs(event.delta.y) || panel()) return;
  const now = Date.now(); if (now-lastWheel < 900) return;
  wheel += event.delta.y * (event.deltaMode === "lines" ? 30 : 1);
  if (Math.abs(wheel)>80) { lastWheel=now; const direction=wheel>0?1:-1;wheel=0;void step(direction); }
 }}>
  <If when={!!current()?.cover && !ready()}><Image src={current()?.cover ?? ""} class="absolute inset-0 opacity-25" style={{width:"100%",height:"100%",objectFit:"contain"}} /></If>
  <If when={ready()}>{item => <Video testID="global-video" ref={node => player=node} src={item().mediaUrl} paused={paused()} muted={muted()} rate={rate()} controls={false} class="absolute inset-0" style={{width:"100%",height:"100%"}}
   onLoad={event => {duration.set(event.duration);failure.set("");lastPlayback=item();const initial=item().initialPositionSec;const resume=transferPosition>0?transferPosition:initial;transferPosition=0;if(typeof resume === "number" && resume>0 && resume<event.duration-2)player?.seek(resume);}}
   onProgress={event => {position.set(event.currentTime);duration.set(event.duration);lastPlayback=item();if(Date.now()-lastSaved>2500){lastSaved=Date.now();flush();}}}
   onError={event => { failure.set("本集播放失败，请重试或切换短剧");paused.set(true); }}
   onEnd={() => {const active=item();if(ended===active.episode.episodeId)return;ended=active.episode.episodeId;flush();const next=active.episodes.find(ep=>ep.index===active.episode.index+1);if(preferences().autoPlayNext && next)selectEpisode(next.episodeId);else paused.set(true);}}
  />}</If>
  <If when={showControls()}>
  <If when={!fullscreen() && props.recommend}>
  <View class="absolute top-0 left-0 right-0 h-28" style={{backgroundImage:`linear-gradient(to bottom, ${token("media-scrim")}, transparent)`,pointerEvents:"none"}} />
  <View class="absolute top-4 self-center rounded-full bg-media-panel flex-row px-1 py-1">
   <Each of={["关注","真人剧","漫剧","推荐"] as const}>{name => <BaseButton testID={`recommend-tab-${name()}`} selected={tab()===name()} onPress={() => void changeTab(name())} class={tab()===name()?"rounded-full bg-media-muted/25 px-4 py-2":"rounded-full px-4 py-2 hover:bg-media-muted/15"}><Text class={tab()===name()?"text-sm font-semibold text-media-foreground":"text-sm text-media-muted"}>{name()}</Text></BaseButton>}</Each>
  </View>
  <View class="absolute top-4 left-4 gap-1" style={{maxWidth:"28%"}}><Text class="text-sm text-media-foreground" style={{numberOfLines:1}}>{current()?.title ?? ""}</Text><If when={ready()}>{item=><Text class="text-xs text-media-muted">第{item().episode.index}集</Text>}</If></View>
  <View class="absolute top-4 right-4"><IconButton icon="search" label="找剧" media onPress={props.onFind} /></View>
  </If>
  <If when={!props.recommend || fullscreen()}><View class="absolute top-3 left-3 flex-row gap-3 items-center"><IconButton icon="chevron-left" label={fullscreen()?"退出视频全屏":"返回"} media onPress={()=>fullscreen()?toggleFullscreen():props.onBack?.()} /><Text class="text-sm text-media-foreground">{ready()?.title ?? ""}</Text></View></If>
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
    <Text class="text-lg font-semibold text-media-foreground" style={{numberOfLines:1}}>@{ready()?.title ?? current()?.title ?? ""}</Text>
    <View class="flex-row gap-2"><Each of={current()?.tags.slice(0,4) ?? []}>{tag=><View class="rounded bg-media-panel px-2 py-1"><Text class="text-xs text-media-foreground">{tag()}</Text></View>}</Each></View>
    <If when={!!ready()?.intro}><Text class="text-sm text-media-muted" style={{numberOfLines:expanded()?0:2}}>{ready()?.intro ?? ""}</Text><BaseButton onPress={()=>expanded.set(!expanded())}><Text class="text-xs text-media-foreground">{expanded()?"收起":"展开"}</Text></BaseButton></If>
   </View>
   <If when={props.recommend && !fullscreen()}><View class="absolute right-4 bottom-28 gap-1 bg-media-panel rounded-full py-1"><IconButton icon="chevron-up" label="上一部" media onPress={()=>void step(-1)} /><IconButton icon="chevron-down" label="下一部" media onPress={()=>void step(1)} /></View></If>
   <View class="absolute bottom-0 left-0 right-0 px-3 pb-2 pt-8" style={{backgroundImage:`linear-gradient(to top, ${token("media-background")}, transparent)`}}>
    <Slider accessibilityLabel="播放进度" value={position()} min={0} max={duration()>0?duration():1} step={0.1} disabled={!ready()} onChange={event=>{if(typeof event.value==="number")position.set(event.value);}} onChangeEnd={event=>{if(typeof event.value==="number")player?.seek(event.value);}} trackClass="h-5 justify-center" indicatorClass="h-0.5 rounded-full bg-media-muted/60" rangeClass="bg-primary rounded-full" thumbClass="size-2 rounded-full bg-media-foreground" />
    <View class="flex-row items-center justify-between gap-2">
     <View class="flex-row items-center gap-2"><IconButton icon={paused()?"play":"pause"} label={paused()?"继续播放":"暂停播放"} media onPress={togglePlay} disabled={!ready()}/><Text class="text-xs text-media-foreground">{time(position())} / {time(duration())}</Text></View>
     <View class="flex-row items-center gap-2">
      <BaseButton onPress={()=>panel.set("episodes")} disabled={!ready()} class="px-2 py-2"><Text class="text-xs text-media-foreground">选集{ready()?` · 全${ready()?.episodes.length}集`:""}</Text></BaseButton>
      <BaseButton onPress={()=>panel.set("settings")} disabled={!ready()} class="px-2 py-2"><Text class="text-xs text-media-foreground">{ready()?.quality || "清晰度"} · {rate()}x</Text></BaseButton>
      <IconButton icon={muted()?"mute":"volume"} label={muted()?"开启声音":"静音"} media onPress={()=>muted.set(!muted())}/>
      <If when={isAvailable}><IconButton icon="expand" label={fullscreen()?"退出视频全屏":"视频全屏"} media onPress={toggleFullscreen} /></If>
     </View>
    </View>
   </View>
  </If>
  <Sheet open={panel()!==null} side="right" onOpenChange={event=>{if(!event.open)panel.set(null);}} popupClass="bg-card p-5 gap-4" popupStyle={{width:340,maxWidth:"90%"}} backdropClass="bg-media-scrim">
   <View class="flex-row items-center justify-between"><Text class="text-lg font-semibold text-foreground">{panel()==="episodes"?"选集":"播放设置"}</Text><IconButton icon="close" label="关闭播放面板" onPress={()=>panel.set(null)} /></View>
   <If when={panel()==="episodes"}><List each={ready()?.episodes ?? []} keyExtractor={item=>item.episodeId} estimatedItemSize={44} numColumns={3} class="flex-1">{item=><Button label={`${item().index}`} selected={item().episodeId===ready()?.episode.episodeId} onPress={()=>selectEpisode(item().episodeId)} />}</List></If>
   <If when={panel()==="settings"}><Text class="text-sm text-foreground">倍速</Text><View class="flex-row gap-2 flex-wrap"><Each of={[0.75,1,1.25,1.5,2]}>{value=><FilterChip label={`${value()}x`} selected={rate()===value()} onPress={()=>rate.set(value())} />}</Each></View><Text class="text-sm text-foreground">清晰度</Text><View class="flex-row gap-2 flex-wrap"><Each of={["auto","1080p","720p"] as const}>{value=><FilterChip label={value()==="auto"?"自动":value()} selected={quality()===value()} onPress={()=>{const active=ready();quality.set(value());if(active){flush();void startPlayback(active.seriesId,active.episode.episodeId,value(),position());panel.set(null);}}} />}</Each></View></If>
  </Sheet>
 </View>; }
 return <View class="flex-1"><If when={!fullscreen()}><Surface /></If><If when={fullscreen()}><Window id="video-fullscreen" title="视频播放" defaultMode="fullScreen" titleBar={{style:"hidden"}} onOpenChange={event=>{if(!event.open && fullscreen())toggleFullscreen();}} ><Surface /></Window></If></View>;
}
