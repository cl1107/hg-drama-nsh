# 红果项目比较（2026-11-15）

结论：为长桥 NSH 重构，优先选择 **jackotom/hongguo-drama 作为协议与业务参考**，新建清晰的 NSH 工程。它有可审查源码、实际解密链路和回归测试，但不适合直接换壳。**无法判断它的内部代码质量高于 hongguo-player**：后者公开仓库没有应用源码；只能确定前者的可审计性、可复用性明显更高。

## 核验范围

在本项目 `.tmp/hongguo-review/player`、`drama` 独立浅克隆；未修改、推送原仓库，未运行发行二进制、登录、提取用户秘密或请求受保护内容。两个仓库默认分支均为 `main`，经远端 HEAD 与 GitHub 当前仓库页交叉确认。

| 项目 | cl1107/hongguo-player | jackotom/hongguo-drama |
|---|---|---|
| 本次固定提交 | `a4688b02e57c11c159b15d4ce369f53f98299b2d` | `782fb21cbddf1be46f88e97af5e788c99e30beae` |
| 提交时间（+08:00） | 2026-11-05 00:57:47 | 2026-11-15 05:13:53 |
| 公开内容 | README、截图、Issue 模板 | Electron + React；Node 原生服务、NAS 服务、Android 与测试 |
| 来源 | GitHub 标记 fork 自 yangbin1322/hongguo-player | NOTICE 声明修改自 327044572/hongguo-downloader |
| 可审计质量 | 无法评价内部实现、测试、构建或安全 | 分层已有基础，主流程耦合重，类型契约不统一 |
| 片源/解密证据 | 只有作者陈述，源码未知 | 红果主链路直接访问官方站点/API，包含本地内容解密 |
| 许可与复用 | 当前树无应用源码及可复用源码许可证 | GPL-3.0；另有第三方许可与来源记录 |
| NSH 价值 | 仅供交互参考，不能复用源码 | 可移植协议、领域规则、测试向量；重写 UI 与宿主层 |

