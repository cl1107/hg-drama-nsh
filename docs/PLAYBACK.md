# 片源、内容解密与视频解码

## 证据与结论

drama 红果主链确有官方域名 API、设备注册、请求签名、媒体 URL 解析、内容密钥派生与 CENC/AES-CTR 解密实现。证明的是代码存在；本轮未执行真实取源和视频播放，不保证服务当前接受全部请求。也没有官方授权 SDK 的证据。

统一固定 commit：`782fb21cbddf1be46f88e97af5e788c99e30beae`。完整历史证据见 [比较报告](evidence/hongguo-project-comparison.md)，关键实现入口如下。

| 环节 | 固定源码 | 已读到的行为 |
|---|---|---|
| 搜索 | [app-source.js L23](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/app-source.js#L23)、[hongguo-app-search.js L35](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/hongguo-app-search.js#L35) | App `reading/bookapi/search/tab/v`，结果结构另有解析器 |
| 详情/分集 | [hongguo.js L491](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/hongguo.js#L491) | 官网 player/detail 内嵌数据；回退 App preload |
| 播放调度 | [hongguo.js L745](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/hongguo.js#L745) | 网页直链 → App 模型 → 旧 preload；迁移按失败分类而非全异常回退 |
| 设备/签名 | [playback-device.js L11](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/playback-device.js#L11)、[playback-signature.js](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/playback-signature.js#L1) | 匿名设备注册与本地签名，不能随意换 UA/参数顺序 |
| 密钥/URL | [app-source.js L282](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/app-source.js#L282) | spade_a 派生 16 字节内容 key；key_seed 派生参数解密 URL |
| variant 解析 | [app-source.js L509](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/app-source.js#L509) | h264/hevc/bytevc2 区分，质量筛选、加密元数据验证、CDN 限制 |
| 媒体解密 | [hongguo.js L887](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/hongguo.js#L887)、[L1066](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/hongguo.js#L1066) | MP4 box、sample/subsample 与 CTR，输出结构重建 |
| FFmpeg 分支 | [main.js L3320](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/main.js#L3320) | 内容 key 交媒体后端处理，不是普通 URL Base64 还原 |

实际 host：网页 `hongguoduanju.com`；App `api5-normal-sinfonlinea.fqnovel.com` / `api5-normal-sinfonlineb.fqnovel.com`；设备注册 `log5-applog-lf.fqnovel.com`；媒体模型限定 `qznovelvod.com` / `fqnovelvod.com` / `douyinvod.com`。这些是代码角色，不把域名字符串当本次访问记录。

模型路径常量：`/novel/player/multi_video_model/v1/`、`/reading/bookapi/video_tab/multi_video_model/v1/`；分集回退 `/novel/player/multi_video_detail/preload/v1`。实际请求方法、签名 query/header/body 与响应层级迁移时逐端点查源码和脱敏真实响应，不能只凭此路径表实现。

本机安装版 1.2.27 静态证据也显示 `hgapi.Client`、`PlaySourcesFrom`、CENC/AES-CTR 调用。它用于相互核对与 UI 观察；闭源、签名及诊断上报边界见 [静态报告](evidence/hongguo-player-static-security.md)。不复用它的二进制、凭证或更新机制。

## 目标链路

1. SourceProvider 取得剧/集 ID，保留精度；注册/恢复本项目自己的匿名设备。签名只在协议层。
2. 解析播放模型为严格 variant：URL、编码、实际质量、加密方式、必要头、有效期。明确的明文标志才能生成 clear；无 spade/key 的未知加密结果应报错。
3. 校验 URL 和重定向目标；在有效期内复用，403/过期仅允许刷新模型再重试一次，不能无限请求。
4. 明文 H.264/HEVC 进入平台播放器；CENC 媒体进入可取消的媒体后端，按 MP4 元数据解密，输出可 seek 的明文容器/流后再交播放器。
5. MediaBackend 根据实测编码支持选择兼容 variant；兼容编码变化保持同一质量要求，降低质量须用户明确选择。更新进度按实际播放器事件。
6. 切集/离开终止旧 session；ended 仅推进一集；错误重试保持原 episode 和位置。下一集预取只预取必要模型/有限字节，有用户流量和缓存约束。

必须区分：签名是请求身份/完整性参数；URL 解密只还原地址；CENC 解密处理媒体样本；H.264/HEVC/ByteVC2 解码将压缩视频变成帧。任何一步成功都不能替代下一步验收。

## 解密后端选择

P0 先以小样本验证上游算法与输出。保留 sample IV、subsample clear/encrypted 区段、轨道与时间戳，不得对整个文件直接跑 CTR。验证 `moov/mdat`、视频音频轨、片段化 MP4 情况；超出当前实现的 scheme/box 明确拒绝，不能宣称支持任意 DRM。播放与下载共用同一媒体处理模块。

生产默认避免在 QuickJS 线程整文件读入、复制与解密。初期可通过完整临时 MP4 验证正确性，但必须标记首帧等待和内存成本，P3 前验证流式/分段或可控缓存方案。Range/seek 从容器和样本边界映射，禁止仅转发任意 Range 后丢失解密上下文。

FFmpeg 或兼容库是候选，不是假定 NSH 内置；纯 TSX 桌面子进程方案需核实 process 能力、打包/签名和参数泄漏问题。命令行携带 key 会暴露给本机进程观察者，优先库内调用或经安全句柄传递；原生方案会触发模式决策。移动端不能启动桌面 FFmpeg 可执行文件。下载二进制须版本、摘要、许可、架构齐全，首期不在运行时自动下载未知解码器。

## 编码与平台矩阵

[NSH Video 文档](https://nsh.dev/docs/web-view-and-video.md)说明 Apple 端基于 AVPlayer，Windows 基于 Media Foundation，Linux 依赖 GStreamer；这不保证任一内容编码可播。

| 平台 | 优先后端 | 本轮状态/必测 |
|---|---|---|
| macOS | NSH Video/AVPlayer | 未实测；H.264、HEVC 真样本、请求头、音轨、seek、倍速、全屏 |
| Windows | NSH Video/Media Foundation | 未实测；HEVC 组件可用性与覆盖层/键盘 |
| Linux | NSH Video/GStreamer | 未实测；插件缺失反馈；文档当前提示 rate 有限制 |
| iOS | AVPlayer | 未实测；前后台、音频会话、文件保护、签名权限 |
| Android | NSH 平台播放器 | 未实测；设备硬解差异、后台、存储权限 |
| Web | 浏览器视频能力 | 未实测；CORS、Cookie、Range、自动播放、编解码与解密执行位置 |

ByteVC1 在上游模型解析中归为 HEVC；仍需具体样本确认。ByteVC2 不等同 HEVC，平台默认不承诺支持；上游软件解码资产不能直接移植到 QuickJS。先向同集请求兼容 H.264/HEVC；无兼容源显示明确原因，后续解码器作为独立技术任务，不能静默播错或把加载卡住。

## 端到端验证记录格式

每条样本只保存脱敏元数据：日期、来源角色、剧/集匿名引用、codec、容器、质量/尺寸、加密类型、解析/解密/播放结果、首帧/seek/CPU/内存、错误阶段。真实 URL/key 不进报告。离线向量测试负责算法正确性，实际播放负责容器、时间戳、解码及音画同步；两者都必须做。
