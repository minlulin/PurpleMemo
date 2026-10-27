// Journal repository: one entry per calendar day, month navigation.

import type { DataDriver } from "../data/driver.ts";
import { datesInMonth, todayLocal } from "./dates.ts";
import { createTrashRepo } from "./trash.ts";
import type { JournalEntryRow } from "./types.ts";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** One cell of the month grid: a date with its entry marker, or a blank. */
export type MonthGridCell = { date: string; hasEntry: boolean } | null;

/**
 * Build the month grid for `yyyy-mm`: weeks of 7 cells,
 * **Sunday-start** (English UI, `getDay()` 0=Sunday), leading/trailing `null`
 * blanks, `hasEntry` flagging days that have a journal entry. Invalid
 * year-month strings yield `[]`.
 */
export function buildMonthGrid(
  yearMonth: string,
  entryDates: Iterable<string>,
): MonthGridCell[][] {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(yearMonth)) return [];
  const entries = new Set(entryDates);
  const days = datesInMonth(yearMonth);
  const firstDay =
    days[0] !== undefined ? new Date(`${days[0]}T00:00:00`).getDay() : 0;
  const cells: MonthGridCell[] = Array.from({ length: firstDay }, () => null);
  for (const date of days) cells.push({ date, hasEntry: entries.has(date) });
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: MonthGridCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/**
 * React key for one grid week: the date of its first dated cell. Every week
 * `buildMonthGrid` emits has one — leading blanks are at most 6 (`getDay()`
 * 0–6), trailing padding at most 6, and a month runs 28–31 days — so there is
 * no blank-week shape to fabricate a fallback key for (D12). Reaching the
 * throw means the grid itself is broken, not that the row should render
 * under an invented key.
 */
export function weekRowKey(week: MonthGridCell[]): string {
  for (const cell of week) {
    if (cell !== null) return cell.date;
  }
  throw new Error("buildMonthGrid emitted a week with no dated cell");
}

/** English month label for the grid header ("October 2026"), "" if invalid. */
export function monthLabel(yearMonth: string): string {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(yearMonth);
  const month = match?.[2];
  const year = match?.[1];
  if (month === undefined || year === undefined) return "";
  const name = MONTH_NAMES[Number(month) - 1];
  return name === undefined ? "" : `${name} ${year}`;
}

export function createJournalRepo(
  driver: DataDriver,
  trash = createTrashRepo(driver),
) {
  return {
    async getEntry(entryDate: string): Promise<JournalEntryRow | undefined> {
      const rows = await driver.query<JournalEntryRow>(
        "SELECT * FROM journal_entries WHERE entry_date = ?",
        [entryDate],
      );
      return rows[0];
    },

    /**
     * Insert or replace the day's entry (entry_date is UNIQUE).
     *
     * The date is validated here — the write side — because the row is read
     * back into export paths (`journalExportPath`) with no `CHECK` on the
     * column: a date from an imported payload must never leave this function.
     */
    async upsertEntry(entryDate: string, content: string): Promise<void> {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
        throw new Error(`Invalid journal entry date: ${entryDate}`);
      }
      await driver.execute(
        `INSERT INTO journal_entries (entry_date, content, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(entry_date) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
        [entryDate, content, todayLocal(), todayLocal()],
      );
    },

    async deleteEntry(entryDate: string): Promise<void> {
      const entry = await this.getEntry(entryDate);
      if (entry) await trash.trashEntity("journal_entry", entry.id);
    },

    /** Days of `yyyy-mm` that have an entry — the month grid's marked days. */
    async datesInMonth(yearMonth: string): Promise<string[]> {
      const rows = await driver.query<{ entry_date: string }>(
        "SELECT entry_date FROM journal_entries WHERE substr(entry_date, 1, 7) = ? ORDER BY entry_date",
        [yearMonth],
      );
      return rows.map((r) => r.entry_date);
    },
  };
}
