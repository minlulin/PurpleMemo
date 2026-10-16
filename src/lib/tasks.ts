// Tasks & reminders repository (§2.7). Tasks carry due dates and repeats;
// reminders fire local notifications (the notification wiring itself is a P3d
// UI concern — this layer stores and queries them).

import type { DataDriver } from "../data/driver.ts";
import {
  addDays,
  addDaysToDateTime,
  addMonths,
  addMonthsToDateTime,
  todayLocal,
} from "./dates.ts";
import type { ReminderRow, TaskRow } from "./types.ts";

/** Hard cap on catch-up steps when rolling an overdue repeat forward. */
export const REPEAT_ROLL_MAX_STEPS = 1000;

/**
 * Next due date after marking a repeating task done (§2.7). `none` repeats
 * never roll (the task simply stays done). Every other repeat advances the
 * due date by one period per step until it lands strictly after `today` —
 * completing an overdue task re-arms it in the future instead of leaving it
 * immediately overdue again. The walk is hard-capped.
 */
export function nextDueDate(
  dueDate: string | null,
  repeat: TaskRow["repeat"],
  today: string,
): string | null {
  if (repeat === "none") return null;
  const step = (d: string): string => {
    if (repeat === "daily") return addDays(d, 1);
    if (repeat === "weekly") return addDays(d, 7);
    return addMonths(d, 1);
  };
  // Roll from whichever is later: the due date or today (a task with no
  // due date or one far in the past starts from today).
  let next = dueDate !== null && dueDate > today ? dueDate : today;
  for (let i = 0; i < REPEAT_ROLL_MAX_STEPS; i++) {
    next = step(next);
    if (next > today) return next;
  }
  // Pathological (a decade of daily catch-up) — re-arm one period out.
  return next;
}

/**
 * One period of a repeating reminder, through the datetime helpers in
 * `lib/dates.ts` (single source of truth for the month-end clamp).
 */
function stepReminderTime(
  remindAt: string,
  repeat: Exclude<ReminderRow["repeat"], "none">,
): string {
  if (repeat === "daily") return addDaysToDateTime(remindAt, 1);
  if (repeat === "weekly") return addDaysToDateTime(remindAt, 7);
  return addMonthsToDateTime(remindAt, 1);
}

/**
 * Next fire time for a repeating reminder (§2.7) — the datetime sibling of
 * [`nextDueDate`], and the reason the notification loop lives in the app shell
 * rather than in TasksPage. A reminder left overdue for many periods must
 * re-arm to its next *future* occurrence, not one period at a time: rolling a
 * single step would leave it still overdue, and it would fire again on every
 * poll until it had caught up.
 *
 * The walk is hard-capped like `nextDueDate`, and a step that does not advance
 * the time ends it instead of looping forever (an unparseable value comes back
 * unchanged from the date helpers, so that guard is what terminates it).
 */
export function nextReminderAt(
  remindAt: string,
  repeat: Exclude<ReminderRow["repeat"], "none">,
  now: string,
): string {
  let next = stepReminderTime(remindAt, repeat);
  for (let i = 0; i < REPEAT_ROLL_MAX_STEPS && next <= now; i++) {
    const advanced = stepReminderTime(next, repeat);
    if (advanced <= next) break; // no progress — never loop forever
    next = advanced;
  }
  return next;
}

export interface TaskInput {
  title: string;
  dueDate?: string | null;
  repeat?: TaskRow["repeat"];
  note?: string;
}

export interface ReminderInput {
  title: string;
  remindAt: string;
  repeat?: ReminderRow["repeat"];
  note?: string;
}

