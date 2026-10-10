// Journal repository (§2.5): one entry per calendar day, month navigation.

import type { DataDriver } from "../data/driver.ts";
import { todayLocal } from "./dates.ts";
import type { JournalEntryRow } from "./types.ts";

export function createJournalRepo(driver: DataDriver) {
  return {
    async getEntry(entryDate: string): Promise<JournalEntryRow | undefined> {
      const rows = await driver.query<JournalEntryRow>(
        "SELECT * FROM journal_entries WHERE entry_date = ?",
        [entryDate],
      );
      return rows[0];
    },

    /** Insert or replace the day's entry (entry_date is UNIQUE). */
    async upsertEntry(entryDate: string, content: string): Promise<void> {
      await driver.execute(
        `INSERT INTO journal_entries (entry_date, content, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(entry_date) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
        [entryDate, content, todayLocal(), todayLocal()],
      );
    },

    async deleteEntry(entryDate: string): Promise<void> {
      await driver.execute("DELETE FROM journal_entries WHERE entry_date = ?", [
        entryDate,
      ]);
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

export type JournalRepo = ReturnType<typeof createJournalRepo>;
