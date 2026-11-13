/**
 * §13.2's conflict copies, end to end on the shipped schema.
 *
 * Two seams meet here: `conflictCopyStatements` (what Stage 1's apply engine
 * prepends to a winning write) and `createTrashRepo` (what the Trash page
 * restores). The database is built from `BASELINE_SQL` in `schema.rs`, so the
 * `trash_items` CHECK, its two indexes and the unique uid indexes are the real
 * ones — a name that only exists in this test would not survive a real
 * constraint.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type {
  BatchStatement,
  DataDriver,
  ExecuteOutcome,
  Queryable,
} from "../../data/driver.ts";
import {
  createTrashRepo,
  restoreOpAllowed,
  type TrashListItem,
} from "../trash.ts";
import { CONFLICT_COPY_LABEL, type ConflictLoser } from "./bootstrap.ts";
import type { Origin } from "./protocol.ts";
import {
  conflictCopyStatements,
  type HeldConflictRow,
  type SnapshotOp,
  snapshotRowStatements,
} from "./store.ts";

const BASELINE = (() => {
  const src = readFileSync(
    new URL("../../../src-tauri/src/schema.rs", import.meta.url),
    "utf8",
  );
  const match = /pub const BASELINE_SQL: &str = r#"([\s\S]*?)"#;/.exec(src);
  assert.ok(match?.[1], "BASELINE_SQL must be readable from schema.rs");
  return match[1];
})();

const OFF_SHARE = {
  running: false,
  url: null,
  key: null,
  port: null,
  publishedAt: null,
  note: null,
};

function sqliteDriver(): DataDriver & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec(BASELINE);
  return {
    db,
    async query<T extends Queryable>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
    async execute(
      sql: string,
      params: unknown[] = [],
    ): Promise<ExecuteOutcome> {
      const result = db.prepare(sql).run(...(params as never[]));
      return {
        rowsAffected: Number(result.changes),
        lastInsertRowid: Number(result.lastInsertRowid),
      };
    },
    async batch(statements: BatchStatement[]) {
      db.exec("BEGIN");
      try {
        for (const [index, statement] of statements.entries()) {
          try {
            db.prepare(statement.sql).run(...(statement.params as never[]));
          } catch (error) {
            throw new Error(
              `batch statement ${index} failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async begin() {},
    async commit() {},
    async rollback() {},
    async resetTxn() {},
    async savePhoto() {
      return "photos/test.jpg";
    },
    async readPhoto() {
      return new Uint8Array();
    },
    async readPhotoThumb() {
      return new Uint8Array();
    },
    async savePhotoThumb() {
      return "photos/test.thumb.jpg";
    },
    async deletePhoto() {},
    async saveBackupFile() {},
    async saveExportFile() {},
    async saveDbKeyFile() {},
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
    async safetyBackupCopy() {
      throw new Error("no safety copy in this test driver");
    },
    async shareArm() {
      return "";
    },
  };
}

const NOTE_UID = "11111111-1111-4111-8111-111111111111";

/** A note this device holds, with the values about to lose. */
const LOSING_NOTE = {
  id: 1,
  uid: NOTE_UID,
  title: "Losing title",
  content: "losing body",
  tags: "",
  collection_id: null,
  pinned: 0,
  archived: 0,
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
};

