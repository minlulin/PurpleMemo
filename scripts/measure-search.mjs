#!/usr/bin/env node
/**
 * Latency harness for the global search path.
 *
 * NOT part of `npm run verify`: it builds a deliberately large dataset and is
 * run by hand on the target Windows machine, so the numbers recorded in the
 * plan are measured rather than guessed:
 *
 *   node scripts/measure-search.mjs
 *   node scripts/measure-search.mjs --notes 20000 --iterations 40
 *   node scripts/measure-search.mjs --json
 *
 * What it measures:
 *   - the real `globalSearch()` from `src/lib/globalSearch.ts`, against the
 *     real `BASELINE_SQL` extracted from `src-tauri/src/schema.rs`, so the
 *     schema, the FTS5 triggers and the indexes are the shipping ones;
 *   - three numbers per query, because three different things can go slow:
 *       query   the SQL itself, run synchronously. In the app this is Rust
 *               work on a Tauri thread, so it is latency, not blocking.
 *       shape   turning rows into SearchResult objects. This one runs on the
 *               webview's main thread and IS blocking.
 *       total   what someone waits for between a keystroke and results.
 *
 * Two honest limits, recorded in the plan next to the numbers:
 *   - the app's database is SQLCipher-encrypted, so every read here is
 *     unencrypted and the SQL numbers are a floor, not a ceiling;
 *   - the text is synthetic. The shape is what matters for scanning cost, not
 *     the words; the Burmese terms are there because search folding is
 *     Unicode-sensitive and the real user writes Burmese.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const { globalSearch } = await import(
  pathToFileURL(join(root, "src/lib/globalSearch.ts")).href
);
const { buildMatchQuery } = await import(
  pathToFileURL(join(root, "src/lib/search.ts")).href
);
const { SEARCH_CONTRACT, globExpression, globTerm, isSearchable } =
  await import(pathToFileURL(join(root, "src/lib/searchContract.ts")).href);

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const num = (name, fallback) => Number(flag(name, fallback));

/**
 * A user who has had this app for years, not a user who installed it on
 * Tuesday. Sizes are per-entity and each is generous on purpose.
 */
const SIZES = {
  notes: num("--notes", 3_000),
  tasks: num("--tasks", 800),
  contacts: num("--contacts", 300),
  journal_entries: num("--journal", 500),
  memories: num("--memories", 200),
  jobs: num("--jobs", 300),
  payables: num("--payables", 150),
  loans: num("--loans", 60),
  shopping_items: num("--shopping", 400),
};
const ITERATIONS = num("--iterations", 25);
const AS_JSON = args.includes("--json");

// ---------------------------------------------------------------------------
// Schema: the shipping DDL, not a copy of it
// ---------------------------------------------------------------------------

const schemaSrc = readFileSync(join(root, "src-tauri/src/schema.rs"), "utf8");
const baseline = schemaSrc.match(
  /pub const BASELINE_SQL: &str = r#"([\s\S]*?)"#;/,
)[1];

const db = new DatabaseSync(":memory:");
db.exec(baseline);

// ---------------------------------------------------------------------------
// Synthetic data
// ---------------------------------------------------------------------------

const WORDS = [
  "roof",
  "shed",
  "milk",
  "invoice",
  "supplier",
  "roofing",
  "fence",
  "gutter",
  "generator",
  "warranty",
  "invoice",
  "paint",
  "timber",
  "cement",
  "labour",
  "မြန်မာ",
  "ခေါင်းစဉ်",
  "အိမ်",
  "ပန်ကာ",
  "ကြေးသွန်း",
  "ရေ",
  "မီး",
  "လက်ကိုင်",
  "receipt",
  "delivery",
  "invoice",
  "quote",
  "estimate",
  "deposit",
  "final",
];
const pick = (n) => WORDS[n % WORDS.length];
const sentence = (seed, words = 24) =>
  Array.from({ length: words }, (_, i) => pick(seed + i * 7)).join(" ");
/** A distinct calendar day per row: `entry_date` is UNIQUE in the real schema. */
const day = (offset) =>
  new Date(Date.UTC(2019, 0, 1) + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);

