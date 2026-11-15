import { expect, test } from "nsh/test";
import { createHash } from "crypto";
import { Buffer } from "buffer";

test("SHA-512 matches the published abc vector", () => {
  expect(createHash("sha512").update("abc").digest("hex")).toBe("ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f");
});

test("AES-CTR decrypts NIST SP800-38A vector", async () => {
  const key = await crypto.subtle.importKey("raw", Buffer.from("2b7e151628aed2a6abf7158809cf4f3c", "hex"), { name: "AES-CTR" }, false, ["decrypt"]);
  const clear = await crypto.subtle.decrypt({ name: "AES-CTR", counter: Buffer.from("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff", "hex"), length: 128 }, key, Buffer.from("874d6191b620e3261bef6864990db6ce", "hex"));
  expect(Buffer.from(clear).toString("hex")).toBe("6bc1bee22e409f96e93d7e117393172a");
});
