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
