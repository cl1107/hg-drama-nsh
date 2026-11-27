import { Buffer } from "buffer";
import { createHash } from "crypto";
import { gzipSync } from "zlib";
import { expect, test } from "nsh/test";
import { NativeCrypto } from "hg-drama/native";
import { sm3 } from "./sm3";
import { signPlayer } from "./signature";
import { signPlaybackV5 } from "./v5";
import {
  decryptSpadeUrl,
  deriveContentKeyHex,
  parsePlayModelVariants,
  resetResolverStrategy,
  resolveEpisodeVariants,
  resolverDiagnostics,
  type UpstreamTransport,
} from "./index";

const URL_KDF_SALT = Buffer.from(
  "4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58",
  "hex",
);

test("ByteVC2 selection follows decoder availability and preserves same-quality compatible sources", () => {
  const model = { video_list: {
    bytevc2: { codec_type: "bytevc2", definition: "1080p", vwidth: 1080, vheight: 1920, encrypt: false, main_url: "https://v1.fqnovelvod.com/direct.mp4" },
    hevc: { codec_type: "h265", definition: "1080p", vwidth: 1080, vheight: 1920, encrypt: false, main_url: "https://v1.fqnovelvod.com/compatible.mp4" },
  } };
  expect(parsePlayModelVariants(model, "1080p", true, true).map(item => item.codec)).toEqual(["bytevc2", "hevc"]);
  expect(parsePlayModelVariants(model, "1080p", true, false).map(item => item.codec)).toEqual(["hevc"]);
  expect(() => parsePlayModelVariants({ video_list: { bytevc2: model.video_list.bytevc2 } }, "1080p", true, false)).toThrow();
});

test("SM3 matches GB/T 32905 standard test vector for 'abc'", () => {
  expect(sm3("abc").toString("hex")).toBe(
    "66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0",
  );
});

test("parses a spade URL using the decoded key_seed bytes", () => {
  const seed = Buffer.from("test-seed-123", "utf8");
  const plainUrl = "https://v1.fqnovelvod.com/sample/test.mp4";
  const h1 = createHash("sha512").update(seed).digest();
  const h2 = createHash("sha512").update(Buffer.concat([h1, URL_KDF_SALT])).digest();
  const encrypted = Buffer.from(
    NativeCrypto.aes128CbcEncrypt(h2.subarray(0, 16), h2.subarray(16, 32), Buffer.from(plainUrl, "utf8"), true),
  );
  const envelope = Buffer.concat([Buffer.from([0xa8, 0x00, 0x01, 0x00]), encrypted]).toString("base64");
  expect(decryptSpadeUrl(envelope, seed)).toBe(plainUrl);
  const variants = parsePlayModelVariants({
    key_seed: seed.toString("base64"),
    video_list: {
      video_1: {
        codec_type: "h265",
        definition: "1080p",
        encrypt: false,
        main_url: envelope,
      },
    },
  });
  expect(variants.map(({ url, codec }) => ({ url, codec }))).toEqual([{ url: plainUrl, codec: "hevc" }]);
});

test("signPlayer and signPlaybackV5 produce valid signature headers", () => {
  const legacy = signPlayer({
    query: "aid=8662&device_id=123456&version_name=7.1.3.32",
    body: Buffer.from("payload"),
    ts: 1700000000,
    randField: 42,
    ladonRandom: Buffer.from([1, 2, 3, 4]),
  });
  expect(legacy["x-khronos"]).toBe("1700000000");
  expect(legacy["x-argus"].length).toBeGreaterThan(20);
  expect(legacy["x-ladon"].length).toBeGreaterThan(10);
  expect(legacy["x-ss-stub"]).toMatch(/^[a-f0-9]{32}$/);

  const gz = gzipSync(Buffer.from(JSON.stringify({ ok: true })));
  const v5 = signPlaybackV5({
    base: "https://api5-normal-sinfonlineb.fqnovel.com/novel/player/multi_video_model/player/v1",
    values: {
      aid: "8662",
      device_id: "1234567890",
      iid: "9876543210",
      cdid: "11111111-1111-1111-1111-111111111111",
      version_name: "7.4.3.32",
      channel: "vivo_8662_64",
      os_version: "12",
      device_type: "PGT-AN10",
      ts: "1700000000",
    },
    body: gz,
    now: 1700000000000,
  });
  expect(v5.headers["x-medusa"].length).toBeGreaterThan(40);
  expect(v5.headers["x-helios"].length).toBeGreaterThan(10);
  expect(v5.headers["x-ss-stub"]).toMatch(/^[A-F0-9]{32}$/);
});

test("resolveEpisodeVariants registers device, races routes, and parses clear variants", async () => {
  resetResolverStrategy(true);
  const seenUrls: string[] = [];
  const transport: UpstreamTransport = async (req) => {
    seenUrls.push(req.url);
    if (req.url.includes("device_register")) {
      return {
        status: 200,
        headers: {},
        body: Buffer.from(JSON.stringify({ device_id_str: "123456789012", install_id_str: "987654321098" })),
      };
    }
    if (req.url.includes("video_tab")) {
      return {
        status: 200,
        headers: {},
        body: Buffer.from(
          JSON.stringify({
            code: 0,
            data: {
              "1004": {
                "7503780574541122622": {
                  video_model: JSON.stringify({
                    video_list: {
                      v1: {
                        codec_type: "h264",
                        vwidth: 1080,
                        vheight: 1920,
                        encrypt: false,
                        main_url: "https://v1.fqnovelvod.com/clear-1080p.mp4",
                      },
                    },
                  }),
                },
              },
            },
          }),
        ),
      };
    }
    return { status: 200, headers: {}, body: Buffer.alloc(0) };
  };

  const variants = await resolveEpisodeVariants("7503780574541122622", "auto", { transport });
  expect(variants.length).toBe(1);
  expect(variants[0].codec).toBe("h264");
  expect(variants[0].quality).toBe("1080p");
  expect(variants[0].url).toBe("https://v1.fqnovelvod.com/clear-1080p.mp4");
  expect(seenUrls.some((u) => u.includes("device_register"))).toBe(true);
  expect(resolverDiagnostics().activeStrategy.mode).toBe("tab");
  expect(resolverDiagnostics().healCount).toBeGreaterThan(0);
});

