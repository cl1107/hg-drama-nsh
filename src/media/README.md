# 桌面 CENC 媒体模块

`cenc.cjs` 供当前 macOS 开发后端调用，NSH UI 仍为 TSX。适配自 `jackotom/hongguo-drama` 固定提交 `782fb21cbddf1be46f88e97af5e788c99e30beae` 的 `src/native/hongguo.js` MP4 sample 遍历思路，按 GPL-3.0-only 保留来源；项目分发需包含相应许可声明。

```js
const { decryptMp4Buffer, decryptMp4File } = require('./cenc.cjs');
const output = decryptMp4Buffer(encryptedBuffer, contentKeyBuffer);
// 不修改输入，返回新 Buffer，文件总长度与 chunk offsets 保持不变。
// 文件接口不覆盖已有文件，创建模式为 0600。
decryptMp4File(sourcePath, newDestinationPath, contentKeyBuffer);
```

支持非碎片 MP4 的 `cenc` / AES-128-CTR、逐 sample 8/16 字节 IV、`senc` 完整 sample/subsample、`stco`/`co64`、AVC/HEVC 与 mp4a sample entry。每个 sample 独立 IV；subsample 的 clear 部分不消耗 CTR 字节流，encrypted 部分连续消费同一 sample 的流。

验证完成后才复制并修改输入；将 sample entry 还原为 `frma` 指定类型，将保护元数据改为等长 `free` box，避免 moov 缩短导致 chunk offset 失效。逐 track/sample 做 mdat 范围和映射验证，不对整文件直接 CTR。

当前明确拒绝：fragmented MP4（moof）、cbcs/pattern、constant IV、seig key rotation、外部 auxiliary 信息但缺 senc、多 sample description、扩展音频 entry、其他编码。不支持项返回 `INVALID_CENC_MP4`，消息给具体原因。模块不鉴别内容 key 是否正确，必须通过实际解码确认。

离线测试：`node --test src/media/cenc.test.cjs`，7 个测试通过。另用本机 FFmpeg 生成 64×64、2fps、1 秒 H.264 标准 CENC 样本，经本模块解密后 `ffmpeg -v error -i clear.mp4 -f null -` 成功解码。该样本是自生成测试图，并非真实片源验证。

当前是完整 Buffer 实现，内存占用随媒体大小增长；调用方应限制下载大小、放在开发后端/worker执行。真实播放是否通过由服务端和播放器的集成验证记录确认。
