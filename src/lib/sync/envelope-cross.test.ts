/**
 * Cross-language envelope proof (task O.2.2 and O.4.1, ephemeral rework in
 * Session 5b) — this direction.
 *
 * `envelope-from-rust.json` is produced by the Rust implementation
 * (`src-tauri/src/envelope.rs`, `write_the_vector_the_typescript_side_opens`)
 * from the same fixed key material. Opening it here proves the two sides agree
 * on the header bytes (including `eph`), the HKDF salt and info, the nonce
 * layout, the wire shape and the AEAD — the one thing a single-language round
 * trip can never show.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fromHex, open } from "./envelope.ts";

const DESKTOP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PHONE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface Vector {
  secret: string;
  peer_public: string;
  pairingId: string;
  wire: string;
}

function readVector(name: string): Vector {
  return JSON.parse(
    readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"),
  ) as Vector;
}

function openVector(vector: Vector, raw = vector.wire) {
  const secretKey = fromHex(vector.secret);
  const peerPublicKey = fromHex(vector.peer_public);
  assert.ok(secretKey && peerPublicKey, "the vector's keys are hex");
  return open({
    secretKey,
    peerPublicKey,
    localDeviceId: PHONE,
    expectedFrom: DESKTOP,
    lastCounter: 0,
    pairingId: vector.pairingId,
    raw,
  });
}

test("an envelope written by the Rust side opens here", () => {
  const opened = openVector(readVector("envelope-from-rust.json"));
  assert.ok(opened.ok, "TypeScript must open what Rust sealed");
  assert.deepEqual(opened.opened.message, { hello: "from rust", n: 1 });
  assert.equal(opened.opened.header.from, DESKTOP);
  assert.equal(opened.opened.header.to, PHONE);
  assert.equal(
    opened.opened.header.eph.length,
    64,
    "the header carries the eph",
  );
});

test("the same bytes altered are refused here too", () => {
  const vector = readVector("envelope-from-rust.json");
  const parsed = JSON.parse(vector.wire) as {
    header: Record<string, string>;
    body: string;
  };
  const flip = (hex: string) =>
    `${hex.slice(0, -2)}${hex.endsWith("00") ? "01" : "00"}`;

  const ciphertext = openVector(
    vector,
    JSON.stringify({ header: parsed.header, body: flip(parsed.body) }),
  );
  assert.equal(ciphertext.ok, false);
  assert.equal(
    ciphertext.ok === false ? ciphertext.reason : "",
    "unauthenticated",
    "a Rust-sealed envelope is tamper-evident on this side as well",
  );

  // The ephemeral key is authenticated and feeds the HKDF, so changing it is a
  // tag failure here too — the two sides must agree on that.
  const ephemeral = openVector(
    vector,
    JSON.stringify({
      header: { ...parsed.header, eph: flip(parsed.header.eph ?? "") },
      body: parsed.body,
    }),
  );
  assert.equal(
    ephemeral.ok === false ? ephemeral.reason : "",
    "unauthenticated",
  );
});

test("the TypeScript-produced vector still opens (the pair stays symmetric)", () => {
  const opened = openVector(readVector("envelope-from-ts.json"));
  assert.ok(opened.ok);
  assert.deepEqual(opened.opened.message, { from: "typescript", n: 1 });
});
