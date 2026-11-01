# PurpleMemo — Pre-Merge Full Audit (v0.1.1, base `882d5fc`)

Final audit pass before the `dev` → `main` batch merge. Base: `dev` HEAD
`882d5fcefce274d7dda429217d8095fbe1161c5d`. Doc-only pass: **no code changes**.

## Method

- Read `882d5fc`'s four fix classes and swept the whole repo for the same
  classes: dead exports, SQL referencing non-existent columns, stale
  references left by refactors, casts that hide missing values.
- **SQL cross-check (class 2), done mechanically, not by eye:** every SQL
  string literal in `src/**/*.{ts,tsx}`, `src-tauri/src/*.rs` and
  `scripts/*.mjs` was extracted (712 statements; Rust raw strings, template
  literals and `${…}` interpolations handled) and each was `EXPLAIN`-prepared
  against a real SQLite database built from `BASELINE_SQL` in
  `src-tauri/src/schema.rs`. A statement referencing a non-existent column
  fails at prepare time, so this is exhaustive for static SQL. Statements that
  interpolate identifiers (`FROM ${table}`, `SET ${sets…}`) were resolved by
  hand: every interpolated table comes from a closed constant map
  (`BACKUP_TABLES` in `src/lib/backup.ts:130`, `TABLES` in
  `src/lib/trash.ts:44`, `ENTITY_TABLES` in `src/lib/entityLinks.ts:40`,
  `PHOTO_REF_TABLES` in `src/lib/gallery.ts:269`, `TARGET_TABLES` in
  `src/lib/inbox.ts:57`, the `SEARCH_CONTRACT` specs in
  `src/lib/searchContract.ts:101+`) — all verified against the schema — and
  every interpolated column list (`sets.push("col = ?")` in `budget.ts`,
  `business.ts`, `contacts.ts`, `gallery.ts`, `loans.ts`, `memories.ts`,
  `notes.ts`, `tasks.ts`; `TRASH_SNAPSHOT_COLUMNS` in `src/lib/trash.ts`)
  was checked column-by-column. `sort_order` appears only on
  `shopping_items` and `contact_channels`, both of which declare it
  (`schema.rs:436`, `schema.rs:491`).
- **Migration chain verified:** a v1 database was reconstructed (baseline
  minus the post-v1 objects, old `notes_fts_au` trigger restored),
  `MIGRATION_1_2` … `MIGRATION_5_6` were applied in order with version stamping,
  and the resulting `sqlite_master` is **byte-identical (modulo whitespace)
  to `BASELINE_SQL`** — the migration path and the fresh-install path agree.
- **Dead-code check:** every `export` in `src/` (declarations, brace exports,
  re-exports) was counted for references in comment-stripped source across all
  files; every `pub` item in `src-tauri/src/*.rs` likewise.
- Baseline gate before writing: `tsc --noEmit` clean, `biome check
  --error-on-warnings` clean, `node --test "src/**/*.test.ts"` **854/854
  pass**. (`cargo` is not installed in this sandbox, so `test:rust` / `clippy`
  / `fmt:check` could not be run here; the Rust side was covered by the
  source scans above instead.)

## Commit `882d5fc` sanity check

- Removed export `sha256HexText` (`crypto.ts`): no import or code reference
  anywhere. The only remaining mentions are the intentional prose comment in
  `src/lib/vault.ts:163` (documents what P3-19 changed) and the negative
  regex `/sha256HexText|sha256HexBytes/` in `src/lib/vault.test.ts:436`, which
  strips comments before matching and asserts *absence* — both fine.
- Removed alias `urlTransform` (`links.ts`): no import anywhere. Remaining
  mentions of the string `urlTransform` are the live react-markdown **prop**
  (`urlTransform={markdownUrlTransform}` at `src/pages/NotesPage.tsx:253`,
  `src/pages/JournalPage.tsx:485`, `src/components/NoteReaderDialog.tsx:214`;
  the transform itself is exported as `markdownUrlTransform`,
  `src/lib/links.ts:34`, re-exported at `src/components/MarkdownLink.tsx:134`)
  and prose describing the prop. The wiring test
  (`src/components/MarkdownLink.test.ts:34`) asserts against current source
  and passes.
- `budget.ts` `ORDER BY c.sort_order` → now `ORDER BY c.id` at
  `src/lib/budget.ts:952`, where `c` aliases `expense_categories` (which has
  `id` but no `sort_order`) — correct fix, verified by EXPLAIN.
- `additionalData as BufferSource | undefined` → now conditional params at
  `src/lib/crypto.ts:330-332` and `src/lib/crypto.ts:374-376`
  (`if (additionalData) params.additionalData = …`) — correct fix.

**Verdict: `882d5fc` leaves no dangling references.**

## Findings

### PM-01 (Low) — dead exported interface `IncomeEntryRow`

