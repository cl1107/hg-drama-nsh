# 证据索引

## 版本

[versions.json](versions.json) 是 2026-11-15 快照。NSH 最新稳定版 [v0.5.1](https://github.com/longbridge/nsh/releases/tag/v0.5.1) 发布时间 `2026-11-14T05:22:06Z`，本机 `0.5.0 (f4d68f7)`，未升级。GitHub connector 实时返回 release 与 drama HEAD 元数据；drama HEAD 仍为 `782fb21cbddf1be46f88e97af5e788c99e30beae`，提交时间 `2026-11-14T21:13:53Z`。

官方 NSH 文档本轮核实：[安装/更新](https://nsh.dev/docs/installation.md)、[Video 平台后端](https://nsh.dev/docs/web-view-and-video.md)、[文档索引](https://nsh.dev/llms.txt)。在线文档可能比固定 release 新，若与生成类型冲突以发行版本实现为准。官方文档与本地技能参考对 Android 最低 API 的描述有差异，P8 应核对固定版本 manifest/源码并在真机验证，不能任取其一承诺。

## 继承证据

- [项目比较](hongguo-project-comparison.md)：前序源码评估，含固定 commit 链接和历史测试范围。
- [安装包静态分析](hongguo-player-static-security.md)：前序只读静态调查，保留其“不等于运行证据”的边界。

这两份报告按原文归档。其指向 `player-static/`、`drama/review-tests.log` 等原始附件未复制进本项目；报告中的这些相对链接不能在本项目直接使用。原始资料位于本机：

`/Users/cl/Library/Application Support/CindyGlobal/owners/e35e00465ea13a92fdb9/bots/cindy-default/workspace/.tmp/hongguo-review/`

该路径只是补查入口，计划实施不依赖它存在；公开源码以报告的固定 commit 链接获取，尚未独立复核的二进制结论仍标为历史静态证据。不要将它们当本项目当前运行日志。

## 本轮额外复核

直接读取参考仓库 `account-session.js`、`app-source.js` 的登录、云历史、密钥/URL 和 variant 实现，详见 AUTH/PLAYBACK 固定代码链接。未重新运行前序 39 项测试。

只观察了已运行的红果客户端窗口结构，确认页面入口；补拍时返回 `CUA_UNAVAILABLE / screen_locked`，未取得新增屏幕图，页面点击未成功。没有把 AX 文字当接口响应，没有提取账号秘密。七图是用户提供附件的原样复制，非本轮运行截图。

## 待验证账本

| 项目 | 当前证据级别 | 下一步 |
|---|---|---|
| 官方域名取源/签名/内容解密 | 固定源码实现已证实 | P0 脱敏真实请求与媒体样本 |
| 安装版解密能力 | 历史静态调用证据 | 必要时针对当前文件摘要复核，不扩大为源码可复用 |
| NSH 0.5.1 纯 TSX 协议兼容 | 未测 | 生成类型 + crypto/fetch 探针 |
| NSH 视频格式/请求头/seek | 平台后端文档 | P0 每种编码实测 |
| 扫码登录 | 固定源码实现 | 用户确认后端到端验证 |
| 短信登录 | 截图/二进制符号线索 | 观察官方交互并核实完整契约，未请求短信 |
| 发现/榜单/日历/收藏/预约写接口 | 未完成核验 | P0d 能力矩阵，每项附方法/层级/字段 |
| 安全存储纯 TSX 可行性 | 设计目标 | 声明/源码/恢复测试；必要原生方案决策 |
| 未截图页面 | 待补 | 用户解锁后按 UI 清单采集 |

后续每个新结论注明“源码/静态/运行/设计”之一，失败样本需脱敏并给复现步骤。不要把接口缺失简单归入“网络错误”。
