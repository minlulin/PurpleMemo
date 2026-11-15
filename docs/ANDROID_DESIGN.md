# Purple Memo — Android App Design

Owner decisions recorded 2026-11-01. Discussion-first: no build order yet.

## 1. What it is

A slim **companion** to the desktop app, not a full port. Its job is
**quick-capture and quick-view on the go**: jot a note, log income/expense,
check a task, tick a habit, check the shopping list at the market, look up a
password. Heavy work stays on desktop. Future modules can be added via updates.

## 2. Scope

**IN (8 modules + Dashboard + Settings = 10 sections):**

| Section | Mobile job |
|---|---|
| Dashboard | Landing page: actual in-hand money (sum of wallet balances), today's/urgent tasks, pinned/important notes preview |
| Notes | View + quick-add |
| Tasks | View, quick-add, check off; reminders |
| Budget | Money tracker: quick income/expense entry, wallet balances |
| Business | Jobs, quick-add |
| Loans | View, quick-add |
| Habits | Check-ins (the most during-the-day feature) |
| Shopping | Lists: what-to-buy vs already-bought, quick-add item |
| Vault | Password lookup + copy (clipboard auto-clears after ~30s) |
| Settings | Including manual Sync |

**OUT (desktop-only):** Gallery, Contacts (phone has native ones), Journal,
Memories. Rationale: the phone already covers contacts/photos natively;
journal wasn't worth the effort (a quick note covers it); vault earned its
place back because passwords are needed most when away from the desk.

## 3. Tech approach

**Tauri mobile**, sharing the existing codebase (React + TypeScript frontend,
Rust backend). Desktop stays untouched — the mobile target is additive.
Native (Kotlin) rewrite was considered and rejected: it would discard all
audited logic and double the maintenance surface for a one-person project.

### Platform seams (mobile-specific work required)

1. **Key storage** — desktop uses the OS credential store via `keyring`;
   Android needs **Android Keystore**. (Dropping the Vault *feature* does not
   remove this: the whole DB stays SQLCipher-encrypted.)
2. **Updater** — Tauri's updater doesn't support mobile. Distribution is
   sideloaded APK (and/or Play Store later); in-app update checks are desktop-only.
3. **No system tray** — close/background behavior needs a mobile design
   (Android back-gesture / task switcher semantics, not close-to-tray).
4. **Reminders** — the desktop tray ticker doesn't translate; Android Doze
   mode requires **AlarmManager / WorkManager** for reliable task reminders.
5. **Storage & camera** — scoped storage for any file access; camera capture
   for receipt/note photos is a natural later addition (not v1).
6. **SQLCipher on Android** — `bundled-sqlcipher-vendored-openssl` must
   cross-compile via the Android NDK; verify early in Phase A.

## 4. Design language & layout

**Same design language as desktop** (purple palette, typography, card/dialog/
button aesthetic) — one brand, no relearning. **Mobile-native layout:**

- **Bottom tab bar (5):** Dashboard | Tasks | Budget | Shopping | More
- **More sheet:** Notes, Business, Loans, Habits, Vault, Settings
- **Bottom sheets** instead of centered dialogs
- **Cards** instead of dense desktop tables
- **Long-press** instead of hover actions; touch targets ≥ 44pt

### FAB speed-dial (the mobile signature)

Floating button, expands to: Add note, Add task, Add income, Add expense,
Add shopping item. (Habit check-in lives directly on Dashboard and Habits page
as 1-tap toggles; Job / loan creation lives on their pages — less frequent.)

### Quick-capture principle

FAB → form in one tap → minimal fields only (the rest defaulted) → save.
Every flow must work fully **offline**; a sync-status indicator
(e.g. "3 changes to sync") lives on the Dashboard and in Settings.

## 5. Sync (refines the 2026-10-26 decision)