test("resolveEpisodeVariants supports single-episode video_model/v1/ and remembers active strategy", async () => {
  resetResolverStrategy(true);
  const seenUrls: string[] = [];
  const transport: UpstreamTransport = async (req) => {
    seenUrls.push(req.url);
    if (req.url.includes("device_register")) {
      return {
        status: 200,
        headers: {},
        body: Buffer.from(JSON.stringify({ device_id_str: "123456789012", install_id_str: "987654321098" })),
      };
    }
    if (req.url.includes("/novel/player/video_model/v1/") && req.url.includes("api5-normal-sinfonlineb")) {
      return {
        status: 200,
        headers: {},
        body: Buffer.from(
          JSON.stringify({
            code: 0,
            data: {
              video_model: JSON.stringify({
                video_list: [
                  {
                    video_meta: { codec_type: "bytevc1", definition: "1080p", vwidth: 1080, vheight: 1920 },
                    encrypt_info: { encrypt: false },
                    main_url: Buffer.from("https://v1.fqnovelvod.com/single-1080p.mp4", "utf8").toString("base64"),
                  },
                ],
              }),
            },
          }),
        ),
      };
    }
    return { status: 200, headers: {}, body: Buffer.alloc(0) };
  };

  const first = await resolveEpisodeVariants("7503780574541122622", "auto", { transport });
  expect(first.length).toBe(1);
  expect(first[0].codec).toBe("hevc");
  expect(first[0].url).toBe("https://v1.fqnovelvod.com/single-1080p.mp4");
  expect(resolverDiagnostics().activeStrategy.host).toBe("api5-normal-sinfonlineb.fqnovel.com");

  const callsBeforeSecond = seenUrls.length;
  const second = await resolveEpisodeVariants("7503780574541122622", "auto", { transport });
  expect(second[0].url).toBe("https://v1.fqnovelvod.com/single-1080p.mp4");
  // Second call should hit remembered strategy immediately in the fast wave (<=2 requests).
  expect(seenUrls.length - callsBeforeSecond).toBeLessThanOrEqual(2);
});

test("resolveEpisodeVariants prefers preload/v1 and negotiates fallback_api on bytevc2-only models", async () => {
  resetResolverStrategy(true);
  const seenUrls: string[] = [];
  const transport: UpstreamTransport = async (req) => {
    seenUrls.push(req.url);
    if (req.url.includes("device_register")) {
      return {
        status: 200,
        headers: {},
        body: Buffer.from(JSON.stringify({ device_id_str: "123456789012", install_id_str: "987654321098" })),
      };
    }
    if (req.url.includes("/novel/player/multi_video_model/preload/v1")) {
      return {
        status: 200,
        headers: {},
        body: Buffer.from(
          JSON.stringify({
            code: 0,
            data: {
              "1004": {
                "7503780574541122622": {
                  video_model: JSON.stringify({
                    fallback_api: JSON.stringify({ fallback_api: "https://vas.fqnovel.com/video/fplay?codec_type=4" }),
                    video_list: {
                      v1: {
                        codec_type: "bytevc2",
                        vwidth: 1080,
                        vheight: 1920,
                        encrypt: false,
                        main_url: "https://v1.fqnovelvod.com/only-bytevc2.mp4",
                      },
                    },
                  }),
                },
              },
            },
          }),
        ),
      };
    }
    if (req.url.includes("vas.fqnovel.com/video/fplay") && req.url.includes("codec_type=1")) {
      return {
        status: 200,
        headers: {},
        body: Buffer.from(
          JSON.stringify({
            video_info: {
              data: {
                video_list: {
                  video_1: {
                    codec_type: "h265",
                    vwidth: 1080,
                    vheight: 1920,
                    encrypt: false,
                    main_url: "https://v1.fqnovelvod.com/negotiated-hevc.mp4",
                  },
                },
              },
            },
          }),
        ),
      };
    }
    return { status: 200, headers: {}, body: Buffer.alloc(0) };
  };

  const variants = await resolveEpisodeVariants("7503780574541122622", "auto", { transport, allowBytevc2: false });
  expect(variants.length).toBe(1);
  expect(variants[0].codec).toBe("hevc");
  expect(variants[0].url).toBe("https://v1.fqnovelvod.com/negotiated-hevc.mp4");
  expect(seenUrls.some((u) => u.includes("/novel/player/multi_video_model/preload/v1"))).toBe(true);
  expect(seenUrls.some((u) => u.includes("codec_type=1"))).toBe(true);
});

test("parsePlayModelVariants rejects missing encryption metadata and short spade", () => {
  expect(() => deriveContentKeyHex("AA==")).toThrow();
  expect(() =>
    parsePlayModelVariants(
      {
        video_list: {
          v1: {
            codec_type: "h264",
            vwidth: 1080,
            vheight: 1920,
            main_url: "https://v1.fqnovelvod.com/missing-key.mp4",
          },
        },
      },
      "auto",
      true,
    ),
  ).toThrow();
});
