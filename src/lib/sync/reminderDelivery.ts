/**
 * The §13.1 delivery rule, in ONE place
 * (`docs/ANDROID_SYNC_PROTOCOL.md`, decision A).
 *
 * Reminder *definitions* are two-way: a reminder created on the phone reaches
 * the desktop and vice versa, so both devices can show it. Delivery is not
 * two-way: exactly one device arms the alarm, posts the notification and
 * settles it, and that device is the one that created it. Otherwise a reminder
 * typed on the phone would buzz on the desktop as well, and settle there,
 * which would write `fired = 1` for an alarm nobody ever saw.
 *
 * The anchor is `reminders.created_by_device_id`, written at creation from
 * `sync_state` and stamped again at every border a row can cross (engine
 * apply, snapshot apply, upload apply). A NULL after that border stamping can
 * only be a row this device created itself before the column existed, so NULL
 * reads as "mine" — see `remindableHere`.
 */
import type { DataDriver } from "../../data/driver.ts";

/** The minimum a reminder-shaped value needs to be judged (§13.1). */
export interface ReminderOwnership {
  created_by_device_id?: string | null;
}

/**
 * True when this device delivers the reminder: it created it, or it is a
 * legacy-local row from before the column existed (NULL means mine).
 */
export function remindsHere(
  row: ReminderOwnership,
  ownDeviceId: string,
): boolean {
  const creator = row.created_by_device_id;
  return creator === null || creator === undefined || creator === ownDeviceId;
}

/**
 * The same rule over a list — every delivery surface's row selection.
 *
 * Both surfaces call this rather than repeating the comparison: the desktop's
 * due-selection for the ticker, and the Android pass's rows for arming,
 * notifying and settling.
 */
export function remindableHere<T extends ReminderOwnership>(
  rows: readonly T[],
  ownDeviceId: string,
): T[] {
  return rows.filter((row) => remindsHere(row, ownDeviceId));
}

/**
 * This device's own id from `sync_state` — the value every creator stamp and
 * every version stamp is compared against. An empty string means no identity
 * has been seeded, and then only NULL creators read as local: nothing can
 * match a device that does not name itself.
 */
export async function readOwnDeviceId(driver: DataDriver): Promise<string> {
  const rows = await driver.query<{ device_id: string }>(
    "SELECT device_id FROM sync_state WHERE id = 1",
  );
  return rows[0]?.device_id ?? "";
}
