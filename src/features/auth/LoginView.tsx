import { signal, View, Text, Image, cleanup } from "nsh";
import { Button, FilterChip } from "../../ui/controls";
import { serviceGet, servicePost } from "../../service-client";
import { loadUserData } from "../../stores/user-data";

export interface AccountUser {
  userId: string;
  nickname: string;
  avatar: string;
}

export const currentAccount = signal<AccountUser | null>(null);

export async function refreshAccountStatus(): Promise<void> {
  try {
    const res = await serviceGet<{ loggedIn: boolean; user?: AccountUser }>("/auth/status");
    if (res.loggedIn && res.user) {
      currentAccount.set(res.user);
      await loadUserData(`user:${res.user.userId}`);
    } else {
      currentAccount.set(null);
    }
  } catch {
    // Ignore when local service is not started yet.
  }
}

export function LoginView() {
  const mode = signal<"qr" | "sms">("qr");
  const status = signal<"idle" | "loading" | "waiting" | "scanned" | "expired" | "cancelled" | "error">("idle");
  const qrSrc = signal("");
  const message = signal("");
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let generation = 0;

  const stopPolling = () => {
    generation += 1;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  };

  cleanup(stopPolling);

  const startQr = async () => {
    stopPolling();
    const gen = generation;
    status.set("loading");
    message.set("");
    qrSrc.set("");
    try {
      const res = await servicePost<{ token: string; qrcode: string; expireTime: number }>("/auth/qr", {});
      if (gen !== generation) return;
      const raw = res.qrcode || "";
      const img = raw.startsWith("data:") || raw.startsWith("https://") ? raw : raw ? `data:image/png;base64,${raw}` : "";
      qrSrc.set(img);
      status.set("waiting");
      pollTimer = setInterval(async () => {
        if (gen !== generation) return;
        try {
          const poll = await servicePost<{ status: string; user?: AccountUser }>("/auth/poll", { token: res.token });
          if (gen !== generation) return;
          if (poll.status === "scanned") {
            status.set("scanned");
          } else if (poll.status === "expired") {
            stopPolling();
            status.set("expired");
          } else if (poll.status === "cancelled") {
            stopPolling();
            status.set("cancelled");
          } else if (poll.status === "confirmed" && poll.user) {
            stopPolling();
            currentAccount.set(poll.user);
            await loadUserData(`user:${poll.user.userId}`);
            status.set("idle");
          }
        } catch (e) {
          if (gen !== generation) return;
          stopPolling();
          status.set("error");
          message.set(e instanceof Error ? e.message : "扫码状态检查失败");
        }
      }, 2000);
    } catch (e) {
      if (gen !== generation) return;
      status.set("error");
      message.set(e instanceof Error ? e.message : "获取二维码失败");
    }
  };

  const logout = async () => {
    stopPolling();
    try {
      await servicePost("/auth/logout", {});
    } catch {
      // Clear local UI session regardless.
    }
    currentAccount.set(null);
    await loadUserData("guest");
    status.set("idle");
    qrSrc.set("");
  };

  return (
    <View class="flex-1 items-center justify-center p-6">
      <View class="bg-card border border-border rounded-xl p-6 gap-4 items-center" style={{ width: 400 }}>
        <If when={!!currentAccount()}>
          {() => {
            const u = currentAccount()!;
            return (
              <View class="items-center gap-3 w-full">
                <If when={!!u.avatar}>
                  <Image src={u.avatar} style={{ width: 64, height: 64, borderRadius: 32 }} />
                </If>
                <Text class="text-lg font-semibold text-foreground">{u.nickname}</Text>
                <Text class="text-xs text-muted-foreground">账号 ID：{u.userId}</Text>
                <Text class="text-xs text-muted-foreground">当前为内存会话，应用重启后需重新扫码验证</Text>
                <Button label="退出登录" variant="destructive" onPress={() => void logout()} />
              </View>
            );
          }}
        </If>

        <If when={!currentAccount()}>
          <View class="items-center gap-4 w-full">
            <Text class="text-lg font-semibold text-foreground">登录红果账号</Text>
            <View class="flex-row gap-2">
              <FilterChip
                label="扫码登录"
                selected={mode() === "qr"}
                onPress={() => mode.set("qr")}
              />
              <FilterChip
                label="短信登录"
                selected={mode() === "sms"}
                onPress={() => {
                  stopPolling();
                  mode.set("sms");
                }}
              />
            </View>

            <If when={mode() === "sms"}>
              <View class="items-center gap-2 py-6">
                <Text class="text-sm text-muted-foreground">短信登录接口契约待补全，请使用官方 App 扫码登录</Text>
              </View>
            </If>

            <If when={mode() === "qr"}>
              <View class="items-center gap-3 w-full">
                <If when={status() === "idle"}>
                  <Button label="生成登录二维码" variant="primary" onPress={() => void startQr()} />
                </If>
                <If when={status() === "loading"}>
                  <Text class="text-sm text-muted-foreground py-8">正在获取官方二维码…</Text>
                </If>
                <If when={!!qrSrc() && (status() === "waiting" || status() === "scanned")}>
                  <Image src={qrSrc()} style={{ width: 180, height: 180, borderRadius: 8 }} />
                  <Text class="text-xs text-foreground">
                    {status() === "scanned" ? "已扫码，请在手机端确认登录" : "请使用红果短剧或抖音 App 扫码"}
                  </Text>
                  <Button label="刷新二维码" variant="outline" size="sm" onPress={() => void startQr()} />
                </If>
                <If when={status() === "expired" || status() === "cancelled"}>
                  <Text class="text-sm text-muted-foreground py-4">
                    {status() === "expired" ? "二维码已过期" : "已取消扫码"}
                  </Text>
                  <Button label="重新获取" variant="primary" size="sm" onPress={() => void startQr()} />
                </If>
                <If when={status() === "error"}>
                  <Text class="text-sm text-destructive">{message()}</Text>
                  <Button label="重试" variant="primary" size="sm" onPress={() => void startQr()} />
                </If>
                <Text class="text-xs text-muted-foreground">
                  仅限内存会话，不读取原客户端秘密，不写入本地明文存储
                </Text>
              </View>
            </If>
          </View>
        </If>
      </View>
    </View>
  );
}
