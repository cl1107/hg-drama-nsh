# 开发交接（2026-11-15）

## 目标与约束

在 `/Users/cl/ai/hg-drama-nsh` 开发红果短剧全平台客户端，NSH TSX 模式，先完成 macOS 本机。界面只参考 `docs/ui/` 七张用户截图和 `/Applications/红果短剧.app`；`jackotom/hongguo-drama` 仅用于协议与媒体处理参考。

中文沟通，简短直接。保留现有工作，不读取原红果客户端/浏览器的登录秘密；真实登录由用户扫码确认。临时诊断文件有 DEBUG 标记，是否清理由用户决定。不要将未实现入口、fixture 或媒体缓存冒充在线能力。

## 本轮已完成

1. **取源稳定性排查与验证**：
   - 核对 `service/vendor/hongguo/app-source.js`（`fetchAppPlayUrlFresh`、`playbackRequest`、`requestJson`）与 `service/transport.cjs`，确认 query 编码、Argus/Ladon 551 签名、gzip 请求体与单次回退逻辑与固定参考提交 `782fb21cbddf1be46f88e97af5e788c99e30beae` 一致。
   - 实测固定剧 `7503745441910017049` 第 1 集 `7503780574541122622` 时，`VIDEO_TAB_API` 与 `VIDEO_API`（含换用 `sinfonlinea` 或补充 `Accept-Encoding`）均返回服务端 `HTTP 200 Content-Length: 0`（`EMPTY_RESPONSE`）；同一剧 **第 2 集** 实测在线取源（`hevc / 1080p`）、CDN 下载、CENC 解密与本机 Range `206`（`ftyp`）全链路通过（耗时 3918 ms）。确认 `EMPTY_RESPONSE` 为上游针对高频/特定分集的空响应行为，未堆砌重试或放宽校验。

2. **本机 Node 24 服务扩展 (`service/`)**：
   - [service/playback.cjs](service/playback.cjs)：详情提取补充 `cover`、`intro`、`tags`；支持清晰度参数透传。
   - [service/discover.cjs](service/discover.cjs)：基于 `signedSearchRequest` 接入 App 在线搜索与分页游标解析（保大整数 ID 精度，不造假数据）。
   - [service/auth.cjs](service/auth.cjs)：基于官网扫码接口实现二维码获取、状态轮询、账号校验与退出；CookieJar 仅驻进程内存，严格域隔离，不落盘、不回传 TSX。
   - [service/downloads.cjs](service/downloads.cjs)：离线下载队列（复用 `prepare()` 解密，支持启动/取消/删除/离线 Range 播放，落盘于被忽略的 `.tmp/downloads/`）。
   - [service/server.cjs](service/server.cjs)：新增 `/detail`、`/search`、`/auth/*`、`/downloads/*` 路由，保持回环地址、Bearer 鉴权、拒绝外部 Origin 与原有 `/play`、`/media/*` 契约。

3. **Design System 与全页面 TSX 实现 (`nsh.json`, `src/`, `App.tsx`)**：
   - [nsh.json](nsh.json)：补齐深/浅色语义 tokens（`card`、`destructive`、`ring`、`selection`、`rating` 等）。
   - [src/ui/controls.tsx](src/ui/controls.tsx)：统一封装 `Button`、`SidebarItem`、`PageHeader`、`SearchField`、`FilterChip`、`StatusView`、`DramaListRow`、`PosterCard`（仅消费语义 token）。
   - [src/stores/user-data.ts](src/stores/user-data.ts)：基于 `nsh` `Storage` 实现按账号隔离的本地观看历史、收藏、点赞、追更/预约及偏好设置（不存储任何 Cookie/凭据）。
   - [src/features/player/Player.tsx](src/features/player/Player.tsx) & [session.ts](src/features/player/session.ts)：完善播放头栏（返回/收藏/点赞/下载/简介）、选集虚拟列表、进度条时间、音量/静音、倍速、清晰度切换、自动连播防重与断点续播。
   - [src/features/discover/DiscoverView.tsx](src/features/discover/DiscoverView.tsx)：官网目录浏览与过滤、App 在线搜索与分页、剧集详情面板、榜单视图、日历日期条与本地预约。
   - [src/features/history/HistoryView.tsx](src/features/history/HistoryView.tsx)、[DownloadsView.tsx](src/features/downloads/DownloadsView.tsx)、[LoginView.tsx](src/features/auth/LoginView.tsx)、[SettingsView.tsx](src/features/settings/SettingsView.tsx) 与 [App.tsx](App.tsx) 全侧栏导航打通。

## 当前验证结果

已通过全部离线检查与新增单测：
- `./tools/nsh check`：0 错误
- `./tools/nsh build`：通过（`85.6 KB js, 394.7 KB bytecode`）
- `./tools/nsh test App.test.tsx`：3/3 通过
- `./tools/nsh test src/features/player/session.test.tsx`：1/1 通过
- `./tools/nsh test tools/probes/runtime.test.tsx`：2/2 通过
- `node --test --test-concurrency=1 service/server.test.cjs service/extra.test.cjs src/media/cenc.test.cjs service/vendor/hongguo/playback-signature.test.cjs service/vendor/hongguo/playback-device.test.cjs`：31/31 通过
- 真实在线验证（本轮）：`7503745441910017049` 第 2 集经 `service/server.cjs` `/play` → 官方取源 → CDN 下载 → CENC 解密 → Range `206` 验证通过。

## 仍待用户配合或后续推进

1. **真实桌面窗口视觉对照 & 真实扫码**：可在桌面解锁状态下运行 `./tools/dev` 检查主窗口深/浅色及各页布局，并在「我的 / 登录」页面用红果/抖音 App 扫码实测登录与账号切换。
2. **流式首帧与跨平台后端**：当前播放与下载仍先整集下载解密后起播；后续可推进分片/流式解密以降低首帧等待，并按 `PLAN.md` P8 推进 Windows/Linux/移动端后端。
3. **上游未公开接口**：分类筛选枚举（`landpage` 实测返回 404）与云端上新日历/写回接口仍待后续抓包或协议补全，当前 UI 已明确区分本地状态与官网公开能力。
