# Purple Memo audit findings — Batch 8

- **Base:** `b59c5b2b92f50496d01af08b744e494977ced1da` (the checkout's HEAD; no local `dev` ref is present)
- **Working branch:** `arena/7a398c89-purplememo`
- **Review scope:** LAN share snapshot and phone renderer; encrypted and plain backup parsing/import; contact/task CSV import and readable exports; photo persistence/thumbnails; note-reader helpers and callers.
- **Files:** `src/lib/{share.ts,share.test.ts,session.ts,session.test.ts,backup.ts,backup.test.ts,backupContainer.ts,backupContainer.test.ts,csv.ts,csv.test.ts,contactImport.ts,contactImport.test.ts,taskImport.ts,taskImport.test.ts,exports.ts,exports.test.ts,thumbs.ts,thumbs.test.ts,gallery.ts,gallery.test.ts,notes.ts,noteReader.ts,noteReader.test.ts,budget.ts,business.ts,tasks.ts,habits.ts,memories.ts,contacts.ts,dashboard.ts,i18n.ts}`; `src/components/{ImportDialog.tsx,NoteReaderDialog.tsx}`; `src/pages/{ContactsPage.tsx,TasksPage.tsx,ExportsPage.tsx,SettingsPage.tsx,GalleryPage.tsx,NotesPage.tsx,DashboardPage.tsx}`, `src/App.tsx`, `src/data/ipc.test.ts`; `src-tauri/src/{share.rs,photos.rs,commands.rs,lifecycle.rs,safety_copy.rs,schema.rs}`; `src-tauri/share/{share.html,_snapshot.js}`.
- **Method:** Read primary scoped implementations and relevant tests in full; inspected the requested SettingsPage/App.tsx sections and caller/renderer seams; traced input and lifecycle behavior; compared candidates against prior findings available in Batches 2–7 and the exclusions supplied for Batches 1–7. No source changes were made. Tests were read but **not run**.

## Findings

### I1 — Med-high — The thumbnail pixel ceiling is enforced only after the full image decode

**Location:** `src/lib/thumbs.ts:91–107,121–136,144–161`; callers `src/pages/GalleryPage.tsx:131–139,206–221`; tests `src/lib/thumbs.test.ts:116–145`.

`makeThumbnail` checks encoded byte length before decoding (`thumbs.ts:148–155`), but waits for `decode(blob)` before passing the decoded dimensions to `assertThumbableSource` (`:155–160`). Both decoder paths materialize/decode first: `createImageBitmap` (`:61–70`) or `Image.decode()` (`:75–88`). The 150-million-pixel check is therefore reached only at `:132–135`, after the decoder has reported dimensions. This contradicts the nearby comment that the check uses the declared dimensions to refuse the decoder allocation (`:106–107`). Gallery calls this helper for newly picked photos and lazily for photos without a stored thumbnail (`GalleryPage.tsx:131–139,216–221`).

**Impact:** A small crafted image can declare enormous dimensions and reach the full-resolution decoder before the pixel ceiling runs. If the webview attempts that raster allocation, thumbnail generation can exhaust renderer memory or crash the app; the post-decode check cannot prevent that allocation. This is distinct from the encoded-byte check and from the native save-size ceiling.

**Fix direction:** Inspect and bound dimensions before full raster decode, or use a decode path with a reliable pre-allocation/downscale limit; keep the post-decode check as defense in depth. Add an ordering test that proves an over-pixel-limit source is rejected before either decoder is called.

**Test evidence:** `thumbs.test.ts:116–125` calls the guard with supplied dimensions, proving its arithmetic only. `:127–145` asserts the byte check precedes decode, but asserts decoded dimensions only afterward; it does not pin a pre-decode pixel check.

### I2 — Medium — The Gallery buffers an arbitrarily large selected file before Rust enforces the 25 MiB save limit

**Location:** `src/pages/GalleryPage.tsx:206–223`; native limit `src-tauri/src/commands.rs:338–351`; parity test `src/data/ipc.test.ts:101–118`.

For each selected file, `pickFiles` first executes `new Uint8Array(await file.arrayBuffer())` (`GalleryPage.tsx:210–211`) and only then calls `galleryRepo.savePhoto` (`:212–215`). There is no `file.size` preflight. Rust does reject a body above `MAX_SAVED_PHOTO_BYTES` (25 MiB) before hashing, writing, or lifecycle admission, but that check is after the complete request body has been read (`commands.rs:338–351`). The IPC test pins the Rust/backup limit parity and native refusal; it does not cover renderer-side file reading (`ipc.test.ts:101–118`).

**Impact:** Choosing a very large image can allocate the entire file in the renderer and transfer it through IPC before the 25 MiB refusal. That can freeze or exhaust renderer memory even though the photo is not saved. This is **not** E6: the current native check prevents an oversized photo from being persisted or making an export unrestorable; this finding concerns memory consumed before that check.

**Fix direction:** Check `File.size` against the same 25 MiB limit before calling `arrayBuffer()`, show the existing size refusal at the picker boundary, and retain the Rust check as the authoritative backstop.

**Test evidence:** `src/lib/gallery.test.ts:23–40,68–83` pins duplicate-byte handling and raw `Uint8Array` transfer through the repository, not picker-side size preflight; `src/data/ipc.test.ts:101–118` pins the native/backup cap parity.

### I3 — Medium — Share row limits are applied after most source reads, not in SQL

**Location:** `src/lib/share.ts:74–87,141–186,241–269`; repository queries `src/lib/budget.ts:697–709`, `src/lib/business.ts:355–376`, `src/lib/tasks.ts:226–231,288–294`, `src/lib/memories.ts:77–83`, `src/lib/contacts.ts:176–178,357–367`, `src/lib/notes.ts:48–85,150–171`; tests `src/lib/share.test.ts:81–127,256–305`; ticker wiring `src/App.tsx:246–265,706`.

`share.ts:241–246` says each section is capped in SQL. In fact, the `SHARE_LIMITS` slices in `buildShareSnapshot` (`:151–186`) bound the **published arrays**, while several reads at `:259–268` are unbounded:

- `listDayEntries(today)` reads every transaction for that date before totals are computed (`budget.ts:698–708`); `listJobs("open")` reads every open job before warranties are filtered/capped (`business.ts:355–364`); `listReceivable()` returns every open receivable job even though the share only reduces the rows to one total (`business.ts:367–376`, `share.ts:276–279`).
- `dueTasks`, `dueReminders`, and `memories.upcoming` have no SQL limit (`tasks.ts:226–231,288–294`; `memories.ts:78–83`), although the builder later slices their results (`share.ts:156–173`).
- `upcomingBirthdays` loads `SELECT * FROM contacts` for all contacts and filters in JavaScript (`contacts.ts:176–178,359–367`), before the builder takes at most 20 names.
- Notes are limited to 20 rows, but `share.ts:267` explicitly requests `projection: "full"`; it reads each selected note's complete body even though the snapshot only uses `noteExcerpt`, which returns at most 140 characters (`notes.ts:48–85,162–170`; `share.ts:182–185`).

The ticker runs every 30 seconds while sharing is active (`App.tsx:250–265`). The test named “capped in SQL” verifies `LIMIT` only for notes, wallets, and habits (`share.test.ts:256–305`); the builder tests separately verify post-read output slicing (`:81–127`).

**Impact:** With a large library, each tick transfers and processes all matching tasks, reminders, memories, contacts, jobs, receivables, and day entries, plus full bodies for up to 20 notes. Work and transient renderer memory therefore grow with the database rather than the published snapshot size, despite the bounded-glance contract. The read-side over-fetch does not mean these extra fields are sent to the phone; the builder selects a smaller payload.

**Fix direction:** Push row caps and projections into the repository queries, query birthdays directly with the date predicate and a defined order/limit, use SQL aggregates for totals, and request a bounded note projection. Add assertions for the SQL bounds/projections of every ticker read, not only wallets, habits, and notes.

### I4 — Medium — A single valid long text field can exceed the share server's encrypted-envelope byte cap

**Location:** `src/lib/share.ts:54–71,74–87,151–186,293`; CSV/task import `src/lib/csv.ts:24,113–125`, `src/lib/taskImport.ts:76–124`; native cap and refusal `src-tauri/src/share.rs:55–57,412–429,513–519`; publisher error handling `src/lib/session.ts:218–245`.

`SHARE_LIMITS` bounds row counts only. `buildShareSnapshot` copies text such as task/reminder titles, habit and memory names, birthday names, warranty titles, and note titles without a UTF-8 byte limit (`share.ts:151–186`). The CSV importer accepts files up to 5 MiB (`csv.ts:24,113–125`), and `mapTaskRows` only trims/rejects an empty title; it has no per-field length limit (`taskImport.ts:76–88,117–123`). Thus a due task that falls within the ten published rows, with an approximately 400 KiB ASCII title, is a valid import, is copied into the snapshot, and fits within the CSV file cap. `encryptSnapshot` base64-encodes the ciphertext into the outer JSON envelope (`share.ts:54–71`), so that envelope can exceed Rust's 512 KiB `MAX_SNAPSHOT_BYTES`; `parse_snapshot` rejects it before replacing the stored snapshot (`share.rs:55–57,412–429,513–519`).

**Impact:** At initial sharing, publication can fail and the phone has no snapshot. After a prior successful publication, repeated rejection leaves the last good ciphertext in place; the 30-second ticker catches publish errors and retries without surfacing them as a stopped server (`session.ts:218–245`). The link can therefore keep showing stale data while the overlong value remains in the library.

**Fix direction:** Enforce per-field and/or total UTF-8 byte budgets before encryption, accounting for AES-GCM and base64 envelope overhead so every app-produced envelope stays below the Rust cap. Add a test using a valid oversized CSV-mapped task. Consider a distinct stale-publication warning or clearing the stale snapshot on persistent invalidation, without misreporting it as a stopped listener.

## DECISION — test-pinned behavior requiring an owner choice

### Decision 1 — Are sparse current-format backup manifests supported, or are they corrupt full-replacement backups?

`parseBackupJson` accepts absent table keys as zero rows (`src/lib/backup.ts:528–541`), and the current-version branch of `upgradeBackupData` returns that payload unchanged (`:321–324`). `applyBackup` nevertheless deletes every table in `BACKUP_TABLES` and inserts `data[table] ?? []` (`:761–767`); the summary always reports all 31 tables (`:651–661`). The tests pin sparse current-version payloads: `samplePayload()` contains only `notes` and `photos` (`src/lib/backup.test.ts:78–85`), the parser round-trips that sparse payload (`:432–441`), and the apply test uses it while asserting 31 table deletions and a two-row result (`:679–718`). The summary test also asserts 31 tables for that fixture (`:1024–1032`).

**Impact:** A syntactically valid, hand-edited or incomplete current-format manifest with a missing table key is interpreted as an empty table and can delete that table's current rows when the user confirms the full replacement. Settings does warn that continuing replaces all current data and creates a safety copy first (`SettingsPage.tsx:493–510`; `i18n.ts:467–468`), but it does not identify the absent keys as malformed; it can also describe a sparse manifest as “31 tables.”

**Decision needed:** Should a current-format backup require every current table key, with only explicitly versioned upgrades filling tables that did not yet exist? Or is a sparse table map intentionally a supported full-replacement input whose missing keys mean empty? If the former, tighten current-version validation and update the sparse fixtures; if the latter, make that format/summary semantics explicit. This is recorded as a decision rather than an unpinned bug because the tests currently accept and apply sparse payloads.

### Decision 2 — Should locking invalidate an in-flight LAN share start?

`SettingsPage.startShare` awaits `shareRepo.start()` and then publishes, with no cancellation check if the page unmounts (`src/pages/SettingsPage.tsx:611–631`; `src/lib/share.ts:218–221`). Locking sets the shell locked and immediately schedules `shareRepo.stop()` (`src/App.tsx:603–630`), while the publisher timer is paused for the locked workspace (`:246–265,706`). At the Rust boundary, `start()` consumes consent and proceeds to bind (`src-tauri/src/share.rs:273–281,286–297`); ordinary `stop()` only removes the server currently in its slot (`:343–353`). The lifecycle gate used there covers import/reset phases, not the renderer's locked state (`src-tauri/src/lifecycle.rs:237–247`). Most directly, the Rust unit test asserts that a token remains usable after ordinary `stop()` (`share.rs:1016–1025`).

**Interleaving:** `shareRepo.start()` awaits `share_arm` and then `share_start` (`share.ts:218–221`). If lock's ordinary stop runs after the arm but before the start has bound, stop can return with no server to remove; the still-pending token (or a start already past token consumption) can then bind on `0.0.0.0` after the shell has locked. The direct `SettingsPage` continuation is not cancelled by the paused ticker. That would contradict `lockSession`'s rule that locking ends sharing (`src/lib/session.ts:143–160`). This is distinct from E2's factory-reset barrier, which is keyed to reset lifecycle, and H4's stale teardown retry killing a newly started share after unlock; it is not a claim that either prior fix regressed.

**Decision needed:** Should lock cancel every pending/in-flight share start, or may a start the user already confirmed complete after lock? If locking must win, use an atomic lock/share generation or serialized backend transition (or a dedicated lock-stop that revokes pending consent and prevents late binds) and pin the lock-vs-start interleaving in a test. The existing test-pinned ordinary-stop consent behavior means this should not be changed silently.

## Checked-clean areas

- **Backup encryption/container:** The fixed header validates supported version/KDF/cipher/iteration parameters before derivation; the header is authenticated as AES-GCM AAD, and exports use fresh salt/IV (`src/lib/backupContainer.ts:8–22,128–185,196–227,230–255`). The tests cover tampering, wrong passwords, parameter refusal, and fresh salt/IV (`backupContainer.test.ts:150–194,302–312`). The Settings importer checks `File.size` before `arrayBuffer()` and the encrypted-input cap precedes decryption (`SettingsPage.tsx:443–475`; `backup.ts:75–80`). No new container-crypto issue was verified.
- **Contact/task CSV handling and formula safety:** File-size/row caps, mapping, preview-before-write, and one-batch inserts were checked in `csv.ts`, the import mappers, `ImportDialog.tsx:124–171`, and the Contacts/Tasks callers (`ContactsPage.tsx:868–920`; `TasksPage.tsx:505–547`). Formula-prefix neutralization and export→import round trips are covered by `exports.ts:307–339` and `exports.test.ts:257–285,364–406`; no formula-injection issue was verified.
- **Readable-export disclosure:** `ExportsPage` tells users that readable exports exclude photo files, Vault ciphertext, settings, and Trash (`src/pages/ExportsPage.tsx:160–163`). No separate disclosure or export-scope issue was verified.
- **Note reader:** The list projection is capped, but `NotesPage` fetches the selected note through `getNote()` before constructing the reader view (`notes.ts:150–171`; `NotesPage.tsx:548–588`). `resolveReaderView` keeps the full selected/editor content, and the dialog renders `note.content` (`noteReader.ts:92–115`; `NoteReaderDialog.tsx:208–215`). No truncated-reader-content issue was verified.
- **Share disclosure/rendering:** The snapshot builder emits a fixed set of fields and its test pins the exact keys (`share.ts:115–139`; `share.test.ts:151–170`). Vault/settings/photo bytes and Trash are not inputs or snapshot fields; the default note query excludes archived notes (`notes.ts:158–170`). The Settings acknowledgement explicitly says anyone with the link can decrypt the snapshot (`SettingsPage.tsx:1253–1261`); the phone page reads the key from the URL fragment and removes it from browser history (`src-tauri/share/share.html:152–155`), and renders user values with `textContent`, not `innerHTML` (`:143–161,184–201`). The shared decryptor validates a 64-character hex key and authenticates the envelope version/timestamp (`src-tauri/share/_snapshot.js:21–69`). No additional hidden-field or markup-injection disclosure was verified.
- **Previously reported photo boundaries:** The native 25 MiB save refusal remains before hashing/writing (`commands.rs:338–351`), so E6 is not re-reported. Batch 5 E8 concerned the safety-copy/reset symlink boundary; the current safety copy refuses linked roots and linked descendants (`safety_copy.rs:124–143,230–250`). Ordinary `photos.rs` path operations remain within the prior E8 discussion; no distinct new regression was verified here.

## Resolutions (decided by Muus, delegated by the owner 2026-10-29)

The DECISION items above are genuine behaviour choices. Both are settled
here; the original DECISION wording is preserved above.

- **Decision 1 — option (a): require every current table key.** A
  current-format backup must contain all 31 `BACKUP_TABLES` keys as
  arrays; a missing key is rejected as a corrupt/incomplete backup,
  not treated as an empty table. Rationale: the app's own exporter
  always writes all 31 keys, so a current-format manifest missing keys
  is by construction not app-produced — it is hand-edited or truncated.
  The current silent behaviour (wipe the missing tables on apply) is the
  dangerous direction; fail-closed with a clear "backup is incomplete"
  error is safer. The versioned-upgrade path is untouched: older
  versions still gain new tables as empty arrays in `upgradeBackupData`;
  only the current-version branch gets strict. Cost: update the sparse
  synthetic fixtures in `backup.test.ts` (add the missing keys as empty
  arrays).
- **Decision 2 — option (a): lock wins.** Locking must invalidate any
  in-flight LAN share start: a listener binding on `0.0.0.0` after the
  shell locked is the sharpest possible violation of `lockSession`'s
  pinned rule "locking ends sharing" — the user locked the app believing
  nothing serves. The consent was given pre-lock, but the security
  expectation at lock time dominates. Fix direction: bind the consent
  token to a lock epoch at arm time (or a dedicated lock-stop that
  revokes pending consent); `start` refuses tokens from a superseded
  epoch under the server lock, following the E2 re-check pattern.
  Ordinary stop/start token semantics stay exactly as pinned
  (`share.rs:1016–1025`) — only the lock path changes. The renderer
  needs no structural change: the existing `catch` in
  `SettingsPage.startShare` surfaces the refusal.

## Fix-wave note (3 commits, order 1→2→3)

- Commit 1 = I1 + I2 (photo pipeline: `thumbs.ts`
  pixel-ceiling-before-decode; `GalleryPage.tsx` picker `file.size`
  preflight against the 25 MiB limit; tests).
- Commit 2 = D1(a) (backup current-version strictness: `backup.ts`;
  update the sparse fixtures in `backup.test.ts`).
- Commit 3 = I3 + I4 + D2(a) (share subsystem: SQL caps/projections for
  every ticker read — `share.ts` plus `budget.ts`, `tasks.ts`,
  `memories.ts`, `contacts.ts`, `notes.ts`; UTF-8 byte budgets before
  encryption in `share.ts`; lock-epoch share start in `share.rs` +
  `share.ts`; extend the "capped in SQL" test to all reads; tests).

Commits 1 and 2 are independent; commit 3 is the share-subsystem commit
(I3, I4 and D2 share `share.ts`). `npm run verify` green before each
commit.
