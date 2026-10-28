//! The Rust IPC commands: `db_query`, `db_execute`, `db_batch`,
//! `db_begin`, `db_commit`, `db_rollback`, `db_reset_txn`, `photo_save`,
//! `photo_read`, `photo_read_thumb`, `photo_save_thumb`, `photo_delete`,
//! `db_key_save` (write the key to a file the user chose),
//! `backup_save_file` (write the backup archive to a file the user chose),
//! `backup_safety_copy` (open the import exclusion window and take the copy),
//! `backup_import_begin`/`backup_import_end` (claim and release the window's
//! lease), plus the P5 share controls — `share_arm`, `share_start`, `share_stop`,
//! `share_status`, `share_publish`. The share commands touch no SQL: they
//! only control the listener and the snapshot bytes the desktop published.
//! The reset engine adds `factory_reset` (which reports per-component
//! outcomes) and `app_restart` (a thin wrapper over Tauri's restart, called by
//! the frontend only after a complete reset).
//!
//! Every WRITER — DB execute/batch/manual-txn, photo save/thumb/delete and the
//! safety copy — first passes through the [`crate::lifecycle`] barrier and
//! holds a ticket for its duration (E1/E5); `factory_reset` raises that
//! barrier and drains the tickets before it deletes anything, and share
//! start/arm/publish consult it too (E2). `db_query` and the photo reads are
//! not writers and do not admit.
//!
//! Every command serializes through the single mutex-protected connection
//! (— no pooling). UI pages never call these directly; they go through
//! the feature libraries and the data driver (P2).
//!
//! Photo bytes cross IPC as RAW payloads: `photo_read` returns
//! `tauri::ipc::Response`, which the frontend receives as an `ArrayBuffer`
//! instead of a JSON array of byte numbers, and `photo_save`/
//! `photo_save_thumb` take the bytes as the raw request body. A raw body IS
//! the whole request, so the metadata they need (the extension, the source
//! photo path) travels in request headers — the documented channel for a raw
//! payload. Raw payloads are unsupported on Android only; this app bundles
//! desktop targets.

use std::ops::Deref;
use std::sync::atomic::Ordering;
use std::sync::{Arc, MutexGuard};

use rusqlite::Connection;
use serde_json::Value as JsonValue;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Manager, State};

use crate::db::{self, AppState, BatchStatement, ExecuteOutcome, JsonObj};
use crate::file_write;
use crate::lifecycle::Lifecycle;
use crate::photos;
use crate::share::{ShareInfo, ShareState};

type CmdResult<T> = Result<T, String>;

/// Request header carrying the photo extension on a raw `photo_save` body.
const EXT_HEADER: &str = "x-photo-ext";
/// Request header carrying the SOURCE photo path on a raw `photo_save_thumb`
/// body — the thumbnail path itself is always derived in `photos.rs`.
const SOURCE_HEADER: &str = "x-photo-source";
/// Request header carrying the import lease on the raw photo writers (E5).
/// A raw body IS the whole request, so these commands have no argument
/// channel for it — same reason the metadata beside it rides in a header.
/// Absent means "an ordinary app write", which the lifecycle refuses while
/// an import or reset owns the data.
const LEASE_HEADER: &str = "x-import-lease";

/// The body is returned owned so callers can move it into a
/// `spawn_blocking` closure: an `async` command future must be `'static`,
/// and a borrow of `request` (or of anything else the caller holds) cannot
/// cross that boundary.
fn raw_body(request: &Request<'_>) -> CmdResult<Vec<u8>> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.to_vec()),
        InvokeBody::Json(_) => Err("expected a raw byte payload".to_string()),
    }
}

fn header_str<'a>(request: &'a Request<'_>, name: &str) -> CmdResult<&'a str> {
    request
        .headers()
        .get(name)
        .ok_or_else(|| format!("missing {name} header"))?
        .to_str()
        .map_err(|_| format!("{name} header is not valid ASCII"))
}

/// Present-and-valid header value, or `None` when the header is absent —
/// for metadata that is optional by contract (the import lease).
fn header_str_opt<'a>(request: &'a Request<'_>, name: &str) -> CmdResult<Option<&'a str>> {
    match request.headers().get(name) {
        None => Ok(None),
        Some(value) => {
            Ok(Some(value.to_str().map_err(|_| {
                format!("{name} header is not valid ASCII")
            })?))
        }
    }
}

