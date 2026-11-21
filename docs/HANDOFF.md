# 开发交接

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
