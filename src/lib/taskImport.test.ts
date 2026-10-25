// Tasks CSV import: every column rule, the tolerant boolean vocabulary, row
// numbering, and the one-batch write whose failure must leave no row behind.

import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type {
  BatchStatement,
  DataDriver,
  ExecuteOutcome,
  Queryable,
} from "../data/driver.ts";
import { createMockDriver } from "../data/mock-driver.ts";
import { first } from "../test-utils.ts";
import { todayLocal } from "./dates.ts";
import { insertTasks, mapTaskRows, type TaskInsert } from "./taskImport.ts";

const SQLITE_FIXTURE = `
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

const OFF_SHARE = {
  running: false,
  url: null,
  key: null,
  port: null,
  publishedAt: null,
  note: null,
};

/** A `DataDriver` over real SQLite, with the same batch atomicity as Rust. */
function sqliteDriver(): DataDriver & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec(SQLITE_FIXTURE);
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

test("maps every column rule", () => {
  const result = mapTaskRows([
    {
      title: "  Call shop  ",
      due_date: "2026-11-01",
      done: "Yes",
      repeat: "weekly",
      note: "bring the list",
    },
    { title: "Water plants", due_date: "", done: "0", repeat: "", note: "" },
  ]);
  assert.deepEqual(result, {
    valid: [
      {
        title: "Call shop",
        due_date: "2026-11-01",
        done: 1,
        repeat: "weekly",
        note: "bring the list",
      },
      {
        title: "Water plants",
        due_date: null,
        done: 0,
        repeat: "none",
        note: "",
      },
    ],
    errors: [],
  });
});

test("done accepts all six spellings case-insensitively", () => {
  const spellings: [string, number][] = [
    ["true", 1],
    ["TRUE", 1],
    ["yes", 1],
    ["No", 0],
    ["1", 1],
    ["0", 0],
  ];
  const result = mapTaskRows(
    spellings.map(([done]) => ({ title: `t-${done}`, done })),
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.valid.map((row) => row.done),
    spellings.map(([, expected]) => expected),
  );
});

test("an absent optional column falls back to its empty value", () => {
  const result = mapTaskRows([{ title: "Only what matters", done: "false" }]);
  assert.deepEqual(result.valid, [
    {
      title: "Only what matters",
      due_date: null,
      done: 0,
      repeat: "none",
      note: "",
    },
  ]);
});

test("every row-error case is reported with its 1-based data row number", () => {
  const result = mapTaskRows([
    { title: "Good", due_date: "2026-10-31", done: "yes", note: "" },
    { title: "   ", done: "no" }, // 2: blank title
    { title: "Bad date", due_date: "10/31/2026", done: "no" }, // 3
    { title: "Bad done", done: "maybe" }, // 4
    { title: "Empty done", done: "" }, // 5
    { title: "Bad repeat", done: "no", repeat: "yearly" }, // 6
  ]);
  assert.equal(result.valid.length, 1);
  assert.equal(first(result.valid, "valid").title, "Good");
  assert.deepEqual(
    result.errors.map((error) => error.row),
    [2, 3, 4, 5, 6],
  );
  assert.deepEqual(
    result.errors.map((error) => error.reason),
    [
      "import.reason.titleRequired",
      "import.reason.dueDate",
      "import.reason.done",
      "import.reason.done",
      "import.reason.repeat",
    ],
  );
});

test("the header is not row 1", () => {
  const result = mapTaskRows([
    { title: "fine", done: "1" },
    { title: "", done: "1" },
  ]);
  assert.deepEqual(result.errors, [
    { row: 2, reason: "import.reason.titleRequired" },
  ]);
});

const insertRow = (over: Partial<TaskInsert> = {}): TaskInsert => ({
  title: "Call shop",
  due_date: "2026-11-01",
  done: 0,
  repeat: "none",
  note: "",
  ...over,
});

test("insertTasks writes every row in one batch with the full column set", async () => {
  const driver = createMockDriver();
  await insertTasks(driver, [insertRow(), insertRow({ title: "Second" })]);

  const batches = driver.callsTo("batch");
  assert.equal(batches.length, 1, "one batch for the whole import");
  const statements = first(batches, "batches").args[0] as BatchStatement[];
  assert.equal(statements.length, 2);
  const insert = first(statements, "statements");
  assert.match(
    insert.sql,
    /INSERT INTO tasks \(title, due_date, done, repeat, note, created_at\)/,
  );
  assert.deepEqual(insert.params, [
    "Call shop",
    "2026-11-01",
    0,
    "none",
    "",
    todayLocal(),
  ]);
  assert.deepEqual(driver.callsTo("execute"), []);
});

test("an empty accepted list writes nothing", async () => {
  const driver = createMockDriver();
  await insertTasks(driver, []);
  assert.deepEqual(driver.calls, []);
});

test("a failing statement rejects the import and rolls back every row", async () => {
  const driver = createMockDriver({
    batchError: new Error("batch statement 1 failed: UNIQUE constraint failed"),
  });
  await assert.rejects(
    insertTasks(driver, [insertRow(), insertRow({ title: "Second" })]),
    /UNIQUE/,
  );
  // The whole import went in as one transaction and there is no per-row retry
  // that could commit the first row.
  assert.equal(driver.callsTo("batch").length, 1);
  assert.deepEqual(driver.callsTo("execute"), []);
  assert.equal(driver.calls.length, 1);
});

test("a mid-batch failure leaves no task row behind in real SQLite", async () => {
  const driver = sqliteDriver();
  // Abort on the SECOND insert, after the first row has already been written:
  // the exact partial state the batch transaction must not leave behind.
  driver.db.exec(`
    CREATE TRIGGER refuse_boom BEFORE INSERT ON tasks
    WHEN NEW.title = 'boom' BEGIN SELECT RAISE(ABORT, 'boom task refused'); END;
  `);
  await assert.rejects(
    insertTasks(driver, [
      insertRow({ title: "First" }),
      insertRow({ title: "boom" }),
    ]),
    /boom task refused/,
  );
  const count = driver.db.prepare("SELECT count(*) AS n FROM tasks").get() as {
    n: number;
  };
  assert.equal(count.n, 0, "the first row was rolled back with the batch");
});
