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
Add shopping item, Habit check-in. (Job / loan / vault-item creation lives on
their pages — less frequent.)

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

## 6. Phases

- **Phase A** — Android shell + the 10 sections rendering with real local data
  (platform seams stubbed/mocked); NDK/SQLCipher cross-compile proven.
- **Phase B** — Keystore, notifications/AlarmManager reminders, background
  behavior, clipboard auto-clear, camera/scope storage as needed.
- **Phase C** — LAN pair + subset sync (the §5 protocol).

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
3. **First pairing: empty-mobile bootstrap.** The phone starts empty and pulls
   from desktop. Guard: if the phone holds unsynced records at pair time,
   pairing is blocked until the user resets or exports the mobile data.
4. **Conflict policy per aggregate:**
   - Notes / Tasks / Shopping / Habits → field-level LWW.
   - Budget entries → mobile append-only (no edit/delete from mobile in v1).
   - Business / Loans → mobile create-only; job payments and loan repayments
     are desktop-only in v1.
   - Vault → one-way desktop→mobile, generation-aware (never mix password
     generations).
   - Conflict losers go to trash (Oct 26 rule); trash is extended beyond its
     current five types to hold budget/vault losers.

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
