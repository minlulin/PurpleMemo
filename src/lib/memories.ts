// Memories repository (§2.7): date-based entries; Upcoming (14 days),
// On-this-day, month feed.

import type { DataDriver } from "../data/driver.ts";
import { addDays, todayLocal } from "./dates.ts";
import type { MemoryRow } from "./types.ts";

export interface MemoryInput {
  title: string;
  memoryDate: string;
  note?: string;
}

export function createMemoriesRepo(driver: DataDriver) {
  return {
    async listMemories(): Promise<MemoryRow[]> {
      return driver.query<MemoryRow>(
        "SELECT * FROM memories ORDER BY memory_date DESC, id DESC",
      );
    },

    async getMemory(id: number): Promise<MemoryRow | undefined> {
      const rows = await driver.query<MemoryRow>(
        "SELECT * FROM memories WHERE id = ?",
        [id],
      );
      return rows[0];
    },

    async createMemory(input: MemoryInput): Promise<number> {
      const r = await driver.execute(
        "INSERT INTO memories (title, memory_date, note, created_at) VALUES (?, ?, ?, ?)",
        [input.title, input.memoryDate, input.note ?? "", todayLocal()],
      );
      return r.lastInsertRowid;
    },

    /**
     * Partial update: only the provided fields are written (`undefined`
     * leaves the column unchanged; explicit `null` clears a nullable one).
     */
    async updateMemory(
      id: number,
      fields: Partial<MemoryInput>,
    ): Promise<void> {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (fields.title !== undefined) {
        sets.push("title = ?");
        params.push(fields.title);
      }
      if (fields.memoryDate !== undefined) {
        sets.push("memory_date = ?");
        params.push(fields.memoryDate);
      }
      if (fields.note !== undefined) {
        sets.push("note = ?");
        params.push(fields.note);
      }
      if (sets.length === 0) return;
      params.push(id);
      await driver.execute(
        `UPDATE memories SET ${sets.join(", ")} WHERE id = ?`,
        params,
      );
    },

    async deleteMemory(id: number): Promise<void> {
      await driver.execute("DELETE FROM memories WHERE id = ?", [id]);
    },

    /** Entries within `days` ahead of today (§2.7 Upcoming, default 14). */
    async upcoming(today = todayLocal(), days = 14): Promise<MemoryRow[]> {
      return driver.query<MemoryRow>(
        "SELECT * FROM memories WHERE memory_date > ? AND memory_date <= ? ORDER BY memory_date",
        [today, addDays(today, days)],
      );
    },

    /** Entries on today's month-day, any year (§2.7 On-this-day). */
    async onThisDay(today = todayLocal()): Promise<MemoryRow[]> {
      return driver.query<MemoryRow>(
        "SELECT * FROM memories WHERE substr(memory_date, 6, 5) = ? ORDER BY memory_date",
        [today.slice(5)],
      );
    },

    /** Entries in the month of `yyyy-mm` (§2.7 month feed). */
    async monthFeed(yearMonth: string): Promise<MemoryRow[]> {
      return driver.query<MemoryRow>(
        "SELECT * FROM memories WHERE substr(memory_date, 1, 7) = ? ORDER BY memory_date",
        [yearMonth],
      );
    },
  };
}

export type MemoriesRepo = ReturnType<typeof createMemoriesRepo>;

/**
 * Shift a `yyyy-mm` bucket by whole months (month-grid navigation, §2.7).
 * Malformed input falls through unchanged instead of producing garbage.
 */
export function shiftYearMonth(yearMonth: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  const year = m ? Number(m[1]) : NaN;
  const month = m ? Number(m[2]) : NaN;
  if (!Number.isFinite(year) || !Number.isFinite(month)) return yearMonth;
  const total = year * 12 + (month - 1) + delta;
  const nextYear = Math.floor(total / 12);
  const nextMonth = (total % 12) + 1;
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}`;
}
