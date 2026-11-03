// Android reminder delivery, from the app's side.
//
// The desktop reminder poll (`lib/session.ts`) can only fire while the app is
// running and unlocked. On Android the process is Dozed or killed, so reminders
// are armed with the OS alarm clock instead — exact when the exact-alarm
// permission is held, inexact otherwise — and a broadcast receiver posts the
// notification with Purple Memo closed.
//
// This module is the seam between the encrypted rows and that bridge:
//
// * it shapes the pending rows into the payload the bridge arms,
// * it turns the ids the bridge reports as *delivered since the last sync* into
//   the same settle outcomes the desktop ticker writes, so a reminder is never
//   notified twice, and
// * it keeps the platform check in one place.
//
// Everything here is best-effort by design: the rows are the truth, and a
// failed sync leaves them listed rather than dropping them.

import { invoke } from "@tauri-apps/api/core";
import { nextReminderAt, type ReminderOutcome } from "./tasks.ts";
import type { ReminderRow } from "./types.ts";

/** How often the armed set and the delivery report are reconciled. */
export const ANDROID_REMINDER_SYNC_MS = 30_000;

/** One alarm the phone should hold, as the bridge expects it. */
export interface ReminderSyncRow {
  id: number;
  title: string;
  body: string;
  /** Local `yyyy-mm-ddTHH:mm`, the same shape the database stores. */
  due: string;
}

/** What the phone did, and which alarms fired since the previous sync. */
export interface ReminderSyncReport {
  /** False when the inexact fallback is in use — the UI discloses this. */
  exact: boolean;
  delivered: number[];
  scheduled: number;
  inexact: number;
  error?: string;
}

/** True inside the Android webview (the only place the native path applies). */
export function isAndroidPlatform(): boolean {
  return (
    typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)
  );
}

/**
 * The pending rows as alarm payloads.
 *
 * Notification text follows the same privacy rule as the desktop poll: with
 * previews off — the default — the alarm carries no reminder text, so nothing
 * sensitive is rendered by the system on a locked screen.
 */
export function reminderSyncRows(
  rows: ReminderRow[],
  preview: boolean,
): ReminderSyncRow[] {
  return rows
    .filter((row) => row.fired === 0)
    .map((row) => ({
      id: row.id,
      title: preview ? `Reminder: ${row.title}` : "Reminder due",
      body: preview ? row.note : "Open Purple Memo to see the reminder.",
      due: row.remind_at,
    }));
}

/**
 * The settle outcomes for alarms that already fired on the phone.
 *
 * Mirrors the desktop ticker exactly: a one-shot reminder is marked fired, a
 * repeating one is re-armed to its next future occurrence. Rows that were
 * changed between arming and this report are left alone — `fired === 1` means
 * something else already settled them, and rewriting it would resurrect an
 * acknowledged reminder.
 */
export function deliveredOutcomes(
  rows: ReminderRow[],
  delivered: number[],
  now: string,
): ReminderOutcome[] {
  const fired = new Set(delivered);
  return rows
    .filter((row) => row.fired === 0 && fired.has(row.id))
    .map((row) => ({
      id: row.id,
      nextRemindAt:
        row.repeat === "none"
          ? null
          : nextReminderAt(row.remind_at, row.repeat, now),
    }));
}

/**
 * Reconcile the phone's alarms with these rows and report what fired.
 *
 * The bridge skips rows whose due time is already past: the caller is running,
 * so those are settled by the same pass rather than notified twice.
 */
export async function syncAndroidReminders(
  rows: ReminderRow[],
  preview: boolean,
  now: string,
): Promise<{ report: ReminderSyncReport; outcomes: ReminderOutcome[] }> {
  const report = await invoke<ReminderSyncReport>("reminder_sync", {
    rows: reminderSyncRows(rows, preview),
  });
  return {
    report,
    outcomes: deliveredOutcomes(rows, report.delivered ?? [], now),
  };
}

/** Copy through the sensitive path: marked, then cleared after a short delay. */
export async function copySensitive(text: string): Promise<number> {
  return await invoke<number>("clipboard_copy_sensitive", { text });
}

/** Debug builds only: read the clipboard back to prove the clear happened. */
export async function clipboardProbeRead(): Promise<string> {
  return await invoke<string>("clipboard_probe_read");
}
