# Android design review

Reviewed: 2026-11-01
Subject: [`ANDROID_DESIGN.md`](ANDROID_DESIGN.md)
Repository baseline: `2f6dbad` on `arena/30df859f-purplememo`
Scope: architecture, data model, security, sync, mobile reuse, phase order, and verification readiness. This is a review, not an implementation or a rewrite of the owner's design.

## Verdict

**Approve the product direction and Tauri reuse strategy. Do not approve the current document as an implementation-ready sync/security plan.**

A slim, offline-first Android companion is a good fit for this repository. The domain repositories, SQL discipline, integer-cent money model, Vault cryptography, design tokens, and extensive frontend tests are valuable assets. A Kotlin rewrite would duplicate too much of that for a one-person project.

However, three parts of the plan are not safe as written:

1. **Phase A stores real local data before real key protection exists.** Android key storage must be a prerequisite for personal data, not a Phase B polish item.
2. **`updated_at` + a sync watermark is not a correct two-way replication protocol.** The current schema lacks stable cross-device identities, causal versions, durable delete records, and atomic change capture.
3. **Field-level last-write-wins is unsafe for financial counters and Vault password rotation.** Those are transaction/group invariants, not independent fields.

The recommended order is: **Phase 0 contract/toolchain proof → Phase A secure encrypted vertical slice → Phase B complete offline companion → Phase C narrowly staged, failure-tested sync.** Keep the companion small, but do not treat sync as a small addition to ten finished screens.

“Desktop stays untouched” should mean **desktop behavior and data remain protected**, not “no shared files change.” Schema migrations, mutation instrumentation, platform adapters, capabilities, reset/backup policy, and source-contract tests will necessarily need behavior-preserving shared changes.

## Repository findings that shape the decision

| Area | What exists now | Consequence for Android |
|---|---|---|
| Frontend | React/TypeScript, 18 page components, eager composition in `src/data/app.ts`, desktop shell in `src/App.tsx` | Reuse domain code and tokens; build a separate mobile shell/pages rather than forcing the desktop shell through breakpoints. |
| Domain layer | Eight proposed feature repositories plus settings, trash, backup, share, and supporting libraries; parameterized SQL and batch transactions | Strong reuse candidate. Sync must hook the mutation boundary, not scrape UI state or compare whole tables by date. |
| Rust backend | 12 modules, 25 registered IPC commands, one mutex-protected SQLCipher connection, boot/reset/import barriers | Reuse the DB/lifecycle core, but add a mobile entry point and target-gated desktop integrations. Sync needs its own authorized command surface. |
| Schema | Version 6; 31 regular tables plus trigger-maintained `notes_fts`; local integer primary keys; forward-only migrations | Additive migration work is required for replication identities and metadata. Do not repurpose local IDs as network IDs. |
| Security | Random SQLCipher key in desktop credential store; separate app PIN; separate Vault password with per-item AES-GCM encryption | Three different secrets/locks must remain distinct. Android Keystore replaces the key-storage seam, not the Vault password or app PIN. |
| Native assumptions | Unconditional single-instance, updater, tray/window code; desktop-oriented plugins and capabilities; raw photo/backup/export IPC | Android is not merely a new bundle target. Native project, lifecycle, permissions, storage, and transport need explicit work. |
| UI | `src/styles/app.css` is 4,171 lines; shared modal has keyboard focus trapping but no Android-back contract | Reuse tokens/primitives selectively. Mobile navigation, sheets, keyboard/safe-area behavior, and touch access need their own acceptance tests. |
| Verification | 67 frontend test files; 854 frontend tests passed in this review; 192 Rust test annotations found | Good baseline, but Rust and Android/device execution were unavailable here. Existing tests do not prove replication or Android lifecycle correctness. |

The repository already contains Android launcher icons under `src-tauri/icons/android/`, but no generated Android project under `src-tauri/gen/android`. Icons are assets, not a mobile shell.

## Severity-ranked findings

### F1 — Critical: the proposed sync algorithm cannot preserve offline edits

**Evidence.** The design specifies per-record `updated_at`, a per-side last-successful-sync watermark, field LWW, and Trash for losers (`ANDROID_DESIGN.md:80–93`). Most current domain tables use `INTEGER PRIMARY KEY`; only `notes` and `vault_items` among the proposed core tables already have `updated_at`. Existing timestamps are local calendar dates via `todayLocal()` (`src/lib/dates.ts:49–52`), not causal versions. Deletes are physical deletes in several repositories, and some child rows disappear through foreign-key cascades.

