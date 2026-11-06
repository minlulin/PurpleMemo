// Rules for the phone's two Phase B session-4 surfaces: Settings and the
// Reminders panel inside Tasks.
//
// Pure on purpose. The Android facts (permission state, Keystore backing, page
// counters) are read elsewhere and injected here, so what the screen claims can
// be pinned by tests instead of only observed on a device — and so a wrong
// claim ("encrypted", "exact") cannot come from a formatting accident.

/** Bytes a SQLite database occupies, from its own page counters. */
export function databaseBytes(pageCount: number, pageSize: number): number {
  if (!Number.isFinite(pageCount) || !Number.isFinite(pageSize)) return 0;
  if (pageCount <= 0 || pageSize <= 0) return 0;
  return Math.round(pageCount * pageSize);
}

const UNITS = ["B", "KB", "MB", "GB"] as const;

/**
 * A fixed-precision size for display: one decimal above a kilobyte and rounded
 * *down*, so a size shown to the user is never larger than what is on disk.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  const floored = Math.floor(value * 10) / 10;
  return `${floored.toFixed(1)} ${UNITS[unit]}`;
}

/** `remind_at` on this project is `yyyy-mm-ddTHH:mm` (see `ReminderRow`). */
const REMIND_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export interface ReminderDraft {
  title: string;
  /** The `datetime-local` value, unchanged. */
  remindAt: string;
}

/** A reminder needs a non-blank title and a complete local date-time. */
export function reminderDraftReady(draft: ReminderDraft): boolean {
  return (
    draft.title.trim() !== "" && REMIND_AT_PATTERN.test(draft.remindAt.trim())
  );
}

/**
 * Whether a reminder's time is still ahead of `now`.
 *
 * Both values are in the same fixed-width local format, so a plain string
 * comparison is also a chronological one — no Date parsing, no timezone
 * surprise. An unparseable value answers false: scheduling something in the
 * past would fire immediately, which the user did not ask for.
 */
export function reminderIsFuture(remindAt: string, now: string): boolean {
  const value = remindAt.trim();
  if (!REMIND_AT_PATTERN.test(value) || !REMIND_AT_PATTERN.test(now))
    return false;
  return value > now;
}
