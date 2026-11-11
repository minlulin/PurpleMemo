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
- [x] Habits: 1-tap check-ins on Dashboard & Habits page — emulator proof:
  checking in on the Habits page showed checked + “Current streak (days): 1”
  and wrote `habit_logs` (2026-11-06, uid
  `40875a7c-12ed-4f08-bd3b-ca0bbcfb5900`); the Dashboard row then read
  checked; unchecking it on the Dashboard left 0 log rows and the Habits page
  read unchecked; after `am force-stop` + relaunch both surfaces read checked
  again. No add-habit control exists and the FAB has no habit action.
- [x] Vault: lookup + copy, clipboard auto-clear ~30s, UI disclosure —
  emulator proof: the locked list showed only the title (`Email login`, no
  secret rendered); a wrong password read “Wrong password — nothing was
  unlocked.”; the right password revealed `s3cret-8842!` beside a Copy button
  and the best-effort disclosure. Copy returned “clears in 30 s”; logcat:
  `sensitive clipboard set; will clear in 30000 ms` 11:02:03.886 →
  `cleared after 30000 ms` 11:02:33.889 (30.003 s), and the probe read returned
  the value and then `""`. The row is real AES-256-GCM material (40-byte
  ciphertext, base64 salt/iv) beside `vault_setup` + `vault_verify`; only
  Unlock / reveal / Copy controls exist — no create, edit, delete or
  change-password anywhere on the mobile Vault surface.
- [x] Mobile Settings: sync status, pairing UI prototype, permissions,
  lock/security, diagnostics (no desktop tray/key-export/updater controls) —
  emulator proof: SYNC read “Off. This phone is local-only: nothing leaves it,
  and there is no account to sync with yet.” The pairing block drew the QR
  placeholder and a live 6-digit code, and pressing “New code” left the
  `settings` row count unchanged (0 rows written) — nothing sent, nothing
  stored, no network call. PERMISSIONS read the OS: notifications “Allowed”,
  exact alarms “Not allowed. Reminders may arrive a few minutes late.” with the
  “Allow exact alarms” action; the row flipped to “Allowed. Reminders fire at
  the time you set them.” after `appops set … SCHEDULE_EXACT_ALARM allow` and
  back to “Not allowed” after `ignore`. LOCK & SECURITY reported “An app PIN is
  set. One minute in the background locks the app.”, the screenshot/recents
  block, SQLCipher + Android Keystore wrapping, and the key-loss ⇒ wipe ⇒
  re-pair rule. DIAGNOSTICS showed schema version **7**, database size
  **384.0 KB** (96 × 4096-byte pages) and Keystore backing **software** — the
  new `keystore_backing` command reads the wrapped blob's own header. Size
  needed the table-valued pragmas: under SQLCipher `PRAGMA page_size` reports
  `cipher_page_size` as a string, which read as `0 B` until fixed. No tray,
  key-export or updater control exists on this surface.
