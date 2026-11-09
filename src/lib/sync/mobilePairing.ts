/**
 * The phone's half of pairing: the camera frame, the typed code, and the wire
 * step — protocol §11.1 and §11.6.1 (Phase C Session 6 Q.2; Session 7 T2).
 *
 * Both entries drive the same values `pairing.ts` already defines:
 *
 * - a camera frame goes through `qr.ts`'s decode (`jsqr`) and then
 *   `parseOffer`, so a scan is the same proof the desktop's rendered QR is
 *   tested against — pixels in, an offer with a named refusal out;
 * - a typed code goes through `redeemCode`, so the expired / used / locked /
 *   malformed / wrong-code answers and their attempt counting are the tested
 *   ones, never a second implementation written for the phone.
 *
 * The wire step is `pairWithDesktop`. The sealed request → ack → hello runs in
 * Rust behind `PairingPhoneTransport.pair`, because the long-term key lives in
 * the platform keystore and a webview that could seal with it could also read
 * it. That command resolves only after the desktop has opened the phone's
 * sealed hello, so the pin is written **after** possession is proven — never on
 * the ack alone (wave 1 N1, mirrored on this side).
 */
import type {
  BatchStatement,
  DataDriver,
  PairingDriver,
  PairingPhoneInput,
  PhonePairResult,
} from "../../data/driver.ts";
import {
  type CodeVerdict,
  desktopPinStatements,
  normalizeCode,
  type PairingOffer,
  type PairingSession,
  redeemCode,
} from "./pairing.ts";
import { type QrPixels, scanOffer } from "./qr.ts";
import { type PeerRow, readPeers } from "./store.ts";

export type FrameOutcome =
  | { ok: true; offer: PairingOffer }
  | { ok: false; reason: string };

/**
 * One camera frame through the same decode path the rendered QR is proven
 * against: RGBA pixels → `jsqr` → `parseOffer`.
 */
export function offerFromFrame(pixels: QrPixels): FrameOutcome {
  const scanned = scanOffer(pixels);
  return scanned.ok
    ? { ok: true, offer: scanned.offer }
    : { ok: false, reason: scanned.reason };
}

/** What the numeric entry knows: the scanned offer and its own attempts. */
export type TypedCodeSession = PairingSession;

/**
 * Type the six digits shown on the desktop. `wrong-code` costs an attempt,
 * `malformed` costs none, and the fifth wrong guess locks the code — all of it
 * decided by `redeemCode`.
 */
export function confirmTypedCode(
  session: TypedCodeSession,
  typed: string,
  now: number = Date.now(),
): { verdict: CodeVerdict; session: TypedCodeSession } {
  return redeemCode(session, typed, now);
}

/** True when the entry is worth offering: six digits, spaces and dashes allowed. */
export function isCompleteCode(typed: string): boolean {
  return normalizeCode(typed) !== null;
}

/** The phone's pin of the desktop (§11.2) — the key the QR carried. */
export function desktopPin(offer: PairingOffer): {
  deviceId: string;
  publicKey: string;
  generation: number;
  pairingId: string;
} {
  return {
    deviceId: offer.deviceId,
    publicKey: offer.publicKey,
    generation: offer.generation,
    pairingId: offer.pairingId,
  };
}

/**
 * The wire step and the two local reads a pairing needs. Narrow on purpose:
 * the orchestration below cannot open a socket, cannot read the key, and cannot
 * write anything except the pin statements it was handed.
 */
export interface PairingPhoneTransport {
  /** The sealed request → ack → hello, in Rust; resolves only after the hello. */
  pair(input: PairingPhoneInput): Promise<PhonePairResult>;
  /** Every pin this phone holds, from `sync_peers`. */
  peers(): Promise<PeerRow[]>;
  /** One transaction of pin writes. */
  batch(statements: BatchStatement[]): Promise<void>;
}

