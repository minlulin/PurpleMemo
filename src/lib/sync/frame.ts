/**
 * The length prefix on every pairing message — protocol §11.6.1 (Phase C
 * Session 5, task O.3.1).
 *
 * A pairing message is a UTF-8 JSON document preceded by its length in four
 * big-endian bytes. HTTP already frames a request, but the prefix is what the
 * protocol records, and it is what lets a reader refuse a truncated or padded
 * document instead of parsing whatever arrived.
 * `src-tauri/src/pairing_listener.rs` reads and writes the same four bytes, and
 * both suites pin the same byte vector, so the two halves cannot drift.
 */

export const FRAME_HEADER_BYTES = 4;

/** Handshake-sized: the desktop refuses anything larger (§11.6.1). */
export const MAX_FRAME_BYTES = 64 * 1024;

export type FrameResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/** Prefix `text` with its length, big-endian. */
export function encodeFrame(text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  if (body.length > MAX_FRAME_BYTES) {
    throw new Error(`a pairing message is limited to ${MAX_FRAME_BYTES} bytes`);
  }
  const frame = new Uint8Array(FRAME_HEADER_BYTES + body.length);
  new DataView(frame.buffer).setUint32(0, body.length, false);
  frame.set(body, FRAME_HEADER_BYTES);
  return frame;
}

/**
 * Read one framed document. A length that does not match the body exactly is a
 * refusal, never a guess: accepting a short frame would let a split message be
 * read as two.
 */
export function decodeFrame(bytes: Uint8Array): FrameResult {
  if (bytes.length < FRAME_HEADER_BYTES) {
    return { ok: false, reason: "a frame begins with a four-byte length." };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(0, false);
  if (length > MAX_FRAME_BYTES) {
    return { ok: false, reason: "the frame is larger than the pairing limit." };
  }
  if (bytes.length - FRAME_HEADER_BYTES !== length) {
    return {
      ok: false,
      reason: "the frame's length prefix does not match its body.",
    };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(FRAME_HEADER_BYTES),
    );
    return { ok: true, text };
  } catch {
    return { ok: false, reason: "the frame is not UTF-8." };
  }
}
