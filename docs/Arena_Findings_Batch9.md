# Purple Memo Audit Findings — Batch 9

- **Base commit:** `380cec51c5877ab0be8f5473ac41e6549cc38f07` (`dev` HEAD `380cec5`, after the Batch 8 fix wave)
- **Working branch:** `arena/4bb5c4f1-purplememo`
- **Scoped files audited in full (1,096 lines):**
  1. `src/data/driver.ts` (`1–336`)
  2. `src/lib/types.ts` (`1–292`)
  3. `src/data/mock-driver.ts` (`1–241`)
  4. `src/lib/navigation.ts` (`1–94`)
  5. `src/data/app.ts` (`1–82`)
  6. `src/lib/mutex.ts` (`1–40`)
  7. `src/lib/errors.ts` (`1–11`)
- **Imported, caller, Rust IPC, and pinning test seams read for context:**
  - Rust backend seams: `src-tauri/src/commands.rs` (`1–992`), `src-tauri/src/lifecycle.rs` (`1–452`), `src-tauri/src/schema.rs` (`1–561`), `src-tauri/src/file_write.rs` (`1–333`), `src-tauri/src/navigation.rs` (`1–201`), plus command-facing sections of `src-tauri/src/db.rs`, `src-tauri/src/photos.rs`, `src-tauri/src/share.rs`, and `src-tauri/src/reset.rs`
  - Repository, shell, and UI callers: `src/lib/{backup.ts,budget.ts,business.ts,contactImport.ts,contacts.ts,entityLinks.ts,entityPicker.ts,exports.ts,gallery.ts,habits.ts,i18n.ts,inbox.ts,journal.ts,loans.ts,memories.ts,notes.ts,reset.ts,search.ts,searchContract.ts,session.ts,settings.ts,share.ts,shopping.ts,taskImport.ts,tasks.ts,trash.ts,vault.ts}`, `src/App.tsx`, `src/components/{EntityPicker.tsx,LinksSection.tsx,ResetScreen.tsx}`, `src/pages/{GalleryPage.tsx,MorePage.tsx,NotesPage.tsx,SettingsPage.tsx}`
  - Pinning test suites: `src/data/ipc.test.ts`, `src/data/mock-driver.test.ts`, `src/lib/mutex.test.ts`, `src/reset-gate.test.ts`, `src/pages/import-guard.test.ts`, `src/pages/stale-state-guards.test.ts`, `src/lib/local-gate.test.ts`, `src/app-shortcuts.test.ts`, and targeted sections of `src/lib/{backup.test.ts,contacts.test.ts,gallery.test.ts,notes.test.ts,reset.test.ts,share.test.ts}`
- **Method & test note:** Read all seven scoped files line-by-line in full and traced every IPC command name, header/body/argument/return shape, SQL column projection, error boundary, mutex critical section, navigation target, and singleton composition seam across TypeScript and Rust. Checked all candidates against Batches 1–8 (`F1–F12`, `B1–B14`, `C1–C6`, `D1–D12`, `E1–E14`, `G1–G14`, `H1–H10`, `I1–I4`, and `3c0add5` G9 remainder) with zero re-reports; no regressions of prior fixes were found. No source files were modified. In-scope Node tests were run after installing dependencies locally (`node_modules/` is gitignored) via:
  ```sh
  node --test src/data/ipc.test.ts src/data/mock-driver.test.ts src/lib/mutex.test.ts src/reset-gate.test.ts src/pages/import-guard.test.ts
  ```
  Result: **36/36 tests passed** (`node v22.22.3`; `src/lib/navigation.ts`, `src/data/app.ts`, `src/lib/types.ts`, and `src/lib/errors.ts` have no dedicated `*.test.ts` files).

---

## Summary

