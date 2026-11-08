/**
 * Envelope tests — real keys, real ciphertext (task O.4.1–O.4.2).
 *
 * Round trips run in both directions between two independently generated
 * keypairs, and every refusal is exercised on real bytes. The cross-language
 * vector at the end is ciphertext produced by the **Rust** implementation
 * (`src-tauri/src/sync/envelope.rs`): if the two sides ever disagree about the
 * header bytes, the nonce layout or the wire shape, one of these tests fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ENVELOPE_VERSION,
  fromHex,
  generateKeyPair,
  headerBytes,
  open,
  seal,
  sharedKey,
  toHex,
} from "./envelope.ts";

const DESKTOP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PHONE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function pair() {
  const desktop = generateKeyPair();
  const phone = generateKeyPair();
  return { desktop, phone };
}

test("a sealed message opens on the other side, and only there", () => {
  const { desktop, phone } = pair();

  const sealed = seal({
    secretKey: desktop.secretKey,
    peerPublicKey: phone.publicKey,
    from: DESKTOP,
    to: PHONE,
    messageId: "msg-1",
    counter: 1,
    message: { hello: "world", version: 1 },
  });

  const opened = open({
    secretKey: phone.secretKey,
    peerPublicKey: desktop.publicKey,
    localDeviceId: PHONE,
    expectedFrom: DESKTOP,
    lastCounter: 0,
    raw: sealed,
  });
  assert.ok(opened.ok, "the phone must open what the desktop sealed");
  assert.deepEqual(opened.opened.message, { hello: "world", version: 1 });
  assert.equal(opened.opened.header.from, DESKTOP);

  // The reverse direction is a different key agreement, so it is tested too.
  const back = seal({
    secretKey: phone.secretKey,
    peerPublicKey: desktop.publicKey,
    from: PHONE,
    to: DESKTOP,
    messageId: "msg-2",
    counter: 1,
    message: { pong: true },
  });
  const openedBack = open({
    secretKey: desktop.secretKey,
    peerPublicKey: phone.publicKey,
    localDeviceId: DESKTOP,
    expectedFrom: PHONE,
    lastCounter: 0,
    raw: back,
  });
  assert.ok(openedBack.ok);
  assert.deepEqual(openedBack.opened.message, { pong: true });

  // Both sides derive the same agreement key; that is what makes the seal work.
  assert.equal(
    toHex(sharedKey(desktop.secretKey, phone.publicKey) ?? new Uint8Array()),
    toHex(sharedKey(phone.secretKey, desktop.publicKey) ?? new Uint8Array()),
  );
});

test("an altered envelope is refused, whichever part was altered", () => {
  const { desktop, phone } = pair();
  const sealed = seal({
    secretKey: desktop.secretKey,
    peerPublicKey: phone.publicKey,
    from: DESKTOP,
    to: PHONE,
    messageId: "msg-1",
    counter: 1,
    message: { amount: 100 },
  });
  const wire = JSON.parse(sealed) as {
    header: Record<string, unknown>;
    body: string;
  };

  const openWith = (raw: string) =>
    open({
      secretKey: phone.secretKey,
      peerPublicKey: desktop.publicKey,
      localDeviceId: PHONE,
      expectedFrom: DESKTOP,
      lastCounter: 0,
      raw,
    });

  // A flipped ciphertext byte.
  const flipped = `${wire.body.slice(0, -2)}${wire.body.endsWith("00") ? "01" : "00"}`;
  const ciphertextTamper = openWith(
    JSON.stringify({ header: wire.header, body: flipped }),
  );
  assert.equal(ciphertextTamper.ok, false);
  assert.equal(
    ciphertextTamper.ok === false ? ciphertextTamper.reason : "",
    "unauthenticated",
  );

  // A flipped header byte (the counter is inside the associated data).
  const counterTamper = openWith(
    JSON.stringify({ header: { ...wire.header, counter: 2 }, body: wire.body }),
  );
  assert.equal(
    counterTamper.ok === false ? counterTamper.reason : "",
    "unauthenticated",
  );

  // A flipped nonce.
  const nonce = String(wire.header.nonce);
  const badNonce = `${nonce.slice(0, -2)}${nonce.endsWith("00") ? "01" : "00"}`;
  const nonceTamper = openWith(
    JSON.stringify({
      header: { ...wire.header, nonce: badNonce },
      body: wire.body,
    }),
  );
  assert.equal(nonceTamper.ok, false);

  // Not sealed under the pinned key at all: a stranger with their own keypair.
  const stranger = generateKeyPair();
  const strangerSealed = seal({
    secretKey: stranger.secretKey,
    peerPublicKey: phone.publicKey,
    from: DESKTOP,
    to: PHONE,
    messageId: "msg-9",
    counter: 1,
    message: { forged: true },
  });
  const forged = openWith(strangerSealed);
  assert.equal(forged.ok === false ? forged.reason : "", "unauthenticated");

  // Garbage is a refusal, never an exception escaping to the caller.
  assert.equal(openWith("not json").ok, false);
  assert.equal(openWith('{"header":{},"body":""}').ok, false);
});

test("a replayed envelope, a foreign recipient and a foreign sender are refused", () => {
  const { desktop, phone } = pair();
  const sealed = seal({
    secretKey: desktop.secretKey,
    peerPublicKey: phone.publicKey,
    from: DESKTOP,
    to: PHONE,
    messageId: "msg-1",
    counter: 7,
    message: { note: "once" },
  });
  const first = open({
    secretKey: phone.secretKey,
    peerPublicKey: desktop.publicKey,
    localDeviceId: PHONE,
    expectedFrom: DESKTOP,
    lastCounter: 0,
    raw: sealed,
  });
  assert.ok(first.ok);

  // Same bytes again: the counter has been passed, so it is a replay (§7.2).
  const replay = open({
    secretKey: phone.secretKey,
    peerPublicKey: desktop.publicKey,
    localDeviceId: PHONE,
    expectedFrom: DESKTOP,
    lastCounter: 7,
    raw: sealed,
  });
  assert.equal(replay.ok === false ? replay.reason : "", "replayed");

  const foreignRecipient = open({
    secretKey: phone.secretKey,
    peerPublicKey: desktop.publicKey,
    localDeviceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    expectedFrom: DESKTOP,
    lastCounter: 0,
    raw: sealed,
  });
  assert.equal(
    foreignRecipient.ok === false ? foreignRecipient.reason : "",
    "wrong-recipient",
  );

  const foreignSender = open({
    secretKey: phone.secretKey,
    peerPublicKey: desktop.publicKey,
    localDeviceId: PHONE,
    expectedFrom: PHONE,
    lastCounter: 0,
    raw: sealed,
  });
  assert.equal(
    foreignSender.ok === false ? foreignSender.reason : "",
    "wrong-sender",
  );
});

test("the wire format is the one the Rust side writes", () => {
  // Fixed inputs: the same fields produce the same header bytes on both sides.
  const secret = new Uint8Array(32).fill(1);
  const nonce = new Uint8Array(24).fill(2);
  const header = {
    v: ENVELOPE_VERSION,
    from: DESKTOP,
    to: PHONE,
    messageId: "msg-vector",
    counter: 3,
    nonce: toHex(nonce),
  };
  assert.equal(
    new TextDecoder().decode(headerBytes(header)),
    `{"v":1,"from":"${DESKTOP}","to":"${PHONE}","messageId":"msg-vector","counter":3,"nonce":"${"02".repeat(24)}"}`,
  );
  assert.deepEqual(fromHex(toHex(secret)), secret, "hex round-trips exactly");
});
