# 开发交接

## 2026-11-24 安装 unslop Skill、左侧菜单栏精修、播放修复与运行时自动探测自愈（OTA 构建号 14）

1. **安装 unslop Skill**：从 `heydamir/unslop` 安装至项目 [.agents/skills/unslop/](../.agents/skills/unslop/)（保留 CC BY 4.0 许可与作者署名）。
2. **左侧菜单栏 UI 优化**（[App.tsx](../App.tsx)、[src/ui/controls.tsx](../src/ui/controls.tsx)）：
   - 按 unslop 红线审计与 4px 栅格重写侧栏：外层补充对称水平内边距（展开 `220px` + `px-3`，收起 `64px` + `px-2.5`），彻底消除悬停/选中胶囊贴壁与撞边问题。
   - 导航行统一 `h-9`（36px）、`16px` 线框图标置于统一 `18×18` 对齐槽、组内 `gap-0.5`（2px），第二分组「我的」上间距 `pt-5`（20px）明显大于组内间距；收起态在两组间加水平细分割线。
   - 顶部增加极简品牌行（8px 莓红圆点 + `红果短剧`）并与收起按钮左右对齐；选中态改为柔和选区底 + 左侧 `3×16px` 圆角莓红焦点指示条（Signature 细节）；底部由 `border-t border-border/60` 分隔，「设置」占满 `flex-1` 与 `36×36` 主题按钮齐平，账号行补充单行省略保护。
   - 通过 `nsh test --target macos` 实机截屏验收深色展开态、深色折叠态与浅色展开态。
3. **播放故障根因修复 & 运行时自动探测自愈引擎**（[src/providers/source-resolver/v5.ts](../src/providers/source-resolver/v5.ts)、[src/providers/source-resolver/index.ts](../src/providers/source-resolver/index.ts)、[src/features/settings/SettingsView.tsx](../src/features/settings/SettingsView.tsx)）：
   - **根因**：2026-11-24 上游对 `multi_video_model/preload/v1`、`multi_video_model/player/v1` 与 `video_tab/multi_video_model/v1/` 全部返回 HTTP 200 空包（`content-length: 0`），而同 `field21=312` 签名下的单集端点 `POST /novel/player/video_model/v1/`（`content_type: 1004, video_id`）全节点正常返回 1080p HEVC + `spade_a`。
   - **运行时自适应探测与持久化自愈**：
     - 将策略抽象为 `PlaybackStrategy`（`mode × host × profile × field21`），支持 `video_model/v1/`、`preload/v1`、`video_tab/v1`、`player/v1` 与旧 `v1/`，以及多客户端画像（`modern_745`、`compat_743`、`cronet_739`）、`field21 ∈ {312, 377}` 与多主机池。
     - `raceStrategies()` 在竞速内直接完成模型解析与 `fallback_api` 编码协商，仅在拿到有效片源后才判胜；Tier 1 优先复用持久化到 `Storage`（`hg:resolver:strategy:v1`）的健康线路，失败时自动触发 Tier 2/3 有界探测（跨端点 → 跨主机 → 跨画像/`field21` → 换匿名设备重注册 → Legacy `v1/`），命中后自动持久化固化，无需改代码即可扛住上游单端点/单节点/已知参数轮换。
     - `SettingsView.tsx` 展示当前自适应解析线路、自愈次数与「重置线路探测」按钮。
4. **验证与 OTA 发布**：
   - 沙箱 `nsh check`（0 错误）、`nsh build`（`302.6 KB js, 1.2 MB bytecode`）、`App.test.tsx` **13/13**、`session.test.tsx` **1/1**、`feed.test.tsx` **4/4**、`resolver.test.tsx` **7/7** 全部通过。
   - 真实在线端到端实测：新 TSX `resolveEpisodeVariants` 3 部线上剧集（《宴律》454ms、《谁让这个文盲修仙的第七季》177ms、《和离后我带女儿横扫魔域第三季完结篇》174ms）全取源成功并完成《宴律》22.4 MB 完整 CENC 解密（`ftyp`）；模拟主节点返回空包时 2.3s 内自动探测切换至 `api5-normal-sinfonlineb` 并持久化。
   - 递增 `nsh.json` `build: 14`，推送 `ota-14` 标签触发 `.github/workflows/ota.yml` 发布签名 `.nshpkg` 热更新包。

## 2026-11-24 本机 v0.2.0 安装包 & Desktop packages CI

