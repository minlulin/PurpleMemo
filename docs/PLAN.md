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
- **Categories:** seeded personal set
  (food, transport, rent, health, education, bills, other) + user-added.
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
  Stored as a salted PBKDF2 hash in the settings table; the PIN itself is
  never stored.
- Lock screen on app launch, manual lock button, auto-lock after
  10 minutes idle (configurable).
- **Forgotten-PIN fallback (required):** security question set together
  with the PIN; correct answer allows setting a new PIN. No online
  recovery exists — the UI states this plainly at setup.

## 3. Tech stack — locked versions (verified 2026-10-07, semver-sorted)

| Layer | Choice | Version |
|---|---|---|
| Shell | Tauri | **2.12.1** |
| Tauri CLI / API | @tauri-apps/cli, @tauri-apps/api | 2.12.1 |
| Updater (plugin + JS) | tauri-plugin-updater / @tauri-apps/plugin-updater | 2.13.1 |
| Notifications | tauri-plugin-notification / @tauri-apps/plugin-notification | 2.5.1 |
| DB | rusqlite (`bundled-sqlcipher-vendored-openssl`) — SQLite 3.53.2 + SQLCipher | 0.40.2 |
| Key storage | keyring crate (OS credential store) | 4.2.0 |
| UI | React + react-dom | 19.3.0 |
| Build | Vite / @vitejs/plugin-react | 8.3.3 / 6.1.2 |
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
- **Photos:** bytes hashed (sha256) → stored at
  `photos/<yyyy>/<mm>/<sha256-hex>.<ext>` under app-data; DB keeps the
  relative path; reads guard against path traversal.
- **Tests:** TS via `node --test`; Rust via `cargo test`.
- **Dates:** local `yyyy-mm-dd` everywhere ("today" = user's local date).
- **Money:** integer cents in DB and in logic (`toCents = Math.round(v*100)`);
  major units only at display/parse edges. Outstanding amounts never
  negative.

### Schema (28 tables, single baseline — no migrations)
`notes`, `collections`, `journal_entries`, `wallets`, `income_entries`,
`expense_entries`, `expense_categories`, `expense_limits`,
`recurring_payments`, `loans`, `jobs`, `shops`, `payables`,
`shopping_lists`, `shopping_items`, `habits`, `habit_logs`, `tasks`,
`reminders`, `contacts`, `contact_channels`, `contact_tags`, `memories`,
`photos`, `photo_refs`, `vault_items`, `settings` (key-value: PIN hash,
security question, theme, …), `notes_fts` (FTS5).

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
4. **Backup** includes a user-controlled **key-export step** — a DB backup
   without the key is unopenable, and the UI must say so.

## 6. Design system — PurpleShade theme

- Dark-first: deep purple-tinted surfaces (`#14101F` base), light mode
  mirror. Accent violet `#8B5CF6`, success `#22C55E`, warn `#F59E0B`,
  danger `#EF4444`.
- All design values live in `src/styles/tokens.css` as CSS variables;
  **no hardcoded colors/spacing/typography in components** (linted, §7).
- Money and figures always use tabular numerals (`.figure` class).
- One primary action per view. English UI text.

## 7. Quality gates — strictest, local only

No hosted CI is used. The local gate is the enforcement:

**`npm run verify` =**
`biome check` → `tsc --noEmit` → `node --test` → `cargo clippy --all-targets -- -D warnings` → `cargo fmt --check` → `vite build`

- **Biome:** recommended preset, all as errors, **plus `noExplicitAny`
  as error**; formatter (2-space, double quotes, semicolons) and
  organize-imports enforced — `biome check` covers all three.
- **tsc:** `strict` + `noUncheckedIndexedAccess`.
- **Rust:** clippy denies warnings; `cargo fmt --check`.
- **Pre-push hook** (`.githooks/pre-push`, enabled per clone via
  `git config core.hooksPath .githooks`) runs `npm run verify`.
  Red never gets pushed.
- **Token lint:** a script fails the build if hex colors / hardcoded
  spacing appear outside `tokens.css` (from P4 on).
- Every phase below has its own gate; a phase is done only when its
  gate is green.

## 8. Backup & same-network view

- **Backup:** zip (fflate) containing `{ app: "purple-memo", version,
  exportedAt, data }` + the `photos/` tree. Import rejects files not
  made by this app and upgrades by file version. The user saves the
  file wherever they want — there is no other backup.
- **Same-network view (P5):** a read-only snapshot endpoint on the LAN
  so the user's phone can view data on the same network. Single writer
  (the desktop), no sync engine, no merge logic.

## 9. In-app updates

Via GitHub Releases: `tauri-plugin-updater` + release workflow, owner
signing key as repo secret. (Release mechanics are detailed at P5.)

---

# Part B — Phase-by-phase build log

> The coding agent receives **one phase at a time**: that phase's scope +
> the matching Part A sections + its gate. Nothing else.

| Phase | Scope | Gate |
|---|---|---|
| **P0** Scaffold | Vite 8 + React 19 + TS 7 + Tailwind 4 + Tauri 2.12; `tokens.css`; logo in `public/brand/`; updater wiring; Biome + `.githooks/pre-push`; README with gate docs | `npm run verify` green |
| **P1** Encrypted DB core | SQLCipher via rusqlite, keyring key (mint-once, verify-before-use, WAL, FK on); 28-table schema; 9 IPC commands; photo save/read/delete; `settings` table | `cargo test` + `npm run verify` green |
| **P2** Data layer | Single Tauri driver; per-domain repositories; money lib (cents, cash-basis rule); crypto module (PIN hash/verify, vault AES-GCM); FTS search helper | unit tests green + `npm run verify` |
| **P3a** Notes + Journal | Notes CRUD, collections, tags, pin/archive, markdown editor+preview, FTS search; journal day entries + month grid | feature works E2E + verify |
| **P3b** Budget Tracker | Wallets, income/expense CRUD, categories, monthly/yearly views, expense limits + warnings, recurring payments | feature works E2E + verify |
| **P3c** Business + Loans | Jobs, shops, receivables, payables, history; paid-in-full → history + Business-category income; loans (lent/borrowed) + states | feature works E2E + verify |
| **P3d** Habits + Tasks + Shopping | Habit logs/streaks/week view; tasks + reminders + notifications; shopping lists | feature works E2E + verify |
| **P3e** Address book + Memories + Gallery + Vault | Contacts/channels/tags/birthdays; memories views; gallery; vault password setup + encrypted items | feature works E2E + verify |
| **P3f** Dashboard + Settings + More + PIN | Today-view dashboard; settings (theme, PIN + security question, vault pw, key export); lock screen + auto-lock + fallback flow | feature works E2E + verify |
| **P4** Backup + polish | Export/import UI (in Settings); token lint; empty states; icon/pass; full design review vs §6 | verify + design checklist |
| **P5** Share + updater | Same-network read-only snapshot endpoint; GitHub Releases updater flow (signed) | E2E on LAN + verify |
| **P6** Pre-release audit | Full report-only audit (code, security model, gates); fix wave; release build | audit clean, release cut |

### Progress log (updated per phase)

| Phase | Status | Commit | Gate result | Notes |
|---|---|---|---|---|
| P0 | pending | | | |
| P1 | pending | | | |
| P2 | pending | | | |
| P3a | pending | | | |
| P3b | pending | | | |
| P3c | pending | | | |
| P3d | pending | | | |
| P3e | pending | | | |
| P3f | pending | | | |
| P4 | pending | | | |
| P5 | pending | | | |
| P6 | pending | | | |

*Status values: pending → in_progress → gate_pass / gate_fail → done.*
