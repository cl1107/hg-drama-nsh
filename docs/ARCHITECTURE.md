# 架构与领域契约

## 技术选择

UI 使用 NSH TSX + signals + app-owned styled components，业务与表现分层。纯 TSX 是首选实施模式；媒体重活和凭证存储是否需要 native host，由 P0 实测决定。Node 进程、Electron 服务端、React、浏览器 DOM 都不属于默认运行环境。

官方入口：[TSX/项目结构](https://nsh.dev/docs/project-structure.md)、[原生组件](https://nsh.dev/docs/native-components.md)、[能力限制](https://nsh.dev/docs/sandbox-and-capabilities.md)。在线文档随 main 变化，精确导出以固定 CLI 的 `.nsh/types` 为准。

依赖方向：页面 → feature store/use cases → 领域契约 → 平台/来源适配器。页面不得拼 API 地址、处理 Cookie、派生 key 或启动媒体进程。SourceProvider 提供领域对象；PlaybackSession 决定播放状态与生命周期；MediaBackend 执行可取消处理；View 仅显示公开播放状态。

## 预期目录（尚未创建）

| 目录 | 职责 |
|---|---|
| `src/app` | 启动、依赖装配、路由、窗口生命周期 |
| `src/theme`、`src/ui` | 主题、样式组件、焦点/输入/弹层规范 |
| `src/features/{discover,search,detail,player,library,auth,downloads,settings}` | 页面与各自 store、用例 |
| `src/domain` | Drama/Episode/Source/Session/Job 及错误模型，无 NSH 视图依赖 |
| `src/providers/hongguo` | 网页/App 请求、签名、设备、响应校验，逐端点明确 DTO |
| `src/platform` | 网络、文件、凭证、播放、通知适配器及 capability 探测 |
| `tests/fixtures` | 脱敏的契约和媒体结构 fixture，注明来源/格式 |
| `tools/probes` | 可重复的协议与媒体最小探针 |

若 P0 决定引入原生核心，再增加独立原生目录和绑定；不得把重构后的大 `main.js` 搬到这里。

## 领域对象（应用自定，非上游返回契约）

| 对象 | 必需语义 | 可选字段与约束 |
|---|---|---|
| Drama | 来源 ID、剧 ID、标题 | 封面/简介/总集数/评分/演员/标签可缺失；未提供评分不显示 `0分` |
| Episode | 来源 ID、剧 ID、集 ID、展示集序 | 时长、标题、访问权限；集序必须按已确认契约转换，不能缺失补 0 |
| Page<T> | items、明确的后续分页状态 | 游标是 opaque string；无总数时不造总数 |
| PlaybackVariant | variant ID、集 ID、URL、来源、编码、加密判别、有效期语义 | 宽高/质量/UA/必要请求头；URL/key 仅服务边界内部可见 |
| Encryption | `clear` 或 `cenc` 的判别联合 | cenc 必有验证过的 key handle/元数据；缺 key 不能降为 clear |
| Account | account ID、展示昵称、登录状态 | 凭证引用只在适配器；UI 不接收 Cookie |
| WatchProgress | 剧/集 ID、位置 ms、更新时间、finished | 用户/设备命名空间；未知总时长不能推断已看完 |
| DownloadJob | job ID、剧/集/variant、目标、状态、实际字节 | ETag/校验/重试记录；不能持久化过期媒体 URL 作为永久任务来源 |

所有来源 ID 使用字符串，大整数 JSON 在解析边界保精度；若 NSH JSON.parse 已丢精度，事后 String(number) 无法修复，必须在解析前采用有测试的保整数方案。页面只接应用契约，不继承上游字段别名链。各端点分别验证响应层级和必填项。

SourceProvider 用例：search、detail、episodes、resolvePlayback；discover/filter/rank/calendar、账号读写作为显式 capability。能力缺失与网络失败分开，禁止空数组掩盖未实现。

## 状态与生命周期

每个 store 独占自身状态。搜索状态含 query、filters、cursor、items、requestGeneration、loading/error；切筛选清空游标并取消旧请求，响应只在 generation 匹配时写入。

播放器状态：idle → resolving → preparing → ready/playing ↔ paused/buffering/seeking → ended；任一步可进入 error 或被 cancelled。每次切集递增 sessionGeneration，旧下载、解密、回调、进度事件均不能影响新集。取消后释放请求/临时文件/媒体句柄。seek 由播放器确认后的实际位置更新显示，避免 UI 自报已跳转。

账号状态详见 AUTH。下载独立队列，不随页面销毁；进程退出按可恢复元数据保存，凭证失效不循环重试。

NSH 组件运行一次：动态值在 JSX binding/闭包读取；不解构动态 props；长列表使用 `List`，以领域 ID 为 key，行状态在按 ID 索引的 store，不能附着复用 cell。effects 注册取消与 cleanup。数据请求用 resource 或可取消用例，避免页面中散落 fetch。

## 本地数据和账号隔离

首期存储适配器可用版本化 JSON/NSH Storage（具体 API 待核实）；数据量与事务需求明确后再选 SQLite，不能在 TSX 里假定 npm sqlite 可用。所有文件原子替换并做 schema migration，升级失败保留旧文件。

本地库按 `{sourceId, accountId | guest, dramaId}` 分区；播放器位置额外含 episodeId。游客到登录账号不静默合并，云端同步先读后展示来源。退出停止账号请求并清除凭证，保留/清除本地个人数据策略需在设置中明确；默认保留独立本地历史，不暴露给下一账号。

下载媒体使用应用目录和用户选定目录，清理只针对有记录且身份匹配的临时文件。缓存预算建议初始 512 MB（可配置，需实测调整），播放/下载活动文件不可清除；图片 LRU 与媒体缓存分开。原始 URL、Cookie、手机号、key 不写普通日志。

## 网络与权限

API、CDN、登录跳转逐角色 allowlist；DNS/重定向后再次检查协议、host 和目标 IP，媒体/头像不能访问 localhost 或内网。账号 Cookie 只发往匹配的已验证账号域，不随 CDN 请求传播。动态 CDN 主机必须来自已验证契约并校验域边界，不能使用任意字符串后缀匹配。

若桌面媒体服务采用回环 HTTP：随机端口、绑定 loopback、单会话不可预测令牌、短期资源映射、Range 支持、不提供任意 URL 代理/文件路径/命令接口、退出销毁。NSH capabilities 精确授权该端口/主机；移动端与 Web 不能直接继承本机服务方案。

错误至少区分：网络超时/取消、响应契约错误、登录过期、访问受限、质量不可用、编码不支持、解密失败、播放器失败、磁盘/权限失败。只对可恢复网络请求限次重试；写操作需幂等语义。业务失败不自动切换账号或放低画质。
