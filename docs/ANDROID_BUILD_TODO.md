# Purple Memo Android — Build Progress Todo

Companion to `docs/ANDROID_DESIGN.md` (decisions) and
`docs/ANDROID_DESIGN_REVIEW.md` (risks). Check off as each item lands;
nothing moves to the next phase until its exit gate passes.

## Phase 0 — Contract and feasibility proof (no personal data)

- [x] Write matrix decided: narrow 17-table core, per-operation authority
- [x] Conflict policy decided: per-aggregate (toggles LWW, append-only,
  create-only, one-way Vault)
- [x] Key/lock policy decided: Keystore+HW, app PIN, 1-min grace,
  FLAG_SECURE, key-loss → wipe + re-pair, backup exclusion
- [x] Pairing transport decided: QR primary + numeric fallback, pinned
  device keys, revocation, allowlists
- [x] Support envelope decided: min API 26, arm64-v8a, sideload, rollback
- [x] Sync/restore/key **contracts written** (protocol sketch, backup
  payload rules, restore generation, re-pair rules, first-pair mobile record adoption)
- [x] Cross-device UID contract defined (UUIDs generated on record creation
  from Phase A onward so offline-created data is sync-ready)
- [x] Toolchain pinned: JDK, Android SDK/Build Tools, NDK, Rust targets
- [x] Android project generated and curated in git (despite `gen/` ignore;
  exclude build outputs, SDK paths, signing material)
- [x] Mobile entry point; tray / single-instance / updater / desktop window (updater plugin gating still open)
  behavior target-gated
- [x] SQLCipher + OpenSSL cross-compile via NDK proven
- [x] SQLCipher create/open/migrate/reopen with a real Keystore-wrapped DEK
  **on a device**: create, close, reopen after `am force-stop`, and reopen
  across an APK update all proven on the Redmi from the same wrapped blob. The
  5→6 migration itself was not replayed there: the only v5 artefact available is
  a `user_version` stamp on an already-v6 schema, and re-running the step
  correctly fails on `idx_notes_browse already exists` and rolls back. This is
  also the recorded proof that a failed migration never boots half-applied; a
  real v5 database is needed for the migration replay.
- [x] Keystore wrap/unwrap, denial/loss handling, reset proven on device:
  tampered blob and missing alias both fail closed with a named message and a
  full local wipe (no crash, no fallback key, no wrong-key decryption), and reset
  removes the blob *and* the Keystore entry. StrongBox is requested and refused
  on this phone, so the DEK is wrapped by a **TEE**-backed key.
