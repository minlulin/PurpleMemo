/**
 * Stage 1's recording half — `docs/ANDROID_SYNC_PROTOCOL.md` §6.1: an op
 * commits in the same transaction as its mutation.
 *
 * One mutation without its op, or an op without its mutation, is the bug these
 * tests exist to catch, so every case here reads the domain row, the outbox and
 * the tombstone set out of the SAME real SQLite database, after the real
 * repository method ran. The fixtures are hand-trimmed copies of the app's DDL
 * (`src-tauri/src/schema.rs`) — the tables each repository actually touches —
 * and the sync tables are sliced from that file rather than retyped
 * (`./testSchema.ts`).
 *
 * The eight Stage 1 tables are the whole of this session's scope
 * (`§12.1`); a write to any other table must record nothing, which the Budget
 * case at the end pins.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { BatchStatement, DataDriver } from "../../data/driver.ts";
import { createBudgetRepo } from "../budget.ts";
import { createHabitsRepo } from "../habits.ts";
import { createNotesRepo } from "../notes.ts";
import { createShoppingRepo } from "../shopping.ts";
import { createTasksRepo } from "../tasks.ts";
import {
  readOutbox,
  readState,
  readTombstones,
  type SyncState,
} from "./store.ts";
import { applySyncStorage } from "./testSchema.ts";

/**
 * The Stage 1 tables, the two the Trash delete path reads, and Budget's two.
 *
 * `reminders.created_by_device_id` is declared here because `./testSchema.ts`
 * skips the v9 `ALTER TABLE` that adds it in the app — this fixture cares about
 * that column, so it states the column.
 */