[两个仓库关系之一：GitHub fork 标记](https://github.com/cl1107/hongguo-player)；[另一个仓库的上游声明](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/NOTICE#L7)。没有证据表明这两个项目彼此 fork 或共用实现；公开代码缺失使同源性无法完整比较。`hongguo-player` [明确写明只发布安装包、不含源码](https://github.com/cl1107/hongguo-player/blob/a4688b02e57c11c159b15d4ce369f53f98299b2d/README.md#L185)；其 README 中关于设备注册、加密下载等描述仅属产品说明，不能据此证实官方 API 或解密算法。

GitHub API 本次返回 HTTP 403 rate limit exceeded，未取到 API 元数据；改用实时 GitHub 官方页面和实际 git 克隆核验。日期来自提交对象的 committer timestamp，不把它当成发行时间。

## 片源与解密：分别判断

**已证实（代码实现）：** `hongguo-drama` 的红果默认链路访问 `hongguoduanju.com` 官网网页，App 回退访问 `api5-normal-sinfonline[a/b].fqnovel.com`，设备注册访问 `log5-applog-lf.fqnovel.com`，回退接口限制 `fqnovel.com` / `snssdk.com`。不是必须依赖作者运营的第三方解析后端才能获得红果 URL。App 返回媒体 URL 限定 `qznovelvod.com`、`fqnovelvod.com`、`douyinvod.com`（[白名单](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/app-source.js#L569)）；旧网页/模型路径使用公共媒体 URL 校验。已证实存在面向官方 CDN 域名的直连代码，未抓取本次真实播放响应，不保证每条网页 URL 均为官方 CDN。

- 搜索：UI 经 preload IPC 到 main 的搜索调度，再到 App 搜索/网页路径。[IPC 搜索入口](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/preload.js#L72)、[App 搜索调度](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/main.js#L1775)、[搜索响应解析与错误码](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/hongguo-app-search.js#L35)。
- 详情与分集：竞速读取官网 `/player/<id>` 与 `/detail?series_id=...` 的内嵌数据；失败后请求 `/novel/player/multi_video_detail/preload/v1`。回退会核对请求剧集 ID，但不是所有字段都强校验。[详情与分集完整路径](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/hongguo.js#L491)。
- 播放：优先官网直链，再 App `multi_video_model`，最后旧 preload 接口；App 有 video_tab 与 fallback 分支。[播放来源回退](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/hongguo.js#L745)、[API 常量](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/app-source.js#L23)、[App 模型取源](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/app-source.js#L430)。
- 签名与设备：仓库自带签名代码并注册匿名设备，不只是远程索要签名。[签名实现](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/playback-signature.js#L1)、[设备注册](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/playback-device.js#L11)。注册请求的 AES-CBC/ttEncrypt 是请求封装，不能单独当作视频解密证据。
- URL 与密钥：App 从响应 `spade_a` 派生内容密钥；对于加密 URL 使用 `key_seed` 派生 AES-CBC 参数再解密。[密钥派生和 URL 解密](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/app-source.js#L282)、[组装 contentKey/codec/URL 结果](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/app-source.js#L556)。
- **视频内容解密真实存在**：老路径从 `spadeA` 派生 key，解析 MP4 box、CENC 样本并进行 CTR 解密；新路径把 `contentKey` 交给 FFmpeg `-decryption_key`，输出经后续媒体处理播放或下载。[CENC-AES-CTR 样本解密](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/hongguo.js#L887)、[MP4 重建与解密](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/hongguo.js#L1066)、[下载调用解密](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/main.js#L1194)、[FFmpeg 内容解密](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/main.js#L3320)。worker 避免解密阻塞主线程，但依然整块处理部分媒体。

因此，若“官方解密”指“实现对红果 API 所返回加密媒体的本地解密”，**drama 有明确代码证据**；若指“红果官方提供、授权或认证的 SDK/解密服务”，**没有证据**。不能扩大为支持任意 DRM、所有付费内容或所有未来格式。本次未在线复验真实加密视频，结论是实现存在，不承诺今天所有剧均可播。

**未知：** player 二进制真实访问主机、算法、密钥获取过程；其他来源与用户配置的解析服务内部行为。drama 的 `hema` 使用 `www.kuaikaw.cn`，`xifan` 使用 `xifan-api-cn.youlishipin.com`，还有 ReelShort、DramaBox、自定义源；这些不应统称红果官方来源。[多来源分发](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/hongguo.js#L472)。自定义源即便给出明文 URL，也不能证明本客户端或服务端执行过视频解密。

**版权边界：** 代码能证明访问哪里与怎样处理字节，不能证明每部内容的版权归属、传播授权。官网/API/CDN来源不等于下载或再分发许可。Base64 还原 URL、请求签名、解码 HEVC/ByteVC2，也分别不等于视频 DRM 解密。

## 实现质量与代表性问题

优点：`src/native` 已拆出设备、签名、媒体地址防护、取消、账号、下载临时文件等模块；有超时与取消传播、请求 host 限制、IPC 主 frame/来源校验、文件身份防误删、安全存储失败不落明文等实际防护。[API URL 限制](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/app-source.js#L320)、[IPC 信任边界](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/renderer-security.js#L1)、[账号安全存储](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/account-session.js#L166)。可作为重构时保留的行为约束。

主要问题与边界：

1. **业务与宿主耦合重。** main.js 同时承担 IPC、搜索编排、媒体缓存、解密/转码、下载和窗口生命周期；Player.jsx 集中播放状态和 DOM/浏览器处理。约 6055/2429 行只是定位信号，判断依据是上述职责同时混合，重构应抽出 SourceProvider、PlaybackSession、DownloadJob，而非逐行翻译。[主进程媒体流程](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/main.js#L3378)、[播放器](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/components/Player.jsx#L1)。
2. **返回契约不一致。** 老路径传 `spadeA`，App 路径传 `contentKey`，调用方还按 `codec` 分支；模型有字符串与对象兼容路径，缺统一判别类型。分集 fallback 使用 `String(item.vid)` 与 `item.vid_index || 0`，缺字段可能变成字符串 `undefined` 或索引 0，未在入口拒绝。[分集字段转换](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/hongguo.js#L573)。这是异常响应下的确定性代码行为，不断言上游正常响应目前缺这些字段。
3. **有可复现的异常行处理缺陷。** `parseModelVideo` 遍历 `video_list` 时未检查元素，`{"video_list":{"video_1":null}}` 会在读取 `v.main_url` 时抛 TypeError；同函数对非法 JSON 却返回 null 三元组，错误语义不一致。已用隔离 VM 提取原函数复现。影响是旧接口异常响应丢失结构化原因，不能据此宣称正常剧集必然失败。[未检查模型行](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/hongguo.js#L641)。App 新解析器有过滤，反映两套解析器约束不统一。
4. **部分解密仍有整文件内存开销。** `decryptMp4File` 同步读入完整媒体，workerData 还可能复制 buffer；worker 能缓解 UI 阻塞，不能消除内存峰值。NSH 应保留取消边界并改流式/分段处理。[整文件解密](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/hongguo.js#L1196)、[worker 数据传输](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/decrypt-worker.cjs#L1)。
5. **安全/供应链有基础但不能背书无风险。** 有 lockfile、部分固定版本；软件播放器资产固定 commit 并校验 SHA256。FFmpeg/librempeg、Wasm、自动更新与 CI 仍是独立供应链；GitHub Actions 使用版本 tag 而非不可变 SHA。未做全依赖漏洞审计，不把固定版本当成已安全。[Wasm 下载与摘要](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/scripts/setup-software-player.cjs#L21)、[依赖及构建钩子](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/package.json#L1)、[CI](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/.github/workflows/test.yml#L1)。

## 验证、维护与 NSH 边界

本次未安装 npm/Electron 依赖或下载解码工具；执行原仓库 5 个现有测试文件（playback-signature、playback-device、hongguo-app-search、proxy-secret、media-sources），**39/39 通过**，日志 `drama/review-tests.log`。另运行上述异常模型最小复现。未执行全量测试、build、GUI 或真实联网播放。仓库包含完整测试入口与 CI；7.3 文档声明全量测试、React build 通过，属于作者记录，未当作本次独立验证。[测试调度](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/scripts/test.cjs#L1)、[7.3 验收及限制](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/docs/release-7.3.md#L15)。较新提交说明仍在维护，不等于稳定性保证。

[NSH 官方文档](https://nsh.dev/docs/) 说明原生视图、Rust 与 TSX 及信号模型。基于代码依赖可推断：React hooks、HTML video、DOM/CSS、Electron BrowserWindow/preload/IPC、Node crypto/fs/worker 与 WebGPU/Wasm 播放器不能直接搬进 NSH TSX。

可复用边界：保留取源顺序、分页/游标、ID 精度保护、质量选择、错误分类、取消/重试策略、协议测试向量；把网络、签名、密钥、下载、缓存和媒体进程管理封装成 Rust 核心或明确的独立服务接口。重新实现 UI、账号存储、窗口/快捷键、更新、安全边界与播放器后端。先验证目标 OS 的 HEVC/ByteVC2、seek、音画同步与解密输出通路，再承诺完整迁移。NSH 原生视频能力不自动继承 Chromium/libmedia/FFmpeg 的格式覆盖。

采用或改编 drama 代码要按 GPL-3.0 与其第三方许可规划交付源码、NOTICE 和媒体组件，不能因改成 NSH 就忽略原许可。[许可证](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/LICENSE#L1)、[第三方声明](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/THIRD-PARTY-NOTICES.md#L1)。本次只读评估，未实施重构。
