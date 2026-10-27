// Quick capture.
//
// Two layers, on purpose:
//
// 1. Mock-driver tests assert the SHAPE of what the repository asks for —
//    which statements, which parameters, and that the whole conversion is ONE
//    batch. That is the convention every other repo test follows.
// 2. A real-SQLite driver runs the SAME statements, because the property that
//    matters cannot be seen through a mock: that a double conversion produces
//    exactly one target. `node:sqlite` is a Node built-in, so this costs no
//    dependency and no Rust round trip — but it executes the SQL as SQLite
//    will, which is the only place "idempotent" means anything.

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
import { appendJournalBlock, JOURNAL_BLOCK_SEPARATOR } from "./drafts.ts";
import { isMessageKeyError } from "./i18n.ts";
import {
  convertStatements,
  createInboxRepo,
  INBOX_TARGETS,
  inboxTitle,
  journalBlock,
  targetKey,
} from "./inbox.ts";
import type { InboxRow } from "./types.ts";

// ---------------------------------------------------------------------------
// A real SQLite database behind the DataDriver interface
// ---------------------------------------------------------------------------

/**
 * The four tables a conversion touches, with the production DDL.
 *
 * Copied rather than parsed out of `schema.rs`: the Rust schema is applied by
 * the app at boot and there is no way to read it from a node test, and the
 * `cargo test` suite pins the real DDL's constraints separately. What this
 * harness must reproduce faithfully is the SQL the repository emits — and that
 * is imported, not restated.
 */
