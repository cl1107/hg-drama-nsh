import { signal } from "nsh";
import {
  checkForPackage,
  downloadPackage,
  restartToPackage,
  runningPackage,
  shellInfo,
  type PackageUpdate,
  type RunningPackage,
  type ShellInfo,
} from "nsh/updater";

export const otaBusy = signal(false);
export const otaStatus = signal("");
export const otaError = signal("");
export const availableOta = signal<PackageUpdate | null>(null);
export const otaDownloaded = signal(false);
export const otaPromptDismissed = signal(false);

export function otaShellInfo(): ShellInfo {
  return shellInfo();
}

export function otaRunningPackage(): RunningPackage | null {
  return runningPackage();
}

export function dismissOtaPrompt(): void {
  otaPromptDismissed.set(true);
}

export function resetOtaStateForTest(): void {
  otaBusy.set(false);
  otaStatus.set("");
  otaError.set("");
  availableOta.set(null);
  otaDownloaded.set(false);
  otaPromptDismissed.set(false);
}

export async function checkOtaUpdate(options?: { silent?: boolean }): Promise<PackageUpdate | null> {
  const silent = Boolean(options?.silent);
  if (otaBusy()) return availableOta();

  const shell = shellInfo();
  if (silent && !shell.packages) {
    return null;
  }

  otaBusy.set(true);
  otaError.set("");
  if (!silent) {
    otaStatus.set("正在检查解析包更新…");
  }
  otaDownloaded.set(false);

  try {
    const update = await checkForPackage();
    availableOta.set(update);
    if (update) {
      otaPromptDismissed.set(false);
      otaStatus.set(`发现新解析包 v${update.version}（构建 ${update.build}）`);
    } else if (!silent) {
      otaStatus.set(shell.packages ? "当前已是最新解析包" : "当前为开发运行或未配置 OTA 源");
    }
    return update;
  } catch (error) {
    if (!silent) {
      const msg = error instanceof Error ? `检查失败：${error.message}` : "检查热更新失败";
      otaStatus.set(msg);
      otaError.set(msg);
    }
    return null;
  } finally {
    otaBusy.set(false);
  }
}

export async function applyOtaUpdate(): Promise<void> {
  if (otaBusy() || !availableOta()) return;
  otaBusy.set(true);
  otaError.set("");
  otaStatus.set("正在下载并校验签名包…");
  try {
    await downloadPackage((p) => {
      if (p.total && p.total > 0) {
        otaStatus.set(`正在下载解析包 ${Math.round((p.received / p.total) * 100)}%…`);
      }
    });
    otaDownloaded.set(true);
    otaStatus.set("签名校验通过，正在重启加载新解析包…");
    await restartToPackage();
  } catch (error) {
    const msg = error instanceof Error ? `更新失败：${error.message}` : "热更新失败";
    otaStatus.set(msg);
    otaError.set(msg);
  } finally {
    otaBusy.set(false);
  }
}
