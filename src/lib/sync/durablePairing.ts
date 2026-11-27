// Durable pairing — the remembered link, opened on demand (durable pairing).
//
// The pin already survived a restart; the *reachable* side did not: after a
// panel closed (or the app restarted), the phone had no address that answers
// and needed a fresh code. Durable pairing keeps a pinned-only window bound
// while the app runs, so the phone can sync without re-scanning a code —
// like pairing a Bluetooth device once and trusting it afterwards.
//
// The window this opens is exactly the §11.5 shape that was already safe:
// offer-less (a rendezvous with no code refuses — `hello.rs` answers
// `unpaired`), bound to the pin, and refusing every peer but the pinned one
// at the envelope. This module adds no reachability the protocol does not
// already gate; it just keeps it open.
//
// The toggle (`paired_phone_reachable`, Settings → Paired phone) is read by
// the caller; this module owns the how of opening, not the whether.

import type {
  BatchStatement,
  PairingListenerInfo,
  PairingOpenInput,
} from "../../data/driver.ts";
import { isAndroidPlatform } from "../android-reminders.ts";
import type { PeerRow } from "./store.ts";

/** What the durable window needs — the driver, narrowed so tests stay tiny. */
export interface DurablePairingTransport {
  pairingOpen(input: PairingOpenInput): Promise<PairingListenerInfo>;
  peers(): Promise<PeerRow[]>;
  batch(statements: BatchStatement[]): Promise<void>;
}

export type DurableOutcome =
  /** The durable window is bound (or re-bound) to the pin. */
  | "opened"
  /** The toggle is off — durable reachability was not asked for. */
  | "off"
  /** Nothing is pinned, or the only pins are revoked — nothing to keep reachable. */
  | "no-pin"
  /** The phone role: reachability is the desktop's business, not the phone's. */
  | "mobile"
  /** An attempt was made and did not bind open. */
  | "failed";

/** The one non-revoked pin this window serves, if any. The one-phone rule
 * keeps this to at most one; if a legacy install somehow has several, the
 * oldest non-revoked pin wins — the rest can only be removed by forgetting.
 */
export function durablePin(pins: readonly PeerRow[]): PeerRow | null {
  const usable = pins.filter(
    (row) => row.revoked_at === null && row.public_key !== null,
  );
  usable.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return usable[0] ?? null;
}

/**
 * Open (or re-open) the durable window for the pinned phone.
 *
 * `lastCounter` is passed as 0 on purpose: Rust seeds the window from the
 * device-local `pairing_counter.<pairing_id>` floor, and a webview that asks
 * for less is ignored (§7.2).
 *
 * A pin that never carried a pairing id (a row written before durable
 * pairing) adopts one here — the row is updated once, so the phone keeps its
 * existing trusted pairing and does not re-scan.
 */
export async function ensurePairedPhoneReachable(
  transport: DurablePairingTransport,
  toggle: boolean,
  isMobile: boolean = isAndroidPlatform(),
): Promise<DurableOutcome> {
  if (isMobile) return "mobile";
  if (!toggle) return "off";
  let pins: PeerRow[];
  try {
    pins = await transport.peers();
  } catch {
    return "failed";
  }
  const pin = durablePin(pins);
  if (pin === null) return "no-pin";
  let pairingId = pin.pairing_id;
  if (pairingId === null || pairingId.trim() === "") {
    const minted = crypto.randomUUID();
    try {
      await transport.batch([
        {
          sql: "UPDATE sync_peers SET pairing_id = ? WHERE device_id = ? AND pairing_id IS NULL",
          params: [minted, pin.device_id],
        },
      ]);
      // Re-read rather than trusting the minted value: two callers racing
      // the adoption both see NULL, and only one UPDATE lands — the loser must
      // bind its window under the id that actually persisted, or the floor
      // rows and the phone's envelopes disagree with the salt.
      const fresh = (await transport.peers()).find(
        (row) => row.device_id === pin.device_id,
      );
      pairingId = fresh?.pairing_id ?? minted;
    } catch {
      return "failed";
    }
  }
  let listener: PairingListenerInfo;
  try {
    listener = await transport.pairingOpen({
      pairingId,
      offerCode: null,
      offerExpiresAt: null,
      peer: {
        deviceId: pin.device_id,
        publicKey: pin.public_key as string,
        generation: pin.generation,
        revoked: false,
      },
      lastCounter: 0,
    });
  } catch {
    return "failed";
  }
  return listener.running ? "opened" : "failed";
}
