/**
 * Pairing for protocol v1 — `docs/ANDROID_SYNC_PROTOCOL.md` §8.1–§8.2 and §11
 * (Phase C Session 3).
 *
 * The trust root, in three parts:
 *
 * 1. **The offer** (§11.1): the desktop mints one short-lived, single-use,
 *    rate-limited numeric code plus the QR payload that carries it. A code is
 *    never a bearer password: it is confirmed by comparing key fingerprints on
 *    both screens, and it dies with the session.
 * 2. **The pin** (§11.2): each side stores the other's long-term public key in
 *    `sync_peers`. Every later hello is checked against that pin — no
 *    trust-on-first-use, and a changed key is a re-pair, never a silent accept.
 * 3. **The admission** (§7.1, §11.3): revoked, unpinned, wrong key, wrong
 *    protocol, wrong schema or wrong generation is a **wall**: the caller gets
 *    a named refusal and there is nothing to apply.
 *
 * This module holds no socket and no database. Codes and sessions are values;
 * pins and revocations are batch statements from `store.ts`. The transport and
 * the camera are deliberately absent — see the session report.
 */
import type { BatchStatement } from "../../data/driver.ts";
import { type Hello, handshake, PROTOCOL_VERSION } from "./protocol.ts";
import {
  type PeerRow,
  registerPeerStatements,
  rePairStatements,
  revokePeerStatements,
} from "./store.ts";

/** A numeric code is valid for two minutes: long enough to type, short enough
 * that an overheard code is worthless by the time it is used (§11.1). */
export const PAIRING_CODE_LIFETIME_MS = 2 * 60 * 1000;

/** Five wrong guesses burn the code. The sixth attempt is a lockout, not a
 * retry — a 6-digit code must not survive a brute force (§11.1). */
export const PAIRING_MAX_ATTEMPTS = 5;

/** The offer format version, separate from PROTOCOL_VERSION: the QR pays for
 * its own parsing, and v1's shape may change without the sync wire changing. */
export const PAIRING_OFFER_VERSION = 1;

export interface PairingOffer {
  version: number;
  /** §11.4: a re-pair mints a NEW pairing id — this is how the two sides tell
   * a fresh pairing from a resumed one. */
  pairingId: string;
  /** The desktop's device id (§1.2). Never rendered in the UI. */
  deviceId: string;
  /** `host:port` the phone connects to once the listener is up (§11.5). */
  endpoint: string;
  /** The desktop's long-term public key, hex. Pinned by the phone (§11.2). */
  publicKey: string;
  generation: number;
  protocolVersion: number;
  schemaVersion: number;
  code: string;
  createdAt: number;
  expiresAt: number;
}

export interface PairingSession {
  offer: PairingOffer;
  /** Timestamps of failed redemptions inside this session's lifetime. */
  failedAttempts: readonly number[];
  /** Set once, by the successful redemption: the code is single-use. */
  usedAt: number | null;
}

export type PairingSessionState = "active" | "expired" | "used" | "locked";

export interface CreatePairingInput {
  deviceId: string;
  endpoint: string;
  publicKey: string;
  generation: number;
  schemaVersion: number;
  protocolVersion?: number;
  now?: number;
  /** Injected so a test can pin a code it can actually type; the default is
   * the OS CSPRNG. */
  random?: (bytes: number) => Uint8Array;
}

function defaultRandom(bytes: number): Uint8Array {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return buffer;
}

/**
 * Six digits from the CSPRNG, with rejection sampling so no digit is more
 * likely than another (a modulo alone biases the first 967,296 of 2^32).
 */
function mintCode(random: (bytes: number) => Uint8Array): string {
  const limit = 4_000_000_000 - (4_000_000_000 % 1_000_000);
  for (;;) {
    const bytes = random(4);
    const value =
      ((bytes[0] ?? 0) << 24) |
      ((bytes[1] ?? 0) << 16) |
      ((bytes[2] ?? 0) << 8) |
      (bytes[3] ?? 0);
    const unsigned = value >>> 0;
    if (unsigned < limit) return String(unsigned % 1_000_000).padStart(6, "0");
  }
}

export function createPairingSession(
  input: CreatePairingInput,
): PairingSession {
  const now = input.now ?? Date.now();
  const random = input.random ?? defaultRandom;
  return {
    offer: {
      version: PAIRING_OFFER_VERSION,
      pairingId: crypto.randomUUID(),
      deviceId: input.deviceId,
      endpoint: input.endpoint,
      publicKey: input.publicKey,
      generation: input.generation,
      protocolVersion: input.protocolVersion ?? PROTOCOL_VERSION,
      schemaVersion: input.schemaVersion,
      code: mintCode(random),
      createdAt: now,
      expiresAt: now + PAIRING_CODE_LIFETIME_MS,
    },
    failedAttempts: [],
    usedAt: null,
  };
}

