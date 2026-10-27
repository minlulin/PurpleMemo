# Purple Memo — Rust backend audit, Batch 5

**Base:** `dev` at `5371e7be6fe55c0f18892232f7184fe472062422` (`5371e7b`).

**Working branch:** `arena/2db2b345-purplememo`.

**Scope:** `src-tauri/src/lib.rs`, `reset.rs`, `commands.rs`, `safety_copy.rs`, `file_write.rs`, `navigation.rs`, and `main.rs` (all seven read completely, including their in-file tests, in that order).

**Method.** Traced their relevant imports, registrations, Tauri invokes, the TypeScript driver, and the relevant reset, gallery, share and backup callers. Inspected the applicable tests and the earlier F1–F12, B1–B14, C1–C6 and D1–D12 reports. Those earlier findings are not repeated; no regression is asserted here. The observations below distinguish source-traced interleavings from the two limited reproductions listed at the end. No source or version files were modified in this audit.

## Findings

### E1 — A completed reset can be followed by photo writes — **High**

**Evidence.** `src-tauri/src/commands.rs:247-264` obtains the date under the DB lock but drops that lock before dispatching `photos::save_photo`; `:297-304` dispatches a thumbnail write without checking the DB connection at all. `src-tauri/src/photos.rs:43-80,105-109,183-195` serializes photo writers with a separate mutex and creates missing directories. The reset wrapper at `src-tauri/src/commands.rs:478-494` calls `run_factory_reset` without draining those jobs or taking that mutex; `src-tauri/src/reset.rs:238-269` deletes the photo tree and can return `complete: true`. Gallery operations issue these asynchronous calls through `src/lib/gallery.ts:187-207,282-287` and `src/pages/GalleryPage.tsx:206-222`; the terminal reset screen is installed only after the reset invoke resolves (`src/pages/SettingsPage.tsx:759-773`).

**Defect.** A save that has passed its date lookup can be delayed until after the reset removed `photos/`, then create it and write the original. A previously dispatched thumbnail write can do the same; the thumbnail command also remains callable after the connection has been taken. The photo mutex does not protect reset deletion.

**Impact.** The reset can report success while original or thumbnail image bytes reappear in app-data, contrary to the reset's deletion guarantee. This is an interleaving derived from the code, not a Rust integration test.

**Fix direction.** Introduce a reset/lifecycle barrier that rejects new filesystem work and drains or cancels already-admitted photo and safety-copy workers before deleting and reporting completion; keep post-reset photo commands fail-closed.

### E2 — Reset can miss an already-authorized share start — **Med-high**

**Evidence.** Reset stops sharing first (`src-tauri/src/commands.rs:488-493`, `src-tauri/src/reset.rs:229-250`). `share_start` delegates to `ShareState::start` (`src-tauri/src/commands.rs:420-437`); that method consumes consent before acquiring the server lock (`src-tauri/src/share.rs:225-252`). `stop_for_reset` separately stops the current server and clears pending consent (`src-tauri/src/share.rs:311-333`); it does not exclude a start that has already consumed its token. The start later binds and publishes a new running state (`src-tauri/src/share.rs:263-295`), and `publish` can put a prepared snapshot into that server (`src-tauri/src/share.rs:350-369`).

**Defect.** If a start consumes consent, reset observes no running server and no pending consent, and then the delayed start binds, reset has no later check that stops it. The frontend does not install its terminal screen until reset resolves (`src/pages/SettingsPage.tsx:759-773`).

**Impact.** A listener can remain active after a successful reset until it is otherwise stopped or the process exits; a delayed publication can leave a previously prepared snapshot available. The endpoint serves ciphertext: decrypting it requires the key used for that payload, so this is not a claim of unconditional plaintext disclosure. A late start can also recreate the share audit log after log deletion (`src-tauri/src/lib.rs:650-667,690-697`).

**Fix direction.** Make reset and consent consumption/start/publication mutually exclusive through a shared lifecycle state, and prevent any start admitted before reset from becoming live after the stop barrier.

### E3 — An interrupted reset has no cross-process recovery state — **Med-high**

