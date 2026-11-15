# 本机播放开发服务

Node 24+，无 npm 依赖。`./tools/dev` 启动服务和 NSH 原生客户端，退出时停止服务。
单独启动：`node service/server.cjs`，再 `./tools/nsh run --target macos`。

服务随机绑定 127.0.0.1 端口。控制请求需随机 Bearer，生成到被 gitignore 的 `.tmp/service-config.ts`，不会读用户登录态。媒体使用随机 256-bit 资源路径，支持 GET/HEAD 与单 Range；账号头和内容密钥不返回 UI。无远程服务、无任意 URL 代理、无 shell 执行接口。

只支持源协议能返回的 H.264/HEVC 与非碎片 CENC MP4。现在按整集下载解密、最多缓存两集、30分钟资源有效期；这是低延迟流式播放之前的开发实现，首帧须等待整集准备。Node 是当前桌面验证依赖，不代表 iOS/Android/Web 已具备该媒体后端。完整打包和流式处理见项目后续计划。

`node --test --test-concurrency=1 service/server.test.cjs src/media/cenc.test.cjs` 验证服务边界、Range 和解密。
`node service/probe.cjs` 取得固定剧第一集并写 `.tmp/media/first.mp4`（实际网络、约21MB）。
`node service/verify-playback.cjs` 通过已启动服务执行完整链路并生成临时原生播放验证配置。
验证时使用 `./tools/nsh run tools/probes/RealPlayback.tsx --target macos`。

新增协议来源和许可见 `vendor/README.md`，不要移除上游许可。