/// The import lease off [`LEASE_HEADER`]: `None` for an ordinary write.
fn lease_from_header(request: &Request<'_>) -> CmdResult<Option<u64>> {
    match header_str_opt(request, LEASE_HEADER)? {
        None => Ok(None),
        Some(text) => {
            Ok(Some(text.parse::<u64>().map_err(|_| {
                format!("{LEASE_HEADER} header must be a lease number")
            })?))
        }
    }
}

/// The managed connection, guarded against use after factory reset took it.
///
/// [`lock_conn`] validates the connection is `Some` while holding the very
/// lock this guard wraps, and only factory reset (through
/// `db::close_connection_for_reset`, same lock) can take it — so [`Deref`]
/// cannot observe a `None` while the guard lives. That is the same
/// "checked above, under the lock" shape `share::status` already relies on.
pub(crate) struct ConnGuard<'a>(MutexGuard<'a, Option<Connection>>);

impl Deref for ConnGuard<'_> {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        self.0
            .as_ref()
            .expect("lock_conn checked the connection is open")
    }
}

fn lock_conn(state: &AppState) -> CmdResult<ConnGuard<'_>> {
    // Recover from a poisoned mutex: a panic in any command drops the guard
    // atomically, leaving the Connection in a clean state. Refusing all future
    // commands (the previous behaviour) was more harmful than the panic itself.
    // Unwind-only path: release builds abort on panic (RELEASE.md).
    let (conn, was_poisoned) = match state.conn.lock() {
        Ok(guard) => (guard, false),
        Err(poisoned) => (poisoned.into_inner(), true),
    };
    // A dropped guard is NOT the same as a rolled-back transaction (review P3-1):
    // the guard releases on unwind, so a panic between `BEGIN` and `COMMIT`
    // leaves the connection *inside* that transaction, and every later command
    // runs inside it while `txn_open` still says a transaction is open.
    //
    // Only on the poison path — `txn_open` is legitimately true whenever the UI
    // holds a manual transaction, so probing unconditionally would end those.
    if was_poisoned && state.txn_open.swap(false, Ordering::SeqCst) {
        if let Some(conn) = conn.as_ref() {
            // Best effort: if this ROLLBACK fails there was nothing to roll back.
            let _ = conn.execute_batch("ROLLBACK;");
        }
    }
    // Fail closed: once factory reset has taken the connection, the
    // database file is gone or going, so every DB command must refuse with a
    // message the user can act on instead of touching a deleted file.
    if conn.is_none() {
        return Err(db::DB_CLOSED_MESSAGE.to_string());
    }
    Ok(ConnGuard(conn))
}

/// SELECT-ish reads: rows as JSON objects keyed by column name.
#[tauri::command]
pub fn db_query(
    state: State<'_, AppState>,
    sql: String,
    params: Option<Vec<JsonValue>>,
) -> CmdResult<Vec<JsonObj>> {
    let conn = lock_conn(&state)?;
    db::query_rows(&conn, &sql, params.as_deref().unwrap_or(&[]))
}

/// Single write: returns affected-row count + last insert rowid.
#[tauri::command]
pub fn db_execute(
    state: State<'_, AppState>,
    lifecycle: State<'_, Arc<Lifecycle>>,
    sql: String,
    params: Option<Vec<JsonValue>>,
    lease: Option<u64>,
) -> CmdResult<ExecuteOutcome> {
    // Admit first, and declare the ticket BEFORE the connection guard: the
    // ticket then drops after it, so when `begin_import`'s drain returns no
    // admitted writer can still hold the connection — which is what lets the
    // safety copy know its snapshot has no writer landing behind it (E5).
    let _ticket = lifecycle.admit(lease)?;
    let conn = lock_conn(&state)?;
    db::execute(&conn, &sql, params.as_deref().unwrap_or(&[]))
}

