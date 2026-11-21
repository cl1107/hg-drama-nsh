import { effect, signal, View, Text, Image, Scroll } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Button, FilterChip, StatusView } from "../../ui/controls";
import { Icon } from "../../ui/icons";
import { detailState } from "./discover-store";
import { isFavorite, isLiked, isSubscribed, preferences, toggleFavorite, toggleLike, toggleSubscription } from "../../stores/user-data";
import { servicePost } from "../../service-client";

type Episode = { episodeId: string; index: number };
// 先折叠渲染前几集，长剧（数百集）点「显示全部」再铺开，避免首屏过重。
const EPISODE_PREVIEW_COUNT = 60;

export function DramaHomeView(props: {
  onPlay: (seriesId: string, episodeId?: string) => void;
  onBack: () => void;
  onNotify?: (message: string) => void;
}) {
  const state = detailState;
  const showAllEpisodes = signal(false);
  const visibleEpisodes = (d: { episodes: Episode[] }): Episode[] =>
    showAllEpisodes() ? d.episodes : d.episodes.slice(0, EPISODE_PREVIEW_COUNT);
  // 每次打开新剧集详情时收起「显示全部」状态。
  effect(() => { if (state().kind === "ready") showAllEpisodes.set(false); });
  const busyDownload = signal(false);
  const download = async (seriesId: string, episodeId: string) => {
    if (busyDownload()) return;
    busyDownload.set(true);
    try {
      await servicePost("/downloads/start", { seriesId, episodeId, quality: preferences().defaultQuality });
      props.onNotify?.("已加入下载队列");
    } catch (error) {
      props.onNotify?.(error instanceof Error ? error.message : "下载失败，请重试");
    } finally {
      busyDownload.set(false);
    }
  };
  return <View class="flex-1 gap-4">
    <BaseButton accessibilityLabel="返回剧集列表" onPress={props.onBack} class="flex-row items-center gap-1 self-start rounded-lg px-2 py-1.5 hover:bg-muted active:opacity-70">
      <Icon name="chevron-left" color="muted-foreground" size={18} />
      <Text class="text-sm text-muted-foreground">返回</Text>
    </BaseButton>
    <If when={state().kind === "loading"}>
      {() => {
        const st = state();
        if (st.kind !== "loading") return <View />;
        return <StatusView kind="loading" message={`正在加载「${st.title}」详情…`} />;
      }}
    </If>
    <If when={state().kind === "error"}>
      {() => {
        const st = state();
        if (st.kind !== "error") return <View />;
        return <View class="flex-1 gap-3 items-center justify-center">
          <StatusView kind="error" message={st.message} actionLabel="重试" onAction={() => props.onBack()} />
          <View class="flex-row gap-2">
            <Button label="直接播放" variant="primary" size="sm" onPress={() => props.onPlay(st.seriesId)} />
            <Button label="返回" variant="outline" size="sm" onPress={() => props.onBack()} />
          </View>
        </View>;
      }}
    </If>
    <If when={state().kind === "ready"}>
      {() => {
        const st = state();
        if (st.kind !== "ready") return <View />;
        const d = st.detail;
        const firstEpisode = d.episodes[0]?.episodeId;
        return <Scroll class="flex-1">
          <View class="gap-6 pb-6">
            <View class="flex-row gap-6">
              <If when={!!d.cover}>
                <Image src={d.cover} style={{ width: 216, height: 300, borderRadius: 12 }} />
              </If>
              <View class="flex-1 gap-3 pt-1">
                <Text class="text-2xl font-semibold text-foreground">{d.title}</Text>
                <View class="flex-row flex-wrap gap-2">
                  <Text class="rounded-full bg-selection px-3 py-1 text-xs font-medium text-primary">{d.episodeText || `全 ${d.episodes.length} 集`}</Text>
                  <Each of={d.tags.slice(0, 8)}>{tag => <Text class="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">{tag()}</Text>}</Each>
                </View>
                <If when={!!d.intro}>
                  <Text class="text-sm leading-5 text-muted-foreground">{d.intro}</Text>
                </If>
                <View class="flex-row flex-wrap items-center gap-2 pt-1">
                  <Button label="播放第 1 集" variant="primary" size="sm" disabled={!firstEpisode} onPress={() => props.onPlay(d.seriesId, firstEpisode)} />
                  <Button label={isLiked(d.seriesId) ? "已点赞" : "点赞"} variant="outline" size="sm" onPress={() => toggleLike({ seriesId: d.seriesId, title: d.title, cover: d.cover, episodes: d.episodes.length })} />
                  <Button label={isFavorite(d.seriesId) ? "已收藏" : "收藏"} variant="outline" size="sm" onPress={() => toggleFavorite({ seriesId: d.seriesId, title: d.title, cover: d.cover, episodes: d.episodes.length })} />
                  <Button label={isSubscribed(d.seriesId) ? "已追更" : "追更"} variant="outline" size="sm" onPress={() => toggleSubscription({ seriesId: d.seriesId, title: d.title, cover: d.cover, episodes: d.episodes.length })} />
                  <Button label="下载第 1 集" variant="outline" size="sm" disabled={!firstEpisode || busyDownload()} onPress={() => void download(d.seriesId, firstEpisode ?? "")} />
                </View>
                <If when={!!d.recordNumber}>
                  <Text class="text-xs text-muted-foreground pt-1">{d.recordNumber}</Text>
                </If>
              </View>
            </View>
            <If when={d.celebrities.length > 0}>
              <View class="flex-row flex-wrap gap-5">
                <Each of={d.celebrities} key={c => c.nickname}>{c => (
                  <View class="w-20 items-center gap-1.5">
                    <If when={!!c().avatar}>
                      <Image src={c().avatar} style={{ width: 64, height: 64, borderRadius: 32 }} />
                    </If>
                    <If when={!c().avatar}>
                      <View class="items-center justify-center bg-muted" style={{ width: 64, height: 64, borderRadius: 32 }}>
                        <Text class="text-lg font-semibold text-muted-foreground">{c().nickname.slice(0, 1)}</Text>
                      </View>
                    </If>
                    <Text class="text-sm text-foreground" style={{ numberOfLines: 1 }}>{c().nickname}</Text>
                    <If when={!!c().role}><Text class="text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>{c().role}</Text></If>
                  </View>
                )}</Each>
              </View>
            </If>
            <View class="gap-3">
              <Text class="text-base font-semibold text-foreground">选集 {d.episodes.length}</Text>
              <If when={d.episodes.length > 0}>
                <View class="flex-row flex-wrap gap-2.5">
                  <Each of={visibleEpisodes(d)} key={ep => ep.episodeId}>{ep => (
                    <FilterChip
                      label={`第 ${ep().index} 集`}
                      selected={false}
                      onPress={() => props.onPlay(d.seriesId, ep().episodeId)}
                      testID={`home-episode-${ep().index}`}
                    />
                  )}</Each>
                  <If when={!showAllEpisodes() && d.episodes.length > EPISODE_PREVIEW_COUNT}>
                    <FilterChip label={`显示全部 ${d.episodes.length} 集`} selected={false} onPress={() => showAllEpisodes.set(true)} />
                  </If>
                </View>
              </If>
            </View>
          </View>
        </Scroll>;
      }}
    </If>
    <If when={state().kind === "closed"}>
      <StatusView kind="empty" message="尚未选择剧集" />
    </If>
  </View>;
}