**Why it fails.** Two devices can edit the same old row while offline; neither edit is newer than the last watermark in a way that reliably discovers it. Date-only timestamps tie, clocks skew, retries repeat, deletes vanish, and an interrupted apply can advance a cursor before all effects are durable. Local integer IDs also collide across devices and cannot identify the same wallet, list, habit, or job.

**Required before Phase C.** Define a versioned protocol with at least:

- stable record UIDs and explicit local-ID mappings, including foreign-key and link endpoints;
- device identity, operation identity, base version, and deterministic conflict ordering;
- a durable outbox written **in the same transaction** as the domain mutation;
- field versions or an operation log for genuinely independent fields, plus tombstones for records and cascaded children;
- idempotent, resumable apply with per-peer cursors and acknowledgements;
- schema/protocol negotiation, bounded batches, and a consistent initial snapshot;
- an explicit first-pair policy for two already-populated devices;
- a restore/reset generation policy so an old backup cannot replay stale authority.

A hybrid-log clock or vector/version metadata can help, but adding a timestamp column alone does not solve causality. Prefer a narrow operation protocol over a general-purpose CRDT framework. The test oracle should be “both devices converge without losing acknowledged operations,” not “the newest date won.”

### F2 — Critical: real Android key protection must precede real local data

**Evidence.** Phase A renders ten sections with real local data while platform seams are stubbed/mocked; Keystore moves to Phase B (`ANDROID_DESIGN.md:95–101`). Boot currently calls desktop `keyring` directly (`src-tauri/src/db.rs:94–213`), and reset deletes that credential last. The pinned `keyring` 4.2.0 default v1 implementation explicitly refuses Android; its Android store is optional, not an automatic fallback.

**Required change.** Introduce a platform key-storage seam and implement Android protection before accepting personal notes, money records, or Vault ciphertext:

1. Generate a random SQLCipher data-encryption key (DEK).
2. Wrap it with a non-exportable Android Keystore key using authenticated encryption.
3. Persist only the wrapped blob in app-private storage; unwrap natively at boot and zeroize transient plaintext key material where practical.
4. Fail closed on missing/corrupt key material. Never silently mint a replacement key over an existing database.
5. Define key-loss recovery, Android backup exclusion, factory reset, upgrade, and process-death behavior.

Do not use a hardcoded key, WebView storage, or a mock key store for real data. Mocks are acceptable only in an explicitly synthetic demo/test build that cannot be mistaken for the personal app. Hardware backing/StrongBox and user-authentication binding are owner decisions, not assumptions.

The app PIN is a UI/session gate; SQLCipher protects data at rest; the Vault password protects item plaintext. Opening the database before PIN entry is consistent with the current architecture, but the mobile threat model must say what a running compromised process can still access.

### F3 — Critical: financial and Vault groups cannot use independent-field LWW

**Financial evidence.** `recordJobPayment()` updates `paid_cents` and inserts an income entry in one batch (`src/lib/business.ts:466–499`). Loan repayment updates a stored `repaid_cents` counter under a local mutex (`src/lib/loans.ts:125–144`). A local mutex does not serialize two devices. Independent LWW can keep one counter value while both income entries survive, or lose one of two repayments.

**Vault evidence.** Items carry ciphertext/salt/IV; setup marker and verifier live in `settings`; password change re-encrypts every item and replaces the verifier (`src/lib/vault.ts:34–47, 241–255, 392–464`). Mixing an old item with a new verifier/password generation can make data undecryptable even though each field individually “won.”

**Required change.** Choose one of these policies per aggregate:

- **Recommended for v1:** desktop remains authoritative for existing job/loan payment fields and Vault contents/password generation. Mobile creates new jobs/loans if desired, appends new Budget entries, and looks up Vault items only.
- If mobile must edit those groups: use idempotent payment events and derived counters, or version the entire aggregate and apply it atomically. Vault needs a password-generation identifier and stale-write rejection/rotation handling.

Do not sum conflicting counters blindly or merge ciphertext fields independently. Conflict archives must retain ciphertext only for Vault and must be written in the same transaction as the winning apply.

There is also a scope contradiction: §2 says Vault is “lookup + copy,” while §4 says Vault-item creation lives on its page. Resolve it explicitly. **Lookup-only mobile Vault** is the safer first release.

