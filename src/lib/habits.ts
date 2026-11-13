// Habits repository: daily logs, current/best streaks, week progress,
// month grid. Streaks are pure functions over the set of logged dates.

import type { DataDriver } from "../data/driver.ts";
import { addDays, todayLocal } from "./dates.ts";
import {
  deleteStatements,
  outboxStatements,
  readRowId,
  readRowUid,
} from "./sync/store.ts";
import type { HabitLogRow, HabitRow } from "./types.ts";
import { newUid } from "./uid.ts";

/** Current streak: consecutive logged days ending today or yesterday. */
export function currentStreak(dates: string[], today: string): number {
  const set = new Set(dates);
  let cursor = today;
  if (!set.has(cursor)) cursor = addDays(cursor, -1); // today not logged yet — don't break the streak
  let streak = 0;
  while (set.has(cursor)) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/** Best streak: longest run of consecutive logged days ever. */
export function bestStreak(dates: string[]): number {
  const unique = [...new Set(dates)].sort();
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of unique) {
    run = prev !== null && addDays(prev, 1) === d ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  }
  return best;
}

/** The 7 days ending today, oldest first, each mapped to done/not. */
export function weekProgress(
  dates: string[],
  today: string,
): { date: string; done: boolean }[] {
  const set = new Set(dates);
  const out: { date: string; done: boolean }[] = [];
  for (let i = 6; i >= 0; i--) {
    const date = addDays(today, -i);
    out.push({ date, done: set.has(date) });
  }
  return out;
}

export function createHabitsRepo(driver: DataDriver) {
  return {
    async listHabits(): Promise<HabitRow[]> {
      return driver.query<HabitRow>("SELECT * FROM habits ORDER BY id");
    },

    async createHabit(name: string): Promise<number> {
      const created = todayLocal();
      const uid = newUid();
      await driver.batch([
        {
          sql: "INSERT INTO habits (name, created_at, uid) VALUES (?, ?, ?)",
          params: [name, created, uid],
        },
        ...outboxStatements([
          {
            table: "habits",
            uid,
            kind: "create",
            fields: { name, created_at: created },
          },
        ]),
      ]);
      return readRowId(driver, "habits", uid);
    },

    async deleteHabit(id: number): Promise<void> {
      const uid = await readRowUid(driver, "habits", id);
      // §5.2: `habit_logs` goes with the habit through the FK cascade, and the
      // cascade is not the record — every check-in the habit held needs its own
      // tombstone, or the peer keeps a log whose habit no longer exists.
      const logs = (
        await driver.query<{ uid: string | null }>(
          "SELECT uid FROM habit_logs WHERE habit_id = ? ORDER BY id",
          [id],
        )
      )
        .map((row) => row.uid)
        .filter((log: string | null): log is string =>
          Boolean(log && log.length > 0),
        );
      await driver.batch([
        { sql: "DELETE FROM habits WHERE id = ?", params: [id] },
        ...deleteStatements([
          ...(uid ? [{ table: "habits" as const, uid }] : []),
          ...logs.map((log) => ({ table: "habit_logs" as const, uid: log })),
        ]),
      ]);
    },

    async getLog(
      habitId: number,
      logDate: string,
    ): Promise<HabitLogRow | undefined> {
      const rows = await driver.query<HabitLogRow>(
        "SELECT * FROM habit_logs WHERE habit_id = ? AND log_date = ?",
        [habitId, logDate],
      );
      return rows[0];
    },

    /**
     * Toggle a day's log; returns the new done state.
     *
     * A check-in IS a `habit_logs` row (§2.3), so it records like any other
     * mutation: an insert is a `create`, an un-check is a `delete` with its
     * tombstone (§5.1) — in the same batch, both times (§6.1).
     */
    async toggleLog(habitId: number, logDate: string): Promise<boolean> {
      const existing = await this.getLog(habitId, logDate);
      if (existing) {
        await driver.batch([
          { sql: "DELETE FROM habit_logs WHERE id = ?", params: [existing.id] },
          ...deleteStatements(
            existing.uid ? [{ table: "habit_logs", uid: existing.uid }] : [],
          ),
        ]);
        return false;
      }
      const uid = newUid();
      await driver.batch([
        {
          sql: "INSERT INTO habit_logs (habit_id, log_date, done, uid) VALUES (?, ?, 1, ?)",
          params: [habitId, logDate, uid],
        },
        ...outboxStatements([
          {
            table: "habit_logs",
            uid,
            kind: "create",
            fields: { habit_id: habitId, log_date: logDate, done: 1 },
          },
        ]),
      ]);
      return true;
    },

    /**
     * Progress for a bounded list of habits in two queries — the ONLY progress
     * entry point (D12): the per-habit variant this replaced cost two queries
     * per habit (forty IPC round-trips for the share ticker's twenty habits,
     * every 30 seconds) and was deleted rather than left for a caller to
     * reintroduce — `fan-out-guard.test.ts` pins that no page calls it. The log
     * read is one statement scoped to the selected ids — a streak needs the
     * habit's whole history, so the dates themselves are not capped.
     *
     * Each result also carries `dates`, the habit's full done-date history
     * (ascending): the log rows are already in hand, so callers like
     * HabitsPage's calendar grid get them for free instead of paying one more
     * query per habit.
     */
    async habitProgressList(
      today = todayLocal(),
      limit?: number,
    ): Promise<
      {
        habit: HabitRow;
        current: number;
        best: number;
        week: { date: string; done: boolean }[];
        dates: string[];
      }[]
    > {
      const rows = await driver.query<HabitRow>(
        `SELECT * FROM habits ORDER BY id${limit !== undefined ? " LIMIT ?" : ""}`,
        limit !== undefined ? [limit] : [],
      );
      if (rows.length === 0) return [];
      const ids = rows.map((h) => h.id);
      const placeholders = ids.map(() => "?").join(", ");
      const logs = await driver.query<{ habit_id: number; log_date: string }>(
        `SELECT habit_id, log_date FROM habit_logs WHERE done = 1 AND habit_id IN (${placeholders}) ORDER BY log_date`,
        ids,
      );
      const byHabit = new Map<number, string[]>();
      for (const log of logs) {
        const dates = byHabit.get(log.habit_id);
        if (dates) dates.push(log.log_date);
        else byHabit.set(log.habit_id, [log.log_date]);
      }
      return rows.map((habit) => {
        const dates = byHabit.get(habit.id) ?? [];
        return {
          habit,
          current: currentStreak(dates, today),
          best: bestStreak(dates),
          week: weekProgress(dates, today),
          dates,
        };
      });
    },
  };
}
