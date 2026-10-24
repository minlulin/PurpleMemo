// Habits repository: daily logs, current/best streaks, week progress,
// month grid. Streaks are pure functions over the set of logged dates.

import type { DataDriver } from "../data/driver.ts";
import { addDays, todayLocal } from "./dates.ts";
import type { HabitLogRow, HabitRow } from "./types.ts";

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
      const r = await driver.execute(
        "INSERT INTO habits (name, created_at) VALUES (?, ?)",
        [name, todayLocal()],
      );
      return r.lastInsertRowid;
    },

    async deleteHabit(id: number): Promise<void> {
      await driver.execute("DELETE FROM habits WHERE id = ?", [id]);
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

    /** Toggle a day's log; returns the new done state. */
    async toggleLog(habitId: number, logDate: string): Promise<boolean> {
      const existing = await this.getLog(habitId, logDate);
      if (existing) {
        await driver.execute("DELETE FROM habit_logs WHERE id = ?", [
          existing.id,
        ]);
        return false;
      }
      await driver.execute(
        "INSERT INTO habit_logs (habit_id, log_date, done) VALUES (?, ?, 1)",
        [habitId, logDate],
      );
      return true;
    },

    async listLogs(habitId: number): Promise<HabitLogRow[]> {
      return driver.query<HabitLogRow>(
        "SELECT * FROM habit_logs WHERE habit_id = ? ORDER BY log_date",
        [habitId],
      );
    },

    /** All logged dates for a habit (the streak/week/month computations). */
    async loggedDates(habitId: number): Promise<string[]> {
      const rows = await driver.query<{ log_date: string }>(
        "SELECT log_date FROM habit_logs WHERE habit_id = ? AND done = 1 ORDER BY log_date",
        [habitId],
      );
      return rows.map((r) => r.log_date);
    },

    /**
     * Progress for a bounded list of habits in two queries.
     *
     * `habitProgress` is two queries per habit, which suits a page showing one
     * habit and not the share ticker asking for twenty: that path paid forty
     * IPC round-trips every 30 seconds. The log read is one statement scoped to
     * the selected ids — a streak needs the habit's whole history, so the dates
     * themselves are not capped.
     *
     * Each result also carries `dates`, the habit's full done-date history
     * (ascending, the same set `loggedDates` returns per habit): the log rows
     * are already in hand, so callers like HabitsPage's calendar grid get them
     * for free instead of paying one more query per habit.
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

    /** Habit + derived progress for the habit views. */
    async habitProgress(
      habitId: number,
      today = todayLocal(),
    ): Promise<{
      habit: HabitRow | undefined;
      current: number;
      best: number;
      week: { date: string; done: boolean }[];
    }> {
      const [habit, dates] = await Promise.all([
        driver.query<HabitRow>("SELECT * FROM habits WHERE id = ?", [habitId]),
        this.loggedDates(habitId),
      ]);
      return {
        habit: habit[0],
        current: currentStreak(dates, today),
        best: bestStreak(dates),
        week: weekProgress(dates, today),
      };
    },
  };
}