### F4 — High: “the eight modules’ tables” is not a sufficient privacy allowlist

The full closure of the eight proposed modules is **20 domain tables**. A narrower first-release core can be **17** if Budget limits/recurring payments and Business payables stay desktop-only:

| Module | Narrow core tables | Optional full-module additions | Recommended v1 authority |
|---|---|---|---|
| Notes | `collections`, `notes` | — | Mobile create + view, matching §2; desktop edits existing notes. |
| Tasks | `tasks`, `reminders` | — | Mobile create/complete; reminder delivery state device-local. |
| Budget | `wallets`, `income_categories`, `expense_categories`, `income_entries`, `expense_entries` | `expense_limits`, `recurring_payments` | Desktop owns wallets/categories/corrections; mobile appends entries. |
| Business | `shops`, `jobs` | `payables` | Desktop owns shops and payment fields; mobile may create jobs. |
| Loans | `loans` | — | Desktop owns repayment fields; mobile may create loans. |
| Habits | `habits`, `habit_logs` | — | Desktop owns definitions; mobile toggles check-ins. |
| Shopping | `shopping_lists`, `shopping_items` | — | Shared list/item edits with tested ordering/toggle semantics. |
| Vault | `vault_items` | Selected `vault_setup`/`vault_verify` settings projection | Desktop → mobile only; lookup/copy, no setup or password change. |

This matrix is a recommendation for owner approval, not a silent change to the design. “Two-way on the subset” can still mean different write permissions per table/operation.

Do **not** synchronize whole `settings`, `links`, `trash_items`, `photos`, or `photo_refs` tables:

- `settings` mixes PIN/security material, drafts, tray preferences, notification preferences, and Vault verifier data.
- `links` can reference excluded Contacts/Journal/Memories entities.
- `trash_items` can contain snapshots of excluded modules and attachment references.
- Notes/jobs can reference photos even though Gallery is out of scope. Define whether attachments are omitted, shown as unavailable, or projected as metadata; do not leak excluded rows accidentally.
- `notes_fts` is derived and should rebuild locally, not replicate.

Search and Dashboard need the same allowlist. `SEARCH_CONTRACT` currently includes Contacts, Journal, and Memories (`src/lib/searchContract.ts:97–171`); filtering only the visible navigation is insufficient. Inbox, Trash, Exports, desktop backup, and key export are also outside the ten mobile sections and need an explicit “not exposed on mobile” decision.

### F5 — High: the Android shell is substantial shared/native work

**Evidence.** `src-tauri/src/main.rs` only calls the shared `run()`, which currently assumes desktop. `src-tauri/src/lib.rs:90–151` unconditionally registers single-instance, updater, notification, dialog, and desktop session chrome. `Cargo.toml` includes desktop-oriented plugins and `tray-icon`; `tauri.conf.json` enables updater artifacts; capabilities are not platform-split. `.gitignore:7` ignores all of `src-tauri/gen/`.

**Required work.**

- Add the Tauri mobile entry point and generate/curate the Android project.
- Target-gate tray, single-instance, updater, desktop window/restart behavior, and desktop-only plugins/dependencies/capabilities.
- Keep notification support where appropriate, but use mobile lifecycle and permission handling.
- Track the Android source project, manifest, Gradle configuration, and custom Kotlin/Rust bridges despite the current blanket `gen/` ignore. Exclude build outputs, local SDK paths, and signing material.
- Pin JDK, Android SDK/Build Tools, NDK, Rust toolchain, targets, minimum API, and ABIs. Upstream Tauri 2.12.3 declares Rust 1.90, while this package still declares 1.77.2; verify the actual compatible toolchain rather than trusting the old metadata.
- Prove SQLCipher/OpenSSL cross-compilation **and** encrypted open/create/migrate/reopen on a device, not just a successful link.
- Treat raw photo/backup/export transport as a separate adapter decision. The app's own contract says raw payloads are Android-unsupported (`src-tauri/src/commands.rs:26–33`; `src/data/ipc.test.ts:545–549`). Upstream Tauri documents raw IPC generally, so neither assume the comment proves current runtime behavior nor assume the desktop header/body path works unchanged. Probe it on the pinned Android runtime or keep those features desktop-only.

Desktop window dimensions are not a mobile blocker—Tauri ignores configured window size on mobile—but boot dialogs, tray assumptions, restart, filesystem paths, and permissions are real portability work.