/**
 * Where the session stands. Order matters: a used code is used even after it
 * expires, and a locked session stays locked — "expired" must never be shown
 * for a session someone was guessing at.
 */
export function pairingState(
  session: PairingSession,
  now: number = Date.now(),
): PairingSessionState {
  if (session.usedAt !== null) return "used";
  if (session.failedAttempts.length >= PAIRING_MAX_ATTEMPTS) return "locked";
  if (now >= session.offer.expiresAt) return "expired";
  return "active";
}

export type CodeRefusal =
  | "malformed"
  | "wrong-code"
  | "expired"
  | "used"
  | "locked";

export interface CodeVerdict {
  ok: boolean;
  /** Attempts left before the code locks, for the message the user reads. */
  attemptsLeft: number;
  message: string;
  refusal?: CodeRefusal;
}

/** Digits-only, six of them. Spaces and dashes are a typing convenience. */
export function normalizeCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

export interface RedeemResult {
  verdict: CodeVerdict;
  /** The session after the attempt — attempts and single-use are recorded in
   * the value, so a caller cannot forget to persist them. */
  session: PairingSession;
}

/**
 * Redeem a typed numeric code (§11.1). Every refusal is a value, never an
 * exception: "expired" and "wrong" are states the user must see, and a
 * thrown error is how a UI ends up swallowing one of them.
 */
export function redeemCode(
  session: PairingSession,
  input: string,
  now: number = Date.now(),
): RedeemResult {
  const state = pairingState(session, now);
  if (state !== "active") {
    return {
      verdict: {
        ok: false,
        refusal: state,
        attemptsLeft: 0,
        message: refusalMessage(state),
      },
      session,
    };
  }
  const code = normalizeCode(input);
  if (code === null) {
    return {
      verdict: {
        ok: false,
        refusal: "malformed",
        attemptsLeft: PAIRING_MAX_ATTEMPTS - session.failedAttempts.length,
        message: "the pairing code is six digits.",
      },
      session,
    };
  }
  if (code !== session.offer.code) {
    const failedAttempts = [...session.failedAttempts, now];
    return {
      verdict: {
        ok: false,
        refusal: "wrong-code",
        attemptsLeft: Math.max(0, PAIRING_MAX_ATTEMPTS - failedAttempts.length),
        message:
          failedAttempts.length >= PAIRING_MAX_ATTEMPTS
            ? "too many wrong codes — the desktop must show a new one."
            : `that code does not match (${PAIRING_MAX_ATTEMPTS - failedAttempts.length} attempt(s) left).`,
      },
      session: { ...session, failedAttempts },
    };
  }
  return {
    verdict: { ok: true, attemptsLeft: 0, message: "paired." },
    // Single use: a second redemption of the same digits is a refusal.
    session: { ...session, usedAt: now },
  };
}

function refusalMessage(state: Exclude<PairingSessionState, "active">): string {
  switch (state) {
    case "expired":
      return "this pairing code expired — show a new one on the desktop.";
    case "used":
      return "this pairing code was already used once.";
    case "locked":
      return "too many wrong codes — the desktop must show a new one.";
  }
}

/**
 * The reason a session in this state shows. Exported so the panel surfaces the
 * message `redeemCode` would return instead of inventing a second wording for
 * the same refusal (`null` while the session is active).
 */
export function pairingStateMessage(state: PairingSessionState): string | null {
  return state === "active" ? null : refusalMessage(state);
}

/**
 * The QR payload (§11.1): the endpoint, the single-use secret and the public
 * key the phone pins. A plain URI rather than JSON so a scanner hands back
 * something a person can also read out over the phone if the camera fails.
 */
export function encodeOffer(offer: PairingOffer): string {
  const params = new URLSearchParams({
    v: String(offer.version),
    pairing: offer.pairingId,
    device: offer.deviceId,
    endpoint: offer.endpoint,
    key: offer.publicKey,
    generation: String(offer.generation),
    protocol: String(offer.protocolVersion),
    schema: String(offer.schemaVersion),
    code: offer.code,
    created: String(offer.createdAt),
    expires: String(offer.expiresAt),
  });
  return `purplememo-pair://v${offer.version}?${params.toString()}`;
}

export type ParsedOffer =
  | { ok: true; offer: PairingOffer }
  | { ok: false; reason: string };

/** Parse what a scanner read. A malformed offer is refused with a reason —
 * never partially trusted, and never filled in with defaults that would make
 * a forged payload look like a valid one. */
