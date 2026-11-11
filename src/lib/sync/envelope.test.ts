/**
 * Envelope tests — real keys, real ciphertext (tasks O.4.1–O.4.2, ephemeral
 * rework in Session 5b).
 *
 * Round trips run in both directions between two independently generated
 * keypairs, every refusal is exercised on real bytes, and the vector writer at
 * the end produces the file the Rust suite opens. If the two sides ever
 * disagree about the header bytes (now including `eph`), the HKDF salt or info,
 * the nonce layout or the wire shape, one of these tests fails.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import {
  ENVELOPE_VERSION,
  fromHex,
  generateKeyPair,
  headerBytes,
  KEY_BYTES,
  open,
  openKey,
  publicKeyOf,
  seal,
  sealKey,
  toHex,
} from "./envelope.ts";

const DESKTOP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PHONE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PAIRING = "pair-1";

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
    pairingId: PAIRING,
  });

  const opened = open({
    secretKey: phone.secretKey,
    peerPublicKey: desktop.publicKey,
    localDeviceId: PHONE,
    expectedFrom: DESKTOP,
    lastCounter: 0,
    pairingId: PAIRING,
    raw: sealed,
  });
  assert.ok(opened.ok, "the phone must open what the desktop sealed");
  assert.deepEqual(opened.opened.message, { hello: "world", version: 1 });
  assert.equal(opened.opened.header.from, DESKTOP);

  // The reverse direction is a different pairing of keys, so it is tested too.
  const back = seal({
    secretKey: phone.secretKey,
    peerPublicKey: desktop.publicKey,
    from: PHONE,
    to: DESKTOP,
    messageId: "msg-2",
    counter: 1,
    message: { pong: true },
    pairingId: PAIRING,
  });
  const openedBack = open({
    secretKey: desktop.secretKey,
    peerPublicKey: phone.publicKey,
    localDeviceId: DESKTOP,
    expectedFrom: PHONE,
    lastCounter: 0,
    pairingId: PAIRING,
    raw: back,
  });
  assert.ok(openedBack.ok);
  assert.deepEqual(openedBack.opened.message, { pong: true });
});

test("both sides derive the same message key from the ephemeral and static agreements", () => {
  const { desktop, phone } = pair();
  const ephemeral = generateKeyPair();
  const sender = sealKey(
    desktop.secretKey,
    phone.publicKey,
    ephemeral.secretKey,
    DESKTOP,
    PHONE,
    PAIRING,
  );
  const receiver = openKey(
    phone.secretKey,
    desktop.publicKey,
    ephemeral.publicKey,
    DESKTOP,
    PHONE,
    PAIRING,
  );
  assert.ok(sender && receiver, "both sides must derive a key");
  assert.equal(toHex(sender), toHex(receiver));
  assert.equal(sender.length, KEY_BYTES);
});

test("a fresh ephemeral key means a fresh message key, even with one nonce", () => {
  const { desktop, phone } = pair();
  const nonce = new Uint8Array(24).fill(7);
  const sealOnce = () =>
    seal({
      secretKey: desktop.secretKey,
      peerPublicKey: phone.publicKey,
      from: DESKTOP,
      to: PHONE,
      messageId: "msg-1",
      counter: 1,
      message: { same: "message" },
      pairingId: PAIRING,
      nonce,
    });
  const first = sealOnce();
  const second = sealOnce();
  assert.notEqual(first, second, "a reused key would repeat the ciphertext");
  for (const wire of [first, second]) {
    const opened = open({
      secretKey: phone.secretKey,
      peerPublicKey: desktop.publicKey,
      localDeviceId: PHONE,
      expectedFrom: DESKTOP,
      lastCounter: 0,
      pairingId: PAIRING,
      raw: wire,
    });
    assert.ok(opened.ok, "a fresh ephemeral key must still open");
  }
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
    pairingId: PAIRING,
  });
  const wire = JSON.parse(sealed) as {
    header: Record<string, unknown>;
    body: string;
  };

  const openWith = (raw: string, pairingId = PAIRING) =>
    open({
      secretKey: phone.secretKey,
      peerPublicKey: desktop.publicKey,
      localDeviceId: PHONE,
      expectedFrom: DESKTOP,
      lastCounter: 0,
      pairingId,
      raw,
    });
  const flip = (hex: string) =>
    `${hex.slice(0, -2)}${hex.endsWith("00") ? "01" : "00"}`;

  // A flipped ciphertext byte.
  const ciphertextTamper = openWith(
    JSON.stringify({ header: wire.header, body: flip(wire.body) }),
  );
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

  // A flipped nonce: it is both the AAD and the cipher's IV.
  const nonceTamper = openWith(
    JSON.stringify({
      header: { ...wire.header, nonce: flip(String(wire.header.nonce)) },
      body: wire.body,
    }),
  );
  assert.equal(nonceTamper.ok, false);

  // A forged ephemeral key: it feeds the HKDF, so the tag must fail.
  const ephTamper = openWith(
    JSON.stringify({
      header: { ...wire.header, eph: flip(String(wire.header.eph)) },
      body: wire.body,
    }),
  );
  assert.equal(
    ephTamper.ok === false ? ephTamper.reason : "",
    "unauthenticated",
    "a forged ephemeral key must be refused, not used",
  );

  // An ephemeral key that is not 32 bytes is malformed, not a tag failure.
  const shortEph = openWith(
    JSON.stringify({
      header: { ...wire.header, eph: "0011" },
      body: wire.body,
    }),
  );
  assert.equal(shortEph.ok === false ? shortEph.reason : "", "malformed");

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
    pairingId: PAIRING,
  });
  const forged = openWith(strangerSealed);
  assert.equal(forged.ok === false ? forged.reason : "", "unauthenticated");

  // The pairing id is part of the derived key.
  const otherPairing = openWith(sealed, "pair-2");
  assert.equal(
    otherPairing.ok === false ? otherPairing.reason : "",
    "unauthenticated",
  );

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
    pairingId: PAIRING,
  });
  const first = open({
    secretKey: phone.secretKey,
    peerPublicKey: desktop.publicKey,
    localDeviceId: PHONE,
    expectedFrom: DESKTOP,
    lastCounter: 0,
    pairingId: PAIRING,
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
    pairingId: PAIRING,
    raw: sealed,
  });
  assert.equal(replay.ok === false ? replay.reason : "", "replayed");

  const foreignRecipient = open({
    secretKey: phone.secretKey,
    peerPublicKey: desktop.publicKey,
    localDeviceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    expectedFrom: DESKTOP,
    lastCounter: 0,
    pairingId: PAIRING,
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
    pairingId: PAIRING,
    raw: sealed,
  });
  assert.equal(
    foreignSender.ok === false ? foreignSender.reason : "",
    "wrong-sender",
  );
});

test("the wire format is the one the Rust side writes", () => {
  // Fixed inputs: the same fields produce the same header bytes on both sides.
  const nonce = new Uint8Array(24).fill(2);
  const eph = new Uint8Array(32).fill(3);
  const header = {
    v: ENVELOPE_VERSION,
    from: DESKTOP,
    to: PHONE,
    messageId: "msg-vector",
    counter: 3,
    nonce: toHex(nonce),
    eph: toHex(eph),
  };
  assert.equal(
    new TextDecoder().decode(headerBytes(header)),
    `{"v":1,"from":"${DESKTOP}","to":"${PHONE}","messageId":"msg-vector","counter":3,"nonce":"${"02".repeat(24)}","eph":"${"03".repeat(32)}"}`,
  );
  assert.deepEqual(fromHex(toHex(eph)), eph, "hex round-trips exactly");
});

/**
 * N11: one spelling of hex and one shape for the wire, so this side and
 * `src-tauri/src/envelope.rs` give the same bytes the same verdict. Rust used
 * to accept `A-F` here and this side always refused them, so an envelope could
 * be "malformed" on the phone and openable on the desktop.
 */