### F6 — High: reminders, clipboard, and background locking need native lifecycle contracts

**Reminders.** Current reminders are standalone rows, not task-linked rows (`src-tauri/src/schema.rs:466–473`), and the current ticker runs in the WebView while the shell is live/unlocked (`src/lib/session.ts:343–405`). The plan must decide whether to add a task association or keep standalone reminders.

Evaluate the already pinned notification plugin before writing a custom scheduler. Its Android implementation uses AlarmManager, exact alarms when permitted, and inexact fallback otherwise; it also has boot/schedule restoration components. WorkManager is useful for deferrable reconciliation, not a drop-in exact-alarm replacement. Specify:

- notification permission and exact-alarm permission/fallback disclosure;
- reboot, timezone travel, DST/ambiguous local times, edit/delete/reschedule, and process death;
- whether reminder definitions sync but delivery state remains per-device;
- which device notifies, so two paired devices do not both fire or one suppresses the other;
- lock-screen privacy and behavior while the app is locked;
- Doze/OEM battery restrictions and an honest “best effort” delivery claim.

**Clipboard.** The pinned clipboard-manager 2.3.2 implementation lacks `writeSecret`; newer rolling upstream code adds sensitive-content marking. Verify a compatible release or implement the native seam. A ~30-second clear is best effort: it must not erase somebody else's later clipboard content, cannot guarantee execution after process death, and cannot erase IME/clipboard-history copies. Mark content sensitive, clear on resume when still owned, and describe the limitation in the UI. Vault copy is new mobile functionality, not existing desktop behavior to port unchanged.

**Background/lock.** Native pause/resume events must drive locking and cache eviction; WebView idle timers are insufficient. Define immediate versus grace-period locking, Vault key-cache and decrypted-state eviction, task-switcher screenshots, and `FLAG_SECURE` for sensitive surfaces. Reset must also remove wrapped keys, Keystore aliases, scheduled notifications, pairing credentials, and pending sync state—not just the desktop keyring slot.

### F7 — High: writable LAN sync needs a different trust model from LAN share

The existing share server is read-only HTTP with client-side decryption and a consent token for starting the listener (`src-tauri/src/share.rs`). It is not an authenticated writable sync API. “Same network” is not a trust boundary.

Required properties:

- one-time pairing that bootstraps pinned long-term device keys;
- authenticated encryption, replay protection, authorization, revocation, and re-pair after reset;
- a reviewed protocol/library rather than homemade cryptography;
- rate-limited, short-lived numeric fallback with explicit confirmation; a low-entropy code must not become a bearer password;
- server-side table/operation allowlists and schema validation—never expose arbitrary `db_execute` over LAN;
- listener lifetime tied to manual sync/lock/reset, with clear failure states;
- handling for AP isolation, hotspots, multiple interfaces, changing IPs, and interrupted transfers.

QR pairing introduces camera permission even though receipt/note camera capture is out of scope. Keep numeric/manual entry as a first-class fallback. The Dashboard's pending count should come from the durable outbox, not a timestamp watermark.

### F8 — High: backup, restore, reset, and migration are part of sync correctness

Backup format v4 replaces all 31 regular tables in one transaction (`src/lib/backup.ts:129–162, 819–848`). Adding replication columns/tables changes what a backup means. Peer credentials, cursors, delivery state, and device identity must not be copied blindly from one device to another.

Before enabling sync, define:

- which replication identities/history belong in the backup payload and which state is device-local;
- payload-version migration and compatibility with older backups;
- restore generation/epoch changes that invalidate or reconcile old peer cursors;
- whether restoring an old desktop backup re-deletes mobile records, resurrects tombstones, or requires re-pairing;
- how factory reset revokes peers and clears outbox/conflict archives;
- how interrupted migration/restore/reset recovers on next launch.

Do not let a restored old watermark decide that newer mobile edits are “already synced.” Keep schema migrations forward-only and test them against populated v6 databases and real backup fixtures.

### F9 — Medium: mobile UX and product claims need tightening

