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
- [ ] Notification scheduling + permission fallback proven on device
- [ ] Sensitive clipboard write proven on device
- [ ] Raw-IPC probe done (or explicit desktop-only isolation recorded)
- [x] Debug APK installs and launches; desktop regression build green (DB key
  comes from the platform key-store seam; `keyring` is desktop-only and never
  linked on Android)

**Exit gate:** documented contracts (including UID and first-pair adoption rules),
reproducible native build, encrypted vertical-slice prototype, no mock key path in
any personal-data build.

## Phase A — Secure encrypted vertical slice

- [ ] Mobile shell: bottom tabs (Dashboard|Tasks|Budget|Shopping|More),
  More sheet, Android back stack
- [ ] FAB speed-dial for creation only (Add Note, Add Task, Add Income,
  Add Expense, Add Shopping Item — habit check-ins live on Dashboard/Habits)
- [ ] Bottom sheets, safe-area insets, keyboard-aware layouts
- [ ] Real Keystore protection from the first personal record (never mocked)
- [ ] Lock/background: 1-min grace, FLAG_SECURE, cache eviction on pause
- [ ] Stable cross-device UIDs generated on record creation from day one
- [ ] Notes: view + create
- [ ] Tasks: view + create + mark done
- [ ] Shopping: view + create + toggle bought
- [ ] Mobile migrations run clean on a fresh install
- [ ] Repository-level tests for the three flows
- [ ] Search/dashboard show no excluded-module data (allowlist enforced)

**Exit gate:** offline create/toggle works; process death and background
lock pass; key loss fails closed; reset removes all owned state; desktop
`npm run verify` green.

## Phase B — Complete offline companion

- [ ] Dashboard: in-hand money (recorded balance) + tasks + pinned notes +
  today's habit check-ins
- [ ] Budget: wallet views + append-only entry forms (via FAB & Budget tab)
- [ ] Business: view + create jobs (no payment fields on mobile)
- [ ] Loans: view + create (no repayment fields on mobile)
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
