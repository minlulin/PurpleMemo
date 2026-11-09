/**
 * The phone's half of pairing: the camera frame and the typed code — protocol
 * §11.1 (Phase C Session 6, Q.2).
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
 * The phone's *wire* step (bringing its long-term key to the desktop's
 * rendezvous) is deliberately absent: the key lives behind the platform
 * keystore, and a webview that could read it would be a webview that could leak
 * it. Nothing here claims a pairing completed.
 */
import {
  type CodeVerdict,
  normalizeCode,
  type PairingOffer,
  type PairingSession,
  redeemCode,
} from "./pairing.ts";
import { type QrPixels, scanOffer } from "./qr.ts";

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
