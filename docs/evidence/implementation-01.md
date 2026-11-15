# 第一阶段实现与验证（2026-11-15）

## 已落地

- NSH 0.5.1 (224d9a7) 官方 macOS arm64 分发安装于 `.tools/nsh`，SHA256 `2710affd59e6345b6f87dfa1f579c36b9a9d7a58992b8399d14f39290da048a3` 与上一轮官方 release 记录一致。全局工具未改。
- 从该版 CLI 原生 ts 模板初始化，保留 TSX 工程模式；配置为 `com.hgdrama.nsh` / 0.1.0。
- `src/providers/catalog.ts` 按实际官网 SSR `loaderData.page.homeSections[].video_list` 校验并映射。用字符串 ID，不丢精度；解析 `_ROUTER_DATA` 的完整 JSON，不执行页面脚本。
- `src/catalog-store.ts` 管理请求、15秒超时、旧请求取消与响应隔离。
- `App.tsx` 有参考布局的侧栏/折叠/导航、深浅色 tokens、公开目录加载、分区选择和当前目录内搜索、真实空态/失败态、虚拟化列表。当前使用剧集行，海报网格和页面细节尚未完成视觉还原。
- 独立播放探针接受 HTTPS URL，使用 NSH Video 原生控制条、暂停和 seek。只是探针，尚未验证实际媒体播放。其余页面入口显示开发中，不能计入功能完成。

## 已执行与结果

原始模板 check/build/test 通过后开始修改。当前 `./tools/nsh check`、`build` 通过；`App.test.tsx` 两项（目录加载/筛选、503反馈/导航）通过；`runtime.test.tsx` 两项（SHA-512 标准摘要、NIST AES-CTR 解密向量）通过。

在线 `catalog` 应用测试显式使用 `{network: "live"}`，通过 NSH 自己的网络栈取得官网首页并显示“热播短剧”。命令为 `./tools/check-live.sh`。测试使用真实网络，不是离线 fixture。

Cookie 探针使用本机 `127.0.0.1:18791` Python 测试服务器：302 保持不跟随、Location 正确、两条 HttpOnly Set-Cookie 独立保留，应用测试通过。重复步骤：一个终端 `python3 tools/probes/http-server.py`，另一个 `./tools/check-live.sh --cookies`。不访问用户凭证。

注意：直接在 NSH 测试文件顶层 fetch 会报“this host has no network stack”；测试应用 `open(...,{network:"live"})` 才可验证网络。测试宿主不继承 shell 的 NSH_LIVE 环境变量，因此在线模板由脚本复制进 `.tmp` 执行，离线默认不依赖本机服务器。测试模板放 `tools/probes/*.test.template`。

实际执行 `nsh run --target macos --name 红果短剧-NSH --window-size 1480x820`，原生宿主连接成功，桌面工具确认同名窗口。截图返回 `CUA_UNAVAILABLE / screen_locked`，未做视觉或音视频验收。不能把窗口启动等同界面已验证。

## 新证据与剩余工作

实际官网公开首页返回完整 `homeSections`，可无需登录加载该目录。当前搜索只是已加载目录过滤，输入框明确范围，尚未实现完整 App 搜索。fixture 是公开首页两分区各两条记录，未包含请求身份/凭证。

实际 `https://hongguoduanju.com/player/7503745441910017049` 的 SSR key 是 `player_(series_id)/page`，返回 `protectedPlayback:true`、`videoList:{}`，但有 seriesDetail/publicVideoSeo。它不能当完整媒体模型；公开 SEO 视频若有也不能冒充全剧。下一步按 PLAYBACK 接 App 协议及匿名设备，先做真实加密样本闭环。

生成的 VideoHostProps 没有 headers 属性，仅 src/paused/volume/rate/controls 等；VideoRef 提供 seek(seconds)。需要 UA/Referer 的媒体必须适配。不要给 Video 猜造 headers prop。QuickJS 的 AES-CTR 运算已证明可用，但 MP4 样本解密、URL CBC、ByteVC2、安全存储和账号登录均未完成。

当前运行环境网络在 shell 沙箱内 DNS 受限，下载和 live 测试经授权的扩展权限执行。工具下载/本机服务/项目原生宿主均未遭自动审批拒绝。截图阻塞来自锁屏。

## 下一步

1. 固定参考 commit，移植搜索签名/匿名设备请求及严格 DTO；先补可复现协议向量，记录许可来源。
2. 真实解析播放 variant，选择兼容 H.264/HEVC，完成 CENC 样本处理与原生 Video 的可 seek 输出。
3. 安全存储 API 探针和扫码流程；现有客户端凭证不可复用。
4. 解锁后检查原生外观，再将目录行改为响应式海报网格并补详情/选集。
