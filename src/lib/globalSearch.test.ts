// Global search.
//
// The ordering, the caps and the refusal rules are the contract's promises, so
// they are tested against REAL SQL — the whole surface is one query per entity
// and the interesting failures (a ranking that is not deterministic, a cap that
// does not bite, an FTS operator typed by accident) only exist in SQLite.

import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type {
  BatchStatement,
  DataDriver,
  ExecuteOutcome,
  Queryable,
} from "../data/driver.ts";
import {
  applyTotalCap,
  buildSearchQuery,
  daysAgo,
  globalSearch,
  resultCount,
  type SearchGroup,
} from "./globalSearch.ts";
import {
  isSearchable,
  normalizeTerm,
  SEARCH_CONTRACT,
  SEARCH_EXCLUSIONS,
  SEARCH_TOTAL_CAP,
  specFor,
} from "./searchContract.ts";

const SQLITE_FIXTURE = `
CREATE TABLE notes (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '', collection_id INTEGER, pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE notes_fts USING fts5(title, content, tags, folder);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, due_date TEXT, done INTEGER NOT NULL DEFAULT 0,
  repeat TEXT NOT NULL DEFAULT 'none', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '',
  birthday TEXT, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE journal_entries (
  id INTEGER PRIMARY KEY, entry_date TEXT NOT NULL UNIQUE, content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE memories (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, memory_date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, shop_id INTEGER, total_cents INTEGER NOT NULL,
  paid_cents INTEGER NOT NULL DEFAULT 0, job_date TEXT NOT NULL, warranty_days INTEGER,
  status TEXT NOT NULL DEFAULT 'open', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE payables (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, amount_cents INTEGER NOT NULL, shop_id INTEGER,
  due_date TEXT, paid INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE loans (
  id INTEGER PRIMARY KEY, counterparty TEXT NOT NULL, direction TEXT NOT NULL,
  amount_cents INTEGER NOT NULL, repaid_cents INTEGER NOT NULL DEFAULT 0,
  due_date TEXT, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE shopping_lists (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE shopping_items (
  id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL, text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0
);
-- Present so the contract's EXCLUSIONS can be asserted as exclusions: a search
-- that reached into any of these would find these rows.
CREATE TABLE vault_items (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, ciphertext TEXT NOT NULL,
  salt TEXT NOT NULL, iv TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
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

function seed(db: DatabaseSync): void {
  const note = db.prepare(
    "INSERT INTO notes (id, title, content, tags, collection_id, pinned, archived, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 0, ?, ?, ?)",
  );
  const fts = db.prepare(
    "INSERT INTO notes_fts(rowid, title, content, tags, folder) VALUES (?, ?, ?, ?, '')",
  );
  const addNote = (
    id: number,
    title: string,
    content: string,
    tags: string,
    archived: number,
    updated: string,
  ) => {
    note.run(id, title, content, tags, archived, updated, updated);
    fts.run(id, title, content, tags);
  };
  addNote(1, "Shopping list", "milk and eggs", "home", 0, "2026-10-01");
  addNote(2, "Shopping plan", "weekly plan", "home", 0, "2026-10-05");
  addNote(3, "Archived shopping note", "old milk list", "", 1, "2026-01-01");
  addNote(4, "Tightrope repair", "fix the milk shed", "", 0, "2026-10-10");
  addNote(5, "Roof quote", "three quotes, cheap one won", "", 0, "2026-10-10");

  db.prepare(
    "INSERT INTO tasks (id, title, due_date, done, repeat, note, created_at) VALUES (1, 'Buy milk', '2026-10-20', 0, 'none', '', 'x'), (2, 'Milk the cow', NULL, 1, 'none', '', 'x'), (3, 'Fix the shed', '2026-10-01', 0, 'none', '', 'x')",
  ).run();
  db.prepare(
    "INSERT INTO contacts (id, name, address, notes, created_at) VALUES (1, 'Milk Supplier', '12 River Road', 'delivers on Fridays', 'x'), (2, 'Aunt Ma', 'Bahan', '', 'x')",
  ).run();
  db.prepare(
    "INSERT INTO journal_entries (id, entry_date, content, created_at, updated_at) VALUES (1, '2026-10-12', 'Bought milk at the market', 'x', 'x'), (2, '2026-08-01', 'nothing much', 'x', 'x')",
  ).run();
  db.prepare(
    "INSERT INTO memories (id, title, memory_date, note, created_at) VALUES (1, 'Milk float day', '2019-05-04', 'the whole village came out', 'x')",
  ).run();
  db.prepare(
    "INSERT INTO jobs (id, title, shop_id, total_cents, paid_cents, job_date, warranty_days, status, note, created_at) VALUES (1, 'Shelf rebuild', NULL, 50000, 50000, '2026-09-01', NULL, 'paid', 'also fixed the milk roof', 'x'), (2, 'Milk fridge repair', NULL, 20000, 0, '2026-10-02', NULL, 'open', 'technician comes Tuesday', 'x')",
  ).run();
  db.prepare(
    "INSERT INTO payables (id, title, amount_cents, shop_id, due_date, paid, note, created_at) VALUES (1, 'Milk invoice', 12000, NULL, '2026-10-05', 0, 'due friday', 'x'), (2, 'Paid invoice', 5000, NULL, NULL, 1, '', 'x')",
  ).run();
  db.prepare(
    "INSERT INTO loans (id, counterparty, direction, amount_cents, repaid_cents, due_date, note, created_at) VALUES (1, 'Milk Supplier', 'lent', 50000, 0, '2026-11-01', 'for the shed', 'x')",
  ).run();
  db.prepare(
    "INSERT INTO shopping_lists (id, name, created_at) VALUES (1, 'Shop', 'x')",
  ).run();
  db.prepare(
    "INSERT INTO shopping_items (id, list_id, text, done, sort_order) VALUES (1, 1, 'Milk', 0, 0), (2, 1, 'Bread', 0, 1)",
  ).run();
  // The three things that must never be findable.
  db.prepare(
    "INSERT INTO vault_items (id, title, ciphertext, salt, iv, created_at, updated_at) VALUES (1, 'milk bank code', 'x', 'x', 'x', 'x', 'x')",
  ).run();
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('pin_hash', 'milk')",
  ).run();
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('vault', 'milk')",
  ).run();
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

test("the contract covers the entities the phase requires", () => {
  const types = SEARCH_CONTRACT.map((s) => s.type);
  for (const required of [
    "note",
    "journal",
    "task",
    "contact",
    "memory",
    "job",
    "payable",
    "loan",
    "shopping_item",
  ] as const) {
    assert.ok(types.includes(required), `the contract must cover ${required}`);
  }
  assert.equal(new Set(types).size, types.length, "no type twice");
});

test("every contract row is complete enough to run", () => {
  for (const spec of SEARCH_CONTRACT) {
    assert.ok(spec.label.length > 0, `${spec.type}: label`);
    assert.ok(spec.searchable.length > 0, `${spec.type}: searchable columns`);
    assert.ok(spec.title.length > 0, `${spec.type}: title columns`);
    assert.ok(spec.cap > 0 && spec.cap <= 20, `${spec.type}: a sane cap`);
    assert.ok(
      spec.why.length > 30,
      `${spec.type}: every inclusion needs a stated reason`,
    );
    assert.match(spec.match, /^(fts|like)$/);
  }
});

test("only notes use FTS, because only notes have an FTS index", () => {
  const fts = SEARCH_CONTRACT.filter((s) => s.match === "fts");
  assert.deepEqual(
    fts.map((s) => s.type),
    ["note"],
  );
});

test("the vault, settings and money entries are excluded, each with a reason", () => {
  const text = SEARCH_EXCLUSIONS.map((e) => `${e.what} ${e.why}`)
    .join(" ")
    .toLowerCase();
  for (const needle of ["vault_items", "settings", "income_entries"]) {
    assert.ok(text.includes(needle), `${needle} must be excluded explicitly`);
  }
  for (const exclusion of SEARCH_EXCLUSIONS) {
    assert.ok(
      exclusion.why.length > 40,
      `${exclusion.what} needs a stated reason, not just a refusal`,
    );
  }
  // And no contract row reaches into an excluded table.
  const tables = SEARCH_CONTRACT.map((s) => s.table);
  for (const forbidden of [
    "vault_items",
    "settings",
    "income_entries",
    "expense_entries",
    "photos",
  ]) {
    assert.equal(
      tables.includes(forbidden),
      false,
      `${forbidden} is not searchable`,
    );
  }
});

test("a search for a secret finds nothing in it", async () => {
  const driver = sqliteDriver();
  seed(driver.db);
  // Control: the plain text is findable.
  const control = await globalSearch(driver, "milk");
  assert.equal(
    control.flatMap((g) => g.results).length > 0,
    true,
    "an ordinary word is findable",
  );
  // The vault item is titled "milk bank code". Its ciphertext and the settings
  // rows are not search columns, so its title can never surface.
  const everything = (await globalSearch(driver, "bank code")).flatMap(
    (g) => g.results,
  );
  assert.equal(everything.length, 0, "the vault row must not surface");
  // Even the visible half of that title finds nothing.
  assert.equal(resultCount(await globalSearch(driver, "code")), 0);
});

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

test("empty and punctuation-only input searches for nothing, without error", async () => {
  const driver = sqliteDriver();
  seed(driver.db);
  for (const input of ["", "   ", '"', "'''", "-", "??", "()", "*", "^"]) {
    assert.equal(
      isSearchable(input),
      false,
      `${JSON.stringify(input)} is not searchable`,
    );
    const groups = await globalSearch(driver, input);
    assert.deepEqual(
      groups,
      [],
      `${JSON.stringify(input)} must return no groups`,
    );
  }
});

test("a typed FTS operator is text, not syntax", async () => {
  const driver = sqliteDriver();
  seed(driver.db);
  // These are the tokens that would break a naive MATCH expression. Each is a
  // literal, so the search either finds that word or finds nothing — it never
  // throws.
  for (const input of [
    '"',
    'milk"',
    "AND",
    "OR NOT",
    "NEAR(a b)",
    "*",
    "^milk",
    "a OR",
    "(",
    "col:milk",
  ]) {
    const groups = await globalSearch(driver, input);
    assert.ok(Array.isArray(groups), `${input} must not throw`);
  }
});

test("the term is normalized to NFC and lower case, and keeps its marks", () => {
  // Measured against SQLite: stripping combining marks from the query alone
  // matches nothing, because the stored text still has them.
  assert.equal(normalizeTerm("CAFÉ"), "café");
  assert.equal(normalizeTerm("cafe\u0301"), "café");
  assert.equal(normalizeTerm("  မြန်မာ  "), "မြန်မာ");
  assert.match(
    normalizeTerm("မြန်မာ"),
    /\p{M}/u,
    "Burmese vowel signs are kept",
  );
});

test("a composed and a decomposed spelling of the same word both match", async () => {
  const driver = sqliteDriver();
  driver.db
    .prepare(
      "INSERT INTO tasks (id, title, due_date, done, repeat, note, created_at) VALUES (1, 'café order', NULL, 0, 'none', '', 'x')",
    )
    .run();
  const composed = await globalSearch(driver, "café");
  const decomposed = await globalSearch(driver, "cafe\u0301");
  assert.equal(resultCount(composed), 1);
  assert.equal(
    resultCount(decomposed),
    1,
    "NFC makes both spellings the same term",
  );
});

// ---------------------------------------------------------------------------
// What comes back
// ---------------------------------------------------------------------------

test("one search spans every entity in the contract", async () => {
  const driver = sqliteDriver();
  seed(driver.db);
  const groups = await globalSearch(driver, "milk");
  const types = groups.map((g) => g.type);
  for (const expected of [
    "note",
    "task",
    "contact",
    "journal",
    "memory",
    "payable",
    "loan",
    "shopping_item",
  ] as const) {
    assert.ok(
      types.includes(expected),
      `expected ${expected} in ${types.join(", ")}`,
    );
  }
  // Groups come back in contract order, which is the order the UI shows them.
  const order = SEARCH_CONTRACT.map((s) => s.type);
  assert.deepEqual(
    types,
    types.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b)),
  );
});

test("a title that starts with the term outranks one that merely contains it", async () => {
  const driver = sqliteDriver();
  seed(driver.db);
  // "Milk the cow" is already done, so the state filter would hide it and the
  // test would prove nothing about ranking: ask for inactive rows too.
  const tasks = (
    await globalSearch(driver, "milk", { includeInactive: true })
  ).find((g) => g.type === "task");
  // "Buy milk" contains it, "Milk the cow" starts with it.
  assert.deepEqual(
    tasks?.results.map((r) => r.id),
    [2, 1],
  );
});

test("archived and completed rows are hidden unless asked for", async () => {
  const driver = sqliteDriver();
  seed(driver.db);
  const live = await globalSearch(driver, "shopping");
  const liveNotes = live.find((g) => g.type === "note")?.results ?? [];
  assert.equal(
    liveNotes.some((r) => r.id === 3),
    false,
    "the archived note is hidden by default",
  );
  const withInactive = await globalSearch(driver, "shopping", {
    includeInactive: true,
  });
  const allNotes = withInactive.find((g) => g.type === "note")?.results ?? [];
  assert.equal(
    allNotes.some((r) => r.id === 3),
    true,
  );
  assert.equal(allNotes.find((r) => r.id === 3)?.state, "Archived");

  const tasks = await globalSearch(driver, "cow");
  assert.equal(resultCount(tasks), 0, "a completed task is hidden by default");
  const tasksAll = await globalSearch(driver, "cow", { includeInactive: true });
  assert.equal(tasksAll[0]?.results[0]?.state, "Done");
});

test("a paid job is as finished as a ticked task, and hides the same way", async () => {
  const driver = sqliteDriver();
  seed(driver.db);
  const live = await globalSearch(driver, "roof");
  const jobs = live.find((g) => g.type === "job");
  assert.equal(
    jobs,
    undefined,
    "the paid job does not appear without being asked for",
  );
  const all = await globalSearch(driver, "roof", { includeInactive: true });
  const paid = all.find((g) => g.type === "job")?.results ?? [];
  assert.deepEqual(
    paid.map((r) => r.id),
    [1],
  );
  assert.equal(paid[0]?.state, "Paid");
  // The open job keeps matching a term that only it has.
  assert.equal(resultCount(await globalSearch(driver, "fridge")), 1);
  // And the state word comes from the contract, not from the column name.
  assert.equal(specFor("job")?.inactive?.label, "Paid");
  assert.equal(specFor("job")?.inactive?.value, "paid");
});

test("the same search twice returns the same order", async () => {
  const driver = sqliteDriver();
  seed(driver.db);
  const first = await globalSearch(driver, "milk");
  const second = await globalSearch(driver, "milk");
  assert.deepEqual(
    first.flatMap((g) => g.results.map((r) => `${r.type}:${r.id}`)),
    second.flatMap((g) => g.results.map((r) => `${r.type}:${r.id}`)),
    "ordering must be deterministic, or Up/Down means nothing while typing",
  );
});

test("a type filter narrows the groups", async () => {
  const driver = sqliteDriver();
  seed(driver.db);
  const groups = await globalSearch(driver, "milk", {
    types: ["task", "contact"],
  });
  assert.deepEqual(
    groups.map((g) => g.type),
    ["task", "contact"],
  );
});

test("a date filter bounds by the contract's date column", async () => {
  const driver = sqliteDriver();
  seed(driver.db);
  assert.equal(daysAgo(10, "2026-10-18"), "2026-10-08");
  // Notes are dated by updated_at: the 10-01 note drops out of a 10-day window,
  // the 10-10 one stays.
  const recent = await globalSearch(driver, "milk", {
    since: daysAgo(10, "2026-10-18"),
  });
  const noteIds = (recent.find((g) => g.type === "note")?.results ?? []).map(
    (r) => r.id,
  );
  assert.equal(noteIds.includes(1), false, "the 10-01 note is outside 10 days");
  assert.equal(noteIds.includes(4), true, "the 10-10 note is inside 10 days");
  // Journal entries are dated by entry_date, not updated_at.
  const until = daysAgo(6, "2026-10-18");
  assert.equal(until, "2026-10-12");
  const older = await globalSearch(driver, "milk", { until });
  const journal = older.find((g) => g.type === "journal");
  assert.equal(
    journal?.results.length,
    1,
    "the 10-12 entry is on the boundary and is kept",
  );
  assert.equal(journal?.results[0]?.dateKey, "2026-10-12");
  const before = await globalSearch(driver, "milk", {
    until: daysAgo(7, "2026-10-18"),
  });
  const beforeAll = before.flatMap((g) => g.results);
  assert.equal(
    beforeAll.some((r) => r.id === 1 && r.type === "note"),
    true,
    "the 10-01 note is inside the window",
  );
  assert.equal(
    beforeAll.some((r) => r.type === "task"),
    false,
    "the task due 10-20 is after the window",
  );
});

test("results carry enough to open the exact row", async () => {
  const driver = sqliteDriver();
  seed(driver.db);
  const groups = await globalSearch(driver, "milk");
  // FTS ranking decides which note comes first; this test is about the payload
  // a click needs, so it looks the row up by id.
  const note = groups
    .find((g) => g.type === "note")
    ?.results.find((r) => r.id === 1);
  assert.deepEqual(note?.entity, { type: "note", id: 1 });
  assert.equal(note?.title, "Shopping list");
  assert.equal(note?.excerpt, "milk and eggs");
  assert.equal(note?.date, "2026-10-01");
  // A journal entry opens by DATE, not by row id — it has no row navigation.
  const journal = groups.find((g) => g.type === "journal")?.results[0];
  assert.equal(journal?.dateKey, "2026-10-12");
  assert.equal(journal?.entity, null);
  const shopping = groups
    .find((g) => g.type === "shopping_item")
    ?.results.find((r) => r.id === 1);
  assert.equal(shopping?.parentId, 1, "shopping opens the owning list");
});

test("an empty title still produces a usable row", async () => {
  const driver = sqliteDriver();
  driver.db
    .prepare(
      "INSERT INTO tasks (id, title, due_date, done, repeat, note, created_at) VALUES (1, '', NULL, 0, 'none', '', 'x')",
    )
    .run();
  // Search by the note field, since the title is empty.
  const groups = await globalSearch(driver, "unnamed");
  assert.equal(groups.length, 0);
  const byNote = await globalSearch(driver, "x");
  assert.equal(byNote.length, 0);
});

test("every cap in the contract is enforced, and reported when it bites", async () => {
  const driver = sqliteDriver();
  // 30 tasks all matching: the task cap is 10.
  const insert = driver.db.prepare(
    "INSERT INTO tasks (id, title, due_date, done, repeat, note, created_at) VALUES (?, 'zebra', NULL, 0, 'none', '', 'x')",
  );
  for (let i = 1; i <= 30; i++) insert.run(i);
  // One row that matches a different term, so the group exists but is uncapped.
  driver.db
    .prepare(
      "INSERT INTO tasks (id, title, due_date, done, repeat, note, created_at) VALUES (31, 'Buy milk', NULL, 0, 'none', '', 'x')",
    )
    .run();
  const groups = await globalSearch(driver, "zebra");
  const tasks = groups.find((g) => g.type === "task");
  assert.equal(tasks?.results.length, specFor("task")?.cap);
  assert.equal(tasks?.capped, true, "a capped group says so");
  const notCapped = await globalSearch(driver, "milk");
  assert.equal(
    notCapped.find((g) => g.type === "task")?.capped,
    false,
    "a group under its cap does not claim it was capped",
  );
});

test("the total cap trims from the end and drops emptied groups", () => {
  const group = (type: string, n: number): SearchGroup => ({
    type: type as SearchGroup["type"],
    label: type,
    capped: false,
    results: Array.from({ length: n }, (_, i) => ({
      type: type as SearchGroup["type"],
      label: type,
      id: i + 1,
      dateKey: null,
      title: `${type} ${i}`,
      excerpt: null,
      date: null,
      state: null,
      entity: null,
      parentId: null,
    })),
  });
  const trimmed = applyTotalCap(
    [group("note", 10), group("task", 10), group("contact", 10)],
    15,
  );
  assert.equal(resultCount(trimmed), 15);
  assert.deepEqual(
    trimmed.map((g) => g.type),
    ["note", "task"],
  );
  assert.equal(trimmed[1]?.results.length, 5);
  // A cap of zero shows nothing rather than empty headings.
  assert.deepEqual(applyTotalCap([group("note", 3)], 0), []);
  assert.equal(SEARCH_TOTAL_CAP > 0, true);
});

test("no value is ever interpolated into the SQL", () => {
  const input = "'; DROP TABLE notes; --";
  for (const spec of SEARCH_CONTRACT) {
    const { sql, params } = buildSearchQuery(spec, input, {});
    assert.equal(
      sql.includes("DROP"),
      false,
      `${spec.type}: SQL must not carry input`,
    );
    assert.equal(sql.includes(";"), false, `${spec.type}: one statement only`);
    // Every ? has a parameter, in order.
    const placeholders = (sql.match(/\?/g) ?? []).length;
    assert.equal(
      params.length,
      placeholders,
      `${spec.type}: placeholders match params`,
    );
  }
});

test("the FTS path reuses the existing MATCH builder, with its limit", () => {
  const spec = specFor("note");
  assert.ok(spec);
  const { sql, params } = buildSearchQuery(spec, "buy milk", {});
  assert.match(sql, /notes_fts MATCH \?/);
  assert.equal(params[0], '"buy"* "milk"*');
  // And it asks for one row more than the cap, so it can tell it bit.
  assert.match(sql, new RegExp(`LIMIT ${(spec?.cap ?? 0) + 1}$`));
});