export function parseOffer(text: string): ParsedOffer {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return { ok: false, reason: "that is not a Purple Memo pairing code." };
  }
  if (url.protocol !== "purplememo-pair:") {
    return { ok: false, reason: "that is not a Purple Memo pairing code." };
  }
  const get = (name: string): string | null => url.searchParams.get(name);
  const version = Number(get("v"));
  if (version !== PAIRING_OFFER_VERSION) {
    return {
      ok: false,
      reason: `this pairing code is format v${get("v") ?? "?"}; this build speaks v${PAIRING_OFFER_VERSION}.`,
    };
  }
  const code = normalizeCode(get("code") ?? "");
  const pairingId = get("pairing");
  const deviceId = get("device");
  const endpoint = get("endpoint");
  const publicKey = get("key");
  const generation = Number(get("generation"));
  const protocolVersion = Number(get("protocol"));
  const schemaVersion = Number(get("schema"));
  const createdAt = Number(get("created"));
  const expiresAt = Number(get("expires"));
  if (
    code === null ||
    !pairingId ||
    !deviceId ||
    !endpoint ||
    !publicKey ||
    !Number.isFinite(generation) ||
    !Number.isFinite(protocolVersion) ||
    !Number.isFinite(schemaVersion) ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt)
  ) {
    return { ok: false, reason: "that pairing code is incomplete." };
  }
  return {
    ok: true,
    offer: {
      version,
      pairingId,
      deviceId,
      endpoint,
      publicKey,
      generation,
      protocolVersion,
      schemaVersion,
      code,
      createdAt,
      expiresAt,
    },
  };
}

/**
 * The fingerprint both screens show so a person confirms the key, not the
 * name (§11.1). Grouped in fours: easy to read aloud, and short enough to
 * compare without a magnifying glass.
 */
export function keyFingerprint(publicKey: string): string {
  const hex = publicKey.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  return (hex.match(/.{1,4}/g) ?? []).slice(0, 6).join(" ");
}

export interface PinnedPeer {
  deviceId: string;
  publicKey: string;
  generation: number;
  pairingId: string | null;
  revoked: boolean;
}

export type AdmissionRefusal =
  | "revoked"
  | "unpaired"
  | "key-mismatch"
  | "pairing-mismatch"
  | "needs-re-pair"
  | "same-device"
  | "protocol-unsupported"
  | "schema-mismatch";

export type Admission =
  | { ok: true; message: string }
  | { ok: false; code: AdmissionRefusal; message: string };

export interface AdmissionInput {
  local: Hello;
  remote: Hello;
  /** The peer's key as presented by this hello. */
  remotePublicKey: string;
  /** The pin this device holds, or null when it has never paired. */
  pinned: PinnedPeer | null;
  /** The pairing id this hello claims, when it claims one. */
  pairingId: string | null;
}

/**
 * §7.1's preconditions, in the order that matters: revoked first, because a
 * revoked peer must be refused **before any effect** (§11.3) — before its key
 * is compared, before its generation is looked at, before anything.
 */
export function admitPeer(input: AdmissionInput): Admission {
  const { pinned, remote, remotePublicKey } = input;
  if (pinned?.revoked) {
    return {
      ok: false,
      code: "revoked",
      message:
        "this phone was revoked on the desktop; re-pair it before anything syncs (§11.3).",
    };
  }
  if (!pinned) {
    return {
      ok: false,
      code: "unpaired",
      message:
        "this device has never paired; show a pairing code on the desktop first (§11.2).",
    };
  }
  if (pinned.deviceId !== remote.deviceId) {
    return {
      ok: false,
      code: "unpaired",
      message: "that device is not the one this pairing pinned (§11.2).",
    };
  }
  if (pinned.publicKey !== remotePublicKey) {
    return {
      ok: false,
      code: "key-mismatch",
      message:
        "this device's key changed — that is a re-pair, not a sync. Re-pair and compare the fingerprints (§11.2).",
    };
  }
  // §11.6.1: the pairing id is the envelope's HKDF salt, so every pairing has
  // one. A pin without one is a broken pin, not a pairing that skips the check
  // (N9).
  if (pinned.pairingId === null) {
    return {
      ok: false,
      code: "unpaired",
      message: "this pairing has no pairing id — re-pair this phone (§11.6.1).",
    };
  }
  if (input.pairingId !== pinned.pairingId) {
    return {
      ok: false,
      code: "pairing-mismatch",
      message:
        "this hello belongs to a different pairing; re-pair this phone (§11.4).",
    };
  }
  // §10.2, §10.5 (D5): the pin remembers the data line this pairing was made
  // on. Compare it BEFORE the handshake, because a restore makes the desktop
  // and the phone disagree about the line too, and the pin is the reason why.
  // "needs-re-pair" is the canonical refusal — reachable for every stale
  // pairing, not only for a phone that happened to send the new generation.
  if (pinned.generation !== input.local.generation) {
    return {
      ok: false,
      code: "needs-re-pair",
      message:
        "the desktop's data line changed since this phone paired; re-pair it (§10.2, §10.5).",
    };
  }
  const admitted = handshake(input.local, remote);
  if (!admitted.ok) {
    // `handshake` words the generation case for the protocol layer. Here the
    // pin has already passed, so a hello that still disagrees about the line
    // is a stale pairing as well — same canonical code (D5).
    if (admitted.code === "generation-mismatch") {
      return { ok: false, code: "needs-re-pair", message: admitted.message };
    }
    return { ok: false, code: admitted.code, message: admitted.message };
  }
  return { ok: true, message: "hello accepted." };
}

