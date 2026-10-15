# Purple Memo — Full Plan

> Greenfield build. This document is the single source of truth.
> The coding agent works **one phase at a time** (Part B) and never needs
> anything outside this plan.

---

# Part A — Main Plan

## 1. Product

**Purple Memo** — a personal, offline-first desktop notebook and life/money
manager for one person. No accounts, no servers, no cloud. Everything lives
in an encrypted database on the user's own machine.

**Non-goals:** multi-user, collaboration, hosted sync, web version, mobile app
(a same-network view for a phone comes later, Part B P5 — read-only).

## 2. Features

### 2.1 Budget Tracker
Standard personal budget-tracker features:

- **Wallets:** Cash, Kpay, Wave Money, CB Pay, Banking (+ user-added).
  Each wallet shows its balance = sum of entries naming it.
- **Income / Expense entries:** amount, category, wallet, date, note.
  Money is stored as **integer cents** in the DB, shown in major units (MMK).
- **Categories:** expenses seeded (food, transport, rent, health,
  education, bills, other); income seeded separately (incl.
  **Business**, §2.2); both user-addable — tables in §4.
- **Views:** daily list, monthly summary, yearly summary, per-category totals.
- **Expense limit:** per-category monthly cap; warn at 80%, warn again when
  exceeded. Never blocks entry.
- **Monthly payments (recurring):** rules with frequency
  (weekly/monthly/quarterly/yearly) and next-due date; marking one paid
  creates the expense entry. Catch-up is capped (never an unbounded loop).

**Core money rule — cash basis:** an entry counts as income **only when cash
actually arrives**. Promises and unpaid amounts are never income.

### 2.2 Business Tracker
Jobs, shops, receivables, payables.

- **Jobs:** title, customer (shop), total amount, paid amount, date,
  warranty days (for repair jobs), notes. Status: `open` | `paid`.
- **Paid in full at once** → status becomes `paid`, the job moves to
  **History**, and an **Income entry is created in the Budget Tracker**
  under the **Business category**, in the wallet the money arrived in.
- **Partial payments (cash basis, §2.1):** every receipt creates its own
  **Income entry** under the **Business category** in the wallet it arrived
  in, when it arrives. The job stays in **Receivable** with the remaining
  balance until fully paid; per-customer receivable totals.
- **Payable:** amounts the user owes (suppliers etc.) — title, amount,
  due date; marking paid creates the expense entry.
- **Shops:** customer/supplier directory (name, phone, address, notes).
- **History:** paid/closed jobs, read-only list.
- **Text voucher for receivables:** when asking a customer to settle,
  generate a plain-text voucher — shop name, date, list of unpaid jobs
  (title + remaining each), total remaining. Copy to clipboard; the user
  sends it via any app (Viber, Messenger, …). Plain text is deliberate:
  the receiving phone needs no PDF reader.

### 2.3 Loans
Money lent and borrowed: counterparty, amount, repaid amount, due date,
direction (`lent` | `borrowed`), note. States derived:
`open` | `partial` | `overdue` (due date < today) | `closed`.

### 2.4 Notes
Markdown notes with an **editor + live preview** (`react-markdown`),
collections (folders), tags, pin, archive, full-text search (FTS5 over
title/content/tags/folder), 140-char plain-text excerpts.

### 2.5 Journal
One entry per calendar day, month grid navigation.

### 2.6 Shopping List
Lists with checkable items, manual sort order.

### 2.7 Personal
- **Habits:** daily logs, current/best streaks, week progress, month grid.
- **Tasks & reminders:** due dates, repeats (daily/weekly/monthly),
  local notifications via the Tauri notification plugin.
- **Address book:** contacts, phone/email channels (primary flag, order),
  tags, addresses, birthdays (full date or month-day).
- **Memories:** date-based entries; Upcoming (14 days), On-this-day,
  month feed; contact birthdays surface here.
- **Gallery:** photo storage (see §4), photo links to notes/memories/jobs.
- **Vault:** password-protected secrets (see §5).

### 2.8 Dashboard / Settings / More
- **Dashboard:** today at a glance — due tasks/reminders, today's money
  in-out, habit week progress, upcoming memories/birthdays, expiring
  warranties, total receivable. Every card links to its feature.
