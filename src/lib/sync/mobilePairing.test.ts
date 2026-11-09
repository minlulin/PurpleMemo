/**
 * The phone's pairing entry (Q.2), proven through the same paths the app uses.
 *
 * The camera path is proven against a QR this codebase rendered: pixels →
 * `jsqr` → `parseOffer` → the offer that went in. The camera itself is not a
 * fixture, so "built and proven on a rendered image" is the honest claim; the
 * device proof waits for a real camera.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  confirmTypedCode,
  desktopPin,
  isCompleteCode,
  offerFromFrame,
} from "./mobilePairing.ts";
import {
  createPairingSession,
  encodeOffer,
  type PairingSession,
} from "./pairing.ts";
import { qrMatrix, qrPixels } from "./qr.ts";

const DESKTOP_KEY =
  "7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13";

function fixedCode(code: string): () => Uint8Array {
  const digits = Number(code);
  return () =>
    new Uint8Array([
      (digits >>> 24) & 0xff,
      (digits >>> 16) & 0xff,
      (digits >>> 8) & 0xff,
      digits & 0xff,
    ]);
}

function offer(code = "123456") {
  return createPairingSession({
    deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    endpoint: "192.168.1.20:47820",
    publicKey: DESKTOP_KEY,
    generation: 1,
    schemaVersion: 8,
    now: Date.now(),
    random: fixedCode(code),
  }).offer;
}

test("a rendered QR decodes back to the same offer through the phone's path", () => {
  const source = offer();
  const pixels = qrPixels(qrMatrix(encodeOffer(source)));
  const scanned = offerFromFrame(pixels);
  assert.ok(scanned.ok);
  assert.deepEqual(scanned.offer, source);
});

test("a frame with no code is a named refusal, not a partial pairing", () => {
  const blank = {
    data: new Uint8ClampedArray(64 * 64 * 4).fill(255),
    width: 64,
    height: 64,
  };
  const scanned = offerFromFrame(blank);
  assert.equal(scanned.ok, false);
  if (!scanned.ok) assert.match(scanned.reason, /no pairing code/);
});

test("the typed code uses redeemCode's own attempts and refusals", () => {
  const source = offer();
  const session: PairingSession = {
    offer: source,
    failedAttempts: [],
    usedAt: null,
  };

  const malformed = confirmTypedCode(session, "12ab", source.createdAt + 1_000);
  assert.equal(malformed.verdict.refusal, "malformed");
  assert.equal(
    malformed.session.failedAttempts.length,
    0,
    "a typo costs no attempt",
  );

  const wrong = confirmTypedCode(
    malformed.session,
    "654321",
    source.createdAt + 2_000,
  );
  assert.equal(wrong.verdict.refusal, "wrong-code");
  assert.equal(wrong.verdict.attemptsLeft, 4);

  const right = confirmTypedCode(
    wrong.session,
    "123456",
    source.createdAt + 3_000,
  );
  assert.ok(right.verdict.ok);

  const again = confirmTypedCode(
    right.session,
    "123456",
    source.createdAt + 4_000,
  );
  assert.equal(again.verdict.refusal, "used");

  const late = confirmTypedCode(session, "123456", source.expiresAt);
  assert.equal(late.verdict.refusal, "expired");
});

test("the desktop pin is the key the QR carried, not a new one", () => {
  const source = offer();
  assert.deepEqual(desktopPin(source), {
    deviceId: source.deviceId,
    publicKey: DESKTOP_KEY,
    generation: 1,
    pairingId: source.pairingId,
  });
  assert.equal(isCompleteCode("12 34 56"), true);
  assert.equal(isCompleteCode("12345"), false);
});
