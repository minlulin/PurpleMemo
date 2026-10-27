// Tasks repository: partial updates write only the provided fields, and — since
// The one complete path shared by Tasks and Today.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type {
  BatchStatement,
  DataDriver,
  ExecuteOutcome,
  Queryable,
} from "../data/driver.ts";
import { createMockDriver } from "../data/mock-driver.ts";
import { createTasksRepo, nextDueDate, nextReminderAt } from "./tasks.ts";
import type { TaskRow } from "./types.ts";

const OFF_SHARE = {
  running: false,
  url: null,
  key: null,
  port: null,
  publishedAt: null,
  note: null,
};

const SQLITE_TASKS_FIXTURE = `
CREATE TABLE tasks (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL,
  due_date   TEXT,
  done       INTEGER NOT NULL DEFAULT 0,
  repeat     TEXT NOT NULL DEFAULT 'none',
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
`;

/** A `DataDriver` over real SQLite — ordering claims need real SQL. */
function sqliteDriver(): DataDriver & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec(SQLITE_TASKS_FIXTURE);
  return {
    db,
    async query<T extends Queryable>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
    async execute(
      sql: string,
      params: unknown[] = [],
    ): Promise<ExecuteOutcome> {
      const r = db.prepare(sql).run(...(params as never[]));
      return {
        rowsAffected: Number(r.changes),
        lastInsertRowid: Number(r.lastInsertRowid),
      };
    },
    async batch(statements: BatchStatement[]) {
      db.exec("BEGIN");
      try {
        for (const s of statements) {
          db.prepare(s.sql).run(...(s.params as never[]));
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    async begin() {},
    async commit() {},
    async rollback() {},
    async resetTxn() {},
    async savePhoto() {
      return "photos/2026/10/x.jpg";
    },
    async readPhoto() {
      return new Uint8Array(0);
    },
    async readPhotoThumb() {
      return new Uint8Array(0);
    },
    async savePhotoThumb() {
      return "photos/2026/10/x.thumb.jpg";
    },
    async deletePhoto() {},
    async saveBackupFile() {},
    async saveExportFile() {},
    async saveDbKeyFile() {},
    async safetyBackupCopy() {
      throw new Error("no safety copy in this test driver");
    },
    async shareStart() {
      return OFF_SHARE;
    },
    async shareStop() {
      return OFF_SHARE;
    },
    async shareStatus() {
      return OFF_SHARE;
    },
    async sharePublish() {
      return OFF_SHARE;
    },
    async shareArm() {
      return "";
    },
  };
}

test("updateTask writes only the provided fields (no NULL wipe)", async () => {
  const driver = createMockDriver();
  const tasks = createTasksRepo(driver);
  await tasks.updateTask(3, { title: "Call shop" });
  const call = driver.lastCall();
  assert.ok(call);
  const [sql, params] = call.args as [string, unknown[]];
  assert.match(sql, /UPDATE tasks SET title = \? WHERE id = \?/);
  assert.deepEqual(params, ["Call shop", 3]);
});

test("updateTask with explicit null clears a nullable field", async () => {
  const driver = createMockDriver();
  const tasks = createTasksRepo(driver);
  await tasks.updateTask(3, { dueDate: null });
  const call = driver.lastCall();
  assert.ok(call);
  const [sql, params] = call.args as [string, unknown[]];
  assert.match(sql, /UPDATE tasks SET due_date = \? WHERE id = \?/);
  assert.deepEqual(params, [null, 3]);
});

test("nextDueDate: repeat rolls the due date to the next future occurrence", () => {
  // None: no roll — the task simply stays done.
  assert.equal(nextDueDate("2026-10-11", "none", "2026-10-11"), null);
  // Done on the due day -> one period forward.
  assert.equal(nextDueDate("2026-10-11", "daily", "2026-10-11"), "2026-10-12");
  assert.equal(nextDueDate("2026-10-11", "weekly", "2026-10-11"), "2026-10-18");
  assert.equal(
    nextDueDate("2026-10-11", "monthly", "2026-10-11"),
    "2026-11-11",
  );
  // Overdue catch-up: keeps advancing past today, never re-arms in the past.
  assert.equal(nextDueDate("2026-10-01", "daily", "2026-10-11"), "2026-10-12");
  assert.equal(nextDueDate("2026-08-11", "weekly", "2026-10-11"), "2026-10-18");
  // No due date: roll from today.
  assert.equal(nextDueDate(null, "daily", "2026-10-11"), "2026-10-12");
  // Month clamp (Jan 31 -> Feb 28) follows addMonths semantics.
  assert.equal(
    nextDueDate("2026-01-31", "monthly", "2026-01-31"),
    "2026-02-28",
  );
  // Malformed or impossible stored due dates fall back to rolling from today
  // rather than writing "NaN-NaN-NaN" into SQLite.
  assert.equal(nextDueDate("2026-13-45", "daily", "2026-10-11"), "2026-10-12");
  assert.equal(nextDueDate("2026-02-31", "daily", "2026-10-11"), "2026-10-12");
  assert.equal(nextDueDate("not-a-date", "weekly", "2026-10-11"), "2026-10-18");
});

test("nextReminderAt: a repeating reminder re-arms to its next future occurrence", () => {
  // Fire time still ahead in this period -> one period forward.
  assert.equal(
    nextReminderAt("2026-01-01T09:00", "daily", "2026-01-01T08:00"),
    "2026-01-02T09:00",
  );
  assert.equal(
    nextReminderAt("2026-03-01T07:30", "weekly", "2026-03-01T08:00"),
    "2026-03-08T07:30",
  );
  // Month clamp, through the datetime helper (Jan 31 -> Feb 28).
  assert.equal(
    nextReminderAt("2026-01-31T09:00", "monthly", "2026-02-01T00:00"),
    "2026-02-28T09:00",
  );
  // Overdue by many periods: re-arm into the future, not one period at a time
  // — a single step would leave it overdue and fire on every poll.
  assert.equal(
    nextReminderAt("2026-01-01T09:00", "daily", "2026-01-05T09:00"),
    "2026-01-06T09:00",
  );
  assert.equal(
    nextReminderAt("2026-01-01T09:00", "weekly", "2026-02-20T09:00"),
    "2026-02-26T09:00",
  );
});

test("nextReminderAt: an absurd backlog and a malformed stamp both terminate", () => {
  // A decade of missed daily periods runs into the catch-up cap: the value
  // comes back advanced, but still behind `now`, instead of looping forever.
  const capped = nextReminderAt(
    "2016-01-01T09:00",
    "daily",
    "2026-10-16T09:00",
  );
  assert.ok(capped > "2016-01-01T09:00", "the cap still advances the time");
  assert.ok(capped <= "2026-10-16T09:00", `the cap is a cap: ${capped}`);
  // A malformed stamp comes back unchanged from the date helpers; the
  // no-progress guard, not the cap, is what ends the walk.
  assert.equal(
    nextReminderAt("not-a-date", "daily", "2026-10-16T09:00"),
    "not-a-date",
  );
});

test("rescheduleReminder updates in place so repeating reminders cannot be lost", async () => {
  const driver = createMockDriver();
  const tasks = createTasksRepo(driver);
  await tasks.rescheduleReminder(7, "2026-10-13T09:00");
  const call = driver.lastCall();
  assert.ok(call);
  assert.equal(call.method, "execute");
  assert.deepEqual(call.args, [
    "UPDATE reminders SET remind_at = ?, fired = 0 WHERE id = ?",
    ["2026-10-13T09:00", 7],
  ]);
});

// -- The shared complete path, and the missed-reminder list ------------

const taskRow = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: 3,
  title: "Water plants",
  due_date: "2026-10-11",
  done: 0,
  repeat: "none",
  note: "",
  created_at: "2026-10-01",
  ...over,
});

