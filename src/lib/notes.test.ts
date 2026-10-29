// Unit tests for the notes feature helpers (140-char plain-text excerpts).
// Runs under `node --test` with Node's type-stripping — no JSX, `.ts` imports only.

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
import { at, first } from "../test-utils.ts";
import { createNotesRepo, EXCERPT_MAX_CHARS, noteExcerpt } from "./notes.ts";

test("the repo forwards the collection filter to the FTS search (P2-13)", async () => {
  // The page cannot be unit-tested here, so the seam it relies on is pinned
  // instead: `search` must forward `collectionId` through to `searchNotes`,
  // not swallow it. Swallowing it is what made the sidebar filter look applied
  // during a search while matching every collection.
  const driver = createMockDriver({ results: [[{ id: 3 }]] });
  const notes = createNotesRepo(driver);
  await notes.search("grocery", { collectionId: 4, includeArchived: true });
  const call = first(
    driver
      .callsTo("query")
      .filter((c) => /notes_fts/.test(c.args[0] as string)),
    "fts query",
  );
  assert.match(call.args[0] as string, /n\.collection_id = \?/);
  assert.deepEqual(call.args[1], ['"grocery"*', 4]);

  // And the filter is optional: `listNotes`-style calls with no collection must
  // not acquire a `= NULL` clause that would match nothing.
  const unscoped = createMockDriver();
  await createNotesRepo(unscoped).search("grocery");
  const plain = first(unscoped.callsTo("query"), "fts query");
  assert.doesNotMatch(plain.args[0] as string, /collection_id =/);
});

test("noteExcerpt strips markdown syntax to plain text", () => {
  const md = [
    "# Title",
    "",
    "> Quote line",
    "",
    "- item one",
    "- item two",
    "",
    "**bold** and _under_ with [site](http://a.b/c) and ![pic](p.png) plus `code`",
    "",
    "***",
  ].join("\n");
  assert.equal(
    noteExcerpt(md),
    "Title Quote line item one item two bold and under with site and pic plus code",
  );
});

test("noteExcerpt keeps fenced code text but drops the fence markers", () => {
  assert.equal(
    noteExcerpt("Intro\n\n```ts\nlet x = 1;\n```\n"),
    "Intro let x = 1;",
  );
});

test("noteExcerpt cap is 140 chars, counted with the ellipsis", () => {
  assert.equal(EXCERPT_MAX_CHARS, 140);
  const long = "word ".repeat(100);
  const out = noteExcerpt(long);
  assert.ok(out.length <= EXCERPT_MAX_CHARS, `length ${out.length} > 140`);
  assert.ok(out.endsWith("…"), `must end with ellipsis: ${out.slice(-5)}`);
  assert.ok(out.startsWith("word"), `must keep the head: ${out.slice(0, 20)}`);
  assert.ok(!out.includes("  "), "no double spaces");
});

test("noteExcerpt returns short content unchanged", () => {
  assert.equal(noteExcerpt("hello world"), "hello world");
  assert.equal(noteExcerpt("  padded  \n"), "padded");
});

test("noteExcerpt maps empty and symbol-only content to an empty string", () => {
  assert.equal(noteExcerpt(""), "");
  assert.equal(noteExcerpt("   \n\t  "), "");
  assert.equal(noteExcerpt("***\n---\n"), "");
});

// -- Collection delete vs the FTS folder column (review P3-4) ------------------
// `notes_fts.folder` is refreshed by the notes UPDATE trigger, and the FK's
// ON DELETE SET NULL is an FK action — SQLite does not fire UPDATE triggers
// for those — so `DELETE FROM collections` alone left the collection's name
// searchable until each note was next edited. This needs real SQLite (triggers
// + FK enforcement), so it carries its own small driver like the other suites.

const COLLECTION_FIXTURE = `
CREATE TABLE collections (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE notes (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
  pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE notes_fts USING fts5(title, content, tags, folder);
CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, content, tags, folder)
  VALUES (new.id, new.title, new.content, new.tags,
          COALESCE((SELECT name FROM collections WHERE id = new.collection_id), ''));
END;
CREATE TRIGGER notes_fts_ad AFTER DELETE ON notes BEGIN
  DELETE FROM notes_fts WHERE rowid = old.id;
END;
CREATE TRIGGER notes_fts_au AFTER UPDATE ON notes BEGIN
  UPDATE notes_fts
  SET title = new.title, content = new.content, tags = new.tags,
      folder = COALESCE((SELECT name FROM collections WHERE id = new.collection_id), '')
  WHERE rowid = new.id;
END;
`;

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
  db.exec(COLLECTION_FIXTURE);
  // The production connection runs with this on (`db.rs`); the SET NULL path
  // being pinned here depends on it.
  db.exec("PRAGMA foreign_keys = ON");
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
      throw new Error("no safety copy in this test driver");
    },
    async shareArm() {
      return "";
    },
  };
}

