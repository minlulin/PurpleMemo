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

// -- Excerpt truncation: word boundaries and a cluster cap (K11) -------------
// Two promises the doc comment made and the code did not keep: the cut is on
// a WORD boundary — Burmese is written without inter-word spaces, so
// `lastIndexOf(" ")` found none and every Burmese excerpt ended mid-word — and
// the 140 cap counts visible characters, not UTF-16 units, so Burmese got
// ~90 where Latin got 140. Unit slicing also split pairs: an emoji is two
// units, a cluster two, so `slice(0, n)` could leave a lone surrogate or a
// base missing its vowel. Characters are written as escapes where the test
// compares exact positions, so no editor normalisation can turn a composed
// pair into a test that passes by accident.

/** A lone (unpaired) UTF-16 surrogate — the signature of a split pair. */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** 😀 as its two UTF-16 units. */
const EMOJI = "\u{1F600}";
/** 👨‍👩‍👧 — five code points, eight units, ONE grapheme. */
const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
/** က + ် (U+1000 U+103A): one cluster, two units. */
const BURMESE = "\u1000\u103A";

test("noteExcerpt never splits an emoji across the cut (K11)", () => {
  // The cap is 139 clusters plus the ellipsis: 138 `a`s put the emoji in the
  // last slot — the old unit slice at 139 landed BETWEEN its surrogates.
  const out = noteExcerpt(`${"a".repeat(138)}${EMOJI} more text past the cap`);
  assert.equal(
    out,
    `${"a".repeat(138)}${EMOJI}…`,
    "one cluster for the emoji means the emoji stays whole",
  );
  assert.ok(
    !LONE_SURROGATE.test(out),
    `lone surrogate in ${JSON.stringify(out)}`,
  );

  // One slot earlier and it is well inside the budget — also whole.
  const fits = noteExcerpt(`${"a".repeat(137)}${EMOJI} more text past the cap`);
  assert.equal(fits, `${"a".repeat(137)}${EMOJI}…`);
  assert.ok(!LONE_SURROGATE.test(fits));
});

test("noteExcerpt keeps a ZWJ emoji sequence whole (K11)", () => {
  // The family is one grapheme spanning units 135–142: the old cut at unit
  // 139 landed between the parents, leaving half a family plus lone
  // surrogates; one cluster of budget keeps it intact.
  const cut = noteExcerpt(
    `${"a".repeat(135)}${FAMILY} and more text past the cap`,
  );
  assert.equal(
    cut,
    `${"a".repeat(135)}${FAMILY}…`,
    "a cluster that fits the budget is kept whole",
  );
  const fits = noteExcerpt(
    `${"a".repeat(130)}${FAMILY} and more text past the cap`,
  );
  assert.ok(
    fits.includes(FAMILY),
    `family must survive intact: ${JSON.stringify(fits)}`,
  );
});

test("noteExcerpt never cuts a Burmese cluster in half (K11)", () => {
  // The unit-slice case: 138 `a`s put the old cut between a consonant and
  // its combining mark, so the excerpt showed a base whose vowel had
  // vanished. Clusters are indivisible, so the pair survives or goes together.
  const cut = noteExcerpt(`${"a".repeat(138)}${BURMESE} tail tail`);
  assert.equal(
    cut,
    `${"a".repeat(138)}${BURMESE}…`,
    "the base and its mark are one cluster — kept or dropped together",
  );
  assert.ok(noteExcerpt(`${BURMESE} fits whole`).includes(BURMESE));
});

test("a space-less Burmese excerpt ends on a word, not mid-word (K11)", () => {
  // The finding's own measurement: a 200-unit Burmese text was cut at unit
  // 139 with no space anywhere in it, so the excerpt ended mid-word — while
  // the doc comment promised a word boundary. The word pass uses the same
  // Intl.Segmenter granularity as the reader's word counter.
  const text = "မြန်မာနိုင်ငံကအရမ်းလှတယ်ဆိုတာသက်သေပြချင်တယ်ဖြစ်သည်";
  const out = noteExcerpt(text, 12);
  assert.ok(out.endsWith("…"));
  const head = out.slice(0, -1);
  assert.ok(
    head.length > 0 && head.length < text.length,
    "truncated to a non-empty head",
  );
  const wordEnds = new Set<number>();
  for (const w of new Intl.Segmenter(undefined, {
    granularity: "word",
  }).segment(text)) {
    wordEnds.add(w.index + w.segment.length);
  }
  assert.ok(
    wordEnds.has(head.length),
    `cut at unit ${head.length} is mid-word: ${JSON.stringify(out)}`,
  );
  assert.ok(!LONE_SURROGATE.test(out));
});

test("the cap counts grapheme clusters, not UTF-16 units (K11)", () => {
  const segmenter = new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  });
  const clusters = (s: string) => [...segmenter.segment(s)].length;

  // Burmese packs ~1.6 units per visible character: this body is OVER the
  // cap in units and UNDER it in clusters, so a unit budget cut it mid-word
  // even though it fits the 140-cluster cap the excerpt promises.
  const burmese = "မြန်မာနိုင်ငံကအရမ်းလှတယ်".repeat(7);
  assert.ok(burmese.length > 140, `precondition: ${burmese.length} units`);
  assert.ok(
    clusters(burmese) <= EXCERPT_MAX_CHARS,
    `precondition: ${clusters(burmese)} clusters`,
  );
  assert.equal(
    noteExcerpt(burmese),
    burmese,
    "a body within the cluster cap is returned whole",
  );

  // The mirror image: 130 emoji are 260 units but 130 clusters — a unit
  // budget cut them at unit 139, through a surrogate pair.
  const emojis = EMOJI.repeat(130);
  assert.equal(clusters(emojis), 130, "precondition: one cluster per emoji");
  assert.equal(noteExcerpt(emojis), emojis, "130 emoji fit a 140-cluster cap");
  const over = noteExcerpt(`${emojis} and a tail to push it past the cap`);
  assert.ok(over.endsWith("…"));
  assert.ok(
    !LONE_SURROGATE.test(over),
    "the over-cap cut still never splits a pair",
  );
});