/// Multi-statement writes, committed as one transaction inside Rust
///
/// Async + `spawn_blocking`: a backup import replays up to
/// `MAX_BACKUP_ROWS` statements, each an individual SQLCipher execute — a
/// sync command would freeze the window for seconds-to-minutes. The
/// manual-transaction refusal is checked before dispatch, unchanged.
#[tauri::command]
pub async fn db_batch(
    app: tauri::AppHandle,
    statements: Vec<BatchStatement>,
    lease: Option<u64>,
) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        // Admitted on the blocking thread, before anything is locked — a
        // reset or import raise that gets here first refuses the batch
        // instead of it racing the replacement (E1/E5).
        let lifecycle = app.state::<Arc<Lifecycle>>();
        let _ticket = lifecycle.admit(lease)?;
        let state = app.state::<AppState>();
        // The flag is checked under the connection lock, exactly as the sync
        // form did — `db_begin` takes the same lock, so the two cannot race.
        let conn = lock_conn(&state)?;
        if state.txn_open.load(Ordering::SeqCst) {
            return Err("db_batch is not allowed while a manual transaction is open".to_string());
        }
        db::batch(&conn, &statements)
    })
    .await
    .map_err(|e| format!("db batch task failed: {e}"))?
}

/// Start a manual transaction — short critical sections only, the UI
/// must never hold it across awaits.
///
/// These commands are intentionally retained even though no app code calls
/// them today: the surface is mandated, and every
/// multi-statement write already goes through [`db_batch`]. An abandoned
/// manual transaction makes [`db_batch`] fail until something rolls it back
/// — or [`db_reset_txn`] clears the flag as a last resort.
///
/// The flag is only trustworthy because no *other* command can end a
/// transaction behind its back: `db::reject_dangerous_statement` now runs on
/// reads as well as writes, so `db_query` cannot COMMIT an open transaction or
/// BEGIN one the flag never saw. `db::tests::db_query_cannot_commit_or_begin_around_the_txn_flag`
/// is the regression that keeps it that way.
#[tauri::command]
pub fn db_begin(state: State<'_, AppState>, lifecycle: State<'_, Arc<Lifecycle>>) -> CmdResult<()> {
    let _ticket = lifecycle.admit(None)?;
    let conn = lock_conn(&state)?;
    if state.txn_open.swap(true, Ordering::SeqCst) {
        return Err("a transaction is already open".to_string());
    }
    if let Err(e) = db::begin_tx(&conn) {
        state.txn_open.store(false, Ordering::SeqCst);
        return Err(e);
    }
    Ok(())
}

/// Commit the manual transaction. On failure the open flag stays set so the
/// caller may still call [`db_rollback`]. If rollback also fails, call
/// [`db_reset_txn`] to clear the flag; the uncommitted rows are lost.
#[tauri::command]
pub fn db_commit(
    state: State<'_, AppState>,
    lifecycle: State<'_, Arc<Lifecycle>>,
) -> CmdResult<()> {
    let _ticket = lifecycle.admit(None)?;
    let conn = lock_conn(&state)?;
    if !state.txn_open.load(Ordering::SeqCst) {
        return Err("no open transaction to commit".to_string());
    }
    db::commit_tx(&conn)?;
    state.txn_open.store(false, Ordering::SeqCst);
    Ok(())
}

/// Roll back the manual transaction.
#[tauri::command]
pub fn db_rollback(
    state: State<'_, AppState>,
    lifecycle: State<'_, Arc<Lifecycle>>,
) -> CmdResult<()> {
    let _ticket = lifecycle.admit(None)?;
    let conn = lock_conn(&state)?;
    if !state.txn_open.load(Ordering::SeqCst) {
        return Err("no open transaction to roll back".to_string());
    }
    db::rollback_tx(&conn)?;
    state.txn_open.store(false, Ordering::SeqCst);
    Ok(())
}

/// Clear the manual-transaction flag without touching the DB.
///
/// Break-glass only: use this if `db_commit` AND `db_rollback` both
/// failed (e.g., connection died) and the flag is stuck, which would
/// block every future `db_batch`. A lost transaction means the rows
/// from the last `db_begin` are gone; the caller is responsible for
/// re-reading and reconciling state.
#[tauri::command]
pub fn db_reset_txn(
    state: State<'_, AppState>,
    lifecycle: State<'_, Arc<Lifecycle>>,
) -> CmdResult<()> {
    let _ticket = lifecycle.admit(None)?;
    // Fail closed like every other DB command once the connection is taken
    // "every DB command refuses after a reset" is one rule, and
    // clearing a transaction flag without a connection is meaningless.
    {
        let _guard = lock_conn(&state)?;
    }
    state.txn_open.store(false, Ordering::SeqCst);
    Ok(())
}