- [x] Reminders: creating device notifies; exact-alarm permission +
  inexact fallback disclosure — emulator proof: the Tasks page lists pending
  rows under the disclosure (“fires even when Purple Memo is closed … this phone
  schedules and notifies its own reminders; it does not receive the desktop's”).
  A reminder created through the form (`uid
  7f93f2b3-bc70-46b7-9ab7-bdc044b8701f`) logged `armed reminder … (exact)` with
  `exactAllowReason=permission` in `dumpsys alarm`; with the process killed
  (`am kill`) the alarm still fired — logcat `delivered reminder 2 at
  1793941560363` (11:36:00.363), a real notification posted on
  `purple_memo_reminders` (“Reminder due”), and the row read `fired=1` after
  relaunch. With the grant denied (`SCHEDULE_EXACT_ALARM ignore`) the bridge
  reported `exact=false` and armed `reminder 3 … (inexact)` with
  `window=+1m51s`. A cold boot re-armed the pending row: `re-armed 1 reminder(s)
  after boot` plus the 12:32 alarm back in `dumpsys alarm` at its original
  time, so reminders survive a reboot.
- [x] Accessibility: 48dp targets, TalkBack labels, reduced motion —
  measured on `emulator-5554` with a scripted audit of every interactive
  element on Dashboard, Tasks, Budget, Shopping, the More sheet, Notes,
  Business, Loans, Habits, Vault, Settings and the open FAB menu. Before:
  header/back/lock buttons **44dp**, More-sheet items **44dp**, list rows
  **44dp**, chips **~36dp**, FAB actions **~43dp**, “Try again” links
  **~19dp**, and every shared `.btn`/`.input` **35dp** (the desktop geometry).
  After the fixes: `.mobile-icon-btn` **48×48**, `.mobile-sheet-item`
  **48**, `.mobile-row` **48**, `.mobile-chip` **48**, `.mobile-fab-action`
  **48**, `.mobile-link-btn` **48**, `.mobile-shell .btn/.input` **48**;
  FAB **56×56** and tabs **60** were already above the floor. Under-48
  findings on the final build: **4**, all of them the raw 20dp checkbox glyph,
  which sits inside a 48dp `.mobile-row` label so the tap target is the row.
  TalkBack: enabled and bound on the emulator
  (`com.google.android.marvin.talkback/…TalkBackService`, `Bound services:
  {Service[label=TalkBack …]}`), and the WebView's accessibility tree (what
  TalkBack reads) exposes labels and state — e.g. Dashboard: `RootWebArea |
  Purple Memo`, `button | Lock workspace`, `button | Create something`,
  `navigation | Sections`, `button | Tasks`, `textbox | Quick capture`,
  `searchbox | Search`, `checkbox | Mark done: Morning walk [checked=false]`;
  locked: `heading | Purple Memo is locked`, `textbox | PIN`, `button |
  Unlock`, `button | Forgot PIN?`. Toggle labels now carry the record
  (`Mark done: {title}`, `Mark bought: {title}`) instead of a bare verb, in
  English and Burmese. Reduced motion: `settings put global
  animator_duration_scale 0` made `(prefers-reduced-motion: reduce)` match and
  every transition report `1e-05s` (the global 0.01ms rule), with
  `.mobile-shell`’s height transition switched off outright; back to `1` and
  the shell transition reads `0.12s` again.
- [x] Empty states + first-run (no wallet/category → guided, never invented) —
  **walked end to end on a fresh install (Session 6, `emulator-5554`)**. Setup was
  completed with genuine input events, never CDP value assignment: `pm clear`,
  launch, tap the PIN field, `input text` for PIN / confirm / question / answer,
  TAB to “Set PIN and continue”, ENTER. Proof the setup landed: the app left the
  form for the Dashboard, the next launch demanded the PIN, and the database read
  `PRAGMA user_version = 7` with `pin_hash`, `security_question` and
  `security_answer_hash` in `settings`, every data table empty and the five
  seeded wallets present. Every surface was then opened with real taps, and its
  empty state recorded verbatim:

  | Surface | Empty state shown on the fresh install |
  |---|---|
  | Dashboard | `RECORDED BALANCE 0.00` with the five seeded wallets at `0.00` — rows that exist in the database, nothing invented; `DUE TODAY` “Nothing due today.”; `PINNED NOTES` “No pinned notes yet.”; `TODAY'S HABITS` “No habits yet. Habits are created on the desktop.” |
  | Tasks | “Nothing due — enjoy it.”, then the REMINDERS disclosure (“Scheduled with this phone's own alarm clock … it does not receive the desktop's.”) and “No reminders yet.” above the add-reminder form |
  | Budget | “Entries are append-only on the phone: you can add a record here, but never edit or delete one.”; every seeded wallet reads `0.00` / “Tap for entries” |
  | Shopping | “No lists yet — create one below to start your shopping list.” beside `Create list` |
  | Notes | “No notes yet — create your first note.” beside `New note` |
  | Business | “No jobs yet. Add one here, or record it on the desktop — nothing is invented here.” |
  | Loans | “No loans yet. Add one here, or record it on the desktop — nothing is invented here.” |
  | Habits | “No habits yet. Habits are created on the desktop.” |
  | Vault | “There is no vault on this phone yet. Set up the vault password on the desktop, then come back — this screen never creates one.” |
  | Settings | no empty state to walk (sync, pairing, permissions, lock, diagnostics all populated): SYNC reads “Off. This phone is local-only …”, DIAGNOSTICS schema version `7`, Keystore backing `software` |

  No surface showed a bare list, a crash, a failing “Try again”, or a row from an
  earlier install; no balance was printed that the database does not hold. Honest
  caveats, recorded rather than smoothed over: the three Dashboard section
  placeholders (“Nothing due today.”, “No pinned notes yet.”) and “No reminders
  yet.” are terse — labelled rather than guided — and each sits beside a working
  create control (Quick capture, `New task`, the reminder form), so the copy was
  left as written rather than reworded in a verification session; and the
  “no wallet at all” branch cannot be reached on a fresh install because the
  schema seeds five wallets, whose zero balances are real rows, not invention.

  Harness note for later sessions: `adb shell input tap` did **nothing** while
  the first-run `GrantPermissionsActivity` (POST_NOTIFICATIONS) dialog sat on top,
  and again while a stale `InputMethod` window reported `mIsInputViewShown=true`
  with `mInputShown=false`. Taps only land once the dialog is dismissed
  (`pm grant … POST_NOTIFICATIONS` then BACK) and `dumpsys input_method` shows
  `mIsInputViewShown=false`; key events still reached the WebView throughout,
  which is what made the failure look like a React problem. CDP was used only to
  read text and geometry, never to write a value.