/** What one pairing attempt did — a value, so the order can be tested. */
export interface PairingOutcome {
  /** The session after the attempt; a used code stays used. */
  session: PairingSession;
  /** The code verdict, exactly as `redeemCode` words it. */
  verdict: CodeVerdict;
  /** True only once the desktop acknowledged the sealed hello. */
  paired: boolean;
  /** The desktop's facts, once it acknowledged. */
  desktop: PhonePairResult | null;
  /** What this attempt wrote to `sync_peers`; empty unless `paired`. */
  statements: BatchStatement[];
  /**
   * Why nothing was paired, when the code was right but the wire was not: the
   * desktop's own reason code (`wrong-code`, `unpaired`, `unauthenticated`, …)
   * or `pin-failed`, which means the desktop accepted the phone but the pin
   * could not be stored.
   */
  refusal: { code: string; message: string } | null;
}

/**
 * The Rust command's error text is `"{code}: {message}"` (§11.6.1 — the wire's
 * reason, then its words). Split it so the UI can show the protocol's message
 * and still keep the code for branching.
 */
export function splitRefusal(text: string): { code: string; message: string } {
  const at = text.indexOf(": ");
  return at === -1
    ? { code: "refused", message: text }
    : { code: text.slice(0, at), message: text.slice(at + 2) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Pair with the desktop in the scanned offer (§11.1, §11.6.1).
 *
 * The order is the point, and it is the same rule the desktop's panel enforces:
 *
 * 1. the code is redeemed first — attempts, single use and every refusal come
 *    from `redeemCode`, so a wrong code never reaches the network;
 * 2. the wire step runs in Rust and resolves only after the desktop opened the
 *    phone's sealed hello, which is the proof of key possession;
 * 3. only then is the pin written, through the desktop's own pin/re-pair path
 *    (`desktopPinStatements`).
 *
 * A refused code, a refused rendezvous or a desktop that goes away mid-call
 * writes nothing at all.
 */
export async function pairWithDesktop(
  transport: PairingPhoneTransport,
  session: PairingSession,
  typed: string,
  now: number = Date.now(),
): Promise<PairingOutcome> {
  const { verdict, session: redeemed } = redeemCode(session, typed, now);
  const code = normalizeCode(typed);
  if (!verdict.ok || code === null) {
    return {
      session: redeemed,
      verdict,
      paired: false,
      desktop: null,
      statements: [],
      refusal: null,
    };
  }

  let desktop: PhonePairResult;
  try {
    desktop = await transport.pair({
      endpoint: session.offer.endpoint,
      pairingId: session.offer.pairingId,
      publicKey: session.offer.publicKey,
      code,
    });
  } catch (error) {
    return {
      session: redeemed,
      verdict,
      paired: false,
      desktop: null,
      statements: [],
      refusal: splitRefusal(errorText(error)),
    };
  }

  try {
    const peers = await transport.peers();
    const existing =
      peers.find((row) => row.device_id === desktop.desktopDeviceId) ?? null;
    const statements = desktopPinStatements(
      desktop,
      session.offer,
      existing,
      new Date(now),
    );
    await transport.batch(statements);
    return {
      session: redeemed,
      verdict,
      paired: true,
      desktop,
      statements,
      refusal: null,
    };
  } catch (error) {
    return {
      session: redeemed,
      verdict,
      paired: false,
      desktop,
      statements: [],
      refusal: {
        code: "pin-failed",
        message: `the desktop accepted this phone, but the pin could not be stored: ${errorText(error)}`,
      },
    };
  }
}

/** Bind the phone's pairing to the one production driver (`data/app.ts`). */
export function createMobilePairingRepo(driver: DataDriver & PairingDriver) {
  const transport: PairingPhoneTransport = {
    pair: (input) => driver.pairingPhonePair(input),
    peers: () => readPeers(driver),
    batch: async (statements) => {
      await driver.batch(statements);
    },
  };
  return {
    pairWithDesktop: (
      session: PairingSession,
      typed: string,
      now?: number,
    ): Promise<PairingOutcome> =>
      pairWithDesktop(transport, session, typed, now),
  };
}
