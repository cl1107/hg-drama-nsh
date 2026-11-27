import { expect, test } from "nsh/test";
import { NativeVideo } from "hg-drama/native";
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

test("ByteVC2 sessions require the installed native decoder and keep their codec", () => {
 const direct = {...valid,codec:"bytevc2"};
 if (NativeVideo.bytevc2Available()) {
  expect(parsePlayback(direct,base,"123","456").codec).toBe("bytevc2");
 } else {
  expect(() => parsePlayback(direct,base,"123","456")).toThrow();
 }
 expect(() => parsePlayback({...valid,codec:"unknown"},base,"123","456")).toThrow();
});
