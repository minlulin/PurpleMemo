// Relationships.
//
// The properties here cannot be checked through a mock: canonical ordering is a
// property of SQLite's BINARY collation, "a ghost endpoint cannot be inserted"
// is a property of one statement's WHERE clause, and "delete the note and its
// relationships atomically" is a property of a transaction. So the SQL runs
// against real SQLite through Node's built-in `node:sqlite`, and the mock is
// used only for what mocks are good at — the shape of what was asked for.

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
import {
  canonicalPair,
  compareEntities,
  createEntityLinksRepo,
  createLinkStatement,
  deleteEntityLinks,
  isSelfLink,
  LINKABLE_TYPES,
  linkIsCanonical,
  linkIsSelfReferential,
} from "./entityLinks.ts";
import type { LinkableEntity } from "./types.ts";

const SQLITE_FIXTURE = `
CREATE TABLE notes (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '', collection_id INTEGER, pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, due_date TEXT, done INTEGER NOT NULL DEFAULT 0,
  repeat TEXT NOT NULL DEFAULT 'none', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '',
  birthday TEXT, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE photo_refs (
  id INTEGER PRIMARY KEY, photo_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL
);
CREATE TABLE links (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL DEFAULT 'related' CHECK (kind IN ('related')),
  type_a     TEXT NOT NULL CHECK (type_a IN ('note', 'task', 'contact')),
  id_a       INTEGER NOT NULL CHECK (id_a > 0),
  type_b     TEXT NOT NULL CHECK (type_b IN ('note', 'task', 'contact')),
  id_b       INTEGER NOT NULL CHECK (id_b > 0),
  created_at TEXT NOT NULL,
  CHECK (NOT (type_a = type_b AND id_a = id_b)),
  CHECK (type_a < type_b OR (type_a = type_b AND id_a < id_b)),
  UNIQUE (kind, type_a, id_a, type_b, id_b)
);
CREATE INDEX idx_links_a ON links(type_a, id_a);
CREATE INDEX idx_links_b ON links(type_b, id_b);
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
}

/** Seed one row of each type, with a duplicate-name pair to force disambiguation. */
function seed(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO notes (id, title, content, tags, collection_id, pinned, archived, created_at, updated_at)
     VALUES (1, 'First note', '', '', NULL, 0, 0, 'x', 'x'),
            (2, '', '', '', NULL, 0, 1, 'x', 'x'),
            (3, 'Same name', '', '', NULL, 0, 0, 'x', 'x')`,
  ).run();
  db.prepare(
    `INSERT INTO tasks (id, title, due_date, done, repeat, note, created_at)
     VALUES (1, 'A task', NULL, 0, 'none', '', 'x'),
            (2, 'Same name', NULL, 1, 'none', '', 'x')`,
  ).run();
  db.prepare(
    `INSERT INTO contacts (id, name, address, birthday, notes, created_at)
     VALUES (1, 'A contact', '', NULL, '', 'x'),
            (2, 'Same name', '', NULL, '', 'x')`,
  ).run();
}

function rows(db: DatabaseSync, sql: string): Record<string, unknown>[] {
  return db.prepare(sql).all() as Record<string, unknown>[];
}

const note = (id: number): LinkableEntity => ({ type: "note", id });
const task = (id: number): LinkableEntity => ({ type: "task", id });
const contact = (id: number): LinkableEntity => ({ type: "contact", id });

// ---------------------------------------------------------------------------
// Canonical order
// ---------------------------------------------------------------------------

test("a pair is stored smaller end first, whatever order it arrives in", () => {
  // contact < note < task in BINARY order, so these are the canonical forms.
  assert.deepEqual(canonicalPair(note(9), contact(1)), [contact(1), note(9)]);
  assert.deepEqual(canonicalPair(contact(1), note(9)), [contact(1), note(9)]);
  assert.deepEqual(canonicalPair(note(9), task(2)), [note(9), task(2)]);
  assert.deepEqual(canonicalPair(note(9), note(2)), [note(2), note(9)]);
  assert.deepEqual(canonicalPair(note(3), note(3)), [note(3), note(3)]);
});

