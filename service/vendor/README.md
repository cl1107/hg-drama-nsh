# 协议参考代码

`hongguo/` 六个 JavaScript 模块来自 jackotom/hongguo-drama 固定提交
`782fb21cbddf1be46f88e97af5e788c99e30beae` 的 `src/native/`，用于桌面开发服务。

原始 LICENSE、NOTICE、THIRD-PARTY-NOTICES.md 已原样保留在该目录。遵循 GPL-3.0 及各文件上游声明。不是官方 SDK。

本项目改动：`app-source.js` 的 axios 传输替换为 `service/transport.cjs`，其他算法保留原实现。传输层用 Node 内置 HTTPS，逐域名及 DNS 地址验证，限制大小和超时；没有额外 npm 依赖。复制范围未包含 Electron、React 或账号凭证。

`src/media/cenc.cjs` 按该上游算法思路重写严格容器解析，亦标记 GPL-3.0-only。