test("only lowercase hex in exactly two wire fields is accepted", () => {
  const { desktop, phone } = pair();
  const sealed = seal({
    secretKey: desktop.secretKey,
    peerPublicKey: phone.publicKey,
    from: DESKTOP,
    to: PHONE,
    messageId: "msg-1",
    counter: 1,
    message: { shape: "one" },
    pairingId: PAIRING,
  });
  const wire = JSON.parse(sealed) as {
    header: Record<string, unknown>;
    body: string;
  };
  const refusal = (raw: string) => {
    const result = open({
      secretKey: phone.secretKey,
      peerPublicKey: desktop.publicKey,
      localDeviceId: PHONE,
      expectedFrom: DESKTOP,
      lastCounter: 0,
      pairingId: PAIRING,
      raw,
    });
    return result.ok ? "" : result.reason;
  };

  assert.equal(refusal(sealed), "", "the honest wire still opens");
  assert.equal(fromHex("00FF10"), null, "upper-case hex is not this wire's");

  assert.equal(
    refusal(
      JSON.stringify({ header: wire.header, body: wire.body.toUpperCase() }),
    ),
    "malformed",
    "an upper-case body is hex this format does not speak",
  );
  for (const field of ["nonce", "eph"] as const) {
    const upper = {
      ...wire.header,
      [field]: String(wire.header[field]).toUpperCase(),
    };
    assert.equal(
      refusal(JSON.stringify({ header: upper, body: wire.body })),
      "malformed",
      `${field} in upper-case hex`,
    );
  }

  // The associated data is the header alone, so an injected key is
  // unauthenticated: refused, never ignored.
  assert.equal(
    refusal(JSON.stringify({ ...wire, extra: 1 })),
    "malformed",
    "an extra field on the wire",
  );
  assert.equal(
    refusal(
      JSON.stringify({ header: { ...wire.header, extra: 1 }, body: wire.body }),
    ),
    "malformed",
    "an extra field in the header",
  );
  const withoutEph = { ...wire.header };
  delete withoutEph.eph;
  assert.equal(
    refusal(JSON.stringify({ header: withoutEph, body: wire.body })),
    "malformed",
    "a missing header field",
  );
});