| ID | Severity | Grounded in | Summary |
|---|---|---|---|
| **J1** | **Med-high** | `src/lib/types.ts`, `src/data/driver.ts` | `NoteRow` and `PayableRow` are reused on partial/truncated SQL projections via unchecked `driver.query<T>`, silently truncating `EntityPicker` note-body searches at 200 characters and typing 2-column title rows as full 9-column `NoteRow`s |
| **J2** | **Med** | `src/data/driver.ts` | `encodeHeaderPath` leaves ASCII space (`0x20`) unescaped and raw photo headers skip encoding/validation, allowing Fetch `Headers` normalization to strip leading/trailing spaces on backup/export paths and photo extensions |
| **J3** | **Med** | `src/lib/mutex.ts`, `src/data/app.ts` | `KeyedMutex` is omitted from sibling delete/edit mutators on `job`, `payable`, and `recurring` keys, and from the shared `trashRepo` singleton across multi-await restore/purge critical sections |
| **J4** | **Med** | `src/data/mock-driver.ts` | `createMockDriver` omits the E5 import-lease surface, mismodels LAN-share consent/lock-revocation/stopped-publish and snapshot validation, shares one global thumbnail slot across all photos, and ignores `txnOpen` state |
| **J5** | **Low-med** | `src/data/app.ts` | `app.ts` constructs 11 duplicate repository instances (and 2 duplicate `KeyedMutex` instances) inside `createShareRepo(driver)` and leaves `vaultRepo`'s `CryptoKey` cache uncoordinated with `backupRepo.importBackup` |
| **J6** | **Low-med** | `src/lib/errors.ts` | `errText` returns `"[object Object]"` on plain error objects (contradicting its own comment), drops `MessageKeyError` locale keys to English on direct callers, passes raw SQLite `table.column` constraint strings through, and returns `""` on empty-message errors (hiding UI error banners) |
| **J7** | **Low-med** | `src/data/driver.ts` | `resetTxn()` JSDoc contradicts post-E12 Rust behaviour, `safetyBackupCopy()` hides its session-wide `Phase::Importing` write lock without returning a lease, and `batch(): Promise<void>` forces a racy second-IPC `SELECT last_insert_rowid()` in `contactsRepo.addChannel` |
| **J8** | **Low** | `src/lib/navigation.ts`, `src/lib/types.ts` | `navigation.ts` has no unit tests, leaves `NavigationTarget`, `pageTarget`, `entityTarget`, and `sameTarget` as bypassed dead code (skipping `entityTarget`'s ID check), ignores `target.page` in `focusedRowFor`, and `types.ts` carries a stale baseline/date-format header comment |

---

## Findings

### J1 — Med-high — `NoteRow` and `PayableRow` are reused on partial/truncated SQL projections across `driver.query<T>`, silently truncating `EntityPicker` note-body search at 200 characters and typing 2-column rows as full 9-column `NoteRow`s

- **Evidence:**
  - `src/lib/types.ts:11–21` (`NoteRow` declares all 9 columns required: `id`, `title`, `content`, `tags`, `collection_id`, `pinned`, `archived`, `created_at`, `updated_at`) and `src/lib/types.ts:94–103` (`PayableRow` declares all 9 columns required)
  - `src/data/driver.ts:54–55, 86` (`export type Queryable = object;` and `query<T extends Queryable>(sql: string, params?: unknown[]): Promise<T[]>`, unchecked cast over `src-tauri/src/db.rs:1138–1148`'s `stmt.column_names()` JSON map)
  - `src/lib/notes.ts:88, 150–205` (`LIST_CONTENT_CHARS = 200`; `listNotes` returns `Promise<NoteRow[]>` via `driver.query<NoteRow>(...)` for `"full"`, `"list"`, and `"title"`, as do `listNoteTitles` and its 9 unused sibling aliases at `:178–205`; `src/lib/search.ts:51` similarly projects `substr(n.content, 1, 200) AS content`)
  - `src/components/EntityPicker.tsx:55, 65–68, 75` and `src/lib/entityPicker.ts:43, 108` (`EntityPicker` calls `notesRepo.listNotes({ includeArchived: true })` expecting *"three full table reads"* and passes the result as `PickerSource.notes: NoteRow[]` into `matches(query, note.title, note.content, note.tags)`)
  - `src/pages/GalleryPage.tsx:81, 116` (`const [notes, setNotes] = useState<NoteRow[]>([])` populated from `notesRepo.listNoteTitles()`)
  - `src/lib/business.ts:567–570` (`driver.query<PayableRow>("SELECT paid FROM payables WHERE id = ?", [id])`)

- **What is wrong:**
  `types.ts` defines only full table-row interfaces (`NoteRow`, `PayableRow`) with no narrow projection types (`NoteTitleRow` / `NoteSummaryRow`), and `driver.query<T>` (`driver.ts:86`) performs an unchecked compile-time cast of whatever columns the SQL statement actually selects:
  1. **Default `"list"` projection masquerading as full `NoteRow`:** When `projection` is omitted, `notesRepo.listNotes` selects `substr(content, 1, 200) AS content` (`notes.ts:88, 167`) while still returning `Promise<NoteRow[]>`. Because the return type is `NoteRow[]`, `EntityPicker.tsx:75` calls `notesRepo.listNotes({ includeArchived: true })` without `projection: "full"`, believing it received complete `NoteRow` rows (`:65–66`), and feeds them to `pickerResults` (`entityPicker.ts:43, 108`), which searches `note.content` in memory. Any search term occurring after character 200 of a note's body never matches (`entityPicker.test.ts` passes full `NoteRow` fixtures, masking the seam bug).
  2. **`"title"` projection missing 7 of 9 required `NoteRow` fields at runtime:** `listNotes({ projection: "title" })` and `listNoteTitles()` execute `SELECT id, title FROM notes ...` (`notes.ts:166`) cast via `driver.query<NoteRow>`. At runtime `content`, `tags`, `collection_id`, `pinned`, `archived`, `created_at`, and `updated_at` are all `undefined`, yet `GalleryPage.tsx:81, 116` stores the array in `useState<NoteRow[]>([])`. Passing any element of that array to a helper typed to accept `NoteRow` (such as `noteExcerpt(n.content)` or `parseTags(n.tags)`) compiles without error and throws `TypeError` at runtime.
  3. **1-column `PayableRow` cast:** `business.ts:567–570` types `SELECT paid FROM payables WHERE id = ?` as `driver.query<PayableRow>` instead of `Pick<PayableRow, "paid">`, leaving the other 8 required fields `undefined` at runtime.

- **User impact:**
  When linking items via `EntityPicker` ("Link to" on Notes, Tasks, or Contacts), searching for a phrase inside a note's body silently fails to find the note whenever that phrase appears past the first 200 characters. Meanwhile `GalleryPage` and `business.ts` hold partially populated objects typed as full `NoteRow` / `PayableRow` records, inviting runtime `TypeError` crashes on future property reads.

- **Fix direction:**
  Add narrow projection types in `src/lib/types.ts` (e.g. `NoteTitleRow = Pick<NoteRow, "id" | "title">` and a distinct snippet/list type or explicit `listNoteSnippets` vs `listNotes`), type `listNoteTitles` as `Promise<NoteTitleRow[]>` (and remove the 9 dead title-only aliases in `notes.ts:178–205`), pass `projection: "full"` in `EntityPicker.tsx:75` (or add a dedicated picker query), update `GalleryPage.tsx:81` to `useState<NoteTitleRow[]>([])`, and narrow `business.ts:567` to `driver.query<Pick<PayableRow, "paid">>`.

---

### J2 — Med — `encodeHeaderPath` leaves ASCII space (`0x20`) unencoded and raw photo headers skip encoding/validation, allowing Fetch `Headers` whitespace normalization to corrupt paths and photo extensions

- **Evidence:**
  - `src/data/driver.ts:28–49` (`encodeHeaderPath`: `if (byte >= 0x20 && byte <= 0x7e && byte !== 0x25)`), `src/data/driver.ts:110–121`, and `src/data/driver.ts:222–255` (`savePhoto`, `savePhotoThumb`, `saveBackupFile`, `saveExportFile`)
  - `src/data/ipc.test.ts:299–329, 440–460` (`new Headers({ [BACKUP_PATH_HEADER]: encoded })` checked only for non-throwing construction; `decodeHeaderPath(encoded)` runs on pre-`Headers` `encoded` rather than `headers.get(...)`)
  - `src-tauri/src/commands.rs:80–97, 334–336, 404–406, 475–478, 621–624`, `src-tauri/src/file_write.rs:116–134, 190–200`, `src-tauri/src/photos.rs:228–230`
  - `src/lib/backup.ts:770–785` (`const ext = row.ext as string; const saved = await driver.savePhoto(entry.bytes, ext, lease);`)

- **What is wrong:**
  1. **`encodeHeaderPath` emits `0x20` raw, so Fetch `Headers` strips leading/trailing spaces on backup and export paths:** `driver.ts:32–33` states *"header values must be visible ASCII"*, which is `0x21..=0x7E` (RFC 9110 `VCHAR`), yet `:42` allows `byte >= 0x20` (`SP`). Tauri's raw-body `invoke` builds a WHATWG Fetch `Headers` object (`ipc.test.ts:441–446`), which normalizes header values per the Fetch / RFC 9110 §5.5 rules by stripping leading and trailing HTTP whitespace (`0x20`, `0x09`). On macOS and Linux, filenames ending (or relative paths starting) with a space are legal paths that the native save dialog can return (e.g. `/Users/alice/Backups/archive `). `encodeHeaderPath` leaves the trailing `0x20` unescaped, `Headers` strips it before Rust reads `Request::headers()`, and `backup_save_file` / `export_save_file` writes to `/Users/alice/Backups/archive` instead. `ipc.test.ts:320–328` missed this because it discards `new Headers(...)` and decodes `encoded` directly, and includes only interior spaces in its fixtures.
  2. **`savePhoto` (`driver.ts:222–230`) and `savePhotoThumb` (`driver.ts:237–245`) pass `ext` and `sourceRelPath` into `headers` unencoded and unvalidated:** `driver.ts:114–115` assumes callers always supply strict ASCII, but `applyBackup` (`backup.ts:771, 778`) forwards untrusted `row.ext as string` from `backup.json` straight to `driver.savePhoto`. If a crafted/corrupt manifest supplies `" jpg "` (padded with spaces/tabs), `Headers` trims it to `"jpg"` so Rust's `is_valid_ext` (`photos.rs:228–230`) accepts it and writes `<sha256>.jpg`, while `backup.ts:782–785` (which recomputes `rel_path`, `sha256`, and `size_bytes`, but not `ext`) inserts untrimmed `" jpg "` into `photos.ext` (unchecked in `schema.rs:437`). If `row.ext` is JSON `null`, `Headers` WebIDL-coerces `null` to `"null"` (valid 4-char alphanumeric extension in `is_valid_ext`!), writing `<sha256>.null` to disk before the later SQL batch fails; if `ext` or `sourceRelPath` contains non-Latin1 or CR/LF bytes, `new Headers(...)` throws a raw browser `TypeError` instead of reaching Rust's error handler.

- **User impact:**
  Saving a backup or export to a path with a trailing space on macOS/Linux silently writes to (and can atomically overwrite an existing file at) the space-trimmed path. Malformed backup manifests can store whitespace-corrupted `photos.ext` values or surface raw `TypeError: Failed to construct 'Headers'` errors.

- **Fix direction:**
  Change `encodeHeaderPath` (`driver.ts:42`) to escape `0x20` as `%20` (`byte >= 0x21 && byte <= 0x7e && byte !== 0x25`, updating `file_write.rs:193`'s test helper to match; `decode_header_path` already decodes `%20`), update `ipc.test.ts:320–328` to decode `new Headers({ [BACKUP_PATH_HEADER]: encoded }).get(BACKUP_PATH_HEADER)` with leading/trailing-space test cases, and validate/percent-encode `PHOTO_EXT_HEADER` and `PHOTO_SOURCE_HEADER` in `driver.ts` (rejecting non-strings or whitespace before `Headers` can coerce or strip them).

---

### J3 — Med — `KeyedMutex` (`mutex.ts`) is omitted from sibling delete/edit mutators on `job`, `payable`, and `recurring` keys, and from the shared `trashRepo` singleton (`app.ts`)

- **Evidence:**
  - `src/lib/mutex.ts:1–6` (*"serializes read-modify-write sequences that span IPC awaits ... Each repo creates its own mutex; keys are per-entity (e.g. `job:12`)."*)
  - `src/lib/business.ts:156, 288, 351–353, 462–495, 544, 593–595, 605–633` (`updateJob` and `recordJobPayment` lock `job:${id}`, `deleteJob` does not; `updatePayable` and `markPayablePaid` lock `payable:${id}`, `deletePayable` does not)
  - `src/lib/budget.ts:333, 886–960, 978–1014` (`markRecurringPaid` locks `recurring:${id}`, while `setRecurringActive`, `updateRecurring`, and `deleteRecurring` do not)
  - `src/data/app.ts:33, 35–36, 41, 71, 74` (one `trashRepo` shared across `notesRepo`, `journalRepo`, `tasksRepo`, `contactsRepo`, `memoriesRepo`), `src/App.tsx:656` (detached `void trashRepo.purge()` on every unlock), and `src/lib/trash.ts:391–463, 476–791` (no `KeyedMutex` anywhere in `createTrashRepo`)

- **What is wrong:**
  `createKeyedMutex()` itself is sound, but mutual exclusion only holds if every mutator touching the same invariant acquires the same lock key:
  1. **Unlocked `deleteJob` and `deletePayable` in `business.ts`:** `recordJobPayment` (`:462–495`) awaits `getJob(p.jobId)` (`:463`) and `businessCategoryId()` (`:488`) before executing `driver.batch([UPDATE jobs ..., INSERT INTO income_entries ...])`. Because `deleteJob(id)` (`:351–353`) skips `mutex.withLock("job:${id}", ...)`, a delete arriving between those awaits removes the job row first; `recordJobPayment`'s `UPDATE jobs ... WHERE id = ?` then affects 0 rows without error while `INSERT INTO income_entries` commits a phantom cash receipt in Budget. `deletePayable(id)` (`:593–595`) vs `markPayablePaid` (`:605–633`) has the identical hole for `INSERT INTO expense_entries`.
  2. **Unlocked `updateRecurring`, `deleteRecurring`, and `setRecurringActive` in `budget.ts`:** Unlike `updateJob`, `updatePayable`, and `updateLoan` (which were placed under their entity mutexes in review P2-2), `updateRecurring` (`:901`), `deleteRecurring` (`:954`), and `setRecurringActive` (`:886`) bypass `recurring:${id}`. An `updateRecurring` landing after `markRecurringPaid` read `getRecurring(id)` (`:979`) has its edited `next_due_date` overwritten by `markRecurringPaid`'s stale `advanceDate(lastDue, rule.frequency)` while booking occurrences at the stale `amount_cents`/`frequency`; a racing `deleteRecurring` books phantom `expense_entries` for a deleted rule.
  3. **No `KeyedMutex` on the shared `trashRepo` singleton (`app.ts:33` + `trash.ts:391`):** `App.tsx:656` launches `void trashRepo.purge()` detached in the background the instant the user unlocks, and every `trashEntity` (`:458`) and `restore` (`:679`) triggers another `purge()`. Meanwhile `restore(trashId)` (`:476–677`) spans 6+ sequential IPC awaits (`SELECT trash_items`, `allocateIds`, parent/date checks, per-photo `SELECT` + `readPhoto`, per-link `SELECT trash_items`) before `driver.batch`, and `removeTrashRows` (`:701–763`) reads `remainingItems` and `photos` across awaits before `driver.batch` and `driver.deletePhoto`. Interleaving background `purge()` with `restore(trashId)` or `removePermanently(trashId)` (or two concurrent restores) can allocate colliding IDs in `allocateIds`, overwrite sibling `trash_items.snapshot` link arrays (`:653` vs `:729`), or purge the trash row and photo file after `restore` validated them — either failing on `photo_refs` FK or re-inserting an already-purged entity (`DELETE FROM trash_items WHERE id = ?` affecting 0 rows).

- **User impact:**
  Interleaved delete/edit and payment actions can create orphaned income or expense entries in Budget or silently revert edited recurring schedules; unlocking the workspace and immediately restoring or deleting in Trash while background `purge()` is running can clobber related-link snapshots or corrupt/resurrect a concurrently purged item.

- **Fix direction:**
  Acquire `job:${id}` in `deleteJob`, `payable:${id}` in `deletePayable`, and `recurring:${id}` in `updateRecurring`, `deleteRecurring`, and `setRecurringActive` (and guard the batch `INSERT`s on the parent row still existing); give `createTrashRepo` a repository-level `KeyedMutex` (e.g. serializing `trashEntity`, `restore`, `removePermanently`, and `purge` on `"trash"`, calling an unlocked internal `purgeUnlocked()` from inside `trashEntity`/`restore` to avoid re-entrant self-deadlock per `mutex.ts:5–6`).

---

### J4 — Med — `createMockDriver` (`mock-driver.ts`) omits the E5 import-lease surface, mismodels LAN-share consent/lock-revocation/stopped-publish and snapshot validation, shares a single thumbnail slot across all photos, and ignores `txnOpen` state

- **Evidence:**
  - `src/data/mock-driver.ts:18–29, 87–121, 130–229`
  - Contrasted with `src/data/driver.ts:93–109, 121–136, 169–209`, `src-tauri/src/commands.rs:49, 178–315, 509–618, 639–691`, `src-tauri/src/lifecycle.rs:144–210`, and `src-tauri/src/share.rs:251–424, 482–501, 585–621, 1442`
  - Caller test impact in `src/lib/backup.test.ts:737–885, 1346–1375`, `src/pages/import-guard.test.ts:80–118`, and `src/lib/share.test.ts:209–240, 474–568`

- **What is wrong:**
  Four unpinned fidelity gaps in `createMockDriver` allow unit tests to pass on behaviour the Tauri/Rust backend refuses (the separate test-pinned `savePhoto` / `thumbPath` path-grammar question is reported in **DECISION 1**):
  1. **E5 import-lease & exclusion-window blind spot (`mock-driver.ts:87–109, 122–149, 174–182`):** `execute`, `batch`, `savePhoto`, `savePhotoThumb`, and `deletePhoto` omit `lease?: number` and drop it from `record(...)`. `createMockDriver` also omits `beginImportLease` and `endImportLease`, and `safetyBackupCopy` opens no exclusion window. As a result, zero runtime tests in the repository verify lease threading or `IMPORT_BLOCKED` refusal (forcing `import-guard.test.ts` to rely on regex source matching), and `backup.test.ts:1346` (`await repo.saveSafetyCopy(...)`) passes on a standalone call that in Rust (`commands.rs:512, 579`) leaves the session permanently write-blocked.
  2. **LAN-share token lifecycle and `sharePublish` drift (`mock-driver.ts:183–229`):**
     - `shareStart` (`:185–190`) comments *"Mirrors Rust: a start without a fresh consent token binds nothing"*, yet checks only `consentToken.length === 0`: it accepts arbitrary un-armed strings, permits replaying a spent token (`share.rs:277–281` burns the armed token on *every* attempt, matched or not), and `shareStop(true)` (`forLock`, `:206–219`) fails to revoke an armed token (`share.rs:414–417`).
     - `sharePublish` (`:224–229`) sets `share.publishedAt` even when `share.running === false`, and `shareStart` (`:196`) carries that `publishedAt` into the next started listener — contradicting `share.rs:487–500` (pinned by `publish_with_sharing_off_stores_nothing` at `share.rs:1442`), which stores nothing when stopped and returns `publishedAt: null`.
     - `sharePublish` (`:226`) runs only `JSON.parse`, omitting Rust's `parse_snapshot` validation (`MAX_SNAPSHOT_BYTES = 512 KiB`, JSON object, `version === 1`, string `generatedAt`, non-empty `nonce` and `ciphertext` at `share.rs:585–621`) — the exact mock blind spot that hid Batch 8's `I4` oversize-envelope failure.
  3. **Single global `script.thumbBytes` across all photos (`mock-driver.ts:28, 130–149`):** `savePhotoThumb` overwrites one global `script.thumbBytes` slot ignoring `sourceRelPath`, `readPhotoThumb` returns those bytes for *any* photo path, and `deletePhoto` clears `script.thumbBytes` even when deleting a completely different photo.
  4. **Ignored `txnOpen` state & inaccurate `MockScript.error` contract (`mock-driver.ts:23–26, 102–121, 150–182`):** `begin`/`commit`/`rollback`/`resetTxn` maintain no `txnOpen` flag, so `batch()` during an open `begin()`, double `begin()`, or `commit()`/`rollback()` with no open transaction all succeed on the mock while Rust rejects them (`commands.rs:219, 244, 263, 279`). Meanwhile `MockScript.error`'s JSDoc (`:23`: *"Thrown by the next `query`/`execute` when set"*) omits that `saveDbKeyFile`, `saveBackupFile`, `saveExportFile`, and `safetyBackupCopy` (`:152–179`) also consume it, and types rejections only as `Error` even though Tauri command errors reject as plain `string`s (`commands.rs:49`).

- **User impact:**
  Tests built on `createMockDriver` can stay green across regressions in import-lease propagation, lock-time share token revocation, stopped-share publishing, malformed/oversized share envelopes, multi-photo thumbnail caching/deletion, string IPC rejections, and transaction misuse that fail at runtime in the desktop app.

- **Fix direction:**
  Record `lease` whenever `lease !== undefined` (preserving existing 1-/2-arg `deepEqual` assertions in tests), implement `beginImportLease` / `endImportLease` and `Importing`-phase refusal on `createMockDriver`, enforce one-shot armed consent tokens cleared on both `shareStart` and `shareStop(true)`, mirror `parse_snapshot` and no-op stopped `sharePublish` in `mock-driver.ts`, store thumbnails in a `Map<string, Uint8Array>` keyed by `sourceRelPath`, track `txnOpen` across `begin`/`commit`/`rollback`/`resetTxn`/`batch`, and widen `MockScript.error` / `batchError` to `Error | string` with accurate JSDoc.

---

### J5 — Low-med — `app.ts` constructs 11 duplicate repository instances (and 2 duplicate `KeyedMutex` instances) inside `createShareRepo(driver)` and leaves `vaultRepo`'s `CryptoKey` cache uncoordinated with `backupRepo.importBackup`

- **Evidence:**
  - `src/data/app.ts:32–41, 70–78` (`backupRepo`, `trashRepo`, `notesRepo`, `budgetRepo`, `businessRepo`, `habitsRepo`, `tasksRepo`, `contactsRepo`, `memoriesRepo`, `vaultRepo`, `shareRepo`)
  - `src/lib/share.ts:294–303` (`createShareRepo(driver)` internally calls `createBudgetRepo`, `createBusinessRepo`, `createTasksRepo`, `createHabitsRepo`, `createMemoriesRepo`, `createContactsRepo`, and `createNotesRepo` — the last four without `trashRepo`, each default-constructing another `createTrashRepo(driver)` at `tasks.ts:124`, `memories.ts:17`, `contacts.ts:172`, `notes.ts:117`, and the first two each constructing another `createKeyedMutex()` at `budget.ts:333`, `business.ts:156`)
  - `src/lib/vault.ts:168–206` (`keyCache` and `deriveItemKey`) and `src/pages/SettingsPage.tsx:26, 493–522` (`confirmImport` calls `shareRepo.stop()` and `backupRepo.importBackup(...)`, then waits 900 ms for `window.location.reload()`, never calling `vaultRepo.lockVault()`)

- **What is wrong:**
  1. **11 duplicate repos + 2 duplicate mutexes in the composition root:** `app.ts:1–3` exists to instantiate one singleton per domain repository over `driver`, yet `export const shareRepo = createShareRepo(driver)` (`:78`) rebuilds 7 domain repos and 4 implicit `trashRepo` instances instead of receiving `app.ts`'s already-constructed singletons. While `shareRepo` currently invokes only read methods on those copies, any per-instance state, memoization, or write added to those repositories immediately splits across two instances with separate mutexes.
  2. **Stale `vaultRepo` `CryptoKey` cache across `backupRepo.importBackup`:** `app.ts` wires `backupRepo` (`:32`) and `vaultRepo` (`:76`) independently with no cache-invalidation hook when `importBackup` replaces all tables (unlike `App.tsx`'s `lockNow` and `handleResetFinished`, which both call `vaultRepo.lockVault()`). When a user unlocks the vault and then imports a backup in Settings, pre-import `CryptoKey`s stay live in `vaultRepo`'s `keyCache` (`vault.ts:168`) throughout the 900 ms reload delay (`SettingsPage.tsx:520` — during which the sidebar remains interactive) and indefinitely for any direct caller of `app.ts`'s `backupRepo.importBackup`. Worse, `deriveItemKey` (`vault.ts:201–205`) validates `cached.tag === await deriveVaultTag(password, cached.salt)` against `cached.salt` *without querying SQLite for the imported row's `salt`*: if the user opens an imported vault item with a colliding `id` and the same password before reload, `deriveItemKey` returns the **old** salt's `CryptoKey`, AES-GCM authentication fails, and `VaultPage` falsely reports `WrongPasswordError`.

- **User impact:**
  Violates singleton repository/mutex ownership in `app.ts`, retains pre-import `CryptoKey`s in renderer memory after the vault data they belonged to was replaced, and causes false `WrongPasswordError` failures if an imported vault item with a reused ID is accessed before page reload.

- **Fix direction:**
  Accept optional pre-built repositories in `createShareRepo(driver, repos?)` and pass `app.ts`'s singletons at `app.ts:78`; wire `vaultRepo.lockVault()` (and `shareRepo` state reset) into `app.ts`'s `backupRepo` composition (e.g. via an `onBeforeImport` / `onImported` hook or wrapper in `app.ts`) so `importBackup` always invalidates in-memory `CryptoKey`s regardless of caller.

---

### J6 — Low-med — `errText` (`errors.ts`) returns `"[object Object]"` on plain error objects, drops `MessageKeyError` locale keys to English on direct callers, leaks raw SQLite `table.column` strings, and returns `""` on empty-message errors

- **Evidence:**
  - `src/lib/errors.ts:1–11` (`// ... never as "[object Object]".` vs `export function errText(e: unknown): string { return e instanceof Error ? e.message : String(e); }`)
  - `src/lib/i18n.ts:1504–1517` (`MessageKeyError`, `isMessageKeyError`), `src/lib/inbox.ts:42–51, 209–215` (`InboxError` sets `super(translate("en", ...))`), `src/lib/entityLinks.ts:69–78` (`LinkTargetGoneError` sets `super(translate("en", ...))`)
  - Direct callers vs manual wrappers: `src/components/EntityPicker.tsx:192`, `src/components/ImportDialog.tsx:115`, and `src/pages/InboxPage.tsx:131` manually check `isMessageKeyError(e)`, whereas the other 21 UI importers of `errText` — including `src/App.tsx:440, 1114` (`submitCapture` calling `inboxRepo.create`) and `src/components/LinksSection.tsx:50, 71, 115` — call `errText(e)` directly
  - Raw backend errors reaching `errText(e)`: `src-tauri/src/db.rs:1129, 1136, 1170` (`"execute failed: UNIQUE constraint failed: wallets.name"`, `"prepare failed: ..."`), `src/pages/SettingsPage.tsx:706, 725` (`@tauri-apps/plugin-updater`)

- **What is wrong:**
  1. **Contradicts its own `never as "[object Object]"` invariant (`errors.ts:6–10`):** When a non-`Error` plain object is rejected (such as a structured `{ message: string }` / `{ error: string }` rejection from a Tauri plugin like `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-dialog`, or `@tauri-apps/plugin-opener`, or a serialized/cross-realm error object), `e instanceof Error` is `false` and `String(e)` returns literal `"[object Object]"`.
  2. **Ignores `MessageKeyError`, forcing callers to duplicate a manual guard or leak English in Burmese mode:** `InboxError` and `LinkTargetGoneError` hardcode English into `Error.message` (`translate("en", ...)`). Because `errText` does not check `isMessageKeyError(e)` against the active locale (`getLocale()`), every caller that uses `errText(e)` without the three-file boilerplate wrapper drops `e.messageKey` and renders English to Burmese users. Meanwhile, unhandled SQLite uniqueness failures on user-facing names (`wallets.name`, `collections.name`, `income_categories.name`, `expense_categories.name`) cross `driver.ts` and `errText` untranslated as raw `"execute failed: UNIQUE constraint failed: <table>.<column>"`.
  3. **Returns `""` on `new Error("")` or `""`, hiding error banners:** Nearly every page renders `{error ? <p className="alert alert-error" role="alert">{error}</p> : null}` (`App.tsx:1114`, `LinksSection.tsx:115`, etc.). When `errText(e)` returns `""`, `setError("")` evaluates falsy in JSX and silently swallows the failure with no alert rendered.

- **User impact:**
  Structured plugin/runtime rejections display as `"[object Object]"`, `MessageKeyError`s caught by `errText`-only callers bypass Burmese translation, duplicate wallet/collection/category names expose raw SQLite schema internals, and empty-message errors fail silently without rendering an alert banner.

- **Fix direction:**
  Teach `errText` (`src/lib/errors.ts`) to resolve `isMessageKeyError(e)` via `translate(getLocale(), e.messageKey, e.params)`, extract non-empty string `.message` / `.error` fields (or `JSON.stringify` fallback) from non-null objects so `"[object Object]"` is unreachable, return a non-empty fallback message when the extracted text is empty/whitespace, and add `src/lib/errors.test.ts` pinning all four cases. (Friendly duplicate-name handling or mapping for `UNIQUE constraint failed` on named user entities can also be translated cleanly at the repo or error-helper boundary.)

---

### J7 — Low-med — `DataDriver` (`driver.ts`) contract hazards: `resetTxn()` JSDoc contradicts post-E12 Rust behaviour, `safetyBackupCopy()` hides its session-locking side effect without returning a lease, and `batch(): Promise<void>` forces a racy second-IPC `SELECT last_insert_rowid()` in `contactsRepo.addChannel`

- **Evidence:**
  - `src/data/driver.ts:103–109` (`resetTxn` JSDoc) vs `src-tauri/src/commands.rs:299–313` and `src-tauri/src/db.rs:829–839` (`reconcile_open_txn`)
  - `src/data/driver.ts:160–188` (`safetyBackupCopy`, `beginImportLease`, `endImportLease`) vs `src-tauri/src/commands.rs:509–585` (`backup_safety_copy` calls `lifecycle.begin_import()?` and disarms `ImportWindowGuard` on success) and `src/lib/backup.ts:952–954` (`saveSafetyCopy`)
  - `src/data/driver.ts:98–99` (`batch(statements: BatchStatement[], lease?: number): Promise<void>`) vs `src/lib/contacts.ts:249–277` (`addChannel`: `await driver.batch(statements); const rows = await driver.query<{ id: number }>("SELECT last_insert_rowid() AS id");`) and `src-tauri/src/commands.rs:201–225`

- **What is wrong:**
  1. **`resetTxn()` JSDoc (`driver.ts:103–109`) states the exact opposite of post-E12 Rust:** `driver.ts:104–106` still documents `resetTxn()` as *"Clear the manual-transaction flag without touching the DB — break-glass for when `commit` AND `rollback` both failed"*. Since Batch 5's `E12` fix (`commands.rs:310–312`, `db.rs:829–839`), `db_reset_txn` *does* touch SQLite (`ROLLBACK;` under the connection lock) and **refuses** to clear `txn_open` whenever `ROLLBACK` fails, requiring an app restart instead.
  2. **`safetyBackupCopy(label): Promise<string>` (`driver.ts:160–169`) opens a session-wide `Phase::Importing` write lock as an undocumented side effect without returning the lease:** In Rust (`commands.rs:512, 579`), `backup_safety_copy` opens the `Lifecycle` import exclusion window (`Phase::Importing`) and leaves it open when it resolves, returning only the destination path string. Neither `driver.ts:160–169` nor `backup.ts:944–954` mentions that calling `safetyBackupCopy` / `saveSafetyCopy` leaves every ordinary DB write, photo write, and LAN-share action in the app permanently failing with `IMPORT_BLOCKED` unless `beginImportLease()` + `endImportLease(lease)` subsequently runs.
  3. **`batch()` returning `Promise<void>` (`driver.ts:98–99`) causes a cross-IPC `last_insert_rowid()` race in `contactsRepo.addChannel` (`contacts.ts:272–276`):** Because `db_batch` returns `()` and drops the SQLite connection lock before resolving (`commands.rs:201–225`), `contactsRepo.addChannel` issues a second IPC call `driver.query("SELECT last_insert_rowid() AS id")` to learn the inserted channel's ID. Any write from a background ticker, draft save, or Quick Capture landing on the single shared SQLite connection between `db_batch` and `db_query` overwrites connection-global `last_insert_rowid()`, causing `addChannel` to return an unrelated table's rowid (and on an unscripted `mock-driver`, `0`).

- **User impact:**
  Misleading break-glass and safety-copy contracts in `DataDriver` invite caller misuse that permanently write-blocks a running session; concurrent background writes during `contactsRepo.addChannel` return a corrupted channel ID to the caller.

- **Fix direction:**
  Update `driver.ts:103–109` to document `resetTxn()`'s post-E12 `ROLLBACK`-gated reconciliation; document `safetyBackupCopy`'s `Phase::Importing` side effect on `DataDriver` (or return `{ path, lease }` / fold `saveSafetyCopy` + `importBackup` behind one lease-owning repo operation); and either return `lastInsertRowid` from `db_batch` / `DataDriver.batch` or rewrite `contactsRepo.addChannel` (`contacts.ts:249–277`) to use `driver.execute` when `!input.isPrimary` and retrieve the ID atomically (or avoid returning an unconsumed ID if callers reload channels).

---

### J8 — Low — `navigation.ts` has no unit tests, leaves `NavigationTarget` / `pageTarget` / `entityTarget` / `sameTarget` as bypassed dead code, ignores `target.page` in `focusedRowFor`, and `types.ts` carries a stale header comment

- **Evidence:**
  - `src/lib/navigation.ts:8–11, 44–94` (`NavigationTarget`, `pageTarget`, `entityTarget`, `sameTarget`, `focusedRowFor`; no `src/lib/navigation.test.ts` exists)
  - `src/App.tsx:73, 314, 324–354, 979–982, 1025–1028, 1046–1049` (imports only `ENTITY_PAGE`, `focusedRowFor`, and `type PageKey`; zero callers of `pageTarget`, `entityTarget`, or `sameTarget` anywhere in `src/`)
  - `src/lib/types.ts:1–3, 223, 236` vs `src-tauri/src/schema.rs:4`

- **What is wrong:**
  1. **Bypassed navigation model and dead exports in `navigation.ts`:** `navigation.ts:8–11` states *"The shell keeps ONE target in state and passes it down as props"*, backed by `NavigationTarget` (`:44–48`), `pageTarget` (`:51–53`), `entityTarget` (`:62–67`), and `sameTarget` (`:74–80`). In reality, `App.tsx:314–354` keeps four separate states (`page`, `focus`, `focusToken`, `searchTarget`), leaves `pageTarget`, `entityTarget`, and `sameTarget` with **zero callers** across the repository, bypasses `entityTarget`'s positive-integer ID guard (`:63–65`, which also checks `Number.isInteger` rather than `Number.isSafeInteger`) by calling `setFocus(entity); setPage(ENTITY_PAGE[entity.type])` directly in `openEntity` (`App.tsx:328–333`), and allocates ad-hoc `{ page, entity: focus ?? undefined }` objects inline (`App.tsx:980, 1026, 1047`) solely to call `focusedRowFor`.
  2. **`focusedRowFor(target, type)` (`navigation.ts:89–94`) ignores `target.page` and invalid IDs:** `return target.entity?.type === type ? target.entity.id : null` never checks `target.page === ENTITY_PAGE[type]` and does not reject non-positive or non-safe-integer `id`s (`0`, `-1`, `NaN`), so a mismatched `{ page: "dashboard", entity: { type: "note", id: 7 } }` still reports note `7` focused.
  3. **Stale baseline table count and date-format comment in `types.ts:1–3`:** `types.ts:1–2` claims *"Row/domain types for the 29-table baseline ... dates are local `yyyy-mm-dd` strings"*. At `SCHEMA_VERSION = 5` (`schema.rs:4`), the schema has 31 regular tables + `notes_fts` (32 total), `types.ts` defines 27 `*Row` interfaces (omitting `income_entries`, `expense_entries`, `trash_items`, and `settings`), `ReminderRow.remind_at` (`:223`) is local `yyyy-mm-ddTHH:mm`, and `ContactRow.birthday` (`:236`) accepts `yyyy-mm-dd` or yearless `mm-dd`.

- **User impact:**
  No immediate crash in current UI flows, but `entityTarget`'s invalid-ID guard is completely unreached on real navigations, `navigation.ts` has zero unit-test coverage, and comments in `navigation.ts` and `types.ts` misdescribe the live architecture and schema.

- **Fix direction:**
  Either route `App.tsx`'s `openEntity`/`navigate` through `entityTarget` (strengthened to `Number.isSafeInteger(entity.id) && entity.id > 0`) and check `target.page === ENTITY_PAGE[type]` inside `focusedRowFor` — or delete the unused `NavigationTarget`/`pageTarget`/`entityTarget`/`sameTarget` surface and simplify `focusedRowFor(focus: LinkableEntity | null, type: LinkableEntityType)` to match `App.tsx`'s actual state model, adding `src/lib/navigation.test.ts`; update `src/lib/types.ts:1–3` to reflect the 31-table (+ `notes_fts`) v5 schema and `remind_at` / `birthday` formats.

---

## DECISION — Test-Pinned Behaviour Requiring an Owner Choice

### DECISION 1 — `mock-driver.ts` synthetic photo/thumbnail path grammar (`"photos/2026/10/jpg.3"` and `.thumb.<ext>`) vs Rust's content-addressed `<sha256>.<ext>` and `.thumb.jpg` contract

- **Files:** `src/data/mock-driver.ts:31–38, 122–129` vs `src-tauri/src/photos.rs:67, 152–167, 248–274, 456–468`
- **Pinning tests:** `src/data/mock-driver.test.ts:56–57, 74–75` (`assert.equal(rel, "photos/2026/10/jpg.3")` and `assert.equal(thumb, "photos/2026/10/jpg.thumb.1")`) and `src/lib/backup.test.ts:757, 808, 847, 934, 938, 1040`
- **Why this needs a decision:**
  - In Rust, `photos::save_photo` returns content-addressed `photos/<yyyy>/<mm>/<64-hex-sha256>.<ext>`, `photos::validate_rel_path` (`photos.rs:248–274`) rejects any non-64-hex stem or numeric-only/multi-dot extension, and since review P3-16 (`photos.rs:152–167`, pinned at `:456–468`) `photos::thumb_rel_path` **always** emits `.thumb.jpg` regardless of source extension because `thumbs.ts` encodes JPEG.
  - `mock-driver.ts:122–125` instead returns `` `photos/2026/10/${ext}.${bytes.length}` `` (`"photos/2026/10/jpg.3"`), which swaps stem and extension into a path Rust rejects as invalid, collides whenever two distinct photos share an extension and byte length (forcing `backup.test.ts:1051–1060` to monkey-patch `savePhoto` by hand to test a real SHA-256 path), and `thumbPath` (`mock-driver.ts:31–38`) still carries a pre-P3-16 comment (*"Mirrors the Rust thumbnail derivation: `<hash>.<ext>` -> `<hash>.thumb.<ext>`"*) while preserving `.${ext}` (and corrupting dotless strings via `file.slice(0, -1)`).
  - Because `mock-driver.test.ts` and `backup.test.ts` explicitly pin `"photos/2026/10/jpg.3"` and `"photos/2026/10/jpg.thumb.1"`, changing the path format updates six test assertions across two test files.
- **Options:**
  1. **Align `mock-driver.ts` with Rust's `<64-hex-sha256>.<ext>` and `.thumb.jpg` grammar (recommended):** Compute SHA-256 (or deterministic 64-hex content hash) in `mock-driver.savePhoto`, validate `ext`, make `thumbPath` return `${dir}${hash}.thumb.jpg` (rejecting malformed paths like Rust), and update the pinned path strings in `mock-driver.test.ts` and `backup.test.ts`.
  2. **Keep the synthetic `"photos/2026/10/${ext}.${bytes.length}"` stub for test brevity and fix the JSDoc:** Leave the pinned test strings untouched, but rewrite `mock-driver.ts:31` and `:122` comments to state explicitly that the mock returns a synthetic non-Rust stub path (not content-addressed and not `.thumb.jpg`).

---

### DECISION 2 — Retaining vs removing the uncalled, await-unsafe `begin` / `commit` / `rollback` / `resetTxn` manual-transaction surface

- **Files:** `src/data/driver.ts:4–5, 99–109, 218–221`, `src/data/mock-driver.ts:110–121`, `src-tauri/src/commands.rs:227–315`
- **Pinning tests:** `src/data/ipc.test.ts:47–51` (`assert.equal(commands.length, 25)`), `src/data/mock-driver.test.ts:53–54` (`await driver.begin(); await driver.commit();`), and `src-tauri/src/commands.rs:230–231, 969–991`
- **Why this needs a decision:**
  - Zero production code in `src/` calls `driver.begin()`, `driver.commit()`, `driver.rollback()`, or `driver.resetTxn()` — every multi-statement write goes through atomic `driver.batch(...)` (`commands.rs:230–232`: *"intentionally retained even though no app code calls them today: the surface is mandated"*).
  - Worse, `driver.ts:4–5` claims `begin`/`commit`/`rollback` *"exist only for short critical sections and are never held across UI awaits"*, which is impossible in JavaScript: `await driver.begin()` is itself an async IPC round-trip that releases `AppState.conn`'s Rust mutex on return (`commands.rs:240–252`). While `txn_open` is `true`, `db_batch` refuses (`commands.rs:219`), **but `db_execute` (`commands.rs:178–190`) and `db_query` (`:167–175`) do not check `txn_open`**, so any background poller, draft write, or Quick Capture `driver.execute(...)` landing between `await driver.begin()` and `await driver.commit()` silently enters the open manual transaction (and rolls back with it on abort), and none of the four commands accepts an import `lease`.
- **Options:**
  1. **Remove `begin`, `commit`, `rollback`, and `resetTxn` from `DataDriver`, `mock-driver.ts`, and `commands.rs` (shrinking the pinned IPC surface from 25 to 21 commands):** Eliminates an unused footgun that cannot be safely called across IPC awaits without interleaving unrelated `db_execute` writes, while keeping `db_batch` as the sole atomic multi-statement path.
  2. **Keep the 25-command surface as mandated, fix `driver.ts:4–5, 103–109`'s comments (`J7`), and document the interleaving hazard:** Warn explicitly on `DataDriver.begin` that `AppState.conn` is not held across IPC calls so concurrent `execute` writes join the open transaction.

---

## Checked and Found Clean

- **25-command IPC registration, argument casing, and return shapes (`driver.ts`, `commands.rs`, `lib.rs`, `ipc.test.ts`):** Every `invoke(...)` command name in `src/data/driver.ts` matches `tauri::generate_handler!` in `src-tauri/src/lib.rs` 1-for-1 (pinned in both directions by `ipc.test.ts:41–68`). Argument keys (`{ sql, params, lease }`, `{ statements, lease }`, `{ relPath }`, `{ sourceRelPath }`, `{ path }`, `{ label }`, `{ consentToken }`, `{ forLock: forLock === true }`, `{ snapshotJson }`) match Rust parameter names and `#[tauri::command(rename_all = "camelCase")]` annotations (`commands.rs:654, 670`). Return shapes (`ExecuteOutcome` camelCase at `db.rs:77`, `ShareInfo` camelCase at `share.rs:108`, `ResetOutcome` / snake_case `ResetComponent` & `ResetStatus` at `reset.rs:60, 127`) match `driver.ts:57–81, 276–308` exactly.
- **Raw byte IPC channels, webview capability isolation, and photo size parity (`driver.ts`, `commands.rs`, `ipc.test.ts`):** `photo_read` and `photo_read_thumb` return `tauri::ipc::Response` wrapped into `new Uint8Array(await invoke<ArrayBuffer>(...))` (`driver.ts:231–236`) without JSON byte-array expansion; `photo_save`, `photo_save_thumb`, `backup_save_file`, and `export_save_file` send raw `Uint8Array` bodies; `PHOTO_EXT_HEADER`, `PHOTO_SOURCE_HEADER`, `PHOTO_LEASE_HEADER`, `BACKUP_PATH_HEADER`, and `EXPORT_PATH_HEADER` match Rust constants; `tauri.conf.json` `connect-src` permits `ipc:` and `http://ipc.localhost`; no `fs:*` permission or plugin is granted; and `MAX_SAVED_PHOTO_BYTES` (`25 MiB`) matches `MAX_BACKUP_PHOTO_BYTES`.
- **Schema-to-`types.ts` column parity across all 27 `*Row` interfaces (`types.ts`, `schema.rs`):** Every column name, scalar type (`number` vs `string`), nullability (`| null`), and string-literal union (`RecurringFrequency`, `JobStatus`, `LoanDirection`, `TaskRow["repeat"]`, `InboxTarget`, `InboxStatus`, `LinkableEntityType`, `LinkRow["kind"]`, `ReminderRow["repeat"]`, `ContactChannelKind`, `PhotoRefEntity`) in `src/lib/types.ts` agrees with `BASELINE_SQL` and `MIGRATION_1_2`..`MIGRATION_4_5` in `src-tauri/src/schema.rs`. All `SELECT *` repository queries match their declared `*Row` interfaces (only the non-`*` partial projections in `J1` diverge).
- **`createKeyedMutex` internal promise-chain mechanics (`mutex.ts:12–40`, `mutex.test.ts`):** Same-key callers serialize strictly in arrival order, distinct keys run concurrently without head-of-line blocking, synchronous throws and asynchronous rejections inside `fn()` settle the internal gate cleanly without poisoning subsequent waiters (`.then(() => undefined, () => undefined)` at `:25–28`), and `if (tails.get(key) === mine) tails.delete(key)` (`:35`) cleans up idle keys without evicting a queued successor's tail.
- **Terminal `ResetResultScreen` isolation & Batch 7/8 fix-wave verification (`driver.ts`, `navigation.ts`, `App.tsx`, `reset-gate.test.ts`):** `PageKey` (`navigation.ts:16–34`) contains no reset route; `resetAttempt` lives in top-level `App.tsx` state (`:311`), gates `workspaceLive` off (`:667`), outranks `shellStage` (`:791–792`), and follows Batch 7 Decision 1 + `H3`/`H6`/`H8` pins (`reset-gate.test.ts`). Batch 8 fixes (`I1`–`I4`, `D1(a)`, `D2(a)` `shareStop(true)` lock epoch, and `3c0add5` G9 search date guard) are intact with no regressions.

## Resolutions (decided by Muus, delegated by the owner 2026-10-29)

The DECISION items above are genuine behaviour choices. Both are settled
here; the original DECISION wording is preserved above.

- **Decision 1 — option (1): align `mock-driver.ts` with Rust's path
  grammar.** `savePhoto` computes a real SHA-256 (or deterministic 64-hex
  content hash) and returns `photos/<yyyy>/<mm>/<64-hex>.<ext>` with ext
  validated; `thumbPath` returns `<dir><hash>.thumb.jpg`, rejecting
  malformed paths the way `photos::validate_rel_path` does; the six
  pinned path strings in `mock-driver.test.ts` and `backup.test.ts` are
  updated. Rationale: J4's entire thesis is that mock/real divergence
  hides bugs — keeping a knowingly-wrong path grammar while fixing the
  other fidelity gaps would be incoherent, and `backup.test.ts`
  monkey-patching `savePhoto` to test a real SHA-256 path is already
  evidence the stub gets in the way. The stale pre-P3-16 JSDoc is fixed
  as part of it.
- **Decision 2 — option (2): keep the 25-command surface as mandated.**
  Rationale: `commands.rs` records the surface as intentionally retained
  ("mandated"), and the mandate's origin is not established — removing it
  is the riskier change. Instead fix the misleading contracts (J7): the
  `resetTxn()` JSDoc gets the post-E12 ROLLBACK-gated truth, and
  `DataDriver.begin` documents the interleaving hazard explicitly
  (`AppState.conn` is not held across IPC awaits, so concurrent
  `execute` writes join an open manual transaction). Removal stays a
  clean follow-up once the mandate is understood.

## Fix-wave note (5 commits, order 1→2→3→4→5)

- Commit 1 = J1 (projection types: narrow `NoteTitleRow`/snippet types
  in `types.ts`; type `listNoteTitles` + remove the dead title-only
  aliases in `notes.ts`; `projection: "full"` in `EntityPicker.tsx`;
  `useState<NoteTitleRow[]>` in `GalleryPage.tsx`; narrow the
  `PayableRow` cast in `business.ts`; tests).
- Commit 2 = J2 + J7 + D2(2) (`driver.ts` contract: `encodeHeaderPath`
  escapes `0x20`, photo headers validated/percent-encoded before
  `Headers`; `resetTxn()` JSDoc corrected to the post-E12 truth;
  `safetyBackupCopy` documents its `Phase::Importing` side effect;
  `begin` documents the interleave hazard; `contactsRepo.addChannel`
  stops the cross-IPC `last_insert_rowid()` race; `file_write.rs` test
  helper + `ipc.test.ts` updated).
- Commit 3 = J3 (mutex coverage: `job:${id}` in `deleteJob`,
  `payable:${id}` in `deletePayable`, `recurring:${id}` in
  `updateRecurring`/`deleteRecurring`/`setRecurringActive`; a
  repository-level `KeyedMutex` for `createTrashRepo` serializing
  `trashEntity`/`restore`/`removePermanently`/`purge`, with an unlocked
  internal `purgeUnlocked()` for the re-entrant callers).
- Commit 4 = J4 + D1(1) (mock fidelity: lease threading +
  `beginImportLease`/`endImportLease` + `Importing`-phase refusal;
  one-shot armed consent tokens cleared on `shareStart` and
  `shareStop(true)`; `parse_snapshot` validation + no-op stopped
  `sharePublish`; thumbnails in a `Map` keyed by `sourceRelPath`;
  `txnOpen` tracking; `MockScript.error` widened to `Error | string`;
  SHA-256 photo paths + `.thumb.jpg` per D1(1); update the six pinned
  path assertions).
- Commit 5 = J5 + J6 + J8 (composition: `createShareRepo(driver, repos?)`
  accepting `app.ts` singletons; `vaultRepo.lockVault()` wired into the
  `importBackup` path regardless of caller; `errText` taught
  `MessageKeyError` + non-`"[object Object]"` + non-empty fallback with
  a new `src/lib/errors.test.ts`; `navigation.ts` either routed through
  `entityTarget` or pruned to `App.tsx`'s actual state model with
  `navigation.test.ts`; `types.ts` header comment corrected).

Commits 1 and 5 share `types.ts`, commits 1 and 3 share `business.ts`
(order 1→3→5 as listed). `npm run verify` green before each commit.
