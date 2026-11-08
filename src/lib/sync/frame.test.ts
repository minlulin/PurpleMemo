/**
 * Framing tests — the four-byte length prefix both halves of the pairing wire
 * speak (task O.3.1).
 *
 * The `00000011` prefix below is asserted against the Rust implementation in
 * `src-tauri/src/pairing_listener.rs`, so a change to one side's byte order or
 * width fails here rather than on a phone.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFrame, encodeFrame, MAX_FRAME_BYTES } from "./frame.ts";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

test("a frame is four big-endian length bytes then UTF-8 JSON", () => {
  const text = '{"hello":"world"}';
  const frame = encodeFrame(text);
  assert.equal(
    hex(frame),
    `00000011${hex(new TextEncoder().encode(text))}`,
    "17 bytes of body, big-endian, then the body",
  );
  assert.deepEqual(decodeFrame(frame), { ok: true, text });
});

test("a truncated, padded or oversized frame is refused, never guessed", () => {
  const frame = encodeFrame('{"hello":"world"}');

  for (const [label, bytes] of [
    ["three bytes is not a length", frame.subarray(0, 3)],
    ["a short body", frame.subarray(0, frame.length - 1)],
    ["trailing bytes", new Uint8Array([...frame, 0x20])],
    ["an absurd length", new Uint8Array([0xff, 0xff, 0xff, 0xff])],
    ["a body that is not UTF-8", new Uint8Array([0, 0, 0, 1, 0xff])],
  ] as const) {
    const decoded = decodeFrame(bytes);
    assert.equal(decoded.ok, false, label);
    if (!decoded.ok) assert.ok(decoded.reason.length > 0, label);
  }
});

test("the encoder refuses a body over the pairing limit", () => {
  assert.throws(
    () => encodeFrame("a".repeat(MAX_FRAME_BYTES + 1)),
    /limited to 65536 bytes/,
  );
});