/// Store photo bytes content-addressed under `photos/<yyyy>/<mm>/`; the
/// yyyy/mm comes from SQLite's local-time clock so paths follow the user's
/// local date. Returns the relative path the feature layer stores in
/// the `photos` table.
///
/// The bytes arrive as the RAW request body (`invoke('photo_save',
/// new Uint8Array(bytes), { headers: { 'x-photo-ext': ext } })`), so a 3 MB
/// photo crosses IPC as 3 MB instead of ~12 million JSON characters.
///
/// Async + `spawn_blocking`: the SHA-256 hashing, the write, and
/// the dedupe re-hash of an existing file are the expensive part; the request
/// body and header are extracted into owned values first, before any await,
/// because the borrow does not outlive the command.
#[tauri::command]
pub async fn photo_save(app: tauri::AppHandle, request: Request<'_>) -> CmdResult<String> {
    let ext = header_str(&request, EXT_HEADER)?.to_string();
    let lease = lease_from_header(&request)?;
    let bytes = raw_body(&request)?;
    // Admit BEFORE the date lookup and hold the ticket across the blocking
    // write (E1): a save admitted before `raise_reset` is drained before the
    // reset deletes `photos/`, and one arriving after it is refused instead
    // of recreating the tree the reset just removed.
    let lifecycle = app.state::<Arc<Lifecycle>>();
    let _ticket = lifecycle.admit(lease)?;
    let year_month: String = {
        let state = app.state::<AppState>();
        let conn = lock_conn(&state)?;
        conn.query_row("SELECT strftime('%Y/%m', 'now', 'localtime')", [], |row| {
            row.get(0)
        })
        .map_err(|e| format!("local date lookup failed: {e}"))?
    };
    let data_dir = app.state::<AppState>().data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        photos::save_photo(&data_dir, &year_month, &bytes, &ext)
    })
    .await
    .map_err(|e| format!("photo save task failed: {e}"))?
}

/// Read photo bytes by DB-relative path (traversal-guarded). The response is
/// raw bytes: the frontend receives an `ArrayBuffer`, not a JSON array.
#[tauri::command]
pub fn photo_read(state: State<'_, AppState>, rel_path: String) -> CmdResult<Response> {
    Ok(Response::new(photos::read_photo(
        &state.data_dir,
        &rel_path,
    )?))
}

/// Read the thumbnail of a photo, given the SOURCE photo's relative path.
/// Errors when no thumbnail has been stored yet — the frontend then generates
/// one from the full bytes and saves it with `photo_save_thumb`.
#[tauri::command]
pub fn photo_read_thumb(
    state: State<'_, AppState>,
    source_rel_path: String,
) -> CmdResult<Response> {
    Ok(Response::new(photos::read_thumb(
        &state.data_dir,
        &source_rel_path,
    )?))
}

/// Store the thumbnail of a photo (raw bytes; the source photo path travels
/// in the `x-photo-source` header). Returns the derived thumbnail path.
///
/// Async + `spawn_blocking`: same freeze class as
/// [`photo_save`]; the header and body are owned before the first await.
#[tauri::command]
pub async fn photo_save_thumb(app: tauri::AppHandle, request: Request<'_>) -> CmdResult<String> {
    let source = header_str(&request, SOURCE_HEADER)?.to_string();
    let lease = lease_from_header(&request)?;
    let bytes = raw_body(&request)?;
    // Same barrier as `photo_save` (E1) — this command used to check nothing
    // at all and was callable after the connection had been taken.
    let lifecycle = app.state::<Arc<Lifecycle>>();
    let _ticket = lifecycle.admit(lease)?;
    let state = app.state::<AppState>();
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || photos::save_thumb(&data_dir, &source, &bytes))
        .await
        .map_err(|e| format!("photo thumbnail save task failed: {e}"))?
}

