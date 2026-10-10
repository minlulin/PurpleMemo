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
- **Not fully paid** → the job stays in **Receivable** with the remaining
  balance; per-customer receivable totals.
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

## 3. Tech stack — locked versions (verified 2026-10-07; max-stable re-verified 2026-10-10, semver-sorted)

| Layer | Choice | Version |
|---|---|---|
| Shell | Tauri | **2.12.2** |
| Tauri CLI / API | @tauri-apps/cli / @tauri-apps/api | 2.12.1 / 2.12.2 |
| Updater (plugin + JS) | tauri-plugin-updater / @tauri-apps/plugin-updater | 2.13.2 |
| Notifications | tauri-plugin-notification / @tauri-apps/plugin-notification | 2.5.1 |
| DB | rusqlite (`bundled-sqlcipher-vendored-openssl`) — SQLite 3.53.2 + SQLCipher | 0.40.2 |
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
- **Rust IPC surface (9 commands):**
  `db_query`, `db_execute`, `db_batch`, `db_begin`, `db_commit`,
  `db_rollback`, `photo_save`, `photo_read`, `photo_delete`.
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
`biome check --error-on-warnings .` → token-lint script → `tsc --noEmit` → `node --test "src/**/*.test.ts"` → `cargo clippy --all-targets -- -D warnings` → `cargo fmt --check` → `vite build`

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
| P3b | pending | | | |
| P3c | pending | | | |
| P3d | pending | | | |
| P3e | pending | | | |
| P3f | pending | | | |
| P4 | pending | | | |
| P5 | pending | | | |
| P6 | pending | | | |

*Status values: pending → in_progress → gate_pass / gate_fail → done.*