- [x] Notification scheduling + permission fallback proven on device: real
  AlarmManager alarms (exact when the grant is held, `setAndAllowWhileIdle`
  otherwise) posted by a broadcast receiver with the app closed. Measured on
  the Redmi: an exact reminder fired **1.9 s** after its due time; with the
  exact-alarm grant denied (the phone's default) the same reminder fired via
  the inexact path **more than 65 s late**, and the Tasks page said so before
  it fired. A reboot drops every alarm, and the boot receiver re-armed the
  pending one (`re-armed 1 reminder(s) after boot`), which then fired — so
  reminders are carried, not lost. Delivery state is device-local: the app
  settles rows from the ids the phone reports as fired, so nothing is
  notified twice.
- [x] Sensitive clipboard write proven on device: the copy marks the clip
  `IS_SENSITIVE` (Android 13+ hides it from the copy preview), kept it for a
  measured **30.012 s**, then cleared it. Best effort, and the UI says so: when
  the app was killed before the timer, the value stayed on the clipboard (the
  test value survived force-stop + relaunch).
- [x] Raw-IPC probe done — see `docs/ANDROID_IPC_SURFACE.md`: every mobile
  command invoked on the device, and the tray / single-instance / updater /
  opener surfaces verified absent from the mobile build.
- [x] Debug APK installs and launches; desktop regression build green (DB key
  comes from the platform key-store seam; `keyring` is desktop-only and never
  linked on Android)

**Exit gate:** documented contracts (including UID and first-pair adoption rules),
reproducible native build, encrypted vertical-slice prototype, no mock key path in
any personal-data build.

## Phase A — Secure encrypted vertical slice

- [x] Mobile shell: bottom tabs (Dashboard|Tasks|Budget|Shopping|More),
  More sheet, Android back stack
- [x] FAB speed-dial for creation only (Add Note, Add Task, Add Income,
  Add Expense, Add Shopping Item — habit check-ins live on Dashboard/Habits)
- [x] Bottom sheets, safe-area insets, keyboard-aware layouts
- [x] Real Keystore protection from the first personal record (never mocked)
- [x] Lock/background: 1-min grace, FLAG_SECURE, cache eviction on pause
- [x] Stable cross-device UIDs generated on record creation from day one (emulator proof: note/task/shopping rows and seeded wallets all carry UUID-v4 UIDs; duplicate UID rejected by UNIQUE index)
- [x] Notes: view + create (emulator proof: explicit note form and Dashboard quick capture)
- [x] Tasks: view + create + mark done (emulator proof: task moved to COMPLETED and persisted)
- [x] Shopping: view + create + toggle bought (emulator proof: list/item created and bought state persisted)
- [x] Mobile migrations run clean on a fresh install (emulator proof: onboarding booted clean with PRAGMA user_version=7, 17 UID indexes, and five seeded wallets backfilled)
- [x] Repository-level tests for the three flows (npm run verify: JS 879 tests and Rust 196 tests)
- [x] Search/dashboard show no excluded-module data (SQL allowlist + emulator probe: journal/contact/memory rows excluded; note/task rows returned)

**Exit gate — PASS, 2026-11-05** (emulator `emulator-5554`, fresh x86_64
debug APK from `aba467b`):

- [x] **Offline create/toggle works.** A note, a task and a shopping item were
  created through the UI without a network; the task moved to COMPLETED and
  the item to bought. Read back through `db_query`: note `3982e797…`, task
  `212301c3…` (`done=1`), list `655fe677…`, item `42c8e8de…` (`done=1`),
  `PRAGMA user_version=7`.
- [x] **Process death passes.** `am force-stop` then relaunch landed on the
  PIN screen; after unlock the same UIDs and both `done=1` states were there —
  no data loss, no crash.
- [x] **Background lock passes.** HOME for 30 s resumed straight into the
  Dashboard; HOME for 75 s showed the "Session Locked" PIN screen. FLAG_SECURE
  is on the activity window (`fl=… SECURE …`), and `screencap` of the focused
  app was black (2,830 non-black pixels of 2,592,000 — the status bar only;
  704,243 when a system dialog sat over it).
- [x] **Key loss fails closed, both runs.** (1) Tampered `db-key.wrapped`:
  boot refused with *"the wrapped database key … could not be unwrapped (the
  wrapped key file is not a blob this build understands); the Android
  Keystore key that protected it is gone"*, wiped DB + WAL/SHM + blob + logs
  and the Keystore entry (`Keystore entry removed=true`), and stayed alive
  (pid 5054) with the wipe/re-pair sentence in `boot-error.log`.
  (2) Blob intact, alias removed from `persistent.sqlite` with `keystore2`
  stopped: boot named the missing key (*"the Keystore key
  purple_memo_db_key_wrap_v1 that wrapped the database key is gone"*), wiped
  the same surface (`Keystore entry removed=false`), stayed alive (pid 5388).
  Each following launch was a clean first run.
- [x] **Reset removes all owned state.** `factory_reset` with data present
  returned `"complete":true` — database/logs/keyring_key `removed`,
  share/photos/backups `already_absent`; no `purple-memo.db*`, no
  `db-key.wrapped`, no `boot-error.log` remained, and the Keystore alias row
  count went 1 → 0. The next launch was the first-run setup screen. (The
  surviving `app_webview/` and `cache/` dirs are platform WebView caches, not
  part of the reset contract; a grep for the test note's text found no
  personal data in them.)
- [x] **Desktop `npm run verify` green.** exit 0: lint, typecheck, JS 879/879,
  Rust 196/196, clippy, fmt:check and build.

Note: the emulator has no StrongBox/TEE, so its wrapping key is
`backing=software`; the Redmi's Phase 0 run was TEE-backed. Same code path,
weaker hardware.

## Phase B — Complete offline companion

- [x] Dashboard: in-hand money (recorded balance) + tasks + pinned notes +
  today's habit check-ins — emulator proof: one wallet with entries (1,200.00
  in, 200.00 out) showed **မှတ်တမ်းရှိ လက်ကျန်ငွေ / Recorded balance 1,000.00**
  and `Cash 1,000.00`; one task due today, one pinned note and one habit showed
  exactly those rows and no others; the task's mark-done and the habit's
  check-in both persisted across `am force-stop` + relaunch (`tasks.done=1`,
  `habit_logs` row with uid). No wallet → the guided empty state, not `0.00`
  invented as a balance.