- **Evidence:** `src/lib/types.ts:321` (`export interface IncomeEntryRow {`).
  A repo-wide search (code, comments stripped, tests, `src-tauri`, `docs`,
  `scripts`) finds exactly two hits, both in `types.ts` itself: the
  declaration and a `{@link IncomeEntryRow}` doc mention on
  `ExpenseEntryRow` at `types.ts:331`. Nothing imports or uses it; the ledger
  types both income and expense rows as `ExpenseEntryRow` (see
  `src/lib/budget.ts:12` import and `src/lib/budget.ts:89`
  `DayEntry = ExpenseEntryRow & { kind: LedgerKind }`).
- **What's wrong:** an exported type alias/interface with zero callers — the
  exact class `882d5fc` removed (`sha256HexText`, `urlTransform`).
- **Why it matters:** low runtime impact (types erase), but it is a second
  name for the same row shape, so the next reader wonders which of
  `IncomeEntryRow`/`ExpenseEntryRow` is authoritative, and a future drift
  between them would be invisible.
- **Suggested fix:** delete the interface (or un-export it and keep it only
  if something actually uses it), and reword the `ExpenseEntryRow` doc to
  say "same column list as `income_entries`" without the `{@link}`.

No other findings in any category.

## Category verdicts

1. **Dead code — one finding (PM-01); otherwise clean.** Every other export in
   `src/` has at least one reference in comment-stripped code (including
   test files); there are no unused *private* functions/consts/types in
   `src/` (template-literal references counted properly), and every `pub`
   item in `src-tauri/src/*.rs` is referenced. The vault.ts prose comment
   about `sha256HexText` is intentional history, not dead code, as flagged in
   the brief.
2. **SQL referencing non-existent columns — clean.** 712 statements
   EXPLAIN-verified against the real schema (baseline + migration chain, which
   themselves agree exactly). `sort_order` is used only on `shopping_items`
   and `contact_channels`, both of which declare it. Dynamic table/column
   interpolation is fed exclusively from closed constant maps and hardcoded
   column lists, all verified. The `882d5fc` budget fix is the only instance of
   the class and is correctly fixed.
3. **Stale references — clean.** No imports of the removed identifiers; the
   remaining mentions are intentional prose or the live `urlTransform` prop.
   No test name/regex points at a deleted function (the `vault.test.ts:436`
   regex is a negative test that strips comments first). No SQL string
   concatenation (`"SELECT…" + x`) exists outside templates.
4. **Casts hiding missing values — clean.** No `as X | undefined` anywhere;
   the only `as unknown as` in production code is the legitimate type guard
   `value as unknown as Record<string, unknown>` after `instanceof Error` in
   `src/lib/i18n.ts:1513` (the other is in `src/test-utils.ts`, test-only). No
   non-null assertions (`!`) in non-test `src/`. The `shift() as T[]` in
   `src/data/mock-driver.ts:229` is guarded by a `length > 0` check. The
   `additionalData` fix from `882d5fc` is in place; remaining
   `as BufferSource` casts in `crypto.ts` are on non-optional `Uint8Array`
   values, not on possibly-absent ones.

## General sweep (correctness / data-loss / security / crash)

Read end-to-end: `src/lib/crypto.ts`, `vault.ts`, `appLock.ts`, `settings.ts`,
`backup.ts`, `backupContainer.ts`, `trash.ts`, `session.ts`, `update.ts`,
`links.ts`, `globalSearch.ts`/`searchContract.ts`, `src/data/{driver,app,mock-driver}.ts`,
and `src-tauri/src/{schema,db,commands,lib,lifecycle,navigation,photos,share,file_write,safety_copy}.rs`.
No new Critical/High/Medium/Low correctness, data-loss, security or crash
bugs found. Notable already-hardened spots re-verified: strict photo path
grammar (`photos.rs:252`), header percent-decoding unambiguous by
construction (`file_write.rs:118`), atomic 0600+O_NOFOLLOW temp-then-rename
writes (`file_write.rs:74-106`), navigation origin check incl. port
(`navigation.rs:53-66`), share server GET-only + single-allowed-Host
anti-rebinding + ciphertext-only snapshot with key in the URL fragment
(`share.rs:772-820`, `share.rs:583-620`), backup zip-bomb limits + complete-
manifest rule + FK canary inside the import transaction (`backup.ts:505-660`,
`backup.ts:820-850`), vault wrong-password vs corruption error split and
in-flight key-cache generation guard (`vault.ts:88-225`), PIN hash shape/
iteration-range classification before any verify (`appLock.ts:166-230`).

## Parked (per brief — not findings)

PERF-11 (habit-log read horizon), PERF-12 (`db_query_many` multi-read IPC),
and the settled product decisions (tray close, PIN lock design, cash-basis
money, same-network-only share, single-user scope).

## Verification performed for this doc

- `npm run typecheck` — clean.
- `npm run lint` — clean (179 files).
- `npm run test` — 854 pass, 0 fail.
- SQL EXPLAIN harness over 712 statements in `src/`, `src-tauri/src/`,
  `scripts/` — zero schema violations.
- Migration simulation 1→6 vs `BASELINE_SQL` — identical `sqlite_master`.
- Export-reference scan (comments stripped) — one dead export (PM-01).
- Not run here: `cargo test` / `clippy` / `fmt:check` (no Rust toolchain in
  this sandbox); the JS half of `npm run verify` is green and this change is
  doc-only.