test("completeTask rolls a repeating task forward instead of closing it", async () => {
  // The  rule, now owned by the repo so Today and Tasks cannot drift
  // (task 6): a repeat re-arms to its next future due date and stays open.
  const driver = createMockDriver({
    results: [[taskRow({ repeat: "daily", due_date: "2026-10-11" })]],
  });
  await createTasksRepo(driver).completeTask(3, "2026-10-11");
  const writes = driver.callsTo("execute");
  assert.equal(writes.length, 1, "exactly one write: the rolled due date");
  assert.deepEqual(writes[0]?.args, [
    "UPDATE tasks SET due_date = ? WHERE id = ?",
    ["2026-10-12", 3],
  ]);
});

test("completeTask marks a one-off done", async () => {
  const driver = createMockDriver({ results: [[taskRow()]] });
  await createTasksRepo(driver).completeTask(3, "2026-10-11");
  const writes = driver.callsTo("execute");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]?.args, [
    "UPDATE tasks SET done = ? WHERE id = ?",
    [1, 3],
  ]);
});

test("completeTask on a row that vanished writes nothing", async () => {
  // The list was already stale; a no-op beats a scary error for a click that
  // changed nothing.
  const driver = createMockDriver({ results: [[]] });
  await createTasksRepo(driver).completeTask(99, "2026-10-11");
  assert.deepEqual(driver.callsTo("execute"), []);
});

test("firedReminders reads the fired one-shots, ordered by time", async () => {
  const driver = createMockDriver();
  await createTasksRepo(driver).firedReminders();
  const call = driver.lastCall();
  assert.ok(call);
  assert.equal(call.method, "query");
  assert.deepEqual(call.args, [
    "SELECT * FROM reminders WHERE fired = 1 ORDER BY remind_at",
    undefined,
  ]);
});

test("openTasks: done=0 only, overdue first, null due dates last", async () => {
  // The dashboard's open list (plan §A.3): plain date order already yields
  // overdue -> soon -> ok, with dateless tasks trailing.
  const repo = createTasksRepo(sqliteDriver());
  const overdueEarly = await repo.createTask({
    title: "Pay rent",
    dueDate: "2026-10-01",
  });
  const noDateA = await repo.createTask({ title: "Someday" });
  const dueToday = await repo.createTask({
    title: "Call shop",
    dueDate: "2026-10-11",
  });
  const doneOverdue = await repo.createTask({
    title: "Already done",
    dueDate: "2026-09-01",
  });
  const overdueLater = await repo.createTask({
    title: "Late bill",
    dueDate: "2026-10-05",
  });
  const noDateB = await repo.createTask({ title: "Another someday" });
  await repo.toggleTask(doneOverdue, true);

  const rows = await repo.openTasks();
  assert.deepEqual(
    rows.map((r) => r.id),
    [overdueEarly, overdueLater, dueToday, noDateA, noDateB],
    "open only, overdue (oldest first) -> dated -> dateless (by id)",
  );
});

test("Today and Tasks complete through one repo function", () => {
  // The identical-recurrence claim is structural, not aspirational: both
  // pages call the same repo function, and neither rolls repeats itself.
  for (const page of ["TasksPage.tsx", "DashboardPage.tsx"]) {
    const src = readFileSync(
      new URL(`../pages/${page}`, import.meta.url),
      "utf8",
    );
    assert.ok(
      src.includes("tasksRepo.completeTask("),
      `${page} must complete tasks through tasksRepo.completeTask`,
    );
    assert.ok(
      !src.includes("nextDueDate"),
      `${page} must not roll repeats on its own — the repo owns that rule`,
    );
  }
});
