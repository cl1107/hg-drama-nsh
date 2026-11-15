import { signal, View, Text, List, cleanup } from "nsh";
import { Button, StatusView } from "../../ui/controls";
import { serviceGet, servicePost } from "../../service-client";

interface DownloadTask {
  id: string;
  seriesId: string;
  episodeId: string;
  title: string;
  episodeIndex: number;
  quality: string;
  codec: string;
  status: "downloading" | "completed" | "failed" | "cancelled";
  bytes: number;
  error?: string;
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DownloadsView(props: {
  onPlayOffline: (downloadId: string, seriesId: string, episodeId: string) => void;
}) {
  const items = signal<DownloadTask[]>([]);
  const loading = signal(false);
  const error = signal("");

  const refresh = async () => {
    loading.set(true);
    error.set("");
    try {
      const res = await serviceGet<{ items: DownloadTask[] }>("/downloads");
      items.set(Array.isArray(res.items) ? res.items : []);
    } catch (e) {
      error.set(e instanceof Error ? e.message : "获取下载列表失败");
    } finally {
      loading.set(false);
    }
  };

  const timer = setInterval(() => {
    if (items().some(t => t.status === "downloading")) void refresh();
  }, 2000);
  cleanup(() => clearInterval(timer));

  void refresh();

  const cancelTask = async (id: string) => {
    try {
      await servicePost("/downloads/cancel", { id });
      await refresh();
    } catch (e) {
      error.set(e instanceof Error ? e.message : "取消失败");
    }
  };

  const deleteTask = async (id: string) => {
    try {
      await servicePost("/downloads/delete", { id });
      await refresh();
    } catch (e) {
      error.set(e instanceof Error ? e.message : "删除失败");
    }
  };

  return (
    <View class="flex-1 gap-4">
      <View class="flex-row items-center justify-between">
        <Text class="text-xs text-muted-foreground">离线下载保存在本机临时目录（已完成可离线播放）</Text>
        <Button label={loading() ? "刷新中…" : "刷新"} variant="outline" size="sm" onPress={() => void refresh()} />
      </View>

      <If when={!!error()}>
        <StatusView kind="error" message={error()} actionLabel="重试" onAction={() => void refresh()} />
      </If>

      <If when={!error() && items().length === 0}>
        <StatusView kind="empty" message="暂无离线下载任务，可在播放器中点击“下载本集”" />
      </If>

      <If when={items().length > 0}>
        <List each={items()} keyExtractor={t => t.id} estimatedItemSize={84} class="flex-1">
          {task => (
            <View class="flex-row items-center justify-between gap-4 py-3 px-3 border-b border-border bg-card rounded-lg mb-2">
              <View class="flex-1 gap-1">
                <Text class="text-sm font-semibold text-foreground">
                  {task().title} · 第{task().episodeIndex}集
                </Text>
                <Text class="text-xs text-muted-foreground">
                  {task().status === "downloading"
                    ? "正在下载并解密…"
                    : task().status === "completed"
                      ? `已完成 · ${formatBytes(task().bytes)} · ${task().quality} ${task().codec}`
                      : task().status === "cancelled"
                        ? "已取消"
                        : `失败：${task().error ?? "未知错误"}`}
                </Text>
              </View>
              <View class="flex-row items-center gap-2">
                <If when={task().status === "downloading"}>
                  <Button label="取消" variant="outline" size="sm" onPress={() => void cancelTask(task().id)} />
                </If>
                <If when={task().status === "completed"}>
                  <Button
                    label="离线播放"
                    variant="primary"
                    size="sm"
                    onPress={() => props.onPlayOffline(task().id, task().seriesId, task().episodeId)}
                  />
                </If>
                <Button label="删除" variant="ghost" size="sm" onPress={() => void deleteTask(task().id)} />
              </View>
            </View>
          )}
        </List>
      </If>
    </View>
  );
}