- **Separate shell/pages, shared domain.** The desktop shell and large pages are not a mobile layout with a narrower viewport. Reuse repositories, crypto, tokens, and small primitives; create mobile compositions and a mobile search/dashboard projection.
- **Navigation/accessibility.** Add Android back behavior for sheets, speed dial, editors, and tab history. Long-press cannot be the only route to an action; provide visible/menu alternatives. Use at least 48dp touch targets, safe-area insets, keyboard-aware sheets, focus management, TalkBack labels, and reduced-motion support. The plan's 44pt target is not an Android-native specification.
- **Speed dial wording.** “FAB → form in one tap” is actually two taps after opening the speed dial. Either accept the two-step flow or define a context-specific primary action.
- **Habits placement.** Habits is described as the most during-the-day feature but buried in More. Keep the five-tab decision if desired, but expose today's check-ins on Dashboard or reconsider the tab set after usage testing.
- **Money wording.** Wallet balances are derived from recorded income/expense entries. The current schema has no opening-balance or transfer model, and loan repayment does not automatically move wallet cash. Call the Dashboard figure **recorded wallet balance**, not verified “actual in-hand money,” unless those product gaps are separately designed.
- **Offline defaults.** Quick income/expense needs an existing wallet/category; shopping needs a list; habit check-in needs a habit. Define empty-state and first-run behavior instead of silently inventing financial classifications.
- **Settings scope.** Mobile Settings should expose only mobile-relevant preferences, lock/security, permissions, pairing, sync status, and diagnostics—not desktop tray, key export, or updater controls.

## Reuse boundary

| Reuse with tests | Adapt behind a seam | Build mobile-specific |
|---|---|---|
| Domain repositories and validation | Key storage, boot, reset, lifecycle | Bottom-tab shell and Android back stack |
| Integer-cent helpers and derived balances | Data driver composition and platform imports | Mobile pages/cards and quick-capture forms |
| Vault crypto primitives and cache invalidation | Notification scheduling and delivery state | Bottom sheets, speed dial, keyboard/safe-area handling |
| SQLCipher connection/transaction discipline | File/backup/export transport | Pairing UI and sync status/conflict views |
| Design tokens, icons, contrast tests | Capabilities and native permissions | Mobile search/dashboard allowlist |
| Existing source-contract and migration tests | Backup payload and restore generation | Device/lifecycle/failure-injection test harness |

Avoid importing the eager desktop `src/data/app.ts` composition wholesale into mobile if it constructs share/backup/gallery services that mobile must not expose. A mobile composition root can reuse the same repository factories with only the required ports.

## Owner decisions required before implementation

1. **First release write matrix:** approve the 17-table narrow core or the 20-table full closure, with per-operation authority. Recommended: append-only mobile Budget entries, desktop-owned payment counters, lookup-only Vault.
2. **Vault contradiction:** lookup/copy only, or also create/edit? Recommended: lookup/copy only for v1.
3. **First pairing:** empty-mobile bootstrap from desktop, or true merge of two populated devices? Phase A with real local data makes the latter mandatory unless explicitly restricted.
4. **Conflict policy:** which fields are independent, which aggregates are atomic, and where encrypted conflict history lives. Current five-type Trash cannot hold all proposed losers unchanged.
5. **Attachments/links:** omit, project metadata, or sync a bounded subset? Define excluded-module leak tests.
6. **Key/lock policy:** hardware backing, authentication binding, background grace period, screenshot protection, key-loss recovery, and Android backup exclusion.
7. **Reminders:** standalone versus task-linked; notifying device; wall-time versus instant semantics; exact-alarm fallback and privacy.
8. **Clipboard:** acceptable best-effort clearing language and compatible sensitive-write implementation.
9. **Pairing/security:** reviewed transport/protocol, numeric fallback, revocation, and supported network topologies.
10. **Restore/reset:** backup payload version, device-local state, restore generation, and re-pair rules.
11. **Mobile support envelope:** minimum Android API, ABIs, device matrix, APK signing/update channel, and rollback policy.
12. **Desktop compatibility:** accept behavior-preserving shared changes and require the existing Windows desktop gate plus populated-database migration tests.

## Revised phases and acceptance gates

### Phase 0 — Contract and feasibility proof

No personal data. Produce the approved write matrix, sync/restore/key contracts, and a pinned toolchain. Generate the Android project and prove on a device/emulator:

- mobile entry point and target-gated desktop plugins;
- SQLCipher create/open/migrate/reopen with a real wrapped DEK;
- Keystore wrap/unwrap, denial/loss handling, and reset;
- notification scheduling/permission fallback and sensitive clipboard write;
- raw-IPC probe or explicit desktop-only isolation;
- debug APK install/launch and desktop regression build.