const FIXTURE = `
CREATE TABLE collections (
  id INTEGER PRIMARY KEY,
  uid TEXT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  uid TEXT,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  uid TEXT,
  title TEXT NOT NULL,
  due_date TEXT,
  done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  repeat TEXT NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'daily', 'weekly', 'monthly')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE reminders (
  id INTEGER PRIMARY KEY,
  uid TEXT,
  title TEXT NOT NULL,
  remind_at TEXT NOT NULL,
  repeat TEXT NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'daily', 'weekly', 'monthly')),
  note TEXT NOT NULL DEFAULT '',
  fired INTEGER NOT NULL DEFAULT 0 CHECK (fired IN (0, 1)),
  created_at TEXT NOT NULL,
  created_by_device_id TEXT
);
CREATE TABLE shopping_lists (
  id INTEGER PRIMARY KEY,
  uid TEXT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE shopping_items (
  id INTEGER PRIMARY KEY,
  uid TEXT,
  list_id INTEGER NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE habits (
  id INTEGER PRIMARY KEY,
  uid TEXT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE habit_logs (
  id INTEGER PRIMARY KEY,
  uid TEXT,
  habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  log_date TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 1 CHECK (done IN (0, 1)),
  UNIQUE (habit_id, log_date)
);
CREATE TABLE wallets (
  id INTEGER PRIMARY KEY,
  uid TEXT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE expense_categories (
  id INTEGER PRIMARY KEY,
  uid TEXT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE expense_entries (
  id INTEGER PRIMARY KEY,
  uid TEXT,
  amount_cents INTEGER NOT NULL,
  category_id INTEGER NOT NULL REFERENCES expense_categories(id),
  wallet_id INTEGER NOT NULL REFERENCES wallets(id),
  entry_date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE links (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'related',
  type_a TEXT NOT NULL,
  id_a INTEGER NOT NULL,
  type_b TEXT NOT NULL,
  id_b INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE photo_refs (
  id INTEGER PRIMARY KEY,
  photo_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL
);
CREATE TABLE inbox_items (
  id INTEGER PRIMARY KEY,
  converted_type TEXT,
  converted_id INTEGER
);
CREATE TABLE trash_items (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL CHECK (entity_id > 0),
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  deleted_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

interface Store {
  db: DatabaseSync;
  driver: DataDriver;
}

function openStore(): Store {
  const db = new DatabaseSync(":memory:");
  // The FK cascade is half of what §5.2 is about (a child removed by the
  // database still needs its own tombstone), so it is ON as in production.
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(FIXTURE);
  applySyncStorage(db);
  const run = (sql: string, params: unknown[] = []): void => {
    db.prepare(sql).run(...(params as never[]));
  };
  const driver = {
    query: async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
      db.prepare(sql).all(...(params as never[])) as T[],
    execute: async (sql: string, params: unknown[] = []) => {
      const result = db.prepare(sql).run(...(params as never[]));
      return {
        rowsAffected: Number(result.changes),
        lastInsertRowid: Number(result.lastInsertRowid),
      };
    },
    async batch(statements: BatchStatement[]): Promise<void> {
      db.exec("BEGIN");
      try {
        for (const statement of statements) {
          run(statement.sql, statement.params ?? []);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as DataDriver;
  return { db, driver };
}

function count(db: DatabaseSync, sql: string, params: unknown[] = []): number {
  const row = db.prepare(sql).get(...(params as never[])) as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

/** One row of `sync_outbox`, as the assertions want to read it. */
interface RecordedOp {
  seq: number;
  entity_table: string;
  entity_uid: string;
  op: string;
  counter: number;
  payload: Record<string, unknown>;
}

async function opsFor(
  driver: DataDriver,
  table: string,
): Promise<RecordedOp[]> {
  return (await readOutbox(driver))
    .filter((row) => row.entity_table === table)
    .map((row) => ({
      seq: row.seq,
      entity_table: row.entity_table,
      entity_uid: row.entity_uid,
      op: row.op,
      counter: row.counter,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    }));
}

/** The stamp `sync_row_stamps` holds for one record (§4.2/§8.4). */
function rowStamp(
  db: DatabaseSync,
  table: string,
  uid: string,
): { counter: number; device_id: string; op_id: string } | undefined {
  return db
    .prepare(
      "SELECT counter, device_id, op_id FROM sync_row_stamps WHERE entity_table = ? AND entity_uid = ?",
    )
    .get(table, uid) as
    | { counter: number; device_id: string; op_id: string }
    | undefined;
}

function uidOf(
  db: DatabaseSync,
  table: string,
  id: number,
): string | undefined {
  const row = db.prepare(`SELECT uid FROM "${table}" WHERE id = ?`).get(id) as
    | { uid: string | null }
    | undefined;
  return row?.uid ?? undefined;
}

/**
 * §6.1 on one record: the row exists, exactly one op names it, that op's stamp
 * is the row's stamp, and the sequence/lamport pair moved once.
 */
async function assertRecorded(
  store: Store,
  table: string,
  id: number,
  kind: string,
): Promise<{ op: RecordedOp; state: SyncState; uid: string }> {
  const { db, driver } = store;
  const uid = uidOf(db, table, id);
  assert.ok(uid, `${table} ${id} has no uid`);
  const ops = await opsFor(driver, table);
  const op = ops.at(-1);
  assert.ok(op, `no op recorded for ${table}`);
  assert.equal(op.entity_uid, uid, "the op names the row's uid");
  assert.equal(op.op, kind);
  const state = await readState(driver);
  assert.equal(op.counter, state.lamport, "the op carries this device's stamp");
  assert.equal(op.seq, state.lastSeq);
  const stamp = rowStamp(db, table, uid);
  assert.ok(stamp, `${table} ${uid} has no row stamp`);
  assert.equal(stamp.counter, op.counter, "the row's stamp is the op's stamp");
  assert.equal(stamp.device_id, state.deviceId);
  return { op, state, uid };
}

// ---------------------------------------------------------------------------
// Task 1 — notes, tasks, collections, reminders.
// ---------------------------------------------------------------------------

test("a note records create, update and delete, each with its op in the same commit", async () => {
  const store = openStore();
  const { db, driver } = store;
  const notes = createNotesRepo(driver);

  const id = await notes.createNote({
    title: "Trip plan",
    content: "pack",
    tags: ["travel"],
  });
  assert.equal(count(db, "SELECT count(*) AS n FROM notes"), 1);
  const created = await assertRecorded(store, "notes", id, "create");
  assert.equal(created.op.payload.title, "Trip plan");
  assert.equal(created.op.payload.tags, "travel", "tags travel comma-joined");
  assert.equal(created.op.counter, 1);
  assert.equal(created.op.seq, 1);

  await notes.updateNote(id, { title: "Trip plan v2" });
  const ops = await opsFor(driver, "notes");
  assert.equal(ops.length, 2, "the update appended a second op");
  const updated = ops[1];
  assert.ok(updated);
  assert.equal(updated.op, "update");
  assert.equal(updated.entity_uid, created.uid);
  assert.ok(
    updated.counter > created.op.counter,
    "the newer write outranks the one it replaced (§4.2)",
  );
  assert.equal(updated.payload.title, "Trip plan v2");
  assert.ok(
    updated.payload.updated_at !== undefined,
    "the op carries the row's updated_at, which the write changed",
  );

  await notes.deleteNote(id);
  assert.equal(count(db, "SELECT count(*) AS n FROM notes"), 0, "the row went");
  const afterDelete = await opsFor(driver, "notes");
  assert.equal(afterDelete.length, 3);
  assert.equal(afterDelete[2]?.op, "delete");
  assert.equal(afterDelete[2]?.entity_uid, created.uid);
  const tombstones = (await readTombstones(driver)).filter(
    (row) => row.entity_table === "notes",
  );
  assert.equal(tombstones.length, 1, "the delete left a tombstone (§5.1)");
  assert.equal(tombstones[0]?.entity_uid, created.uid);
  assert.equal(
    rowStamp(db, "notes", created.uid),
    undefined,
    "a deleted record keeps no row stamp — the tombstone carries the stamp",
  );
});

test("a task records create, update and delete, each with its op", async () => {
  const store = openStore();
  const { db, driver } = store;
  const tasks = createTasksRepo(driver);

  const id = await tasks.createTask({
    title: "Call shop",
    dueDate: "2026-11-20",
  });
  const created = await assertRecorded(store, "tasks", id, "create");
  assert.equal(created.op.payload.due_date, "2026-11-20");
  assert.equal(created.op.payload.done, 0);

  await tasks.updateTask(id, { dueDate: "2026-11-21" });
  const updated = (await opsFor(driver, "tasks"))[1];
  assert.ok(updated);
  assert.equal(updated.op, "update");
  assert.ok(updated.counter > created.op.counter);
  assert.deepEqual(updated.payload, { due_date: "2026-11-21" });

  await tasks.toggleTask(id, true);
  const toggled = (await opsFor(driver, "tasks"))[2];
  assert.ok(toggled);
  assert.equal(toggled.op, "toggle", "a done flag is a toggle (§2.3)");
  assert.deepEqual(toggled.payload, { done: 1 });

  await tasks.deleteTask(id);
  assert.equal(count(db, "SELECT count(*) AS n FROM tasks"), 0);
  const deleted = (await opsFor(driver, "tasks")).at(-1);
  assert.equal(deleted?.op, "delete");
  assert.equal(
    (await readTombstones(driver)).filter((row) => row.entity_table === "tasks")
      .length,
    1,
  );
});

test("a collection records its create and delete, and the notes it unlinked travel too", async () => {
  const store = openStore();
  const { db, driver } = store;
  const notes = createNotesRepo(driver);

  const collectionId = await notes.createCollection("Travel");
  const collection = await assertRecorded(
    store,
    "collections",
    collectionId,
    "create",
  );
  assert.equal(collection.op.payload.name, "Travel");

  const noteId = await notes.createNote({
    title: "Flight",
    content: "",
    collectionId,
  });
  const noteUid = uidOf(db, "notes", noteId);
  assert.ok(noteUid);
  const notesBefore = (await opsFor(driver, "notes")).length;

  await notes.deleteCollection(collectionId);
  assert.equal(count(db, "SELECT count(*) AS n FROM collections"), 0);
  const unlink = (await opsFor(driver, "notes")).at(-1);
  assert.ok(unlink);
  assert.equal(
    (await opsFor(driver, "notes")).length,
    notesBefore + 1,
    "clearing the link is a note mutation, so it records one op",
  );
  assert.equal(unlink.entity_uid, noteUid);
  assert.equal(unlink.op, "update");
  assert.deepEqual(unlink.payload, { collection_id: null });

  const collectionDelete = (await opsFor(driver, "collections")).at(-1);
  assert.equal(collectionDelete?.op, "delete");
  assert.equal(collectionDelete?.entity_uid, collection.uid);
  assert.equal(
    (await readTombstones(driver)).filter(
      (row) => row.entity_table === "collections",
    ).length,
    1,
    "the note was unlinked, not deleted, so only the collection is tombstoned",
  );
});

test("a reminder create carries this device's id, and its delete records", async () => {
  const store = openStore();
  const { db, driver } = store;
  const tasks = createTasksRepo(driver);
  const state = await readState(driver);

  const id = await tasks.createReminder({
    title: "Stand up",
    remindAt: "2026-11-20T09:00",
  });
  const created = await assertRecorded(store, "reminders", id, "create");
  const row = db
    .prepare("SELECT created_by_device_id FROM reminders WHERE id = ?")
    .get(id) as { created_by_device_id: string | null } | undefined;
  assert.equal(
    row?.created_by_device_id,
    state.deviceId,
    "§13.1 Option A: the creating device is stamped on the definition",
  );

  await tasks.deleteReminder(id);
  assert.equal(count(db, "SELECT count(*) AS n FROM reminders"), 0);
  assert.equal((await opsFor(driver, "reminders")).at(-1)?.op, "delete");
  assert.equal(
    (await readTombstones(driver)).filter(
      (row) => row.entity_table === "reminders",
    ).length,
    1,
  );
  assert.equal(created.op.payload.title, "Stand up");
});

test("a Budget entry records nothing: Stage 1's boundary is the eight tables", async () => {
  const store = openStore();
  const { db, driver } = store;
  db.exec(`
    INSERT INTO wallets (name, created_at) VALUES ('Cash', '2026-11-01');
    INSERT INTO expense_categories (name, created_at) VALUES ('Food', '2026-11-01');
  `);
  const budget = createBudgetRepo(driver);

  const entryId = await budget.createExpenseEntry({
    amountCents: 500,
    categoryId: 1,
    walletId: 1,
    entryDate: "2026-11-13",
  });
  assert.equal(
    count(db, "SELECT count(*) AS n FROM expense_entries"),
    1,
    "the entry itself is written",
  );
  assert.equal(entryId > 0, true);
  assert.equal(
    count(db, "SELECT count(*) AS n FROM sync_outbox"),
    0,
    "a Stage 2 table must never record a Stage 1 op (§12.1)",
  );
  assert.equal(count(db, "SELECT count(*) AS n FROM sync_row_stamps"), 0);
  assert.equal(
    (await readState(driver)).lamport,
    0,
    "and it must not spend a Lamport step either",
  );
});

// ---------------------------------------------------------------------------
// Task 2 — shopping's parent/child shapes and the habit toggle.
// ---------------------------------------------------------------------------

test("a shopping item records its own op, and a list delete tombstones every item it held", async () => {
  const store = openStore();
  const { db, driver } = store;
  const shopping = createShoppingRepo(driver);

  const listId = await shopping.createList("Groceries");
  const listOp = await assertRecorded(
    store,
    "shopping_lists",
    listId,
    "create",
  );

  const milk = await shopping.addItem(listId, "milk");
  const milkOp = await assertRecorded(store, "shopping_items", milk, "create");
  assert.equal(milkOp.op.payload.text, "milk");
  assert.equal(milkOp.op.payload.list_id, listId);

  const bread = await shopping.addItem(listId, "bread");
  const breadUid = uidOf(db, "shopping_items", bread);
  const milkUid = uidOf(db, "shopping_items", milk);
  assert.ok(breadUid && milkUid);

  await shopping.toggleItem(milk, true);
  const toggled = (await opsFor(driver, "shopping_items")).at(-1);
  assert.equal(toggled?.op, "toggle");
  assert.deepEqual(toggled?.payload, { done: 1 });

  await shopping.deleteList(listId);
  assert.equal(count(db, "SELECT count(*) AS n FROM shopping_lists"), 0);
  assert.equal(
    count(db, "SELECT count(*) AS n FROM shopping_items"),
    0,
    "the FK cascade removed the items",
  );
  const tombstones = await readTombstones(driver);
  assert.deepEqual(
    tombstones.map((row) => row.entity_uid).sort(),
    [listOp.uid, milkUid, breadUid].sort(),
    "§5.2: the list AND every child it held are tombstoned — the cascade is not the record",
  );
  const deletes = (await readOutbox(driver)).filter(
    (row) => row.op === "delete",
  );
  assert.equal(
    deletes.length,
    3,
    "each tombstone travels as its own delete op",
  );
});

test("a habit check-in and its un-check each record exactly one op", async () => {
  const store = openStore();
  const { db, driver } = store;
  const habits = createHabitsRepo(driver);

  const habitId = await habits.createHabit("Run");
  const habit = await assertRecorded(store, "habits", habitId, "create");
  assert.equal(habit.op.payload.name, "Run");

  assert.equal(await habits.toggleLog(habitId, "2026-11-13"), true);
  assert.equal(count(db, "SELECT count(*) AS n FROM habit_logs"), 1);
  const logUid = uidOf(db, "habit_logs", 1);
  assert.ok(logUid);
  let logs = await opsFor(driver, "habit_logs");
  assert.equal(logs.length, 1, "a check-in is one create op");
  assert.equal(logs[0]?.op, "create");
  assert.equal(logs[0]?.entity_uid, logUid);

  assert.equal(await habits.toggleLog(habitId, "2026-11-13"), false);
  assert.equal(count(db, "SELECT count(*) AS n FROM habit_logs"), 0);
  logs = await opsFor(driver, "habit_logs");
  assert.equal(logs.length, 2, "and an un-check is one delete op");
  assert.equal(logs[1]?.op, "delete");
  assert.equal(logs[1]?.entity_uid, logUid);
  assert.equal(
    (await readTombstones(driver)).filter(
      (row) => row.entity_table === "habit_logs",
    ).length,
    1,
  );
});

test("deleting a habit tombstones the habit and every check-in it held", async () => {
  const store = openStore();
  const { db, driver } = store;
  const habits = createHabitsRepo(driver);

  const habitId = await habits.createHabit("Read");
  const habitOp = await assertRecorded(store, "habits", habitId, "create");
  await habits.toggleLog(habitId, "2026-11-11");
  await habits.toggleLog(habitId, "2026-11-12");
  const logUids = (await readOutbox(driver))
    .filter((row) => row.entity_table === "habit_logs")
    .map((row) => row.entity_uid);
  assert.equal(logUids.length, 2);

  await habits.deleteHabit(habitId);
  assert.equal(count(db, "SELECT count(*) AS n FROM habits"), 0);
  assert.equal(count(db, "SELECT count(*) AS n FROM habit_logs"), 0);
  const tombstoned = (await readTombstones(driver)).map(
    (row) => row.entity_uid,
  );
  assert.deepEqual(
    tombstoned.sort(),
    [habitOp.uid, ...logUids].sort(),
    "§5.2: the cascaded check-ins get their own tombstones",
  );
});

// ---------------------------------------------------------------------------
// Atomicity at the repository level.
// ---------------------------------------------------------------------------

test("a batch that fails midway leaves neither the mutation nor its op", async () => {
  const store = openStore();
  const { db, driver } = store;
  const notes = createNotesRepo(driver);
  const tasks = createTasksRepo(driver);

  // The mutation commits first in the batch and the op second, so an op that
  // cannot be written is exactly the crash-between-the-two §6.1 forbids.
  db.exec(
    "CREATE TRIGGER refuse_outbox BEFORE INSERT ON sync_outbox BEGIN SELECT RAISE(ABORT, 'outbox refused'); END",
  );

  await assert.rejects(
    notes.createNote({ title: "Never lands", content: "body" }),
    /outbox refused/,
  );
  assert.equal(
    count(db, "SELECT count(*) AS n FROM notes"),
    0,
    "the note must not survive its refused op",
  );
  assert.equal(
    (await readState(driver)).lamport,
    0,
    "nor may the clock have advanced",
  );

  await assert.rejects(
    tasks.createTask({ title: "Never lands" }),
    /outbox refused/,
  );
  assert.equal(count(db, "SELECT count(*) AS n FROM tasks"), 0);

  // And the reverse direction: a refused delete leaves the row and no tombstone.
  db.exec("DROP TRIGGER refuse_outbox");
  const id = await notes.createNote({ title: "Stays", content: "" });
  db.exec(
    "CREATE TRIGGER refuse_outbox_delete BEFORE INSERT ON sync_outbox WHEN NEW.op = 'delete' BEGIN SELECT RAISE(ABORT, 'delete refused'); END",
  );
  await assert.rejects(notes.deleteNote(id), /delete refused/);
  assert.equal(
    count(db, "SELECT count(*) AS n FROM notes"),
    1,
    "a failed op rolled the trash batch back whole",
  );
  assert.equal(count(db, "SELECT count(*) AS n FROM sync_tombstones"), 0);
});