**Evidence.** `src-tauri/src/reset.rs:63-73,198-269` performs separate removals, with the database before photos, backups, logs and the key; the outcome exists only in memory. Its retry test (`:729-760`) reruns the engine in the same process, not after process death. `src-tauri/src/lib.rs:161-173` boots directly from the data directory and keyring without consulting a reset-in-progress record. A still-present key is reused (`src-tauri/src/db.rs:173-180`), and `open_encrypted_db` uses a creating open (`:475-485`). The frontend can then see a fresh database without a PIN and offer setup (`src/App.tsx:277-279,706-711`).

**Defect.** If the process or machine stops after database deletion but before the remaining steps, the next boot cannot distinguish this from first run. With the old key still in the keyring it can create a fresh DB using that key, while old photos or safety copies remain. No completed outcome is emitted in the crash itself.

**Impact.** A user returning after an interrupted erasure can see first-run setup without a report of the residual data/key; private files can remain, and the intended reset must be initiated again. This is distinct from a reported successful reset.

**Fix direction.** Provide durable, crash-recoverable reset progress or an equivalent boot-time refusal/recovery mechanism so an interrupted attempt is visible and can be finished before ordinary first-run initialization. Preserve the documented key/DB ordering and obtain owner approval for any change to the no-creation reset invariant (`src-tauri/src/reset.rs:20-31`).

### E4 — A busy WAL checkpoint can produce a stale safety database — **High**

