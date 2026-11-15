import { signal, Text, View, Video, List, cleanup, type VideoRef } from "nsh";
import { Button, FilterChip, StatusView } from "../../ui/controls";
import { playbackState, startPlayback, retryPlayback, cancelPlayback } from "./session";
import {
  isFavorite,
  isLiked,
  preferences,
  recordWatchProgress,
  toggleFavorite,
  toggleLike,
  type QualityOption,
} from "../../stores/user-data";
import { servicePost } from "../../service-client";

const QUALITIES: { value: QualityOption; label: string }[] = [
  { value: "auto", label: "自动" },
  { value: "1080p", label: "1080p" },
  { value: "720p", label: "720p" },
  { value: "540p", label: "540p" },
  { value: "480p", label: "480p" },
];

const RATES = [0.75, 1, 1.25, 1.5, 2];

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function Player(props: { onBack?: () => void; onNotify?: (msg: string) => void }) {
  const paused = signal(false);
  const muted = signal(false);
  const volume = signal(1);
  const rate = signal(1);
  const position = signal(0);
  const duration = signal(0);
  const failure = signal("");
  const selectedQuality = signal<QualityOption>(preferences().defaultQuality);
  const showIntro = signal(false);
  let player: VideoRef | undefined;
  let lastSavedAt = 0;
  let endedEpisodeId = "";
  let resumedEpisodeId = "";

  cleanup(cancelPlayback);

  const ready = () => {
    const state = playbackState();
    return state.kind === "ready" ? state.playback : null;
  };
  const error = () => {
    const state = playbackState();
    return state.kind === "error" ? state.message : "";
  };

  const handleBack = () => {
    cancelPlayback();
    props.onBack?.();
  };

  const switchEpisode = (seriesId: string, episodeId: string) => {
    paused.set(false);
    position.set(0);
    duration.set(0);
    failure.set("");
    endedEpisodeId = "";
    resumedEpisodeId = "";
    void startPlayback(seriesId, episodeId, selectedQuality());
  };

  const queueDownload = async (seriesId: string, episodeId: string) => {
    try {
      await servicePost("/downloads/start", { seriesId, episodeId, quality: selectedQuality() });
      props.onNotify?.("已加入离线下载队列");
    } catch (e) {
      props.onNotify?.(e instanceof Error ? e.message : "加入下载失败");
    }
  };

  return (
    <View class="flex-1 gap-3">
      <If when={playbackState().kind === "idle"}>
        <StatusView
          kind="empty"
          message="从找剧、推荐或历史中选择一部短剧开始播放"
          actionLabel={props.onBack ? "返回浏览" : undefined}
          onAction={props.onBack}
        />
      </If>

      <If when={playbackState().kind === "preparing"}>
        <StatusView
          kind="loading"
          message="正在获取官方片源并解密本集（首帧前需完成整集下载）…"
          actionLabel="取消"
          onAction={cancelPlayback}
        />
      </If>

      <If when={playbackState().kind === "error"}>
        <View class="flex-1 items-center justify-center p-8 gap-3">
          <Text class="text-sm text-destructive">{error()}</Text>
          <View class="flex-row gap-2">
            <Button label="重试" variant="primary" size="sm" onPress={retryPlayback} />
            <If when={!!props.onBack}>
              <Button label="返回" variant="outline" size="sm" onPress={handleBack} />
            </If>
          </View>
        </View>
      </If>

      <If when={ready()}>
        {current => (
          <View class="flex-1 gap-3">
            <View class="flex-row items-center justify-between gap-3 pb-2 border-b border-border">
              <View class="flex-row items-center gap-2 flex-1">
                <If when={!!props.onBack}>
                  <Button label="‹ 返回" variant="outline" size="sm" onPress={handleBack} />
                </If>
                <Text class="text-base font-semibold text-foreground">
                  {current().title} · 第{current().episode.index}/{current().episodes.length}集
                </Text>
              </View>
              <View class="flex-row items-center gap-1.5">
                <Button
                  label={isFavorite(current().seriesId) ? "已收藏" : "收藏"}
                  variant={isFavorite(current().seriesId) ? "primary" : "outline"}
                  size="sm"
                  onPress={() =>
                    toggleFavorite({
                      seriesId: current().seriesId,
                      title: current().title,
                      cover: current().cover ?? "",
                      episodes: current().episodes.length,
                    })
                  }
                />
                <Button
                  label={isLiked(current().seriesId) ? "已赞" : "点赞"}
                  variant={isLiked(current().seriesId) ? "primary" : "outline"}
                  size="sm"
                  onPress={() =>
                    toggleLike({
                      seriesId: current().seriesId,
                      title: current().title,
                      cover: current().cover ?? "",
                      episodes: current().episodes.length,
                    })
                  }
                />
                <Button
                  label="下载本集"
                  variant="outline"
                  size="sm"
                  onPress={() => void queueDownload(current().seriesId, current().episode.episodeId)}
                />
                <If when={!!current().intro}>
                  <Button
                    label={showIntro() ? "收起简介" : "简介"}
                    variant="ghost"
                    size="sm"
                    onPress={() => showIntro.set(!showIntro())}
                  />
                </If>
              </View>
            </View>

            <If when={showIntro() && !!current().intro}>
              <View class="bg-card border border-border rounded-lg p-3">
                <Text class="text-xs text-muted-foreground">{current().intro ?? ""}</Text>
              </View>
            </If>

            <View class="flex-1 flex-row gap-4">
              <View class="flex-1 bg-card rounded-xl overflow-hidden border border-border">
                <Video
                  ref={node => {
                    player = node;
                  }}
                  src={current().mediaUrl}
                  paused={paused()}
                  muted={muted()}
                  volume={volume()}
                  rate={rate()}
                  controls
                  class="flex-1"
                  onLoad={e => {
                    duration.set(e.duration);
                    failure.set("");
                    const item = current();
                    if (
                      item.initialPositionSec &&
                      item.initialPositionSec > 2 &&
                      item.initialPositionSec < e.duration - 2 &&
                      resumedEpisodeId !== item.episode.episodeId
                    ) {
                      resumedEpisodeId = item.episode.episodeId;
                      player?.seek(item.initialPositionSec);
                    }
                  }}
                  onProgress={e => {
                    position.set(e.currentTime);
                    duration.set(e.duration);
                    const now = Date.now();
                    if (now - lastSavedAt > 2500 && e.duration > 0) {
                      lastSavedAt = now;
                      const item = current();
                      recordWatchProgress({
                        seriesId: item.seriesId,
                        title: item.title,
                        cover: item.cover ?? "",
                        episodeId: item.episode.episodeId,
                        episodeIndex: item.episode.index,
                        totalEpisodes: item.episodes.length,
                        positionSec: e.currentTime,
                        durationSec: e.duration,
                      });
                    }
                  }}
                  onError={e => failure.set(e.message)}
                  onEnd={() => {
                    const item = current();
                    if (endedEpisodeId === item.episode.episodeId) return;
                    endedEpisodeId = item.episode.episodeId;
                    recordWatchProgress({
                      seriesId: item.seriesId,
                      title: item.title,
                      cover: item.cover ?? "",
                      episodeId: item.episode.episodeId,
                      episodeIndex: item.episode.index,
                      totalEpisodes: item.episodes.length,
                      positionSec: duration(),
                      durationSec: duration(),
                    });
                    const nextEp = item.episodes.find(ep => ep.index === item.episode.index + 1);
                    if (preferences().autoPlayNext && nextEp) {
                      switchEpisode(item.seriesId, nextEp.episodeId);
                    } else {
                      paused.set(true);
                    }
                  }}
                />
              </View>

              <View class="bg-card border border-border rounded-xl p-2 gap-2" style={{ width: 120 }}>
                <Text class="text-xs font-medium text-muted-foreground px-1">选集 ({current().episodes.length})</Text>
                <List
                  testID="episode-list"
                  each={current().episodes}
                  keyExtractor={e => e.episodeId}
                  estimatedItemSize={42}
                  class="flex-1"
                >
                  {item => (
                    <Button
                      label={`第${item().index}集`}
                      size="sm"
                      selected={item().episodeId === current().episode.episodeId}
                      onPress={() => switchEpisode(current().seriesId, item().episodeId)}
                    />
                  )}
                </List>
              </View>
            </View>

            <If when={!!failure()}>
              <Text class="text-xs text-destructive">{failure()}</Text>
            </If>

            <View class="bg-card border border-border rounded-xl px-4 py-2.5 flex-row items-center justify-between gap-3 flex-wrap">
              <View class="flex-row items-center gap-2">
                <Button
                  label={paused() ? "继续" : "暂停"}
                  variant="primary"
                  size="sm"
                  onPress={() => paused.set(!paused())}
                />
                <Button
                  label="-10秒"
                  variant="outline"
                  size="sm"
                  onPress={() => player?.seek(Math.max(0, position() - 10))}
                />
                <Button
                  label="+10秒"
                  variant="outline"
                  size="sm"
                  onPress={() => player?.seek(Math.min(duration(), position() + 10))}
                />
                <Text class="text-xs text-muted-foreground px-1">
                  {formatTime(position())} / {formatTime(duration())}
                </Text>
              </View>

              <View class="flex-row items-center gap-2 flex-wrap">
                <Button
                  label={muted() ? "取消静音" : "静音"}
                  variant="outline"
                  size="sm"
                  onPress={() => muted.set(!muted())}
                />
                <Button
                  label={`音量 ${Math.round(volume() * 100)}%`}
                  variant="outline"
                  size="sm"
                  onPress={() => volume.set(volume() <= 0.25 ? 1 : Number((volume() - 0.25).toFixed(2)))}
                />
                <Button
                  label={`${rate()}x`}
                  variant="outline"
                  size="sm"
                  onPress={() => {
                    const idx = RATES.indexOf(rate());
                    rate.set(RATES[(idx + 1) % RATES.length]);
                  }}
                />
                <View class="flex-row items-center gap-1">
                  <Each of={QUALITIES}>
                    {q => (
                      <FilterChip
                        label={q().label}
                        selected={selectedQuality() === q().value}
                        onPress={() => {
                          selectedQuality.set(q().value);
                          switchEpisode(current().seriesId, current().episode.episodeId);
                        }}
                      />
                    )}
                  </Each>
                </View>
                <Text class="text-xs text-muted-foreground">
                  {current().quality || "auto"} · {current().codec}
                </Text>
              </View>
            </View>
          </View>
        )}
      </If>
    </View>
  );
}