- **Settings:** theme (dark/light), PIN setup/change + security question,
  vault password setup/change, backup export/import, encryption-key export,
  about. No accounts, no sync, no cloud settings — they never exist.
- **More:** overflow navigation for secondary pages.

### 2.9 PIN lock
Light app lock (not a login system):

- 6+ character PIN, set on first run (skippable? **No — required**).
  Stored as a salted PBKDF2-SHA256 hash — **600k iterations** (same
  cost as the vault, §5) — in the settings table; the PIN itself is
  never stored.
- Lock screen on app launch, manual lock button, auto-lock after
  10 minutes idle (configurable).
- **Forgotten-PIN fallback (required):** security question set together
  with the PIN; correct answer allows setting a new PIN. No online
  recovery exists — the UI states this plainly at setup.

## 3. Tech stack — locked versions (verified 2026-10-07; max-stable re-verified 2026-10-11, semver-sorted)

| Layer | Choice | Version |
|---|---|---|
| Shell | Tauri | **2.12.3** |
| Tauri CLI / API | @tauri-apps/cli / @tauri-apps/api | 2.12.2 / 2.12.3 |
| Updater (plugin + JS) | tauri-plugin-updater / @tauri-apps/plugin-updater | 2.13.3 |
| Notifications | tauri-plugin-notification / @tauri-apps/plugin-notification | 2.6.0 |
| DB | rusqlite (`bundled-sqlcipher-vendored-openssl`) — SQLite 3.51.3 + SQLCipher | 0.40.2 |
| Key storage | keyring crate (OS credential store) | 4.2.0 |
| UI | React + react-dom | 19.3.0 |
| Build | Vite / @vitejs/plugin-react | 8.3.4 / 6.1.2 |
| Styling | Tailwind CSS / @tailwindcss/vite | 4.3.3 |
| Language | TypeScript (native port) | 7.0.2 |
| Node | >= 24 | 24.20.0 |
| Markdown | react-markdown | 10.1.0 |
| Backup zip | fflate | 0.8.3 |
| Lint/format | @biomejs/biome | 2.5.15 |

**Dependency rules:**
1. Latest STABLE only — no alphas/betas/RCs. Re-check max stable with
   semver-aware sorting at the start of every phase (string comparison
   lies: "2.9.5" > "2.12.1" lexicographically).
2. A dependency that blocks another's update gets **replaced**.
3. Prefer small dependency trees. Nothing that needs a hosted backend
   or an account. Lockfile committed.

## 4. Architecture

```
UI pages → feature lib (src/lib/*) → data driver (src/data) → Tauri IPC → Rust → SQLCipher SQLite (WAL)
```

- **One driver:** Tauri only. No multi-backend abstraction.
- **UI never touches the DB directly.** Pages call feature libraries;
  libraries call the single async data driver; the driver calls Tauri IPC.