**Exit gate:** documented decisions, reproducible native build, encrypted vertical-slice prototype, and no mock key path in a personal-data build.

### Phase A — Secure encrypted vertical slice

Build the mobile shell plus a small set of real flows (for example Notes, Tasks, Shopping), not ten mocked sections. Include real Keystore protection, lock/background behavior, Android back, sheets, safe areas, migrations, and repository-level tests.

**Exit gate:** offline create/edit/complete/reopen works; process death and background lock pass; key loss fails closed; reset removes all owned state; desktop tests remain green; no excluded-module data appears in search/dashboard.

### Phase B — Complete offline companion

Add the remaining approved sections, mobile Settings, reminders, clipboard, accessibility, performance budgets, empty states, signed APK distribution, and update/rollback documentation. Pairing UI may be prototyped, but writable sync stays disabled.

**Exit gate:** all approved offline flows pass on the supported device matrix; permission denial, reboot, timezone change, keyboard, TalkBack, and low-memory/process-death cases are covered; clipboard/reminder limitations are disclosed; signed install/upgrade is reproducible.

### Phase C — Staged sync, narrow first

Approve the protocol specification and failure-injection harness before UI completion. Start with Notes/Tasks/Shopping/Habits under the agreed write matrix; then add append-only Budget entries and create-only Business/Loans; add Vault last as a one-way, generation-aware ciphertext projection.

**Exit gate:** two populated devices converge; retries are idempotent; interrupted apply/reset/restore cannot lose acknowledged writes; tombstones and cascades propagate; financial counters reconcile; Vault never mixes password generations; revoked peers are rejected; desktop-only rows never leave desktop; backup/restore and migration fixtures pass.

Do not enable broad two-way financial or Vault editing merely because the narrow subset works. Each expansion needs its own invariant tests.

## Verification performed in this review

Environment: temporary Node `v24.19.0`, npm `10.9.8`. The system Node was 22 and conflicts with the repository's `engines.node >=24` plus `engine-strict=true`; this was an environment issue, not a project defect.

Passed individually:

- `npm ci --no-audit --no-fund` (manifests/lockfile unchanged);
- `node scripts/check-versions.mjs`;
- `npm run lint` (Biome, 179 files);
- `npm run token-lint` (164 files);
- `npm run typecheck`;
- `npm test` — **854 passed, 0 failed**;
- `npm run build` — Vite production build succeeded.

Not executed:

- full `npm run verify`: Rust tooling was unavailable and `core.hooksPath` was unset; Git configuration was not changed to force the gate;
- Rust tests, clippy, and fmt: no `rustc`/`cargo` in the review environment. The 192 Rust tests are source annotations, not executed results;
- Android build, NDK cross-compilation, APK signing/install, emulator/device tests, and real Keystore/notification/clipboard behavior: no Java, Android SDK/NDK, adb, or device was available.

The working tree was clean before this review document was added. No application code, schema, configuration, or original design document was modified.

## Upstream references checked

Checked 2026-11-01. Pinned tags are distinguished from rolling documentation.

- [Tauri v2 mobile entry point](https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/develop/calling-rust.mdx) and [Android prerequisites](https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/start/prerequisites.mdx).
- [Tauri v2 updater desktop-target pattern](https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/plugin/updater.mdx).
- [Tauri 2.12.3 runtime](https://github.com/tauri-apps/tauri/tree/tauri-v2.12.3): Android cfg support and mobile window-size behavior.
- [keyring 4.2.0](https://github.com/hwchen/keyring-rs/tree/v4.2.0): default v1 Android refusal; optional Android store is not the default.
- [notification plugin 2.6.0](https://github.com/tauri-apps/plugins-workspace/tree/notification-v2.6.0/plugins/notification): AlarmManager exact/inexact fallback and boot/schedule restoration; no exact-alarm permission in the plugin manifest.
- [clipboard-manager 2.3.2](https://github.com/tauri-apps/plugins-workspace/tree/clipboard-manager-v2.3.2/plugins/clipboard-manager): no `writeSecret`; rolling `plugins-workspace@v2` adds sensitive-content marking, which is not proof that the pinned release has it.

## Bottom line

Proceed with Tauri and a separate mobile shell, but treat **key protection, replication identity, aggregate atomicity, and restore/reset semantics** as design work that must finish before the corresponding implementation phases. The companion can stay small; its data-safety contract cannot be mocked.