The Oct 26 decision was "two-way sync, both sides hold identical data." With
a subset mobile app this refines to: **two-way sync on the shared subset
only**, via a table allowlist (the 8 modules' tables). Desktop-only tables
never leave the desktop.

Unchanged from Oct 26: manual sync (no auto), QR pairing (LAN address +
one-time secret, numeric-code fallback), same-network only, no hosted relay.
Conflict rule: different records/fields → auto-merge; same field →
**last-write-wins, no prompt**; the losing version is written to trash
**before** overwriting. Requires per-record `updated_at` + a per-side
last-successful-sync watermark; device authentication via the pairing secret
is mandatory (write access, unlike the read-only LAN share).

## 6. Phases (revised per the design review — gated, no mocks with real data)

### Phase 0 — Contract and feasibility proof (no personal data)

Write matrix (§8), sync/restore/key contracts, pinned toolchain (JDK, Android
SDK/Build Tools, NDK, Rust targets, min API 26, arm64-v8a). Generate the
Android project and prove on a device/emulator: mobile entry point with
desktop plugins target-gated; SQLCipher create/open/migrate/reopen with a
real Keystore-wrapped DEK; Keystore wrap/unwrap, denial/loss handling, reset;
notification scheduling + permission fallback; sensitive clipboard write;
raw-IPC probe (or explicit desktop-only isolation); debug APK install/launch;
desktop regression build green.
**Exit gate:** documented contracts, reproducible native build, encrypted
vertical-slice prototype, no mock key path in any personal-data build.

### Phase A — Secure encrypted vertical slice

Mobile shell + a small set of real flows (Notes, Tasks, Shopping — not ten
mocked sections). Real Keystore protection from the first personal record,
lock/background behavior (1-min grace, FLAG_SECURE), Android back, bottom
sheets, safe areas, migrations, repository-level tests.
**Exit gate:** offline create/toggle works; process death and background lock
pass; key loss fails closed; reset removes all owned state; desktop tests
green; no excluded-module data in search/dashboard.

### Phase B — Complete offline companion

Remaining approved sections, mobile Settings, reminders (creating device
notifies; exact-alarm with fallback disclosure), clipboard auto-clear,
accessibility (48dp, TalkBack, keyboard-aware sheets), empty states, signed
APK distribution + update/rollback docs. Pairing UI may be prototyped;
**writable sync stays disabled**.
**Exit gate:** all approved offline flows pass on the device matrix;
permission denial, reboot, timezone change, TalkBack, process death covered;
limitations disclosed; signed install/upgrade reproducible.

### Phase C — Staged sync, narrow first

Protocol spec + failure-injection harness approved before UI completion.
Order: Notes/Tasks/Shopping/Habits under the write matrix → append-only
Budget entries + create-only Business/Loans → Vault last, one-way and
generation-aware. Each expansion needs its own invariant tests; never enable
broad two-way financial/Vault editing just because the narrow subset works.
**Exit gate:** two populated devices converge; retries idempotent;
interrupted apply/reset/restore cannot lose acknowledged writes; tombstones
propagate; counters reconcile; Vault never mixes generations; revoked peers
rejected; desktop-only rows never leave desktop.

## 7. Non-goals

Full desktop parity; auto-sync; cloud backup; multi-user; Play Store
release (sideload first). The desktop app is not to be destabilized by mobile
work — guard the working code.

## 8. Owner decisions (decided 2026-11-02, from the design review)

### Batch 1 — Sync core

1. **Write matrix: narrow 17-table core.** `expense_limits`,
   `recurring_payments`, and `payables` stay desktop-only in v1
   (configuration work, not quick-capture). The other 17 tables sync two-way.
2. **Vault: lookup/copy only on mobile (v1).** No item creation, no password
   change, no setup on mobile. (Resolves the §2/§4 contradiction.)
3. **First pairing: mobile bootstrap and adoption.** The phone pulls initial data
   from desktop. If the phone already holds offline-created records from Phase A/B,
   first pairing safely uploads them to desktop as new records (using their
   client-generated UIDs) without requiring a mobile data wipe.
4. **Conflict policy per aggregate:**
   - Notes / Tasks / Shopping / Habits → field-level LWW.
   - Budget entries → mobile append-only (no edit/delete from mobile in v1).
   - Business / Loans → mobile create-only; job payments and loan repayments
     are desktop-only in v1.
   - Vault → one-way desktop→mobile, generation-aware (never mix password
     generations).
   - Conflict losers go to trash (Oct 26 rule); trash is used for mutable
     entities (Notes/Tasks/Shopping). Append-only Budget and read-only Vault do
     not produce conflict losers in v1.

### Batch 2 — Security (decided 2026-11-02)

5. **Attachments/links: omitted on mobile.** Notes/jobs referencing photos
   show an "available on desktop" placeholder; links to excluded entities
   (Contacts/Journal/Memories) are not rendered. No leak surface.
6. **Key/lock policy:**
   - DEK wrapped by Android Keystore (non-exportable), hardware-backed
     (StrongBox/TEE) where available, software fallback otherwise.
   - App PIN on mobile, same setup flow as desktop, stored in mobile-local
     settings (settings do not sync).
   - Background lock grace period: **1 minute**.
   - **FLAG_SECURE** on the whole app (no screenshots anywhere).
   - Key loss → fail closed → wipe mobile data → re-pair from desktop
     (desktop is the source of truth).
   - App data excluded from Android auto-backup.
7. **Clipboard: best-effort ~30s auto-clear** with sensitive-content marking
   and an honest UI disclosure of the limitation.
8. **Pairing transport:** QR primary + numeric-code fallback (Oct 26),
   accepting the review's constraints as design requirements — pinned
   long-term device keys, revocation, rate-limited short-lived numeric codes,
   server-side table/operation allowlists, listener lifetime tied to
   manual sync/lock/reset.

### Interaction model refinement (his words 2026-11-02)

Mobile is **portable quick capture**: **view + add**, plus **mark-done
toggles**. Concretely:
- CREATE new records in all 8 modules.
- TOGGLE only: task done/undone, shopping item bought/unbought, habit
  check-in. No other edits from mobile in v1 (this narrows the earlier
  "field-level LWW" to single-field toggles, where LWW is safe).
- Conflict losers (toggles) go to trash per the Oct 26 rule.

### Batch 3 — Platform (decided 2026-11-02)

9. **Reminders:** standalone rows as the schema has them (no task-linked
   redesign). **The creating device notifies**; delivery state is
   device-local (no cross-device notification sync in v1). Exact-alarm
   permission requested, inexact fallback with honest UI disclosure.
10. **Restore/reset:** desktop is the backup/restore authority; mobile does
    no full backups in v1. If desktop restores an old backup, mobile cursors
    are stale → **re-pair required**. Pairing keys, cursors, and delivery
    state are device-local and never enter the backup payload.
11. **Support envelope:** min API 26 (Android 8.0), arm64-v8a only, new APK
    signing key, sideload first (Play later if wanted), rollback = reinstall
    the previous APK.
12. **Desktop compatibility:** behavior-preserving shared changes accepted;
    the Windows `npm run verify` gate must stay green; schema migrations
    tested against populated v6 databases and real backup fixtures.

### Cross-device UID contract (decided 2026-11-02, Session 3)

Applies to all synced tables (the 17-table narrow core); Phase A only needs
Notes/Tasks/Shopping/Habits identity, but the contract is defined once and reused
by Budget/Business/Loans/Vault when their sync stages arrive.

1. **Format.** UUID **v4** (random), canonical textual form `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`
   (lowercase, 36 chars incl. hyphens), stored as `TEXT`. Recommended over v7: v4 carries no
timestamp and no ordering semantics, which prevents it being misused as a cursor or ordering
key (see item 5); it needs no clock and no coordination; and both sides can mint it offline via a
CSPRNG (`crypto.randomUUID()` on the TS/web side, `uuid` crate on the Rust side). v7 is
acceptable in principle but rejected here to keep the identity value deliberately opaque.

   *Assumption (flagged):* column name is `uid TEXT NOT NULL UNIQUE` on each synced table,
distinct from any existing local integer primary key/rowid. Existing desktop rows are
backfilled with freshly minted v4 UIDs in a schema migration; mobile never observes a null
`uid`.

2. **Generation points.** Every synced record gets a UID **at creation time, on the creating
   client**, from Phase A onward - including records created offline with no pairing yet and
   records created on desktop. Concretely the 17 tables:
   `collections`, `notes`; `tasks`, `reminders`; `wallets`, `income_categories`,
   `expense_categories`, `income_entries`, `expense_entries`; `shops`, `jobs`; `loans`;
   `habits`, `habit_logs`; `shopping_lists`, `shopping_items`; `vault_items`.
   Desktop-only tables (`expense_limits`, `recurring_payments`, `payables`, and everything
   outside the 8 modules) do **not** get a cross-device UID. Tombstones also carry the UID of
   the deleted record.

3. **Uniqueness guarantee.** UUID v4 provides 122 random bits; with a CSPRNG on each device the
   probability of collision is negligible without any central allocator, counter, or
   coordination. Generation is fully local and works offline, so a phone can mint UIDs before
   it has ever paired.

4. **First-pair adoption.** Desktop accepts mobile-minted UIDs as **new records** at first
   pairing (upload as new entries, no mobile data wipe). Desktop inserts a row iff its `uid` is
   not already present; a repeated upload of the same `uid` is an **idempotent accept** (no
   duplicate, no error) and the existing row is left in place (reconciliation/field merge then
   follows the aggregate conflict policy). A coincidental UID collision between a mobile-minted
   and desktop-minted record is treated as the same record and resolved by LWW on
   `updated_at` per the conflict policy; in practice this cannot happen.

5. **What UIDs are NOT.** They are not sync cursors (cursors are per-peer high-water marks),
   not ordering keys (ordering stays on existing `created_at`/`updated_at` semantics), not
   user-visible (never rendered in UI), and not auth tokens. Conflict resolution remains LWW on
   `updated_at` per the Batch 1 conflict policy; the UID is identity only.

### Sync / restore / key contracts (protocol sketch, Session 3)

1. **Sync protocol sketch.**
   - **Trigger:** manual only (Settings -> Sync). No auto-sync, no background sync in v1;
     listener lifetime is tied to manual sync / lock / reset.
   - **Per-peer cursors:** each side stores a cursor per peer (last applied change position)
     in device-local state; cursors are never shared in the backup payload.
   - **Durable outbox:** every mutation appends to an outbox in the **same DB transaction** as
     the mutation; the outbox survives process death and retries until acknowledged.
   - **Tombstones:** deletes are represented as tombstone rows, including tombstones for
     cascaded children (e.g. a deleted collection cascades to its notes), and propagate
     idempotently. *Assumption (flagged):* tombstone GC happens only after all known peers
     have acknowledged them.
   - **17-table allowlist** with per-operation authority (Batch 1):
     - Narrow core two-way on shared subset: `collections`, `notes`, `tasks`, `reminders`,
       `wallets`, `income_categories`, `expense_categories`, `income_entries`,
       `expense_entries`, `shops`, `jobs`, `loans`, `habits`, `habit_logs`,
       `shopping_lists`, `shopping_items`, `vault_items`.
     - Desktop-only, never leave desktop: `expense_limits`, `recurring_payments`, `payables`,
       plus `settings`, `links`, `trash_items`, `photos`, `photo_refs`, `notes_fts`.
     - Authority: Notes/Tasks/Shopping/Habits toggles LWW; Budget entries mobile append-only;
       Business/Loans mobile create-only; Vault one-way desktop->mobile, generation-aware;
       Wallets/categories and reminder definitions desktop-owned.
   - **Operation allowlist:** only approved per-table operations cross the wire (no arbitrary
     SQL / `db_execute`); server-side schema validation on every apply.
   - **Pinned device keys + revocation:** revoked peers are rejected before any data flows.

2. **First-pair adoption flow.**
   1. Initiate pairing (QR primary, numeric-code fallback); devices exchange and pin long-term
      device keys; user confirms fingerprints.
   2. Desktop sends an initial snapshot of the 17 sync tables to mobile; mobile applies it
      transactionally (rebuild local state from snapshot).
   3. Mobile uploads offline-created records (those whose `uid` is absent from the desktop
      snapshot) as new entries, using their client-generated UIDs.
   4. Desktop inserts iff `uid` is new (idempotent accept); returns acknowledgements.
   5. Both sides initialize per-peer cursors to the post-adoption positions.
   - **Failure: pairing interrupted mid-upload.** Outbox retains pending uploads; on retry each
     `uid` is accepted idempotently, so no duplicate and no data loss.
   - **Failure: duplicate adoption attempt** (re-pair without prior wipe). Desktop treats
     already-present `uid`s as adopted and skips them; cursor state is reset and a fresh
     snapshot is re-applied. *Assumption (flagged):* if mobile holds unacknowledged writes at
     re-pair time, they are lost unless desktop already accepted them - mobile should push its
     outbox before any re-pair is initiated.

3. **Backup payload rules.**
   - **In:** user data (desktop backup covers all desktop tables; the 17 sync tables at
     minimum) + schema version.
   - **Never in payload (device-local):** pairing keys, per-peer cursors, delivery state,
     Keystore-wrapped DEK, app PIN / mobile-local settings, notification scheduling.
   - Mobile performs **no full backups in v1**.

4. **Restore + re-pair rules.**
   - Desktop is the backup/restore authority. Restoring an old backup on desktop replaces
     desktop data and bumps the data generation.
   - A generation bump invalidates mobile cursors => **re-pair required**. Mobile detects the
     stale generation and refuses to sync until re-paired; re-pair wipes/re-bootstraps mobile
     from the desktop snapshot.
   - Mobile does no full backups in v1.

5. **Key contract (summary only - implementation is a later Phase 0 session).**
   - DEK wrapped by Android Keystore (non-exportable), hardware-backed (StrongBox/TEE) where
     available, software fallback otherwise.
   - App PIN is mobile-local; same setup flow as desktop; settings do not sync.
   - Background lock grace period: 1 minute.
   - `FLAG_SECURE` on the whole app (no screenshots).
   - Key loss => fail closed => wipe mobile data => re-pair from desktop (desktop is source of
     truth).
   - App data excluded from Android auto-backup.
