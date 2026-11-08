/**
 * The sealed envelope — protocol §11.6.1 (Phase C Session 5, task O.2).
 *
 * The TypeScript half of one wire format; `src-tauri/src/sync/envelope.rs` is
 * the Rust half, and the two are tested against each other's bytes rather than
 * against their own.
 *
 * **What is encrypted, and under which key.** Both peers hold a long-term
 * X25519 keypair (`@noble/curves`); the public half travels in the offer and is
 * pinned (§11.2). A message is sealed under `X25519(my_secret, peer_public)`
 * with XChaCha20-Poly1305, a fresh 24-byte nonce, and the canonical header as
 * associated data. Only the two pinned keys can derive that key, so a peer
 * without the pinned secret cannot produce an openable message — that is the
 * §11.6 "authenticated encryption under the pinned key" property.
 *
 * **Deviation, stated rather than hidden:** §11.6.1 describes an *ephemeral*
 * X25519 exchange. Composing an ephemeral and a static DH into one
 * authenticated key needs a KDF of its own, and §11.6 forbids inventing one;
 * this build therefore uses the static-static agreement, which is the whole
 * security boundary minus forward secrecy. The gap is recorded in the todo as
 * pending MinLulin's decision.
 *
 * The header is authenticated but not secret: it carries the routing and
 * replay facts a receiver must check before spending a decryption.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";

export const ENVELOPE_VERSION = 1;
export const NONCE_BYTES = 24;
export const KEY_BYTES = 32;

export interface KeyPair {
  /** Never leaves the device, never logged, never in a backup (§10.3). */
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface EnvelopeHeader {
  v: number;
  /** Sending device id (§1.2). Checked against the pin, never trusted alone. */
  from: string;
  /** Receiving device id. A message addressed elsewhere is refused. */
  to: string;
  /** Operation/message identity; the replay key (§1.3). */
  messageId: string;
  /** Per-sender, monotonic: a message at or below the last seen is a replay. */
  counter: number;
  /** 24-byte nonce, lowercase hex. */
  nonce: string;
}

export interface OpenedMessage {
  header: EnvelopeHeader;
  message: unknown;
}

export type OpenRefusal =
  | "malformed"
  | "wrong-version"
  | "wrong-recipient"
  | "wrong-sender"
  | "replayed"
  | "unauthenticated";

export type OpenResult =
  | { ok: true; opened: OpenedMessage }
  | { ok: false; reason: OpenRefusal; message: string };

export function generateKeyPair(): KeyPair {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function publicKeyOf(secretKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(secretKey);
}

/** Lowercase hex — the one textual form both sides speak. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * The agreement key. A low-order peer key yields an all-zero secret, which
 * every X25519 implementation warns about; it is refused rather than used.
 */
export function sharedKey(
  secretKey: Uint8Array,
  peerPublicKey: Uint8Array,
): Uint8Array | null {
  const shared = x25519.getSharedSecret(secretKey, peerPublicKey);
  return shared.every((byte) => byte === 0) ? null : shared;
}

/** The exact bytes both sides authenticate as associated data. Field order is
 * part of the format: the Rust side serializes the same struct in this order. */
export function headerBytes(header: EnvelopeHeader): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      v: header.v,
      from: header.from,
      to: header.to,
      messageId: header.messageId,
      counter: header.counter,
      nonce: header.nonce,
    }),
  );
}

export interface SealInput {
  secretKey: Uint8Array;
  peerPublicKey: Uint8Array;
  from: string;
  to: string;
  messageId: string;
  counter: number;
  message: unknown;
  /** Injected only so a test vector can be reproduced exactly. */
  nonce?: Uint8Array;
}

