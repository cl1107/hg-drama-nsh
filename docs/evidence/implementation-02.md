# 真实播放链路验证（2026-11-15）

## 结果

已打通：本项目匿名设备注册 → 请求签名 → 官方播放模型 → 官方 CDN 下载 → 内容密钥派生 → CENC MP4 样本解密 → 本机 Range 媒体服务 → NSH macOS 原生 Video。

真实对象：《宴律，你的白月光回国了》，series ID `7503745441910017049`，第一集 `7503780574541122622`。官网详情提供76集的 vid_list，UI 按该列表映射选集；未使用原客户端/浏览器登录凭证，也没有第三方解析服务。

本集取得 1080p HEVC 加密媒体，21 MiB（22,421,134字节），视频1080×1920、音频AAC、时长211.833333秒。完整文件解密后 SHA256：`d9684e0cb60537f8377a8dfd1961e20e9ee35eb1fa881aa111d02d2815912694`。内容密钥仅驻内存，不写出；签名 URL、生成的本机服务配置与媒体资源 URL 均仅在被忽略的临时目录，不进本文档。

## 实现

- `service/vendor/hongguo/`：固定参考提交 `782fb21cbddf1be46f88e97af5e788c99e30beae` 的协议/注册/签名模块及原始许可，传输替换为 Node 内置 HTTPS；没有 npm 依赖。
- `service/transport.cjs`：限定源/API/CDN域名，固定 DNS 已检查的公网地址，限制协议、超时、大小；不自动携带账号 Cookie。
- `service/playback.cjs`：官网详情绑定剧和分集；请求模型、保持质量档位选择兼容 H.264/HEVC，下载后交解密模块。
- `src/media/cenc.cjs`：严格解析 MP4 sample、8/16字节IV、subsample、stco/co64；等长替换保护元数据，保留chunk offsets。比上游简化逻辑增加格式/边界检查和subsample支持。明确拒绝未支持加密格式，见该目录 README。
- `service/server.cjs`：只绑定随机回环端口，Bearer授权控制、拒绝外部Origin、不可预测媒体路径、单Range/HEAD、取消传播、两集/30分钟开发缓存。
- `src/features/player/`：响应契约校验、超时/取消、旧请求隔离、原生Video、暂停/seek、虚拟化选集列表。目录“播放”按钮已连接该流程。

TSX 工程模式不变。当前 Node 24 开发服务单独承担协议与媒体处理；整集下载解密后才出首帧，仍需后续流式处理及正式打包。移动端/Web 不继承这套桌面后端。代码已附 GPL-3.0 LICENSE 和上游声明。

## 实际验证证据

1. `node service/probe.cjs` 成功取得真实 encrypted/hevc/1080p 模型及官方 qznovelvod.com CDN 媒体，写 `.tmp/media/first.mp4`。
2. `ffprobe` 确认 HEVC/AAC、1080×1920、211.833333秒；`ffmpeg -v error -i .tmp/media/first.mp4 -f null -` 全集音视频解码完成、退出0，无解码错误。
3. FFmpeg 8秒画面已实际查看，内容清晰，无花屏。
4. 通过 `service/verify-playback.cjs` 实际调用回环服务完成另一遍取源/解密，返回同一剧第一集、76集列表；媒体 `Range: bytes=0-1023` 返回206和1024字节。
5. NSH 原生验证窗口记录：`onLoad` duration=211.834，size=1080×1920；`onProgress` 到3.000183578秒；seek(60)后到60.250058389秒并继续。这是实际 AppKit/AVPlayer 宿主，不是 headless 播放模拟。
6. Apple AVFoundation `AVAssetImageGenerator` 同一解密媒体于60.233333秒提取1080×1920画面，已实际查看：[原生解码帧](playback/apple-frame-60.png)。该图是原生媒体解码帧，**不是应用窗口截图**。沙箱中首次因硬件解码权限返回 Cannot Decode；在完整本机权限下成功，未修改媒体或解密算法。
7. TSX `PlaybackFlow` + 实际服务在线测试通过：正确显示本剧第一集和1080p HEVC，选集列表滚动到底可见第76集。headless测试只证明用例/控件数据连接，原生播放证据来自第5/6项。

回归：19项上游签名/设备离线测试、10项自有媒体/回环服务测试、5项NSH交互/契约/crypto测试通过；check/build通过，另外1项真实播放服务→UI在线测试通过。Node测试需 `--test-concurrency=1` 顺序执行。

## 可重复步骤

日常：`./tools/dev` 启动开发服务和主窗口 → 加载官网目录 → 在任意可用剧集行点“播放” → 选择分集。退出开发命令会停止服务。需要Node24+和已安装的项目NSH0.5.1。

复现本文固定剧：

1. 一个终端 `node service/server.cjs`。
2. `node service/verify-playback.cjs`。
3. `./tools/nsh run tools/probes/RealPlayback.tsx --target macos --name 红果短剧-真实播放验证 --window-size 1280x820`。该DEBUG探针在进度3秒后自动seek到60秒并输出固定字段的加载/进度诊断，不打印任何媒体URL或密钥。
4. `cp tools/probes/playback.test.template .tmp/playback.test.tsx` 后 `./tools/nsh test .tmp/playback.test.tsx` 可复跑在线UI链路；需要上一步服务仍运行。
5. 原生帧复现：`swiftc -parse-as-library -module-cache-path .tmp/swift-cache tools/probes/apple-frame.swift -o .tmp/apple-frame` 后 `.tmp/apple-frame .tmp/media/first.mp4 .tmp/media/apple-frame-60.png`。需要完整本机媒体访问；锁屏不影响媒体帧解码，但会阻止窗口截图。

## 限制与下一步

初次验收因 `CUA_UNAVAILABLE / screen_locked` 未能截图；用户随后明确回复已解锁，补充窗口验收见下节。

已验证单剧第一集完整媒体。其他集/其他剧需逐样本扩充，ByteVC2、fragmented MP4、登录、断点持久化、自动连播和跨平台后端未在本轮完成。DEBUG验证文件保留且有标记，清理由用户决定。后续继续主播放器产品化、流式首帧与账号，不重做已有效的单集解密验证。

## 用户解锁后的窗口验收

用户明确回复“已解锁，可以验收画面”后，只操作本项目原生窗口。主窗口截图：[找剧初始页](playback/main-window.png)，导航与输入/按钮无明显遮挡或溢出；当前未加载目录，因此该截图不代表目录内容或完整播放器页面验收。

原生播放验证窗口截图：[实际播放画面](playback/real-playing-before.png)，进度89/211秒；人物、场景清晰，竖屏比例正确，两侧留黑，无明显花屏、裁切或控件重叠。暂停后 AX 确认按钮变为“继续”，进度113/211秒；后续暂停帧截图失败，未取得有效图片，未继续执行恢复播放。现有有效窗口证据只有播放中截图。窗口来自 NSH AppKit/Video，区别于此前媒体帧提取。

本次旧验证资源已被后续测试缓存替换，重新在线取源返回 `EMPTY_RESPONSE`（HTTP200空响应）。因此截图使用之前已成功下载解密、SHA256与本文记录一致的本地缓存，经同一生产Range服务接口重新提供给原生播放器。新增 `tools/probes/serve-cached.cjs`（DEBUG标记）用于复现；已检查语法。该次截图证明原生显示/交互，不扩大为本次重新在线取源成功；前次成功端到端记录仍保留。