- [x] Budget: wallet views + append-only entry forms (via FAB & Budget tab) —
  emulator proof: one income (500.00) and one expense (30.00) added through the
  FAB speed-dial, one expense (20.00) through the Budget tab; all three carry
  UUID-v4 `uid`s (0 NULL uids in either ledger table), and Cash moved
  1,000.00 → 1,450.00 exactly. No edit/delete control exists in the wallet
  entry list — only the append-only disclosure.
- [x] Business: view + create jobs (no payment fields on mobile) — emulator
  proof: one job (45,000.00, “Printer board repair”) created from the Business
  screen and one (18,000.00, “Outlet rewiring”) through the FAB speed-dial;
  both persisted across `am force-stop` + relaunch with UUID-v4 `uid`s,
  `paid_cents = 0`, `status = 'open'`, each showing its full total as
  outstanding. Only New job / Save job controls exist — no amount-paid field,
  no mark-paid action.
- [x] Loans: view + create (no repayment fields on mobile) — emulator proof:
  one lent loan (Daw Hla, 20,000.00) from the Loans screen and one borrowed
  loan (Ko Aung, 12,000.00) through the FAB; both persisted across process
  death with UUID-v4 `uid`s, `repaid_cents = 0`, direction and remaining
  balances intact. Form fields are direction, name, amount, due date — no
  repayment control exists on the mobile Loans surface.
- [ ] Habits: 1-tap check-ins on Dashboard & Habits page
- [ ] Vault: lookup + copy, clipboard auto-clear ~30s, UI disclosure
- [ ] Mobile Settings: sync status, pairing UI prototype, permissions,
  lock/security, diagnostics (no desktop tray/key-export/updater controls)
- [ ] Reminders: creating device notifies; exact-alarm permission +
  inexact fallback disclosure
- [ ] Accessibility: 48dp targets, TalkBack labels, reduced motion
- [ ] Empty states + first-run (no wallet/category → guided, never invented)
- [ ] Signed APK distribution + update/rollback documentation
- [ ] Writable sync stays **disabled** (pairing UI may exist, sync does not run)

**Exit gate:** device-matrix pass; permission denial, reboot, timezone
change, TalkBack, low-memory/process-death covered; limitations disclosed;
signed install/upgrade reproducible.

## Phase C — Staged sync, narrow first

- [ ] Protocol specification + failure-injection harness approved
- [ ] Schema & storage work: durable outbox (same transaction as mutation),
  tombstones incl. cascaded children, device identity, per-peer cursors
  (UIDs already established in Phase A)
- [ ] Pairing & bootstrap: QR + numeric fallback, pinned keys, revocation,
  re-pair; **first-pair adoption** pushes offline mobile-created records to
  desktop as new entries without data wipe
- [ ] Trash extended for conflict losers of mutable entities (Notes / Tasks / Shopping;
  no trash complexity for append-only Budget or read-only Vault)
- [ ] Stage 1: Notes / Tasks / Shopping / Habits sync
- [ ] Stage 2: Budget append-only entries + Business/Loans create-only
- [ ] Stage 3: Vault one-way, generation-aware (never mix generations)
- [ ] Backup payload rules: device-local state excluded; restore bumps
  generation and forces re-pair
- [ ] Desktop-only rows provably never leave desktop (leak tests)

**Exit gate:** two populated devices converge; retries idempotent;
interrupted apply/reset/restore cannot lose acknowledged writes; tombstones
propagate; counters reconcile; Vault generations never mix; revoked peers
rejected; backup/restore + migration fixtures pass.