- [ ] Signed APK distribution + update/rollback documentation — docs written
  (`docs/ANDROID_DISTRIBUTION.md`: key creation, `key.properties`, the
  arm64-only release build, `apksigner verify`/`sha256sum` checks, the Redmi
  install checklist, the upgrade path and the lossy rollback). **The signed
  artefact was not produced**: the aarch64 release build aborts with a rustc
  ICE — `error: the compiler unexpectedly panicked. This is a bug` while
  compiling `icu_locale_core` 2.3.0 with `-C opt-level=s -C panic=abort`,
  rustc 1.95.0, NDK 27.3 clang linker (exit 101). There is also no release
  keystore on this PC and no `key.properties` (both gitignored and absent), so
  signing has to be set up before the first distribution. Left unticked: this
  needs a toolchain/scope decision, not a code fix in this session.
- [x] Writable sync stays **disabled** (pairing UI may exist, sync does not run)
  — re-proved on the final build: “New code” on the Settings pairing block
  left the `settings` row count at **5 → 5**, no key is exchanged and no
  network call is made. With the exact-alarm grant denied
  (`SCHEDULE_EXACT_ALARM ignore`) the bridge reports `inexact` and the Settings
  row discloses the delay; restoring `allow` reports `exact` again.

**Exit gate:** device-matrix pass; permission denial, reboot, timezone
change, TalkBack, low-memory/process-death covered; limitations disclosed;
signed install/upgrade reproducible.

**Phase B exit gate — PASSES EXCEPT THE SIGNED RELEASE APK (2026-11-07;
empty-state item closed in Session 6).** Only `emulator-5554` was
used (x86_64, software Keystore backing); everything below is emulator truth,
and the Redmi (arm64, TEE-backed Keystore, signed-APK install) has proved
nothing in this session.

- **Permission denial — PASS.** `SCHEDULE_EXACT_ALARM ignore` +
  notification-blocked: `reminder_exact_state` returns `inexact`, the Settings
  row says so, and reminders still arm (Session 4 measured the inexact window
  at `+1m51s`); the app keeps working. Restored to `allow` afterwards.
- **Reboot — PASS (Session 4, same alarm path).** Cold boot re-armed the
  pending row (`re-armed 1 reminder(s) after boot`) at its original time.
  This session changed no alarm code.
- **Timezone change — PASS with a caveat.** `persist.sys.timezone`
  Asia/Yangon → Asia/Tokyo moved the system clock (`Sat Nov 7 14:30 JST`) and
  every `reminders.remind_at` value was **unchanged**; no reminder was lost
  and no due time shifted. The WebView keeps its original zone for the life of
  the process (`Date` still reported GMT+0630) and follows the new one on the
  next launch — so a zone change needs an app restart before new reminders are
  read in the new zone. Not a data bug; worth a note in the release notes.
