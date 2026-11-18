# 开发交接

## 2026-11-18 macOS 应用包

新应用图标位于 `assets/app-icon.png`。 `./tools/package-macos` 通过固定版本的 NSH 打包，附带 Node.js 和片源服务。启动器生成一次性的本机连接凭证，应用退出后服务随之结束。离线下载写入用户 Application Support 目录。

Apple Silicon 应用已安装为 `/Applications/红果短剧-NSH.app`，通过严格签名校验，并从已安装应用的原生窗口确认推荐视频出画。类型检查、构建和 59 项相关测试通过。安装包使用临时签名，Intel 和公证发行尚未验证。

## 2026-11-18 正片取源恢复

本机安装了 `com.wails.hgplayer` 1.2.29 和 `io.github.jackotom.hongguo-drama-mac` 7.2.0。对照 [hongguo-drama v7.5](https://github.com/jackotom/hongguo-drama/releases/tag/v7.5) 与 [hongguoTV 播放修复](https://github.com/N3urda/hongguoTV/pull/60)，确认现有取源请求使用旧协议。引入 Android v5 的播放签名、播放器端点和响应分组解析，沿用已有匿名注册、分集匹配、清晰度检查、CENC 解密及 Range 服务。推荐和普通播放页已移除「打开红果官网」入口。

修复前，截图样本《穿越八零，我把娘俩宠成宝》首集的本机 `/play` 返回 502 / `EMPTY_RESPONSE`，官网公开 MP4 仅 10 秒。修复后该剧第 1、2 集分别返回约 96.94、100.84 秒的完整媒体，H.265 / 1080p。另验证《持械入宋：第十一季》《全球死考：刚下刑场你让我去考试一季》首集，以及《宴律，你的白月光回国了》分集 ID `7503780574541122622`。5 个样本均通过 `/play` 200、媒体 Range 206、MP4 格式和第 12 秒解码。macOS AVFoundation 从截图样本首集第 61 秒提取出 1080×1924 画面。

NSH check/build、应用与播放会话 5 项测试、服务/签名/设备/媒体 48 项测试通过。开发实例需重启 `./tools/dev` 加载新服务代码。下一步在原生窗口验证推荐首播、选集切换和连续播放。

## 最新：推荐首屏与界面完善

已保留 Anti Gravity 的账号/下载/发现实现，新增默认推荐视频首屏，调整侧栏、筛选、海报和新剧/榜单布局。当前最新事实先读 [implementation-03.md](evidence/implementation-03.md)。check/build和11项相关NSH测试通过；真实推荐首部在线出画，截图归档 docs/evidence/ui-03/。实机暂停被桌面工具拒绝，未宣称人工通过。下一步可在工具能正确归属窗口后验收暂停/选集，并继续处理主播放器一致性和流式首帧。以下为Anti Gravity阶段记录，保留历史但优先以上最新记录。

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

4. **离线下载持久化、发现网格、播放器与个人资料完善（本轮）**：
   - [service/downloads.cjs](service/downloads.cjs) & [service/server.cjs](service/server.cjs)：任务列表持久化至 `.tmp/downloads/tasks.json`，服务重启自动恢复状态并清理残余 `.part` 文件；新增 `/downloads/retry` 与 `/downloads/clear`。
   - [src/features/downloads/DownloadsView.tsx](src/features/downloads/DownloadsView.tsx)：支持状态筛选（全部/下载中/已完成/失败或取消）、失败/取消重试、批量清理以及已占用空间统计。
   - [src/features/player/Player.tsx](src/features/player/Player.tsx) & [session.ts](src/features/player/session.ts)：新增追更按钮、上一集/下一集切换、进度条可视化、退出前 `flushProgress()`、选集已看标记（`✓`）、错误重试按钮与离线播放识别。
   - [src/features/discover/discover-store.ts](src/features/discover/discover-store.ts) & [DiscoverView.tsx](src/features/discover/DiscoverView.tsx)：抽离发现/搜索/详情/分类/榜单状态至 store，保留返回状态并用 `AbortController` 取消旧请求；进入找剧/新剧/排行榜/推荐/上新日历时自动加载对应数据（无需手动点加载）；接入真实 App 分类筛选（`POST /reading/distribution/category/landpage/v/`，含 7 组真实筛选枚举与近 7 天上新）和 App 热播榜（`GET /reading/bookapi/bookmall/cell/change/v`，支持总榜/真人/漫剧/AI 剧切换与分页）；接入 `PosterCard` 4 列虚拟化海报网格与列表切换。
   - [service/discover.cjs](service/discover.cjs) & [service/server.cjs](service/server.cjs)：新增 `browseCategory`、 `browseRank`、`catalogCover`（安全 `.heic` → JPEG 转换）以及 `/discover/category`、`/discover/rank` 路由。
   - [src/providers/catalog.ts](src/providers/catalog.ts)：安全过滤 `video_list` 中的 `null` 行。
   - [service/auth.cjs](service/auth.cjs) & [service/server.cjs](service/server.cjs)：修复 `restoreSession()` 非 401 误删钥匙串与持久化状态回传；新增 `fetchCloudBookshelf`（`/reading/bookapi/bookshelf/video/list/v` + `/reading/bookapi/multi-detail/v1/`）与 `GET /auth/cloud-bookshelf`，并用 `catalogCover` 转换云端历史/书架的 `.heic` 封面。
   - **登录态被误删根因修复**（[service/keychain.cjs](service/keychain.cjs)、[service/extra.test.cjs](service/extra.test.cjs)、[service/auth.cjs](service/auth.cjs)、[service/server.cjs](service/server.cjs)、[App.tsx](App.tsx)）：定位此前重启 `./tools/dev` 后钥匙串消失的直接原因为 `service/extra.test.cjs` 第 72/78 行无参调用 `logoutAccount()` 时触发真实 `keychain.deleteSecret()` 物理清除了系统钥匙串 `com.hgdrama.nsh.session`；现已在 `keychain.cjs` 中增加测试进程保护（`NODE_TEST_CONTEXT`/`--test`/`HG_DISABLE_KEYCHAIN=1` 下 `isAvailable()` 返回 `false`），在 `extra.test.cjs` 显式传入 mock store，在 `restoreSession()` 中改用 `cookieJar` 副本校验且不再自动删除有效钥匙串，在 `fetchCloudHistory`/`fetchCloudBookshelf` 与 `server.cjs` `start()` 提前执行 `restoreSession`，并将 `App.tsx` 启动加载改为串行 `loadUserData("guest").then(() => refreshAccountStatus())`。
   - [src/stores/user-data.ts](src/stores/user-data.ts)、[HistoryView.tsx](src/features/history/HistoryView.tsx)、[SettingsView.tsx](src/features/settings/SettingsView.tsx) & [App.tsx](App.tsx)：主题深浅色与侧栏折叠状态持久化；历史/收藏/点赞/追更统一支持批量管理删除；已登录时进入「历史/收藏/点赞」或「追更/预约」自动拉取云端历史（104 条实测）与云端书架（4 部实测），账号切换/退出自动隔离清空；设置页新增清理离线下载与恢复默认设置。

## 当前验证结果

已通过全部离线检查、单测与真实在线接口验证：
- `./tools/nsh check`：0 错误
- `./tools/nsh build`：通过（`128.4 KB js, 629.9 KB bytecode`）
- `./tools/nsh test App.test.tsx`：3/3 通过
- `./tools/nsh test src/features/player/session.test.tsx`：1/1 通过
- `./tools/nsh test tools/probes/runtime.test.tsx`：2/2 通过
- `node --test --test-concurrency=1 service/server.test.cjs service/extra.test.cjs src/media/cenc.test.cjs service/vendor/hongguo/playback-signature.test.cjs service/vendor/hongguo/playback-device.test.cjs`：37/37 通过
- 真实在线验证：`browseCategory` 返回 3 条近期上新与 7 组筛选枚举；`browseRank`（`hot-drama`）返回 11 条榜单短剧且 `hasMore: true`。
- 真实在线验证（本轮）：`7503745441910017049` 第 2 集经 `service/server.cjs` `/play` → 官方取源 → CDN 下载 → CENC 解密 → Range `206` 验证通过。

## 仍待用户配合或后续推进

1. **真实桌面窗口视觉对照 & 真实扫码**：可在桌面解锁状态下运行 `./tools/dev` 检查主窗口深/浅色及各页布局，并在「我的 / 登录」页面用红果/抖音 App 扫码实测登录与账号切换。
2. **流式首帧与跨平台后端**：当前播放与下载仍先整集下载解密后起播；后续可推进分片/流式解密以降低首帧等待，并按 `PLAN.md` P8 推进 Windows/Linux/移动端后端。
3. **上游未公开接口**：分类筛选枚举（`landpage` 实测返回 404）与云端上新日历/写回接口仍待后续抓包或协议补全，当前 UI 已明确区分本地状态与官网公开能力。
