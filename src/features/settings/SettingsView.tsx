import { View, Text, colorScheme } from "nsh";
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
  const clearAllDownloads = async () => {
    try {
      const res = await servicePost<{ cleared: number }>("/downloads/clear", { scope: "all" });
      props.onNotify?.(`已清理 ${res.cleared} 个离线下载任务`);
    } catch (e) {
      props.onNotify?.(e instanceof Error ? e.message : "清理下载失败");
    }
  };

  return (
    <View class="flex-1 gap-4">
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

      <View class="bg-card border border-border rounded-xl p-4 gap-1.5">
        <Text class="text-base font-semibold text-foreground">关于</Text>
        <Text class="text-xs text-muted-foreground">红果短剧 NSH 客户端 · NSH 0.5.1 · TSX · macOS</Text>
        <Text class="text-xs text-muted-foreground">协议与媒体模块遵循 GPL-3.0 许可 · 无遥测 · 无自动更新</Text>
      </View>
    </View>
  );
}
