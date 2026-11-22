// The last successful backup, as this device recorded it.
//
// One `settings` row answers "when was the last backup?" — the question that
// matters on a machine with no cloud. The stored value is untrusted (a
// hand-edited row, a row from another build), so reading it is a pure,
// unit-tested rule here, the same split as `notesView.ts`. The key is
// DEVICE-LOCAL in `backup.ts`: the record describes files on THIS machine, so
// a restore must not inherit the timestamp of the machine that wrote the
// archive.

import type { Locale } from "./i18n.ts";

const DAY_MS = 86_400_000;

/**
 * How old a backup may be before the row warns instead of informing: a month
 * of daily use is the most anyone should lose without being told.
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

/** How old a recorded backup is. */
export interface BackupAge {
  /** "today" / "3 days ago" / "2 months ago", in the reader's language. */
  age: string;
  /** Whole days since the archive was written; what staleness is measured on. */
  days: number;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The stored record, or `null` when there is nothing to trust: absent,
 * unreadable and half-shaped rows all mean this device has no backup history
 * it can vouch for, which is exactly what the warning says. A partial record
 * would let a corrupt row claim a backup that may not exist.
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
 * Whole days since `atIso`, floored and never negative — a clock that moved
 * backwards can leave a stored instant in the future, and "in 3 days" over a
 * backup timestamp reads as a bug. `null` when the instant is unreadable.
 */
function daysSince(atIso: string, now: Date): number | null {
  const at = new Date(atIso).getTime();
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((now.getTime() - at) / DAY_MS));
}

/**
 * The age of a backup as a person would say it, with the day count staleness
 * is measured on; `null` when the stored instant cannot be read (there is no
 * age to show). Past two months the unit becomes months — a backup from last
 * year should not read "412 days ago".
 */
export function describeBackupAge(
  locale: Locale,
  atIso: string,
  now: Date = new Date(),
): BackupAge | null {
  const days = daysSince(atIso, now);
  if (days === null) return null;
  // `latn` digits for the same approved reason as `format.ts`; the assertion
  // covers a member this TypeScript lib's options type predates.
  const formatter = new Intl.RelativeTimeFormat(locale, {
    numeric: "auto",
    numberingSystem: "latn",
  } as Intl.RelativeTimeFormatOptions);
  return {
    days,
    age:
      days >= 60
        ? formatter.format(-Math.floor(days / 30), "month")
        : formatter.format(-days, "day"),
  };
}
