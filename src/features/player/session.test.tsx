import { expect, test } from "nsh/test";
import { parsePlayback } from "./session";
const base = "http://127.0.0.1:18792";
const valid = { seriesId: "123", title: "测试剧", episode: { episodeId: "456", index: 1 }, episodes: [{ episodeId: "456", index: 1 }], codec: "hevc", quality: "1080p", encrypted: true, mediaUrl: base + "/media/" + "a".repeat(64) };
test("accepts only the selected series and episode at the local media session", () => {
 expect(parsePlayback(valid, base, "123", "456").episode.index).toBe(1);
 expect(() => parsePlayback(valid,base,"124")).toThrow();
 expect(() => parsePlayback(valid,base,"123","457")).toThrow();
 expect(() => parsePlayback({...valid,mediaUrl:"https://evil.test/media/"+"a".repeat(64)},base,"123")).toThrow();
 expect(() => parsePlayback({...valid,mediaUrl:base+"/media/file.mp4"},base,"123")).toThrow();
 expect(() => parsePlayback({...valid,episode:{episodeId:"456",index:0}},base,"123")).toThrow();
});
