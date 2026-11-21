---
name: hg-playback-debug
description: 红果短剧 NSH 客户端取源、签名、CENC 解密与播放故障排查和修复规范。当在线播放/下载出现 EMPTY_RESPONSE、INVALID_RESPONSE、NO_COMPATIBLE_SOURCE、MEDIA_HTTP 或上游接口变更时使用。
---

# 红果短剧播放取源排查与修复

用于定位和修复本仓库（`hg-drama-nsh`）的正片取源、协议签名、媒体下载与 CENC 解密问题。

## 1. 核心链路与文件定位

1. **分集目录**：`service/playback.cjs` `details(seriesId)`
   - 请求 `https://hongguoduanju.com/player/${seriesId}`，通过 `src/providers/catalog.ts` `routerData()` 读取 `loaderData['player_(series_id)/page'].seriesDetail.vid_list`。
2. **匿名设备身份**：`service/vendor/hongguo/playback-device.js`
   - `getPlaybackDevice(requestJson)`：进程内懒注册并复用匿名设备（`device_id`、`iid`、`cdid`），带 10 秒失败冷却。
   - `registerPlaybackDevice(requestJson, { signal })`：仅在需要强制换设备时调用（带 8 秒超时，勿在每次取源无条件重注册，否则易触发上游同步延迟/空响应）。
3. **取源与签名调度**：`service/vendor/hongguo/app-source.js` `fetchAppPlayUrlFresh(vid, options)`
   - **主协议（v5）**：`POST /novel/player/multi_video_model/player/v1`，使用 `playback-v5.js` `signPlaybackV5`（`7.4.3.32` / `PGT-AN10` / gzip body）。
   - **官方主机池 `PLAYER_HOSTS`**：
     - `api5-normal-sinfonlineb.fqnovel.com`
     - `api5-normal-sinfonlinea.fqnovel.com`
     - `api5-normal-sinfonlinec.fqnovel.com`
     - `api5-normal.fqnovel.com`
     - `api3-normal.fqnovel.com`
   - **旧协议回退**：`POST /novel/player/multi_video_model/v1/`，使用 `playback-signature.js` `signPlayer`（仅在主协议全部主机返回 `EMPTY_RESPONSE` 且换设备重试仍空时回退）。
4. **密钥派生与 URL 解密**：`app-source.js` `parseAppPlayModel()`
   - `spade_a` → `deriveContentKey()` → 16 字节 CENC `contentKey`。
   - `key_seed` → `decryptSpadeUrl()` → 还原真实 CDN URL（仅允许 `qznovelvod.com` / `fqnovelvod.com` / `douyinvod.com`）。
   - 严格区分编码：`h264` / `hevc`（含 `bytevc1`）可用，`bytevc2` 不支持，无兼容编码时明确报 `NO_COMPATIBLE_SOURCE`。
5. **媒体下载与解密**：`service/playback.cjs` `prepare()` + `src/media/cenc.cjs` `decryptMp4Buffer()`
   - 同清晰度优先 `h264`，若某个 `variant` 返回 `MEDIA_HTTP` 或空响应，顺延尝试 `ordered` 列表中的下一个可用 `variant`。
6. **本机播放服务**：`service/server.cjs`（`/play`、`GET /media/:token` Range `206`）与前端 `src/features/player/session.ts`、`GlobalPlayer.tsx`。

## 2. 常见故障排查命令

先用命令行直接验证服务端取源，区分是**上游取源问题**还是**前端播放器问题**：

```bash
# 1. 测试单集取源、下载与解密（Node 24+）
node -e '
const pb = require("./service/playback.cjs");
pb.details("7503745441910017049").then(d => {
  console.log("detail:", d.title, "eps:", d.episodes.length);
  return pb.prepare({ seriesId: d.seriesId, episodeId: d.episodes[0].episodeId });
}).then(r => console.log("OK:", r.codec, r.quality, "encrypted:", r.encrypted, "bytes:", r.data.length))
.catch(e => { console.error("ERR:", e.code, e.message); process.exitCode = 1; });
'
```

```bash
# 2. 对当前热播榜前 5 部剧批量回归（确认非单剧问题）
node -e '
const disc = require("./service/discover.cjs");
const pb = require("./service/playback.cjs");
(async () => {
  const rank = await disc.browseRank({ outerTab: "all", subTab: "ranklist_hot_play_sc", limit: 5 });
  for (const item of rank.items) {
    try {
      const d = await pb.details(item.id);
      const r = await pb.prepare({ seriesId: item.id, episodeId: d.episodes[0]?.episodeId });
      console.log("OK:", item.title, r.codec, r.quality, r.data.length);
    } catch (e) {
      console.log("FAIL:", item.title, e.code, e.message);
    }
  }
})();
'
```

## 3. 常见错误码与处置原则

| 错误码 | 常见原因 | 正确处置 |
|---|---|---|
| `EMPTY_RESPONSE` | 上游返回 HTTP 200 空包（节点抖动、单设备限流、接口升级） | 先确认 `getPlaybackDevice` 复用正常；依次轮询 `PLAYER_HOSTS`；必要时换设备重注册一次；仍失败再查上游接口/参数是否变更（如对比新版本 `multi_video_model` 参数）。**禁止**无限重试或静默跳过校验。 |
| `DEVICE_REGISTRATION_FAILED` | 设备注册接口失败或进入 10s 冷却 | 检查 `playback-device.js` 注册体与网络；尊重 `403`/`429`/`BUSINESS_REJECTED` 熔断，不要绕过冷却风暴重试。 |
| `INVALID_RESPONSE` / `MISSING_MODEL` | 响应 JSON 结构变化（如 `data['1004']` vs `data[vid]`）或 `spade_a` 缺失 | 打印脱敏后的顶层 key 核对路径（勿将真实 URL/key 写入仓库文档）。 |
| `NO_COMPATIBLE_SOURCE` | 仅返回 `bytevc2` 或无可用编码 | 检查请求 `biz_param`（如 `need_all_video_definition: true`）；若确实仅 ByteVC2，按规范报错提示，勿强行送入 AVPlayer。 |
| `MEDIA_HTTP` | 某个 CDN 节点返回 403/404/超时 | 确认 `prepare()` 按 `ordered` 尝试备用 `variant`；检查 `User-Agent` 与请求头是否与取源时一致。 |

## 4. 安全与合规红线

- **严禁**放宽媒体域名白名单（仅限 `qznovelvod.com`、`fqnovelvod.com`、`douyinvod.com`）。
- **严禁**用官网 10 秒公开预览 MP4 冒充正片。
- **严禁**把登录 Cookie、设备密钥或真实 CDN URL 写入源码/测试/文档。
- 每次修改后必须跑通：
  1. `node --test service/*.test.cjs service/vendor/hongguo/*.test.cjs`
  2. `./tools/nsh check && ./tools/nsh test App.test.tsx && ./tools/nsh test src/features/player/session.test.tsx`
  3. 至少 3 部在线热播剧真实 `prepare()` 验证。
