# hongguo-player 安装版静态安全补充

结论：本次**未发现能够明确认定为窃密、挖矿、恶意远控的证据**；但不能认定安全。最值得注意的是：应用包没有可信开发者签名、更新程序会清除新版扩展属性并替换启动程序，以及存在事件/错误/环境信息上报。建议谨慎作为普通播放器使用；在发布者身份和上报范围核实前，不建议绑定重要账号或授予额外权限。用户若对闭源软件信任要求较高，优先选可审查源码的方案。

## 范围与产物身份（已观察到）

分析日期：2026-11-15。对象仅为 `/Applications/红果短剧.app` 当前安装产物，版本 `1.2.27`，bundle ID `com.wails.hgplayer`。没有启动目标或其可执行文件，没有安装更新、改隔离属性、访问登录数据或上传样本。

- 主程序 SHA256：`73314fe3017e56e716ecaf83d1aa6340ddfd6c5d17760fc9ef2c2d3b4c17428b`。
- 包内只有主程序、`Info.plist`、`iconfile.icns` 三个普通文件；未见嵌套 helper、独立 dylib、ASAR。完整大小及 SHA256 在 [inventory.txt](player-static/inventory.txt)。
- 双架构 Mach-O：x86_64 / arm64。Go build metadata 为 `go1.25.0`，路径 `hg-go/cmd/hgplayer`，依赖 Wails v2.11.0、wazero、SQLite、HEIC 等；系统链接 Cocoa/WebKit/Security。可确认 Go/Wails 包装，不能把 Go 依赖表当成完整第三方代码清单。见 [buildinfo.txt](player-static/buildinfo.txt)、[libraries.txt](player-static/libraries.txt)。
- `codesign -dvvv`：`Signature=adhoc`、无 TeamIdentifier、`Info.plist=not bound`、`Sealed Resources=none`；未输出 entitlement。`codesign --verify --deep --strict` 失败：`code object is not signed at all`。不能验证发布者身份或应用包整体资源完整性，也没有已验证的 sandbox 限制。未签名本身不等于恶意。
- `spctl` 输出 `accepted`，但同时明确 `source=no usable signature`、`override=security disabled`；这次接受来自本机安全评估关闭，不能解读成已公证、可信或通过安全审计。见 [signature.txt](player-static/signature.txt)。

## 已观察到的代码能力

证据均来自安装文件，不来自 README。Go 常规符号已剥离，但 `__gopclntab` 仍可恢复函数名和地址；使用本地 Go 标准库解析器恢复两架构函数表，重点反汇编 x86_64 的 125 个函数。以下地址为 x86_64 虚拟地址，字符串 offset 为整个 universal 文件偏移；不表示代码实际执行过。证据目录 [player-static](player-static/)。

| 项目 | 实际静态证据 | 判断 |
|---|---|---|
| 子进程与更新 | `Updater.Apply` 在 `0x1008625e0` 调用 `startWatchdog`；后者在 `0x100863c8c` 引用 `/usr/bin/ditto`，在 `0x100863e18` 引用 `/usr/bin/xattr`，邻近参数 `-cr`，随后调用 `os/exec.Command` 与 Run | 存在解压和移除新版扩展属性的更新实现；不是只命中 shell 字符串 |
| 应用替换与重启 | `runPlan` 多次调用 `os.rename` / `os.removeAll`，`0x100864e3a` 创建命令，`0x100864ed8` Start；`openApp` 引用 `/usr/bin/open` 并调用 Run | 存在本机更新替换、启动及回滚路径，不足以认定远控后门 |
| 下载校验 | `Updater.fetch` 发起 HTTP 请求，在 `0x100868840` 调用 SHA256 Sum，且有 `SHA-256 校验失败` 错误分支；manifest 经 `updproto.OpenManifest` | 不是完全无校验下载；清单签名的信任根、校验覆盖与回退等本次未完整恢复，不能称具备可信更新链或断言缺少签名校验 |
| 上报能力 | `ReportEnv.func1` 在 `0x100884e22` 调用 `Updater.Track`；`flushHealth` 使用 `api_health`；Track JSON 序列化入队；Flush 在 `0x10086a089` 调用 post；post 在 `0x10086a325` 创建 HTTP 请求并在 `0x10086a401` 执行 | 已确认有环境/事件/接口健康上报代码，是否默认开启、实际内容与收件服务器需要进一步核实 |
| 错误与反馈 | `ReportError`、`reportPendingCrash`、`SubmitFeedback`、`ReplyFeedback` 及 `/api/v1/feedback` | 有诊断/反馈功能；没有完整证明所有敏感字段均脱敏 |
| 账号数据 | 自有 `Session.CookieString`、登录验证码、SMSLogin、QRLogin、Store 等函数 | 符合播放器自有账号会话用途；不能据此认定读取浏览器 Cookie |

更新相关反汇编：`player-static/hg-go_internal_update.startWatchdog.asm`、`runPlan.asm`、`openApp.asm`（均带相同 `hg-go_internal_update.` 文件名前缀）；其余见 [functions.txt](player-static/functions.txt) 和 [string-xrefs.txt](player-static/string-xrefs.txt)。可重跑本目录 `symbols.go` 与 `inspect.py` 的离线分析；它们只读取应用文件并运行分析工具。