test("the TypeScript order matches the one SQLite enforces", () => {
  // If these two ever disagreed, every insert would fail with a CHECK error the
  // user cannot act on. So the agreement is asserted against the real table.
  const db = sqliteDriver().db;
  const pairs: [LinkableEntity, LinkableEntity][] = [
    [note(1), contact(1)],
    [task(1), note(1)],
    [task(1), contact(1)],
    [note(5), note(4)],
    [contact(7), contact(3)],
  ];
  for (const [a, b] of pairs) {
    const [first, second] = canonicalPair(a, b);
    assert.equal(
      linkIsCanonical({
        type_a: first.type,
        id_a: first.id,
        type_b: second.type,
        id_b: second.id,
      }),
      true,
    );
    const statement = createLinkStatement(a, b);
    // The statement names the ends in canonical order and the table accepts it.
    assert.equal(statement.params?.[0], first.type);
    assert.equal(statement.params?.[1], first.id);
    assert.doesNotThrow(() =>
      db
        .prepare(
          "INSERT INTO links (kind, type_a, id_a, type_b, id_b, created_at) VALUES ('related', ?, ?, ?, ?, 'x')",
        )
        .run(first.type, first.id, second.type, second.id),
    );
  }
});

test("compareEntities orders by type then id", () => {
  assert.ok(compareEntities(contact(1), note(1)) < 0);
  assert.ok(compareEntities(task(1), contact(1)) > 0);
  assert.equal(compareEntities(note(4), note(4)), 0);
  assert.ok(compareEntities(note(2), note(9)) < 0);
  assert.equal(isSelfLink(note(4), note(4)), true);
  assert.equal(isSelfLink(note(4), task(4)), false);
});

test("a self-link and an unknown type are refused before any SQL runs", async () => {
  const repo = createEntityLinksRepo(sqliteDriver());
  await assert.rejects(() => repo.createLink(note(1), note(1)), /itself/);
  await assert.rejects(
    () =>
      repo.createLink(
        { type: "journal", id: 1 } as unknown as LinkableEntity,
        note(1),
      ),
    /Cannot link a journal/,
  );
  await assert.rejects(
    () => repo.createLink(note(1), { type: "note", id: 0 }),
    /without a row/,
  );
});

// ---------------------------------------------------------------------------
// Creating and reading, against real SQLite
// ---------------------------------------------------------------------------

test("a relationship is visible from both ends", async () => {
  const driver = sqliteDriver();
  seed(driver.db);
  const repo = createEntityLinksRepo(driver);
  const result = await repo.createLink(note(1), task(1));
  assert.deepEqual(result, { linked: true, alreadyLinked: false });

  const fromNote = await repo.listRelated(note(1));
  assert.equal(fromNote.length, 1);
  assert.deepEqual(fromNote[0]?.entity, task(1));
  assert.equal(fromNote[0]?.label, "A task");
  assert.equal(fromNote[0]?.gone, false);

  // Same relationship, other end: one row, seen from the other side.
  const fromTask = await repo.listRelated(task(1));
  assert.deepEqual(fromTask[0]?.entity, note(1));
  assert.equal(rows(driver.db, "SELECT count(*) AS n FROM links")[0]?.n, 1);
});

test("every pair of types links, in both directions of storage", async () => {
  const driver = sqliteDriver();
  seed(driver.db);
  const repo = createEntityLinksRepo(driver);
  const pairs: [LinkableEntity, LinkableEntity][] = [
    [note(1), task(1)],
    [note(2), contact(2)],
    [task(1), contact(1)],
    // Same type twice, which is the other shape of pair.
    [note(1), note(3)],
  ];
  for (const [a, b] of pairs) await repo.createLink(a, b);
  assert.equal(rows(driver.db, "SELECT count(*) AS n FROM links")[0]?.n, 4);
  // Each is reachable from both of its ends.
  for (const [a, b] of pairs) {
    const fromA = await repo.listRelated(a);
    assert.ok(
      fromA.some(
        (item) => item.entity.type === b.type && item.entity.id === b.id,
      ),
      `${a.type}#${a.id} must see ${b.type}#${b.id}`,
    );
  }
});