/// Delete a photo file by DB-relative path (traversal-guarded, idempotent).
/// The derived thumbnail is deleted with it; DB rows referencing the photo are
/// the feature layer's concern (P3e).
#[tauri::command]
pub fn photo_delete(
    state: State<'_, AppState>,
    lifecycle: State<'_, Arc<Lifecycle>>,
    rel_path: String,
    lease: Option<u64>,
) -> CmdResult<()> {
    // An import deletes the photos its archive no longer references; anyone
    // else is refused while a window or reset owns the data (E1/E5).
    let _ticket = lifecycle.admit(lease)?;
    photos::delete_photo(&state.data_dir, &rel_path)
}

/// Write the DB encryption key to a file the user chose
///
/// The path travels here as a plain string — a path is not a secret. It is
/// where the native save dialog returned it, and this command cannot prove
/// that: an arbitrary renderer-chosen destination is accepted, which is the
/// documented renderer-trust decision in `docs/RELEASE.md` ("Renderer trust
/// boundary"), not a property of the dialog.
///
/// The key does not come back: [`db::save_db_key_file`] reads it from the
/// credential store, writes it and drops it, so the plaintext master key never
/// enters the webview and cannot end up in React state, a clipboard, or a
/// renderer crash dump. Read-only with respect to the database, and never
/// mints: a missing credential-store entry is an error, not a fresh key.
///
/// Every successful call appends to `key-export.log`.
#[tauri::command]
pub fn db_key_save(path: String) -> CmdResult<()> {
    db::save_db_key_file(std::path::Path::new(&path))
}

/// Write the backup archive to the file the user chose (review P1-1).
///
/// The bytes arrive as the RAW request body (`invoke('backup_save_file',
/// bytes, { headers: { 'x-backup-path': path } })`), so a multi-hundred-MB zip
/// crosses IPC as bytes rather than a JSON array; the destination travels in
/// the header, percent-encoded because header values must be ASCII and a path
/// the user picked need not be ([`file_write::decode_header_path`]).
///
/// The path is the one the native save dialog returned. It is not validated
/// against an app-owned root — the renderer's trust is the boundary, and that
/// decision is written down in `docs/RELEASE.md` ("Renderer trust boundary").
/// This is deliberately *not* an fs-plugin write: `fs:write-files`
/// grants every write command on every path with no accessible-path scope,
/// which is both broader than this one operation needs and (with no `allow`
/// entry in the capability) the reason `writeFile` always failed, so backup
/// export never worked at all.
///
/// Async + `spawn_blocking`: up to ~128 MiB plus `sync_all` and
/// the rename; the path is decoded and the body owned before the first await.
#[tauri::command]
pub async fn backup_save_file(request: Request<'_>) -> CmdResult<()> {
    let encoded = header_str(&request, file_write::BACKUP_PATH_HEADER)?;
    let path = file_write::decode_header_path(encoded)?;
    let bytes = raw_body(&request)?;
    tauri::async_runtime::spawn_blocking(move || {
        file_write::save_backup_file(std::path::Path::new(&path), &bytes)
    })
    .await
    .map_err(|e| format!("backup save task failed: {e}"))?
}

