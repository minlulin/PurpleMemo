import { strict as assert } from "node:assert";
import { test } from "node:test";

import { at } from "../test-utils.ts";
import {
  b64ToBytes,
  bytesToB64,
  createVaultKey,
  decryptWithKey,
  deriveVaultKey,
  encryptWithKey,
  hashAnswer,
  hashPin,
  normalizeAnswer,
  PBKDF2_ITERATIONS,
  verifyAnswer,
  verifyPin,
} from "./crypto.ts";

test("PBKDF2 runs at 600k iterations", () => {
  assert.equal(PBKDF2_ITERATIONS, 600_000);
});

test("base64 helpers roundtrip arbitrary bytes", () => {
  const bytes = new Uint8Array([0, 1, 2, 127, 128, 200, 254, 255]);
  assert.deepEqual([...b64ToBytes(bytesToB64(bytes))], [...bytes]);
});

test("b64ToBytes refuses anything that is not canonical base64 (H2)", () => {
  // `atob`'s forgiving algorithm DROPS ASCII whitespace, so "   " used to
  // decode to zero bytes — a salt that leaves PBKDF2 running UNSALTED — and it
  // accepts a missing pad, so several distinct strings decoded to the same
  // bytes. The refusal has `atob`'s own error name, so callers that recognise
  // a decode failure by name keep working, but the message says what is wrong.
  const bad = [
    "   ", // whitespace only: zero bytes, not a salt
    "AAEC Aw=", // embedded whitespace (and the pad it hides)
    "***", // not the base64 alphabet
    "AAECAwQFBgcICQoLDA0ODw", // padding stripped
    "AAAA====", // over-padded
    "AAECAw=Q", // pad in the middle
    "A", // length is not a multiple of 4
  ];
  for (const value of bad) {
    assert.throws(
      () => b64ToBytes(value),
      { name: "InvalidCharacterError" },
      JSON.stringify(value),
    );
  }
  // Canonical input still decodes — including the empty string, which really
  // is the encoding of zero bytes (a too-short value is caught by the
  // byte-length check at the call site, not by the decoder).
  assert.equal(b64ToBytes("").length, 0);
  assert.equal(b64ToBytes(bytesToB64(new Uint8Array(16))).length, 16);
});

test("hashPin/verifyPin roundtrip; wrong PIN fails", async () => {
  const stored = await hashPin("123456");
  assert.equal(stored.iterations, PBKDF2_ITERATIONS);
  assert.notEqual(stored.salt, "");
  assert.equal(await verifyPin("123456", stored), true);
  assert.equal(await verifyPin("654321", stored), false);
});

test("same PIN gets a different salt+hash each time", async () => {
  const a = await hashPin("hunter2");
  const b = await hashPin("hunter2");
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
});

test("security answers normalize case and whitespace", () => {
  assert.equal(normalizeAnswer("  Yangon "), "yangon");
  assert.equal(normalizeAnswer("New   York"), "new york");
});

test("verifyAnswer compares through the normalized form", async () => {
  const stored = await hashAnswer("  Purple  Memo ");
  assert.equal(await verifyAnswer("purple memo", stored), true);
  assert.equal(await verifyAnswer("Purple Memo", stored), true);
  assert.equal(await verifyAnswer("purple  memo", stored), true);
  assert.equal(await verifyAnswer("purple", stored), false);
});

test("PINs stay exact — no normalization at verify time", async () => {
  const stored = await hashPin("Secret1");
  assert.equal(await verifyPin("secret1", stored), false);
  assert.equal(await verifyPin(" Secret1 ", stored), false);
  assert.equal(await verifyPin("Secret1", stored), true);
});

test("vault key derivation is deterministic for password+salt", async () => {
  const { key, salt } = await createVaultKey("vault-pass");
  const again = await deriveVaultKey("vault-pass", salt);
  const cipher = await encryptWithKey(key, "secret note");
  const plain = await decryptWithKey(again, cipher);
  assert.equal(plain, "secret note");
});

test("vault items encrypt with per-item IVs — same plaintext differs", async () => {
  const { key } = await createVaultKey("pw");
  const a = await encryptWithKey(key, "same text");
  const b = await encryptWithKey(key, "same text");
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.equal(await decryptWithKey(key, a), "same text");
  assert.equal(await decryptWithKey(key, b), "same text");
});

test("vault decryption fails on a wrong password (no recovery)", async () => {
  const { key, salt } = await createVaultKey("right");
  const cipher = await encryptWithKey(key, "secret");
  const wrongKey = await deriveVaultKey("wrong", salt);
  await assert.rejects(decryptWithKey(wrongKey, cipher));
});

test("vault decryption fails on tampered ciphertext (GCM auth tag)", async () => {
  const { key } = await createVaultKey("pw");
  const cipher = await encryptWithKey(key, "secret");
  const tamperedBytes = b64ToBytes(cipher.ciphertext);
  tamperedBytes[0] = at(tamperedBytes, 0, "tamperedBytes") ^ 0xff;
  await assert.rejects(
    decryptWithKey(key, {
      ciphertext: bytesToB64(tamperedBytes),
      iv: cipher.iv,
    }),
  );
});