export function createTasksRepo(driver: DataDriver) {
  return {
    // -- Tasks -----------------------------------------------------------------
    async listTasks(includeDone = false): Promise<TaskRow[]> {
      return includeDone
        ? driver.query<TaskRow>(
            "SELECT * FROM tasks ORDER BY due_date IS NULL, due_date, id",
          )
        : driver.query<TaskRow>(
            "SELECT * FROM tasks WHERE done = 0 ORDER BY due_date IS NULL, due_date, id",
          );
    },

    async getTask(id: number): Promise<TaskRow | undefined> {
      const rows = await driver.query<TaskRow>(
        "SELECT * FROM tasks WHERE id = ?",
        [id],
      );
      return rows[0];
    },

    async createTask(input: TaskInput): Promise<number> {
      const r = await driver.execute(
        `INSERT INTO tasks (title, due_date, done, repeat, note, created_at)
         VALUES (?, ?, 0, ?, ?, ?)`,
        [
          input.title,
          input.dueDate ?? null,
          input.repeat ?? "none",
          input.note ?? "",
          todayLocal(),
        ],
      );
      return r.lastInsertRowid;
    },

    /**
     * Partial update: only the provided fields are written (`undefined`
     * leaves the column unchanged; explicit `null` clears a nullable one).
     */
    async updateTask(id: number, fields: Partial<TaskInput>): Promise<void> {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (fields.title !== undefined) {
        sets.push("title = ?");
        params.push(fields.title);
      }
      if (fields.dueDate !== undefined) {
        sets.push("due_date = ?");
        params.push(fields.dueDate);
      }
      if (fields.repeat !== undefined) {
        sets.push("repeat = ?");
        params.push(fields.repeat);
      }
      if (fields.note !== undefined) {
        sets.push("note = ?");
        params.push(fields.note);
      }
      if (sets.length === 0) return;
      params.push(id);
      await driver.execute(
        `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`,
        params,
      );
    },

    async toggleTask(id: number, done: boolean): Promise<void> {
      await driver.execute("UPDATE tasks SET done = ? WHERE id = ?", [
        done ? 1 : 0,
        id,
      ]);
    },

    async deleteTask(id: number): Promise<void> {
      await driver.execute("DELETE FROM tasks WHERE id = ?", [id]);
    },

    /** Open tasks due on/before today — the dashboard's due list (§2.8). */
    async dueTasks(today = todayLocal()): Promise<TaskRow[]> {
      return driver.query<TaskRow>(
        "SELECT * FROM tasks WHERE done = 0 AND due_date IS NOT NULL AND due_date <= ? ORDER BY due_date, id",
        [today],
      );
    },

    // -- Reminders ---------------------------------------------------------------
    async listReminders(includeFired = false): Promise<ReminderRow[]> {
      return includeFired
        ? driver.query<ReminderRow>(
            "SELECT * FROM reminders ORDER BY remind_at",
          )
        : driver.query<ReminderRow>(
            "SELECT * FROM reminders WHERE fired = 0 ORDER BY remind_at",
          );
    },

    async createReminder(input: ReminderInput): Promise<number> {
      const r = await driver.execute(
        `INSERT INTO reminders (title, remind_at, repeat, note, fired, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
        [
          input.title,
          input.remindAt,
          input.repeat ?? "none",
          input.note ?? "",
          todayLocal(),
        ],
      );
      return r.lastInsertRowid;
    },

    async markReminderFired(id: number): Promise<void> {
      await driver.execute("UPDATE reminders SET fired = 1 WHERE id = ?", [id]);
    },

    /** Re-arm a repeating reminder without a delete/insert gap. */
    async rescheduleReminder(id: number, remindAt: string): Promise<void> {
      await driver.execute(
        "UPDATE reminders SET remind_at = ?, fired = 0 WHERE id = ?",
        [remindAt, id],
      );
    },

    async deleteReminder(id: number): Promise<void> {
      await driver.execute("DELETE FROM reminders WHERE id = ?", [id]);
    },

    /** Reminders due now — the notification poll (§2.7). */
    async dueReminders(now: string): Promise<ReminderRow[]> {
      return driver.query<ReminderRow>(
        "SELECT * FROM reminders WHERE fired = 0 AND remind_at <= ? ORDER BY remind_at",
        [now],
      );
    },
  };
}