test("every cut offset in a mixed-script body lands on a cluster boundary (K11)", () => {
  // Sweep the pad so the cut walks through Burmese clusters, an emoji pair and
  // a ZWJ sequence: whatever the offset, the head must end where
  // grapheme segmentation ends — the general property behind the cases above.
  const sample = `${"\u1019\u103C\u1012\u102C".repeat(3)} ${EMOJI} ${FAMILY} tail`;
  const segmenter = new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  });
  for (let pad = 130; pad <= 150; pad++) {
    const text = `${"a".repeat(pad)}${sample} and more words past the cap`;
    const out = noteExcerpt(text);
    assert.ok(!LONE_SURROGATE.test(out), `pad ${pad}: ${JSON.stringify(out)}`);
    const head = out.endsWith("…") ? out.slice(0, -1) : out;
    const ends = new Set<number>();
    for (const g of segmenter.segment(text)) {
      if (g.index > 220) break;
      ends.add(g.index + g.segment.length);
    }
    assert.ok(
      ends.has(head.length),
      `pad ${pad}: head ends at unit ${head.length}, mid-cluster (untruncated would be ${text.length})`,
    );
  }
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

// -- The FTS search path answers LIST previews (K5) ---------------------------
// J1 gave the truncated projections their own row type; the FTS search path
// kept the full-body type behind an unchecked cast. The row it actually
// returns has a 200-char `content` — so the pin is both ends: the SQL the real
// database answers, and the source annotation that names the type.

test("notes.search answers the LIST preview row, not a full body (K5)", async () => {
  const driver = sqliteDriver();
  const notes = createNotesRepo(driver);
  const body = "gamma filler words here ".repeat(15); // 345 chars, no markdown
  assert.ok(body.length > 200, "precondition: the body outruns the preview");
  await notes.createNote({ title: "preview check", content: body });

  const rows = await notes.search("gamma");
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row);
  assert.equal(
    row.content.length,
    200,
    "the FTS row carries the 200-char preview",
  );
  assert.notEqual(row.content, body, "…not the stored body");

  // One literal, one truth: the browse projection and the FTS projection must
  // cut the same row at the same place (K5's drift risk).
  const listed = await notes.listNotes();
  assert.equal(row.content, listed[0]?.content, "FTS preview ≡ list preview");

  // Source pins, because `NoteListRow` is a `NoteRow` alias — tsc cannot see
  // the difference, so the annotation itself is what regresses.
  const src = readFileSync(new URL("./notes.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /async search\(\s*input: string,[\s\S]*?\): Promise<NoteListRow\[\]>/,
    "notes.search must declare NoteListRow[] — the truncated projection's type",
  );
  assert.doesNotMatch(
    src,
    /as Promise<NoteRow\[\]>/,
    "the unchecked cast is gone",
  );
  assert.doesNotMatch(
    src,
    /const LIST_CONTENT_CHARS =/,
    "notes.ts imports the cap from search.ts instead of keeping a second literal",
  );
});

// -- The in-page search has a total order (K8) --------------------------------
// bm25 rank is not a total order: tied rows had no defined relative position,
// so the list under the search box could reorder between two identical
// searches — while the global search over this same index promised and
// enforced one. Real SQLite: the tie has to be real for the pin to mean
// anything.

test("equal-rank notes order by updated_at DESC, then id DESC, stably (K8)", async () => {
  const driver = sqliteDriver();
  const notes = createNotesRepo(driver);
  const ids: number[] = [];
  for (let i = 0; i < 3; i++) {
    ids.push(
      await notes.createNote({
        title: "twin",
        content: "identical body for a tied bm25 rank",
      }),
    );
  }
  const id0 = at(ids, 0, "first id");
  const id1 = at(ids, 1, "second id");
  const id2 = at(ids, 2, "third id");

  // Precondition: bm25 really does tie them — identical documents, one query.
  const ranks = driver.db
    .prepare("SELECT rank FROM notes_fts WHERE notes_fts MATCH ?")
    .all('"twin"*') as { rank: number }[];
  assert.equal(ranks.length, 3);
  assert.equal(
    new Set(ranks.map((r) => r.rank)).size,
    1,
    "precondition: the three ranks tie, so the tie-break decides",
  );

  // Distinct recency in a different order from insertion, so satisfying the
  // assertion by accident (rowid order) is impossible.
  const recency = ["2026-01-03", "2026-01-01", "2026-01-02"];
  for (const [i, date] of recency.entries()) {
    await driver.execute("UPDATE notes SET updated_at = ? WHERE id = ?", [
      date,
      at(ids, i, "id to re-date"),
    ]);
  }

  const order = async (): Promise<number[]> =>
    (await notes.search("twin")).map((r) => r.id);
  const expected = [id0, id2, id1]; // 01-03, then 01-02, then 01-01
  assert.deepEqual(
    await order(),
    expected,
    "ties break by updated_at DESC, then id DESC — the browse list's own order",
  );
  for (let run = 0; run < 5; run++) {
    assert.deepEqual(
      await order(),
      expected,
      `run ${run}: identical queries must answer identically (K8)`,
    );
  }
});