- **TalkBack — PASS** (see the Accessibility item).
- **Low-memory / process death — PASS.** Repeated `am force-stop` and the
  appops-driven kills throughout this session: relaunch always came back to the
  PIN screen, and after unlock the records and toggle states were intact (the
  earlier sessions' `done=1` rows survived; no crash in `logcat`).
- **Limitations disclosed — PASS.** Emulator software Keystore (`backing`
  reads `software` on Settings), inexact fallback and its delay, pairing
  prototype writing nothing, reminders being device-local, Vault clipboard
  clear being best effort: each is stated where the user meets it.
- **Signed install/upgrade reproducible — FAIL / BLOCKED** (see the Signed APK
  item: rustc ICE on the aarch64 release build, and no release keystore yet).

- **Empty states + first-run — PASS (Session 6).** Fresh install, setup
  completed through real input events, every surface walked and its guided
  empty text recorded verbatim (see the item above).

**Phase B is closed (2026-11-07).** MinLulin closed it on 2026-11-07:
Session 6 (`a02b5c9`), exit gate "PASSES EXCEPT THE SIGNED RELEASE APK",
gate FULL GREEN (TS 898 + Rust 196). The signed release artefact (Blocker 2,
a separate toolchain track) is parked as a **release-time item** — a rustc ICE
on the aarch64 release build and no release keystore yet, see
`docs/ANDROID_DISTRIBUTION.md` — and is **not** a Phase B gate item, so it no
longer holds the phase open.

## Phase C — Staged sync, narrow first

- [x] Protocol specification + failure-injection harness — **written
  2026-11-08, approved 2026-11-10** (approved by Muus on MinLulin's delegation —
  he asked Muus to approve it. The approval is of the spec as the working
  contract, with two recorded exceptions: §10.1's "and by a re-pair" wording is
  wrong and Wave 3 (D3) removes it; the restore-bumps-generation behavior is
  specified but not yet implemented in code — Session 2 carry-over, "Backup
  payload rules" item. The 6 pending harness invariants are unwritten tests,
  not spec gaps.) Spec: protocol v1 in
  `docs/ANDROID_SYNC_PROTOCOL.md`, superseding `ANDROID_DESIGN.md` §5 wherever
  they conflict (`updated_at` LWW + watermark replaced by Lamport version
  stamps and transactional cursors).
  **Harness:** `src/lib/sync/protocol.ts` (pure rules),
  `src/lib/sync/harness.ts` (two-peer simulator, fault injection, oracles),
  `src/lib/sync/harness.test.ts` (verdicts).
  **Injections implemented (9):** `mid-apply-kill`, `duplicate-delivery`,
  `clock-skew`, `conflicting-offline-edits`, `delete-vs-edit`,
  `cascaded-child-delete`, `revoked-peer`, `old-backup-restore`,
  `desktop-only-leak`. **Invariant tests pending on Stage 1's engine (6):** two
  populated peers converge; retry idempotent; interrupted apply loses no
  acknowledged write; tombstones propagate incl. cascades; revoked peer
  rejected; desktop-only rows never appear on the peer — each skipped with its
  reason and clause, never passing on a stub.
  **Open decision for MinLulin:** §13.1 `reminder-definition-owner` (Option A
  recommended: reminder definitions two-way, `created_by_device_id`, the
  creating device notifies). §13.2 (conflict losers → per-device local trash)
  is confirmed, not open.
- [x] Schema & storage work — **written 2026-11-08, storage tests green,
  engine not started** (schema **v8**, migration 7→8). Six device-local
  tables: `sync_state` (§1.2 device id, §4.2 Lamport counter, §1.3 last
  seq, §10 generation + re-pair flag), `sync_outbox` (§6.1–§6.2: op id,
  table + uid, stamp, field stamps, payload, base counter),
  `sync_outbox_delivery` (§6.5 per-peer acks), `sync_tombstones` +
  `sync_tombstone_acks` (§5.1–§5.4; a cascaded child gets its own),
  `sync_peers` (§6.4 cursors, §10.2 paired generation, §11.3 revocation).
  Plus nullable `reminders.created_by_device_id` — **pending MinLulin's
  §13.1 call, reversible, nothing wired to it**. Write path:
  `src/lib/sync/store.ts` returns batch statements, so an outbox row
  commits in the same transaction as its mutation (§6.1) and a cursor
  moves only inside the apply transaction (§6.4). Migration proof: an
  honest v7 fixture seeded across the 17 synced tables migrates to
  `user_version = 8` with every row and uid intact, and every new
  table/index matches a fresh baseline (Rust). Storage tests on real
  SQLite, no stubs (`store.test.ts`): atomicity both ways, seq/Lamport
  monotonic across pruning, tombstone survives a cascade, cursor
  honesty, acks prune only when every live peer acked, tombstone GC
  needs a peer, device id stable per install (a wipe mints a new one),
  restore bumps the generation and forces re-pair, allowlist refusal,
  §13.1 marker unread. The six engine invariants in `harness.test.ts`
  stay pending. Still open by design: nothing calls the store (no
  engine yet), and `applyBackup` does not bump the generation — that
  belongs to the "Backup payload rules" item.
- [x] Pairing & bootstrap — **written 2026-11-08; core, sealed envelope and
  LAN listener green, Stage 1 not started** (no QR rendering and no device
  run yet — see the last paragraph). CORE:
  `src/lib/sync/pairing.ts` — offer + QR payload (`purplememo-pair://v1`),
  6-digit code with a **120 s lifetime** and a **5-attempt lockout**
  (single-use; malformed input costs no attempt), key fingerprints for the
  on-screen comparison, hello admission in §7.1 order (revoked → unpinned →
  key mismatch → pairing id → protocol → schema → generation → stale pin),
  the §11.4 re-pair guard (refuses while the outbox owes writes unless the
  user discards), and a listener state that is idle except while pairing is
  open. Pins, revocation and re-pair are the Session 2 store statements
  (`pinStatements`, `revokePeerStatements`, `rePairStatements`; re-pair
  zeroes both cursors and drops the old pairing's acks). BOOTSTRAP:
  `src/lib/sync/bootstrap.ts` — `planBootstrap` counts snapshot / upload /
  alreadyKnown / desktopOnly with `deletions: []` always, uploads keep the
  phone's own UIDs (a second attempt uploads nothing), `batchSnapshot`
  honours 200 ops / 256 KiB and never splits an aggregate, `resumeAdoption`
  re-takes an interrupted snapshot (§8.4), `conflictLosers` archives only
  Notes/Tasks/Shopping with the "Conflict copy — kept on this device only"
  label, `adoptionSummary` is §9.3's plain count. TESTS (6 + 6, real SQLite
  from the shipped v8 DDL with real `sync_peers` rows, no stubs): redeem
  once → pin both sides → later hello admitted; expired / used / locked
  refusals; a revoked peer refused before any effect (no outbox or delivery
  row written); key / pairing / generation / protocol / schema refusals;
  re-pair zeroes cursors and clears the revocation; adoption keeps every row
  (counted on both sides) and uploads new UIDs only; bounded
  aggregate-safe snapshot; interrupted snapshot re-taken; trash only for
  **SESSION 4 (2026-11-08): the §11.6 library + framing choice is recorded
  in the spec (§11.6.1), and the QR path is built and proven** —
  `src/lib/sync/qr.ts` turns the offer into an SVG or RGBA pixels and decodes
  it back through `parseOffer` (`qrcode` 1.5.4, `jsqr` 1.4.0, `@types/qrcode`
  **SESSION 5 (2026-11-08): the envelope, the device keys and the listener are
  built and proven** — `src-tauri/src/envelope.rs` + `src/lib/sync/envelope.ts`
  implement one wire format (`{"header":{…},"body":"<hex>"}`, the header as
  AEAD associated data, a 24-byte nonce, lowercase hex) with `x25519-dalek` 2 +
  `chacha20poly1305` 0.10 in Rust and `@noble/curves` 2.4.0 + `@noble/ciphers`
  2.4.0 in TypeScript — two crates and one package, each a published primitive
  §11.6 names. **Cross-tested both directions on the exact bytes the other side
  produced**: `__fixtures__/envelope-from-ts.json` is opened by the Rust test,
  and `envelope-from-rust.json` is written by the Rust test and opened by
  TypeScript, so neither side proves itself against its own output. Refusals run
  on real bytes — flipped ciphertext, altered counter, altered nonce, a
  stranger's key, replay, foreign recipient, foreign sender, garbage — and each
  names its reason. The long-term keypair lives in `pairing_key.rs` over the
  key-store seam: keyring entry `pairing-identity-key` on desktop,
  `pairing-key.wrapped` with its own non-exportable Keystore alias (magic
  `PMPK1`) on Android; the secret is never serialized and never printable (its
  `Debug` shows the fingerprint), a stored value that is not a key fails closed
  instead of being replaced, and a factory reset deletes the slot so the next
  launch mints a new keypair and device id. The listener is
  `src-tauri/src/pairing_listener.rs`: `std::net` (a hand-rolled HTTP head on a
  `TcpListener` — `tiny_http` was never a dependency and the earlier line here
  said so wrongly), `POST /pair/hello`, a
  four-byte big-endian length-prefixed UTF-8 JSON body (the phone's half is
  `src/lib/sync/frame.ts`, pinned to the same `00000011` vector on both sides),
  admission in §7.1 order (revoked → unpaired → envelope version/recipient/
  sender/replay/tag → message-kind allowlist → pairing id → protocol → schema →
  data line), an ack sealed back to the peer, and **no effect on any refusal**
  (the only effect of an accepted hello is advancing the replay counter).
  Lifetime is a property of the socket, not a flag: `stop` joins the accept
  thread and then proves the port itself is refused — tiny_http frees the
  socket on its own thread, so the join alone proves nothing; the reset path is
  wired today, and the lock/background call sites arrive with the pairing
  panel — 14
  loopback tests prove an accept while open and a refused connection after
  stop, lock and reset. **Both interpretations settled 2026-11-08 (MinLulin
  delegated them to Muus; Session 5b implemented them):** (1) §11.6.1’s
  *ephemeral* X25519 is what the code now does — a fresh ephemeral keypair per
  message, combined with the static agreement through `HKDF-SHA256(dh_eph ||
  dh_static)`, `salt` = the pairing id and `info` = protocol + sender + receiver
  + pairing (Session 5b; the static-static deviation is gone, so no recorded
  gap remains); (2) a changed peer key is still refused as `unauthenticated`,
  accepted as implemented, because naming the presented key would mean
  accepting an unpinned envelope (§11.2). Added dependencies: `hkdf` 0.13.0
  (Rust, HKDF-SHA256 — already a transitive pin in `Cargo.lock`) and
  `@noble/hashes` 2.4.0 (TypeScript HKDF — already in the tree through
  `@noble/ciphers`).  **SESSION 6 (2026-11-09): the desktop panel and the phone’s entry are wired;
  the two-device run did not happen.** Q.1 — the desktop Settings has a
  Pairing section (`src/components/PairingPanel.tsx`, state in
  `src/lib/sync/pairingPanel.ts`) over four real commands (`pairing_local`,
  `pairing_open`, `pairing_close`, `pairing_status`): the offer is minted by
  `pairing.ts`, drawn from `qr.ts`’s matrix, and shown only while the listener
  is bound and the code is live; expiry, lock, app background and the panel
  closing all call `pairing_close`, which resolves only after the port refuses
  a connect (§11.5). The listener gained the code-confirmed rendezvous the
  spec describes in §11.1/§11.6.1 — `POST /pair/request`: the code gates the
  rendezvous only, the presented key is pinned for the window, the ack is an
  ordinary sealed envelope — **new wire surface, since §11.6.1 does not name
  the request message; MinLulin’s approval is required**. Q.2 — the phone’s
  pairing block is real (  `src/components/MobilePairingCard.tsx`, logic in
  `src/lib/sync/mobilePairing.ts`): camera frames decode through `jsqr` →
  `parseOffer`, a typed code goes through `redeemCode`, and each refusal is the
  module’s own wording. The camera path is **built and proven against a
  rendered QR fixture, not on a camera**. The phone’s sealed client **is built
  now** — `pairing_phone_pair` (Session 7 T1) sends the sealed request, opens
  the ack and answers with the sealed hello, so the card can pair for real;
  the sentence here that said the phone “cannot yet send its key” was true in
  Session 6 and is not any more. **Still open in this item: the two-device run
  (Q.3).** *(The paragraph that used to sit here said the emulator booted but
  no pairing could complete, because the phone had no sealed client and no
  adoption engine. That was true until Session 7 T1/T2 built both; it is kept
  only as the record of why Q.3 was open, and the two-device run is now the
  one thing missing.)*
  **SESSION 7 (2026-11-10): the snapshot transport is built on both sides; the
  upload and the two-device run are not.** T1 added `/pair/snapshot` to the
  desktop's listener (`pairing_listener.rs`, `pairing_snapshot.rs`,
  `commands.rs`): the snapshot is read once per window and held, admission is
  the SAME path the hello uses (no route can lose a check), and the batch
  budget is **30 KiB** of rows — not the 48 KiB this item first said, and not
  32 KiB, because `envelope::seal` hex-encodes: measured here, a full batch is
  30,660 bytes of plaintext → 61,641 sealed → **61,645 framed of 65,536**, and
  32 KiB of plaintext seals to 65,857 and is refused. Two tests pin that
  boundary. T2 added the phone's half — `request_snapshot` /
  `acknowledge_batch` / `acknowledge_snapshot` in `pairing_client.rs` behind
  `pairing_snapshot_request` / `_applied` / `_adopted` (the pin supplies the key
  and the data line; the webview supplies an address), and `pullSnapshot` in
  `mobilePairing.ts`: every batch is staged in memory with real sealed
  envelopes, then the **whole** snapshot is written in ONE transaction,
  parents-first with `<column>_uid` → `(SELECT id FROM parent WHERE uid = ?)`,
  and only then adopted. `bootstrap.ts`'s `rowBytes` now measures UTF-8 bytes
  (`TextEncoder`), because `.length` counted a Burmese letter as 1 where the
  wire pays 3. **Proof, and which half proved it:** T1's *serve* proof is the
  seeded-desktop test in `pairing_listener.rs` — **4 batches / 78 rows / 1
  tombstone** served and adopted with those exact counts, over loopback with
  real crypto. T2's *pull* proofs are separate and smaller: a 3-row pull and a
  250-row (2-batch) pull in Rust against a live window, and a 4-row / 3-batch
  pull in TypeScript against sealed envelopes it opens with its own keypair.
  **Not done:** the §9.1 upload (a phone's own records still do not reach the
  desktop, and the card says so), and the two-device run. **Wire surface
  approved 2026-11-10 (Muus's call on MinLulin's delegation):** the upload may
  add a `/pair/` route following the `/pair/snapshot` pattern — same `admit`
  path, same envelope, kinds `upload`/`uploaded` — detailed in the upload
  session prompt; no new surface beyond that without approval.
  **PHASE C SESSION 4 (2026-11-11): the two-device run was attempted on the
  real hardware and STOPPED before pairing — evidence, not a pass.** Built and
  installed: the aarch64 debug APK (arm64-v8a only; no other ABI in the
  archive) from dev HEAD `855b1ce`, on the Redmi `4c61bf7a`; the desktop ran
  from this dev clone (`npm run tauri dev`, `target\debug\purple-memo.exe`,
  window "Purple Memo"). The phone was a **fresh install** (no purplememo
  package present), so first-run setup was completed on it through real input
  events (PIN + recovery question); Settings then read **schema version 9** and
  Keystore backing **TEE**. The desktop panel minted a live window: code
  `846404` at `117 s left`, a rendered QR, and "Listening on
  `100.96.0.19:52608`". **Where it stopped:** that endpoint is the
  **CloudflareWARP** adapter's address — `share::lan_ip()` prefers
  `default_route_ip()`, the source address a UDP connect to 192.0.2.1:80 picks,
  so a VPN tunnel's default route wins over the LAN — and the phone cannot
  reach it (`nc -w 3 100.96.0.19 52608` → `nc: Timeout`). The real LAN address
  did not answer either (`nc -w 3 192.168.100.232 52608` → `nc: Timeout`) while
  the same phone reached its own gateway (`192.168.100.1:80`, rc=0) and ARP
  showed both devices behind one gateway MAC (`6c:eb:b6:aa:28:3f`); Windows
  already holds Allow/Public/TCP+UDP inbound rules for the exact dev binary
  (`...\src-tauri\target\debug\purple-memo.exe`). A **control listener** (a
  plain Node HTTP server on `0.0.0.0:8099`, `LISTENING`) showed the same
  `nc: Timeout` from the phone, so the failure is not specific to the pairing
  port: while CloudflareWARP is active on this Public-profile machine, no
  inbound TCP from the phone's WiFi reaches this PC at all — either WARP's
  filters or wireless/wired client isolation at the AP (`ZEN Mobile Service`,
  gateway MAC `6c:eb:b6:aa:28:3f` on both sides). Per the session rule (a wrong
  offer address is reported, never hand-edited) the agent did not pair; the
  owner then tried the phone's own entry by hand and could not complete it (see
  the entry defects below). Nothing was sent and nothing was adopted, so the
  desktop's records are unchanged. The panel was driven by screenshot-and-click on the window
  (WebView2's remote-debugging port never bound, so there was no CDP), and it
  then hit the shell's own lock ("Purple Memo is locked"; the listener closed
  with it, §11.5). The owner supplied the desktop PIN and the run resumed: a
  fresh window minted code `144866` on `100.96.0.19:55559`, and while that
  port was `LISTENING` the phone still timed out on both `100.96.0.19:55559`
  and `192.168.100.232:55559` while answering its gateway in the same breath.
  The run therefore stops at reachability, not at the offered address alone:
  the address is wrong **and** no inbound TCP from the phone reaches this PC.
  **Also observed on the way:** a never-paired desktop shows *"This
  device's pairing key is gone or unreadable"* with the confirmed replacement,
  because `identityRecovery` treats `present: false` as `needed`; and the panel
  shows no device id or key fingerprint of its own before a peer is staged, so
  the run's step 1 (record them "as the panel shows them") has no source on
  screen. **And the phone's pairing entry could not pair at all on that build,**
  independently of the network: *Scan the desktop's QR* answered *"This build
  cannot reach a camera here"* — `getUserMedia` was undefined because the
  generated manifest declared no `android.permission.CAMERA` — and the
  no-camera field is labelled *"Pairing code from the desktop"* while
  `usePastedOffer` runs `parseOffer`, so the six digits the desktop shows were
  refused with *"that is not a Purple Memo pairing code."* (`pairing.ts:327`,
  the `new URL()` catch). The six-digit entry that `redeemCode` serves only
  renders once `offer !== null`, and an offer existed only after a scan or a
  pasted `purplememo-pair://v1?…` URI — which the panel never displayed. So
  §11.1's "manual entry must remain first-class" was unreachable on that build.
  **Both halves are fixed and proven on the Redmi in the same session, after
  the run above was reported:** `AndroidManifest.xml` now declares
  `android.permission.CAMERA` (plus `<uses-feature android.hardware.camera
  required="false"/>`), which is the gate that hides `navigator.mediaDevices`;
  the existing `RustWebChromeClient` then asks for the runtime grant at scan
  time (with the grant revoked, `getUserMedia` brought up
  `GrantPermissionsActivity`), and tapping *Scan the desktop's QR* opened a live
  back-facing stream — `video` visible, `480×640`, track `camera 0, facing
  back:live`. The panel also prints the offer as selectable text under the QR
  with a *Copy pairing string* action (it selects the string when the clipboard
  is refused), and the phone answers a bare six digits with its own sentence
  instead of *"not a Purple Memo pairing code"* (`isBareCode` in
  `mobilePairing.ts`, EN + MY copy). The Q.3 two-device run itself still needs a
  network path the phone can reach.
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