function seedLosingNote(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO notes (id, uid, title, content, tags, collection_id, pinned, archived, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, 0, 0, ?, ?)`,
  ).run(
    LOSING_NOTE.id,
    LOSING_NOTE.uid,
    LOSING_NOTE.title,
    LOSING_NOTE.content,
    LOSING_NOTE.tags,
    LOSING_NOTE.created_at,
    LOSING_NOTE.updated_at,
  );
}

function losingNoteLoser(): ConflictLoser {
  return {
    table: "notes",
    uid: NOTE_UID,
    loser: "mobile",
    label: CONFLICT_COPY_LABEL,
    kept: { title: LOSING_NOTE.title, content: LOSING_NOTE.content },
    won: { title: "Winning title", content: "winning body" },
  };
}

function heldLosingNote(): HeldConflictRow {
  return { table: "notes", uid: NOTE_UID, row: { ...LOSING_NOTE } };
}

/** §9.5's winning side as the snapshot apply writes it: same uid, new values. */
function winningNoteOp(): SnapshotOp {
  return {
    table: "notes",
    uid: NOTE_UID,
    stamp: { counter: 9, deviceId: "desktop-7f3c", opId: "desktop-7f3c#9" },
    fields: {
      title: "Winning title",
      content: "winning body",
      tags: "",
      collection_uid: null,
      pinned: 0,
      archived: 0,
      created_at: "2026-01-01",
      updated_at: "2026-01-02",
    },
  };
}

interface TrashRow {
  id: number;
  entity_type: string;
  entity_id: number;
  snapshot: string;
  deleted_at: string;
}

function trashRows(db: DatabaseSync): TrashRow[] {
  return db
    .prepare(
      "SELECT id, entity_type, entity_id, snapshot, deleted_at FROM trash_items ORDER BY id",
    )
    .all() as unknown as TrashRow[];
}

function noteRows(
  db: DatabaseSync,
): { id: number; uid: string; title: string }[] {
  return db.prepare("SELECT id, uid, title FROM notes ORDER BY id").all() as {
    id: number;
    uid: string;
    title: string;
  }[];
}

test("the copy and the winning apply land in one batch: winner live, loser archived (§5.5)", async () => {
  const driver = sqliteDriver();
  const { db } = driver;
  seedLosingNote(db);

  await driver.batch([
    ...conflictCopyStatements(
      [losingNoteLoser()],
      [heldLosingNote()],
      "2026-03-01",
    ),
    ...snapshotRowStatements(winningNoteOp()),
  ]);

  const notes = noteRows(db);
  assert.equal(
    notes.length,
    1,
    "the winner is the same record, not a second one",
  );
  assert.equal(
    notes[0]?.title,
    "Winning title",
    "the winning value is in place",
  );
  assert.equal(notes[0]?.uid, NOTE_UID, "the winner keeps the uid");

  const trash = trashRows(db);
  assert.equal(trash.length, 1, "exactly one copy was archived");
  assert.equal(trash[0]?.entity_type, "note");
  assert.equal(
    trash[0]?.entity_id,
    LOSING_NOTE.id,
    "the copy names the row it lost",
  );
  const snapshot = JSON.parse(trash[0]?.snapshot ?? "{}");
  assert.equal(snapshot.conflict.kind, "conflict_loser");
  assert.equal(snapshot.conflict.label, CONFLICT_COPY_LABEL);
  assert.equal(
    snapshot.conflict.uid,
    NOTE_UID,
    "the marker keeps the losing uid",
  );
  assert.equal(
    snapshot.entity.title,
    "Losing title",
    "the copy keeps the losing values",
  );
  assert.deepEqual(snapshot.links, [], "a conflict copy archives no children");

  // What the user sees on the losing device only (§13.2): the label and the
  // winning value beside the copy.
  const listed = await createTrashRepo(driver).list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.title, "Losing title");
  assert.deepEqual(listed[0]?.conflict, {
    label: CONFLICT_COPY_LABEL,
    won: "Winning title",
  });
});

test("a batch that fails midway leaves neither the winner nor the copy", async () => {
  const driver = sqliteDriver();
  const { db } = driver;
  seedLosingNote(db);

  await assert.rejects(() =>
    driver.batch([
      ...conflictCopyStatements(
        [losingNoteLoser()],
        [heldLosingNote()],
        "2026-03-01",
      ),
      ...snapshotRowStatements(winningNoteOp()),
      { sql: "INSERT INTO not_a_table (id) VALUES (1)", params: [] },
    ]),
  );

  assert.equal(
    noteRows(db)[0]?.title,
    "Losing title",
    "the winning apply was rolled back with the copy",
  );
  assert.deepEqual(trashRows(db), [], "no orphaned Trash row was committed");
});

test("a loser on a non-archiving table produces no statements (§13.2)", () => {
  // Habit check-ins are not content (§9.5), Budget is append-only, Vault is
  // read-only and a reminder definition is not content — none of them archive.
  for (const table of [
    "habit_logs",
    "expense_entries",
    "vault_items",
    "reminders",
  ] as const) {
    const loser = { ...losingNoteLoser(), table } as ConflictLoser;
    assert.deepEqual(
      conflictCopyStatements([loser], [], "2026-03-01"),
      [],
      `${table} must not archive a conflict copy`,
    );
  }
});

test("restoring a conflict copy creates a new record with a new uid and never touches the winner (§13.2)", async () => {
  const driver = sqliteDriver();
  const { db } = driver;
  seedLosingNote(db);
  await driver.batch([
    ...conflictCopyStatements(
      [losingNoteLoser()],
      [heldLosingNote()],
      "2026-03-01",
    ),
    ...snapshotRowStatements(winningNoteOp()),
  ]);
  const trashId = trashRows(db)[0]?.id;
  assert.ok(trashId !== undefined);

  const trash = createTrashRepo(driver);
  await trash.restore(trashId);

  const notes = noteRows(db);
  assert.equal(notes.length, 2, "the copy came back as a second record");
  const winner = notes.find((note) => note.id === LOSING_NOTE.id);
  assert.equal(winner?.title, "Winning title", "the winner is untouched");
  assert.equal(winner?.uid, NOTE_UID, "the winner still owns the uid");
  const copy = notes.find((note) => note.id !== LOSING_NOTE.id);
  assert.equal(copy?.title, "Losing title");
  assert.notEqual(
    copy?.uid,
    NOTE_UID,
    "the copy never resurrects the losing uid",
  );
  assert.match(
    copy?.uid ?? "",
    /^[0-9a-f-]{36}$/,
    "the copy is an ordinary record with a freshly minted uid",
  );
  assert.deepEqual(trashRows(db), [], "the copy left the Trash");
});

/** Trash a note and restore it on a device of `origin`; answer the ops made. */
async function restoreNoteOps(
  origin: Origin,
): Promise<{ entity_table: string; op: string; entity_uid: string }[]> {
  const driver = sqliteDriver();
  const { db } = driver;
  seedLosingNote(db);
  const trash = createTrashRepo(driver, origin);
  await trash.trashEntity("note", LOSING_NOTE.id);
  const [item] = await trash.list();
  assert.ok(item);
  await trash.restore(item.id);
  assert.equal(
    noteRows(db)[0]?.uid,
    NOTE_UID,
    "the note comes back locally under its own uid either way",
  );
  return db
    .prepare(
      "SELECT entity_table, op, entity_uid FROM sync_outbox ORDER BY seq",
    )
    .all() as { entity_table: string; op: string; entity_uid: string }[];
}

test("a restore records its create op only where §2.3 allows one", async () => {
  const onPhone = await restoreNoteOps("mobile");
  assert.equal(onPhone.length, 1, "a two-way table records from the phone too");
  assert.equal(onPhone[0]?.entity_table, "notes");
  assert.equal(onPhone[0]?.op, "create", "a restore is a resurrection (§5.3)");
  assert.equal(onPhone[0]?.entity_uid, NOTE_UID);

  const onDesktop = await restoreNoteOps("desktop");
  assert.equal(onDesktop.length, 1, "the desktop records as before");

  // No Trash type is desktop-owned today (Notes, Tasks and Shopping are all
  // two-way), so the refusal branch is pinned on the rule itself: the synced
  // tables a restore could not record from the phone are the desktop-owned
  // and one-way ones.
  assert.equal(restoreOpAllowed("wallets", "mobile"), false);
  assert.equal(restoreOpAllowed("shops", "mobile"), false);
  assert.equal(restoreOpAllowed("vault_items", "mobile"), false);
  assert.equal(restoreOpAllowed("notes", "mobile"), true);
  assert.equal(restoreOpAllowed("tasks", "mobile"), true);
  assert.equal(restoreOpAllowed("wallets", "desktop"), true);
});

test("the ordinary delete → trash → restore round-trip is unchanged (notes and tasks)", async () => {
  const driver = sqliteDriver();
  const { db } = driver;
  seedLosingNote(db);
  db.prepare(
    `INSERT INTO tasks (id, uid, title, due_date, done, repeat, note, created_at)
     VALUES (1, '22222222-2222-4222-8222-222222222222', 'A task', NULL, 0, 'none', '', '2026-01-01')`,
  ).run();
  const trash = createTrashRepo(driver);

  await trash.trashEntity("note", LOSING_NOTE.id);
  const [noteCopy] = await trash.list();
  assert.equal(
    noteCopy?.conflict,
    null,
    "an ordinary Trash item is not a conflict copy",
  );
  assert.equal(noteCopy?.title, "Losing title");
  await trash.restore(noteCopy?.id ?? -1);
  const restoredNote = noteRows(db)[0];
  assert.equal(
    restoredNote?.uid,
    NOTE_UID,
    "a note comes back as the same record",
  );

  await trash.trashEntity("task", 1);
  const [taskCopy] = await trash.list();
  await trash.restore(taskCopy?.id ?? -1);
  const [task] = db.prepare("SELECT id, uid, title FROM tasks").all() as {
    id: number;
    uid: string;
    title: string;
  }[];
  assert.equal(task?.uid, "22222222-2222-4222-8222-222222222222");
  assert.equal(task?.title, "A task");
  assert.deepEqual(trashRows(db), []);
});

test("a shopping conflict copy is a plain Trash row and survives a restart (§13.2)", async () => {
  const driver = sqliteDriver();
  const { db } = driver;
  db.prepare(
    "INSERT INTO shopping_lists (id, uid, name, created_at) VALUES (1, 'list-uid', 'Groceries', '2026-01-01')",
  ).run();
  db.prepare(
    "INSERT INTO shopping_items (id, uid, list_id, text, done, sort_order) VALUES (1, 'item-uid', 1, 'milk', 0, 0)",
  ).run();

  const losers: ConflictLoser[] = [
    {
      table: "shopping_lists",
      uid: "list-uid",
      loser: "desktop",
      label: CONFLICT_COPY_LABEL,
      kept: { name: "Groceries (mine)" },
      won: { name: "Groceries" },
    },
    {
      table: "shopping_items",
      uid: "item-uid",
      loser: "desktop",
      label: CONFLICT_COPY_LABEL,
      kept: { text: "milk 2L" },
      won: { text: "milk" },
    },
  ];
  const held: HeldConflictRow[] = [
    {
      table: "shopping_lists",
      uid: "list-uid",
      row: {
        id: 1,
        uid: "list-uid",
        name: "Groceries (mine)",
        created_at: "2026-01-01",
      },
    },
    {
      table: "shopping_items",
      uid: "item-uid",
      row: {
        id: 1,
        uid: "item-uid",
        list_id: 1,
        text: "milk 2L",
        done: 0,
        sort_order: 0,
      },
    },
  ];
  await driver.batch(conflictCopyStatements(losers, held, "2026-03-01"));

  // A fresh repository — a restart, as far as the database is concerned: the
  // copies are ordinary `trash_items` rows, so nothing in memory matters.
  const listed: TrashListItem[] = await createTrashRepo(driver).list();
  assert.deepEqual(
    listed.map((item) => [item.entity_type, item.title, item.conflict?.won]),
    [
      ["shopping_item", "milk 2L", "milk"],
      ["shopping_list", "Groceries (mine)", "Groceries"],
    ],
  );
  assert.deepEqual(
    listed.map((item) => item.conflict?.label),
    [CONFLICT_COPY_LABEL, CONFLICT_COPY_LABEL],
  );
});
