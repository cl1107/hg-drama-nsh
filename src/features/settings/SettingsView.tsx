import { View, Text, Scroll, colorScheme, signal } from "nsh";
import {
  checkForPackage,
  downloadPackage,
  restartToPackage,
  runningPackage,
  shellInfo,
  type PackageUpdate,
} from "nsh/updater";
import { Button, FilterChip } from "../../ui/controls";
import {
  preferences,
  removeHistoryItems,
  resetPreferences,
  updatePreferences,
  watchHistory,
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

export function SettingsView(props: { onNotify?: (msg: string) => void }) {
  const shell = shellInfo();
  const activePkg = runningPackage();
  const otaBusy = signal(false);
  const otaStatus = signal<string>("");
  const availablePkg = signal<PackageUpdate | null>(null);
  const downloadedPkg = signal(false);

  const checkOta = async () => {
    if (otaBusy()) return;
    otaBusy.set(true);
    otaStatus.set("正在检查解析包更新…");
    downloadedPkg.set(false);
    try {
      const update = await checkForPackage();
      availablePkg.set(update);
      if (update) {
        otaStatus.set(`发现新解析包 v${update.version}（构建 ${update.build}）`);
      } else {
        otaStatus.set(shell.packages ? "当前已是最新解析包" : "当前为开发运行或未配置 OTA 源");
      }
    } catch (e) {
      otaStatus.set(e instanceof Error ? `检查失败：${e.message}` : "检查热更新失败");
    } finally {
      otaBusy.set(false);
    }
  };

  const applyOta = async () => {
    if (otaBusy() || !availablePkg()) return;
    otaBusy.set(true);
    otaStatus.set("正在下载并校验签名包…");
    try {
      await downloadPackage((p) => {
        if (p.total && p.total > 0) {
          otaStatus.set(`正在下载解析包 ${Math.round((p.received / p.total) * 100)}%…`);
        }
      });
      downloadedPkg.set(true);
      otaStatus.set("签名校验通过，正在重启加载新解析包…");
      await restartToPackage();
    } catch (e) {
      otaStatus.set(e instanceof Error ? `更新失败：${e.message}` : "热更新失败");
    } finally {
      otaBusy.set(false);
    }
  };

  const clearAllDownloads = async () => {
    try {
      const res = await servicePost<{ cleared: number }>("/downloads/clear", { scope: "all" });
      props.onNotify?.(`已清理 ${res.cleared} 个离线下载任务`);
    } catch (e) {
      props.onNotify?.(e instanceof Error ? e.message : "清理下载失败");
    }
  };

  return (
    <Scroll class="flex-1">
    <View class="gap-4 pb-6">
      <View class="bg-card border border-border rounded-xl p-4 gap-3">
        <Text class="text-base font-semibold text-foreground">外观</Text>
        <View class="flex-row items-center justify-between">
          <Text class="text-sm text-muted-foreground">主题模式</Text>
          <View class="flex-row gap-2">
            <FilterChip
              label="深色"
              selected={colorScheme() === "dark"}
              onPress={() => updatePreferences({ colorScheme: "dark" })}
            />
            <FilterChip
              label="浅色"
              selected={colorScheme() === "light"}
              onPress={() => updatePreferences({ colorScheme: "light" })}
            />
          </View>
        </View>
      </View>

      <View class="bg-card border border-border rounded-xl p-4 gap-3">
        <Text class="text-base font-semibold text-foreground">播放设置</Text>
        <View class="flex-row items-center justify-between flex-wrap gap-2">
          <Text class="text-sm text-muted-foreground">默认清晰度</Text>
          <View class="flex-row gap-1.5 flex-wrap">
            <Each of={QUALITIES}>
              {q => (
                <FilterChip
                  label={q().label}
                  selected={preferences().defaultQuality === q().value}
                  onPress={() => updatePreferences({ defaultQuality: q().value })}
                />
              )}
            </Each>
          </View>
        </View>
        <View class="flex-row items-center justify-between">
          <Text class="text-sm text-muted-foreground">播完自动连播下一集</Text>
          <Button
            label={preferences().autoPlayNext ? "已开启" : "已关闭"}
            variant={preferences().autoPlayNext ? "primary" : "outline"}
            size="sm"
            onPress={() => updatePreferences({ autoPlayNext: !preferences().autoPlayNext })}
          />
        </View>
        <View class="flex-row items-center justify-between">
          <Text class="text-sm text-muted-foreground">默认开启弹幕</Text>
          <Button
            label={preferences().danmakuEnabled ? "已开启" : "已关闭"}
            variant={preferences().danmakuEnabled ? "primary" : "outline"}
            size="sm"
            onPress={() => updatePreferences({ danmakuEnabled: !preferences().danmakuEnabled })}
          />
        </View>
      </View>

      <View class="bg-card border border-border rounded-xl p-4 gap-3">
        <Text class="text-base font-semibold text-foreground">本地数据与存储</Text>
        <View class="flex-row items-center justify-between">
          <Text class="text-sm text-muted-foreground">当前本地观看历史：{watchHistory().length} 条</Text>
          <Button
            label="清空本地历史"
            variant="outline"
            size="sm"
            disabled={watchHistory().length === 0}
            onPress={() => {
              removeHistoryItems(watchHistory().map(i => i.seriesId));
              props.onNotify?.("已清空当前账号的本地观看历史");
            }}
          />
        </View>
        <View class="flex-row items-center justify-between">
          <Text class="text-sm text-muted-foreground">离线下载目录：.tmp/downloads</Text>
          <Button
            label="清理全部离线下载"
            variant="outline"
            size="sm"
            onPress={() => void clearAllDownloads()}
          />
        </View>
        <View class="flex-row items-center justify-between">
          <Text class="text-sm text-muted-foreground">偏好设置</Text>
          <Button
            label="恢复默认设置"
            variant="ghost"
            size="sm"
            onPress={() => {
              resetPreferences();
              props.onNotify?.("已恢复默认外观与播放设置");
            }}
          />
        </View>
      </View>

      <View class="bg-card border border-border rounded-xl p-4 gap-3">
        <Text class="text-base font-semibold text-foreground">解析包热更新（OTA）</Text>
        <View class="flex-row items-center justify-between gap-2 flex-wrap">
          <View class="gap-1">
            <Text class="text-sm text-muted-foreground">
              {activePkg
                ? `当前运行热更新包：v${activePkg.version}（构建 ${activePkg.build}）`
                : `当前运行内置包${shell.version ? `：v${shell.version}（构建 ${shell.build ?? "-"}）` : ""}`}
            </Text>
            <If when={Boolean(otaStatus())}>
              <Text class="text-xs text-muted-foreground">{otaStatus()}</Text>
            </If>
          </View>
          <View class="flex-row gap-2">
            <Button
              label={otaBusy() ? "处理中…" : "检查热更新"}
              variant="outline"
              size="sm"
              disabled={otaBusy()}
              onPress={() => void checkOta()}
            />
            <If when={Boolean(availablePkg()) && !downloadedPkg()}>
              <Button
                label="下载并重启"
                variant="primary"
                size="sm"
                disabled={otaBusy()}
                onPress={() => void applyOta()}
              />
            </If>
          </View>
        </View>
      </View>

      <View class="bg-card border border-border rounded-xl p-4 gap-1.5">
        <Text class="text-base font-semibold text-foreground">关于</Text>
        <Text class="text-xs text-muted-foreground">{`红果短剧 NSH 客户端 · NSH ${shell.nshVersion} · Rust 底座 + TSX 可热更解析层`}</Text>
        <Text class="text-xs text-muted-foreground">协议与媒体模块遵循 GPL-3.0 许可 · 无遥测</Text>
      </View>
    </View>
    </Scroll>
  );
}