/** Terms a user actually types, from shortest to longest. */
const QUERIES = [
  ["1-char", "r"],
  ["2-char", "ro"],
  ["3-char prefix", "roo"],
  ["common word", "invoice"],
  ["2 tokens", "roof invoice"],
  ["3 tokens", "roof repair invoice"],
  ["burmese", "ပန်ကာ"],
  ["burmese mixed", "ပန်ကာ ရေ"],
  ["punctuation", '"roof* (invoice)'],
  ["rare/absent", "zzzzqqq"],
  ["empty-ish", "   "],
  ["long tail", "warranty certificate for the generator installation work"],
];

function seed() {
  const note = db.prepare(
    `INSERT INTO notes (id, title, content, tags, collection_id, pinned, archived, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
  );
  const noteTx = db.transaction ? db : { transaction: (f) => f };
  for (let i = 1; i <= SIZES.notes; i++) {
    const w = sentence(i);
    note.run(
      i,
      i % 9 === 0 ? "" : `${pick(i)} ${pick(i + 3)} ${i}`,
      w,
      `${pick(i + 11)} ${pick(i + 5)}`,
      i % 40 === 0 ? 1 : 0,
      i % 23 === 0 ? 1 : 0,
      day(i),
      day(i + 1),
    );
  }

  const task = db.prepare(
    `INSERT INTO tasks (id, title, due_date, done, repeat, note, created_at)
     VALUES (?, ?, ?, ?, 'none', ?, ?)`,
  );
  for (let i = 1; i <= SIZES.tasks; i++) {
    task.run(
      i,
      `${pick(i)} ${pick(i + 2)} ${i}`,
      day(i + 5),
      i % 6 === 0 ? 1 : 0,
      sentence(i, 8),
      day(i),
    );
  }

  const contact = db.prepare(
    `INSERT INTO contacts (id, name, address, notes, created_at) VALUES (?, ?, ?, ?, ?)`,
  );
  for (let i = 1; i <= SIZES.contacts; i++) {
    contact.run(
      i,
      `${pick(i)} ${pick(i + 13)} ${i}`,
      `${i} ${pick(i + 2)} Road`,
      sentence(i, 10),
      day(i),
    );
  }

  const journal = db.prepare(
    `INSERT INTO journal_entries (id, entry_date, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  );
  for (let i = 1; i <= SIZES.journal_entries; i++) {
    journal.run(i, day(i), sentence(i, 60), day(i), day(i));
  }

  const memory = db.prepare(
    `INSERT INTO memories (id, title, memory_date, note, created_at) VALUES (?, ?, ?, ?, ?)`,
  );
  for (let i = 1; i <= SIZES.memories; i++) {
    memory.run(i, `${pick(i)} day ${i}`, day(i + 40), sentence(i, 20), day(i));
  }

  const job = db.prepare(
    `INSERT INTO jobs (id, title, shop_id, total_cents, paid_cents, job_date, warranty_days, status, note, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?)`,
  );
  for (let i = 1; i <= SIZES.jobs; i++) {
    job.run(
      i,
      `${pick(i)} ${pick(i + 4)} ${i}`,
      1000 + i,
      1000 + i,
      day(i + 2),
      i % 4 === 0 ? "paid" : "open",
      sentence(i, 12),
      day(i),
    );
  }

  const payable = db.prepare(
    `INSERT INTO payables (id, title, amount_cents, shop_id, due_date, paid, note, created_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
  );
  for (let i = 1; i <= SIZES.payables; i++) {
    payable.run(
      i,
      `${pick(i)} ${pick(i + 6)} ${i}`,
      1000 + i,
      day(i + 3),
      i % 5 === 0 ? 1 : 0,
      sentence(i, 8),
      day(i),
    );
  }

  const loan = db.prepare(
    `INSERT INTO loans (id, counterparty, direction, amount_cents, repaid_cents, due_date, note, created_at)
     VALUES (?, ?, 'lent', ?, 0, ?, ?, ?)`,
  );
  for (let i = 1; i <= SIZES.loans; i++) {
    loan.run(
      i,
      `${pick(i)} ${pick(i + 9)} ${i}`,
      1000 + i,
      day(i + 7),
      sentence(i, 8),
      day(i),
    );
  }

  db.prepare(
    "INSERT INTO shopping_lists (id, name, created_at) VALUES (1, 'Shop', '2026-01-01')",
  ).run();
  const item = db.prepare(
    "INSERT INTO shopping_items (id, list_id, text, done, sort_order) VALUES (?, 1, ?, ?, ?)",
  );
  for (let i = 1; i <= SIZES.shopping_items; i++) {
    item.run(i, `${pick(i)} ${pick(i + 8)} ${i}`, i % 7 === 0 ? 1 : 0, i);
  }
  void noteTx;
}

const t0 = performance.now();
seed();
const seedMs = performance.now() - t0;

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

const driver = {
  query: async (sql, params = []) => db.prepare(sql).all(...params),
  db,
};

/** Sync SQL time alone: the number that would block if it ran on the UI thread. */
function sqlOnly(input, options = {}) {
  if (!isSearchable(input)) return 0;
  let ms = 0;
  for (const spec of SEARCH_CONTRACT) {
    // The shipping shape of a folded entity's WHERE (K4): `col GLOB ?` per
    // searchable column, with the term folded into character classes.
    const pattern = `*${globTerm(input)}*`;
    const params = spec.searchable.map(() => pattern);
    let sql;
    if (spec.match === "fts") {
      // The shipping token quoting, imported rather than re-derived: a
      // hand-rolled copy would let this harness report a healthy number while
      // the app's own MATCH expression regressed (docs/AUDIT.md DUP-11).
      sql = `SELECT n.id FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid
             WHERE notes_fts MATCH ? AND n.archived = 0 ORDER BY rank LIMIT ${spec.cap + 1}`;
      params.length = 0;
      params.push(buildMatchQuery(input));
    } else {
      sql = `SELECT id FROM ${spec.table} WHERE (${globExpression(spec)}) LIMIT ${spec.cap + 1}`;
    }
    const a = performance.now();
    db.prepare(sql).all(...params);
    ms += performance.now() - a;
  }
  void options;
  return ms;
}

const pct = (sorted, p) =>
  sorted.length === 0
    ? 0
    : sorted[
        Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
      ];

const rows = [];
for (const [label, input] of QUERIES) {
  const totals = [];
  const sqls = [];
  let hits = 0;
  // Warm the page cache, the way a user who has had the app open for a minute
  // experiences it. The first run is reported separately below.
  await globalSearch(driver, input);
  for (let i = 0; i < ITERATIONS; i++) {
    const sqlMs = sqlOnly(input);
    sqls.push(sqlMs);
    const a = performance.now();
    const groups = await globalSearch(driver, input);
    totals.push(performance.now() - a);
    hits = groups.reduce((n, g) => n + g.results.length, 0);
  }
  // One cold run, reported nowhere today but kept as a sanity check against
  // the warm numbers.
  await globalSearch(driver, input);
  totals.sort((x, y) => x - y);
  sqls.sort((x, y) => x - y);
  rows.push({
    query: label,
    input: input.length > 24 ? `${input.slice(0, 23)}…` : input,
    results: hits,
    p50: pct(totals, 50),
    p95: pct(totals, 95),
    max: totals[totals.length - 1],
    sqlP95: pct(sqls, 95),
  });
}

const sizeLine = Object.entries(SIZES)
  .map(([table, n]) => `${table} ${n.toLocaleString("en-US")}`)
  .join(", ");

if (AS_JSON) {
  console.log(
    JSON.stringify(
      { seedMs, sizes: SIZES, iterations: ITERATIONS, rows },
      null,
      2,
    ),
  );
} else {
  const f = (n) => `${n.toFixed(1)} ms`;
  console.log(`PurpleMemo search latency — ${ITERATIONS} iterations per query`);
  console.log(`dataset: ${sizeLine} (seeded in ${seedMs.toFixed(0)} ms)`);
  console.log("");
  console.log(
    "query".padEnd(16) +
      "results".padStart(8) +
      "p50".padStart(10) +
      "p95".padStart(10) +
      "max".padStart(10) +
      "sql p95".padStart(10),
  );
  for (const r of rows) {
    console.log(
      r.query.padEnd(16) +
        String(r.results).padStart(8) +
        f(r.p50).padStart(10) +
        f(r.p95).padStart(10) +
        f(r.max).padStart(10) +
        f(r.sqlP95).padStart(10),
    );
  }
}