/// Take a copy of the encrypted database and the photo library before an
/// import replaces them, and return the folder it went into.
///
/// The destination is composed HERE, under app-data, from a sanitized label —
/// unlike the two save commands above, this path is not the renderer's to
/// choose. The WAL checkpoint and the database-file copy are ONE step under
/// the connection lock, so no command can write between the
/// flush and the copy; the photo tree copies after the guard is released,
/// because it is large and touches no database state. The whole job runs on
/// a blocking thread because a photo library can be ~110 MiB and a
/// synchronous command would freeze the window.
///
/// This command is also where the import exclusion window OPENS (E5):
/// `begin_import` flips the lifecycle to `Importing` and drains every writer
/// admitted earlier, so the checkpoint below is the snapshot boundary —
/// nothing else can commit behind it, in the DB or the photo tree, until the
/// frontend's import releases the lease (`backup_import_end`). The copy's
/// own work is admitted with that lease, and a failure closes the window
/// again so a cancelled import never leaves the app write-blocked.
///
/// A failure is an error, never a warning: the caller aborts the import when
/// this fails, because the whole point is that the data is about to be gone.
#[tauri::command]
pub async fn backup_safety_copy(app: tauri::AppHandle, label: String) -> CmdResult<String> {
    let dest = tauri::async_runtime::spawn_blocking(move || -> CmdResult<std::path::PathBuf> {
        let lifecycle = app.state::<Arc<Lifecycle>>();
        let lease = lifecycle.begin_import()?;
        // RAII release: the window closes on EVERY exit from the copy — an
        // error return or a panic unwinding through this frame — unless the
        // copy succeeded, when it stays open for the import to attach to.
        // A plain `if is_err` would miss the panic case, and a window left
        // open writes-refuses the session until a restart (E5).
        let mut window = ImportWindowGuard {
            lifecycle: lifecycle.inner().clone(),
            lease,
            armed: true,
        };
        let copied = (|| -> CmdResult<std::path::PathBuf> {
            let _ticket = lifecycle.admit(Some(lease))?;
            let state = app.state::<AppState>();
            // The locked step: flush the WAL, then copy the database file, before
            // any other command can take the mutex and write again.
            let dest = {
                let conn = lock_conn(&state)?;
                conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                    .map_err(|e| {
                        format!("could not flush the database before the safety copy: {e}")
                    })?;
                crate::safety_copy::copy_database_for_import(&state.data_dir, &label)?
            };
            // Outside the lock: the photo tree (~110 MiB) and README.txt.
            crate::safety_copy::copy_photos_for_import(&state.data_dir, &dest)?;
            Ok(dest)
        })();
        if copied.is_ok() {
            // The window is the import's to keep — it attaches to this lease
            // next — so disarm the guard. On failure (and on panic, in
            // `Drop`) the guard hands the window back instead of leaving
            // ordinary writes refused for the rest of the session.
            window.armed = false;
        }
        copied
    })
    .await
    .map_err(|e| format!("safety copy task failed: {e}"))??;
    Ok(dest.to_string_lossy().to_string())
}

/// Closes the import exclusion window on drop, unless disarmed after a
/// successful copy — see [`backup_safety_copy`]. Best effort: a reset that
/// preempted the copy has already moved the phase on and needs no release
/// (and [`Lifecycle::end_import`] would refuse the stale lease anyway).
struct ImportWindowGuard {
    lifecycle: Arc<Lifecycle>,
    lease: u64,
    armed: bool,
}

impl Drop for ImportWindowGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.lifecycle.end_import(self.lease);
        }
    }
}

/// Claim (or attach to) the import exclusion window and return its lease.
///
/// Called by the confirmed import before its first write. The window may
/// already be open — `backup_safety_copy` opened it at the snapshot
/// boundary — in which case this returns the SAME lease: one window from
/// the copy through `backup_import_end`, not two. Refuses while a factory
/// reset owns the data.
#[tauri::command]
pub fn backup_import_begin(lifecycle: State<'_, Arc<Lifecycle>>) -> CmdResult<u64> {
    lifecycle.begin_import()
}

/// Release the import exclusion window with the lease it was opened with.
///
/// A late or foreign lease is refused rather than opening the door for
/// someone else's write; the frontend calls this in a `finally`, after FK
/// enforcement is restored, so the window closes on success and failure
/// alike.
#[tauri::command]
pub fn backup_import_end(lifecycle: State<'_, Arc<Lifecycle>>, lease: u64) -> CmdResult<()> {
    lifecycle.end_import(lease)
}

#[tauri::command]
pub async fn export_save_file(request: Request<'_>) -> CmdResult<()> {
    let encoded = header_str(&request, file_write::EXPORT_PATH_HEADER)?;
    let path = file_write::decode_header_path(encoded)?;
    let bytes = raw_body(&request)?;
    tauri::async_runtime::spawn_blocking(move || {
        file_write::save_export_file(std::path::Path::new(&path), &bytes)
    })
    .await
    .map_err(|e| format!("export save task failed: {e}"))?
}

/// Record that the user confirmed the LAN-share consent prompt, and return a
/// one-shot token for [`share_start`].
///
/// Issuing a token is not consent — only starting the server consumes it, and
/// only once. Splitting it out means the bare `share_start` call, which is what
/// an accident or a stray invocation looks like, no longer opens a listener on
/// its own.
#[tauri::command]
pub fn share_arm(state: State<'_, ShareState>) -> CmdResult<String> {
    state.arm()
}