const SQLITE_FIXTURE = `
CREATE TABLE inbox_items (
  id             INTEGER PRIMARY KEY,
  body           TEXT NOT NULL CHECK (length(trim(body, char(9)||char(10)||char(11)||char(12)||char(13)||' ')) > 0),
  status         TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'converted', 'archived')),
  converted_type TEXT CHECK (converted_type IN ('note', 'task', 'journal')),
  converted_id   INTEGER,
  created_at     TEXT NOT NULL,
  CHECK (
    (status = 'converted' AND converted_type IS NOT NULL AND converted_id IS NOT NULL)
    OR
    (status <> 'converted' AND converted_type IS NULL AND converted_id IS NULL)
  )
);
CREATE TABLE notes (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '',
  collection_id INTEGER,
  pinned      INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE tasks (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL,
  due_date   TEXT,
  done       INTEGER NOT NULL DEFAULT 0,
  repeat     TEXT NOT NULL DEFAULT 'none',
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE journal_entries (
  id         INTEGER PRIMARY KEY,
  entry_date TEXT NOT NULL UNIQUE,
  content    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/**
 * A `DataDriver` over `node:sqlite`. `batch` runs its statements in one
 * transaction, which is what the Rust driver does — the atomicity the
 * conversion depends on has to exist here too, or these tests would be
 * testing a weaker guarantee than production gets.
 */
function sqliteDriver(): DataDriver & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec(SQLITE_FIXTURE);
  const driver: DataDriver & { db: DatabaseSync } = {
    db,
    async query<T extends Queryable>(sql: string, params: unknown[] = []) {
      const rows = db.prepare(sql).all(...(params as never[]));
      return rows as T[];
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
      // The import confirm step calls this before it deletes anything
      // These suites never import, so there is nothing to
      // copy and a throw is the honest answer.
      throw new Error("no safety copy in this test driver");
    },
    async shareArm() {
      return "";
    },
  };
  return driver;
}

const OFF_SHARE = {
  running: false,
  url: null,
  key: null,
  port: null,
  publishedAt: null,
  note: null,
};

function rows<T>(db: DatabaseSync, sql: string): T[] {
  return db.prepare(sql).all() as T[];
}

// ---------------------------------------------------------------------------
// Titles and blocks
// ---------------------------------------------------------------------------

test("a note title is the first line that has something on it", () => {
  assert.equal(inboxTitle("buy milk"), "buy milk");
  assert.equal(inboxTitle("\n\n  \nfirst thought\nsecond"), "first thought");
  assert.equal(inboxTitle("  spaced   out  "), "spaced out");
  // A tab-separated line collapses like any other whitespace.
  assert.equal(inboxTitle("\t\tindented"), "indented");
});

test("a derived title never invents more than the body says", () => {
  const body = `${"x".repeat(400)}\nmore`;
  const title = inboxTitle(body);
  assert.ok(title.length <= 60, `title was ${title.length} characters`);
  assert.ok(title.endsWith("…"), "a capped title says so");
  // And the whole body is still there to be stored as content.
  assert.ok(body.startsWith(title.slice(0, -1)));
});

test("a one-line capture keeps its full text as the title", () => {
  const body = "call the supplier about the 40,000 kyat invoice";
  assert.equal(inboxTitle(body), body);
});

test("the journal block is the captured text, unmodified", () => {
  assert.equal(
    journalBlock("thought one\nthought two"),
    "thought one\nthought two",
  );
});

test("the inbox and the notes flow share one journal separator", () => {
  assert.equal(JOURNAL_BLOCK_SEPARATOR, "\n\n---\n\n");
  assert.equal(
    appendJournalBlock("existing", "block"),
    `existing${JOURNAL_BLOCK_SEPARATOR}block`,
  );
});

// ---------------------------------------------------------------------------
// The statements themselves
// ---------------------------------------------------------------------------

test("a conversion is ONE batch, and every statement is claimed on status", () => {
  for (const target of INBOX_TARGETS) {
    const statements = convertStatements(7, target, "a thought", "2026-10-18");
    assert.equal(
      statements.length,
      2,
      `${target}: expected a write and a claim`,
    );
    for (const s of statements) {
      assert.match(s.sql, /status = 'open'/, `${target}: unclaimed statement`);
    }
    const claim = statements[1];
    assert.match(claim?.sql ?? "", /^UPDATE inbox_items/);
    assert.match(claim?.sql ?? "", /converted_type = \?/);
  }
});

test("a note conversion derives the title and keeps the whole body", () => {
  const [insert] = convertStatements(
    1,
    "note",
    "buy milk\nand eggs",
    "2026-10-18",
  );
  assert.equal(insert?.params?.[0], "buy milk");
  assert.equal(insert?.params?.[1], "buy milk\nand eggs");
  // No due date, no repeat, no collection: a capture carries none of that.
  assert.match(insert?.sql ?? "", /SELECT \?, \?, '', NULL, 0, 0/);
});

test("a task conversion infers no date and no recurrence", () => {
  const [insert] = convertStatements(1, "task", "call supplier", "2026-10-18");
  // title, created_at, inbox id — the date column is a literal NULL, not a guess.
  assert.equal(insert?.params?.[0], "call supplier");
  assert.match(String(insert?.params?.[1] ?? ""), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(insert?.sql ?? "", /SELECT \?, NULL, 0, 'none', '', \?/);
});

test("a journal conversion targets one entry date and appends", () => {
  const statements = convertStatements(1, "journal", "a thought", "2026-10-18");
  assert.equal(statements[0]?.params?.[0], "2026-10-18");
  assert.equal(
    statements[0]?.params?.[5],
    JOURNAL_BLOCK_SEPARATOR,
    "the separator is bound, not written into the SQL",
  );
  assert.match(
    statements[0]?.sql ?? "",
    /ON CONFLICT\(entry_date\) DO UPDATE SET/,
  );
  assert.match(statements[0]?.sql ?? "", /journal_entries\.content \|\| \?/);
  // The claim reads the entry's own id rather than the last insert, because an
  // ON CONFLICT update does not move last_insert_rowid().
  assert.match(statements[1]?.sql ?? "", /SELECT id FROM journal_entries/);
});

test("an unknown target is refused rather than guessed at", () => {
  assert.throws(
    () => convertStatements(1, "calendar" as never, "x", "2026-10-18"),
    /Unknown capture target/,
  );
});

// ---------------------------------------------------------------------------
// Against real SQLite
// ---------------------------------------------------------------------------

test("capture stores one open row and refuses a blank one", async () => {
  const repo = createInboxRepo(sqliteDriver());
  const id = await repo.create("  buy milk  ");
  assert.equal(id, 1);
  const open = await repo.listOpen();
  assert.equal(open.length, 1);
  assert.equal(open[0]?.body, "buy milk", "the body is stored trimmed");
  assert.equal(open[0]?.status, "open");
  assert.equal(open[0]?.converted_type, null);
  for (const blank of ["", "   ", "\n\t ", "  \r\n  "]) {
    await assert.rejects(() => repo.create(blank), /Type something/);
  }
  assert.equal((await repo.listOpen()).length, 1, "no blank row was stored");
});

test("a note conversion records the note it created", async () => {
  const driver = sqliteDriver();
  const repo = createInboxRepo(driver);
  const id = await repo.create("buy milk\nand eggs");
  const result = await repo.convert(id, "note");
  assert.equal(result.type, "note");

  const notes = rows<{ id: number; title: string; content: string }>(
    driver.db,
    "SELECT id, title, content FROM notes",
  );
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.id, result.id);
  assert.equal(notes[0]?.title, "buy milk");
  assert.equal(notes[0]?.content, "buy milk\nand eggs");
  assert.deepEqual(await repo.listOpen(), [], "the capture left the inbox");
});

test("a second conversion of the same capture produces no second target", async () => {
  const driver = sqliteDriver();
  const repo = createInboxRepo(driver);
  const id = await repo.create("buy milk");
  const first = await repo.convert(id, "note");
  const second = await repo.convert(id, "note");
  assert.equal(rows(driver.db, "SELECT id FROM notes").length, 1);
  assert.equal(second.id, first.id, "the retry answers with the first target");

  assert.equal(rows(driver.db, "SELECT id FROM tasks").length, 0);
});

test("two conversions racing produce exactly one target", async () => {
  const driver = sqliteDriver();
  const repo = createInboxRepo(driver);
  const id = await repo.create("buy milk");
  // Both calls read the row as open before either batch runs — the interleaving
  // a double-click produces.
  const [a, b] = await Promise.all([
    repo.convert(id, "note"),
    repo.convert(id, "note"),
  ]);
  assert.equal(rows(driver.db, "SELECT id FROM notes").length, 1);
  assert.equal(a.id, b.id);
  assert.deepEqual(a, b, "both callers are answered with the same target");
});

test("a capture cannot be converted into two different things", async () => {
  const driver = sqliteDriver();
  const repo = createInboxRepo(driver);
  const id = await repo.create("ambiguous thought");
  const [note, task] = await Promise.all([
    repo.convert(id, "note"),
    repo.convert(id, "task"),
  ]);
  assert.equal(
    rows(driver.db, "SELECT id FROM notes").length +
      rows(driver.db, "SELECT id FROM tasks").length,
    1,
  );
  // Both callers get an answer, and both answers name the same target.
  assert.equal(note.id, task.id);
  assert.equal(note.type, task.type);
});

test("a journal conversion appends to today and never overwrites", async () => {
  const driver = sqliteDriver();
  const repo = createInboxRepo(driver);
  const today = new Date();
  const entryDate = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("-");
  driver.db
    .prepare(
      "INSERT INTO journal_entries (id, entry_date, content, created_at, updated_at) VALUES (1, ?, 'what I already wrote today', 'x', 'x')",
    )
    .run(entryDate);

  const id = await repo.create("and one more thing");
  const result = await repo.convert(id, "journal");
  assert.equal(result.type, "journal");
  const entries = rows<{ id: number; content: string }>(
    driver.db,
    "SELECT id, content FROM journal_entries",
  );
  assert.equal(entries.length, 1, "still one entry per day");
  assert.equal(
    entries[0]?.id,
    result.id,
    "the claim recorded today's entry id",
  );
  assert.match(
    entries[0]?.content ?? "",
    /^what I already wrote today\n\n---\n\nand one more thing$/,
    "existing text first, then the block",
  );
});

test("two journal captures on the same day both survive", async () => {
  const driver = sqliteDriver();
  const repo = createInboxRepo(driver);
  const a = await repo.create("first thing");
  const b = await repo.create("second thing");
  await repo.convert(a, "journal");
  await repo.convert(b, "journal");
  const entries = rows<{ content: string }>(
    driver.db,
    "SELECT content FROM journal_entries",
  );
  assert.equal(entries.length, 1);
  const content = entries[0]?.content ?? "";
  assert.ok(content.includes("first thing"));
  assert.ok(content.includes("second thing"));
  assert.ok(
    content.indexOf("first thing") < content.indexOf("second thing"),
    "the blocks keep their order",
  );
});

test("a journal conversion on a day with no entry creates just the block", async () => {
  const driver = sqliteDriver();
  const repo = createInboxRepo(driver);
  const id = await repo.create("a quiet day");
  await repo.convert(id, "journal");
  const entries = rows<{ content: string }>(
    driver.db,
    "SELECT content FROM journal_entries",
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.content, "a quiet day", "no leading separator");
});

test("an archived capture cannot be converted", async () => {
  const driver = sqliteDriver();
  const repo = createInboxRepo(driver);
  const id = await repo.create("put this away");
  await repo.archive(id);
  await assert.rejects(() => repo.convert(id, "note"), /archived/);
  assert.equal(rows(driver.db, "SELECT id FROM notes").length, 0);
});

test("converting a capture that no longer exists is refused", async () => {
  const repo = createInboxRepo(sqliteDriver());
  await assert.rejects(() => repo.convert(404, "note"), /no longer exists/);
});

test("refused conversions carry a translation key, not a bare sentence (D11)", async () => {
  // The inbox page is fully localized, and these refusals are reached exactly
  // on the stale-list and raced-click paths: the key is what the page renders,
  // the English `message` is only the readable fallback the assertions above
  // match on.
  const repo = createInboxRepo(sqliteDriver());
  const id = await repo.create("put this away");
  await repo.archive(id);
  await assert.rejects(
    () => repo.convert(id, "note"),
    (e: unknown) =>
      isMessageKeyError(e) && e.messageKey === "inbox.convertArchived",
  );
  await assert.rejects(
    () => repo.convert(404, "note"),
    (e: unknown) =>
      isMessageKeyError(e) && e.messageKey === "inbox.convertGone",
  );
});

test("a converted capture survives its target being deleted", async () => {
  const driver = sqliteDriver();
  const repo = createInboxRepo(driver);
  const id = await repo.create("buy milk");
  const result = await repo.convert(id, "note");
  driver.db.prepare("DELETE FROM notes WHERE id = ?").run(result.id);

  const converted = await repo.listByStatus("converted");
  assert.equal(converted.length, 1);
  assert.equal(converted[0]?.converted_type, "note");
  assert.equal(
    converted[0]?.converted_id,
    result.id,
    "the reference is historical",
  );
  const live = await repo.liveTargets(converted);
  assert.equal(live.get(targetKey("note", result.id)), false, "unavailable");
  // And it is never silently reconverted by asking again.
  const again = await repo.convert(id, "note");
  assert.deepEqual(again, result, "asking again returns the recorded target");
  assert.equal(rows(driver.db, "SELECT id FROM notes").length, 0);
});

test("liveTargets reports each recorded target across all three tables", async () => {
  const driver = sqliteDriver();
  const repo = createInboxRepo(driver);
  const note = await repo.convert(await repo.create("a"), "note");
  const task = await repo.convert(await repo.create("b"), "task");
  const journal = await repo.convert(await repo.create("c"), "journal");
  const converted = await repo.listByStatus("converted");
  const live = await repo.liveTargets(converted);
  assert.equal(live.get(targetKey("note", note.id)), true);
  assert.equal(live.get(targetKey("task", task.id)), true);
  assert.equal(live.get(targetKey("journal", journal.id)), true);
  driver.db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id);
  const after = await repo.liveTargets(await repo.listByStatus("converted"));
  assert.equal(after.get(targetKey("task", task.id)), false);
  assert.equal(after.get(targetKey("note", note.id)), true);
});

test("a deleted capture is gone from the list", async () => {
  const driver = sqliteDriver();
  const repo = createInboxRepo(driver);
  const id = await repo.create("temporary");
  await repo.deleteItem(id);
  assert.deepEqual(await repo.listOpen(), []);
  // And deleting a converted capture does not touch the target it produced.
  const converted = await repo.convert(await repo.create("kept"), "task");
  await repo.deleteItem(2);
  assert.equal(rows(driver.db, "SELECT id FROM tasks").length, 1);
  assert.equal(
    rows<{ id: number }>(driver.db, "SELECT id FROM tasks")[0]?.id,
    converted.id,
  );
});

// ---------------------------------------------------------------------------
// Through the mock driver: the statements the repository actually issues
// ---------------------------------------------------------------------------

test("the repository sends one batch per conversion", async () => {
  const driver = createMockDriver({
    results: [[openRow()], [convertedRow()]],
  });
  const repo = createInboxRepo(driver);
  await repo.convert(3, "task");
  const batches = driver.callsTo("batch");
  assert.equal(
    batches.length,
    1,
    "the target write and the claim are one batch",
  );
  const statements = first(batches, "batch").args[0] as BatchStatement[];
  assert.equal(statements.length, 2);
  assert.deepEqual(statements[1]?.params, ["task", 3]);
});

test("a converted capture is answered from the row, without writing", async () => {
  const driver = createMockDriver({ results: [[convertedRow()]] });
  const repo = createInboxRepo(driver);
  const result = await repo.convert(9, "note");
  assert.equal(result.type, "task");
  assert.equal(result.id, 42);
  assert.equal(driver.callsTo("batch").length, 0, "a retry must not write");
  assert.equal(driver.callsTo("execute").length, 0);
});

test("a batch that did not convert the capture is reported, not swallowed", async () => {
  const driver = createMockDriver({ results: [[openRow()], [openRow()]] });
  const repo = createInboxRepo(driver);
  await assert.rejects(() => repo.convert(4, "note"), /not converted/);
});

function openRow(): InboxRow {
  return {
    id: 4,
    body: "a thought",
    status: "open",
    converted_type: null,
    converted_id: null,
    created_at: "2026-10-18",
  };
}

function convertedRow(): InboxRow {
  return {
    id: 9,
    body: "a thought",
    status: "converted",
    converted_type: "task",
    converted_id: 42,
    created_at: "2026-10-18",
  };
}