- **本机安装**：构建号 13（`nsh.json` `0.2.0`）已通过 `./tools/package-macos` 打包并替换 `/Applications/红果短剧-NSH.app`。`codesign --verify --deep --strict` 通过；宿主为 `Contents/MacOS/NSH` arm64，无 Node 后端。
- **CI 根因**：[run 45211811241](https://github.com/cl1107/hg-drama-nsh/actions/runs/45211811241) 的 macOS 任务因 GitHub 托管 arm64 runner 抢占失败被 cancelled（空 steps，注解 `not acquired by Runner of type hosted`），Windows 已成功；发布任务因此跳过。
- **CI 修复**：[.github/workflows/release.yml](../.github/workflows/release.yml) 将 macOS 超时提到 45 分钟；打包步骤抽到 [.github/actions/package-macos](../.github/actions/package-macos/action.yml)；首次仍用 `macos-15`，失败后再用 `macos-latest` 走不同容量池；`publish` 在两次尝试任一成功且 Windows 成功时继续。
- **发布结果**：重跑 [run 45211811241](https://github.com/cl1107/hg-drama-nsh/actions/runs/45211811241) 已成功，macOS / Windows / Publish 均通过，[GitHub Release v0.2.0](https://github.com/cl1107/hg-drama-nsh/releases/tag/v0.2.0) 已挂上两份 ZIP 与校验文件。master 上的换池重试用于后续标签。
- **下一步**：实机打开 `/Applications/红果短剧-NSH.app` 验收在线播放与 OTA 入口。

## 2026-11-23 方案 A 改造：Rust 稳定底座 + TSX 可 OTA 视频解析层

- **分支留存**：原完整 Rust 后端工作区改动已完整备份在分支 `backup/rust-full-backend`（`35158f3`）；`master` 保持 clean（`v0.1.2`）；本次方案 A 改造在分支 `feat/tsx-resolver-ota` 上完成。
- **Rust 稳定底座（`native/`）**：
  - [native/src/lib.rs](../native/src/lib.rs) 新增 `NativeCrypto` 模块注册到 `hg-drama/native`，向 TSX 暴露永不过时的 `aes128CbcEncrypt` / `aes128CbcDecrypt` 密码学原语。
  - [native/src/transport.rs](../native/src/transport.rs) 新增 `checked_public_https_url()`（强制 HTTPS 443 + `PublicDns` 防内网 SSRF，不锁死具体上游/CDN 域名，支持未来上游换域名免重发 Rust 宿主）。
  - [native/src/server.rs](../native/src/server.rs)、[native/src/media/mod.rs](../native/src/media/mod.rs)、[native/src/downloads.rs](../native/src/downloads.rs)：新增 `POST /upstream/fetch`（公网 HTTPS 代理原语）、`POST /play/cache`（本机解密缓存快查）、`POST /play/prefetch`（TSX 预取入队）；`POST /play`、`POST /downloads/start`、`POST /downloads/retry` 均支持直接接收 TSX 解析好的 `variants`，由 Rust 完成并发分片下载、CENC MP4 解密、LRU 缓存与 Range 播放。
- **TSX 可 OTA 视频解析层（`src/providers/source-resolver/`）**：
  - 完整迁入纯 TypeScript 解析模块（`types.ts`、`sm3.ts`、`device.ts`、`signature.ts`、`v5.ts`、`index.ts`），仅依赖 NSH 标准库（`buffer`/`crypto`/`zlib`）和 Rust 稳定原语（`NativeCrypto` + `/upstream/fetch`），并绕过 LLRT QuickJS 不支持 `Buffer.*BigUInt64*` 与数组 u8 溢出的运行时差异。
  - [src/features/player/session.ts](../src/features/player/session.ts)、[GlobalPlayer.tsx](../src/features/player/GlobalPlayer.tsx)、[DramaHomeView.tsx](../src/features/discover/DramaHomeView.tsx)、[DownloadsView.tsx](../src/features/downloads/DownloadsView.tsx) 全部接入 TSX 解析层，在线播放、下一集静默预取、离线下载与重试统一走 TSX 解析，后续上游改协议只需发 `.nshpkg` 热更新包。
- **OTA 热更新入口**：[src/features/settings/SettingsView.tsx](../src/features/settings/SettingsView.tsx) 接入 `nsh/updater`（`checkForPackage` / `downloadPackage` / `restartToPackage` / `runningPackage` / `shellInfo`），提供「解析包热更新（OTA）」检查与一键下载重启。
- **上游 `EMPTY_RESPONSE` 修复（纯 TSX，零 Rust 改动）**：
  - 根因：上游 2026-11-23 将 v5 Medusa 签名 `field 21` 从 `377` 改为 `312`，主播放接口切至 `POST https://reading.snssdk.com/novel/player/multi_video_model/preload/v1`（7.4.5.32 profile、`dr_scene: "preload"`、`device_level: 2`、`User-Agent: okhttp/4.12.0`）。
  - 修复：[src/providers/source-resolver/v5.ts](../src/providers/source-resolver/v5.ts) 更新 `field 21 = 312`；[src/providers/source-resolver/index.ts](../src/providers/source-resolver/index.ts) 新增 `preload/v1` 主路由并支持仅返回 ByteVC2 时自动经 `fallback_api`（`codec_type=1/3`）协商兼容编码。
  - 实测：固定样本《宴律》第 1 集（`7503780574541122622`）返回 HTTP 200（18,926 B，5 路清晰度）；当日热播榜前 3 部（《谁让这个文盲修仙的第七季》《穿越八零，我把娘俩宠成宝》《全球死考：刚下刑场你让我去考试一季》）首集 3/3 均拿到 `1080p bytevc1 (HEVC) + spade_a`。
- **OTA 签名发布工作流**：
  - 新增本地密钥初始化脚本 [tools/setup-ota-keys](../tools/setup-ota-keys)（默认生成到被忽略的 `.tmp/ota-keys/`，支持 `--apply` 自动将公钥写入 `nsh.json`），[.gitignore](../.gitignore) 新增 `keys/` 与 `*.secret` 防误提交。
  - 新增 GitHub Actions 工作流 [.github/workflows/ota.yml](../.github/workflows/ota.yml)（支持 `ota-*` 标签或手动触发，自动 `nsh publish` + `nsh update-manifest` 发布 `.nshpkg`、`latest.json` 与 `latest.json.sig`）。
  - 本地端到端 dry-run 验证：`nsh keygen` → `nsh certify` → `nsh publish`（985 KB `.nshpkg`，42 ms）→ `nsh verify` 全部通过。
- **验证**：`cargo test` **32/32** 通过；`./tools/nsh check`、`./tools/nsh build`（`283.7 KB js, 1.2 MB bytecode`）通过；`App.test.tsx` **13/13**、`session.test.tsx` **1/1**、`feed.test.tsx` **4/4**、`runtime.test.tsx` **2/2**、`resolver.test.tsx` **6/6** 全部通过。
- **下一步**：
  1. 运行 `./tools/setup-ota-keys --apply` 生成你自己的本地免费密钥对（离线妥善保管 `.tmp/ota-keys/root.secret`），按脚本提示执行 3 条 `gh secret set` 命令上传发布密钥。
  2. 提交并发布一版带 `updater` 公钥的基础客户端安装包后，今后修改 `src/providers/source-resolver/` 只需递增 `nsh.json` 的 `build` 并推送 `ota-<build>` 标签即可自动推送热更新包。

## 2026-11-23 Rust + TSX 本机迁移

- Rust 后端和 TSX 界面编译进同一个 NSH 应用。Rust 通过 `hg-drama/native` 向 TSX 提供回环连接，继续使用原生播放器、单 Range、旧版下载索引和 macOS 钥匙串会话。Node 参考实现保留用于协议对照测试。
- macOS arm64 已使用 NSH 0.6.1 和 Rust 1.97.0 本地构建。无 Node 的环境中启动应用，确认同进程监听回环端口；未授权请求返回 401。原生播放器通过 Rust 服务读取本地媒体，加载 211.8 秒样本并从 60 秒继续播放。独立候选包从 168.4 MiB 降至 45.5 MiB，ZIP 为 16.1 MiB。
- 31 项 Rust 离线测试及 14 项 TSX 测试通过，真实热播榜和搜索通过。固定播放样本及两部当日榜单剧在 Rust 和旧 Node 实现均复现上游 HTTP 200 空响应。扫码确认、短信登录和云端同步仍需真实账号验收。
- Windows 打包脚本和 GitHub 工作流已切到 Rust 构建，ZIP 脚本用替代构建产物验证过中文文件名和目录分隔符。下一步在 Windows runner 构建，再按 [平台验收要求](VALIDATION.md) 验证 Windows 启动与播放。

## 2026-11-23 v0.1.2 GitHub 双平台发布

- [Desktop packages](https://github.com/cl1107/hg-drama-nsh/actions/workflows/release.yml) 使用 NSH 0.6.1 和 Node.js 24.22.1 的官方发行档，校验 SHA-256 后在原生 runner 生成 macOS arm64、Windows x64 ZIP。推送与 `nsh.json` 版本一致的标签后，由 GitHub Actions 发布两份 ZIP 和校验文件。手动运行只生成构建产物。
- Windows 免安装包补齐 `danmaku.cjs`，按 NSH 输出目录精确定位 UI 可执行文件。ZIP 保留中文文件名，并从 v0.1.2 起统一使用标准的正斜杠目录分隔符。两个打包脚本均检查内置 Node.js 能加载随包发布的服务，并附带 NSH、Node.js 及项目许可证。
- 每次构建结果和发布状态以 Actions 和 [GitHub Releases](https://github.com/cl1107/hg-drama-nsh/releases) 为准。Windows 桌面启动和播放仍按 [平台验收要求](VALIDATION.md) 在实机确认。

## 2026-11-22 弹幕匀速防重叠修复 & 完整弹幕设置面板（构建号 10）

1. **弹幕匀速滚动与防重叠修复**（[DanmakuLayer.tsx](../src/features/player/DanmakuLayer.tsx)）：
   - **根因定位**：此前 `effect` 内调用 `syncBullets()` 追踪了 `positionSec`，导致每次 `onProgress` 触发都对所有活跃弹幕重新调用 `resumeAllBullets()` -> `x.timing(endX, { duration: 8500 })`，越靠近左边缘剩余距离越小而时长仍为 `8500ms`，造成指数级减速并在左侧堆叠成团；同时原逻辑中轨道长度纳入了速度计算使长弹幕追尾短弹幕，且缺少单行限制与严格轨道间距约束。
   - **修复方案**：改用普通数组管理活跃弹幕、`prevPaused` 仅在真实暂停/恢复状态跳变时触发 `pauseAllBullets()`/`resumeAllBullets()`，所有位移统一使用 `Easing.linear` 严格匀速直线运动；所有弹幕统一水平像素速度（消除长短弹幕追尾），配合暂停感知播放时钟 `nowPlayMs()`、单行文本清洗与 `numberOfLines: 1` 估算/实测宽度、`44px` 同轨安全间距及 `onLayout` 宽度校正，满轨时自动跳过不强行叠压。
2. **补齐完整弹幕设置抽屉 & 屏蔽词管理**（[user-data.ts](../src/stores/user-data.ts)、[GlobalPlayer.tsx](../src/features/player/GlobalPlayer.tsx)）：
   - 底部控制栏在「弹幕 开/关」右侧新增独立「弹幕设置」入口按钮（`testID="player-danmaku-settings-btn"`），打开专属「弹幕设置」抽屉（「播放设置」抽屉也保留直达入口）。
   - 完整实现并持久化：弹幕开关、不透明度滑杆（`20%–100%`）、字号滑杆（`12–36px`）、字号随画面大小缩放（实时展示当前生效字号）、粗细（细 / 常规 / 粗 / 特粗）、颜色（原 / 白 / 黄 / 青 / 绿 / 粉 / 橙 / 彩）、显示行数（`2–16 行` 步进与快捷档）、滚动速度（慢 / 正常 / 快）、全屏时显示弹幕、合并重复弹幕（15 秒同轨合并并展示 `×N` 计数）以及独立「屏蔽词管理」子视图（增删清空并在屏幕上即时过滤）。
3. **验证与打包**：
   - `./tools/nsh check`、`./tools/nsh build`、`App.test.tsx` **13/13**（含重复弹幕合并 `×2`、全量弹幕设置交互与屏蔽词实时过滤回归测试）、`session.test.tsx` **1/1** 与 Node 服务端/协议测试 **53/53** 全部通过。
   - 构建号 10（[nsh.json](../nsh.json)）已通过 `./tools/package-macos` 打包并替换 `/Applications/红果短剧-NSH.app`，`codesign --verify --deep --strict` 校验通过。

## 2026-11-22 切集速度优化（并发探测 / 分片并发下载 / 详情与媒体缓存 / 下一集预取）& 构建号 9 打包

1. **瓶颈定位**：实测原有每集准备耗时达 35–51 秒，核心瓶颈在红果 VOD CDN 单连接下载限速（~300–400 KB/s，21.38 MB 耗时 51.2 秒），叠加每集重抓官网详情（~934 ms）、串行探测已空响应的 `v5` 与 1 秒节流、以及缺少已解密缓存与下一集预取。
2. **优化实施**：
   - **取源并发探测**（[service/vendor/hongguo/app-source.js](../service/vendor/hongguo/app-source.js)）：`playbackReadyAt` 全局节流降至 `150ms`；新增 `raceRoutes()` 并发竞速主/备模式（记住 `preferredPlayMode`，默认优先 `tab`），首个有效响应立即胜出并中止其余请求，全空后再轮询备用节点与重注册兜底。
   - **详情缓存 & CDN 竞速 + 1MB×6 路分片并发下载**（[service/playback.cjs](../service/playback.cjs)）：`details()` 新增 10 分钟/32 部剧 LRU 缓存与并发去重；`downloadFromVariants()` 先对同编码层多 CDN 节点并发发起首 MB `Range` 探测，胜出节点直接以 6 路并发拉取剩余 1MB 分片并在内存精确拼接（失败自动回退单连接全量下载），再交 CENC 解密。
   - **已解密媒体 LRU 缓存、静默预取下一集与抢占**（[service/server.cjs](../service/server.cjs)）：`files` + `episodeCache` 支持最多 4 集缓存复用；当前集返回后延迟 `150ms` 后台静默预取下一集（切集恰逢预取进行中直接复用）；新 `/play` 请求到来主动中止旧请求抢占执行（中止时若连接未关回写 `499`），消除 `409 BUSY`。
3. **验证与实测对比**：
   - 真实在线实测（《宴律，你的白月光回国了》）：冷启动第 1 集（21.38 MB）由 ~52.6 秒降至 **5,106 ms**；第 2 集（10.10 MB）直拉由 ~35.9 秒降至 **770 ms**；经 `/play` 命中预取缓存切第 2 集耗时 **7 ms**。
   - Node 服务端与协议测试 **53/53** 通过（含 `downloadFromVariants` 竞速/分片拼接、`server.cjs` 缓存/预取/抢占单测）；`./tools/nsh check`、`./tools/nsh build`、`App.test.tsx` **13/13**、`session.test.tsx` **1/1** 全部通过。
   - 构建号 9（[nsh.json](../nsh.json)）已通过 `./tools/package-macos` 重新打包并替换安装至 `/Applications/红果短剧-NSH.app`，`codesign --verify --deep --strict` 校验通过，已确认内置 `service/danmaku.cjs`。

## 2026-11-22 播放器弹幕功能 & 上一集/下一集切换

1. **后端真实在线弹幕接口**（[service/vendor/hongguo/app-source.js](../service/vendor/hongguo/app-source.js)、[service/danmaku.cjs](../service/danmaku.cjs)、[service/server.cjs](../service/server.cjs)、[tools/package-macos](../tools/package-macos)）：
   - 对照 `/Users/cl/Downloads/短剧播放器.app` 核实红果弹幕接口 `POST /novel/commentapi/comment/list/{episodeId}/v1/`（`comment-source=601`、`server-channel=1000`、`group_type=30`、`comment_type=20`、`business_param.book_id/start_offset_time/playlet_item_duration/need_danmaku_guide_type=[48]`），在 `signedMetadataRequest()` 放行该路径正则。
   - 新增 `service/danmaku.cjs` 导出 `fetchDanmaku` 与 `parseDanmakuResponse`，完成入参校验、响应 `data_list` 解析去重与按 `offset_time` 排序，并依据 `extra.next_query_danmaku_list_time` / `common_list_info.cursor.end_offset_time` 计算分段下一页游标 `nextMs` 及总弹幕数 `total`。
   - `service/server.cjs` 注册 `POST /danmaku` 路由（受 Bearer 鉴权与 ID 校验保护），`tools/package-macos` 同步加入 `danmaku.cjs`。
2. **弹幕渲染层与偏好持久化**（[DanmakuLayer.tsx](../src/features/player/DanmakuLayer.tsx)、[user-data.ts](../src/stores/user-data.ts)、[SettingsView.tsx](../src/features/settings/SettingsView.tsx)）：
   - 新增 `DanmakuLayer`，按播放进度分段拉取与提前 10 秒预取下一窗口，使用 NSH 原生 `AnimatedValue.timing()` 线性驱动弹幕滚动；支持多轨道防重叠分配、同屏上限控制、暂停定格/恢复续播、seek/切集清屏重同步以及失败 8 秒冷却静默降级；容器 `pointerEvents: "none"` 不拦截视频点击手势。
   - `user-data.ts` 新增并持久化 `danmakuEnabled`、`danmakuOpacity`、`danmakuFontSize`、`danmakuArea`（顶部/半屏/全屏）、`danmakuSpeed`（慢/正常/快）；`SettingsView.tsx` 增加「默认开启弹幕」设置项。
3. **播放器上一集/下一集切换 & 弹幕控制**（[GlobalPlayer.tsx](../src/features/player/GlobalPlayer.tsx)、[icons.tsx](../src/ui/icons.tsx)、`src/assets/icons/skip-prev.svg`、`skip-next.svg`）：
   - 底部控制栏左侧新增「上一集」「下一集」图标按钮（首/尾集自动禁用，快捷键 `P` / `N`），`onEnd` 自动连播同步复用 `nextEpisode()`。
   - 底部控制栏右侧新增「弹幕 开/关」快捷切换按钮（快捷键 `D`），「播放设置」抽屉补充完整弹幕开关、透明度、字号、显示区域与滚动速度调节（支持滚动）。
4. **验证**：
   - 在线实测 `fetchDanmaku({ seriesId: '7503745441910017049', episodeId: '7503780574541122622', startMs: 0, durationMs: 120000 })` 返回 23 条真实弹幕（总计 908 条，`nextMs: 30000`）。
   - Node 服务与协议套件 `51/51` 通过（含 `parseDanmakuResponse` 与 `POST /danmaku` 路由单测）。
   - `./tools/nsh check`、`./tools/nsh build`、`App.test.tsx` `13/13`（含上一集/下一集边界切换、弹幕拉取渲染/显隐开关/设置调节回归测试）、`session.test.tsx` `1/1` 全部通过。如需同步到 `/Applications/红果短剧-NSH.app`，运行 `./tools/package-macos` 重打包。

## 2026-11-22 选集面板自动居中定位、正/倒序切换与到头/到底快捷滚动

1. **选集面板体验增强**（[GlobalPlayer.tsx](../src/features/player/GlobalPlayer.tsx)）：
   - **自动滚动到当前集居中**：打开选集面板时，待 `List` 视口完成布局（`onLayout` 高度 > 0），通过 `ListRef.scrollToIndex({ index, viewPosition: 0.5, animated: false })` 自动将当前播放集定位到视口中央；顶部标题旁新增可点击的 `第X集` 胶囊（`testID="episodes-locate-current"`），任意滚动后可一键平滑回到当前集居中。
   - **正序 / 倒序切换**：新增 `episodeOrder` 状态及工具栏分段按钮 `正序` / `倒序`（`testID="episodes-order-asc"` / `episodes-order-desc"`），切换排序后自动重新居中到当前播放集。
   - **到头 / 到底快捷切换**：工具栏右侧新增 `到头`（`scrollToIndex({ index: 0, viewPosition: 0, animated: true })`）与 `到底`（`scrollToEnd({ animated: true })`）按钮，在正序与倒序下均按当前列表首尾快速跳转。
   - **播放页标题后显示当前集数**：短剧播放页与全屏顶部标题后补充 `第X集`（`testID="player-header-episode"`），左下角 `@剧名` 标题后补充 `第X集` 标签（`testID="player-title-episode"`），标题均支持截断收缩不挤压集数。
2. **验证**：实测 NSH `List`（`numColumns={3}`）下 `scrollToIndex({ index: 74, viewPosition: 0.5 })`、`scrollToIndex({ index: 0, viewPosition: 0 })` 与 `scrollToEnd()` 的 `measureScrollPosition()` 偏移精确符合预期；新增 `episodes sheet auto-centers current episode, toggles order, and jumps to start or end` 回归测试（[App.test.tsx](../App.test.tsx)），`./tools/nsh check`、`./tools/nsh build`、`App.test.tsx` 11/11、`session.test.tsx` 1/1 全部通过。如需同步到 `/Applications/红果短剧-NSH.app`，运行 `./tools/package-macos` 重打包。

## 2026-11-21 视频播放页点击画面暂停/继续播放

1. **点击视频画面切换暂停/播放**（[GlobalPlayer.tsx](../src/features/player/GlobalPlayer.tsx)）：
   - 在 `<Video>` 之上、所有交互覆盖层（顶部栏、右侧操作栏、左下简介、底部控制栏、选集/设置抽屉）之下新增铺满画面的透明点击层（`testID="video-surface-tap"`，`focusable={false}`），点击视频空白画面即触发 `revealFullscreenControls()` 与 `togglePlay()`；推荐页、短剧播放页及全屏态统一生效，点击按钮/控制栏/抽屉不误触。
   - `togglePlay()` 补充 `!playbackError()` 保护，避免播放错误态误切换暂停。
   - 暂停状态新增居中半透明播放图标指示（`testID="video-paused-indicator"`，`pointerEvents: "none"`），便于鼠标移出或全屏隐藏控制栏时明确辨识暂停态。
2. **验证**：新增 `clicking the video surface toggles pause and resume with visual indicator` 回归测试（[App.test.tsx](../App.test.tsx)），`./tools/nsh check`、`./tools/nsh build`、`App.test.tsx` 10/10、`session.test.tsx` 1/1 全部通过。如需同步到 `/Applications/红果短剧-NSH.app`，运行 `./tools/package-macos` 重打包。

## 2026-11-21 接入 `video_tab` 兜底修复 `EMPTY_RESPONSE`

1. **问题定位**：上游 `multi_video_model/player/v1` 与旧 `v1/` 在当前全量节点均返回 HTTP 200 空包（`content-length: 0`）。
2. **修复**：参考 `jackotom/hongguo-drama` 最新实现，[playback-v5.js](../service/vendor/hongguo/playback-v5.js) 新增 `allowEmptyBody` 支持 GET 空请求体签名；[app-source.js](../service/vendor/hongguo/app-source.js) 新增 `videoTabRequest()` 接入 `GET /reading/bookapi/video_tab/multi_video_model/v1/`，在 `player/v1` 主/备节点返回 `EMPTY_RESPONSE` 时自动切换 `video_tab`。
3. **验证**：Node 42/42、`./tools/nsh check`、`App.test.tsx` 9/9、`session.test.tsx` 1/1 及 11 部在线剧集（含《宴律，你的白月光回国了》与热播榜前 10 部）`prepare()` 解密全部通过（`hevc 1080p`）。

## 2026-11-21 全屏播放无操作自动隐藏 UI

1. **全屏空闲自动隐藏控制栏**（[GlobalPlayer.tsx](../src/features/player/GlobalPlayer.tsx)）：
   - 全屏播放状态下无操作 3 秒（`FULLSCREEN_IDLE_HIDE_MS = 3000`）后自动隐藏覆盖层 UI（顶部返回/标题、右侧操作栏、底部简介与播放控制栏）并将光标设为 `cursor: "none"`。
   - 鼠标移动（`onMouseMove`）、点击、滚轮或播放快捷键操作后立即恢复 UI 显示并重置 3 秒计时；增加 150ms 同坐标防抖，避免 UI 卸载触发的同坐标重排事件把控制栏误弹回。
   - 打开选集/设置抽屉面板时暂停自动隐藏，关闭面板或退出全屏时自动恢复/清理计时器；非全屏保持原 hover 显隐行为。
2. **验证**：新增 `fullscreen player auto-hides overlay UI when idle and restores it on mouse move` 回归用例（[App.test.tsx](../App.test.tsx)），`./tools/nsh check`、`./tools/nsh build`、`App.test.tsx` 9/9、`session.test.tsx` 1/1 全部通过。如需同步到 `/Applications/红果短剧-NSH.app`，运行 `./tools/package-macos` 重打包。

## 2026-11-21 排行榜全量榜单 / 播放稳定性修复 / 播放排查 Skill / README 更新

1. **排行榜多榜单补全**（[service/discover.cjs](../service/discover.cjs)、[service/server.cjs](../service/server.cjs)、[discover-store.ts](../src/features/discover/discover-store.ts)、[DiscoverView.tsx](../src/features/discover/DiscoverView.tsx)）：
   - 核实 `bookmall/cell/change/v` 返回的 `cell_selector` 真实树结构，新增 `parseRankSelectors()` 解析顶部 5 大分类（全部 / 系列剧 / 漫剧 / 真人剧 / AI剧）及其全部子榜单（全部下 9 榜：推荐榜、热播榜、臻果榜、预约榜、新剧榜、热搜榜、追更榜、必看榜、收藏榜；系列剧 2 榜；漫剧 5 榜；真人剧 7 榜；AI剧 7 榜），同时兼容旧 `rankType` 参数。
   - 实测 `ranklist_hot_sc`、`ranklist_prestige`、`ranklist_hot_search_sc`、`series_album_new_rank` 均正常返回 10 条真实剧目与 5 组 selectors。
2. **播放取源稳定性修复**（[service/vendor/hongguo/app-source.js](../service/vendor/hongguo/app-source.js)、[service/playback.cjs](../service/playback.cjs)）：
   - 改为优先复用进程内已注册匿名设备 `getPlaybackDevice()`（避免每次取源重注册导致新设备同步延迟或空响应），扩大官方主机池 `PLAYER_HOSTS` 至 5 个节点（`sinfonlineb` / `sinfonlinea` / `sinfonlinec` / `api5-normal` / `api3-normal`），遇 `EMPTY_RESPONSE` 时依次轮询，全部空响应后再换设备重注册并兜底旧接口 `VIDEO_API`。
   - `prepare()` 下载媒体时若主 `variant` 失败（非取消），自动顺延尝试同清晰度其余 `variant`。
   - 实测热播榜前 10 部剧第 1 集（10/10）与《宴律，你的白月光回国了》第 1、2 集（2/2）共 12 集全部取源、解密通过。
   - 构建号 8（[nsh.json](../nsh.json)）已打包并替换安装到 `/Applications/红果短剧-NSH.app`，严格签名校验通过。
3. **沉淀播放排查 Skill & 更新 README**：
   - 新增项目 Skill：[.agents/skills/hg-playback-debug/SKILL.md](../.agents/skills/hg-playback-debug/SKILL.md)。
   - 参考 `yangbin1322/hongguo-player` 风格重写 [README.md](../README.md)，仅描述本仓库已真实实现的功能与命令。

## 2026-11-21 找剧搜索结果返回保持 & 标题 hover 气泡全称

1. **搜索结果页进入主页/播放后返回保持结果页**（[DiscoverView.tsx](../src/features/discover/DiscoverView.tsx)）：此前 `searchMode` 为组件局部 signal，离开「找剧」卸载后重建重置为筛选页。现将 `discover` 模式的搜索态持久化到 [discover-store.ts](../src/features/discover/discover-store.ts) `discoverSearchMode`；进入剧集主页或播放器再返回仍停留在搜索结果页，点「返回筛选」或清空搜索框才切回筛选页（并按需补载分类）。
2. **找剧/列表标题 hover 展示全称**（[controls.tsx](../src/ui/controls.tsx)）：NSH `tooltip` 需传入 `<Tooltip>` 元素而非裸字符串（裸字符串无气泡样式）。新增 `textTooltip()` 使用 `nsh/base` `Tooltip`（`delay={300}`、`maxWidth: 320`、卡片背景与边框）包裹 `PosterCard` 与 `DramaListRow` 标题。
3. **验证**：新增 `discover search results persist when returning from drama home` 回归测试，App 8/8、session 1/1、`./tools/nsh check`、`./tools/nsh build` 通过。

## 2026-11-21 侧栏层级缩进（展开态）

用户复核展开态侧栏：分组标签「发现/我的」（px-2）比收起按钮图标（px-3）更靠左、子项又与收起按钮同轴。调整（[controls.tsx](../src/ui/controls.tsx) `SidebarItem` + [App.tsx](../App.tsx)）：
- 「发现/我的」标签 `pl-3`：与收起按钮图标同轴（12px）。
- 子项展开态 `pl-5 pr-3`（图标 20px、选中胶囊随之右缩），收起态维持 `px-3` 整列同轴不变。
- 主题/用户/设置随 SidebarItem 一致缩进。App 7/7、detector 无发现；构建号 7 已替换 `/Applications/红果短剧-NSH.app`。
- 注意区分：`./tools/dev` 开发实例窗口与安装版同名同图标，用户可能看混；dev 窗口热重载当前源码。

## 2026-11-21 侧栏图标列垂直对齐

收起态侧栏三处图标中线不一致（导航项 21px / 收起按钮 26px / 主题按钮 18px）。新增 [controls.tsx](../src/ui/controls.tsx) `SidebarIconButton`，与 `SidebarItem` 同参构造（`px-3 h-10`、18px 图标、`self-start`），收起/展开切换与主题切换均改用——整列图标中线统一为 21px，由构造保证不再漂移。App 7/7 通过，detector 无发现；构建号 6 已替换 `/Applications/红果短剧-NSH.app`。

## 2026-11-21 筛选面板挤压结果区修复

根因：NSH flexbox 默认不收缩（"nothing shrinks unless flexShrink says so"），找剧页筛选面板 `Scroll` 固定 `maxHeight: 460` 且 flexShrink 0，窗口变小或筛选内容多时把结果网格整个挤出窗口（且不可滚动）。修复（[DiscoverView.tsx](../src/features/discover/DiscoverView.tsx)）：
- 筛选面板高度自适应视口：`maxHeight = min(460, 视口高×45%)`（保底 120），并设 `flexShrink: 1`——空间不足时面板压缩、内部滚动，结果区始终保有一席之地。
- 结果容器补 `minHeight: 0, flexShrink: 1`。
- 无头测试的 `shows` 不考虑裁剪，无法自动断言此视觉 bug（已实验验证）；保留小窗口冒烟用例（App 7/7、服务 38/38、session 1/1、探针 2/2 通过）。构建号 5 已替换 `/Applications/红果短剧-NSH.app`（替换前优雅退出了正在运行的旧实例），实机验收：缩小窗口后筛选面板内部可滚、结果网格始终可见。

## 2026-11-21 UI 融合改版（无标题栏/海报悬浮/剧集主页/排行榜重排）

1. **去除系统标题栏**：[nsh.json](../nsh.json) 增加 `"window": { "titleBar": { "style": "hidden" } }`；[App.tsx](../App.tsx) 侧栏顶部 36px 与内容区顶部 24px 设 `desktop={{ windowDrag: true }}` 拖拽区（避开 macOS 红绿灯），内容延伸至窗口顶。
2. **侧栏收起/展开改图标**：`sidebar-toggle` IconButton（收起 ‹ / 展开 ›），收起后各项靠 `tooltip` 显示全称；主题切换按钮收起态也保留。
3. **海报悬浮双按钮**（[controls.tsx](../src/ui/controls.tsx) `PosterCard`）：hover 显示「播放」（主色胶囊）与「主页」（白胶囊）；封面底部 scrim 左侧标签、右侧评分/角标；标题与列表行 `tooltip` 展示全称，榜单前三名名次红色高亮。
4. **新增剧集主页**（[DramaHomeView.tsx](../src/features/discover/DramaHomeView.tsx)，页面键「剧集主页」）：返回、大封面、集数徽章+标签、简介、播放第1集/点赞/收藏/追更/下载、主演头像（官网 `celebrities`）、备案号（官网 `record_number`）、选集 flex-wrap 网格（>60 集折叠为「显示全部」，打开新剧自动重置）。[service/playback.cjs](../service/playback.cjs) `details()` 补 `episodeText`/`recordNumber`/`celebrities`（均来自官网页面真实字段，实测无播放/收藏数故未展示）。找剧/排行榜「详情」均跳转主页，原内联详情面板已移除。
5. **找剧搜索态头部**：`搜索 "关键词"` + 返回筛选 + 热门搜词胶囊（`HOT_SEARCHES`，全部为 App 分类接口真实枚举词，点击即搜）。
6. **排行榜重排**：左侧 160px 榜单分类列表（全部/真人剧/漫剧/AI剧，仅 API 支持的热播榜），顶部旧 tab 移除；右侧行样式加封面/名次/评分/详情。
7. **间距规范**：页面 p-6/gap-4、区块 gap-3、胶囊 px-3 py-1、行 py-3；测试更新为 6 项（新增排行榜→剧集主页回归），App 6/6、服务 38/38、session 1/1、探针 2/2 通过；构建号 4 已替换 `/Applications/红果短剧-NSH.app`（严格签名校验通过）。

待实机验收：无标题栏后拖拽/红绿灯位置、悬浮双按钮、主页各区块与长剧（800+ 集）选集折叠、排行榜左列切换。

## 2026-11-21 Enter 搜索 / 防息屏 / NSH 0.6.1 重打包

1. **搜索按 Enter 无反应已修复**（[src/ui/controls.tsx](../src/ui/controls.tsx)）：NSH `Input` 原生支持 `onSubmit`/`submitBehavior`，此前 `SearchField` 未接线。现已传入 `onSubmit`、`submitBehavior="submit"`（回车提交且保持焦点）与 `returnKeyType="search"`；找剧页和历史页搜索框同时受益。

2. **播放期间不再息屏**：NSH 无防休眠 API，走系统层。新增 [service/keep-awake.cjs](../service/keep-awake.cjs)：`POST /keep-awake {active}` 在服务端起停 `caffeinate -d -i -s -w <服务pid>`（防显示休眠+空闲休眠+AC 下系统休眠；`-w` 绑定服务进程，服务被强杀断言自动消失；非 macOS 静默降级）。TSX 侧 [GlobalPlayer.tsx](../src/features/player/GlobalPlayer.tsx) 用 `effect` 监听「已就绪且未暂停且无错误」，变化即上报，cleanup 固定释放。`tools/package-macos` 已把 `keep-awake.cjs` 加入打包列表；server 测试注入 mock 断言，不真起 caffeinate。

3. **NSH 升级 0.6.1 (2f51d86)** 并重打包：官方 macOS arm64 发行档 SHA-256 `ee1aed2a4d111fe90e6cceca4b9d5f834c9e11cfda525f8be984261a329c06de` 校验一致；`./tools/nsh check`、`./tools/nsh build`、`App.test.tsx` 5/5、Node 服务套件 38/38 通过。构建号 3 已替换到 `/Applications/红果短剧-NSH.app`，严格签名校验通过。注意：App 离线测试依赖 `.tmp/service-config.ts` 存在真实 baseUrl/token（测试网络按其 mock，本环境已写入测试值，dev 启动会自动覆盖）。

待实机验收：找剧页输入关键词回车出结果；播放中静置超过系统息屏时限屏幕不灭、暂停后正常息屏。下一步维持「取源稳定性」（`EMPTY_RESPONSE` 为上游对特定分集的空响应行为）。

## 2026-11-19 播放器全屏白屏/空白修复

修复历史播放等页面进入「短剧播放」后点击全屏导致主区域变空的问题：
- **根因**：[src/features/player/GlobalPlayer.tsx](src/features/player/GlobalPlayer.tsx) 原本通过 `<If when={!fullscreen()}><Surface /></If>` 卸载主窗口内的播放器，再挂载 `<Window id="video-fullscreen" defaultMode="fullScreen">` 打开新窗口；而 [tools/package-macos](tools/package-macos) 声明的 `capabilities` 未授予 `windows` 权限，导致新窗口无法打开、主窗口播放器被卸载为空白；同时切换全屏时销毁重建 `<Video>` 也会造成播放中断。
- **修复**：改为在当前主窗口内原地全屏（通过 `currentWindow().setMode("fullScreen")` 切换主窗口全屏并监听 `modeChange` 同步退出），[App.tsx](App.tsx) 响应 `isVideoFullscreen()` 隐藏侧边栏与页头并移除内容区内边距，不再新建第二窗口也不卸载重建 `<Video>`；补充 `onMouseMove` 保持全屏下鼠标移动可唤出控制栏。
- **验证**：`./tools/nsh check`、`./tools/nsh build`、`./tools/nsh test App.test.tsx`（5/5，含新增历史播放原地全屏与退出回归用例）、`./tools/nsh test src/features/player/session.test.tsx`（1/1）全部通过。
- **下一步**：如需更新 `/Applications/红果短剧-NSH.app`，运行 `./tools/package-macos` 重新打包并替换安装。

## 2026-11-18 NSH 0.6.0 重打包

项目工具更新为 [NSH 0.6.0 (5541637)](https://github.com/longbridge/nsh/releases/tag/v0.6.0)。官方 macOS arm64 发行档 SHA-256 为 `b2a8370c8b44ca6059d2d8665b48b08472a4fee3956813b99223f4e3ce5491d9`，与 GitHub 发行资产摘要和独立校验文件一致。打包配置补充 0.6.0 要求的 `application` 权限。

check/build 和 11 项 NSH 测试通过。打包器使用发行档内的预构建完整 runner。构建号 2 已替换到 `/Applications/红果短剧-NSH.app`，通过严格签名校验，并确认从已安装的窗口播放真实推荐视频。

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