/// Turn on the read-only LAN share: binds a fresh port, mints a pairing
/// code and serves the last published snapshot. Idempotent while running.
///
/// Requires the token from [`share_arm`]; see the refusal in
/// [`ShareState::start`]. Every start and stop is recorded in `share.log`
/// beside the database.
///
/// `rename_all` is what lets the Rust-side name stay snake_case while the JS
/// driver sends `consentToken` — the IPC contract is camelCase, same as the
/// `rowsAffected`/`lastInsertRowid` fields on [`db::ExecuteOutcome`].
#[tauri::command(rename_all = "camelCase")]
pub fn share_start(state: State<'_, ShareState>, consent_token: String) -> CmdResult<ShareInfo> {
    state.start(&consent_token)
}

/// Turn the LAN share off and close the listener. Idempotent.
#[tauri::command]
pub fn share_stop(state: State<'_, ShareState>) -> CmdResult<ShareInfo> {
    state.stop()
}

/// Current share state — also reports a server that stopped unexpectedly.
#[tauri::command]
pub fn share_status(state: State<'_, ShareState>) -> CmdResult<ShareInfo> {
    state.status()
}

/// Publish a fresh snapshot payload (built by `src/lib/share.ts`) for the
/// LAN server to serve. The payload is validated, never executed, and the
/// share path has no DB or filesystem access at all.
#[tauri::command]
pub fn share_publish(state: State<'_, ShareState>, snapshot_json: String) -> CmdResult<ShareInfo> {
    state.publish(&snapshot_json)
}

/// Factory reset: remove every piece of PurpleMemo-owned local
/// state and report each component's outcome.
///
/// This is the engine, not the policy: the frontend gates it behind an
/// explicit permanent-destruction acknowledgement (Wave 2), and restarts the
/// app only when the outcome says `complete`. The engine stops the LAN share
/// first, checkpoints the WAL and takes the managed connection (from then on
/// every DB command fails closed with `db::DB_CLOSED_MESSAGE`), deletes the
/// database files, the photo tree, the safety-copy tree and the logs, and
/// deletes the credential-store key **last** — never orphaning a live
/// database from its key. Anything it cannot remove blocks `complete` and is
/// named in the outcome. The reset creates nothing: the restart's first-run
/// boot owns the new key, database and seed rows.
///
/// The heavy work runs on a blocking thread so a large photo library cannot
/// stall the async runtime; ordering and seams live in
/// [`crate::reset::run_factory_reset`], where the tests pin them.
#[tauri::command]
pub async fn factory_reset(app: tauri::AppHandle) -> CmdResult<crate::reset::ResetOutcome> {
    let handle = app.clone();
    let outcome =
        tauri::async_runtime::spawn_blocking(move || -> CmdResult<crate::reset::ResetOutcome> {
            let share = handle
                .try_state::<ShareState>()
                .ok_or_else(|| "share state is not available — restart the app".to_string())?;
            let db_state = handle
                .try_state::<AppState>()
                .ok_or_else(|| "database state is not available — restart the app".to_string())?;
            let lifecycle = handle
                .try_state::<Arc<Lifecycle>>()
                .ok_or_else(|| "lifecycle state is not available — restart the app".to_string())?;
            // E1: raise the barrier BEFORE the engine runs. This refuses every
            // writer that arrives from now on (including post-reset photo
            // commands, for the rest of the process) and waits out the photo
            // and safety-copy workers already in flight — so nothing can
            // write back into what `run_factory_reset` is about to delete,
            // and `complete: true` cannot be followed by reappearing files.
            lifecycle.raise_reset();
            Ok(crate::reset::run_factory_reset(
                crate::reset::fault_injection(),
                || share.stop_for_reset(),
                || db::close_connection_for_reset(&db_state),
                &db_state.data_dir,
                db::delete_db_key,
            ))
        })
        .await
        .map_err(|e| format!("factory reset task failed: {e}"))?;
    outcome
}