网络线索：`https://hongguo.235698.xyz`（file offset `0x1011190`）；蓝奏目录（`0x927cc8`）；GitHub 作者仓库及 releases 字符串（`0xace5ad`、`0xbbce6d`）；`/api/v1/events`（`0x910f2d`）、`/api/v1/check?`（`0x910f3b`）。上报 post 通过配置拼 URL，尚未把所有目标值完整追溯到运行配置，所以**不能把这些字符串直接等同实际访问记录**。Go 字符串常相邻无分隔，自动 URL 扫描可能多取后续字符，需结合 RIP 引用及长度复核。见 [urls.txt](player-static/urls.txt)。未连接这些服务。

## player 的片源与解密可以补充什么

之前“源码不可见、实现未知”现在可以缩小为：**安装产物内确实实现了媒体内容解密，并有面向红果/番茄官方接口的取源代码线索**。

- `hgapi.Client` 包含 VideoModel / MultiVideoModel / callPlayHosts / PlaySourcesFrom 等；有 `hongguoduanju.com`、多个 `api*-normal*.fqnovel.com` 与 `novel.snssdk.com` 字符串。PlaySourcesFrom 的代码确实处理 video model、fallback、密钥与 URL。官方 host 字符串和专门 API 模块相互支持，但本次没有完整恢复主机配置选择及全部请求参数，**只能确认官方直连实现线索，不能确认实际播放总是官方直连，也不能排除额外代理**。
- `PlaySourcesFrom` 在 `0x1006da835` 调用 `cenc.DeriveContentKey`；`0x1006dae60` / `0x1006daeeb` 调用 `DecryptSpadeURL`。密钥从媒体响应字段处理的路径存在；未提取账户秘密或实际内容密钥。
- `media.Proxy.serveDecrypted` 在 `0x100821760` 调用 `Prepared.DecryptRange`，后者在 `0x1006929cc` 调用 `DecryptCTRSample`；样本解密在 `0x100694e43` 调用 `crypto/aes.NewCipher`、在 `0x100694eee` 调用 `crypto/cipher.NewCTR`。这形成实际解密调用链，**明显超出 Base64/URL 解码**。相关 `.asm` 均保留调用目标注释。
- 这些证据说明播放器自带 CENC/AES-CTR 媒体处理，而非只能接收第三方明文 URL；但不证明官方授权、任意 DRM 支持、付费破解或全部视频今天可播。原始内容版权归属及传播授权仍无法由此判断。

## 潜在风险

1. **发布者与更新信任风险最高。** 临时签名无法验证作者；程序存在清除扩展属性、替换并启动新版的能力。SHA256 校验有价值，但还需确认清单签名和可信根，不能只依赖同一服务端同时给出包和 hash。
2. **诊断隐私边界未清楚。** 事件队列、安装 ID、API health、环境、崩溃上报能力存在；本次没有恢复完整数据字段和默认开关，不能承诺不会上传账号或私人信息，也没有发现它正在上传这些内容的证据。
3. **没有证实沙箱约束，闭源审计覆盖有限。** 自有会话、文件缓存、下载目录及外部进程管理扩大了需信任范围；依赖版本已列出，未做漏洞数据库扫描和完整调用图审计。

## 无法确认及有界排查结果

- 未发现与目标名/路径匹配的当前进程；只检查进程名/可执行路径，没有读取其他进程环境或秘密。
- 在用户及系统 `Library/LaunchAgents`、系统 `Library/LaunchDaemons` 的 plist 内容中，未找到“红果”/`hgplayer`/`hg-go` 标记。未遍历所有登录项数据库、Background Task Management 状态或匿名 helper，所以不能保证不存在其他持久化。
- 对整个主程序做敏感位置/恶意特征关键词筛查，未命中 `.ssh`、`Login Data`、`Cookies.binarycookies`、`login.keychain`、`SecItemCopyMatching`、`SecKeychain`、`xmrig`、`stratum+`、`LaunchAgents`、`LaunchDaemons`、`/bin/sh`。这只是有界阴性证据，路径可动态拼接、调用可间接进行，不能据此保证不窃密、不挖矿。
- macOS 的 `FixLoopbackProxy` 在本次反汇编中只构造返回值，没有进程/系统设置调用；未看到明确安装证书或改系统代理的静态证据。没有检查所有 Objective-C 间接消息和嵌入 Wasm/前端代码，不能给全局否定结论。
- REA MCP 未提供、`rea` CLI 未安装；没有为这次简单检查安装引擎或修改全局配置。使用系统 codesign/spctl/otool、Go 标准库及 Xcode llvm-objdump 完成支持范围内的静态分析；本报告不冒称 REA Evidence 或反编译源码。
- 未观察真实网络、运行时文件访问、自动更新触发、上报开关、完整 DRM/解码兼容性；未做 arm64 全函数反汇编或依赖漏洞审计。动态结果均未知。

建议：不需要仅凭这次结果立即认定恶意并卸载；也不要据此放宽系统安全设置或盲目信任自动更新。若继续用，保持权限最小化，暂不绑定重要账号，并优先向作者核实上报内容、关闭方式和可验证的更新签名。NSH 重构仍应选择可合法复用、可审查的源码；本次二进制补充不改变 player 未开放源码的事实。