test("a deleted collection's name stops matching in note search (P3-4)", async () => {
  const driver = sqliteDriver();
  const { db } = driver;
  const notes = createNotesRepo(driver);
  const collectionId = await notes.createCollection("Retired Folder");
  await notes.createNote({
    title: "note one",
    content: "body text",
    collectionId,
  });

  const matches = (term: string): number => {
    const row = db
      .prepare("SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH ?")
      .get(term) as { n: number };
    return row.n;
  };

  // Sanity: while the collection exists, its name is searchable for the note.
  assert.equal(matches("Retired"), 1, "precondition: folder is indexed");

  await notes.deleteCollection(collectionId);

  // The note survives, unfiled…
  const note = db
    .prepare("SELECT collection_id FROM notes WHERE id = 1")
    .get() as { collection_id: number | null };
  assert.equal(note.collection_id, null, "FK SET NULL still clears membership");
  // …and search no longer matches the deleted collection's name for it.
  assert.equal(
    matches("Retired"),
    0,
    "the deleted collection's name must be retired from notes_fts.folder",
  );
});

// -- Projection typing (J1) ---------------------------------------------------
// `driver.query<T>` is an unchecked cast, so the row TYPE a projection
// answers is a contract pinned here from both ends: the SQL the repo builds
// (mock driver) and the columns SQLite actually returns (real DB). The old
// surface typed every projection `NoteRow`, so a two-column title row read as
// a full row lost seven columns to `undefined` — and the default list
// projection's 200-char `content` prefix reached the link picker, whose
// in-memory search silently missed every hit past character 200.

test("listNoteTitles selects id+title only, and its rows carry nothing else (J1)", async () => {
  const mock = createMockDriver();
  const notes = createNotesRepo(mock);
  await notes.listNoteTitles({ collectionId: 4, limit: 20 });
  const call = first(mock.callsTo("query"), "title read");
  assert.equal(
    call.args[0],
    "SELECT id, title FROM notes WHERE collection_id = ? AND archived = 0 ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT ?",
    "the title projection must select exactly id, title, through the same filter surface",
  );
  assert.deepEqual(call.args[1], [4, 20]);

  // Against real SQLite the row really IS two columns. (`node:sqlite`
  // answers null-prototype rows, so compare through plain-object spreads —
  // the pin is about WHICH columns exist, not about prototypes.)
  const real = createNotesRepo(sqliteDriver());
  await real.createNote({ title: "Groceries", content: "milk, eggs" });
  const rows = await real.listNoteTitles();
  assert.deepEqual(
    rows.map((r) => ({ ...r })),
    [{ id: 1, title: "Groceries" }],
  );
});

test("the default projection previews content; 'full' asks for the body (J1)", async () => {
  const mock = createMockDriver();
  const notes = createNotesRepo(mock);

  await notes.listNotes({ includeArchived: true });
  const listCall = first(mock.callsTo("query"), "list read");
  assert.match(
    listCall.args[0] as string,
    /substr\(content, 1, 200\) AS content/,
    "the default 'list' projection must stay the 200-char preview",
  );

  await notes.listNotes({ includeArchived: true, projection: "full" });
  const fullCall = at(mock.callsTo("query"), 1, "full read");
  assert.equal(
    fullCall.args[0],
    "SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC, id DESC",
    "projection 'full' must select every column, untruncated",
  );
});

test("listNoteTitles is typed NoteTitleRow[], and the nine dead title aliases are gone (J1)", async () => {
  // A source pin, because tsc alone cannot catch the regression:
  // `NoteRow[]` is ASSIGNABLE to `NoteTitleRow[]`, so widening the return
  // type would still compile everywhere while putting the seven absent
  // columns back on the row.
  const src = readFileSync(new URL("./notes.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /listNoteTitles\(filter: NoteFilter = \{\}\): Promise<NoteTitleRow\[\]>/,
    "listNoteTitles must answer NoteTitleRow[], never the full NoteRow",
  );

  const repo = createNotesRepo(createMockDriver()) as unknown as Record<
    string,
    unknown
  >;
  for (const dead of [
    "listNotesTitles",
    "listNotesTitleOnly",
    "listNotesTitlesOnly",
    "listTitleNotes",
    "listTitleOnlyNotes",
    "listNoteTitleOnly",
    "listTitles",
    "listTitlesOnly",
    "listTitleOnly",
  ]) {
    assert.equal(
      repo[dead],
      undefined,
      `${dead} must be gone: listNoteTitles is the one title-only entry`,
    );
  }
  assert.equal(typeof repo.listNoteTitles, "function");
});

test("the picker searches FULL bodies; the gallery list is NoteTitleRow[] (J1)", () => {
  const picker = readFileSync(
    new URL("../components/EntityPicker.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    picker,
    /listNotes\(\{ includeArchived: true, projection: "full" \}\)/,
    "EntityPicker matches note.content in memory — the list projection's 200-char prefix hid every hit past it",
  );

  const gallery = readFileSync(
    new URL("../pages/GalleryPage.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    gallery,
    /useState<NoteTitleRow\[\]>\(\[\]\)/,
    "the gallery's picker list holds id+title rows; typing them NoteRow[] made seven absent columns look readable",
  );
});
