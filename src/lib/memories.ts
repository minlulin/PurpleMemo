// Memories repository: date-based entries; Upcoming (14 days),
// On-this-day, month feed.

import type { DataDriver } from "../data/driver.ts";
import { addDays, monthRange, todayLocal } from "./dates.ts";
import { createTrashRepo } from "./trash.ts";
import type { MemoryRow } from "./types.ts";

export interface MemoryInput {
  title: string;
  memoryDate: string;
  note?: string;
}

export function createMemoriesRepo(
  driver: DataDriver,
  trash = createTrashRepo(driver),
) {
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

    /** Move the memory and its photo references into Trash. */
    async deleteMemory(id: number): Promise<void> {
      await trash.trashEntity("memory", id);
    },

    /**
     * Entries within `days` ahead of today (Upcoming, default 14).
     *
     * `limit` caps the read in SQL for the share ticker (I3), which publishes
     * at most twenty of them — the date window alone does not bound this: a
     * busy fortnight could hand it every memory in the library. The order is
     * already the published order, so the first rows are unchanged.
     */
    async upcoming(
      today = todayLocal(),
      days = 14,
      limit?: number,
    ): Promise<MemoryRow[]> {
      return driver.query<MemoryRow>(
        `SELECT * FROM memories WHERE memory_date > ? AND memory_date <= ? ORDER BY memory_date${
          limit !== undefined ? " LIMIT ?" : ""
        }`,
        limit !== undefined
          ? [today, addDays(today, days), limit]
          : [today, addDays(today, days)],
      );
    },

    /**
     * Entries on today's month-day, any year (On-this-day).
     *
     * Every other date filter here is a range (`dates.ts` explains why:
     * `substr` on the column cannot use an index), but "the same day in any
     * year" is the one filter a range cannot express. The fix is the other
     * indexable form: `idx_memories_month_day` (schema v14) is an expression
     * index on exactly `substr(memory_date, 6, 5)`, and SQLite matches it by
     * the expression's spelling — so this predicate must stay written exactly
     * like this, and a "tidier" `month_day = ?` would silently go back to a
     * full scan.
     */
    async onThisDay(today = todayLocal()): Promise<MemoryRow[]> {
      return driver.query<MemoryRow>(
        "SELECT * FROM memories WHERE substr(memory_date, 6, 5) = ? ORDER BY memory_date",
        [today.slice(5)],
      );
    },

    /**
     * Entries in the month of `yyyy-mm` (month feed). Range predicate so the
     * `memory_date` index is used instead of a scan.
     */
    async monthFeed(yearMonth: string): Promise<MemoryRow[]> {
      const { from, to } = monthRange(yearMonth);
      return driver.query<MemoryRow>(
        "SELECT * FROM memories WHERE memory_date >= ? AND memory_date < ? ORDER BY memory_date",
        [from, to],
      );
    },
  };
}
