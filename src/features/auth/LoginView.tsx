import { signal, View, Text, Image, cleanup } from "nsh";
import { Input } from "nsh/base";
import { Button, FilterChip } from "../../ui/controls";
import { serviceGet, servicePost } from "../../service-client";
import { loadUserData } from "../../stores/user-data";

export interface AccountUser {
  userId: string;
  nickname: string;
  avatar: string;
}

export const currentAccount = signal<AccountUser | null>(null);
export const sessionPersistent = signal(false);
export const sessionPendingVerification = signal(false);

export async function refreshAccountStatus(): Promise<void> {
  try {
    const res = await serviceGet<{
      loggedIn: boolean;
      user?: AccountUser;
      persistent?: boolean;
      pendingVerification?: boolean;
    }>("/auth/status");
    sessionPersistent.set(Boolean(res.persistent));
    sessionPendingVerification.set(Boolean(res.pendingVerification));
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

  // SMS state
  const mobile = signal("");
  const smsCode = signal("");
  const captchaText = signal("");
  const captchaImg = signal("");
  const smsBusy = signal(false);
  const smsError = signal("");
  const smsNotice = signal("");
  const countdown = signal(0);

  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let countdownTimer: ReturnType<typeof setInterval> | undefined;
  let generation = 0;

  const stopPolling = () => {
    generation += 1;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  };

  const stopCountdown = () => {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = undefined;
    }
  };

  cleanup(() => {
    stopPolling();
    stopCountdown();
  });

  const startCountdown = (seconds: number) => {
    stopCountdown();
    countdown.set(seconds);
    countdownTimer = setInterval(() => {
      const next = countdown() - 1;
      if (next <= 0) {
        countdown.set(0);
        stopCountdown();
      } else {
        countdown.set(next);
      }
    }, 1000);
  };

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
      const schedulePoll = () => {
        if (gen !== generation) return;
        pollTimer = setTimeout(async () => {
          if (gen !== generation) return;
          try {
            const poll = await servicePost<{ status: string; user?: AccountUser; persistent?: boolean }>("/auth/poll", { token: res.token });
            if (gen !== generation) return;
            if (poll.status === "scanned") {
              status.set("scanned");
              schedulePoll();
            } else if (poll.status === "expired") {
              stopPolling();
              status.set("expired");
            } else if (poll.status === "cancelled") {
              stopPolling();
              status.set("cancelled");
            } else if (poll.status === "confirmed" && poll.user) {
              stopPolling();
              currentAccount.set(poll.user);
              sessionPersistent.set(Boolean(poll.persistent));
              sessionPendingVerification.set(false);
              await loadUserData(`user:${poll.user.userId}`);
              status.set("idle");
            } else {
              schedulePoll();
            }
          } catch (e) {
            if (gen !== generation) return;
            stopPolling();
            status.set("error");
            message.set(e instanceof Error ? e.message : "扫码状态检查失败");
          }
        }, 2000);
      };
      schedulePoll();
    } catch (e) {
      if (gen !== generation) return;
      status.set("error");
      message.set(e instanceof Error ? e.message : "获取二维码失败");
    }
  };

  const sendCode = async () => {
    if (smsBusy() || countdown() > 0) return;
    smsBusy.set(true);
    smsError.set("");
    smsNotice.set("");
    try {
      const res = await servicePost<{ sent: boolean; retryAfter?: number; captcha?: string; message?: string }>(
        "/auth/sms/send",
        {
          mobile: mobile().trim(),
          ...(captchaText().trim() ? { captcha: captchaText().trim() } : {}),
        },
      );
      if (res.sent) {
        captchaImg.set("");
        captchaText.set("");
        smsNotice.set("验证码已发送，请注意查收短信");
        startCountdown(res.retryAfter && res.retryAfter > 0 ? res.retryAfter : 60);
      } else if (res.captcha) {
        const img = res.captcha.startsWith("data:") ? res.captcha : `data:image/png;base64,${res.captcha}`;
        captchaImg.set(img);
        smsError.set(res.message || "请输入图形验证码后重试");
      }
    } catch (e) {
      smsError.set(e instanceof Error ? e.message : "发送验证码失败");
    } finally {
      smsBusy.set(false);
    }
  };

  const submitSmsLogin = async () => {
    if (smsBusy()) return;
    smsBusy.set(true);
    smsError.set("");
    try {
      const res = await servicePost<{ loggedIn: boolean; user?: AccountUser; persistent?: boolean; captcha?: string; message?: string }>(
        "/auth/sms/login",
        {
          mobile: mobile().trim(),
          code: smsCode().trim(),
          ...(captchaText().trim() ? { captcha: captchaText().trim() } : {}),
        },
      );
      if (res.loggedIn && res.user) {
        stopCountdown();
        currentAccount.set(res.user);
        sessionPersistent.set(Boolean(res.persistent));
        sessionPendingVerification.set(false);
        await loadUserData(`user:${res.user.userId}`);
        mobile.set("");
        smsCode.set("");
        captchaImg.set("");
        captchaText.set("");
        smsNotice.set("");
      } else if (res.captcha) {
        const img = res.captcha.startsWith("data:") ? res.captcha : `data:image/png;base64,${res.captcha}`;
        captchaImg.set(img);
        smsError.set(res.message || "请输入图形验证码");
      }
    } catch (e) {
      smsError.set(e instanceof Error ? e.message : "短信登录失败");
    } finally {
      smsBusy.set(false);
    }
  };

  const logout = async () => {
    stopPolling();
    stopCountdown();
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
                <Text class="text-xs text-muted-foreground">
                  {sessionPendingVerification()
                    ? "当前为待验证会话，联网后将自动核验"
                    : sessionPersistent()
                      ? "会话已安全保存于系统钥匙串，重启自动恢复"
                      : "当前为内存会话，应用重启后需重新登录验证"}
                </Text>
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
              <View class="w-full gap-3">
                <Input
                  class="bg-background border border-input rounded-lg px-3.5 py-2.5 text-sm text-foreground"
                  value={mobile()}
                  onChange={({ value }) => mobile.set(value)}
                  placeholder="请输入手机号（如 13800138000）"
                />
                <View class="flex-row gap-2 items-center">
                  <Input
                    class="flex-1 bg-background border border-input rounded-lg px-3.5 py-2.5 text-sm text-foreground"
                    value={smsCode()}
                    onChange={({ value }) => smsCode.set(value)}
                    placeholder="短信验证码"
                  />
                  <Button
                    label={countdown() > 0 ? `${countdown()}s 后重发` : "发送验证码"}
                    variant="outline"
                    size="sm"
                    disabled={smsBusy() || countdown() > 0}
                    onPress={() => void sendCode()}
                  />
                </View>

                <If when={!!captchaImg()}>
                  <View class="gap-2 items-center">
                    <Image src={captchaImg()} style={{ width: 140, height: 48, borderRadius: 6 }} />
                    <Input
                      class="w-full bg-background border border-input rounded-lg px-3.5 py-2 text-sm text-foreground"
                      value={captchaText()}
                      onChange={({ value }) => captchaText.set(value)}
                      placeholder="请输入图形验证码"
                    />
                  </View>
                </If>

                <If when={!!smsNotice()}>
                  <Text class="text-xs text-primary">{smsNotice()}</Text>
                </If>
                <If when={!!smsError()}>
                  <Text class="text-xs text-destructive">{smsError()}</Text>
                </If>

                <Button
                  label={smsBusy() ? "登录中…" : "登录"}
                  variant="primary"
                  disabled={smsBusy()}
                  onPress={() => void submitSmsLogin()}
                />
                <Text class="text-xs text-muted-foreground text-center">
                  会话仅保存于系统安全钥匙串，不读取原客户端秘密，不写入明文配置
                </Text>
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
                  会话仅保存于系统安全钥匙串，不读取原客户端秘密，不写入明文配置
                </Text>
              </View>
            </If>
          </View>
        </If>
      </View>
    </View>
  );
}
