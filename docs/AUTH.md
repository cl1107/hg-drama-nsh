# 登录与账号方案

## 已有证据

参考 commit 同 PLAYBACK：`782fb21cbddf1be46f88e97af5e788c99e30beae`。本轮直接读取 `account-session.js`，确认以下是客户端实现，不代表本次已经登录成功。

| 动作 | 源码及契约线索 |
|---|---|
| 获取扫码 | [account-session.js L330](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/account-session.js#L330)：官网 `/passport/web/get_qrcode/`，next 指向官网；解析 data.token/qrcode/expire_time |
| 轮询 | [L341](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/account-session.js#L341)：`/passport/web/check_qrconnect/`，token 和独立 CookieJar，可能需跟随 redirect_url |
| 验证账号 | [L231](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/account-session.js#L231)：`/passport/account/info/v2/`，返回可校验 user ID 才建立登录状态 |
| 安全保存 | [L166](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/account-session.js#L166)：Electron 宿主安全存储，不能原样用于 NSH |
| 云端历史 | [L405](https://github.com/jackotom/hongguo-drama/blob/782fb21cbddf1be46f88e97af5e788c99e30beae/src/native/account-session.js#L405)：签名请求 `/reading/bookapi/read_history/list/v1/`，解析 data.data_list；读接口不证明支持写回 |

上游网页 query 含 aid `513755`、passport_jssdk_version `3.4.10` 等，属于该固定版本的实现线索。需要完整移植时核实 query、UA、CSRF、Cookie 域和重定向策略，不拆掉看似多余字段。账号 API 与播放设备 API 分层，匿名可播不等于已登录。

用户截图显示“扫码登录/短信登录”；安装产物符号含 SMSLogin、QRLogin，但没有足够的短信端点、请求格式、风控/验证码契约。因此首选扫码；短信为首期调研任务，完成契约后再实现，不凭接口命名猜测。验证码图片、滑块或风控若出现，交给官方页面与用户正常完成。

## 状态机与交互

匿名 → 创建二维码 → 等待扫码 → 已扫码/等待手机确认 → 验证资料 → 安全保存 → 已登录。另有 expired、cancelled、denied、networkError、storageError。扫码状态码与 UI 状态映射以真实响应为准，不假定数字枚举。

二维码只展示本次服务端返回图片，绝不复用截图中的二维码。使用服务端过期信息倒计时，过期显示刷新按钮；默认单请求轮询，初始约 2 秒间隔（待协议核实），失败退避，窗口关闭/离开/切换登录方式即取消。任何时刻仅一个有效 loginGeneration，旧请求不能覆盖新二维码或退出后的状态。

跟随登录跳转逐跳校验 HTTPS 与已确认账号域，限制跳转次数；CookieJar 处理多 Set-Cookie、domain/path/secure/expiry，不能拼接到所有网络请求。P0 要验证 NSH fetch 是否暴露这些响应头和 manual redirect；不满足时查原生支持，不能从网页脚本读取 HttpOnly Cookie 来规避。

二维码完成后必须资料验证成功，再向 UI 暴露昵称和 account ID。网络中断时保留“待验证”而非误报登录失效；明确 401/服务端过期才要求重新登录。退出立即取消轮询/同步和清空内存凭证，删除本项目安全存储记录；若存在已确认服务端注销接口再调用，不能把本地退出表述为所有设备退出。

## 安全存储与平台

macOS 优先 Keychain；Windows Credential Manager/DPAPI；Linux Secret Service；iOS Keychain；Android Keystore 保护的存储。这些是目标适配方案，尚未证明 NSH 0.5.1 纯 TSX 提供相应 API。P0 需检索声明、官方模块和实际重启测试。

没有系统安全存储时，默认会话仅保留内存，重启重新扫码，界面说明限制。不得将 Cookie 写进 NSH Storage、普通 JSON、日志或 shell 参数，也不得用仓库内固定 key 加密后声称安全。若必须补原生桥，遵循 HANDOFF 模式取舍流程。

Web 不能持有本机 Keychain 或隐含复制原生 Cookie。若官方 CORS/登录策略不允许纯前端，需用户明确选择自建同源 BFF，再设计 HttpOnly/Secure/SameSite 会话与部署；这不是原生客户端默认所需第三方后端。

## 本地与云端资料

本地历史、收藏、点赞、追更可以先实现本地能力，标签和设置明确同步范围。已确认可读取云端历史；云端收藏、点赞、预约、追更、写回进度和删除记录均待确认，不用“操作成功”掩盖仅修改本地。

云读失败不擦掉本地记录；合并必须有账户、来源、剧/集 ID 和更新时间策略。服务端没有可信更新时间时不执行 last-write-wins。离线可记录本地操作，但只有确认幂等/冲突协议后才增加出站同步队列。

## 必测

二维码刷新/过期/取消/拒绝、确认后资料失败、多次快速开关、退出时延迟响应、Cookie 域隔离、恶意跳转、安全存储拒绝、重启恢复、服务端失效、网络离线、A 账号退出后 B 登录。测试夹具需移除 token、Cookie、手机号、二维码图和重定向票据。真实扫码由用户在官方 App 完成，agent 不获取短信或代确认。
