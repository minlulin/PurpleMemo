/**
 * QR tests — render → decode → parse, with the real libraries (task N.6.2).
 *
 * The encoder and the decoder are independent implementations, so this is a
 * genuine round trip rather than a self-consistency check: if either library
 * changed how it lays out modules, the offer would come back different and the
 * test would fail. No mocks, and no assertion on "looks like a QR".
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPairingSession, encodeOffer, parseOffer } from "./pairing.ts";
import {
  decodeQr,
  qrMatrix,
  qrPixels,
  qrSvg,
  scanOffer,
  verifyOfferQr,
} from "./qr.ts";

const NOW = 1_760_000_000_000;

function offer() {
  return createPairingSession({
    deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    endpoint: "192.168.1.20:47820",
    // 32 bytes of lowercase hex — the only key shape an offer may carry (N7).
    publicKey:
      "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    generation: 3,
    schemaVersion: 8,
    now: NOW,
    random: () => new Uint8Array([0, 0x01, 0xe2, 0x40]), // 123456
  }).offer;
}

test("a rendered code scans back to exactly the offer that was rendered", () => {
  const original = offer();
  const payload = encodeOffer(original);

  const matrix = qrMatrix(payload);
  assert.ok(matrix.size >= 21, "a QR is at least 21 modules across");
  assert.equal(matrix.data.length, matrix.size * matrix.size);

  const pixels = qrPixels(matrix);
  assert.equal(pixels.width, pixels.height);
  assert.equal(decodeQr(pixels), payload, "the decoder reads the same bytes");

  const scanned = verifyOfferQr(original);
  assert.ok(scanned.ok, "the scanned payload must parse as an offer");
  assert.deepEqual(scanned.offer, original);
  assert.equal(scanned.offer.code, "123456");
  assert.equal(scanned.offer.expiresAt, NOW + 120_000);
});

test("the SVG carries the whole code, including its quiet zone", () => {
  const payload = encodeOffer(offer());
  const svg = qrSvg(payload);
  const matrix = qrMatrix(payload);
  const side = matrix.size + 8; // 4 modules of quiet zone each side

  assert.match(svg, /^<svg /);
  assert.match(svg, new RegExp(`viewBox="0 0 ${side} ${side}"`));
  assert.match(svg, /fill="white"/, "a scanner needs the light background");
  assert.match(svg, /fill="black"/, "the modules are dark");
  const squares = (svg.match(/h1v1h-1z/g) ?? []).length;
  assert.equal(
    squares,
    matrix.data.reduce((total, module) => total + module, 0),
    "one path square per dark module — no module is dropped",
  );
});

test("a frame with no code, and a code that is not ours, are refusals", () => {
  const blank = {
    data: new Uint8ClampedArray(64 * 64 * 4).fill(255),
    width: 64,
    height: 64,
  };
  assert.equal(decodeQr(blank), null);
  const nothing = scanOffer(blank);
  assert.equal(nothing.ok, false);
  assert.match(nothing.ok === false ? nothing.reason : "", /no pairing code/);

  // A perfectly readable QR that is simply not a pairing offer.
  const foreign = qrPixels(qrMatrix("https://example.com/not-a-pairing-code"));
  const payload = decodeQr(foreign);
  assert.equal(payload, "https://example.com/not-a-pairing-code");
  const refused = scanOffer(foreign);
  assert.equal(refused.ok, false);
  assert.match(
    refused.ok === false ? refused.reason : "",
    /not a Purple Memo pairing code/,
  );

  // A payload of ours with a digit flipped still parses to a *different* code:
  // the code is data, not a checksum, so the offer must not be trusted for
  // matching just because the QR decoded.
  const tampered = encodeOffer(offer()).replace(/code=\d{6}/, "code=999999");
  const tamperedOffer = parseOffer(tampered);
  assert.ok(tamperedOffer.ok);
  assert.equal(tamperedOffer.offer.code, "999999");
  assert.notEqual(tamperedOffer.offer.code, offer().code);
});
