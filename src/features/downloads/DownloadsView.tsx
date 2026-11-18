import { signal, View, Text, List, cleanup } from "nsh";
import { Button, FilterChip, StatusView } from "../../ui/controls";
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
  const filter = signal<"all" | "downloading" | "completed" | "failed">("all");
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

  const retryTask = async (id: string) => {
    try {
      await servicePost("/downloads/retry", { id });
      await refresh();
    } catch (e) {
      error.set(e instanceof Error ? e.message : "重试失败");
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

  const clearTasks = async (scope: "finished" | "completed") => {
    try {
      await servicePost("/downloads/clear", { scope });
      await refresh();
    } catch (e) {
      error.set(e instanceof Error ? e.message : "清理失败");
    }
  };

  const filteredItems = () => {
    const f = filter();
    return items().filter(t => {
      if (f === "all") return true;
      if (f === "failed") return t.status === "failed" || t.status === "cancelled";
      return t.status === f;
    });
  };

  const totalCompletedBytes = () =>
    items()
      .filter(t => t.status === "completed")
      .reduce((acc, t) => acc + (t.bytes || 0), 0);

  const hasFinished = () => items().some(t => t.status === "failed" || t.status === "cancelled");
  const hasCompleted = () => items().some(t => t.status === "completed");

  return (
    <View class="flex-1 gap-4">
      <View class="flex-row items-center justify-between gap-2 flex-wrap">
        <Text class="text-xs text-muted-foreground">
          共 {items().length} 个任务 · 已占用 {formatBytes(totalCompletedBytes())}（保存在本机 .tmp/downloads）
        </Text>
        <View class="flex-row items-center gap-2">
          <If when={hasFinished()}>
            <Button label="清理失败/取消" variant="outline" size="sm" onPress={() => void clearTasks("finished")} />
          </If>
          <If when={hasCompleted()}>
            <Button label="清空已完成" variant="outline" size="sm" onPress={() => void clearTasks("completed")} />
          </If>
          <Button label={loading() ? "刷新中…" : "刷新"} variant="outline" size="sm" onPress={() => void refresh()} />
        </View>
      </View>

      <View class="flex-row gap-2 flex-wrap">
        <FilterChip label={`全部 (${items().length})`} selected={filter() === "all"} onPress={() => filter.set("all")} />
        <FilterChip
          label={`下载中 (${items().filter(t => t.status === "downloading").length})`}
          selected={filter() === "downloading"}
          onPress={() => filter.set("downloading")}
        />
        <FilterChip
          label={`已完成 (${items().filter(t => t.status === "completed").length})`}
          selected={filter() === "completed"}
          onPress={() => filter.set("completed")}
        />
        <FilterChip
          label={`失败/取消 (${items().filter(t => t.status === "failed" || t.status === "cancelled").length})`}
          selected={filter() === "failed"}
          onPress={() => filter.set("failed")}
        />
      </View>

      <If when={!!error()}>
        <StatusView kind="error" message={error()} actionLabel="重试" onAction={() => void refresh()} />
      </If>

      <If when={!error() && filteredItems().length === 0}>
        <StatusView
          kind="empty"
          message={items().length === 0 ? "暂无离线下载任务，可在播放器中点击“下载本集”" : "当前筛选下暂无下载任务"}
        />
      </If>

      <If when={filteredItems().length > 0}>
        <List each={filteredItems()} keyExtractor={t => t.id} estimatedItemSize={84} class="flex-1">
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
                <If when={task().status === "failed" || task().status === "cancelled"}>
                  <Button label="重试" variant="outline" size="sm" onPress={() => void retryTask(task().id)} />
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