/// Restart the app: the
/// next launch takes the existing first-run boot path, which mints a fresh
/// key and seeds a fresh database — the only place that pairing may happen,
/// because the reset itself creates nothing. A thin wrapper over Tauri's
/// restart: no arguments, no logic.
#[tauri::command]
pub fn app_restart(app: tauri::AppHandle) -> CmdResult<()> {
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::lock_conn;

    /// Once factory reset has taken the connection, every DB command
    /// must fail closed with a clear message instead of touching a deleted
    /// file. All the DB commands reach the connection through `lock_conn`, so
    /// this one seam IS the behaviour of every one of them.
    #[test]
    fn db_commands_fail_closed_after_the_connection_is_taken() {
        let state = crate::db::AppState {
            conn: std::sync::Mutex::new(None),
            txn_open: std::sync::atomic::AtomicBool::new(false),
            data_dir: std::path::PathBuf::from("unused"),
        };
        let error = match lock_conn(&state) {
            Ok(_) => panic!("a taken connection must fail closed"),
            Err(e) => e,
        };
        assert_eq!(error, crate::db::DB_CLOSED_MESSAGE);
        assert!(error.contains("restart"), "must say what to do: {error}");
    }

    /// The fail-closed check must not get in the way of normal operation:
    /// while the connection is open, `lock_conn` hands out a guard that
    /// derefs straight to it.
    #[test]
    fn lock_conn_hands_out_the_connection_while_it_is_open() {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
        let state = crate::db::AppState {
            conn: std::sync::Mutex::new(Some(conn)),
            txn_open: std::sync::atomic::AtomicBool::new(false),
            data_dir: std::path::PathBuf::from("unused"),
        };
        let guard = lock_conn(&state).expect("an open connection must be available");
        let one: i64 = guard
            .query_row("SELECT 1", [], |row| row.get(0))
            .expect("query through the guard");
        assert_eq!(one, 1);
    }

    /// A panic inside a command must not wedge the connection mutex for the
    /// rest of the session: the guard drops atomically on unwind,
    /// so recovering the inner value is safe — while refusing the lock, the
    /// old behaviour, failed every later command until a restart.
    #[test]
    fn poisoned_db_mutex_recovers() {
        // Simulate what happens after a command panics mid-execution.
        let mutex = std::sync::Mutex::new(42u32);
        let _ = std::panic::catch_unwind(|| {
            let _guard = mutex.lock().unwrap();
            panic!("simulated panic");
        });
        // The mutex is poisoned; recovery yields the inner value.
        let val = mutex.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(*val, 42);
    }

    /// E1/E5: the barrier only holds if EVERY writer goes through it — a
    /// command that writes while bypassing `admit` could land inside the
    /// reset's deletion or behind the import's snapshot. A source pin, the
    /// same shape `safety_copy` uses for the locked step: it cannot prove the
    /// barrier works (that is `lifecycle::tests`), but it stops a writer from
    /// being added — or an existing one quietly unwired — without one.
    #[test]
    fn every_writer_command_admits_through_the_lifecycle() {
        let src = include_str!("commands.rs");
        let body_of = |name: &str| -> String {
            let start = src
                .find(&format!("fn {name}("))
                .unwrap_or_else(|| panic!("{name} not found — renamed?"));
            // The next command annotation bounds the body; `factory_reset` is
            // followed by `app_restart`, which is annotated too.
            let end = src[start..]
                .find("#[tauri::command]")
                .map(|i| start + i)
                .unwrap_or(src.len());
            src[start..end].to_string()
        };

        for name in [
            "db_execute",
            "db_batch",
            "db_begin",
            "db_commit",
            "db_rollback",
            "db_reset_txn",
            "photo_save",
            "photo_save_thumb",
            "photo_delete",
        ] {
            assert!(
                body_of(name).contains("admit("),
                "{name} must admit through the lifecycle barrier"
            );
        }
        let copy = body_of("backup_safety_copy");
        assert!(
            copy.contains("begin_import("),
            "the safety copy opens the import exclusion window (E5)"
        );
        assert!(
            copy.contains("admit(Some(lease))"),
            "the copy's own work is admitted with the window's lease"
        );
        assert!(
            body_of("factory_reset").contains("raise_reset()"),
            "factory_reset must raise the barrier before deleting anything (E1)"
        );
    }
}
