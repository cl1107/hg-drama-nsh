# 红果短剧 NSH 客户端

目标：使用最新稳定版 NSH 的 TSX 模式开发跨平台客户端，先在本机 macOS 验证；界面依据用户截图与 `/Applications/红果短剧.app`，协议和媒体处理参考 `jackotom/hongguo-drama`。

当前已有第一阶段 TSX 实现：官网公开目录加载与筛选、侧栏、深浅色切换和独立 HTTPS 视频播放探针。已新增官方取源、CENC解密、本机媒体服务与原生播放/选集；一部真实短剧第一集已验证。登录与下载管理仍待实施。项目工具固定为 **NSH 0.5.1 (224d9a7)**，全局工具保持不变。

运行（含片源服务，需Node24+）：`./tools/dev`。类型检查/构建：`./tools/nsh check`、`./tools/nsh build`。离线测试：`./tools/nsh test App.test.tsx` 与 `./tools/nsh test tools/probes/runtime.test.tsx`。在线目录验证：`./tools/check-live.sh`。详见 [当前实现与验证记录](docs/evidence/implementation-01.md)。

当前播放证据：[真实播放与画面验证](docs/evidence/implementation-02.md)。协议/媒体改编代码按GPL-3.0交付，见 LICENSE 和 service/vendor/README.md。

## 从这里开始

1. [交接入口与下一步](docs/HANDOFF.md)：后续 agent 先读，包含当前状态和实施顺序。
2. [完整开发计划](docs/PLAN.md)：范围、依赖、任务、阶段验收。
3. [架构和领域契约](docs/ARCHITECTURE.md)：TSX 边界、模块、存储、平台适配。
4. [片源、解密和解码](docs/PLAYBACK.md)：固定源码证据、播放链路、编码兼容和失败处理。
5. [登录和账号](docs/AUTH.md)：扫码、短信待验证项、会话保护、同步边界。
6. [界面规格](docs/UI.md)：七张原图、布局、组件、补图清单。
7. [验证与发布](docs/VALIDATION.md)：macOS 验收、回归与跨平台矩阵。
8. [证据索引](docs/evidence/README.md)：已证实、推断、未验证及版本记录。

历史调查报告仅作证据，当前方案以以上专题文档为准。实现时逐项更新任务状态，不能把“计划”“静态实现存在”写成“已验证可用”。
