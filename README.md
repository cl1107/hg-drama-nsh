<div align="center">

<img src="assets/app-icon.png" width="96" height="96" alt="红果短剧-NSH">

# 红果短剧 NSH 客户端

### 不用安卓模拟器，直接在电脑上原生追红果短剧

基于 **NSH 0.6.1 (TSX)** 与本机 **Node 24** 媒体服务构建的红果短剧第三方桌面客户端，先在 macOS 本机完成验证，持续向跨平台扩展。

**沉浸式刷剧 · 自动连播 · 多维找剧 · 9 大排行榜 · 剧集主页 · 离线下载 · 云端同步**

</div>

## 🖥️ 为什么做这个？

在电脑前想刷几集短剧时，拿起手机或者专门开一个安卓模拟器都很折腾。  
本项目使用 NSH 原生 UI 与本地解密服务，直接在桌面窗口里完成推荐刷剧、找剧筛选、排行榜浏览、选集播放、离线缓存与账号同步。

## ✨ 主要功能

- 🎬 **推荐刷剧**：打开即看推荐流，支持「关注 / 真人剧 / 推荐」切换、上下切换剧集与点赞/收藏/追更/下载
- ▶️ **原生播放与连播**：自研控制条，支持自动连播下一集、断点续播、倍速/清晰度切换、选集列表、原地全屏与播放防息屏
- 🔍 **找剧与搜索**：支持关键词搜索（回车提交）、热门搜词、多维度筛选（类型 / 题材 / 设定 / 背景 / 排序 / 受众 / 上新时间），从搜索结果进剧集主页再返回时保留搜索结果
- 🏆 **排行榜**：支持「全部 / 系列剧 / 漫剧 / 真人剧 / AI剧」分类及推荐榜、热播榜、臻果榜、预约榜、新剧榜、热搜榜、追更榜、必看榜、收藏榜
- ✨ **新剧与日历**：新剧推荐流、上新日历与本地追更预约管理
- 📄 **剧集主页**：封面、集数标签、简介、演职员、备案号、分集折叠网格与一键播放/下载
- ❤️ **追剧管理**：观看历史（区分云端历史与本地记录）、收藏、点赞、追更/预约，支持搜索与批量管理删除
- ⬇️ **离线下载**：支持单集下载、队列重试与清理，离线加密解密本地直接播放（macOS 下默认保存在 `~/Library/Application Support/com.hgdrama.nsh/downloads`）
- 👤 **账号同步**：支持扫码 / 短信登录，登录后自动拉取云端观看历史与云端书架；本地会话由系统钥匙串保护，不外泄 Cookie
- 🎨 **桌面体验**：浅色 / 深色主题切换、可折叠侧边栏、长剧名悬浮气泡展示全称

## 📥 开发运行与打包（macOS）

### 环境要求

- **Node.js 24+**
- **NSH 0.6.1 (2f51d86)**：官方发行档解压至 `.tools/nsh`，通过 `./tools/nsh` 调用

### 常用命令

```bash
# 启动开发模式（同时启动本机片源服务与 NSH 桌面窗口）
./tools/dev

# 类型检查、构建与离线测试
./tools/nsh check
./tools/nsh build
./tools/nsh test App.test.tsx
./tools/nsh test src/features/player/session.test.tsx

# Node 服务端单测
node --test service/*.test.cjs service/vendor/hongguo/*.test.cjs

# 在线目录接口检查
./tools/check-live.sh
```

### 打包 macOS 应用

```bash
./tools/package-macos
```

脚本使用固定版本 NSH 与同架构 Node.js 24+ 运行时，在 `.nsh/out/` 下生成临时签名的 `红果短剧-NSH.app`。拖入「应用程序」后，若首次在其他 Mac 上打开提示“已损坏或无法验证”，可在终端执行：

```bash
xattr -cr /Applications/红果短剧-NSH.app
```

### GitHub Release

[Releases](https://github.com/cl1107/hg-drama-nsh/releases) 提供 macOS Apple Silicon 应用包和 Windows x64 免安装包，均内置 Node.js 和本机播放服务。macOS 包使用临时签名，Windows 启动器未签名。

更新 `nsh.json` 的 `version` 和 `build` 并提交后，推送与版本一致的 `vX.Y.Z` 标签。GitHub Actions 会在两端构建成功后发布两个 ZIP 和 `SHA256SUMS.txt`。也可从 Actions 手动运行 `Desktop packages`，仅构建并保留产物供验证。

## ❓ 常见问题

**为什么部分剧集或分集提示“上游暂未提供本集正片片源”？**  
上游片源接口存在偶发空响应（`EMPTY_RESPONSE`）或特定分集仅提供当前播放器不支持的 ByteVC2 编码。客户端已内置多官方主机轮询与备用接口回退；如遇单集持续不可用，可尝试切换其它分集或稍后重试。

**下载的视频用别的播放器打不开？**  
上游正片受加密保护，客户端负责在本地解密后通过本机回环服务（`127.0.0.1`）以 Range 流形式提供给内置播放器播放。

**登录态与本地数据保存在哪里？**  
macOS 上离线下载与本地数据位于 `~/Library/Application Support/com.hgdrama.nsh/`；网页会话凭据保存在本机系统钥匙串中，仅由本地 Node 服务进程使用，不会回传到前端界面。

## 📚 开发文档索引

1. [交接入口与下一步](docs/HANDOFF.md)：最新状态、已完成工作与实施顺序
2. [完整开发计划](docs/PLAN.md)：范围、依赖、任务与阶段验收
3. [架构和领域契约](docs/ARCHITECTURE.md)：TSX 边界、模块、存储与平台适配
4. [片源、解密和解码](docs/PLAYBACK.md)：播放链路、编码兼容与失败处理
5. [登录和账号](docs/AUTH.md)：扫码/短信流程、会话保护与同步边界
6. [界面规格](docs/UI.md)：视觉规范、布局、组件与页面行为
7. [验证与发布](docs/VALIDATION.md)：macOS 验收、回归与跨平台矩阵
8. [证据索引](docs/evidence/README.md)：已证实、推断与版本记录

## ⚠️ 说明与许可

- 本项目为个人学习交流用途的**非官方**第三方客户端，与红果短剧官方无任何从属或合作关系。
- 如遇播放异常或内容不可用，通常取决于上游接口策略或网络环境。
- 协议与媒体改编代码按 **GPL-3.0** 交付，详见 `LICENSE` 与 `service/vendor/README.md`；界面视觉参考自用户提供截图与桌面端体验，协议参考自 `jackotom/hongguo-drama` 与 `N3urda/hongguoTV`。
