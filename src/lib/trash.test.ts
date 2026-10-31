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
import { gatedQueryDriver, tick } from "../test-utils.ts";
import { createGalleryRepo, isPhotoCleanupPending } from "./gallery.ts";
import {
  createTrashRepo,
  TRASH_MAX_ITEMS,
  validateTrashPayload,
} from "./trash.ts";

const FIXTURE = `
CREATE TABLE notes (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
  tags TEXT NOT NULL, collection_id INTEGER, pinned INTEGER NOT NULL,
  archived INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, due_date TEXT, done INTEGER NOT NULL,
  repeat TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL,
  birthday TEXT, notes TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE contact_channels (
  id INTEGER PRIMARY KEY, contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, value TEXT NOT NULL, is_primary INTEGER NOT NULL, sort_order INTEGER NOT NULL
);
CREATE TABLE contact_tags (
  id INTEGER PRIMARY KEY, contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag TEXT NOT NULL, UNIQUE (contact_id, tag)
);
CREATE TABLE memories (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, memory_date TEXT NOT NULL,
  note TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE journal_entries (
  id INTEGER PRIMARY KEY, entry_date TEXT NOT NULL UNIQUE, content TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE photos (
  id INTEGER PRIMARY KEY, rel_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL,
  ext TEXT NOT NULL, size_bytes INTEGER NOT NULL, taken_date TEXT, note TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE photo_refs (
  id INTEGER PRIMARY KEY, photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL
);
CREATE TABLE links (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, type_a TEXT NOT NULL, id_a INTEGER NOT NULL,
  type_b TEXT NOT NULL, id_b INTEGER NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(kind, type_a, id_a, type_b, id_b)
);
CREATE TABLE inbox_items (
  id INTEGER PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL,
  converted_type TEXT, converted_id INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE trash_items (
  id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL,
  snapshot TEXT NOT NULL, deleted_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE collections (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const OFF_SHARE = {
  running: false,
  url: null,
  key: null,
  port: null,
  publishedAt: null,
  note: null,
};

function sqliteDriver(): DataDriver & {
  db: DatabaseSync;
  deletedFiles: string[];
} {
  const db = new DatabaseSync(":memory:");
  db.exec(FIXTURE);
  const deletedFiles: string[] = [];
  return {
    db,
    deletedFiles,
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
        for (const statement of statements) {
          db.prepare(statement.sql).run(...(statement.params as never[]));
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
    async deletePhoto(path) {
      deletedFiles.push(path);
    },
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
      //; these suites never import, so there is nothing to
      // copy and a throw is the honest answer.
      throw new Error("no safety copy in this test driver");
    },
    async shareArm() {
      return "";
    },
  };
}

function seedNote(db: DatabaseSync, id = 1, title = "A note") {
  db.prepare(
    "INSERT INTO notes VALUES (?, ?, 'body', '', NULL, 0, 0, '2026-01-01', '2026-01-01')",
  ).run(id, title);
}

/** Link note 1 <-> task 1, trash both, then hand task id 1 to an unrelated row. */
async function seedRecycledPair(driver: ReturnType<typeof sqliteDriver>) {
  const { db } = driver;
  seedNote(db, 1, "original note");
  db.prepare(
    "INSERT INTO tasks VALUES (1, 'original task', NULL, 0, 'none', '', '2026-01-01')",
  ).run();
  db.prepare(
    "INSERT INTO links VALUES (1, 'related', 'note', 1, 'task', 1, '2026-01-01')",
  ).run();
  const trash = createTrashRepo(driver);
  await trash.trashEntity("note", 1); // trash row 1
  await trash.trashEntity("task", 1); // trash row 2
  // SQLite recycles the freed number: id 1 now belongs to an unrelated task
  // while the original is still in Trash.
  db.prepare(
    "INSERT INTO tasks VALUES (1, 'unrelated task', NULL, 0, 'none', '', '2026-01-02')",
  ).run();
  return trash;
}

test("note Trash round-trip remaps IDs and restores links, photos, and Inbox references", async () => {
  const driver = sqliteDriver();
  const { db } = driver;
  seedNote(db);
  db.prepare(
    "INSERT INTO tasks VALUES (1, 'task', NULL, 0, 'none', '', '2026-01-01')",
  ).run();
  db.prepare(
    "INSERT INTO photos VALUES (1, 'photos/n.jpg', 'hash', 'jpg', 3, NULL, '', '2026-01-01')",
  ).run();
  db.prepare(
    "INSERT INTO photo_refs (photo_id, entity_type, entity_id) VALUES (1, 'note', 1)",
  ).run();
  db.prepare(
    "INSERT INTO links VALUES (1, 'related', 'note', 1, 'task', 1, '2026-01-01')",
  ).run();
  db.prepare(
    "INSERT INTO inbox_items VALUES (1, 'capture', 'converted', 'note', 1, '2026-01-01')",
  ).run();

  const trash = createTrashRepo(driver);
  await trash.trashEntity("note", 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM notes").get()?.n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM links").get()?.n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM photo_refs").get()?.n, 0);

  seedNote(db, 1, "Replacement");
  await trash.restore(1);
  const restored = db
    .prepare("SELECT id, title FROM notes WHERE id <> 1")
    .get() as { id: number; title: string };
  assert.equal(restored.id, 2);
  assert.equal(restored.title, "A note");
  assert.equal(
    db.prepare("SELECT entity_id FROM photo_refs").get()?.entity_id,
    2,
  );
  assert.equal(db.prepare("SELECT id_a FROM links").get()?.id_a, 2);
  assert.equal(
    db.prepare("SELECT converted_id FROM inbox_items").get()?.converted_id,
    2,
  );
  assert.equal(db.prepare("SELECT count(*) AS n FROM trash_items").get()?.n, 0);
});

test("restoring the task first remaps the link into the note's Trash snapshot (M1)", async () => {
  const driver = sqliteDriver();
  const { db } = driver;
  const trash = await seedRecycledPair(driver);

  await trash.restore(2); // the original task, onto id 2
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM links").get()?.n,
    0,
    "the unrelated task at the old number must stay unlinked",
  );
  const [noteTrash] = db
    .prepare("SELECT snapshot FROM trash_items WHERE entity_type = 'note'")
    .all() as { snapshot: string }[];
  assert.ok(noteTrash, "the note is still in Trash");
  const noteSnapshot = JSON.parse(noteTrash.snapshot) as {
    links: { type_a: string; id_a: number; type_b: string; id_b: number }[];
  };
  assert.equal(
    noteSnapshot.links.length,
    1,
    "the stale old-ID entry is replaced, not kept alongside",
  );
  const [remapped] = noteSnapshot.links;
  assert.ok(remapped, "the note keeps its one relationship");
  assert.deepEqual(
    {
      type_a: remapped.type_a,
      id_a: remapped.id_a,
      type_b: remapped.type_b,
      id_b: remapped.id_b,
    },
    { type_a: "note", id_a: 1, type_b: "task", id_b: 2 },
  );

  await trash.restore(1); // the original note, back onto id 1
  const link = db
    .prepare("SELECT type_a, id_a, type_b, id_b FROM links")
    .get() as { type_a: string; id_a: number; type_b: string; id_b: number };
  assert.equal(link.type_a, "note");
  assert.equal(link.id_a, 1);
  assert.equal(link.type_b, "task");
  assert.equal(link.id_b, 2);
  assert.equal(
    db.prepare("SELECT title FROM tasks WHERE id = 2").get()?.title,
    "original task",
  );
  assert.equal(db.prepare("SELECT count(*) AS n FROM trash_items").get()?.n, 0);
});

test("restoring the original does not rewrite a snapshot that describes the reuse (M1)", async () => {
  const driver = sqliteDriver();
  const { db } = driver;
  const trash = await seedRecycledPair(driver);

  // The unrelated task at id 1 builds its own relationship, and that note is
  // trashed afterwards — its snapshot must keep describing the unrelated task.
  seedNote(db, 1, "linked to the reuse");
  db.prepare(
    "INSERT INTO links VALUES (2, 'related', 'note', 1, 'task', 1, '2026-01-02')",
  ).run();
  await trash.trashEntity("note", 1); // trash row 3

  await trash.restore(2); // the original task, onto id 2
  const rows = db
    .prepare("SELECT id, snapshot FROM trash_items ORDER BY id")
    .all() as { id: number; snapshot: string }[];
  assert.deepEqual(
    rows.map((row) => row.id),
    [1, 3],
    "the original task's own Trash row is consumed",
  );
  const snapshots = rows.map(
    (row) =>
      JSON.parse(row.snapshot) as {
        links: { type_a: string; id_a: number; type_b: string; id_b: number }[];
      },
  );
  const [preTrash, reuseTrash] = snapshots;
  assert.ok(preTrash, "the original note's snapshot survives");
  assert.ok(reuseTrash, "the reuse's snapshot survives");
  const [preLink] = preTrash.links;
  const [reuseLink] = reuseTrash.links;
  assert.ok(preLink, "the original note keeps its relationship");
  assert.ok(reuseLink, "the reuse keeps its relationship");
  assert.equal(
    preLink.id_b,
    2,
    "the pre-trash snapshot follows the original to its new ID",
  );
  assert.equal(
    reuseLink.id_b,
    1,
    "the later snapshot still points at the unrelated task",
  );
  assert.equal(
    db.prepare("SELECT title FROM tasks WHERE id = 1").get()?.title,
    "unrelated task",
  );
});

test("a failed source deletion rolls back its Trash snapshot and link removal", async () => {
  const driver = sqliteDriver();
  const { db } = driver;
  seedNote(db);
  db.prepare(
    "INSERT INTO tasks VALUES (1, 'task', NULL, 0, 'none', '', '2026-01-01')",
  ).run();
  db.prepare(
    "INSERT INTO links VALUES (1, 'related', 'note', 1, 'task', 1, '2026-01-01')",
  ).run();
  db.exec(
    "CREATE TRIGGER refuse_note_delete BEFORE DELETE ON notes BEGIN SELECT RAISE(ABORT, 'blocked'); END;",
  );
  await assert.rejects(
    createTrashRepo(driver).trashEntity("note", 1),
    /blocked/,
  );
  assert.equal(db.prepare("SELECT count(*) AS n FROM notes").get()?.n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM links").get()?.n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM trash_items").get()?.n, 0);
});

test("contact children restore with collision-free child IDs", async () => {
  const driver = sqliteDriver();
  const { db } = driver;
  db.prepare(
    "INSERT INTO contacts VALUES (1, 'Ada', '', NULL, '', '2026-01-01')",
  ).run();
  db.prepare(
    "INSERT INTO contact_channels VALUES (4, 1, 'email', 'ada@example.test', 1, 0)",
  ).run();
  db.prepare("INSERT INTO contact_tags VALUES (5, 1, 'friend')").run();
  const trash = createTrashRepo(driver);
  await trash.trashEntity("contact", 1);
  db.prepare(
    "INSERT INTO contacts VALUES (1, 'Replacement', '', NULL, '', '2026-01-01')",
  ).run();
  db.prepare(
    "INSERT INTO contact_channels VALUES (4, 1, 'phone', '555', 0, 0)",
  ).run();
  await trash.restore(1);
  const restored = db
    .prepare("SELECT id, name FROM contacts WHERE id <> 1")
    .get() as { id: number; name: string };
  assert.equal(restored.id, 2);
  assert.equal(restored.name, "Ada");
  assert.equal(
    db.prepare("SELECT value FROM contact_channels WHERE contact_id = 2").get()
      ?.value,
    "ada@example.test",
  );
  assert.equal(
    db.prepare("SELECT tag FROM contact_tags WHERE contact_id = 2").get()?.tag,
    "friend",
  );
});

test("links stay hidden while either endpoint is trashed and return after both restore", async () => {
  const driver = sqliteDriver();
  const { db } = driver;
  seedNote(db);
  db.prepare(
    "INSERT INTO tasks VALUES (1, 'task', NULL, 0, 'none', '', '2026-01-01')",
  ).run();
  db.prepare(
    "INSERT INTO links VALUES (1, 'related', 'note', 1, 'task', 1, '2026-01-01')",
  ).run();
  const trash = createTrashRepo(driver);
  await trash.trashEntity("note", 1);
  await trash.trashEntity("task", 1);
  await trash.restore(1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM links").get()?.n, 0);
  await trash.restore(2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM links").get()?.n, 1);
});

test("restoring the note first never links it to the task that reused the old ID (M1)", async () => {
  const driver = sqliteDriver();
  const { db } = driver;
  const trash = await seedRecycledPair(driver);

  await trash.restore(1);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM links").get()?.n,
    0,
    "the unrelated task holding the old number must not receive the link",
  );

  await trash.restore(2); // id 1 is taken, so the original task lands on 2
  const link = db
    .prepare("SELECT type_a, id_a, type_b, id_b FROM links")
    .get() as { type_a: string; id_a: number; type_b: string; id_b: number };
  assert.equal(link.type_a, "note");
  assert.equal(link.id_a, 1);
  assert.equal(link.type_b, "task");
  assert.equal(link.id_b, 2);
  assert.equal(
    db.prepare("SELECT title FROM notes WHERE id = 1").get()?.title,
    "original note",
  );
  assert.equal(
    db.prepare("SELECT title FROM tasks WHERE id = 2").get()?.title,
    "original task",
  );
  assert.equal(db.prepare("SELECT count(*) AS n FROM trash_items").get()?.n, 0);
});

test("same-type links remain canonical when a restored ID is remapped", async () => {
  const driver = sqliteDriver();
  const { db } = driver;
  seedNote(db, 1, "first");
  seedNote(db, 2, "second");
  db.prepare(
    "INSERT INTO links VALUES (1, 'related', 'note', 1, 'note', 2, '2026-01-01')",
  ).run();
  const trash = createTrashRepo(driver);
  await trash.trashEntity("note", 1);
  seedNote(db, 1, "replacement");
  await trash.restore(1);
  const link = db
    .prepare("SELECT type_a, id_a, type_b, id_b FROM links")
    .get() as {
    type_a: string;
    id_a: number;
    type_b: string;
    id_b: number;
  };
  assert.equal(link.type_a, "note");
  assert.equal(link.id_a, 2);
  assert.equal(link.type_b, "note");
  assert.equal(link.id_b, 3);
});

test("restoring endpoint B of a same-type link re-inserts the link", async () => {
  const driver = sqliteDriver();
  const { db } = driver;
  seedNote(db, 1, "first");
  seedNote(db, 2, "second");
  db.prepare(
    "INSERT INTO links VALUES (1, 'related', 'note', 1, 'note', 2, '2026-01-01')",
  ).run();
  const trash = createTrashRepo(driver);
  // Trash the canonical B endpoint: the "other" endpoint must be computed by
  // identity (not type alone), or restore selects this entity itself and throws.
  await trash.trashEntity("note", 2);
  await trash.restore(1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM trash_items").get()?.n, 0);
  const link = db
    .prepare("SELECT type_a, id_a, type_b, id_b FROM links")
    .get() as {
    type_a: string;
    id_a: number;
    type_b: string;
    id_b: number;
  };
  assert.equal(link.type_a, "note");
  assert.equal(link.id_a, 1);
  assert.equal(link.type_b, "note");
  assert.equal(link.id_b, 2);
});

test("permanent deletion removes the relationship from the other Trash snapshot", async () => {
  const driver = sqliteDriver();
  const { db } = driver;
  seedNote(db);
  db.prepare(
    "INSERT INTO tasks VALUES (1, 'task', NULL, 0, 'none', '', '2026-01-01')",
  ).run();
  db.prepare(
    "INSERT INTO links VALUES (1, 'related', 'note', 1, 'task', 1, '2026-01-01')",
  ).run();
  const trash = createTrashRepo(driver);
  await trash.trashEntity("note", 1);
  await trash.trashEntity("task", 1);
  await trash.removePermanently(1);
  await trash.restore(2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM links").get()?.n, 0);
});

test("journal date conflicts refuse restore without consuming the Trash item", async () => {
  const driver = sqliteDriver();
  const { db } = driver;
  db.prepare(
    "INSERT INTO journal_entries VALUES (1, '2026-02-01', 'old', '2026-02-01', '2026-02-01')",
  ).run();
  const trash = createTrashRepo(driver);
  await trash.trashEntity("journal_entry", 1);
  db.prepare(
    "INSERT INTO journal_entries VALUES (2, '2026-02-01', 'new', '2026-02-02', '2026-02-02')",
  ).run();
  await assert.rejects(trash.restore(1), /already exists for that date/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM trash_items").get()?.n, 1);
});

test("journal entry Trash round-trip preserves its date identity and content", async () => {
  const driver = sqliteDriver();
  const { db } = driver;
  db.prepare(
    "INSERT INTO journal_entries VALUES (7, '2026-02-01', 'saved text', '2026-02-01', '2026-02-02')",
  ).run();
  const trash = createTrashRepo(driver);
  await trash.trashEntity("journal_entry", 7);
  await trash.restore(1);
  const restored = db
    .prepare("SELECT id, entry_date, content FROM journal_entries")
    .get() as {
    id: number;
    entry_date: string;
    content: string;
  };
  assert.equal(restored.id, 7);
  assert.equal(restored.entry_date, "2026-02-01");
  assert.equal(restored.content, "saved text");
});

test("task and memory snapshots restore source fields and memory photo refs", async () => {
  const driver = sqliteDriver();
  const { db } = driver;
  db.prepare(
    "INSERT INTO tasks VALUES (1, 'task', NULL, 0, 'weekly', 'details', '2026-01-01')",
  ).run();
  db.prepare(
    "INSERT INTO memories VALUES (1, 'memory', '2026-01-02', 'details', '2026-01-01')",
  ).run();
  db.prepare(
    "INSERT INTO photos VALUES (1, 'photos/m.jpg', 'hash', 'jpg', 3, NULL, '', '2026-01-01')",
  ).run();
  db.prepare(
    "INSERT INTO photo_refs (photo_id, entity_type, entity_id) VALUES (1, 'memory', 1)",
  ).run();
  const trash = createTrashRepo(driver);
  await trash.trashEntity("task", 1);
  await trash.trashEntity("memory", 1);
  await trash.restore(1);
  await trash.restore(2);
  assert.equal(
    db.prepare("SELECT repeat FROM tasks WHERE id = 1").get()?.repeat,
    "weekly",
  );
  assert.equal(
    db.prepare("SELECT note FROM memories WHERE id = 1").get()?.note,
    "details",
  );
  assert.equal(
    db
      .prepare("SELECT entity_id FROM photo_refs WHERE entity_type = 'memory'")
      .get()?.entity_id,
    1,
  );
});

test("restore refuses a missing photo file without consuming the Trash item", async () => {
  const driver = sqliteDriver();
  const { db } = driver;
  seedNote(db);
  db.prepare(
    "INSERT INTO photos VALUES (1, 'photos/missing.jpg', 'hash', 'jpg', 3, NULL, '', '2026-01-01')",
  ).run();
  db.prepare(
    "INSERT INTO photo_refs (photo_id, entity_type, entity_id) VALUES (1, 'note', 1)",
  ).run();
  await createTrashRepo(driver).trashEntity("note", 1);
  driver.readPhoto = async () => {
    throw new Error("file missing");
  };
  await assert.rejects(
    createTrashRepo(driver).restore(1),
    /photo file .* missing/,
  );
  assert.equal(db.prepare("SELECT count(*) AS n FROM notes").get()?.n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM trash_items").get()?.n, 1);
});

test("permanent deletion keeps photo rows and files in Gallery as unlinked (D1)", async () => {
  const driver = sqliteDriver();
  const { db } = driver;
  seedNote(db);
  db.prepare(
    "INSERT INTO photos VALUES (1, 'photos/shared.jpg', 'hash1', 'jpg', 3, NULL, '', '2026-01-01')",
  ).run();
  db.prepare(
    "INSERT INTO photos VALUES (2, 'photos/solo.jpg', 'hash2', 'jpg', 3, NULL, '', '2026-01-01')",
  ).run();
  db.prepare(
    "INSERT INTO photo_refs (photo_id, entity_type, entity_id) VALUES (1, 'note', 1), (2, 'note', 1)",
  ).run();
  db.prepare(
    "INSERT INTO memories VALUES (1, 'memory', '2026-01-01', '', '2026-01-01')",
  ).run();
  db.prepare(
    "INSERT INTO photo_refs (photo_id, entity_type, entity_id) VALUES (1, 'memory', 1)",
  ).run();
  const trash = createTrashRepo(driver);
  const gallery = createGalleryRepo(driver);
  await trash.trashEntity("note", 1);
  const item = db.prepare("SELECT id FROM trash_items").get() as { id: number };
  await trash.removePermanently(item.id);

  // Gallery owns the photo (D1): the Trash path deletes neither the photo row
  // nor the file, so the photo survives as "Not linked to anything yet".
  assert.deepEqual(
    (await gallery.listPhotos()).map((photo) => photo.id).sort(),
    [1, 2],
    "both photos stay listed in Gallery",
  );
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM photo_refs WHERE photo_id = 1").get()
      ?.n,
    1,
    "the memory's link keeps the shared photo referenced",
  );
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM photo_refs WHERE photo_id = 2").get()
      ?.n,
    0,
    "the orphaned photo has no link left",
  );
  assert.deepEqual(
    driver.deletedFiles,
    [],
    "the Trash path never unlinks a file",
  );

  // Clearing the unlinked photo stays possible — as an explicit Gallery action.
  await gallery.deletePhoto(2);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM photos WHERE id = 2").get()?.n,
    0,
  );
  assert.deepEqual(driver.deletedFiles, ["photos/solo.jpg"]);
});

test("Gallery cannot delete a photo retained by a Trash snapshot", async () => {
  const driver = sqliteDriver();
  const { db } = driver;
  seedNote(db);
  db.prepare(
    "INSERT INTO photos VALUES (1, 'photos/held.jpg', 'hash', 'jpg', 3, NULL, '', '2026-01-01')",
  ).run();
  db.prepare(
    "INSERT INTO photo_refs (photo_id, entity_type, entity_id) VALUES (1, 'note', 1)",
  ).run();
  await createTrashRepo(driver).trashEntity("note", 1);
  await assert.rejects(
    createGalleryRepo(driver).deletePhoto(1),
    /held by an item in Trash/,
  );
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM photos WHERE id = 1").get()?.n,
    1,
  );
  assert.deepEqual(driver.deletedFiles, []);
});

test("a failed file delete leaves a durable record the next delete completes (M2)", async () => {
  const driver = sqliteDriver();
  const { db } = driver;
  db.prepare(
    "INSERT INTO photos VALUES (1, 'photos/m2.jpg', 'hash', 'jpg', 3, NULL, '', '2026-01-01')",
  ).run();
  // The unlink fails exactly once — the finding's permission-denied case.
  let failNext = true;
  const unlink = driver.deletePhoto.bind(driver);
  driver.deletePhoto = async (path) => {
    if (failNext) {
      failNext = false;
      throw new Error(`delete ${path}: permission denied`);
    }
    await unlink(path);
  };
  const gallery = createGalleryRepo(driver);

  await assert.rejects(gallery.deletePhoto(1), (e: unknown) => {
    assert.ok(
      isPhotoCleanupPending(e),
      "the failure is reported as pending cleanup — never as success",
    );
    assert.match((e as Error).message, /cleanup pending/);
    return true;
  });

  // The state that must survive: row deleted, file pending, record durable.
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM photos WHERE id = 1").get()?.n,
    0,
    "the row deletion committed",
  );
  const record = db.prepare("SELECT key, value FROM settings").get() as {
    key: string;
    value: string;
  };
  assert.equal(record.value, "photos/m2.jpg", "the record names the file");
  assert.match(
    record.key,
    /^gallery\.pendingPhotoFile\.1\./,
    "keyed by the photo id a retry uses",
  );
  assert.deepEqual(driver.deletedFiles, [], "the file is still on disk");

  // The retry finishes the physical deletion instead of no-op'ing on the
  // missing row — that no-op was the finding's false success.
  await gallery.deletePhoto(1);
  assert.deepEqual(driver.deletedFiles, ["photos/m2.jpg"]);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM settings").get()?.n,
    0,
    "the record is cleared only once the file is gone",
  );

  // Now the delete genuinely is done: a further call changes nothing.
  await gallery.deletePhoto(1);
  assert.deepEqual(driver.deletedFiles, ["photos/m2.jpg"]);
});

test("retention removes expired entries and bounds the remaining Trash", async () => {
  const driver = sqliteDriver();
  const { db } = driver;
  const snapshot = JSON.stringify({
    version: 1,
    snapshotId: "retention-fixture",
    entity: {
      id: 1,
      title: "note",
      content: "",
      tags: "",
      collection_id: null,
      pinned: 0,
      archived: 0,
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
    },
    channels: [],
    tags: [],
    photoRefs: [],
    links: [],
    inboxRefs: [],
  });
  const insert = db.prepare(
    "INSERT INTO trash_items (entity_type, entity_id, snapshot, deleted_at, created_at) VALUES ('note', 1, ?, ?, ?)",
  );
  insert.run(snapshot, "2026-01-01", "2026-01-01");
  for (let index = 0; index < TRASH_MAX_ITEMS + 2; index += 1) {
    insert.run(snapshot, "2026-02-01", "2026-02-01");
  }
  const removed = await createTrashRepo(driver).purge("2026-02-02");
  assert.equal(removed, 3);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM trash_items").get()?.n,
    TRASH_MAX_ITEMS,
  );
});

test("malformed imported Trash snapshots are rejected", () => {
  assert.throws(
    () =>
      validateTrashPayload([
        {
          entity_type: "note",
          entity_id: 1,
          snapshot: "{}",
          deleted_at: "2026-01-01",
        },
      ]),
    /unsupported snapshot format/,
  );
});

test("Trash backup references to missing photos, links, or Inbox rows are rejected", () => {
  const entity = {
    id: 1,
    title: "note",
    content: "body",
    tags: "",
    collection_id: null,
    pinned: 0,
    archived: 0,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  };
  const row = (snapshot: object) => ({
    entity_type: "note",
    entity_id: 1,
    snapshot: JSON.stringify({
      version: 1,
      snapshotId: "payload-fixture",
      entity,
      channels: [],
      tags: [],
      photoRefs: [],
      links: [],
      inboxRefs: [],
      ...snapshot,
    }),
    deleted_at: "2026-01-01",
  });
  const liveEntities = new Map<string, Set<number>>([
    ["note", new Set()],
    ["task", new Set()],
    ["contact", new Set()],
  ]);
  assert.throws(
    () =>
      validateTrashPayload(
        [
          row({
            photoRefs: [{ photo_id: 9, entity_type: "note", entity_id: 1 }],
          }),
        ],
        { photoIds: new Set(), liveEntities },
      ),
    /missing photo/,
  );
  assert.throws(
    () =>
      validateTrashPayload(
        [
          row({
            links: [
              {
                id: 1,
                kind: "related",
                type_a: "note",
                id_a: 1,
                type_b: "task",
                id_b: 9,
                created_at: "2026-01-01",
              },
            ],
          }),
        ],
        { liveEntities },
      ),
    /neither live nor trashed/,
  );
  assert.throws(
    () =>
      validateTrashPayload(
        [
          row({
            inboxRefs: [{ id: 7, converted_type: "note", converted_id: 1 }],
          }),
        ],
        { inboxRows: [] },
      ),
    /missing Inbox item/,
  );
});

test("trashEntity runs its maintenance purge inside the lock, not re-entering it (J3)", {
  timeout: 10_000,
}, async () => {
  const driver = sqliteDriver();
  seedNote(driver.db);
  const trash = createTrashRepo(driver);
  // Would hang — the timeout is what turns that into a failure — if the
  // internal maintenance pass took the repo lock again: `mutex.ts` never
  // nests the same key, so it must call the unlocked variant.
  await trash.trashEntity("note", 1);
  const rows = driver.db.prepare("SELECT id FROM trash_items").all();
  assert.equal(
    rows.length,
    1,
    "the note is in Trash and the maintenance pass kept it (not expired)",
  );
});

test("restore queues behind an in-flight purge on the one trash lock (J3)", {
  timeout: 10_000,
}, async () => {
  const driver = sqliteDriver();
  const { db } = driver;
  seedNote(db, 1, "Expired");
  seedNote(db, 2, "Fresh");
  const trash = createTrashRepo(driver);
  await trash.trashEntity("note", 1);
  await trash.trashEntity("note", 2);
  // Age the first item past the retention window so the purge wants it.
  db.prepare(
    "UPDATE trash_items SET deleted_at = '2020-01-01' WHERE entity_id = 1",
  ).run();
  const fresh = db
    .prepare("SELECT id FROM trash_items WHERE entity_id = 2")
    .get() as {
    id: number;
  };

  // Park the purge at its first query, start the restore behind it, and
  // watch which queries are actually issued (J3: `App.tsx` fires this
  // detached purge the moment the user unlocks).
  const { driver: gated, release } = gatedQueryDriver(driver);
  const queries: string[] = [];
  const spy = {
    ...gated,
    query: <T extends Queryable>(sql: string, params?: unknown[]) => {
      queries.push(sql);
      return gated.query<T>(sql, params);
    },
  } as DataDriver;
  const observing = createTrashRepo(spy);
  const purging = observing.purge("2026-10-20");
  await tick();
  const restoring = observing.restore(fresh.id);
  await tick();
  assert.ok(
    !queries.includes("SELECT * FROM trash_items WHERE id = ?"),
    "restore must not have issued its first SELECT while purge holds the lock",
  );
  release();
  assert.equal(await purging, 1, "the expired item was purged");
  await restoring;
  const remaining = db.prepare("SELECT entity_id FROM trash_items").all() as {
    entity_id: number;
  }[];
  assert.deepEqual(
    remaining,
    [],
    "the expired row was purged and the fresh one restored out of Trash",
  );
  const notes = db.prepare("SELECT id FROM notes").all() as { id: number }[];
  assert.deepEqual(
    notes.map((note) => note.id),
    [2],
    "the fresh note is live again; the expired one is gone for good",
  );
});

test("every trash mutator serializes on the one repo lock (J3)", () => {
  // The behavioural tests above park `purge` and watch `restore`; this pins
  // the two wrappers they do not exercise — and the unlocked-internal rule
  // that keeps the re-entrant maintenance passes from deadlocking.
  const src = readFileSync(new URL("./trash.ts", import.meta.url), "utf8");
  for (const [name, pattern] of [
    [
      "trashEntity",
      /trashEntity: \(type: TrashEntityType, id: number\) =>\s*mutex\.withLock\("trash", \(\) => trashEntityUnlocked\(type, id\)\)/,
    ],
    [
      "restore",
      /restore: \(trashId: number\) =>\s*mutex\.withLock\("trash", \(\) => restoreUnlocked\(trashId\)\)/,
    ],
    [
      "removePermanently",
      /removePermanently: \(trashId: number\) =>\s*mutex\.withLock\("trash", \(\) => removePermanentlyUnlocked\(trashId\)\)/,
    ],
    [
      "purge",
      /purge: \(today\?: string\) =>\s*mutex\.withLock\("trash", \(\) => purgeUnlocked\(today\)\)/,
    ],
  ] as const) {
    assert.match(src, pattern, `${name} must take the repo lock`);
  }
  assert.match(src, /await purgeUnlocked\(\);/);
  assert.doesNotMatch(
    src,
    /await purge\(\);/,
    "the internal maintenance pass must call the UNLOCKED variant",
  );
});
