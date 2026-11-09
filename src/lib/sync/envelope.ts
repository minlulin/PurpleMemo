/**
 * The sealed envelope — protocol §11.6.1 (Phase C Session 5, ephemeral rework
 * in Session 5b).
 *
 * The TypeScript half of one wire format; `src-tauri/src/envelope.rs` is the
 * Rust half, and the two are tested against each other's bytes rather than
 * against their own.
 *
 * **The construction (§11.6.1, as built).**
 *
 * ```text
 * header    = {v:1, from, to, messageId, counter, nonce:<48 hex>, eph:<64 hex>}
 * dh_eph    = X25519(ephemeralSecret, receiverLongPublic)   // fresh per message
 * dh_static = X25519(senderLongSecret, receiverLongPublic)
 * salt      = pairing id bytes          (32 zero bytes only when there is none)
 * info      = "purple-memo-envelope-v1" 0x00 from 0x00 to 0x00 pairingId
 * key       = HKDF-SHA256(ikm = dh_eph || dh_static, salt, info, 32)
 * sealed    = XChaCha20-Poly1305(key, nonce, aad = headerBytes).encrypt(json)
 * wire      = {header, body:"<hex sealed>"}
 * ```
 *
 * The sender mints a fresh ephemeral keypair per message; its public half rides
 * in the authenticated header, so a forged `eph` changes the derived key and
 * fails the tag instead of being used. The long-term keys stay pinned (§11.2):
 * only a peer holding the pinned secret can produce an openable envelope. The
 * ephemeral half is a **sender** ephemeral: per-message key separation and
 * sender-key-compromise resistance, not symmetric forward secrecy. The
 * receiver's long-term secret plus the public `eph` reproduce both agreements,
 * so a later compromise of the receiver's key opens envelopes sent to it;
 * true ephemeral–ephemeral forward secrecy is deferred, bounded by §11.5's
 * short window (§11.6.1, decision D2).
 *
 * The header is authenticated but not secret: it carries the routing and
 * replay facts a receiver must check before spending a decryption.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const ENVELOPE_VERSION = 1;
export const NONCE_BYTES = 24;
export const KEY_BYTES = 32;

/** The fixed prefix of the HKDF `info` (§11.6.1). */
export const KDF_INFO_PREFIX = "purple-memo-envelope-v1";

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
  /** The sender's per-message ephemeral X25519 public key, lowercase hex. */
  eph: string;
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
 * One X25519 agreement. A low-order peer key yields an all-zero secret, which
 * every X25519 implementation warns about; it is refused rather than used.
 */
export function sharedKey(
  secretKey: Uint8Array,
  peerPublicKey: Uint8Array,
): Uint8Array | null {
  const shared = x25519.getSharedSecret(secretKey, peerPublicKey);
  return shared.every((byte) => byte === 0) ? null : shared;
}

/**
 * The pairing id as HKDF salt. A flow with no pairing id salts with 32 zero
 * bytes — the spec names that branch, and a window with no pairing id refuses
 * every hello, so it seals nothing in practice.
 */
function kdfSalt(pairingId: string | undefined): Uint8Array {
  if (pairingId === undefined) return new Uint8Array(KEY_BYTES);
  return new TextEncoder().encode(pairingId);
}

/**
 * The HKDF `info`: a fixed prefix then the sender, receiver and pairing id,
 * each preceded by a NUL byte so the fields cannot be re-split ambiguously.
 */
function kdfInfo(
  from: string,
  to: string,
  pairingId: string | undefined,
): Uint8Array {
  const text = `${KDF_INFO_PREFIX}\u0000${from}\u0000${to}\u0000${pairingId ?? ""}`;
  return new TextEncoder().encode(text);
}

/** HKDF-SHA256 over `dh_eph || dh_static` (§11.6.1). */
function combineKey(
  dhEph: Uint8Array,
  dhStatic: Uint8Array,
  from: string,
  to: string,
  pairingId: string | undefined,
): Uint8Array {
  const ikm = new Uint8Array(KEY_BYTES * 2);
  ikm.set(dhEph, 0);
  ikm.set(dhStatic, KEY_BYTES);
  return hkdf(
    sha256,
    ikm,
    kdfSalt(pairingId),
    kdfInfo(from, to, pairingId),
    KEY_BYTES,
  );
}

/** The sender's message key: its ephemeral and long-term agreements. */
export function sealKey(
  senderSecret: Uint8Array,
  receiverPublic: Uint8Array,
  ephemeralSecret: Uint8Array,
  from: string,
  to: string,
  pairingId: string | undefined,
): Uint8Array | null {
  const dhEph = sharedKey(ephemeralSecret, receiverPublic);
  const dhStatic = sharedKey(senderSecret, receiverPublic);
  if (!dhEph || !dhStatic) return null;
  return combineKey(dhEph, dhStatic, from, to, pairingId);
}

/** The receiver's message key: the same two agreements from its side. */
export function openKey(
  receiverSecret: Uint8Array,
  senderPublic: Uint8Array,
  ephemeralPublic: Uint8Array,
  from: string,
  to: string,
  pairingId: string | undefined,
): Uint8Array | null {
  const dhEph = sharedKey(receiverSecret, ephemeralPublic);
  const dhStatic = sharedKey(receiverSecret, senderPublic);
  if (!dhEph || !dhStatic) return null;
  return combineKey(dhEph, dhStatic, from, to, pairingId);
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
      eph: header.eph,
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
  /** The pairing this message belongs to: the HKDF salt and part of its info. */
  pairingId?: string;
  /** Injected only so a test vector can be reproduced exactly. */
  nonce?: Uint8Array;
  /** Injected only so a test vector can be reproduced exactly; production
   * mints a fresh ephemeral keypair per message. */
  ephemeralSecret?: Uint8Array;
}

/** Seal one message. Returns the wire string: `{"header":…,"body":"<hex>"}`. */
export function seal(input: SealInput): string {
  const ephemeralSecret =
    input.ephemeralSecret ?? x25519.utils.randomSecretKey();
  const key = sealKey(
    input.secretKey,
    input.peerPublicKey,
    ephemeralSecret,
    input.from,
    input.to,
    input.pairingId,
  );
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
    eph: toHex(publicKeyOf(ephemeralSecret)),
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
    (fromHex(header.nonce)?.length ?? 0) !== NONCE_BYTES ||
    typeof header.eph !== "string" ||
    (fromHex(header.eph)?.length ?? 0) !== KEY_BYTES
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
  /** The pairing this message belongs to: the HKDF salt and part of its info. */
  pairingId?: string;
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
  const ephemeralPublic = fromHex(header.eph);
  const nonce = fromHex(header.nonce);
  if (!ephemeralPublic || !nonce) {
    return {
      ok: false,
      reason: "malformed",
      message: "the envelope's key material is unusable.",
    };
  }
  // A low-order point cannot take part in a sealed envelope, so it is malformed
  // rather than an authentication failure.
  const key = openKey(
    input.secretKey,
    input.peerPublicKey,
    ephemeralPublic,
    header.from,
    header.to,
    input.pairingId,
  );
  if (!key) {
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