/** Seal one message. Returns the wire string: `{"header":…,"body":"<hex>"}`. */
export function seal(input: SealInput): string {
  const key = sharedKey(input.secretKey, input.peerPublicKey);
  if (!key) throw new Error("peer public key is not a usable X25519 point");
  const nonce =
    input.nonce ?? crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const header: EnvelopeHeader = {
    v: ENVELOPE_VERSION,
    from: input.from,
    to: input.to,
    messageId: input.messageId,
    counter: input.counter,
    nonce: toHex(nonce),
  };
  const plaintext = new TextEncoder().encode(JSON.stringify(input.message));
  const sealed = xchacha20poly1305(key, nonce, headerBytes(header)).encrypt(
    plaintext,
  );
  return JSON.stringify({ header, body: toHex(sealed) });
}

function parseWire(
  raw: string,
): { header: EnvelopeHeader; body: Uint8Array } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as { header?: unknown; body?: unknown };
  if (typeof record.body !== "string") return null;
  const body = fromHex(record.body);
  if (!body) return null;
  if (typeof record.header !== "object" || record.header === null) return null;
  const header = record.header as Partial<EnvelopeHeader>;
  if (
    typeof header.v !== "number" ||
    typeof header.from !== "string" ||
    typeof header.to !== "string" ||
    typeof header.messageId !== "string" ||
    typeof header.counter !== "number" ||
    typeof header.nonce !== "string" ||
    !fromHex(header.nonce) ||
    (fromHex(header.nonce)?.length ?? 0) !== NONCE_BYTES
  ) {
    return null;
  }
  return { header: header as EnvelopeHeader, body };
}

export interface OpenInput {
  secretKey: Uint8Array;
  peerPublicKey: Uint8Array;
  /** This device's id: a message to anyone else is not ours to read. */
  localDeviceId: string;
  /** The pinned sender: anything else is a stranger, not a peer (§11.2). */
  expectedFrom: string;
  /** The highest counter already accepted from this peer, or 0. */
  lastCounter: number;
  raw: string;
}

/**
 * Open one message. Every refusal names its reason and happens **before** the
 * message is acted on, so a caller cannot apply a half-checked envelope.
 */
export function open(input: OpenInput): OpenResult {
  const wire = parseWire(input.raw);
  if (!wire) {
    return {
      ok: false,
      reason: "malformed",
      message: "that is not a sealed envelope.",
    };
  }
  const { header, body } = wire;
  if (header.v !== ENVELOPE_VERSION) {
    return {
      ok: false,
      reason: "wrong-version",
      message: `this build speaks envelope v${ENVELOPE_VERSION}; the peer sent v${header.v}.`,
    };
  }
  if (header.to !== input.localDeviceId) {
    return {
      ok: false,
      reason: "wrong-recipient",
      message: "that envelope is addressed to another device.",
    };
  }
  if (header.from !== input.expectedFrom) {
    return {
      ok: false,
      reason: "wrong-sender",
      message: "that envelope is not from the pinned peer (§11.2).",
    };
  }
  if (header.counter <= input.lastCounter) {
    return {
      ok: false,
      reason: "replayed",
      message: `message ${header.messageId} was already accepted; envelopes are single-use (§7.2).`,
    };
  }
  const key = sharedKey(input.secretKey, input.peerPublicKey);
  const nonce = fromHex(header.nonce);
  if (!key || !nonce) {
    return {
      ok: false,
      reason: "malformed",
      message: "the envelope's key material is unusable.",
    };
  }
  let plaintext: Uint8Array;
  try {
    plaintext = xchacha20poly1305(key, nonce, headerBytes(header)).decrypt(
      body,
    );
  } catch {
    return {
      ok: false,
      reason: "unauthenticated",
      message:
        "that envelope failed authentication — it was altered, or it was not sealed under the pinned key.",
    };
  }
  try {
    return {
      ok: true,
      opened: {
        header,
        message: JSON.parse(new TextDecoder().decode(plaintext)),
      },
    };
  } catch {
    return {
      ok: false,
      reason: "malformed",
      message: "the sealed payload is not JSON.",
    };
  }
}