/**
 * A counter is a `u64` on the Rust side. A fraction fails its deserialization
 * and anything above `2^53 - 1` rounds in `JSON.parse`, which would make
 * `headerBytes` authenticate a different integer than the peer sealed.
 */
test("a counter that is not a safe positive integer is refused", () => {
  const { desktop, phone } = pair();
  const sealed = seal({
    secretKey: desktop.secretKey,
    peerPublicKey: phone.publicKey,
    from: DESKTOP,
    to: PHONE,
    messageId: "msg-1",
    counter: 1,
    message: { once: true },
    pairingId: PAIRING,
  });
  const wire = JSON.parse(sealed) as {
    header: Record<string, unknown>;
    body: string;
  };
  const refusalFor = (counter: unknown) => {
    const result = open({
      secretKey: phone.secretKey,
      peerPublicKey: desktop.publicKey,
      localDeviceId: PHONE,
      expectedFrom: DESKTOP,
      lastCounter: 0,
      pairingId: PAIRING,
      raw: JSON.stringify({
        header: { ...wire.header, counter },
        body: wire.body,
      }),
    });
    return result.ok ? "" : result.reason;
  };

  for (const counter of [0.5, 0, -1, 2 ** 53, 2 ** 53 + 2, "3", null, true]) {
    assert.equal(
      refusalFor(counter),
      "malformed",
      `counter ${String(counter)} is not a u64`,
    );
  }
  // A well-formed counter is still refused by the tag, not by the parser: the
  // strictness above did not start refusing real envelopes.
  assert.equal(refusalFor(2), "unauthenticated");
});

/**
 * Cross-language proof, this direction: this test writes the vector the Rust
 * suite opens (`an_envelope_written_by_the_typescript_side_opens_here`).
 *
 * Fixed secrets, nonce and ephemeral secret, so the file is byte-for-byte the
 * same on every run; writing it every time keeps the committed vector from
 * drifting away from this implementation.
 */
test("write the vector the Rust side opens", () => {
  const desktopSecret = new Uint8Array(KEY_BYTES).fill(0x11);
  const phoneSecret = new Uint8Array(KEY_BYTES).fill(0x22);
  const ephemeralSecret = new Uint8Array(KEY_BYTES).fill(0x66);
  const wire = seal({
    secretKey: desktopSecret,
    peerPublicKey: publicKeyOf(phoneSecret),
    from: DESKTOP,
    to: PHONE,
    messageId: "msg-1",
    counter: 1,
    message: { from: "typescript", n: 1 },
    pairingId: PAIRING,
    nonce: new Uint8Array(24).fill(0x33),
    ephemeralSecret,
  });

  // The line below proves the fixture this file writes is a real envelope,
  // not a string that happens to have the right shape.
  const opened = open({
    secretKey: phoneSecret,
    peerPublicKey: publicKeyOf(desktopSecret),
    localDeviceId: PHONE,
    expectedFrom: DESKTOP,
    lastCounter: 0,
    pairingId: PAIRING,
    raw: wire,
  });
  assert.ok(opened.ok);
  assert.deepEqual(opened.opened.message, { from: "typescript", n: 1 });

  const fixture = {
    secret: toHex(phoneSecret),
    peer_public: toHex(publicKeyOf(desktopSecret)),
    pairingId: PAIRING,
    wire,
  };
  writeFileSync(
    new URL("./__fixtures__/envelope-from-ts.json", import.meta.url),
    `${JSON.stringify(fixture, null, 2)}\n`,
  );
});
