// The last successful backup, as this device recorded it.
//
// A backup is the only copy of the data on a machine with no cloud, so the app
// has to be able to answer "when was the last one?" — and it could not: no
// export wrote any bookkeeping at all. One `settings` row now does, and this
// module is the only place that decides what a readable one is. The stored
// value is untrusted input (a hand-edited row, a row from another build), so
// the rules are pure and unit-tested, the same split as `notesView.ts`.
//
// The key is DEVICE-LOCAL in `backup.ts`: the record describes files on THIS
// machine, so a restore must not inherit the timestamp of the machine that
// wrote the archive.

import type { Locale } from "./i18n.ts";

const DAY_MS = 86_400_000;

/**
 * How old a backup may be before the row warns instead of informing. A month
 * is the honest line for a single-machine product: at daily use that is the
 * most work anyone should be able to lose without being told.
 */
export const BACKUP_STALE_DAYS = 30;

/** One successful export, written once the archive is on disk. */
export interface LastBackupRecord {
  /** `payload.exportedAt` — when the archive was made, as an ISO instant. */
  at: string;
  /** Data rows the archive holds (`summary.rowCount`). */
  rows: number;
  /** Photos the archive holds (`summary.photoCount`). */
  photos: number;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The stored record, or `null` when there is nothing to trust.
 *
 * Absent, unparseable and half-shaped all answer `null`: each one means this
 * device has no backup history it can vouch for, which is exactly the state
 * the "no backup yet" warning describes. Guessing a partial record would let
 * a corrupt row claim a backup that may not exist.
 */
export function parseLastBackup(value: unknown): LastBackupRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const { at, rows, photos } = value as Record<string, unknown>;
  if (typeof at !== "string" || Number.isNaN(new Date(at).getTime())) {
    return null;
  }
  if (!isCount(rows) || !isCount(photos)) return null;
  return { at, rows, photos };
}

/**
 * Whole days since `atIso`, floored and never negative.
 *
 * Clamping at zero is deliberate: a clock that moved backwards can leave a
 * stored instant in the future, and "in 3 days" over a backup timestamp would
 * read as a bug rather than as a fact. `null` when the instant is unreadable.
 */
function backupAgeDays(atIso: string, now: Date): number | null {
  const at = new Date(atIso).getTime();
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((now.getTime() - at) / DAY_MS));
}

/** Whether the record is older than [`BACKUP_STALE_DAYS`]. */
export function backupIsStale(atIso: string, now: Date = new Date()): boolean {
  const days = backupAgeDays(atIso, now);
  return days !== null && days > BACKUP_STALE_DAYS;
}

const relativeFormatters = new Map<Locale, Intl.RelativeTimeFormat>();

function relativeFormatter(locale: Locale): Intl.RelativeTimeFormat {
  const cached = relativeFormatters.get(locale);
  if (cached !== undefined) return cached;
  // `latn` for the same approved reason as `format.ts`: Burmese screens show
  // the same digits as every other screen and as exported files.
  const formatter = new Intl.RelativeTimeFormat(locale, {
    numeric: "auto",
    // Runtime-supported (it shows up in `resolvedOptions()`), but absent from
    // this TypeScript lib's `RelativeTimeFormatOptions`, hence the assertion.
    numberingSystem: "latn",
  } as Intl.RelativeTimeFormatOptions);
  relativeFormatters.set(locale, formatter);
  return formatter;
}

/**
 * "today" / "3 days ago" / "2 months ago" in `locale`, or `null` when the
 * instant is unreadable (there is no age to show).
 *
 * Past two months the unit becomes months: a backup from last year should not
 * read as "412 days ago".
 */
export function formatBackupAge(
  locale: Locale,
  atIso: string,
  now: Date = new Date(),
): string | null {
  const days = backupAgeDays(atIso, now);
  if (days === null) return null;
  const formatter = relativeFormatter(locale);
  return days >= 60
    ? formatter.format(-Math.floor(days / 30), "month")
    : formatter.format(-days, "day");
}
