// Forgetting a pairing, as one atomic batch (durable pairing).
//
// The "remove this Bluetooth device" act, shared by the desktop's "Forget this
// phone" and the phone's "Forget this desktop". Two statements, one
// transaction (the caller hands them to `driver.batch`, which is one
// transaction), and nothing half-remembered afterwards:
//
//  * the peer row is deleted — `pairing_history` (§11.2, N2) sees *any* row
//    as "this install has paired", so deleting the row is what makes the
//    install pairable again, and
//  * every `pairing_counter.` row is deleted — this device's §7.2 envelope
//    floors for the pairing that is gone. Leaving them behind would let a
//    forgotten pairing's history refuse or accept envelopes of a future one.
//    The LIKE is escaped (`\_`) so `pairingXcounter.` cannot match, and the
//    underscore wildcard is the only one in the pattern.
//
// What is deliberately NOT here: the caller's own pending outbox operations
// (§9.1 — dropping them silently would hide unsent work; the caller offers
// that discard separately and with a count), the vault, the notes, and the
// staged §9.1 upload. Forgetting a pairing never destroys data.

import type { BatchStatement } from "../../data/driver.ts";
import { forgetPeerStatements } from "./store.ts";

/** The DELETE for every device-local §7.2 floor row. Exported for the test
 * that pins the escaped LIKE — an unescaped `_` would widen the delete. */
export const FLOOR_ROWS_DELETE_SQL =
  "DELETE FROM settings WHERE key LIKE 'pairing\\_counter.%' ESCAPE '\\'";

/** Forget one peer: its `sync_peers` row and this device's floor rows. */
export function forgetPairingStatements(deviceId: string): BatchStatement[] {
  return [
    ...forgetPeerStatements(deviceId),
    { sql: FLOOR_ROWS_DELETE_SQL, params: [] },
  ];
}