- **Rust IPC surface (14 commands):** the 10 database/photo commands —
  `db_query`, `db_execute`, `db_batch`, `db_begin`, `db_commit`,
  `db_rollback`, `photo_save`, `photo_read`, `photo_delete`, `db_key_export` —
  plus the 4 P5 share controls `share_start`, `share_stop`, `share_status`,
  `share_publish`. The share commands are still reached through the single
  driver (§4's one-driver rule holds); they touch no SQL, no filesystem and
  no key — they only control the listener and the snapshot bytes the desktop
  published. Without them §8's opt-in toggle could not exist.
- **Connection model:** one SQLCipher connection behind a mutex — every
  IPC call serializes through it; no pooling. Multi-statement writes
  use `db_batch` (committed as a single transaction inside Rust).
  `db_begin`/`db_commit`/`db_rollback` exist only for short critical
  sections and are never held across UI awaits.
- **Photos:** bytes hashed (sha256) → stored at
  `photos/<yyyy>/<mm>/<sha256-hex>.<ext>` under app-data; DB keeps the
  relative path; reads guard against path traversal.
- **Tests:** TS via `node --test` with an explicit
  `src/**/*.test.ts` glob (§7); Rust via `cargo test`.
- **Dates:** local `yyyy-mm-dd` everywhere ("today" = user's local date).
- **Money:** integer cents in DB and in logic (`toCents = Math.round(v*100)`);
  major units only at display/parse edges. Outstanding amounts never
  negative.

### Schema (29 tables, single baseline — no SQL migrations)
`notes`, `collections`, `journal_entries`, `wallets`, `income_entries`,
`income_categories`, `expense_entries`, `expense_categories`,
`expense_limits`, `recurring_payments`, `loans`, `jobs`, `shops`,
`payables`, `shopping_lists`, `shopping_items`, `habits`, `habit_logs`,
`tasks`, `reminders`, `contacts`, `contact_channels`, `contact_tags`,
`memories`, `photos`, `photo_refs`, `vault_items`, `settings`
(key-value: PIN hash, security question, theme, …), `notes_fts` (FTS5).

- **Income categories** are a table (mirrors `expense_categories`),
  seeded with **Business** (required by §2.2) + salary/gift/other,
  plus user-added — income entries FK to it.
- **`PRAGMA user_version` = 1** stamped on the baseline.
- **Schema evolution policy:** no SQL migrations, ever. A future
  schema change ships as: old version exports a backup (§8) → new
  version imports and transforms it (import already upgrades by file
  version). The DB file itself is only ever created at
  `user_version` 1.

## 5. Security model

1. **Database at rest:** SQLCipher, random 256-bit key minted on first run,
   stored in the OS credential store (`keyring`). Encrypted with **no
   password prompt** — verified (`PRAGMA key` → read `sqlite_master`)
   before any schema work; WAL mode; `PRAGMA foreign_keys=ON`.
2. **App access:** PIN lock (§2.9) — casual-eyes protection.
3. **Vault:** separate password; items encrypted with AES-256-GCM,
   key from PBKDF2-SHA256 600k iterations (WebCrypto). Salt+IV stored
   per item (plain base64); **no recovery** — the UI says so before the
   password is set. Auto-lock bounds the unlocked window.
4. **Backup** offers a separate, user-controlled **key-export step** —
   the key is written as its **own file, never inside the backup zip**
   (bundling them would make the zip a plaintext-equivalent copy of
   the DB). A DB backup without the key is unopenable, and the UI says
   so before export.

## 6. Design system — PurpleShade theme

- Dark-first: deep purple-tinted surfaces (`#14101F` base), light mode
  mirror. All purple hues anchor to the **brand purple `#310096`** (hue 255°,
  sampled from `public/brand/*.png` — the logo is the color source of truth).
  Accent violet `#794DFF` (same hue, lightened for interactive use),
  success `#22C55E`, warn `#F59E0B`, danger `#EF4444`.
- All design values live in `src/styles/tokens.css` as CSS variables;
  **no hardcoded colors/spacing/typography in components** (linted, §7).
- Money and figures always use tabular numerals (`.figure` class).
- One primary action per view. English UI text.

## 7. Quality gates — strictest, local only

No hosted CI is used. The local gate is the enforcement:

**`npm run verify` =**
`biome check --error-on-warnings .` → token-lint script → `tsc --noEmit` → `node --test "src/**/*.test.ts"` → `cargo test --manifest-path src-tauri/Cargo.toml` → `cargo clippy --all-targets -- -D warnings` → `cargo fmt --check` → `vite build`

- **Biome:** recommended preset + **`noExplicitAny` raised to error**;
  formatter (2-space, double quotes, semicolons) and organize-imports
  enforced — `biome check` covers all three. The gate runs it with
  `--error-on-warnings`, so **any** diagnostic (warning or error) fails
  the gate — the preset's mixed severities can't slip through.
- **tsc:** `strict` + `noUncheckedIndexedAccess` +
  `erasableSyntaxOnly` (tests execute via Node's type-stripping;
  enums, namespaces and parameter properties would crash the runner).
- **Tests:** explicit glob `node --test "src/**/*.test.ts"` — default
  discovery is never relied on. With zero test files it exits 0
  (verified on Node 24), so P0's gate isn't blocked by missing tests.
- **Rust:** clippy denies warnings; `cargo fmt --check`. P0 assumes
  `rustup component add clippy rustfmt` has been run once.
- **Windows / line endings:** one-time `biome check --write .` in P0
  (under `core.autocrlf=true`) shakes out CRLF/LF churn before the
  gate is trusted; `.githooks/*` + `*.sh` are pinned to LF by
  `.gitattributes` (POSIX `sh` chokes on CRLF shebangs even though
  Git-for-Windows tolerates them).
- **Pre-push hook** (`.githooks/pre-push`, enabled per clone via
  `git config core.hooksPath .githooks`) runs `npm run verify`.
  Red never gets pushed. **`--no-verify` is never used** — that is the
  one rule the Progress log's gate column (Part B) exists to back up.
  `verify` itself warns when `core.hooksPath` is not `.githooks`.
- **Token lint:** a script (created in P0, runs inside `verify`) fails
  the build if hex colors / hardcoded spacing appear outside
  `tokens.css`. It trivially passes until P3a writes the first
  components — then it bites from day one instead of a P4 retrofit.
- **Version check:** `scripts/check-versions.mjs` (added post-review,
  L-05) fails `verify` when `package.json`, `src-tauri/tauri.conf.json`
  and `src-tauri/Cargo.toml` disagree — the exact drift that makes the
  updater silently ignore a release.
- Every phase below has its own gate; a phase is done only when its
  gate is green.

## 8. Backup & same-network view

- **Backup:** zip (fflate) containing `{ app: "purple-memo", version,
  exportedAt, data }` + the `photos/` tree — **data only; the
  encryption key is never inside the zip** (separate key-export file,
  §5.4). Import rejects files not made by this app and upgrades by
  file version; this import path **is** the schema-upgrade mechanism
  (§4 — no SQL migrations). The user saves the file wherever they
  want — there is no other backup.
- **Same-network view (P5):** a read-only snapshot endpoint on the LAN
  so the user's phone can view data on the same network. Single writer
  (the desktop), no sync engine, no merge logic.

## 9. In-app updates — no CI, releases published by hand

**No GitHub Actions is used anywhere in this project.** Updates go
through GitHub Releases, but artifacts are produced and published
**locally**:

1. **Sign:** update-signing key generated once with `tauri signer
   generate`; the private key **stays on the owner's machine** — never
   in the repo, never in any hosted secret store.
2. **Build:** `tauri build` emits the installer, the updater
   artifacts (`.sig`) and the `latest.json` manifest the updater polls.
3. **Publish:** `gh release create <tag>` (or the GitHub web UI)
   uploads artifacts + `latest.json` — manual, and done only after a
   green local gate (§7) and, before the first release, the P6 audit.
4. **Consume:** `tauri-plugin-updater` is pointed at the repo's
   Releases URL; the app checks, downloads, verifies the signature,
   installs.

The local gate (§7) is the *only* check before a release is cut —
there is no CI to catch anything it missed. (Release mechanics are
detailed at P5.)

---

# Part B — Phase-by-phase build log

> The coding agent receives **one phase at a time**: that phase's scope +
> the matching Part A sections + its gate. Nothing else.

| Phase | Scope | Gate |
|---|---|---|
| **P0** Scaffold | Vite 8 + React 19 + TS 7 (`erasableSyntaxOnly`) + Tailwind 4 + Tauri 2.12; all §3 runtime deps installed (`react-markdown`, `fflate` included); `tokens.css` + token-lint script; logo in `public/brand/`; updater wiring; Biome + `.githooks/pre-push` + `.gitattributes`/`.gitignore` (hooks pinned LF); `verify` script (explicit test glob, `--error-on-warnings`); README with gate docs | `npm run verify` green; hook proven to run and block a red push |
| **P1** Encrypted DB core | SQLCipher via rusqlite, keyring key (mint-once, verify-before-use, WAL, FK on); **FTS5-availability test** under SQLCipher (spike: `CREATE VIRTUAL TABLE … USING fts5`); 29-table schema + `PRAGMA user_version` = 1; 9 IPC commands (mutex-serialized connection, `db_batch` for multi-statement writes); photo save/read/delete; `settings` table | `cargo test` + `npm run verify` green |
| **P2** Data layer | Single Tauri driver; per-domain repositories; money lib (cents, cash-basis rule); crypto module (PIN hash/verify, vault AES-GCM); FTS search helper | unit tests green + `npm run verify` |
| **P3a** Notes + Journal | Notes CRUD, collections, tags, pin/archive, markdown editor+preview, FTS search; journal day entries + month grid | feature works E2E + verify |
| **P3b** Budget Tracker | Wallets, income/expense CRUD, categories, monthly/yearly views, expense limits + warnings, recurring payments | feature works E2E + verify |
| **P3c** Business + Loans | Jobs, shops, receivables, payables, history; paid-in-full → history + Business-category income; loans (lent/borrowed) + states | feature works E2E + verify |
| **P3d** Habits + Tasks + Shopping | Habit logs/streaks/week view; tasks + reminders + notifications; shopping lists | feature works E2E + verify |
| **P3e** Address book + Memories + Gallery + Vault | Contacts/channels/tags/birthdays; memories views; gallery; vault password setup + encrypted items | feature works E2E + verify |
| **P3f** Dashboard + Settings + More + PIN | Today-view dashboard; settings (theme, PIN + security question, vault pw, key export); lock screen + auto-lock + fallback flow | feature works E2E + verify |
| **P4** Backup + polish | Export/import UI + separate key-export step (in Settings); empty states; icon/pass; full design review vs §6 | verify + design checklist |
| **P5** Share + updater | Same-network read-only snapshot endpoint; signed updater flow **published by hand** — local `tauri build` + `gh release create`, signing key stays local (§9) | E2E on LAN + verify; app installs a manually published release |
| **P6** Pre-release audit | Full report-only audit (code, security model, gates); fix wave; release build | audit clean, release cut |

### Progress log (updated per phase)

| Phase | Status | Commit | Gate result | Notes |
|---|---|---|---|---|
| P0 | done | 42ba66e, 4ed9574, 19be80f | `npm run verify` green (8/8 steps); pre-push hook proven: blocked a red probe with exit 1, then passed with exit 0 | Updater keypair minted locally in `.keys/` (gitignored, §9); updater dep 2.13.1 → 2.13.2 per §3 rule 1 (max stable re-checked 2026-10-08); `react-markdown` 10.1.0 + `fflate` 0.8.3 installed exact-pinned (versions re-verified, unchanged); P2 review found `tsconfig.json` checked out with CRLF (autocrlf churn) — fixed durably by pinning `*.json text eol=lf` in `.gitattributes` (commit 19be80f) |
| P1 | done | 9998ed4 | `cargo test` green (17/17 tests); `npm run verify` green (8/8 steps) | SQLCipher via rusqlite 0.40.2 + keyring 4.2.0 mint-once key (verify-before-use, WAL, FK on); FTS5 spike passed — finding: legacy special `'delete'` INSERT command fails on plain fts5 tables in this build (SQLite 3.51.3), triggers use direct `UPDATE`/`DELETE` statements instead; 29-table baseline at `user_version` 1 incl. `settings`; 9 IPC commands + photos with traversal guard; deps re-checked max-stable 2026-10-09, `getrandom` 0.4.3 added for key minting |
| P2 | done | 924fd83d | `npm run verify` green (8/8 steps); 67/67 unit tests | Single Tauri driver (`src/data/driver.ts`) + recording mock driver (`src/data/mock-driver.ts`) so repos are testable without Tauri; 13 per-domain repositories (notes, journal, budget, business, loans, shopping, habits, tasks, contacts, memories, gallery, vault, settings) over `types.ts`; money lib (integer cents, cash-basis `outstandingCents` never negative, `applyPayment` clamps); crypto module (PIN PBKDF2-SHA256 600k + normalized `verifyAnswer`; vault AES-256-GCM with **per-item** salt+IV, no recovery); FTS search helper (MATCH query builder + notes search); dates lib (local `yyyy-mm-dd` everywhere — `toISOString()` was caught and replaced); `allowImportingTsExtensions` added to `tsconfig.json` so Node type-stripping runs the tests; `noNonNullAssertion` + `noUncheckedIndexedAccess` enforced by the gate — tests use a runtime-checked `at()`/`first()` helper instead of `!`; P0/P1 review: gates re-run green after the tsconfig fix; P0–P2 plan-vs-code review 2026-10-10: fixed `db_execute` outcome casing (Rust serialized snake_case; Tauri does not rename command return values, so every `lastInsertRowid` would have been `undefined` in the real app) — added `#[serde(rename_all = "camelCase")]` + regression test; added the missing `updater:default` capability (P0 updater wiring); §3 table re-synced to max stable (tauri/api 2.12.2, vite 8.3.4); duplicate P3a row removed; gates re-run green |
| P3a | done | 48b8a5a, cb55f19, 8cda15b | `npm run verify` green (8/8 steps: biome, token-lint, tsc, 77/77 unit tests, clippy `-D warnings`, fmt, vite build) | Notes (§2.4): CRUD, collections, comma-separated tags, pin/archive, `react-markdown` live preview, FTS search, 140-char excerpts, send-to-today's-journal; Journal (§2.5): one entry/day upsert, native-table month grid with entry dots, today-highlight, month nav + Today jump, editor+preview; composition root `src/data/app.ts` is the single wiring point (pages touch repos only, §4); ~25 new token-scoped styles in `src/styles/app.css`; lib coverage extended (notes excerpt/grid) — 67→77 tests; final review findings fixed in cb55f19 (races, vault, updater, photos, CSP); formatter drift restored 2026-10-10 in 8cda15b (biome spaces/LF, rustfmt, `*.ts`/`*.tsx` pinned LF in .gitattributes) |
| P3b | done | 90d1195, b4bb4c6, 430414d, 1bd964b, 6e396b8, bcc834a | `npm run verify` green (8/8 steps: biome, token-lint, tsc, 108/108 unit tests, clippy `-D warnings`, fmt, vite build); `cargo test` green (18/18); E2E `tauri dev` boot clean (app launched, DB init, no panics) | Budget Tracker (§2.1) across 6 TDD tasks: Manage view (wallets + balances, expense/income category create; shared `cleanName`); daily entries (income/expense CRUD, `parseMMK` strict decimal parse, prospective 80%/exceeded limit warning that never blocks, §2.1); monthly summary (totals, net, per-category breakdowns, deleted categories keep `Category #<id>` labels); yearly summary (year totals + 12-month table with per-month net); limits view (per-category monthly caps, urgency-sorted rows); recurring view (rules list, overdue/due chips, mark-paid with capped catch-up + fallback category/wallet, pause/resume, create form); pure display helpers extracted in `lib/budget.ts` (`monthSummaryDisplay`, `yearDisplay`, `limitDisplayRows`, `recurringDisplay`, `dueOccurrences`) keep the page dumb and the logic tested; lib coverage 77→108 tests; final self-review of c991509..bcc834a found no Critical/Important issues, 3 deferred minors (date-input clear edge, edit-form reset ignores kind, stale recurring fallback id) |
| P3c | done | 78a60c2, d0a2171, a8be43d, 22c9712, 670c8c2, 602b6fc, f317a26 | `npm run verify` green (8/8 steps: biome, token-lint, tsc, 113/113 unit tests, clippy `-D warnings`, fmt, vite build); `cargo test` green (18/18); E2E `tauri dev` boot clean (twice, incl. post-fix) | Business (§2.2) + Loans (§2.3) across 5 TDD tasks + fix pass: Shops directory with per-customer receivable totals (`shopReceivableRows`, deleted-shop + "No shop" group labels); Jobs view (create with optional shop/warranty days, inline record-payment with wallet picker prefilled with the remainder, `warrantyEndDate`/`inWarranty` chips); Receivable view (per-customer outstanding + grand total + plain-text voucher copy-to-clipboard — deliberate: receiving phone needs no PDF reader); Payables view (`payableDueStatus` overdue/due chips, mark-paid → expense entry with category/wallet pickers); History view (read-only paid jobs); Loans page (`deriveLoanState` chips open/partial/overdue/closed, inline repayment prefilled, delete, lent/borrowed create form); phase-start dep re-check bumped tauri 2.12.3 / updater 2.13.3 / notification 2.6.0; final self-review found 1 Important (shopless jobs rendered as "Deleted shop #null" orphans with live buttons — fixed in f317a26, TDD), lib coverage 112→113 |
| P3d | done | 0619bca, 05ca248, dd7732d, be47a1e | `npm run verify` green (8/8 steps: biome, token-lint, tsc, 116/116 unit tests, clippy `-D warnings`, fmt, vite build); `cargo test` green; E2E `tauri dev` boot clean (twice, incl. post-fix) | Habits (§2.7): today toggle, current/best streaks, 7-day week toggle row, Sunday-start month grid reusing journal's `buildMonthGrid`; Tasks: open/done lists with overdue chips + repeat badges, `nextDueDate` (TDD) rolls a repeating task's due date to the next future occurrence on completion (capped walk, month clamp); Reminders: create/delete + 30s notification poll via the Tauri notification plugin (permission asked once, denial surfaces inline, repeating reminders re-arm); **added the missing `notification:default` capability** — the plugin was registered in Rust since P1 but had no capability, so every notification call would have failed; Shopping (§2.6): list tabs (select/rename/delete), checkable items, `moveItem` (TDD) one-step reorder persisted via `reorderItems`; final self-review found 1 Important (reminder poll compared UTC `toISOString()` against local `remind_at` — every reminder would fire hours off; fixed in be47a1e with TDD `localISODateTime`), lib coverage 113→116 |
| P3e | done | b21f7a9, 029e585, cbd6d31, 88b45f0 | `npm run verify` green (8/8 steps: biome, token-lint, tsc, 131/131 unit tests, clippy `-D warnings`, fmt, vite build); `cargo test` green (18/18); E2E `tauri dev` boot clean (app launched, DB init, no panics) | Address book (§2.7): searchable contact list, detail with edit, channels (phone/email/other, primary star via `setPrimaryChannel`, add/delete), tag chips, birthdays (full date vs month-day mode — `normalizeMonthDay` TDD-validates `MM-DD`, rejects Feb 30; `birthdayLabel` TDD'd display); Memories: Upcoming (14d) + On-this-day views with **contact birthdays surfaced** (§2.7), month feed with `shiftYearMonth` (TDD) nav, All view + shared create/edit form; Gallery: pick-files → bytes → `savePhoto`, thumbnails as object URLs (CSP `img-src blob:` already allowed since P3a), photo note/taken-date (`updatePhoto` TDD, partial update), **`listRefsForPhoto` (TDD)** + link/unlink to notes/memories/jobs via picker; Vault (§5.3): setup screen states "no recovery" **before** the password is set, unlock via GCM canary, item CRUD with in-memory password (P3f adds app auto-lock on top), reveal/hide, `changePassword` re-encrypt flow; `photoExtFromName` (TDD) keeps file names from steering storage paths; nav grew to 12 tabs (`app-nav` wraps); review fix included: gallery thumbnail object URLs revoked on unmount mid-load; lib coverage 125→131 |
| P3f | done | c5272a5 + working-tree fixes | `npm.cmd run verify` green; 136/136 TS tests; 19/19 Rust tests; clippy clean | Dashboard, Settings, More, PIN lock, auto-lock, fallback flow, atomic PIN settings writes, and separate key-file export. |
| P4 | done | e3d898d, 83c1ca5, 79f238e, a0bc644, 005b815 | `npm.cmd run verify` green (8/8 steps: biome, token-lint, tsc, 153/153 unit tests, clippy `-D warnings`, fmt, vite build); `cargo test` green (19/19) | Backup & polish (§8): export/import UI in Settings + separate key-export step (was a P3f placeholder). `lib/backup.ts` + 17 TDD tests: zip (fflate) of `backup.json` `{app:"purple-memo", version, exportedAt, data}` + the `photos/` tree — **data only, key never inside the zip** (§5.4); import validates the app marker and rejects non-app/non-zip/newer-version/corrupt files, upgrading by file version (`upgradeBackupData` seam — §4: import is the schema-upgrade path, no migrations). Import writes photo files first (savePhoto re-hashes content-addressed; rows are re-pointed to the real path so the DB never references a missing file — and the parsed payload is copied, never mutated), then one `db_batch` replaces all rows with FK off (table order irrelevant) + FK restored in `finally`; orphaned old photo files are unlinked only after the batch commits, so a failed import never leaves rows/files inconsistent. `notes_fts` excluded from backup — a trigger-maintained derived index, rebuilt on import. Empty states unified: shared `EmptyState` component + `icons.tsx` (inline SVG, no new dep), 14 ad-hoc `<p className="muted">` placeholders migrated across 9 pages; `.empty-state` deduped (was defined twice in app.css). Design review vs §6: added `.figure` (tabular numerals) to the two inline money spots that lacked it (recurring + limit rows); icons sized in em via tokens; destructive import is confirmed before applying and `location.reload()`s after (the imported settings re-boot the app). mock-driver gained `batchError`. **Pre-commit audit of P0-P4 found and fixed 1 Critical + 1 Important:** (1) *Critical* — `insertStatement` interpolated backup-supplied **column names** straight into SQL, so a hostile zip could inject SQL into the import batch; fixed with a strict identifier check (`requireIdentifier`) + 2 TDD tests (lib coverage 153→155). (2) *Important* — `App.tsx` boot treated a **settings-read failure** as "first run" and would show `SetupScreen`, risking a PIN overwrite (e.g. right after an import+reload); now distinct `BootState.error` renders a locked error screen instead. Audit confirmed clean: Rust key mint/verify/one-mutex/batch-atomicity, crypto PBKDF2 600k + AES-GCM per-item, §3 dep versions exact, CSP strict + minimal capabilities, money-lib cash-basis invariants, local-date discipline (one `toISOString()` only for the backup `exportedAt` timestamp), `notes_fts` correctly excluded. Known non-issues noted: a 30s reminder poll can interleave between import IPC calls (mutex makes the batch itself atomic; worst case a stray row the import wipes) — inherent to the mandated single-connection 10-command model. |
| P5 | in_progress | 1106574 | `npm.cmd run verify` green (8/8 steps: biome, token-lint, tsc, 173/173 unit tests, clippy `-D warnings`, fmt, vite build); `cargo test` green (32/32, 13 of them new share tests driving the real listener over TCP); E2E `tauri dev` boot clean (app launched, DB init, no panics) | **Share (§8) done, gated: opt-in per session** (never survives a restart), random 6-char pairing code minted at start and required on every request, constant-time compared, 10 wrong codes shut the server down and the app says why; binds `0.0.0.0:<ephemeral>` and reports the LAN link + port; serves the phone page (design tokens inlined from `tokens.css` at compile time via `include_str!`, Tailwind's module import stripped) and `/api/snapshot`; **the network path has no DB, key or filesystem access** — it only ever serves the payload `share_publish` validated (JSON object + numeric `version` + `generatedAt`, ≤512 KiB). The payload is built once, in TS, by `lib/share.ts` (bounded sections, display-ready strings, vault/settings/photos structurally absent, `noteExcerpt` for notes) and re-published by an app-shell loop every 30 s (paused while locked, so the last snapshot keeps serving — the code is the access control, not the lock). Settings gets the toggle, the link, the code, the port, copy-link and stop; import stops sharing *before* replacing data so the phone can never keep reading pre-import rows. Dep: `tiny_http 0.12.0` (blocking, no async runtime — §3 preference for small trees), re-checked as max stable. **Updater (§9) prepared, not released** (owner's choice): plugin + capability + pubkey were already wired in P0, but there was no UI and no release had ever been tagged — Settings → Updates now checks on demand, shows version/date/notes and installs with progress. Finding: **`tauri build` does not emit `latest.json`** (upstream only generates it inside the unused GitHub Action — Tauri docs, v2.tauri.app/plugin/updater), so `lib/release.ts` + `scripts/make-latest-json.mjs` build and validate it (semver, RFC 3339 `pub_date`, and the `.sig` *contents* — not a path — as `signature`) and print the exact `gh release create` line; `docs/RELEASE.md` is the by-hand procedure. Auto-check on boot is deliberately absent until a release exists (it would only produce a 404 toast). **Two bugs found while building this:** (1) `ShareState::publish` re-locked the snapshot mutex inside `info()` — a self-deadlock that hung the first `cargo test` run (the failing test is now the regression proof; mutex is not reentrant); (2) biome rejects a CRLF stylesheet, and `* text=auto` + `core.autocrlf=true` hands a fresh clone CRLF `app.css` → red gate at the first step — `*.css` and `*.rs` are now pinned `eol=lf` in `.gitattributes`, the same fix class as P4's `*.json`/`*.ts` pins. **Remaining for the P5 gate — both need the owner:** (1) a real phone on the LAN against a release build (the HTTP surface is covered by tests over real sockets, but no phone was driven), and (2) installing a hand-published signed release from an older build (`gh` is not installed on this machine; releases can also be published via the web UI). |
| P6 | pending | | | |

*Status values: pending → in_progress → gate_pass / gate_fail → done.*
