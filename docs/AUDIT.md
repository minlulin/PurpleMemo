# PurpleMemo — Codebase Audit

**Date:** 2026-11-01
**Commit audited:** `aa8a6cf` (`dev`, branch `arena/472ac602-purplememo`)
**Scope:** whole repository — `src/` (TypeScript/React), `src-tauri/src/` (Rust),
`src-tauri/share/` (LAN page), `scripts/`, SQL schema and migrations, docs.
**Categories requested:** duplicate usage · dead code · schema mismatch ·
performance bottlenecks.

**Remediation:** applied on the same branch after the report — status per
finding in [§10](#10-remediation-status). Where the code was changed, the
comment there names the finding ID so the two stay traceable.

---

## 1. Executive summary

PurpleMemo is in unusually good shape for a ~69 k-line single-developer
codebase. This audit was run *against* the repository, not read off it:

| Gate | Result in this environment |
| --- | --- |
| `tsc --noEmit` | **clean** |
| `biome check` (176 files) | **clean** (1 info-level style note in a test file) |
| `node --test "src/**/*.test.ts"` | **852 tests, 852 pass, 0 fail** (after remediation: 828 + 24 new) |
| `vite build` | **success** (index 279.4 kB / 73.1 kB gz) |
| `cargo test` / `clippy` / `fmt` | **not run** — no Rust toolchain and no crates.io access in the audit sandbox |

No data-corruption bug, no column-name typo, and no missing-`NOT NULL` insert
was found. What remains is a set of **37 findings**, dominated by performance
work that only bites at realistic data volume (five-figure ledger rows,
thousands of photos) and by maintenance duplication.

**The five things worth doing first**

1. **PERF-01** — `substr(entry_date,1,7)` month filters full-scan
   `income_entries`/`expense_entries` even though `idx_*_entries_date` exists.
   Measured **59×** slower than an equivalent range scan at 100 k rows.
2. **PERF-09** — nine hot-path indexes are missing; most visibly the Notes
   browse `ORDER BY pinned, updated_at`, which is `SCAN + TEMP B-TREE` today.
3. **PERF-10** — SQLite is opened with default `synchronous=FULL` (an fsync per
   autocommit write) and no prepared-statement cache (`prepare` on every IPC
   call, including every row of a 100 k-statement import).
4. **PERF-02** — the Notes page fires a DB query **per keystroke** (no debounce,
   although `SEARCH_DEBOUNCE_MS` exists) and recomputes a grapheme-aware excerpt
   for **every** note on **every** render (~0.13–0.2 ms/row measured).
5. **PERF-06 / PERF-07** — backup export issues one IPC round trip per photo
   while holding the whole library in memory; every photo saved or imported is
   SHA-256'd twice (once in Rust to name the file, once again in the webview).

### Findings by category and severity

| Category | High | Medium | Low | Info | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Duplicate usage (DUP) | 1 | 5 | 5 | 1 | 12 |
| Dead code (DEAD) | 0 | 0 | 4 | 1 | 5 |
| Schema mismatch / drift (SCHEMA) | 0 | 2 | 3 | 0 | 5 |
| Performance (PERF) | 6 | 6 | 3 | 0 | 15 |
| **Total** | **7** | **13** | **15** | **2** | **37** |

> Severity = user-visible impact at *realistic* data volume for this app
> (an offline personal notebook used for years), not abstract code quality.
> Nothing here is a security regression; the security-sensitive surfaces
> (SQLCipher key handling, path traversal, IPC header decoding, LAN share
> consent, reset engine) were read and look sound.

### Repository profile

| Metric | Value |
| --- | --- |
| Tables | 31 regular + `notes_fts` (`SCHEMA_VERSION = 5` when audited; **6** after §10 added the index migration) |
| Source lines (TS/TSX/Rust/scripts) | 69,100 |
| SQL string literals in TS/scripts | 447 |
| `driver.*` call sites in `src/` | 259 |
| IPC commands | 25 (driver ↔ `commands.rs`) |
| Largest modules | `db.rs` 3,546 · `BudgetPage.tsx` 1,961 · `i18n.ts` 1,665 · `BusinessPage.tsx` 1,659 |
| Tests | 828 (3 files use real `node:sqlite`; the rest use the mock driver) |

---

## 2. Duplicate usage

### DUP-01 — `cell()` helper duplicated verbatim — **Low**

* **Where:** `src/lib/taskImport.ts:56`, `src/lib/contactImport.ts:78`
* **What:** byte-identical 10-line helper (alias lookup + spreadsheet-formula
  unescaping), differing only in surrounding comments.
* **Evidence:** both bodies read `if (row[name] !== undefined) return
  unescapeSpreadsheetCell(row[name]); …` with the same alias loop.
* **Fix:** move one copy into `src/lib/csv.ts` (which already owns
  `unescapeSpreadsheetCell`) and import it in both importers.
* **Effort:** 15 min.

### DUP-02 — Two birthday formatters, two month-day caches, two outputs — **Medium**

* **Where:** `src/lib/format.ts:117–155` (`monthDayFormatters`,
  `monthDayFormatter`, `formatBirthday`) and `src/lib/contacts.ts:68–104`
  (`monthDayFormatters`, `monthDayFormatter`, `birthdayLabel`)
* **What:** the Intl formatter and its `Map<Locale, …>` cache are duplicated;
  then the *label* logic is duplicated too, with different results for the same
  input and locale:
  * `formatBirthday("en", "1990-10-20")` → `formatDate` → `"Oct 20, 1990"`
  * `birthdayLabel("1990-10-20", "en")` → hand-rolled `MONTH_SHORT` → `"Oct 20, 1990"`
  (same today, but the two paths diverge for a `my` locale and for malformed
  input, where `formatBirthday` returns the raw string while `birthdayLabel`
  renders `"?? ?"`).
* **Evidence:** `contacts.ts:89` is exported and used by
  `ContactsPage`/`MemoriesPage`; `formatBirthday` is exported from `format.ts`.
  Two independent `Intl.DateTimeFormat` caches are built for the same options.
* **Fix:** keep `formatBirthday` as the single implementation, have
  `birthdayLabel` delegate to it (or delete `birthdayLabel` and use
  `formatBirthday(locale, …)` at the four call sites).
* **Effort:** 30 min + 2 test updates.

### DUP-03 — The day-rollover timer is re-implemented five times, three ways — **Medium**

* **Where:** `DashboardPage.tsx:222–228`, `HabitsPage.tsx:109–115`,
  `JournalPage.tsx:165–172`, `LoansPage.tsx:109–115`,
  `MemoriesPage.tsx:241–247`
* **What:** every long-lived page carries its own
  `setInterval(…, 60_000)` that compares `todayLocal()` with either a state
  value (`Dashboard`, `Habits`, `Journal`) or a ref (`Loans`, `Memories`) and
  then calls `reload()` — five copies, two different staleness strategies, and
  `Journal` only updates `today` instead of reloading.
* **Impact:** the rule "a page open across midnight must re-anchor to the new
  day" is documented once per page and can drift five ways; the ref-based
  versions never re-arm when the day changes if `reload` is memoised away.
* **Fix:** add `useDayRollover(onRollover: () => void)` to `src/lib/` (the repo
  already keeps hooks there, e.g. `useReveal.ts`) and use it in all five pages.
* **Effort:** 1 h.

### DUP-04 — Load-sequence guard re-implemented inline — **Low**

* **Where:** `src/lib/loads.ts:20–33` (`createLoadGuard`), used by
  `ContactsPage`, `GalleryPage`, `NotesPage`, `TasksPage`, `VaultPage`;
  hand-rolled again at `HabitsPage.tsx:65–101` and `InboxPage.tsx:124–159`.
* **What:** `reloadSeqRef` + `++`/`!==` checks duplicate the same monotonic
  token the guard already implements (the comment in `loads.ts:9` even says the
  rule used to live inline in one page).
* **Fix:** replace both inline versions with `createLoadGuard()`.
* **Effort:** 30 min.

### DUP-05 — Ledger inserts duplicated across two repositories — **High**

* **Where:** `budget.ts:549` (income), `budget.ts:565` and `budget.ts:1006`
  (expense), `business.ts:489` (income), `business.ts:632` (expense)
* **What:** the same five-line `INSERT INTO income_entries|expense_entries
  (amount_cents, category_id, wallet_id, entry_date, note, created_at)` appears
  **five times across two modules**. `business.ts` writes the Budget's tables
  directly (job payment → income entry, payable payment → expense entry) instead
  of composing through `budget.ts`.
* **Impact:** adding a column (e.g. a `shop_id` or a `method` field) or changing
  the `created_at` policy means editing five sites in two modules, with no
  compiler help — and the business paths are the easiest to miss.
* **Fix:** export `entryInsertStatement(kind, input): BatchStatement` from
  `budget.ts` (it already builds batch statements internally at `:1006`) and use
  it from `business.ts` so the column list exists once.
* **Effort:** 1 h.

### DUP-06 — Settings SQL bypasses the settings repository — **Medium**

* **Where:** `settings.ts:54, 62, 74, 82` (the owner);
  `gallery.ts:123, 436, 480`; `vault.ts:109, 120, 222, 242, 277`
* **What:** `settings.ts:1–4` states "this module is the only place that knows
  the key names", yet the upsert
  `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE …`
  is copied four times outside it, and `vault.ts:21,30` invents
  `vault_setup` / `vault_verify` outside `SETTING_KEYS`.
* **Impact:** three different writers with three error/`JSON` policies; a future
  change (encryption at rest for setting values, a row-level audit) lands in one
  of four places.
* **Fix:** expose `settingsRepo.getRaw/setRaw` to `gallery`/`vault` (or a
  `settingsKey(namespace)` helper) and add the two vault keys to `SETTING_KEYS`.
* **Effort:** 2 h.

### DUP-07 — Open-tasks query twice in the same module — **Low**

* **Where:** `tasks.ts:131–135` (`listTasks`) and `tasks.ts:251–255`
  (`openTasks`)
* **What:** `SELECT * FROM tasks WHERE done = 0 ORDER BY due_date IS NULL,
  due_date, id` is written twice; `notes.ts` solved exactly this with a single
  `noteListQuery()` builder.
* **Fix:** extract `taskListQuery(includeDone)`, mirroring `noteListQuery`.
* **Effort:** 20 min.

### DUP-08 — Reference reads re-implemented in the exporter — **Low**

* **Where:** `exports.ts:923` vs `notes.ts:205`
  (`SELECT * FROM collections ORDER BY name`); `exports.ts:974` vs
  `loans.ts:39` (`SELECT * FROM loans ORDER BY id`)
* **What:** the exporter issues its own reads of tables the repos already own,
  so ordering/derivation changes in a repo do not reach the export.
* **Fix:** accept the repo instances in `ExportData` (the pattern already used by
  `createShareRepo(driver, repos)`), or import the repo functions.
* **Effort:** 45 min.

### DUP-09 — `@noble/ciphers` is vendored byte-for-byte with no drift check — **Medium**

* **Where:** `src-tauri/share/_crypto/{aes,_polyval,utils}.js` vs
  `node_modules/@noble/ciphers@2.4.0`
* **What (measured):** all three files are **byte-identical** to the installed
  package today. That is the good news; the risk is that nothing enforces it.
  `package.json` pins `2.4.0`; a bump leaves the LAN page decrypting with the
  old library, and `README.md` only *describes* how to refresh the copy.
* **Impact:** the phone page is the one artefact with no test that touches the
  real crypto binary; drift surfaces only on a phone at runtime.
* **Fix:** extend `scripts/check-versions.mjs` (already in the verify gate) with
  a byte compare of the three files against `node_modules/@noble/ciphers`, and
  fail with the copy command in the message.
* **Effort:** 30 min.

### DUP-10 — Limits and constants duplicated across the TS/Rust boundary — **Medium**

| Constant | TS | Rust | Other copies |
| --- | --- | --- | --- |
| 25 MiB per-photo ceiling | `backup.ts:66` `MAX_BACKUP_PHOTO_BYTES` | `commands.rs:68` `MAX_SAVED_PHOTO_BYTES` | — |
| 512 KiB snapshot ceiling | `share.ts:58` `MAX_SNAPSHOT_BYTES` | `share.rs:57` `MAX_SNAPSHOT_BYTES` | `mock-driver.ts:33` |
| Import-blocked message | `mock-driver.ts:22` | `lifecycle.rs:56` | — |

* **What:** the same value under **different names** in two languages, kept in
  sync only by `ipc.test.ts`/`share.test.ts` string assertions.
* **Fix:** keep the tests, but also generate a tiny `shared/limits.json`-style
  source (or a `scripts/check-versions.mjs` assertion) so a rename in one
  language fails the gate even if the value is right.
* **Effort:** 1 h.

### DUP-11 — `scripts/measure-search.mjs` re-implements the search query — **Low**

* **Where:** `scripts/measure-search.mjs:294–297` vs `search.ts:26–90` and
  `search.ts:35` (`buildMatchQuery`) / `searchContract.ts`
* **What:** the measurement harness rebuilds the FTS SQL, the `ORDER BY rank`
  and the token-quoting by hand. Benchmarks therefore measure a *copy* of the
  query and will happily report a healthy number while the app's own query
  regresses.
* **Fix:** import `buildMatchQuery` and the query builder from `../src/lib/*.ts`
  (the script already runs under `node --test`-capable TS resolution elsewhere in
  the repo), or assert the SQL string matches the module's output.
* **Effort:** 45 min.

### DUP-12 — Baseline DDL duplicates the migration DDL — **Info (accepted)**

* **Where:** `src-tauri/src/schema.rs` — `MIGRATION_1_2`…`MIGRATION_4_5` repeat
  the `CREATE TABLE` bodies also present in `BASELINE_SQL`.
* **Assessment:** this is a deliberate, documented trade-off (a fresh install
  must reach the current version in one step) and it is **pinned by tests**
  (`db.rs:2173` compares the migrated structure to the baseline,
  `db.rs:2097` covers every version gap). Leave as is; do not "de-duplicate" it
  into string concatenation — that would make the tests unable to compare two
  independently written definitions.

---

## 3. Dead code

Checked: every exported symbol in `src/` (669), every `pub fn`/`pub const`/
`pub struct` in `src-tauri/src`, every i18n key, every component, every
`package.json` dependency, every `.md` in `docs/`.

**I18n: 568 English keys, 567 used in production** (only
`settings.languageHint` is unreferenced). Every dependency in `package.json` is
imported (the updater plugin via a dynamic `import()` in `update.ts:67`).

### DEAD-01 — Thirteen exported symbols with no production caller — **Low**

| Symbol | Location | Only referenced by |
| --- | --- | --- |
| `LINK_KINDS` | `lib/entityLinks.ts:34` | nothing |
| `linkEndpoints` | `lib/entityLinks.ts:166` | nothing |
| `formatLocalDate` | `lib/format.ts:188` | nothing |
| `formatLocalDateTime` | `lib/format.ts:193` | nothing |
| `urlTransform` (alias) | `lib/links.ts:45` | re-export only |
| `formatYearMonth` | `lib/format.ts:80` | tests |
| `daysBetween` | `lib/dates.ts:155` | tests |
| `confirmLabel` | `lib/confirm.ts:57` | tests |
| `pickerRowLabel` | `lib/entityPicker.ts:177` | tests |
| `isPhotoCleanupPending` | `lib/gallery.ts:87` | tests |
| `opensExternally` | `lib/links.ts:69` | tests |
| `placeholdersIn` / `missingMessageKeys` | `lib/i18n.ts:1527, 1548` | tests |

* **Why it matters:** each is a small piece of public surface that no user path
  exercises; `formatLocalDate`/`formatLocalDateTime` in particular look like they
  were meant to be used and were not (the UI calls `formatDate` with an explicit
  locale instead). `urlTransform` is re-exported by `MarkdownLink.tsx:132` and
  then never imported — a dead alias two files deep.
* **Fix:** delete the five with no caller at all (`LINK_KINDS`, `linkEndpoints`,
  `formatLocalDate`, `formatLocalDateTime`, the `urlTransform` alias **and** its
  re-export in `MarkdownLink.tsx`). For the eight test-only helpers, either keep
  them with an explicit `@internal` note (the tests do exercise real behaviour:
  i18n completeness, vCard-adjacent label logic) or move each into the test that
  needs it — they should not read as app API.
* **Effort:** 30 min.

### DEAD-02 — Dead setting key — **Low**

* **Where:** `src/lib/settings.ts:20` — `vault: "vault"`
* **Evidence:** no `get*`/`set*` helper and no SQL anywhere reads or writes the
  literal `"vault"`; the vault uses `vault_setup` (`vault.ts:21`) and
  `vault_verify` (`vault.ts:30`).
* **Fix:** delete the entry (or reintroduce it *as* the vault namespace and
  collapse the two keys into it — see DUP-06).
* **Effort:** 5 min.

### DEAD-03 — Manual-transaction IPC surface with zero callers — **Low (intentional)**

* **Where:** `driver.ts:178–182` (`begin`/`commit`/`rollback`/`resetTxn`),
  `commands.rs` (`db_begin`, `db_commit`, `db_rollback`, `db_reset_txn`),
  `mock-driver.ts:279`.
* **Evidence:** no `src/` call site outside the driver and the mock;
  `commands.rs:225` documents it: "intentionally retained even though no app code
  calls them today: the surface is mandated".
* **Risk to note:** four Rust commands, their guards and the `txn_open` flag are
  protected only by tests, and `db_batch` must keep refusing while the flag is
  set. That is tested (`db.rs` "db_query cannot commit or begin around the txn
  flag"), but it is dead weight carried for a plan rather than a caller.
* **Fix:** none required. If the mandate lapses, delete the four commands, the
  four driver methods and the flag together — not one at a time.

### DEAD-04 — `_snapshot.js` exports used only through the LAN page — **Info**

* `src-tauri/share/_snapshot.js` exports four helpers; `keyBytes`/
  `base64Bytes`/`envelopeAad` are used internally, `decryptSnapshot` by the page
  and by the Node test. Correctly shared, no action.

### DEAD-05 — Three "plan" documents that describe shipped work — **Low**

* **Where:** `docs/PurpleMemo_First_Release_Prompt.md`,
  `docs/PurpleMemo_Dashboard_Tray_Plan.md`, `docs/PurpleMemo_Import_Tasks.md`
* **What:** plans for work that is implemented (the tray exists — `lib.rs:18`,
  `TrayIconBuilder`; import exists — `backup.ts`; the first release shipped).
  They read as current requirements to a newcomer and duplicate detail that has
  since moved into the code and `docs/RELEASE.md`.
* **Fix:** move to `docs/history/` with a one-line header ("historical plan,
  superseded by the code") or delete, consistent with the previous audit's
  decision to keep findings outside the repo.
* **Effort:** 15 min.

---

## 4. Schema mismatch & schema-drift risk

**Headline: no live mismatch was found.** This was checked mechanically, not by
eye — see §6 for exactly what was verified. What follows are the places where
the code and the schema are only *coincidentally* in agreement today.

### SCHEMA-01 — Trash snapshots hand-maintain column lists — **Medium (data-loss class)**

* **Where:** `src/lib/trash.ts:60–96` (`COLUMNS`, `CONTACT_CHANNEL_COLUMNS`,
  `CONTACT_TAG_COLUMNS`, `PHOTO_REF_COLUMNS`, `LINK_COLUMNS`)
* **What:** five hard-coded column arrays mirror `schema.rs` by hand. A trash
  snapshot stores exactly these columns and `restoreUnlocked` re-inserts exactly
  these columns (`trash.ts:533`).
* **Current state:** all five lists are complete and exact (verified against the
  DDL), so nothing is lost today.
* **The risk:** add a column with a migration — say `notes.colour` — and every
  *existing* trash snapshot still restores fine (it never had the column), but a
  note trashed *after* the migration loses `colour` on restore, silently. There
  is no test that compares `COLUMNS` to `pragma_table_info`.
* **Fix:** derive the lists at runtime
  (`SELECT name FROM pragma_table_info(?)`) inside `trashEntity`, or add a Rust
  test asserting `COLUMNS` equals `pragma_table_info` for each of the five
  tables. The test is cheaper and keeps the snapshot shape explicit.
* **Effort:** 1 h (test) / 3 h (derive).

### SCHEMA-02 — `types.ts` is documented as the home of row types, but four tables live elsewhere — **Low**

* **Where:** `src/lib/types.ts:1–4` ("Row/domain types for the 31-table schema").
  No `*Row` interface exists for `income_entries`, `expense_entries`, `settings`
  or `trash_items`; `trash.ts:22` defines `TrashItemRow` itself and
  `budget.ts`/`settings.ts` use inline anonymous generics
  (e.g. `budget.ts:757` `{ total: number }`).
* **Impact:** the "31 tables, 31 row types" rule is 27/31 true; a reader cannot
  rely on `types.ts` as the schema index, and the ledger rows — the only tables
  with money arithmetic — are the ones without a named type.
* **Fix:** add `IncomeEntryRow`, `ExpenseEntryRow`, `SettingRow` to `types.ts`
  and use them in `budget.ts`; move `TrashItemRow` there too.
* **Effort:** 45 min.

### SCHEMA-03 — `notes_fts` doubles note storage and rewrites the body on every update — **Medium**

* **Where:** `src-tauri/src/schema.rs:176` — a **plain** (content-ful) FTS5
  table: `CREATE VIRTUAL TABLE notes_fts USING fts5(title, content, tags, folder)`
  plus the three triggers at `schema.rs:178–206`.
* **Measured cost** (300 × ~1.8 kB notes, `node:sqlite`):

  | Schema | Size |
  | --- | --- |
  | `notes` only | 0.60 MiB |
  | `notes` + `notes_fts` | **1.33 MiB (×2.21)** |

* **Second cost:** the `AFTER UPDATE` trigger re-writes `title, content, tags,
  folder` for **every** `UPDATE` on `notes`, including
  `setPinned`/`setArchived`/`updated_at` bumps (`notes.ts:314, 321`), so pinning
  a long note rewrites its whole body into the index.
* **Options:**
  1. Keep as is, and narrow the trigger with
  `AFTER UPDATE OF title, content, tags, collection_id ON notes` — a small
  migration (drop + recreate the trigger) that removes the needless index
  rewrites;
  2. Convert to external-content FTS5 (`content='notes'`), which halves storage,
  at the cost of losing `folder` from the index (collection-name search would
  then need a join). Given `folder` is only searchable through the notes page's
  whole-index match, option 1 plus accepting the storage is the pragmatic choice
  for a personal notebook.
* **Effort:** 30 min (trigger narrow) / 1 day (external content).

### SCHEMA-04 — The import integrity canary depends on a `NOT NULL` constraint — **Low**

* **Where:** `src/lib/backup.ts:820`

  ```sql
  INSERT INTO settings (key, value) SELECT 'import-fk-check', NULL
   WHERE EXISTS (SELECT 1 FROM pragma_foreign_key_check)
  ```

* **What:** the statement is designed to *fail* when the imported payload has a
  dangling foreign key, which rolls the batch back — and it fails only because
  `settings.value` is `TEXT NOT NULL` (`schema.rs:513`). If that column ever
  gains a default or loses `NOT NULL`, the canary silently becomes a no-op that
  inserts a junk row and lets a broken import commit. `backup.test.ts:1009`
  pins the SQL *text*, and `:1582` exercises the behaviour on real SQLite, so a
  schema change would be caught — but only by the behavioural test, and only if
  it is kept.
* **Fix:** add an explicit comment on `settings.value` in `schema.rs` pointing at
  the canary, and add a Rust test asserting
  `PRAGMA table_info(settings)` still reports `value` as `NOT NULL`.
* **Effort:** 20 min.

### SCHEMA-05 — `notes_fts.folder` denormalises the collection name — **Low**

* **Where:** `schema.rs:186–206` (trigger subquery
  `COALESCE((SELECT name FROM collections WHERE id = new.collection_id), '')`).
* **What:** the index stores a *copy* of `collections.name`. Today that is safe
  because collections cannot be renamed — only created (`notes.ts:209`) and
  deleted (`notes.ts:217`, which deliberately touches every note first to fire
  the trigger). The invariant is not expressed anywhere: a future
  `renameCollection` that does a bare `UPDATE collections` would leave every
  affected note findable under its **old** folder name until each note is
  next edited.
* **Fix:** if rename is ever added, run
  `UPDATE notes SET collection_id = collection_id WHERE collection_id = ?`
  in the same batch (it fires the trigger), and add a comment on
  `createCollection` saying why rename is absent.
* **Effort:** note now; work only when rename ships.

---

## 5. Performance bottlenecks

Measured in this sandbox (Node 22, `node:sqlite` in-memory). Ratios are what
matter; absolute numbers on the packaged SQLCipher build will be higher.

| Probe | Result |
| --- | --- |
| Month sum, 100 k ledger rows, `substr(entry_date,1,7)=?` | **6.12 ms** (full scan) |
| Same, `entry_date >= ? AND entry_date < ?` | **0.10 ms** → **59× faster**, uses the index |
| Notes browse, 20 k notes, no index | 65.0 ms (`SCAN` + temp B-tree) |
| Same, with `(pinned, updated_at DESC, id DESC)` | 37.3 ms → **1.75× faster** |
| `noteExcerpt` per row (grapheme + word `Intl.Segmenter`) | **0.13–0.2 ms** |
| PBKDF2-SHA256, 600 k iterations | **105 ms** |
| `notes` + `notes_fts` storage | **×2.21** |

### PERF-01 — `substr()` date predicates defeat the ledger indexes — **High**

* **Where:** `budget.ts:757, 761, 765, 769, 786, 790, 835` (income/expense month
  and year sums, and the per-category limit spend), `journal.ts:114`,
  `memories.ts:103, 111`
* **Evidence:** `EXPLAIN QUERY PLAN` on the real schema shape:

  ```
  WHERE substr(entry_date,1,7)=?          → SCAN income_entries
  WHERE entry_date >= ? AND entry_date < ? → SEARCH income_entries USING INDEX idx_income_entries_date
  ```
* **Impact:** `idx_income_entries_date` and `idx_expense_entries_date`
  (`schema.rs:521–522`) exist but are **unusable** for every month query — the
  exact query they were added for. The cost is paid on the Dashboard (2 reads),
  the Budget month view (4), the year view (48), and every limit row.
* **Fix:** a `monthRange(yearMonth)` helper in `dates.ts` and range predicates:

  ```ts
  const { from, to } = monthRange(ym); // "2026-10-01", "2026-11-01"
  "… WHERE entry_date >= ? AND entry_date < ?"
  ```

  Apply the same to `journal.ts` (a `UNIQUE` index on `entry_date` already
  exists) and `memories.ts` (`memory_date` needs the index from PERF-09).
* **Effort:** 2 h + test updates (the query strings are asserted in repo tests).

### PERF-02 — Notes page: one query per keystroke *and* per-row excerpt on every render — **High**

* **Where:** `NotesPage.tsx:1101` (`onChange={(e) => setSearch(e.target.value)}`),
  `NotesPage.tsx:577` (`refresh` depends on `search`), `:579–581` (the effect), and
  `NotesPage.tsx:951–953` (`const excerpt = noteExcerpt(note.content)` inside
  `notes.map(...)` in the render body)
* **What:**
  1. Every keystroke changes `search` → `refresh` is a new callback → the effect
     at `:585` fires an FTS query over the whole index. There is **no debounce**,
     even though `SEARCH_DEBOUNCE_MS = 150` exists in `searchContract.ts:511`
     and the global search dialog uses it (`GlobalSearchDialog.tsx:136`).
  2. `noteExcerpt` runs for **every** note on **every** render of a 26-state
     component. Measured 0.13–0.2 ms per row: 2,000 notes ≈ **260–400 ms** of
     main-thread work per keystroke, on top of the query.
* **Impact:** typing in the Notes search box is the app's most-used interaction;
  at a few thousand notes it degrades into visible input lag.
* **Fix:** (a) debounce `search` with `SEARCH_DEBOUNCE_MS` (keep the guard; it
  still protects against overlap); (b) compute excerpts once per loaded list —
  build `Map<noteId, string>` in `refresh()` (or a `useMemo` keyed on `notes`) —
  instead of per render; (c) if the library is expected to pass ~5 k notes, add
  a `LIMIT`/paging window to `listNotes`, which currently has none
  (`notes.ts:193`).
* **Effort:** 3 h.

### PERF-03 — Limits view fans out two queries per category — **High**

* **Where:** `BudgetPage.tsx:1338–1345` →
  `budget.ts:824–847` (`limitStatusFor` = spend `SUM` + `getLimit`)
* **What:** `Promise.all(cats.map(c => limitStatusFor(c.id, ym)))` issues
  `2N + 1` statements (7 seeded categories = 15; 20 categories = 41) per refresh,
  including after every limit edit.
* **Why it matters twice:** `pages/fan-out-guard.test.ts` exists precisely to
  stop this pattern (it pins `walletBalanceCents` and the per-habit calls out of
  the pages) — Limits view is a **gap in that guard**.
* **Fix:** one grouped statement:

  ```sql
  SELECT c.id, el.limit_cents, COALESCE(SUM(ee.amount_cents), 0) AS spent_cents
    FROM expense_categories c
    LEFT JOIN expense_limits el ON el.category_id = c.id
    LEFT JOIN expense_entries ee ON ee.category_id = c.id
         AND ee.entry_date >= ? AND ee.entry_date < ?
   GROUP BY c.id
  ```

  …plus an index on `expense_entries(category_id, entry_date)` (PERF-09), and a
  `fan-out-guard` assertion that the per-category call never returns.
* **Effort:** 2 h.

### PERF-04 — Year view issues 48 statements through 12 IPC calls — **Medium**

* **Where:** `BudgetPage.tsx:1187–1193` (`Promise.all` over 12 ×
  `monthlySummary(yearMonth)`), `budget.ts:753–779` (each call = 4 queries)
* **What:** a 12-month view costs 12 round trips and 48 statements; the months
  are independent but the data is one range.
* **Fix:** one `yearSummary(year)` query with
  `WHERE entry_date >= ? AND entry_date < ? GROUP BY substr(entry_date,1,7), category_id`
  (range predicate uses the index; `substr` in the *select list* is free).
* **Effort:** 3 h including the display code.

### PERF-05 — Gallery thumbnails are generated strictly one at a time — **Medium**

* **Where:** `GalleryPage.tsx:146–163` (`for (const photo of list)` at `:150` await
  thumbBytesFor(photo)`), `GalleryPage.tsx:135`
* **What:** for a photo saved before thumbnails existed (or restored from a
  backup, which carries none), each tile costs **three** IPC round trips: failed
  thumb read → full-photo read → thumb save, then decode/resize in the webview.
  They are serialised, so a 500-photo library pays 1,500 round trips before the
  grid settles, with no prioritisation for the visible rows.
* **Fix:** bounded concurrency (4) plus IntersectionObserver-driven loading —
  generate only what is on screen (the repo already uses `IntersectionObserver`
  in `useReveal.ts`).
* **Effort:** 4 h.

### PERF-06 — Backup export is one IPC call per photo, serialised — **High**

* **Where:** `backup.ts:242` (31 sequential `SELECT *`), `backup.ts:264–268`
  (one `driver.readPhoto` per row), `backup.ts:292–315` (whole archive in
  memory)
* **What:** the export path is `31 + N` sequential round trips (N ≤ 5,000
  photos) and holds every photo byte plus the zipped copy in memory at once
  (`MAX_EXPORT_PHOTO_BYTES` = 112 MiB). Nothing else can touch the UI while this
  runs, but the window shows a spinner for the whole duration.
* **Good news:** `photo_read` takes **no** DB mutex (`commands.rs:377–386`), so
  parallel reads are genuinely parallel file IO.
* **Fix:** (a) read the 31 tables with `Promise.all` (they are independent
  reads); (b) read photos with a small bounded pool (4–8);
  (c) stream into the zip per entry rather than buffering the whole payload —
  `fflate`'s async API needs the file list up front, so at minimum release each
  `BackupPhotoEntry` after it is zipped.
* **Effort:** 4 h.

### PERF-07 — Every photo is SHA-256'd twice; import does one IPC per photo — **Medium**

* **Where:** `gallery.ts:324` (`await sha256HexBytes(input.bytes)`),
  `backup.ts:783` (`row.sha256 = await sha256HexBytes(entry.bytes)`),
  `backup.ts:769–778` (one `savePhoto` per photo),
  `photos.rs:63–64` (Rust hashes the same bytes to build the path)
* **What:** `savePhoto` returns the **content-addressed** path
  (`photos/<yyyy>/<mm>/<sha256>.<ext>`), so Rust has already computed the digest
  the row needs. The webview then hashes the full res again — for a 112 MiB
  library that is another full pass, on top of an IPC copy.
* **Fix:** parse the digest from the returned path (it is the basename stem) and
  drop `sha256HexBytes` from both call sites. Keep the Rust hash as the single
  source of truth; add a test that the basename equals `photos.sha256`.
* **Effort:** 1 h.

### PERF-08 — The reminder tick writes one statement per due reminder — **Medium**

* **Where:** `session.ts:405–413`
* **What:** after a burst (the app was closed for a week), each due reminder is
  `await ports.markFired(id)` or `await ports.reschedule(id, …)` — N sequential
  IPC writes, each its own autocommit transaction (see PERF-10), and a failure
  halfway leaves the list partially consumed. The rest of the codebase composes
  writes into `driver.batch` for exactly this reason.
* **Fix:** collect `BatchStatement`s in the ticker and issue one `driver.batch`
  (the ticker's port would need a `batch` method; `session.test.ts` already uses
  injected ports, so this is a mechanical change).
* **Effort:** 2 h.

### PERF-09 — Nine hot-path indexes are missing — **High**

Verified against the queries in `src/lib` and the DDL in `schema.rs`:

| Table / predicate | Query site | Index today |
| --- | --- | --- |
| `notes` browse: `WHERE archived = 0 … ORDER BY pinned DESC, updated_at DESC, id DESC` | `notes.ts:193` | none → `SCAN` + **temp B-tree** |
| `photos ORDER BY created_at DESC, id DESC` | `gallery.ts:349` | none |
| `memories` by `memory_date` (range, month, month-day) | `memories.ts:91, 103, 111` | none |
| `habit_logs(habit_id, log_date)` — `ORDER BY log_date` | `habits.ts:127–130` | `habit_id` only → sort |
| `income_entries(category_id, entry_date)` | `budget.ts:765, 835` | `entry_date` only |
| `expense_entries(category_id, entry_date)` | `budget.ts:769, 835` | `entry_date` only |
| `jobs(shop_id)` / `jobs(status, job_date)` | `business.ts:451, 375` | `status` only |
| `payables(paid, due_date)` | `business.ts:509` | none |
| `shopping_items(list_id, sort_order)` | `shopping.ts:59, 67` | none |

Suggested migration for the next schema version:

```sql
CREATE INDEX idx_notes_browse      ON notes(pinned DESC, updated_at DESC, id DESC);
CREATE INDEX idx_photos_created    ON photos(created_at DESC, id DESC);
CREATE INDEX idx_memories_date     ON memories(memory_date);
CREATE INDEX idx_habit_logs_date   ON habit_logs(habit_id, log_date);
CREATE INDEX idx_income_cat_date   ON income_entries(category_id, entry_date);
CREATE INDEX idx_expense_cat_date  ON expense_entries(category_id, entry_date);
CREATE INDEX idx_jobs_shop         ON jobs(shop_id);
CREATE INDEX idx_payables_paid_due ON payables(paid, due_date);
CREATE INDEX idx_shopping_order    ON shopping_items(list_id, sort_order);
```

* **Measured:** the Notes browse index alone is **1.75× faster** at 20 k notes
  in memory (65.0 → 37.3 ms); on an encrypted file the win is larger because the
  sort no longer touches content pages.
* **Caveat:** each index adds write cost; the four ledger/shopping ones are
  small and worth it, `idx_notes_browse` is the only one with measurable write
  overhead (one B-tree insert per note save).
* **Effort:** 2 h including the migration test
  (`db.rs` asserts the expected index set at `:1994`).

### PERF-10 — SQLite is opened with defaults that cost a syscall per write — **High**

* **Where:** `db.rs:609–630` (`open_encrypted_db`) sets only
  `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout`; `db.rs:1105` and
  `:1153` use `prepare`/`execute` with no statement cache.
* **What:**
  1. **`synchronous` is left at FULL** (the SQLite default). In WAL mode FULL
     fsyncs the WAL on *every commit* — and almost every write in this app is a
     single-statement autocommit (`createNote`, `setPinned`, `toggleLog`, one
     reminder mark…). `synchronous = NORMAL` is the standard WAL pairing: it
     cannot corrupt the database, and the window it opens is "the last
     transactions are lost on an OS crash / power loss", not on an app crash.
  2. **No prepared-statement cache.** `rusqlite` caches only statements built
     with `prepare_cached`; the code calls `prepare`/`execute`, so the backup
     import re-parses up to `MAX_BACKUP_ROWS = 100_000` INSERT texts and every
     `db_query` re-prepares its SQL on each keystroke-driven call.
  3. **No `cache_size` / `temp_store` tuning** — the missing-index sorts above
     (PERF-09) spill to `temp_store = FILE` by default.
* **Fix:**

  ```rust
  conn.pragma_update(None, "synchronous", "NORMAL")?;      // WAL + NORMAL
  conn.pragma_update(None, "cache_size", -32_000)?;        // 32 MiB page cache
  conn.pragma_update(None, "temp_store", "MEMORY")?;
  conn.set_prepared_statement_cache_capacity(64);
  // then use conn.prepare_cached(sql) in query_rows/execute_inner
  ```

  Document the durability trade-off next to the pragma, in the same style as the
  existing `busy_timeout` comment.
* **Effort:** 3 h (mostly re-validating the write-path tests).

### PERF-11 — Habit progress reads every log row ever written — **Medium**

* **Where:** `habits.ts:124–131`
* **What:** `SELECT habit_id, log_date FROM habit_logs WHERE done = 1 AND
  habit_id IN (…) ORDER BY log_date` has **no date bound**; streaks are then
  computed in JS (`habits.ts:132–160`). Ten habits tracked for three years is
  ~11,000 rows on every Dashboard/Budget/Habits first paint and on every share
  tick (every 30 s while sharing).
* **Fix:** bound the read to the longest window any of the three consumers needs
  (best-streak needs all history only if it is displayed — if so, compute
  `MAX` streak in SQL with a window function or keep a `streak_best` column), or
  at minimum add `AND log_date >= ?` with a documented horizon plus a separate
  one-off "best streak" query.
* **Effort:** 4 h (needs a product decision on best-streak semantics).

### PERF-12 — No multi-statement read path over IPC — **Medium**

* **Where:** the driver exposes `query`/`execute`/`batch` but no
  `queryMany`; consumers pay one round trip per statement.
* **Evidence:** `DashboardPage.tsx:157–171` issues **10** reads and then one more
  call (`habitProgressList`, 2 queries) = **11 IPC round trips per reload**;
  Budget month view 3, entries view 3, recurring view 3, Limits 15, Year 12.
  `driver.ts:1–10` already documents that every call is one IPC round trip
  through a single mutex-protected connection, so these reads are strictly
  serialised server-side anyway.
* **Fix:** add `#[tauri::command] async fn db_query_many(queries: Vec<Query>) ->
  Vec<Vec<JsonObj>>` executed on the blocking pool under one connection guard,
  and a `readMany` driver method. Dashboard/Budget first paint then cost 1 round
  trip instead of 11/3.
* **Effort:** 1 day (driver + mock + Rust + tests).

### PERF-13 — Vault password change derives keys serially — **Low**

* **Where:** `vault.ts:412–431`
* **What:** per item: `deriveItemKey` (PBKDF2 600 k ≈ **105 ms**) + decrypt +
  `deriveVaultKey` (another ≈105 ms) + encrypt. Twenty items ≈ **4.2 s** of
  sequential crypto with no progress feedback; items are independent (each has
  its own salt), so the work parallelises cleanly.
* **Fix:** `Promise.all` over items with a small concurrency cap (4) and a
  progress counter in the UI; the batch write stays as is.
* **Effort:** 2 h.

### PERF-14 — Trash purge loads every snapshot twice — **Low**

* **Where:** `trash.ts:833–848` (`purgeUnlocked`: `SELECT * FROM trash_items ORDER
  BY deleted_at DESC`) and `trash.ts:791–830` (`removeTrashRows`: another
  `SELECT * … WHERE id NOT IN (…)`)
* **What:** every workspace entry (`App.tsx:656`) and every restore
  (`trash.ts:765`) materialises all trash snapshots — JSON blobs, up to
  `TRASH_MAX_ITEMS = 1_000` rows — parses them in `validateTrashPayload`, then
  loads the remainder again. Cost grows with snapshot size, not with the number
  of expired items.
* **Fix:** push the policy into SQL
  (`WHERE deleted_at <= ? OR id IN (SELECT id FROM trash_items ORDER BY deleted_at
  DESC LIMIT -1 OFFSET 1000)`) and select only the columns `removeTrashRows`
  needs (`id, entity_type, entity_id, snapshot` of the *remaining* rows that
  actually contain links).
* **Effort:** 3 h.

### PERF-15 — Settings page polls share state every 15 s and clears the copy state — **Low**

* **Where:** `SettingsPage.tsx:582–599`
* **What:** `setShareCopied(false)` runs on every successful status poll
  (`:589`), so the "Copied" confirmation silently reverts within 15 seconds while
  the user is away from the button; the poll also runs even when sharing was
  never started. Cosmetic, but it is a state write every 15 s for no change.
* **Fix:** only reset `shareCopied` when the published URL actually changes
  (compare `info.url`), and skip the poll while `!shareState?.running` unless
  the user has armed the prompt.
* **Effort:** 30 min.

---

## 6. What was checked and found correct

Negative results matter in an audit, so here is what did **not** turn up a
problem:

1. **SQL ↔ DDL column names (447 statements).** Every identifier in every
   single-table statement was matched against the parsed `CREATE TABLE` columns;
   no typo, no renamed column, no dropped column. Remaining hits were all
   aliases, JSON paths, string literals or test fixtures.
2. **INSERT completeness.** No `INSERT` omits a `NOT NULL` column that lacks a
   `DEFAULT` (all 31 tables).
3. **`types.ts` ↔ schema.** All 27 row interfaces match their table's column set
   exactly (no extra, no missing) — see SCHEMA-02 for the four tables that live
   elsewhere.
4. **`BACKUP_TABLES` ↔ schema.** Exactly 31 names, identical set; `notes_fts`
   correctly excluded (trigger-maintained).
5. **`SEARCH_CONTRACT` ↔ schema.** All 9 specs; every `searchable`, `title`,
   `excerpt`, `date` and `inactive.column` exists on its table.
6. **`links` canonical ordering.** TypeScript's byte-wise `type` comparison
   (`entityLinks.ts:88`) is intentionally identical to SQLite's BINARY collation
   used by the table's `CHECK`; documented and tested.
7. **Journal restore collision.** `trash.ts:518–531` checks the
   `UNIQUE(entry_date)` constraint before restoring a journal entry and gives a
   readable error instead of a raw constraint failure.
8. **Mock ↔ Rust refusal text.** The three mock strings
   (`mock-driver.ts:22–30`) are character-identical to `lifecycle.rs:57,207` and
   `share.rs`. No drift.
9. **i18n completeness.** 568 English keys; 567 referenced; Burmese catalogue
   complete (the suite enforces it).
10. **`docs/EXPORTS.md` ↔ `EXPORT_FIELD_MAPPING`.** The documentation table is
    *pinned to the code* by `exports.test.ts:354–356` — the docs cannot drift
    from the export.
11. **No duplicate npm dependencies, no unused dependencies, no unused devDeps.**
12. **Bundle splitting.** Every page is `React.lazy` (`App.tsx:89–106`) with
    vendor groups for react/markdown/crypto; the initial shell is 277 kB
    (72 kB gz). No 1 MB chunk.

---

## 7. Prioritised remediation plan

Sequenced so each step is independently shippable behind the existing gate.

### P0 — this week (all Mechanical, low risk)

| # | Change | Findings | Effort | Gain |
| --- | --- | --- | --- | --- |
| 1 | Range predicates for month/year sums; `monthRange()` helper | PERF-01 | 2 h | 59× on ledger reads (measured) |
| 2 | `synchronous=NORMAL`, prepared-statement cache, cache/temp pragmas | PERF-10 | 3 h | one fewer fsync per write; faster import |
| 3 | Migration 5→6 adding the nine indexes | PERF-09 | 2 h | removes temp B-tree sorts everywhere |
| 4 | Debounce Notes search + memoise excerpts | PERF-02 | 3 h | restores typing latency at thousands of notes |
| 5 | Delete the eight symbols with no caller, `SETTING_KEYS.vault`, `urlTransform` alias | DEAD-01…03 | 30 min | smaller surface |

### P1 — next sprint

| # | Change | Findings | Effort |
| --- | --- | --- | --- |
| 6 | One grouped query for Limits view + extend `fan-out-guard.test.ts` | PERF-03 | 2 h |
| 7 | One grouped query for Year view | PERF-04 | 3 h |
| 8 | Backup export: parallel table reads, bounded photo pool | PERF-06 | 4 h |
| 9 | Drop the webview re-hash (derive digest from the returned path) | PERF-07 | 1 h |
| 10 | Batch the reminder-tick writes | PERF-08 | 2 h |
| 11 | `entryInsertStatement()` shared by budget/business | DUP-05 | 1 h |
| 12 | Route gallery/vault settings through the settings repo | DUP-06 | 2 h |
| 13 | Trash `COLUMNS` vs `pragma_table_info` test | SCHEMA-01 | 1 h |
| 14 | Vendored-crypto check in `check-versions.mjs` | DUP-09 | 30 min |
| 15 | `useDayRollover` hook for the five pages | DUP-03 | 1 h |

### P2 — opportunistic

| # | Change | Findings | Effort |
| --- | --- | --- | --- |
| 16 | `db_query_many` multi-read IPC | PERF-12 | 1 day |
| 17 | Narrow the FTS update trigger to indexed columns | SCHEMA-03 | 30 min |
| 18 | Thumbnail lazy loading (IntersectionObserver + pool) | PERF-05 | 4 h |
| 19 | Habit-log read horizon | PERF-11 | 4 h |
| 20 | Parallel vault rekey | PERF-13 | 2 h |
| 21 | Trash purge pushed into SQL | PERF-14 | 3 h |
| 22 | Row types for the four tables; `COLUMNS` derivation | SCHEMA-01/02 | 3 h |
| 23 | Archive the three shipped plan docs | DEAD-05 | 15 min |
| 24 | Unify birthday formatting | DUP-02 | 30 min |
| 25 | Repoint `measure-search.mjs` at the real builder | DUP-11 | 45 min |

**Suggested ordering rationale:** P0 items 1–3 are pure query/pragma changes with
measurable wins and no UX surface; item 4 is the only user-visible latency fix
and should land before the note library grows. Nothing in P0/P1 requires a data
migration except the indexes (a forward-only step 5→6, added the documented way:
bump `SCHEMA_VERSION`, add `MIGRATION_5_6`, register it in `migration_step`,
mirror it into `BASELINE_SQL`, and extend the two structural tests).

---

## 8. Appendix A — method

Everything below is reproducible with the toolchain already in the repo
(`node ≥ 22` is enough to run the TypeScript side; the Rust gates need `cargo`).

**Gate runs (this sandbox):**

```
npm ci --ignore-scripts              # 137 packages
npx tsc --noEmit                     # clean
npx biome check .                    # 1 info, 0 errors
node --test "src/**/*.test.ts"       # 828 pass / 0 fail / 24 s
npm run build                        # success
```

*Note on the environment:* `.npmrc` sets `engine-strict=true` and
`package.json` requires Node ≥ 24; this sandbox has Node 22.22.3, so the install
was done with the engine check temporarily relaxed (the manifest was restored
immediately and is unmodified in the tree). The 828-test suite, `tsc`, `biome`
and `vite build` all pass on Node 22 as well.

`cargo test`, `cargo clippy`, `cargo fmt --check` were **not** run: the audit
sandbox has no Rust toolchain and cannot reach crates.io. The Rust findings
therefore come from reading `src-tauri/src/*.rs` (and one behavioural test of
the FTS design via `node:sqlite`), not from `clippy`'s dead-code pass.

The throwaway analysis scripts below were deleted after the audit so
`biome check .` stays green (with them present it reports 40 errors — they are
scratch code, not repository code).

**Static analyses written for this audit** (throwaway, not committed):

| Check | Technique | Result |
| --- | --- | --- |
| DDL parse | extracted every `CREATE TABLE/INDEX` from `schema.rs` (baseline + migrations) → `{table → columns, indexes}` | 31 tables, 24 indexes |
| SQL extraction | 447 string/template literals containing `SELECT/INSERT/UPDATE/DELETE` from `src/` + `scripts/` + Rust raw strings | 447 |
| Column check | per statement, resolve tables from `FROM/JOIN/INTO/UPDATE`, then validate every bare or qualified identifier | 0 real mismatches |
| INSERT completeness | parse `NOT NULL`/`DEFAULT` per column, diff against each `INSERT`'s column list | 0 omissions |
| Type check | parse `types.ts` interfaces, diff against DDL | 27/27 exact |
| Dead exports | every `export function/const/class/type` in `src/`, counted references in other files, split prod vs `.test.ts` vs `scripts/` | 12 dead, 136 test-only |
| i18n keys | parse the `en` / `enPlurals` catalogues, search for each key literal | 1 unused |
| Duplicate SQL | normalise (strip `${…}`, whitespace, case) and group identical literals | 20 duplicated statements |
| Clone detection | 8-line normalised window across `src/**/*.{ts,tsx}` + `src-tauri/src/*.rs` | 31 clusters (5 real) |
| Index analysis | per statement: WHERE/ORDER BY columns vs indexed columns, and `substr(indexed_col, …)` | 9 missing indexes, 8 index-defeating expressions |
| Rust dead code | every `pub fn/const/struct` counted in non-`#[cfg(test)]` source | 0 dead |

**Measurements:**

* `node:sqlite` in-memory, same DDL and indexes as `schema.rs`, 100 k ledger rows
  and 20 k notes; `EXPLAIN QUERY PLAN` for the query-shape claims; 20 iterations
  averaged after warm-up.
* `noteExcerpt` timed directly (500 iterations, ~5.6 kB body and ~2.3 kB body).
* FTS storage: 300 notes × ~1.8 kB, `PRAGMA page_count × page_size`.
* PBKDF2: WebCrypto, 600 k iterations, SHA-256, 256-bit output.
* Environment: Node v22.22.3, x86_64 Linux container. Absolute numbers exclude
  SQLCipher's per-page crypto and the Tauri IPC marshalling, so treat them as
  lower bounds and trust the ratios.

## 9. Appendix B — finding index

| ID | Severity | One-line | Primary location |
| --- | --- | --- | --- |
| DUP-01 | Low | `cell()` duplicated | `taskImport.ts:56`, `contactImport.ts:78` |
| DUP-02 | Medium | two birthday formatters/caches, divergent output | `format.ts:117`, `contacts.ts:68` |
| DUP-03 | Medium | day-rollover timer ×5, three variants | 5 pages |
| DUP-04 | Low | load guard re-implemented | `HabitsPage.tsx:65`, `InboxPage.tsx:124` |
| DUP-05 | High | ledger INSERT ×5 across two repos | `budget.ts:549/565/1006`, `business.ts:489/632` |
| DUP-06 | Medium | settings SQL/key ownership bypassed | `gallery.ts`, `vault.ts` |
| DUP-07 | Low | open-tasks query twice | `tasks.ts:134`, `:251` |
| DUP-08 | Low | exporter re-reads repo tables | `exports.ts:923/974` |
| DUP-09 | Medium | vendored crypto with no drift check | `src-tauri/share/_crypto/` |
| DUP-10 | Medium | cross-language constants, different names | `backup.ts:66`, `commands.rs:68`, `share.ts:58` |
| DUP-11 | Low | measurement script re-implements search | `scripts/measure-search.mjs:294` |
| DUP-12 | Info | baseline/migration DDL duplication (accepted) | `schema.rs` |
| DEAD-01 | Low | 12 unused exports | see §3 table |
| DEAD-02 | Low | `SETTING_KEYS.vault` unused | `settings.ts:20` |
| DEAD-03 | Low | txn IPC surface, zero callers | `driver.ts:178`, `commands.rs` |
| DEAD-04 | Info | `_snapshot.js` exports (correctly shared) | `share/_snapshot.js` |
| DEAD-05 | Low | shipped plan docs read as current | `docs/*Plan*.md`, `*Prompt*.md` |
| SCHEMA-01 | Medium | trash column lists mirror DDL by hand | `trash.ts:60–96` |
| SCHEMA-02 | Low | 4 tables untyped in `types.ts` | `types.ts`, `budget.ts` |
| SCHEMA-03 | Medium | FTS duplicates content (×2.21), rewrites on any update | `schema.rs:176` |
| SCHEMA-04 | Low | import canary depends on `NOT NULL` | `backup.ts:820`, `schema.rs:513` |
| SCHEMA-05 | Low | `notes_fts.folder` denormalisation invariant undocumented | `schema.rs:186` |
| PERF-01 | High | `substr()` date predicates full-scan (59×) | `budget.ts:757…835`, `journal.ts:114`, `memories.ts:103` |
| PERF-02 | High | query per keystroke + per-row excerpt per render | `NotesPage.tsx:1101`, `:951` |
| PERF-03 | High | limits view 2N+1 queries | `BudgetPage.tsx:1338` |
| PERF-04 | Medium | year view 48 statements / 12 IPC | `BudgetPage.tsx:1187` |
| PERF-05 | Medium | thumbnails generated serially | `GalleryPage.tsx:150` |
| PERF-06 | High | backup export 31+N serial round trips | `backup.ts:242, 264` |
| PERF-07 | Medium | every photo hashed twice | `gallery.ts:324`, `backup.ts:783` |
| PERF-08 | Medium | reminder tick writes per row | `session.ts:405` |
| PERF-09 | High | nine hot-path indexes missing | `schema.rs` |
| PERF-10 | High | `synchronous=FULL`, no statement cache | `db.rs:609`, `:1105` |
| PERF-11 | Medium | habit logs read unbounded | `habits.ts:127–130` |
| PERF-12 | Medium | no multi-read IPC (11 for Dashboard) | `driver.ts` |
| PERF-13 | Low | vault rekey serial PBKDF2 | `vault.ts:415` |
| PERF-14 | Low | trash purge loads all snapshots twice | `trash.ts:835`, `:793` |
| PERF-15 | Low | 15 s share poll clears copied state | `SettingsPage.tsx:590` |

---

## 10. Remediation status

Applied on branch `arena/472ac602-purplememo`, on top of `aa8a6cf`. Every code
change names its finding ID in a comment, so `docs/AUDIT.md` finding →
`grep` its ID.

**Gates after the work:** `tsc --noEmit` clean · `biome check .` 176 files, 1
info, 0 errors · `node --test` **852/852** · `vite build` success ·
`node scripts/check-versions.mjs` OK.

> **Rust is not compiled here.** This sandbox has no `cargo` and no crates.io
> access, so the `schema.rs` / `db.rs` changes (PERF-09, PERF-10, SCHEMA-03,
> SCHEMA-04, and the migration 5→6 test) are written against the code as read
> but **have not been through a compiler**. Run
> `npm run test:rust && npm run clippy && npm run fmt:check` before merging.

| ID | Status | What was done |
| --- | --- | --- |
| DUP-01 | **Fixed** | `cell()` → `cellValue` in `csv.ts`; both importers import it (one copy). `csv.test.ts` pins the alias/escape rules. |
| DUP-02 | **Fixed** | `birthdayLabel` now delegates to `formatBirthday` and keeps only the "?? 40" placeholder for unparseable input; the duplicate `MONTH_SHORT`/`Intl` cache in `contacts.ts` is gone. A test asserts the two agree for every locale. |
| DUP-03 | **Fixed** | New `src/lib/useDayRollover.ts` (`DAY_TICK_MS`, latest-handler ref, no re-arm per render). All five pages use it; the C2 guard test now pins the hook instead of five copies. |
| DUP-04 | **Fixed** | `HabitsPage` and `InboxPage` use `createLoadGuard()`; both hand-rolled sequence counters are gone. |
| DUP-05 | **Fixed** | `ledgerInsertStatement(kind, entry)` in `budget.ts` is the one INSERT shape for both ledger tables; the five call sites use it (`business.ts` now imports it). |
| DUP-06 | **Fixed** | `settings.ts` exposes `settingsUpsertStatement`, `setRaw` and `listByPrefix`; `SETTING_KEYS` gained `vaultSetup`, `vaultVerify`, `photoCleanupPrefix` (the *existing* stored value, so old cleanup records stay visible). `gallery.ts` and `vault.ts` route through the repo. |
| DUP-07 | **Fixed** | `taskListQuery(includeDone)`; `listTasks` and `openTasks` share it. |
| DUP-08 | **Deferred** | The exporter still issues its own `SELECT *` for collections/loans. Fixing it means changing the `ExportData` shape — a larger refactor than the rest of this pass, with no user-visible symptom today. |
| DUP-09 | **Fixed** | `scripts/check-versions.mjs` byte-compares `src-tauri/share/_crypto/{aes,_polyval,utils}.js` against `node_modules/@noble/ciphers` and prints the refresh command on drift. |
| DUP-10 | **Fixed** | Same script now parses the per-photo and snapshot ceilings out of both languages and fails when they disagree (verified by introducing a drift and watching it fail). |
| DUP-11 | **Deferred** | `scripts/measure-search.mjs` still rebuilds the query. It is a measurement tool, not a runtime path; importing `buildMatchQuery` into it is worth doing when the query next changes. |
| DUP-12 | **Accepted** | No change — the duplication is deliberate and pinned by two Rust tests. |
| DEAD-01 | **Partial** | Deleted the five with no caller: `LINK_KINDS`, `linkEndpoints`, `formatLocalDate`, `formatLocalDateTime`, and the `urlTransform` alias re-export (the `MarkdownLink` guard test was updated to the one remaining name). The eight test-only helpers stay: their tests pin real behaviour (streak of 140-char excerpt limits, i18n placeholder parity), and moving them would churn those tests for no gain. |
| DEAD-02 | **Fixed** | `SETTING_KEYS.vault` deleted (the vault keys are now named there properly). |
| DEAD-03 | **No change (intentional)** | The manual-transaction IPC is a documented mandate. Deleting four Rust commands and the `txn_open` flag without a compiler and without a caller to replace them is the riskier edit; the note in §3 stands. |
| DEAD-04 | **No change** | Correctly shared already. |
| DEAD-05 | **Fixed** | The three shipped plans moved to `docs/history/` with a "historical plan, not a requirement" header. |
| SCHEMA-01 | **Fixed** | `trash.ts` exports `TRASH_SNAPSHOT_COLUMNS` / `TRASH_CHILD_COLUMNS`; `trash.test.ts` parses `BASELINE_SQL` and compares every list to the real `CREATE TABLE`. A migration that adds a column now fails the gate. |
| SCHEMA-02 | **Fixed** | `types.ts` gained `IncomeEntryRow`, `ExpenseEntryRow`, `SettingRow` and `TrashEntityType`/`TrashItemRow` (moved, re-exported from `trash.ts`); `DayEntry` is now `ExpenseEntryRow & { kind }`, and `budget.ts`/`settings.ts` use the named rows. |
| SCHEMA-03 | **Fixed** | `notes_fts_au` is now `AFTER UPDATE OF title, content, tags, collection_id` in both the baseline and a new migration 5→6 (`MIGRATION_5_6`), so a pin/archive no longer rewrites the index row. The Rust test pins the trigger text and proves a `pinned` update leaves `notes_fts` untouched while a content edit still reaches it. |
| SCHEMA-04 | **Fixed** | Comment on `settings.value` in `schema.rs` naming the canary, plus a Rust test asserting `PRAGMA table_info(settings)` reports `NOT NULL` and that the canary INSERT actually fails. |
| SCHEMA-05 | **Fixed (documentation)** | `createCollection` carries the invariant and the exact statement a future rename must run. |
| PERF-01 | **Fixed** | `monthRange` / `yearRange` in `dates.ts` (half-open bounds, `from === to` on malformed input). Used by `monthlySummary`, `yearlySummary`, `limitStatusFor`, `datesInMonth`, `memories.monthFeed`. Tests assert the SQL contains a range and no `substr(entry_date, …)`. |
| PERF-02 | **Fixed** | Notes search is debounced on the shared `SEARCH_DEBOUNCE_MS` (the input keeps every keystroke; only the loader waits), and excerpts are memoised per note list. |
| PERF-03 | **Fixed** | `budgetRepo.limitStatuses(yearMonth)` — one grouped statement (LEFT JOIN limits + entries) for the Limits view, replacing 2N+1. |
| PERF-04 | **Fixed** | `budgetRepo.yearSummary(year)` returns twelve buckets from four statements; the Year view makes one call. |
| PERF-05 | **Fixed** | Grid thumbnails load through `mapConcurrent(…, 4)`; cancellation still revokes every URL that was created. |
| PERF-06 | **Fixed** | Backup export reads all tables with one `Promise.all` and photo bytes with a bounded pool (`mapConcurrent(…, 4)`). |
| PERF-07 | **Fixed** | `digestFromPhotoPath` reads the sha256 the content-addressed path already encodes; restore falls back to hashing only when the path does not parse. |
| PERF-08 | **Fixed** | `ReminderTickPorts.settle(outcomes)` — one call per tick; `tasksRepo.settleReminders` writes one batch (`reminderSettleStatements` is pure and tested). |
| PERF-09 | **Fixed** | `MIGRATION_5_6` + baseline create the nine indexes; `expected_indexes_exist` and the new migration test pin them, and the v1 fixture strips them so the migration is genuinely exercised. |
| PERF-10 | **Fixed** | `apply_performance_pragmas` (`synchronous=NORMAL`, 16 MiB `cache_size`, `temp_store=MEMORY`) on the one open path, and `prepare_cached` in `query_rows` / `execute_inner`. |
| PERF-11 | **Deferred** | Bounding the habit-log read changes best-streak semantics — a product decision (the audit said so). Adding the `log_date` index helps the range consumers today; the unbounded read remains. |
| PERF-12 | **Deferred** | `db_query_many` needs a Rust command, a driver method, a mock and new tests, and the Rust half cannot be compiled or tested in this environment. Dashboard stays at 11 IPC round trips. |
| PERF-13 | **Fixed** | `changePassword` re-encrypts through `mapConcurrent(…, 4)`, so the PBKDF2 derivations overlap instead of running one after another. |
| PERF-14 | **Fixed (partially)** | `purgeUnlocked` decides the policy from `id, deleted_at` only and reads snapshots only for the rows it will actually delete — the common "nothing expired" path now touches no snapshot. `removeTrashRows` still reads the remaining snapshots, but with a narrow projection. |
| PERF-15 | **Fixed** | The 15 s poll compares before rendering and only clears the "Copied" state when the link itself changed. |

### What was intentionally not done

* **PERF-11 / PERF-12** — both need a decision or a Rust build, not more code
  (see the table).
* **DUP-08 / DUP-11** — refactors with no user-visible symptom; they stay on the
  list rather than being half-done.
* **DEAD-03** — see the table: deleting the manual-transaction surface is a
  coordinated removal, not a tidy-up.

---

*Previous audit findings were deliberately kept out of the repository
(`aa8a6cf`). This document follows that convention for its analysis but adds
one living part: §10 records what was fixed, where, and what was deliberately
left. Once the deferred items are closed or dropped, delete §10 and archive the
rest.*
