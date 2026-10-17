# PurpleMemo — Final Pre-Public Review

**Date:** 2026-10-16 · **Repo:** `minlulin/PurpleMemo` (private) · **HEAD:** `06a9a435`
**Scope:** full review + audit of the Oct 15–16 remediation wave (13 commits) plus security-critical surfaces, data integrity, UI/pages, and docs-vs-code consistency.
**Method:** 4 parallel reviewers, report-only. Findings verified against current `main` file versions fetched via the GitHub API. The single P1 was independently re-verified by the reviewer (capability file + `tauri.conf.json` + call sites).
**Severity:** P1 = blocks public release · P2 = should fix · P3 = nit.

---

## Verdict

**All P1 findings are closed.** Backup export works again (P1-1) and the webview no longer holds a filesystem-write permission (P2-1); the doc P1s (P1-2…P1-7) are rewritten so the cleanup can delete the scratch docs with nothing left pointing at them. Everything else is P2/P3.

**Fix log**

| # | Status | Commit-level summary |
|---|---|---|
| P1-1 | ✅ **fixed** | Backup export rewritten to a Rust IPC command; `fs:write-files` deleted |
| P1-2…P1-7 | ✅ **fixed** | `docs/PLAN.md` / `§N` references removed from README.md and docs/RELEASE.md |
| P2-1 | ✅ **fixed** | Same change as P1-1 — the webview now holds **no** fs permission at all |
| P2-2 | ✅ **fixed** | `loadSecurity` returns its outcome; `shellStage` pins that a failed read never reaches PIN verification |
| P2-3 | ✅ **fixed** | Thumbnails decode with `imageOrientation: "from-image"` (the audit's `"fromImage"` would have thrown) |
| P2-4 | ✅ **fixed** | `createThumbUrlBook` owns every grid object URL; mutation-checked |
| P3-14 | ✅ **fixed** | The replacement write is atomic (temp sibling + rename), as required |

**No release blockers remain in code or docs.** Open before publishing: P2-8 (dead script), the five scratch-doc deletions, and the rest of the P2/P3 tier.

**Fix order:** ~~(1) P1-1 export fix~~ ✅ → ~~(2) P2-2 security-reload gate~~ ✅ → ~~(3) P2-3 EXIF orientation~~ ✅ → ~~(4) doc P1s (P1-2…P1-7)~~ ✅ → ~~(5) P2-4 object-URL leak~~ ✅ → (6) dead-script drop (P2-8); (7) delete the 5 scratch docs; (8) public.

### What the P1-1 fix does

`src-tauri/src/backup_file.rs` (new) · `commands::backup_save_file` · `driver.ts` `saveBackupFile` + `encodeHeaderPath` · `backupRepo.saveBackupFile` · `SettingsPage.doExport`

- **The write moved to Rust.** `backup_save_file` takes the archive as a raw request body (`photo_save`'s shape, not a JSON byte array) and writes it with `std::fs` — no fs plugin in the path at all.
- **Atomic.** Bytes go to a `<name>.purple-memo-tmp` sibling in the destination directory and are renamed into place, so a full disk or a crash mid-write cannot leave a truncated zip under a name the user trusts (closes P3-14). A failed rename leaves the temp file in place and says where it is, rather than deleting the only copy of the backup.
- **The destination travels in a header, percent-encoded.** A raw body IS the whole request, so the path has no argument channel — and header values must be visible ASCII while a path the user picked need not be (`C:\Users\小明\backup.zip`). `encodeHeaderPath` (driver.ts) ⇄ `decode_header_path` (Rust) is unambiguous because `%` is itself escaped. Both halves are pinned in `ipc.test.ts` and by `backup_file::tests::header_paths_round_trip`, which round-trips Windows, POSIX, spaces, non-ASCII and literal `%` paths.
- **Guards:** refuses an empty archive and a destination that is an existing directory.
- **Privilege dropped, not narrowed.** `fs:write-files` is gone from `capabilities/default.json`, `tauri_plugin_fs::init()` is gone from `lib.rs`, and so are `@tauri-apps/plugin-fs` from `package.json`/`package-lock.json` and `tauri-plugin-fs` from `Cargo.toml`. Nothing else used the plugin (verified: `writeFile` had exactly one call site). The webview's filesystem authority is now nil, where before it was "every write command on every path" — a strictly *smaller* surface than a scoped allow-list, because no allow-list can express "wherever this one save dialog points".
- **Regression-pinned.** `ipc.test.ts` fails if any `fs:` permission reappears in the capability, if the plugin is re-registered, re-declared in `Cargo.toml`, or re-imported in the driver.

Gate: `npm run verify` green — **286/286** TS tests, **92/92** `cargo test` (74 → 92 over this wave), clippy `-D warnings`, `cargo fmt --check`, `vite build`.

**Residual (accepted, not a finding):** the destination path still crosses from JS, so the command is reachable by a compromised webview as an arbitrary-path write — the same residual `db_key_save` has always had. Closing it entirely means opening the save dialog inside Rust and never returning the path to the renderer. Not done here: it is a larger change than the release blocker warrants, and it needs the `db_key_save` key export to move the same way to stay consistent.

---

## P1 — blocks public release

### P1-1 — Backup export fails: `writeFile` is denied by the fs scope — ✅ FIXED

> **Fixed.** See "What the P1-1 fix does" above. The root cause and the original analysis below are kept for the record.

**Files:** `src/pages/SettingsPage.tsx:189-195` (backup export) · `src-tauri/capabilities/default.json:10` · `src-tauri/tauri.conf.json`

M-03 (commit `278b4623`) replaced the blob-anchor download with `save()` (native dialog) → `writeFile(path, bytes)` from `@tauri-apps/plugin-fs`. The capability grants only the bare `fs:write-files` permission set, which per the plugin's own `write-files.toml` "enables all file write related commands **without any pre-configured accessible paths**". The effective fs scope is built solely from `allow` entries in the capability plus `plugins.fs.scope` in `tauri.conf.json` — **neither exists** (verified: capability has no `allow` entries; `tauri.conf.json` `plugins` contains only `updater`).

Result: `scope.is_allowed()` is false for every path, so `writeFile` always throws `PathForbidden` (release) / "forbidden path" (debug), landing in `setError`. The dialog itself works (`dialog:default` is granted). **There is no folder the user can pick that works.** The gate (`npm run verify` → `vite build`) cannot catch this; it only manifests on desktop.

**Key export is NOT affected.** It uses `settingsRepo.saveDatabaseKeyFile(path)` → `db_key_save` Rust IPC command → `db::save_db_key_file()` (`db.rs:178`), which writes via `std::fs::OpenOptions` directly. This completely bypasses the fs plugin permission system and works correctly.

**Fix (follow the codebase's own H-7 precedent):** stop using plugin-fs for this. Add a small Rust IPC command (e.g. `backup_save_file(path, bytes)`) that takes the bytes as a raw body like `photo_save` does, writes atomically via temp+rename (see `photos.rs::write_atomic`), and drop `fs:write-files` from the capability entirely. A static scope cannot work here — any fixed dir is too narrow for a free-choice save dialog, and `$HOME/**` is meaninglessly broad. This fix simultaneously resolves SEC-01 below.

Note P3-14: the replacement write must be atomic — `writeFile` is a single non-atomic write, so a disk-full mid-write would leave a truncated zip.

### P1-2 — README.md:8-9 links to `docs/PLAN.md` (slated for deletion) — ✅ FIXED
**Fixed.** The paragraph pointed at `docs/PLAN.md` *and* leaked the internal process ("The coding agent works one phase at a time from that plan"). Replaced with what a public reader actually needs — one line pointing at `## Development` and `docs/RELEASE.md`, the one doc the cleanup keeps.

> "The full build plan lives in [`docs/PLAN.md`](docs/PLAN.md) — main plan plus a phase-by-phase build log. The coding agent works one phase at a time from that plan."

After cleanup this 404s, and "The coding agent works one phase at a time" leaks internal process into the public README. Rewrite/remove the paragraph.

### P1-3 — README.md:40 "see §7 of the plan" — ✅ FIXED
Was: `Rules of the gate (see §7 of the plan for the full rationale):` → now `Rules of the gate:`. The bullets that followed carry the rationale on their own.

### P1-4 — README.md:43 "Keep the Progress log's gate column in `docs/PLAN.md` current" — ✅ FIXED
Was: `…revert. Keep the Progress log's gate column in [docs/PLAN.md](docs/PLAN.md) current as the local evidence for the gate.` → now `…revert — the gate's own output on your machine is the evidence.` No link, and no instruction to maintain a log that will not exist.

### P1-5 — README.md:50 "see §9 of the plan and `docs/RELEASE.md`" — ✅ FIXED
Was: `see §9 of the plan and [docs/RELEASE.md](docs/RELEASE.md) for the exact procedure` → now `see [docs/RELEASE.md](docs/RELEASE.md) for the exact procedure`. The RELEASE.md link was fine and is kept.

### P1-6 — docs/RELEASE.md:5 "The local gate (§7)" — ✅ FIXED
Was: `The local gate (§7) must be green` → now `The local gate (\`npm run verify\`) must be green`. Naming the command is more useful to a public operator than a section number that will not exist.

### P1-7 — docs/RELEASE.md:34 "(§3 rule 1)" — ✅ FIXED
Was: `1. **Dependency re-check** (§3 rule 1): confirm every pinned version…` → now `1. **Dependency re-check**: confirm every pinned version…`. The rule itself (max stable only) is stated in full in the sentence after the colon.

**Verified after the rewrite:** `README.md` and `docs/RELEASE.md` — the only two files the cleanup keeps — contain **zero** references to `docs/PLAN.md`, `SESSION_MEMORY.md`, "Progress log", or any `§N` section reference. The cleanup can now delete the five scratch docs with nothing left pointing at them.

---

## P2 — should fix

### P2-1 — `fs:write-files` gives the webview unrestricted file write (SEC-01) — ✅ FIXED
**`src-tauri/capabilities/default.json:10`**
Same root cause as P1-1, viewed as privilege scope: the permission set covers write/create/copy/remove/rename/truncate on any path the process can write. Only one legitimate use existed (the backup `writeFile`), and that use is now a Rust IPC command. The permission, the plugin registration, the JS package and the Rust crate are all deleted — the webview holds no filesystem permission of any kind. Pinned by `ipc.test.ts`.

### P2-2 — Unlock swallows a failed security reload, resurrecting the stale-PIN-hash bug — ✅ FIXED
**`src/App.tsx` (was `:300-310`) · `src/lib/appLock.ts`**
`loadSecurity()` catches errors into `setBoot({ error })` and returns void; `handleUnlock`/`handleSetupDone` then call `setUnlocked(true)` unconditionally. Once unlocked, the `!unlocked && boot.error !== null` branch is skipped — the error is invisible AND the shell keeps the stale `boot.pin` trust root. Concrete case: forgot-PIN reset writes a new `pin_hash`, then `loadSecurity()` fails transiently → next lock verifies against the OLD hash (rejects new PIN, accepts old). Fix: gate `setUnlocked(true)` on reload success (return boolean from `loadSecurity`), or surface `boot.error` while unlocked.

**Both halves done.**

- **`loadSecurity` now returns a `SecurityReload`** (`{ok: true} | {ok: false, error}`) instead of `void`. The entry decision travels *with* the result, so a caller cannot read the new state and then set `unlocked` from some other notion of success — the exact shape of the original bug. `reloadOpensEntry()` is the gate; `handleUnlock` and `handleSetupDone` are now one `enterWorkspace` that returns early on a failed reload.
- **The screen order is a pure, tested function.** `shellStage({ready, unlocked, error, pin, answerHash})` replaces the implicit JSX branch order. The invariant it pins: **`error` is checked before `lockGate`,** so a pending failure can never resolve into "verify the PIN against `boot.pin`" — whatever hash the shell happens to be holding. That is the whole security property, and it can no longer be lost to a reordering of the JSX.
- **The stale hash is also never *used***: `boot.error` is cleared in exactly one place (the success arm of `loadSecurity`), and with it set, `boot.pin` is unreachable.
- **A mid-session failure is announced, not swallowed** (`showReloadWarning` + a `role="alert"` banner in the workspace). This was the second half of the finding: `SettingsPage.onChanged()` also calls `loadSecurity`, so a failed theme write was completely invisible before. The open session is deliberately *not* ejected — a hiccup while changing the theme must not cost the user their place — and the failure stays armed, so the next lock lands on the error screen.

Tests: 5 new in `appLock.test.ts`, including the exact regression (a failed read is never resolved into a PIN check, for all three `PinState` shapes) and "a failed read stays armed for the next lock".

Gate: **291/291** TS tests (286 → 291), 92/92 `cargo test`, clippy `-D warnings`, fmt, build.

**Follow-on (not a new finding):** P3-7 — the error screen still has no Retry, so a transient settings-read failure now ends in "Restart Purple Memo". That was already true for a boot-time failure; P2-2 just made it reachable mid-session too. Fixing P3-7 is the natural pairing.

### P2-3 — Thumbnails ignore EXIF orientation (visual regression) — ✅ FIXED
**`src/lib/thumbs.ts:44`** — `createImageBitmap(blob)` defaults to `imageOrientation: "none"`; phone photos with EXIF orientation 6/8 render rotated 90°/270° vs the full image (`<img>` applies EXIF via `image-orientation: from-image`). The `Image`-fallback path already produces EXIF-oriented bitmaps — internally inconsistent. Fix: `createImageBitmap(blob, { imageOrientation: "fromImage" })`.

**Fixed, with one correction to the suggested fix.** The review's `"fromImage"` is not a member of the WebIDL `ImageOrientation` enum — the value is **`"from-image"`** (hyphenated, like CSS `image-orientation`). Passing the camelCase spelling makes the browser throw a `TypeError` out of the decode, which would break *every* thumbnail rather than just the rotated ones. The constant is `THUMB_IMAGE_ORIENTATION = "from-image"`, typed against the DOM `ImageOrientation` union, and both the call shape and the spelling are pinned by tests that read the module source (the same trick `ipc.test.ts` uses) — `node --test` has no `createImageBitmap` to observe directly.

Existing thumbnails keep their stored rotation until each photo is re-thumbnailed (thumbs are derived data, regenerated lazily per tile, so this is self-healing in practice).

Tests: 2 new in `thumbs.test.ts`. Gate: **293/293** TS tests, 92/92 `cargo test`, clippy, fmt, build.

### P2-4 — Object-URL leak on every "Add photos" batch — ✅ FIXED
**`src/pages/GalleryPage.tsx:121`** — `loadThumbs` rebuilds the URL map; the cleanup loop only revokes old URLs whose id is *absent* from the new map, so pre-existing photos get new URLs while old ones leak (~30 kB each, unbounded over bulk imports). Fix: revoke the previous URL before overwriting the entry.

**Fixed structurally, not by patching the loop.** The page kept a bare `thumbsRef` and revoked inline in three places (grid reload, single delete, unmount), which is why the rule was easy to get wrong. `createThumbUrlBook` (`src/lib/gallery.ts`) now owns every grid object URL:

- `swap(next)` revokes every previously-tracked URL **except any URL still present in `next`**, then adopts `next` as the only live set. That rule is correct in both directions: the leak (a photo still in the grid gets a second URL and keeps the first) is closed, and a URL the grid still points at can never be revoked — which the old `!next.has(id)` test did not guarantee.
- `drop(id)`, `clear()` (unmount) and `revokeAll()` (a cancelled mid-flight load, whose URLs the book never adopted) replace the three ad-hoc loops.
- `swap` copies the map it is given, so a caller mutating its own map afterwards cannot smuggle an untracked URL into the live set.

Tests: 5 new in `gallery.test.ts`, driven by a counting `create`/`revoke` stand-in because `URL.createObjectURL` needs a document. **Mutation-checked**: restoring the old `if (!next.has(id))` logic in `swap` makes `swap revokes the previous set even when the photo is still in the grid` fail.

Gate: **298/298** TS tests (293 → 298), 92/92 `cargo test`, clippy, fmt, build.

### P2-5 — `save_thumb` can't replace a thumbnail on Windows
**`src-tauri/src/photos.rs:148`** — calls `write_atomic(..., replace=false)`; the module's own docs state "`rename` overwrites on Unix but not on Windows." Re-saving a thumb fails on Windows (the dev platform where `npm run verify` runs `cargo test`), contradicting the `thumb_save_read_delete_roundtrip_and_sibling_cleanup` test. Thumbs are derived data — use `replace=true`.

### P2-6 — The user-facing discard path is untested
**`src/lib/drafts.test.ts` vs `src/pages/NotesPage.tsx:406`, `src/pages/JournalPage.tsx:131`** — store helpers are covered, but `handleDiscardDraft`, the `draftSeqRef` invalidation, the `touchedRef` race guard, and the "keystrokes during save" path have zero coverage. For a never-lose-text feature, the destructive path needs a test.

### P2-7 — 170 `(§X)` plan-section refs in code comments across 37 files will dangle
e.g. `(§2.9)`, `(§8)`, `(§5.4)` in `src/` and `src-tauri/src/`. Harmless at runtime; a public reader following "§2.9" finds nothing. Options: accept as historical, or strip in the cleanup pass.

### P2-8 — `scripts/reset-session-memory.mjs` becomes dead once `docs/SESSION_MEMORY.md` is deleted
Delete the script **and** the `session:reset` / `memory:reset` entries in `package.json` (nothing else references it — not in the verify chain, not in `.githooks/pre-push`).

### P2-9 — Missing Edit and Delete escape hatches across Business & Budget (2026-10-17 audit)
**`src/pages/BusinessPage.tsx`, `src/lib/business.ts`, `src/pages/BudgetPage.tsx`, `src/lib/budget.ts`**
In single-person day-to-day use, a typo on an entry becomes permanent when a module has no update or delete path:
- **Business Jobs (`BusinessPage.tsx:314-565`, `business.ts:95-155`):** `business.ts` has no `updateJob` or `deleteJob`, and neither `JobsView` nor `HistoryView` offers Edit or Delete. A mistyped customer job amount or test job can never be corrected or removed — it permanently inflates `Total Receivable` on the Dashboard and customer vouchers.
- **Business Payables (`BusinessPage.tsx:666-890`, `business.ts:241-295`):** `business.ts` has no `updatePayable` or `deletePayable`, and `PayablesView` has no Edit or Delete controls. A mistyped supplier payable sits in `Supplier Payables` forever unless marked paid (which books a false expense entry in Budget).
- **Budget Recurring Payments (`BudgetPage.tsx:860-1060`, `budget.ts:235-313`):** Recurring rules can be paused/resumed, but cannot be edited (`updateRecurring`) or deleted (`deleteRecurring`).
- **Budget Wallets & Categories (`BudgetPage.tsx:104-302`, `budget.ts:138-183`):** Wallets and income/expense categories can be added in `ManageView`, but cannot be renamed or deleted (when unused).
- **Budget Transaction Kind Toggle (`BudgetPage.tsx:582-607`):** In `EntriesView`, the Income/Expense toggle buttons are disabled while editing (`disabled={editing !== null}`), forcing delete + re-create if an expense was accidentally logged as income.

### P2-10 — Destructive deletes execute in one click with no confirmation (2026-10-17 audit)
**`src/pages/VaultPage.tsx:221-232`, `src/pages/ShoppingPage.tsx:236-242`, `src/pages/HabitsPage.tsx:101-108`, `src/pages/LoansPage.tsx:99-107`, `src/pages/NotesPage.tsx:512-522`, `src/pages/JournalPage.tsx:177-191`, `src/pages/ContactsPage.tsx:163-172`, `src/pages/GalleryPage.tsx:275-291`**
Because the app has no Trash or Undo, a single misclick permanently wipes user data across:
- **Vault secrets (`VaultPage.tsx:221-232`)** — `removeItem` immediately deletes the encrypted secret row.
- **Shopping lists (`ShoppingPage.tsx:236-242`)** — the `×` button sits right next to the list selection tab and immediately cascades to delete all `shopping_items` in that list.
- **Habits (`HabitsPage.tsx:101-108`)** — `removeHabit` immediately cascades and wipes the entire historical `habit_logs` streak record.
- **Loans (`LoansPage.tsx:99-107`)** — `remove` deletes an active loan with an unpaid balance in one click.
- **Notes, Journal entries, Contacts, and Gallery photos.**
Fix: require a two-step inline confirmation (e.g. `Delete` → `Confirm delete` / `Cancel`, matching the backup-restore confirmation pattern in `SettingsPage.tsx`) before running destructive deletes.

### P2-11 — Rapid double-click on payment / repayment / create buttons books duplicate financial entries (2026-10-17 audit)
**`src/pages/BusinessPage.tsx:370-411, 726-757` · `src/pages/LoansPage.tsx:66-97`**
Unlike `BudgetPage.EntriesView` (which disables submit via `saving`), `BusinessPage` (`JobsView.pay`, `JobsView.addJob`, `PayablesView.pay`, `PayablesView.addPayable`) and `LoansPage` (`repay`, `addLoan`) do not set a `busy` state while awaiting IPC writes. Double-clicking **"Save payment"** on a partial job payment passes the `amountCents <= remaining` check twice and records two job payments plus two Budget income entries; double-clicking **"Save"** on a partial loan repayment records the repayment twice. Fix: gate each async submit handler with a `busy` state that disables the submit button until `finally`.

### P2-12 — Deleting a Note or Memory leaves orphaned `photo_refs` ("Zombie" links in Gallery) (2026-10-17 audit)
**`src/lib/notes.ts:174-176` · `src/lib/memories.ts:67-69` · `src-tauri/src/schema.rs:343-356` · `src/pages/GalleryPage.tsx:293-300`**
`photo_refs` has `ON DELETE CASCADE` on `photo_id`, but `(entity_type, entity_id)` is a polymorphic reference with no SQL foreign key. Neither `deleteNote(id)` nor `deleteMemory(id)` removes matching rows from `photo_refs`, so deleting a linked note or memory leaves dangling entries that display as `Note #12` or `Memory #5` under **"Linked to"** in the Gallery Inspector. Fix: wrap `deleteNote` and `deleteMemory` (and any future `deleteJob`) in `driver.batch(...)` to also delete from `photo_refs WHERE entity_type = ? AND entity_id = ?`.

### P2-13 — Notes full-text search ignores the active sidebar collection filter (2026-10-17 audit)
**`src/pages/NotesPage.tsx:314-323` · `src/lib/notes.ts:178-185` · `src/lib/search.ts:22-39`**
When `search` is non-empty, `NotesPage` calls `notesRepo.search(search, { includeArchived: showArchived })` without passing `activeCollection`. Clicking a collection in the sidebar while a search query is active highlights the collection and triggers a reload, but still returns matches from all collections. Fix: add `collectionId?: number` to `searchNotes` (`AND n.collection_id = ?`) and pass `collectionId: activeCollection === "all" ? undefined : activeCollection`.

---

## P3 — nits and robustness notes (abridged)

- **P3-1** `db.rs:537` — poison recovery can hand back a mid-transaction `Connection`; consider a defensive `ROLLBACK` probe after recovery.
- **P3-2** `db.rs:448` — statement guard misses bracket/backtick-quoted pragma names (`PRAGMA [rekey]`).
- **P3-3** `photos.rs:144,161` — `PHOTO_WRITE_LOCK` poison is caught (returns `Err`, no panic) but wedges photo ops until restart; inconsistent with DB mutex recovery.
- **P3-4** `lib.rs:55` — second-instance guarantee fully delegated to `tauri-plugin-single-instance`; worth one line in release notes.
- **P3-5** `db.rs:179` — key file follows symlinks; Windows gets no `0o600` (inherits parent ACLs).
- **P3-6** `navigation.rs` — `on_navigation` hook doesn't cover iframes (CSP `frame-ancestors 'none'` covers it).
- **P3-7** `App.tsx:392` — boot-error screen has no Retry button (manual restart only).
- **P3-8** `App.tsx:285` — `loadSecurity()` has no timeout; a hung invoke sits on the skeleton forever.
- **P3-9** `NotesPage.tsx:477` — successful note save can report failure via draft bookkeeping (inconsistent with JournalPage's `.catch(() => undefined)`).
- **P3-10** Notes/Journal — per-keystroke encrypted DB writes, no debounce (cosmetic churn).
- **P3-12** `LockScreens.tsx:310` — double-submit within the verify window under-counts failures (negligible; PBKDF2 dominates).
- **P3-14** — ✅ resolved by the P1-1 fix: `backup_file::save_backup_file` writes a temp sibling and renames it into place.
- **P3-15** `thumbs.ts` — no size/dimension guard before full thumbnail decode.
- **P3-16** `photos.rs:143` — thumb filename keeps source extension though content is always JPEG (doc says `.thumb.jpg`; harmless drift).
- **P3-17** — backup export materializes the whole archive ~2× in renderer memory (pre-existing design limit).
- **P3-18** Change-PIN path (`SettingsPage.tsx:113`) bypasses `classifyPin`'s 100k-iteration floor — unreachable today (boot fail-closes first); route through `classifyPin` anyway (second trust root).
- **P3-19** `vault.ts` — key cache holds unsalted SHA-256(password); failed unlocks pollute the cache.
- **P3-20** `db.rs` `save_db_key_file` — truncates whatever path given (only the native dialog constrains it in practice).
- **P3-21** `.gitattributes` — "scripts must be LF" comment but `*.mjs` not pinned (covered by `* text=auto` in practice).
- **P3-22** `NotesPage.tsx` — redundant double `key` on editor section vs `NoteEditor` (harmless).
- **P3-23** `LockScreens.tsx` — shake animation class persists through the 5s cooldown (cosmetic).
- **P3-24** Draft staleness key is date-granularity (`updated_at` = `YYYY-MM-DD`) — safe today (all writers cooperate), weaker than documented.
- **P3-25** `gallery.ts:32` — photo dedup check-then-insert races under concurrency → UNIQUE error, no data loss (latent; callers are sequential).
- **P3-26** `backup.ts:230` — expanded-bytes filter trusts declared ZIP header sizes; fflate's `unzipSync` enforces actual sizes on decompression, so this is a first-pass heuristic bypassable by a lying header, not a hard boundary (defense-in-depth gap; import is local user-initiated).
- **P3-27** `backup.ts:181` — export aborts entirely if any photo file is missing (fail-closed, correct, no skip/repair path).
- **P3-28** `backup.ts:461` — orphan-file scan is O(n²) (perf nit for very large libraries).
- **P3-29** `NotesPage.tsx:547-579` — "Send to journal" gives no toast confirmation and has no `busy` guard while awaiting the append, inviting accidental duplicate appends to today's journal entry.
- **P3-30** `BudgetPage.tsx:894-929` — `RecurringView.markPaid` requires `fallbackCategoryId` and `fallbackWalletId` to be selected even when the recurring rule already carries its own `category_id` and `wallet_id`; meanwhile on mount both fallbacks auto-default to the first category (`Food`) and wallet (`Cash`), silently booking uncategorized recurring rules there.
- **P3-31** `SettingsPage.tsx:82-89` — `Filter settings…` only matches the 8 `SETTINGS_SECTIONS` titles (`Appearance`, `App lock & PIN`, etc.), so searching for `"theme"`, `"dark"`, `"idle"`, `"restore"`, `"zip"`, or `"lan"` returns `No settings match`.
- **P3-32** `App.tsx:135-160` vs `TasksPage.tsx:287-320` — when `useReminderPoll` fires a due reminder in the background, `RemindersSection` on an already-open `TasksPage` does not refresh its list until navigation.
- **P3-33** `Dialog.tsx:41-60` — `Tab` focus trap only wraps when `document.activeElement` is strictly `first` or `last`; clicking non-focusable modal text and pressing `Tab` can move focus outside the dialog unless `!dialog.contains(document.activeElement)` is also guarded.

---

## Verified clean (no findings)

- **Money:** integer-cents invariant holds everywhere; `recordJobPayment` Oct-11 fix intact (keyed mutex, clamped `applyPayment`, zero-amount skip, single atomic batch) — no regression. No float arithmetic anywhere.
- **Backup/restore:** `db::batch` genuinely all-or-nothing; FK toggled OFF only around the import batch and restored in `finally`; `BACKUP_TABLES` matches schema exactly (28 + `notes_fts` = 29); identifiers validated against `^[A-Za-z_][A-Za-z0-9_]*$`; **no zip-slip** (entry names never touch the FS); tampered photos re-hashed and re-pointed; failed imports clean up created files; **the DB key is never in the zip**.
- **Crypto:** fresh 16-byte salt per PIN hash; 600k PBKDF2-SHA256; constant-time `verifyPin`; fresh 12-byte IV per vault item; non-extractable vault keys; single CSPRNG.
- **Lock:** `classifyPin` distinguishes absent/corrupt/malformed/weak-iterations; fail-closed gates; retry throttle (5 free → 5s pause) never bricks; `lockSession` locks even if vault-drop/share-stop throws; Oct-16 lock-bypass fixes verified; **and (P2-2) a failed security reload can no longer be resolved into PIN verification** — `shellStage` checks `error` before `lockGate` and `enterWorkspace` refuses entry unless the reload succeeded.
- **Share:** consent token 256-bit CSPRNG, single-use, 120s TTL, burn-on-mismatch; 30-bit pairing code + 10-*consecutive*-wrong shutdown; Host-header rebinding defense; snapshot cleared before listener teardown (race-safe); 512KB snapshot cap; audit log never carries the code. (Plain-HTTP transport is a standing accepted risk with UI warning.)
- **Photos:** atomic content-addressed writes; strict `photos/<yyyy>/<mm>/<64hex>.<ext>` traversal grammar (regression-tested); save/delete serialized under `PHOTO_WRITE_LOCK`; hash-verified dedup; thumbnails decode with EXIF orientation applied (P2-3), matching what `<img>` shows.
- **DB core:** SQLCipher key verified via `sqlite_master` before schema work; mint-once keyring key; statement guard blocks txn-control/ATTACH/PRAGMA rekey and sees through SQL comments; all values parameter-bound.
- **IPC:** 19 commands registered, none extra (18 + `backup_save_file`, which took the export write out of the webview); every command validates inputs; photo and backup bytes cross as raw bodies; opener scoped to http/https/mailto/tel.
- **Drafts (M-01):** base-`updated_at` matching, stale-drop, in-flight keystroke guards, discard escape hatch, delete-clears-draft — all sound.
- **Links (L-01):** two layers — `MarkdownLink.tsx` + Rust `navigation.rs` origin allowlist; every `ReactMarkdown` instance covered.
- **Docs-vs-code:** README verify chain matches `package.json` exactly; versions agree 0.1.0 × 3 (enforced by `check-versions.mjs` in the gate); `npm run dev` exists; no TODOs/console.logs; no secrets; `"private": true`.

## Verification gaps (verified in 2026-10-17 audit)

1. `src-tauri/share/share.html` — **Verified clean:** every value is inserted via `document.createElement` + `node.textContent = String(text)` (`el()` helper); no `innerHTML` is used.
2. `src/lib/search.ts` — **Verified parameterized** (`buildMatchQuery` double-quotes every whitespace token with internal quotes doubled and binds via `WHERE notes_fts MATCH ?`), **except** `searchNotes` lacks `collectionId` filtering (recorded as **P2-13** above).
3. `scripts/make-latest-json.mjs` — **Verified clean:** delegates to `buildLatestJson` in `src/lib/release.ts`, which strictly validates semver (no leading `v`), non-empty `.sig` contents, non-empty asset URL, and strict RFC 3339 `pub_date`.

---

## Public-release cleanup list

Target: delete agent session files, progress logs, plans — keep the repo clean with only README + RELEASE docs. Deletion is authorized (local backups taken); execution is NOT part of this review.

### docs/ — KEEP (1)

| File | Reason |
|---|---|
| `docs/RELEASE.md` | Explicit wish; the by-hand release procedure. P1-6/P1-7 (§7, §3) ✅ already fixed. |

### docs/ — DELETE (5)

| File | Reason |
|---|---|
| `docs/PLAN.md` | Agent build plan + phase progress log; internal process. (README P1-2…P1-5 ✅ already fixed — nothing links here any more.) |
| `docs/CODE_REVIEW_FIX_PLAN.md` | Agent scratch from the Oct-14 code review. |
| `docs/M02_PHOTO_PIPELINE_PLAN.md` | Agent scratch: M-02 implementation plan. |
| `docs/UI_POLISH_PLAN.md` | Agent scratch: UI phases plan. |
| `docs/SESSION_MEMORY.md` | Agent scratch: rewritten every session; meaningless in public. |

### scripts/ — KEEP (4)

`check-hooks.mjs` (gate step 1) · `check-versions.mjs` (gate step 2) · `token-lint.mjs` (gate) · `make-latest-json.mjs` (release step 6, referenced by RELEASE.md)

### scripts/ — DELETE (1)

`reset-session-memory.mjs` (+ `session:reset` / `memory:reset` in `package.json`) — only rewrites the deleted SESSION_MEMORY.md; template references deleted PLAN.md.

### KEEP everything else

`README.md` (P1-2…P1-5 ✅ done), `package.json` (minus the two reset scripts), `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `biome.json`, `.editorconfig`, `.gitattributes`, `.gitignore`, `.githooks/` (the local gate — the only enforcement), `src/`, `src-tauri/`, `public/`. Full 186-blob inventory: no other scratch files exist (only 7 `.md` files total, all accounted for).

### Deletion mechanics — important

The hardened push method (tree built on the remote `base_tree` with an explicit changed-file list) makes deletions **impossible by construction**. Deleting these files needs the git-data API path: create blobs → create tree on the remote tree with `"sha": null` entries for the deleted paths → commit → PATCH ref. **Cleaner alternative:** fold the deletions into the planned Final Init Commit (history squash) — one commit, no intermediate delete-commit on the private history.

---

## Per-fix verdicts (Oct 15–16 remediation wave)

| Fix | Verdict |
|---|---|
| M-01 drafts (`2f9d67e1`) | Correct, with nits (P2-6, P3-9, P3-10) |
| M-02 photo pipeline (`808b4283`) | Core sound; 3 new P2s (P2-3 ✅ fixed, P2-4, P2-5) |
| M-03 native save dialog (`278b4623`) | Export path **incomplete** — backup export broken (P1-1); key export unaffected. **P1-1 + P2-1 now fixed**: Rust `backup_save_file`, fs permission deleted. |
| L-02 lock retry delay (`6897b553`) | Correct |
| L-04 boot failure (`6a3f1fdc`) | Correct on Rust side; frontend gaps P3 |
| L-05/L-07 versions (`2df4a18d`, `278a7da0`) | Correct |
| Poisoned-mutex recovery (`06a9a435`) | Mostly correct (P3-1 residual) |
| Statement-guard split (`06a9a435`/`eb03e571`) | Correct (P3-2 gap) |
| Second-instance refusal (`e7135bc1`) | Correct |
| Key out of webview (`e9ff30e4`) | Correct |
| Share consent token (`ec17c077`) | Correct |
| Consecutive abuse limit (`b89cec6c`) | Correct |
| Photo delete locks (`b89cec6c`) | Correct |
| Share shutdown race (`0ca5382b`) | Genuinely fixed |
| FIX-04/06/07/08/10 | All correct |
| `navigation.rs` (new) | Sound |
| `93baf125` shell-rules extraction | Correct (also fixes share-ticker stacking) |

Nothing was found fake-fixed or reverted. The remediation wave is in good shape; the single release blocker, P1-1, is fixed and the remaining release blockers are documentation only.