**Evidence.** `src-tauri/src/commands.rs:381-390` runs `PRAGMA wal_checkpoint(TRUNCATE)` through `execute_batch` and checks only for an error; `src-tauri/src/safety_copy.rs:84-98` copies only the main DB file. The pinned rusqlite dependency is `0.40.2` (`src-tauri/Cargo.toml:24`); its [`execute_batch`](https://github.com/rusqlite/rusqlite/blob/v0.40.2/src/lib.rs#L548-L566) steps a result-producing PRAGMA but discards the returned row. `src-tauri/src/db.rs:489-496` explicitly acknowledges possible external file readers. The source pin at `src-tauri/src/safety_copy.rs:280-321` checks order and lock scope, not checkpoint completion.

**Defect.** SQLite can return a successful checkpoint statement with a nonzero busy status and committed frames still in the WAL. The command ignores that status and calls the main-file copy successful. The in-process connection mutex also cannot exclude an external SQLite writer/checkpointer.

**Impact.** Import proceeds to replace the live database (`src/pages/SettingsPage.tsx:500-510`, `src/lib/backup.ts:720-749`), but its advertised undo copy can lack committed rows, or be inconsistent if another process modifies the main file during copying. A targeted ordinary-SQLite reproduction below returned busy and copied zero rows while the live DB contained one; it did **not** execute SQLCipher or the Rust command.

**Fix direction.** Use a SQLite/SQLCipher-consistent snapshot mechanism that includes committed WAL state and coordinates with external connections; at minimum treat an incomplete checkpoint as failure and abort import rather than treating the main file as a complete copy.

### E5 — The safety copy and destructive import do not form one exclusion window — **High**

**Evidence.** `src-tauri/src/commands.rs:381-394` releases the DB lock after copying the DB and before copying photos. `src-tauri/src/safety_copy.rs:17-22` assumes no command writes the photo tree mid-import. The UI awaits the copy and then separately invokes replacement (`src/pages/SettingsPage.tsx:493-510`); `applyBackup` later deletes all tables (`src/lib/backup.ts:720-749`). Meanwhile quick capture remains available from the sidebar and shortcut (`src/App.tsx:397-416,619-625,761-782`). Photo operations have their own lock, not an import-wide one (`src-tauri/src/photos.rs:25-31`; `src-tauri/src/commands.rs:247-264,297-304`).

**Defect.** A capture or other write can commit after the DB file is copied but before the import's delete batch. Concurrent photo saves/deletes can likewise change the tree while it is copied. The `safety_copy.rs:280-321` test intentionally pins the photo copy *outside the connection lock*; it does not pin the absence of a separate lifecycle barrier.

**Impact.** A quick capture can show “saved” and then be deleted by import, yet be absent from both the imported archive and the safety copy. A copied photo tree can also disagree with the DB snapshot. These are source-traced interleavings, not an end-to-end race reproduction.

**Fix direction.** Quiesce all relevant DB and photo writers from the snapshot boundary through replacement and cleanup, or implement an equivalent consistent snapshot/replacement protocol. A separate lifecycle barrier can preserve the test-pinned short DB-lock scope.

### E6 — A successfully saved photo can make an exported backup unrestorable — **Med-high**

**Evidence.** `src-tauri/src/commands.rs:247-264` accepts the raw photo bytes without a per-photo size limit; the gallery picker likewise reads the selected file without one (`src/pages/GalleryPage.tsx:206-215`). The export budget checks only total photo bytes (`src/lib/backup.ts:196-211,214-237`), whereas inspection rejects any one photo over 25 MiB (`src/lib/backup.ts:61-66,579-589`), a rejection pinned by `src/lib/backup.test.ts:325-342`. The save flow calls `backup_save_file` after export and reports success (`src/pages/SettingsPage.tsx:398-424`; `src-tauri/src/commands.rs:354-363`). Replacement of an existing destination is explicitly pinned (`src-tauri/src/file_write.rs:94-107,264-270`).

**Defect.** A photo accepted by the scoped command can pass export's aggregate budget while producing an archive the same app refuses to inspect or restore. A mocked driver reproduction below exported a 25 MiB + 1-byte photo successfully and inspection rejected it; it did not run the native photo writer or use a real image.

**Impact.** The user can be told a backup was saved but discover only on restore that it is unusable. If they selected an existing backup file, the unusable archive may have replaced the previous one.

**Fix direction.** Keep the tested importer limit unless the owner changes it; enforce compatible limits when accepting photos and/or validate exportability before any destination is replaced, with an actionable refusal for existing oversized libraries.

### E7 — The pre-import copy is not made durable before destruction — **Med**

**Evidence.** The scoped safety-copy path uses `fs::copy` for the DB and each photo, creates directories, and writes the README (`src-tauri/src/safety_copy.rs:84-113,118-166,169-190`); it has no explicit file or directory sync before returning. `src-tauri/src/commands.rs:381-398` treats that return as success, after which `src/pages/SettingsPage.tsx:503-510` starts replacement. In contrast, the separate export writer explicitly syncs its temp file before rename (`src-tauri/src/file_write.rs:91-100`).

**Defect.** A successful filesystem copy means the bytes were handed to the OS, not that the copied files and their directory entries are durable against an OS crash or power loss. The destructive import is not gated on a durable safety copy.

**Impact.** After replacement has committed, a sudden system failure can leave the supposedly recoverable copy missing or incomplete. This is a durability guarantee gap; no power-cut test was run, and an ordinary process crash alone does not establish this outcome.

**Fix direction.** Use a documented durable-copy protocol, including appropriate file and directory synchronization and error propagation, before allowing the destructive phase to start.

### E8 — Symlinked photo trees are inconsistently copied and reset — **Med**

**Evidence.** `src-tauri/src/safety_copy.rs:108-110` uses `is_dir` on the `photos` root, which follows a root symlink; its descendant walk deliberately skips symlinks (`:143-164`). The photo writer joins its path and uses ordinary directory/file operations (`src-tauri/src/photos.rs:62-79,105-109`), so an externally installed linked directory can be used by the live library. Reset reports the result of `remove_dir_all` for the photos root (`src-tauri/src/reset.rs:252-253,294-306`); Rust's [`remove_dir_all`](https://github.com/rust-lang/rust/blob/1.77.2/library/std/src/fs.rs) removes a symlink rather than traversing its target.

**Defect.** A linked `photos/` root can be followed into an external tree by the safety copy, contrary to the walk's no-follow rationale; a linked descendant used by the live library is instead silently omitted. Reset can remove the link and report the component removed while the linked target remains outside app-data.

**Impact.** With a pre-existing, user- or locally-installed symlink, the safety copy can contain unexpected external files or omit photos that the app could read. A reset can leave those external originals behind. This does not claim that a normal install creates symlinks or that external targets should be deleted automatically.

**Fix direction.** Define and enforce one symlink policy at the root and every level. Prefer rejecting/reporting unsupported linked trees before a destructive operation; do not follow and delete arbitrary external targets.

### E9 — A failed first schema initialization can strand the newly created DB — **Med**

**Evidence.** `src-tauri/src/lib.rs:161-180` mints/loads a key, opens the DB, runs schema initialization, and on *either* open or schema failure discards a freshly minted key. The open creates a file and enables WAL (`src-tauri/src/db.rs:475-498`); the existing test at `:1108-1114` asserts that opening a new encrypted DB produces a nonempty file. On the next attempt, a nonempty file without a key is refused rather than re-keyed (`src-tauri/src/db.rs:169-188,441-445`).

**Defect.** If the fresh open succeeds but baseline initialization fails, for example because storage fills during schema creation, the file can remain while its only key is deleted. Retry now takes the missing-key recovery path even though the user has never had an opportunity to export that freshly minted key.

**Impact.** A recoverable first-run setup failure can become a persistent startup failure requiring manual cleanup/recovery of the newly created file. This is not a claim that an established user's existing database is erased.

**Fix direction.** Distinguish failure to verify from failure after a newly created DB has been verified; preserve a recoverable key/file pair or safely clean up only a provably new, uncommitted DB before discarding its key.

### E10 — A failed key export can leave a plaintext key without an audit entry — **Med**

**Evidence.** `src-tauri/src/lib.rs:45-47,670-677` describes the key-disclosure log; `src-tauri/src/commands.rs:315-332` delegates the user-chosen file export. `src-tauri/src/db.rs:371-392,418-435` writes and syncs the key in a random temp sibling, retains that completed temp on rename failure, and records an export only after a successful rename. On Unix the temp is owner-only; the returned error explicitly names it (`:425-432`). The existing cleanup test (`:1493-1512`) fails before a temp is created, and the stale-temp test (`:1431-1453`) does not exercise the late-rename failure.

**Defect.** A late rename failure has already placed the complete plaintext master key outside the credential store, but the disclosure is not recorded in `key-export.log`. The user did authorize export and receives the temp path in the error; this is not a claim of an unconsented export.

**Impact.** A retained key file can be overlooked later and is missing from the audit trail. Files at user-chosen external destinations are not covered by factory reset's app-data removal (`src-tauri/src/reset.rs:3-18`).

**Fix direction.** Record the actual retained temp destination when a completed key file survives an error, or securely remove it and report any cleanup failure. Keep the error actionable and do not log the key bytes.

### E11 — Key restore can verify a newly created DB instead of the missing one — **Low-med**

**Evidence.** The recovery flow promises to prove the key against the DB before storing it (`src-tauri/src/lib.rs:328-336,366-374`), but passes the path to `restore_db_key_from_file`, which calls the ordinary creating open (`src-tauri/src/db.rs:246-260,475-485`). A missing-key dialog is offered after a nonempty DB was observed (`src-tauri/src/db.rs:173-185,441-445`); there is no corresponding existence/nonempty check at the restore call.

**Defect.** If that DB is moved, deleted or replaced with an empty file while the recovery dialog is open, the ordinary open can create/initialize an empty SQLCipher DB under any well-shaped candidate key. The `sqlite_master` probe then cannot prove that the candidate opens the original database, yet the flow stores it.

**Impact.** Recovery can appear successful and start an empty workspace with the wrong key in the credential store. The original data must already have disappeared or been replaced for this path; it is not an assertion that selecting a wrong key opens an intact encrypted DB.

**Fix direction.** Verify the existing nonempty target with a non-creating open and fail closed if it changes or disappears; keep first-run creation separate from recovery.

### E12 — The break-glass transaction reset clears only the flag — **Low-med**

**Evidence.** `src-tauri/src/commands.rs:189-191,215-231` says that after commit and rollback both fail, `db_reset_txn` clears the flag and the uncommitted rows are lost; the implementation drops the connection guard, sets the flag to false, and never checks or rolls back SQLite's transaction. `db_batch` trusts that flag (`src-tauri/src/commands.rs:146-156`) and then runs `BEGIN` (`src-tauri/src/db.rs:983-1002`). Single writes use the same connection (`src-tauri/src/commands.rs:129-137`). The command is registered and exposed by the driver, but the source says no current app code calls the manual transaction commands (`src-tauri/src/lib.rs:106-113`, `src-tauri/src/commands.rs:162-169`, `src/data/driver.ts:159-165`).

**Defect.** If a failed rollback leaves the actual transaction open, clearing the flag does not end it or discard its rows. Subsequent batches can fail to begin, and single writes can enter the abandoned transaction despite the false flag; clearing the flag outside the mutex also breaks the other commands' flag/connection synchronization rule.

**Impact.** A future or direct IPC user of this retained break-glass API can get an apparently reset transaction state while later writes are uncommitted and may be lost when the connection closes. No production TypeScript caller was found, so this is not presented as a current ordinary-UI data-loss path.

**Fix direction.** Keep transaction state changes under the connection lock and reconcile with SQLite's actual autocommit state; roll back or close/reopen as appropriate, or fail with a restart-required error rather than declaring the transaction cleared.

### E13 — The boot watchdog can expire after the user has answered — **Low**

**Evidence.** A 600-second watchdog is armed for the boot-failure dialog (`src-tauri/src/lib.rs:22-27,267-285`). Retry immediately starts boot work and Restore opens a file picker without retiring that timer (`:288-325,337-350`); only successful boot or a newly shown dialog increments its generation (`:345-352,384-401`). The watchdog checks the generation before an unconditional exit (`:405-425`), although its comment says it measures only time waiting on the current dialog (`:405-412`).

**Defect.** A user who answers near the deadline can have a retry or file picker interrupted by the old timer. There is also a final check-to-exit window in which successful recovery can increment the generation after the last check but before the exit.

**Impact.** A slow, otherwise recoverable startup or key selection can be terminated with the misleading “no answer” message. The issue requires the long watchdog interval or a narrow final race; it was not time-tested in the sandbox.

**Fix direction.** Retire or transition the watchdog when a dialog is answered, handle the picker/retry as their own states, and synchronize the final exit with recovery.

### E14 — Newlines in key-file paths can forge audit-log lines — **Low**

**Evidence.** The scoped key-save command accepts a renderer-supplied path (`src-tauri/src/commands.rs:315-332`); restore also records a picked path (`src-tauri/src/lib.rs:366-374,680-687`). The formatted paths are passed through `key_export_audit_line` / `key_restore_audit_line` (`src-tauri/src/db.rs:212-217,280-285,425-435`) and written verbatim by `append_audit_line` (`src-tauri/src/lib.rs:650-667,670-687`).

**Defect.** On filesystems permitting newline or carriage-return characters in a filename, one chosen key path can inject additional apparent lines into the timestamped audit log. The log is explicitly best-effort and is not an access-control boundary (`src-tauri/src/lib.rs:650-654`).

**Impact.** An unusual or deliberately named key file can make later human inspection of the disclosure/restore history misleading. This does not imply a remote attacker can choose the path or read the key.

**Fix direction.** Escape control characters or use a structured, unambiguous record format while retaining the destination and excluding key material.

## Checked clean / bounded observations

- The 23 driver invoke names and registrations match in the targeted contract tests (`src/data/ipc.test.ts:1-5,42-68`; `src-tauri/src/lib.rs:106-130`). This is a source-shape check, not proof that workers quiesce during reset.
- SQL query, execute, batch and manual-transaction commands take and validate the connection guard; once reset has taken the connection, they refuse rather than dereferencing a missing connection (`src-tauri/src/commands.rs:68-115,118-231`; test at `:515-531`). This does not extend to the separate photo/share operations in E1–E2.
- Reset aborts on a failed share stop or DB removal and does not delete the key after that abort (`src-tauri/src/reset.rs:97-103,229-250`; tests at `:480-522,550-653`). Failed or unattempted components prevent `complete` (`:267-273`). The post-DB failure policy is called out below rather than relabeled a bug.
- The safety-copy operation is specifically a pre-import safeguard, not a universal guard for every SQL writer (`src-tauri/src/commands.rs:129-159,366-398`; `src/pages/SettingsPage.tsx:500-510`). Factory reset deliberately removes the local safety-copy tree (`src-tauri/src/reset.rs:63-73,252-263`); no claim is made that every other destructive workflow has an automatic safety copy.
- Export writes use a random exclusive temp and atomic rename, with the completed temp named on a late rename failure (`src-tauri/src/file_write.rs:62-107`); accepting renderer-chosen destinations is a documented trust decision (`src-tauri/src/file_write.rs:18-23`, `docs/RELEASE.md:257-289`), not a standalone path-traversal finding.
- Safety-copy labels are whitelisted into one component and destination directories are created without reusing an existing copy (`src-tauri/src/safety_copy.rs:47-70,116-140,324-344`); the separate symlink caveat is E8.
- Ordinary Markdown external links are intercepted and sent to the system opener (`src/components/MarkdownLink.tsx:17-35`); the navigation guard blocks non-allowed origins (`src-tauri/src/navigation.rs:66-101`). The guard logs the full blocked URL (`:96-99`), but no normal Markdown click was established to reach that log with a secret-bearing URL, so no practical leak is asserted on that basis.
- The key-save command returns no key to the webview (`src-tauri/src/commands.rs:323-332`); the late-failure file and audit gap is E10. `main.rs:1-6` only delegates to the library entry point; no independent issue was found there.

## DECISION — tested policies requiring an owner choice

1. **Delete the key after a photo/backup/log removal failure?** `src-tauri/src/reset.rs:20-28,97-103,252-263` continues after these failures, and `:655-683,686-727` pins continued key deletion and an incomplete result. If the safety-copy tree could not be removed, its encrypted DB may be left without the key needed to recover it, unless the user has an exported key. Decide whether to keep prioritizing irreversible deletion after the live DB is gone, or retain the key when recoverable encrypted backups remain. Do not change the tested policy silently.
2. **Bounded share stop versus draining already-started responses.** Reset uses `stop_for_reset` (`src-tauri/src/commands.rs:488-491`). The listener is reaped, but request workers are deliberately not joined (`src-tauri/src/share.rs:396-410,557-565`), and a worker may already have cloned ciphertext (`:676-680`); `:789-821` pins a stop that does not wait on a stalled client. Decide whether bounded shutdown is sufficient, or whether cancellation/draining of already-authorized in-flight responses is required. This is distinct from E2's newly started listener and does not establish a fresh plaintext disclosure.
3. **The import's separate FK toggles permit interleaving.** Scoped `db_execute` and `db_batch` acquire the connection separately (`src-tauri/src/commands.rs:129-156`); `src/lib/backup.ts:720-761` turns foreign keys off, runs the batch, then turns them on in separate calls. `src/lib/backup.test.ts:628-655,729-790` pins these calls and best-effort restore on batch error. A write admitted after the batch's integrity canary but before FK-on can bypass enforcement; restoring the pragma does not retroactively check it. Decide whether to change this pinned API/order to an exclusive backend operation or otherwise exclude writers; preserve the original batch error if restoration also fails.
4. **Platform-origin allowlist.** `src-tauri/src/navigation.rs:43-64,76-87` accepts `tauri://localhost` and both HTTP and HTTPS `tauri.localhost` origins on every platform. `:118-133,180-185` explicitly tests that policy. Decide whether to keep these cross-platform alternatives or restrict to the actual current runtime origin/scheme. No reachable untrusted in-webview navigation or IPC exploit was established; normal Markdown links take the separate opener path.
5. **Raw diagnostics in the renderer.** Reset failures include absolute paths and OS errors (`src-tauri/src/reset.rs:282-288,294-305,310-325`), while the reset screen renders details verbatim (`src/components/ResetScreen.tsx:109-132`); `src/lib/reset.test.ts:158-198` pins that presentation. DB commands also forward DB errors (`src-tauri/src/commands.rs:120-137`; `src-tauri/src/db.rs:903-907,943-945`): the pinned rusqlite's [`SqlInputError` display](https://github.com/rusqlite/rusqlite/blob/v0.40.2/src/error.rs#L345-L351) can include the SQL text. The renderer is a documented trusted boundary and supplied that SQL, so this alone is not an external disclosure; no key in an IPC error was established. Decide whether troubleshooting value outweighs exposing local paths or SQL in UI text, screenshots or user-shared reports; if not, use sanitized display errors and an appropriately protected diagnostic channel.
6. **Close-to-tray after a partial reset.** With a tray installed, a closed DB causes close-to-tray to default on (`src-tauri/src/lib.rs:491-528`), and a second launch raises the existing window (`:73-84,551-567`); default-on and second-launch behavior are pinned at `:920-949`. The incomplete-reset guidance says to close and start the app (`src/lib/i18n.ts:498-499`), but closing the window can merely hide the terminal screen. Decide whether reset-terminal sessions should bypass the tray or whether the guidance should explicitly say to use the tray's Quit action (`src-tauri/src/lib.rs:478-483`).

## Verification performed

Commands were run from the repository root. The JS checks below exercise the IPC/reset contract, not compiled Rust behavior:

```sh
PATH=/home/user/audit-node/node_modules/node/bin:$PATH node --test src/data/ipc.test.ts src/reset-gate.test.ts
```

Result: **19 passed, 0 failed**. These are source/contract tests, not concurrent runtime tests.

```sh
cargo test --manifest-path src-tauri/Cargo.toml
```

Result: **not run**; exit 127, `cargo: command not found`. Neither `cargo` nor `rustc` is installed in this sandbox, so no Rust or SQLCipher test result is claimed.

Two supplemental, limited reproductions used to check E4 and E6:

```sh
python3 -c 'import sqlite3,tempfile,pathlib,shutil; d=tempfile.TemporaryDirectory(); p=pathlib.Path(d.name)/"live.db"; w=sqlite3.connect(p,isolation_level=None,timeout=0.05); w.execute("PRAGMA journal_mode=WAL"); w.execute("CREATE TABLE t (v INTEGER)"); w.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone(); r=sqlite3.connect(p,isolation_level=None); r.execute("BEGIN"); r.execute("SELECT * FROM t").fetchall(); w.execute("INSERT INTO t VALUES (1)"); status=w.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone(); q=pathlib.Path(d.name)/"safety.db"; shutil.copyfile(p,q); c=sqlite3.connect(q); live=w.execute("SELECT count(*) FROM t").fetchone()[0]; copied=c.execute("SELECT count(*) FROM t").fetchone()[0]; print("checkpoint_status=",status,"live_rows=",live,"copied_rows=",copied); assert status[0] == 1 and live == 1 and copied == 0; c.close(); r.close(); w.close(); d.cleanup()'
```

Result: `checkpoint_status= (1, 1, 0) live_rows= 1 copied_rows= 0`. This used ordinary Python SQLite with a held reader, not SQLCipher, rusqlite or the app.

```sh
PATH=/home/user/audit-node/node_modules/node/bin:$PATH node --input-type=module -e 'const {createBackupRepo,MAX_BACKUP_PHOTO_BYTES}=await import("./src/lib/backup.ts"); const path=`photos/2026/10/${"a".repeat(64)}.jpg`, size=MAX_BACKUP_PHOTO_BYTES+1, row={id:1,rel_path:path,sha256:"a".repeat(64),ext:"jpg",size_bytes:size,taken_date:null,note:"",created_at:"2026-10-27"}; const driver={query:async sql=>sql==="SELECT * FROM photos"||sql.startsWith("SELECT rel_path, size_bytes FROM photos")?[row]:[],readPhoto:async()=>new Uint8Array(size)}; const repo=createBackupRepo(driver); const exported=await repo.exportBackup(); console.log("export succeeded; zip bytes:",exported.bytes.length); try {await repo.inspectBackup(exported.bytes); throw Error("unexpectedly imported")} catch(e) {if(!String(e).includes("backup photo is larger")) throw e; console.log("inspect rejected:",e.message)}'
```

Result: export succeeded (`26315` ZIP bytes); inspection rejected the photo for exceeding `26214400` bytes. The driver and photo bytes were mocked; this does not execute the Rust photo-save command or establish a full app round trip.