/**
 * §11.4: re-pair refuses while the phone's outbox still owes writes, unless
 * the user explicitly discards them. Silent loss of offline edits is the
 * failure this whole phase exists to prevent, so the default is "no".
 */
export function canRePair(
  pendingOutbox: number,
  discardPending: boolean,
): { ok: true } | { ok: false; message: string } {
  if (pendingOutbox > 0 && !discardPending) {
    return {
      ok: false,
      message: `${pendingOutbox} change(s) have not been delivered yet. Sync first, or discard them deliberately (§11.4).`,
    };
  }
  return { ok: true };
}

/** Store the peer's pin (§11.2). Both sides run the equivalent of this. */
export function pinStatements(
  peer: {
    deviceId: string;
    generation: number;
    pairingId: string;
    publicKey: string;
    displayName?: string;
  },
  now: Date = new Date(),
): BatchStatement[] {
  return registerPeerStatements(
    {
      deviceId: peer.deviceId,
      generation: peer.generation,
      pairingId: peer.pairingId,
      publicKey: peer.publicKey,
      displayName: peer.displayName ?? "",
    },
    now,
  );
}

/**
 * The desktop's facts the phone learns from its sealed ack (§11.6.1). The
 * `PhonePairResult` the IPC command returns satisfies this shape.
 */
export interface DesktopAck {
  desktopDeviceId: string;
  desktopPublicKey: string;
  pairingId: string;
  generation: number;
  schemaVersion: number;
  protocolVersion: number;
}

/** A pin with its pairing id known — what the wire step always produces. */
export interface DesktopPin extends PinnedPeer {
  pairingId: string;
}

/**
 * The pin the phone stores (§11.2): the key the QR carried — the one the ack was
 * authenticated under — and the generation the desktop's own ack delivered
 * (Option A, §10.2). Never the number the phone remembers, which a restore can
 * leave stale.
 */
export function pinFromDesktop(
  ack: DesktopAck,
  offer: PairingOffer,
): DesktopPin {
  if (ack.pairingId !== offer.pairingId) {
    throw new Error(
      "the acknowledgement belongs to a different pairing (§11.4).",
    );
  }
  return {
    deviceId: ack.desktopDeviceId,
    publicKey: offer.publicKey,
    generation: ack.generation,
    pairingId: ack.pairingId,
    revoked: false,
  };
}

/**
 * The statements that store a desktop's pin, made only after the sealed hello
 * has been acknowledged (N1). A desktop already in `sync_peers` is re-paired
 * through `rePairStatements` (§11.4) — new pairing id, both cursors zeroed, the
 * old pairing's acks dropped — and keeps the name the person gave it.
 */
export function desktopPinStatements(
  ack: DesktopAck,
  offer: PairingOffer,
  existing: Pick<PeerRow, "display_name"> | null,
  now: Date = new Date(),
): BatchStatement[] {
  const pin = pinFromDesktop(ack, offer);
  if (existing === null) return pinStatements(pin, now);
  return rePairStatements(
    {
      deviceId: pin.deviceId,
      generation: pin.generation,
      pairingId: pin.pairingId,
      publicKey: pin.publicKey,
      displayName: existing.display_name,
    },
    now,
  );
}

export { rePairStatements, revokePeerStatements };

export interface ListenerState {
  active: boolean;
  /** Why the listener is up: pairing is the only reason it exists (§11.5). */
  purpose: "pairing" | null;
  startedAt: number | null;
}

export const IDLE_LISTENER: ListenerState = {
  active: false,
  purpose: null,
  startedAt: null,
};

/**
 * §11.5: the port exists only while pairing is on screen. `stop` is what the
 * pairing UI calls on lock, on reset and when the screen closes, so "no
 * always-on port" is a property of this value rather than of a promise in a
 * comment.
 */
export function startPairingListener(now: number = Date.now()): ListenerState {
  return { active: true, purpose: "pairing", startedAt: now };
}

export function stopPairingListener(): ListenerState {
  return IDLE_LISTENER;
}