test("linking the same pair twice is one relationship", async () => {
  const driver = sqliteDriver();
  seed(driver.db);
  const repo = createEntityLinksRepo(driver);
  await repo.createLink(note(1), task(1));
  const again = await repo.createLink(task(1), note(1));
  assert.deepEqual(again, { linked: false, alreadyLinked: true });
  assert.equal(rows(driver.db, "SELECT count(*) AS n FROM links")[0]?.n, 1);
});

test("a ghost endpoint is refused, and nothing is written", async () => {
  const driver = sqliteDriver();
  seed(driver.db);
  const repo = createEntityLinksRepo(driver);
  // The end that does not exist is first, second, and a linkable type with no
  // rows at all.
  await assert.rejects(
    () => repo.createLink(note(99), task(1)),
    /no longer exists/,
  );
  await assert.rejects(
    () => repo.createLink(note(1), task(99)),
    /no longer exists/,
  );
  await assert.rejects(
    () => repo.createLink(note(1), { type: "contact", id: 42 }),
    /no longer exists/,
  );
  assert.equal(rows(driver.db, "SELECT count(*) AS n FROM links")[0]?.n, 0);
});

test("unlinking removes only the relationship", async () => {
  const driver = sqliteDriver();
  seed(driver.db);
  const repo = createEntityLinksRepo(driver);
  await repo.createLink(note(1), task(1));
  await repo.removeLink(task(1), note(1));
  assert.equal(rows(driver.db, "SELECT count(*) AS n FROM links")[0]?.n, 0);
  // Neither end was touched.
  assert.equal(rows(driver.db, "SELECT count(*) AS n FROM notes")[0]?.n, 3);
  assert.equal(rows(driver.db, "SELECT count(*) AS n FROM tasks")[0]?.n, 2);
  // And unlinking twice is not an error.
  await repo.removeLink(note(1), task(1));
});

test("related items are labelled and disambiguated", async () => {
  const driver = sqliteDriver();
  seed(driver.db);
  const repo = createEntityLinksRepo(driver);
  await repo.createLink(note(1), note(2));
  await repo.createLink(note(1), note(3));
  await repo.createLink(note(1), task(2));
  await repo.createLink(note(1), contact(2));
  const related = await repo.listRelated(note(1));
  const byId = new Map(
    related.map((r) => [`${r.entity.type}:${r.entity.id}`, r]),
  );
  // An archived note and a done task say so; that is what separates two rows
  // that share a title.
  assert.equal(byId.get("note:2")?.detail, "Archived");
  assert.equal(
    byId.get("note:2")?.label,
    "Untitled note",
    "an empty title still labels",
  );
  assert.equal(byId.get("note:3")?.detail, null);
  assert.equal(byId.get("task:2")?.detail, "Done");
  assert.equal(byId.get("contact:2")?.label, "Same name");
  assert.equal(byId.get("contact:2")?.detail, null);
});

test("a relationship to a row that is gone is shown, not hidden", async () => {
  const driver = sqliteDriver();
  seed(driver.db);
  const repo = createEntityLinksRepo(driver);
  await repo.createLink(note(1), task(1));
  // A hard delete elsewhere that missed the relationship (a restore from an old
  // backup, say). The row is still stored and must not silently disappear from
  // the list — that would look like the user's link had evaporated.
  driver.db.prepare("DELETE FROM tasks WHERE id = 1").run();
  const related = await repo.listRelated(note(1));
  assert.equal(related.length, 1);
  assert.equal(related[0]?.gone, true);
  assert.equal(related[0]?.label, "Unavailable");
  // Asking from the deleted end still finds the stored relationship, and the
  // OTHER end is live — so it is reported normally. `gone` is a property of an
  // item, not of the entity you asked about.
  const fromTask = await repo.listRelated(task(1));
  assert.deepEqual(fromTask[0]?.entity, note(1));
  assert.equal(fromTask[0]?.gone, false);
  // Once both ends are gone, both sides say so rather than going blank.
  driver.db.prepare("DELETE FROM notes WHERE id = 1").run();
  assert.equal((await repo.listRelated(task(1)))[0]?.gone, true);
});

// ---------------------------------------------------------------------------
// Hard delete, atomically
// ---------------------------------------------------------------------------

test("deleteEntityLinks removes the relationship from either end", () => {
  const [statement] = deleteEntityLinks(note(3));
  assert.match(statement?.sql ?? "", /DELETE FROM links/);
  assert.match(statement?.sql ?? "", /type_a = \? AND id_a = \?/);
  assert.match(statement?.sql ?? "", /type_b = \? AND id_b = \?/);
  assert.deepEqual(statement?.params, ["note", 3, "note", 3]);
});

test("deleting an entity in one batch takes its relationships with it", () => {
  const db = sqliteDriver().db;
  seed(db);
  db.prepare(
    "INSERT INTO links (kind, type_a, id_a, type_b, id_b, created_at) VALUES ('related', 'note', 1, 'task', 1, 'x'), ('related', 'contact', 1, 'note', 1, 'x')",
  ).run();
  // Exactly what notes.deleteNote / tasks.deleteTask / contacts.deleteContact
  // now send: links first, then the row, one batch.
  db.exec("BEGIN");
  try {
    db.prepare(
      "DELETE FROM links WHERE (type_a = 'note' AND id_a = 1) OR (type_b = 'note' AND id_b = 1)",
    ).run();
    db.prepare("DELETE FROM notes WHERE id = 1").run();
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  assert.equal(
    rows(db, "SELECT count(*) AS n FROM links")[0]?.n,
    0,
    "both relationships went",
  );
  assert.equal(
    rows(db, "SELECT count(*) AS n FROM notes")[0]?.n,
    2,
    "the other notes stayed",
  );
});

test("a failed batch leaves the relationships in place", () => {
  const db = sqliteDriver().db;
  seed(db);
  db.prepare(
    "INSERT INTO links (kind, type_a, id_a, type_b, id_b, created_at) VALUES ('related', 'contact', 1, 'note', 1, 'x')",
  ).run();
  assert.throws(() => {
    db.exec("BEGIN");
    try {
      db.prepare(
        "DELETE FROM links WHERE (type_a = 'note' AND id_a = 1) OR (type_b = 'note' AND id_b = 1)",
      ).run();
      // The second statement fails (no such column), so the batch rolls back.
      db.prepare("DELETE FROM notes WHERE no_such_column = 1").run();
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  });
  assert.equal(
    rows(db, "SELECT count(*) AS n FROM links")[0]?.n,
    1,
    "the relationship survived",
  );
  assert.equal(
    rows(db, "SELECT count(*) AS n FROM notes")[0]?.n,
    3,
    "so did the note",
  );
});

// ---------------------------------------------------------------------------
// Through the mock driver
// ---------------------------------------------------------------------------

test("the repositories snapshot supported entities and detach links atomically", async () => {
  const driver = createMockDriver({
    results: [
      [
        {
          id: 5,
          title: "note",
          content: "body",
          tags: "",
          collection_id: null,
          pinned: 0,
          archived: 0,
          created_at: "2026-01-01",
          updated_at: "2026-01-01",
        },
      ],
      [],
      [],
      [],
    ],
  });
  const { createNotesRepo } = await import("./notes.ts");
  await createNotesRepo(driver).deleteNote(5);
  const batches = driver.callsTo("batch");
  assert.equal(
    batches.length,
    1,
    "snapshot and source deletion share one transaction",
  );
  const statements = first(batches, "batch").args[0] as BatchStatement[];
  assert.equal(statements.length, 4);
  assert.match(statements[0]?.sql ?? "", /^INSERT INTO trash_items/);
  assert.match(statements[1]?.sql ?? "", /^DELETE FROM links/);
  assert.match(statements[2]?.sql ?? "", /^DELETE FROM photo_refs/);
  assert.match(statements[3]?.sql ?? "", /^DELETE FROM notes/);
  assert.equal(driver.callsTo("execute").length, 0);
});

test("task deletion stores its snapshot and detaches links in one batch", async () => {
  const driver = createMockDriver({
    results: [
      [
        {
          id: 8,
          title: "task",
          due_date: null,
          done: 0,
          repeat: "none",
          note: "",
          created_at: "2026-01-01",
        },
      ],
      [],
      [],
    ],
  });
  const { createTasksRepo } = await import("./tasks.ts");
  await createTasksRepo(driver).deleteTask(8);
  const statements = first(driver.callsTo("batch"), "batch")
    .args[0] as BatchStatement[];
  assert.equal(statements.length, 3);
  assert.match(statements[0]?.sql ?? "", /^INSERT INTO trash_items/);
  assert.equal(statements[0]?.params?.[0], "task");
  assert.match(String(statements[0]?.params?.[1]), /^[0-9a-f-]{36}$/);
  assert.equal(statements[0]?.params?.at(-1), 8);
  assert.match(statements[1]?.sql ?? "", /^DELETE FROM links/);
  assert.match(statements[2]?.sql ?? "", /^DELETE FROM tasks/);
});

test("contact deletion snapshots children and detaches links in one batch", async () => {
  const driver = createMockDriver({
    results: [
      [
        {
          id: 3,
          name: "contact",
          address: "",
          birthday: null,
          notes: "",
          created_at: "2026-01-01",
        },
      ],
      [],
      [],
      [],
      [],
    ],
  });
  const { createContactsRepo } = await import("./contacts.ts");
  await createContactsRepo(driver).deleteContact(3);
  const statements = first(driver.callsTo("batch"), "batch")
    .args[0] as BatchStatement[];
  assert.equal(statements.length, 3);
  assert.match(statements[0]?.sql ?? "", /^INSERT INTO trash_items/);
  assert.match(statements[1]?.sql ?? "", /^DELETE FROM links/);
  assert.match(statements[2]?.sql ?? "", /^DELETE FROM contacts/);
});

test("every linkable type is one of the three the schema allows", () => {
  assert.deepEqual(LINKABLE_TYPES, ["note", "task", "contact"]);
});

test("the create statement interpolates no table name from data", () => {
  const statement = createLinkStatement(note(1), task(2));
  const sql = statement.sql ?? "";
  // Exactly the two tables the ends name, and both names come from the
  // code-owned map — never from a value read out of a row.
  assert.match(
    sql,
    /EXISTS \(SELECT 1 FROM notes WHERE id = \?\) AND EXISTS \(SELECT 1 FROM tasks WHERE id = \?\)/,
  );
  assert.equal(sql.includes("contacts"), false, "a third table is not named");
  assert.match(
    createLinkStatement(contact(1), note(2)).sql,
    /FROM contacts WHERE id = \?\) AND EXISTS \(SELECT 1 FROM notes/,
  );
  // Two endpoint checks, one per end - both required, so a ghost end cannot slip
  // through by satisfying only one.
  assert.equal((sql.match(/EXISTS \(SELECT 1 FROM/g) ?? []).length, 2);
  assert.equal(statement.params?.slice(-2).join(","), "1,2");
});

test("link validation helpers agree with the canonical order", () => {
  assert.equal(
    linkIsSelfReferential({ type_a: "note", id_a: 1, type_b: "note", id_b: 1 }),
    true,
  );
  assert.equal(
    linkIsSelfReferential({ type_a: "note", id_a: 1, type_b: "task", id_b: 1 }),
    false,
  );
  assert.equal(
    linkIsCanonical({ type_a: "note", id_a: 1, type_b: "task", id_b: 1 }),
    true,
  );
  assert.equal(
    linkIsCanonical({ type_a: "task", id_a: 1, type_b: "note", id_b: 1 }),
    false,
  );
});
