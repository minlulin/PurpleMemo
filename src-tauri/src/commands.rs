//! The Rust IPC commands: `db_query`, `db_execute`, `db_batch`,
//! `db_begin`, `db_commit`, `db_rollback`, `db_reset_txn`, `photo_save`,
//! `photo_read`, `photo_read_thumb`, `photo_save_thumb`, `photo_delete`,
//! `db_key_save` (write the key to a file the user chose),
//! `backup_save_file` (write the backup archive to a file the user chose),
//! `backup_safety_copy` (open the import exclusion window and take the copy),
//! `backup_import_begin`/`backup_import_end` (claim and release the window's
//! lease), and `close_to_tray_set` (publish the Settings toggle to the close
//! handler's in-memory mirror — the handler itself must never read the database
//! on the window-event thread). `ui_locale_set` (D7) records the interface
//! language for the tray and the boot dialogs, which are built before this
//! renderer can answer. The reset engine adds `factory_reset` (which reports
//! per-component outcomes) and `app_restart` (a thin wrapper over Tauri's
//! restart, called by the frontend only after a complete reset).
//!
//! Every failure is a [`Refusal`] — a message key plus params, resolved by the
//! renderer's catalogue — rather than an English sentence (D7). A detail from
//! a layer that only speaks diagnostics (SQLite, the OS) rides along as a
//! `{detail}` param, so the framing is translated and the cause is not
//! misreported.
//!
//! Every WRITER — DB execute/batch/manual-txn, photo save/thumb/delete and the
//! safety copy — first passes through the [`crate::lifecycle`] barrier and
//! holds a ticket for its duration (E1/E5); `factory_reset` raises that
//! barrier and drains the tickets before it deletes anything, and the
//! pairing listener consults it too (E2). `db_query` and the photo reads are
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
use serde::Serialize;
use serde_json::Value as JsonValue;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Manager, State};

use crate::db::{self, AppState, BatchStatement, ExecuteOutcome, JsonObj};
use crate::file_write;
use crate::lifecycle::Lifecycle;
use crate::messages::{self, Refusal};
use crate::pairing_key::{self, PairingHistory, PairingIdentity};
use crate::pairing_listener::{
    PairingListenerInfo, PairingListenerState, PairingOffer, PairingOpenInput, PairingWindow,
    PROTOCOL_VERSION,
};
use crate::photos;

/// Every command's failure is a key plus params (D7): the renderer has the
/// catalogue, and Rust only knows which message to use.
type CmdResult<T> = Result<T, Refusal>;

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
/// E6: the per-photo ceiling, identical to `MAX_BACKUP_PHOTO_BYTES` in
/// `src/lib/backup.ts` — a photo the importer would refuse on restore must
/// never be accepted at save time, or the app writes backups it cannot read
/// back. Pinned against the TS constant by `ipc.test.ts`, because the two
/// limits living in two languages is exactly how they drift apart.
const MAX_SAVED_PHOTO_BYTES: u64 = 25 * 1024 * 1024;

/// The body is returned owned so callers can move it into a
/// `spawn_blocking` closure: an `async` command future must be `'static`,
/// and a borrow of `request` (or of anything else the caller holds) cannot
/// cross that boundary.
fn raw_body(request: &Request<'_>) -> CmdResult<Vec<u8>> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.to_vec()),
        InvokeBody::Json(_) => Err(Refusal::new("rust.error.rawBody")),
    }
}

fn header_str<'a>(request: &'a Request<'_>, name: &str) -> CmdResult<&'a str> {
    request
        .headers()
        .get(name)
        .ok_or_else(|| Refusal::new("rust.error.headerMissing").with("name", name))?
        .to_str()
        .map_err(|_| Refusal::new("rust.error.headerNotAscii").with("name", name))
}

/// Present-and-valid header value, or `None` when the header is absent —
/// for metadata that is optional by contract (the import lease).
fn header_str_opt<'a>(request: &'a Request<'_>, name: &str) -> CmdResult<Option<&'a str>> {
    match request.headers().get(name) {
        None => Ok(None),
        Some(value) => Ok(Some(value.to_str().map_err(|_| {
            Refusal::new("rust.error.headerNotAscii").with("name", name)
        })?)),
    }
}

/// The import lease off [`LEASE_HEADER`]: `None` for an ordinary write.
fn lease_from_header(request: &Request<'_>) -> CmdResult<Option<u64>> {
    match header_str_opt(request, LEASE_HEADER)? {
        None => Ok(None),
        Some(text) => Ok(Some(
            text.parse::<u64>()
                .map_err(|_| Refusal::new("rust.error.leaseNotNumber"))?,
        )),
    }
}

/// The managed connection, guarded against use after factory reset took it.
///
/// [`lock_conn`] validates the connection is `Some` while holding the very
/// lock this guard wraps, and only factory reset (through
/// `db::close_connection_for_reset`, same lock) can take it — so [`Deref`]
/// cannot observe a `None` while the guard lives. That is the same
/// "checked above, under the lock" shape the pairing listener's status
/// read relies on.
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
        return Err(Refusal::new("rust.error.dbClosed"));
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
    db::query_rows(&conn, &sql, params.as_deref().unwrap_or(&[])).map_err(Refusal::from)
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
    db::execute(&conn, &sql, params.as_deref().unwrap_or(&[])).map_err(Refusal::from)
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
            return Err(Refusal::new("rust.error.batchDuringTxn"));
        }
        db::batch(&conn, &statements).map_err(Refusal::from)
    })
    .await
    .map_err(|e| Refusal::from(e.to_string()))?
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
        return Err(Refusal::new("rust.error.txnAlreadyOpen"));
    }
    if let Err(e) = db::begin_tx(&conn) {
        state.txn_open.store(false, Ordering::SeqCst);
        return Err(Refusal::from(e));
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
        return Err(Refusal::new("rust.error.noTxnToCommit"));
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
        return Err(Refusal::new("rust.error.noTxnToRollback"));
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
    // — "every DB command refuses after a reset" is one rule, and
    // clearing a transaction flag without a connection is meaningless.
    //
    // E12: the whole reconciliation runs UNDER this lock. The flag is what
    // every other command consults to mean "a manual transaction is open",
    // so it may only change while this guard excludes them — and it may only
    // clear when SQLite agrees the transaction is gone (`reconcile_open_txn`
    // checks autocommit and ROLLBACKs for real). On failure the `?` returns
    // BEFORE the store: the flag stays set, later writes keep refusing, and
    // the app demands a restart instead of reporting a cleared state that
    // still holds an open transaction.
    {
        let conn = lock_conn(&state)?;
        db::reconcile_open_txn(&conn)?;
        state.txn_open.store(false, Ordering::SeqCst);
    }
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
    // E6: refuse at the door what the importer would refuse at restore. The
    // gallery picker reads the chosen file without a limit, so this command
    // is the one choke point every original bytes pass through — and the
    // refusal happens before any hashing, writing, or barrier ticket.
    if bytes.len() as u64 > MAX_SAVED_PHOTO_BYTES {
        return Err(Refusal::new("rust.error.photoTooLarge")
            .with(
                "size",
                format!("{:.1}", bytes.len() as f64 / (1024.0 * 1024.0)),
            )
            .with(
                "limit",
                format!("{:.0}", MAX_SAVED_PHOTO_BYTES as f64 / (1024.0 * 1024.0)),
            ));
    }
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
        .map_err(|e| Refusal::new("rust.error.photoWrite").with("detail", e))?
    };
    let data_dir = app.state::<AppState>().data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        photos::save_photo(&data_dir, &year_month, &bytes, &ext)
    })
    .await
    .map_err(|e| Refusal::from(e.to_string()))?
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
        .map_err(|e| Refusal::from(e.to_string()))?
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
    refuse_mobile_role()?;
    db::save_db_key_file(std::path::Path::new(&path))
        .map_err(|e| Refusal::new("rust.error.keyWrite").with("detail", e))
}

/// Desktop-role commands refuse on mobile. The handler list is shared
/// across platforms, so without this the phone's webview could invoke the
/// desktop's parts — host a pairing window, export the database key —
/// export the database key — none of which exist in the phone's role
/// (docs/ANDROID_DESIGN.md). The refusal lives at the command boundary,
/// not in the UI, so no page needs to know it is there.
#[cfg(mobile)]
fn refuse_mobile_role() -> CmdResult<()> {
    Err(Refusal::new("rust.error.desktopOnly"))
}

#[cfg(not(mobile))]
fn refuse_mobile_role() -> CmdResult<()> {
    Ok(())
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
    .map_err(|e| Refusal::from(e.to_string()))?
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
                // E4: read the checkpoint's RESULT, not just its exit status.
                // `execute_batch` steps the pragma's row and throws it away, and
                // SQLite happily answers a successful statement with busy=1 and
                // committed frames still in the WAL — the copy would then be a
                // stale main file while the caller believed the flush happened.
                // The three columns are busy, pages-in-log, pages-checkpointed.
                let (busy, log_pages, checkpointed) = conn
                    .query_row("PRAGMA wal_checkpoint(TRUNCATE);", [], |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    })
                    .map_err(|e| Refusal::new("rust.error.flushFailed").with("detail", e))?;
                if busy != 0 {
                    // Fail closed: an incomplete checkpoint aborts the import at
                    // the snapshot boundary — the copy would miss committed rows,
                    // and the destructive phase must never run against it.
                    return Err(Refusal::new("rust.error.flushIncomplete")
                        .with("checkpointed", checkpointed)
                        .with("logPages", log_pages));
                }
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
    .map_err(|e| Refusal::from(e.to_string()))??;
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
    lifecycle.begin_import().map_err(Refusal::from)
}

/// Release the import exclusion window with the lease it was opened with.
///
/// A late or foreign lease is refused rather than opening the door for
/// someone else's write; the frontend calls this in a `finally`, after FK
/// enforcement is restored, so the window closes on success and failure
/// alike.
#[tauri::command]
pub fn backup_import_end(
    app: tauri::AppHandle,
    lifecycle: State<'_, Arc<Lifecycle>>,
    lease: u64,
) -> CmdResult<()> {
    lifecycle.end_import(lease)?;
    // An import replaces the `settings` table, so the close-to-tray value the
    // close handler holds in memory may now be the one from the backup. Read
    // the row again here — the write has finished, and this is not the
    // window-event thread. Best effort: the lease really was released, and a
    // mirror that could not be refreshed must not turn a finished import into
    // a reported failure; the next boot seeds it again.
    refresh_close_to_tray_from(&app);
    Ok(())
}

/// Republish the close-to-tray mirror from the live connection, if there is
/// one. A closed connection leaves the mirror as it was, and its default is the
/// same "on" the absent-row rule gives.
fn refresh_close_to_tray_from(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Ok(conn) = lock_conn(&state) else {
        return;
    };
    crate::refresh_close_to_tray(&conn);
}

/// Publish the close-to-tray toggle the Settings page just wrote.
///
/// The window-close handler runs on the event loop, where the database
/// connection must not be touched (D1: `db_batch` holds that mutex for a whole
/// import batch, and `backup_safety_copy` across its checkpoint and file copy).
/// So the renderer tells Rust the new value here, after the row is written, and
/// the handler keeps reading memory only.
///
/// The row is already persisted by the caller, so a failure to deliver this
/// in-process copy cannot lose the setting — the next boot reads it back.
#[tauri::command]
pub fn close_to_tray_set(enabled: bool) -> CmdResult<()> {
    crate::publish_close_to_tray(enabled);
    Ok(())
}

/// Tell Rust which language the interface is in (D7).
///
/// The tray menu and the boot-failure dialogs are built before the renderer can
/// answer anything, so they cannot read the catalogue; this records the choice
/// where they can find it (`ui-locale`) and relabels a tray that is already up.
/// Called at boot and on every language switch. An unknown tag is refused
/// rather than guessed: the marker is what boot reads, and a wrong value there
/// would outlive the session that wrote it.
#[tauri::command]
pub fn ui_locale_set(app: tauri::AppHandle, locale: String) -> CmdResult<()> {
    let locale =
        messages::Locale::parse(&locale).ok_or_else(|| Refusal::new("rust.error.locale"))?;
    crate::publish_ui_locale(&app, locale);
    Ok(())
}

/// Where Rust's boot stands, for the renderer's first read and its error
/// screen (F13).
///
/// `state` is `"pending"` while boot is still running, `"ready"` once the
/// database is open and managed, or `"failed"` — with `error` carrying the
/// cause — when it is not. The renderer waits out `pending` before its
/// first read: the WebView can be live half a second before the database
/// key is even unwrapped, and a read issued in that window fails with
/// "state not managed" and used to latch the error screen for the session.
/// And when boot has failed, the recorded cause is the honest thing for
/// that screen to show — the boot-failure dialog is the desktop's surface,
/// not the phone's.
#[derive(Debug, Clone, Serialize)]
pub struct BootStatus {
    pub state: &'static str,
    pub error: Option<String>,
}

#[tauri::command]
pub fn boot_status() -> CmdResult<BootStatus> {
    Ok(match crate::boot_phase() {
        crate::BootPhase::Pending => BootStatus {
            state: "pending",
            error: None,
        },
        crate::BootPhase::Ready => BootStatus {
            state: "ready",
            error: None,
        },
        crate::BootPhase::Failed(cause) => BootStatus {
            state: "failed",
            error: Some(cause),
        },
    })
}

/// Re-run boot from the renderer's error screen (F13): the same retry the
/// boot-failure dialog's Retry button runs, reachable on the phone where
/// that dialog is not the surface the user gets. On success the database
/// state is managed and the window is reloaded; on failure the new cause is
/// recorded for `boot_status` and the dialog path runs as before.
#[tauri::command]
pub fn boot_retry(app: tauri::AppHandle) -> CmdResult<()> {
    crate::retry_boot(app);
    Ok(())
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
    .map_err(|e| Refusal::from(e.to_string()))?
}

/// Factory reset: remove every piece of PurpleMemo-owned local
/// state and report each component's outcome.
///
/// This is the engine, not the policy: the frontend gates it behind an
/// explicit permanent-destruction acknowledgement (Wave 2), and restarts the
/// app only when the outcome says `complete`. The engine stops the pairing
/// listener first, checkpoints the WAL and takes the managed connection (from then on
/// every DB command fails closed with `rust.error.dbClosed`), deletes the
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
            let pairing = handle
                .try_state::<crate::pairing_listener::PairingListenerState>()
                .ok_or_else(|| {
                    "pairing listener state is not available — restart the app".to_string()
                })?;
            let db_state = handle
                .try_state::<AppState>()
                .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
            let lifecycle = handle
                .try_state::<Arc<Lifecycle>>()
                .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
            // E3: record the reset durably BEFORE anything is deleted — and
            // before the barrier, so a marker that cannot be written aborts
            // the reset while the app still runs normally (nothing was
            // deleted, nothing is refused). A session that dies mid-run then
            // leaves this marker behind, and the next boot's recovery pass
            // finishes the job before first-run initialization can mistake
            // the leftovers for a fresh start.
            crate::reset::mark_reset_started(&db_state.data_dir)?;
            // D2: the session is terminal from the marker on — not from the
            // engine's return. The flag used to be raised after
            // `run_factory_reset`, which left the whole engine (taking the
            // connection, deleting the photo tree and the safety copies) with
            // close-to-tray still armed: pressing the window's close button
            // mid-reset hid the terminal screen behind the tray, and the next
            // launch only raised that hidden window instead of starting
            // fresh. The marker is the honest boundary, because once it lands
            // the reset can no longer be abandoned — a failed engine still
            // leaves the marker, and the next boot's recovery pass finishes
            // the job. A marker that could NOT be written returned above,
            // before this store, so that session keeps ordinary
            // close-to-tray: the rule this flag has always been scoped to.
            db_state.reset_terminal.store(true, Ordering::SeqCst);
            // E1: raise the barrier BEFORE the engine runs. This refuses every
            // writer that arrives from now on (including post-reset photo
            // commands, for the rest of the process) and waits out the photo
            // and safety-copy workers already in flight — so nothing can
            // write back into what `run_factory_reset` is about to delete,
            // and `complete: true` cannot be followed by reappearing files.
            lifecycle.raise_reset();
            let outcome = crate::reset::run_factory_reset(
                crate::reset::fault_injection(),
                || {
                    // §11.5 before anything is deleted: the pairing window
                    // must be gone before the database it serves is.
                    pairing.stop_for_reset()
                },
                || db::close_connection_for_reset(&db_state),
                &db_state.data_dir,
                db::delete_db_key,
            );
            // The session was already terminal before the engine ran (D2);
            // the outcome only decides whether anything is left to finish.
            if outcome.complete {
                // E3: the run reported `complete`, so the record of it goes
                // away too. Best effort, deliberately — same reasoning as
                // `finish_interrupted_reset`: a marker that cannot be removed
                // makes the next start re-run a now-harmless recovery pass
                // that retries the removal, while failing the reset here
                // would report a deletion that actually succeeded as failed.
                if let Err(e) = crate::reset::clear_reset_marker(&db_state.data_dir) {
                    eprintln!("purple-memo: {e} — the reset completed; the leftover marker is retried on the next start");
                }
                // The phone's armed reminders and delivery records live
                // outside the database the engine just wiped; forget them
                // too (Android only, best-effort — see reminders.rs).
                crate::reminders::clear_reminder_state_after_reset();
            }
            Ok(outcome)
        })
        .await
        .map_err(|e| Refusal::from(e.to_string()))?;
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

/// This device's own pairing facts: what the offer carries (§11.1) and what the
/// other screen compares (§11.2). The public key and fingerprint are public by
/// design; there is no field for a secret.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingLocalInfo {
    pub device_id: String,
    pub generation: u64,
    pub schema_version: u64,
    pub protocol_version: u64,
    pub public_key: String,
    pub fingerprint: String,
}

/// The device id, data line and schema the sync store holds — read from the one
/// database through the same connection lock every other command uses, so the
/// pairing window can never advertise facts the store does not hold.
fn local_sync_facts(state: &AppState) -> CmdResult<(String, u64, u64)> {
    let conn = lock_conn(state)?;
    let (device_id, generation): (String, i64) = conn
        .query_row(
            "SELECT device_id, data_generation FROM sync_state WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| Refusal::new("rust.error.syncState").with("detail", e))?;
    let schema: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| Refusal::new("rust.error.schemaVersion").with("detail", e))?;
    Ok((device_id, generation.max(0) as u64, schema.max(0) as u64))
}

/// Whether this install has ever paired — the one database fact `pairing_key`
/// needs so a missing identity fails closed instead of rotating silently
/// (§11.2, wave 1 N2).
pub(crate) fn pairing_history(conn: &Connection) -> CmdResult<PairingHistory> {
    let paired: bool = conn
        .query_row("SELECT EXISTS (SELECT 1 FROM sync_peers)", [], |row| {
            row.get(0)
        })
        .map_err(|e| Refusal::new("rust.error.pairingHistory").with("detail", e))?;
    Ok(if paired {
        PairingHistory::Paired
    } else {
        PairingHistory::Never
    })
}

/// `sync_state.re_pair_required` as stored.
pub(crate) fn re_pair_required(conn: &Connection) -> CmdResult<bool> {
    let flag: i64 = conn
        .query_row(
            "SELECT re_pair_required FROM sync_state WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|e| Refusal::new("rust.error.rePairFlag").with("detail", e))?;
    Ok(flag == 1)
}

/// Record that this install must re-pair (§11.4, N2). Idempotent, and it moves
/// nothing else: notes, tasks and the database key stay exactly where they are.
pub(crate) fn mark_re_pair_required(conn: &Connection) -> CmdResult<()> {
    conn.execute(
        "UPDATE sync_state SET re_pair_required = 1, \
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 1",
        [],
    )
    .map_err(|e| Refusal::new("rust.error.rePairRecord").with("detail", e))?;
    Ok(())
}

/// This install's pairing identity, minting only on a fresh install (§11.2, N2).
///
/// A missing or unopenable identity over an existing pin is a re-pair, not a
/// crash: the flag is recorded so the recovery path is offered even on a launch
/// that missed boot's check, and the error carries the reason to show.
fn load_pairing_identity(db_state: &AppState) -> CmdResult<PairingIdentity> {
    let history = {
        let conn = lock_conn(db_state)?;
        pairing_history(&conn)?
    };
    pairing_key::load_or_mint(history).map_err(|error| {
        if error.needs_re_pair_flag() {
            if let Ok(conn) = lock_conn(db_state) {
                let _ = mark_re_pair_required(&conn);
            }
        }
        Refusal::new("rust.error.pairingIdentity").with("detail", error.message())
    })
}

/// This device's pairing identity and the data line it would pair on. Reads
/// only — no socket is bound here.
#[tauri::command]
pub fn pairing_local(app: tauri::AppHandle) -> CmdResult<PairingLocalInfo> {
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let (device_id, generation, schema_version) = local_sync_facts(&db_state)?;
    let identity = load_pairing_identity(&db_state)?;
    Ok(PairingLocalInfo {
        device_id,
        generation,
        schema_version,
        protocol_version: PROTOCOL_VERSION,
        public_key: identity.public_key_hex(),
        fingerprint: identity.fingerprint(),
    })
}

/// Open the pairing window (§11.5): one LAN listener, alive only while the
/// panel is on screen. The local identity, device id, generation and schema are
/// read here rather than trusted from the webview.
#[tauri::command]
pub fn pairing_open(
    app: tauri::AppHandle,
    input: PairingOpenInput,
) -> CmdResult<PairingListenerInfo> {
    refuse_mobile_role()?;
    let listener = app
        .try_state::<PairingListenerState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let (device_id, generation, schema_version) = local_sync_facts(&db_state)?;
    let identity = load_pairing_identity(&db_state)?;
    let offer = match (input.offer_code, input.offer_expires_at) {
        (Some(code), Some(expires_at)) => Some(PairingOffer { code, expires_at }),
        (None, None) => None,
        _ => return Err(Refusal::new("rust.error.offerIncomplete")),
    };
    let window = PairingWindow {
        local_device_id: device_id,
        local_generation: generation,
        local_protocol_version: PROTOCOL_VERSION,
        local_schema_version: schema_version,
        pairing_id: input.pairing_id,
        offer,
        peer: input.peer,
        last_counter: input.last_counter.unwrap_or(0),
    };
    // §8.4: the snapshot is read in Rust, under the same connection lock every
    // other reader takes, because §8.4 requires one transaction across the whole
    // read and the webview cannot hold one across an IPC round trip.
    let reader = app.clone();
    // These three readers feed the window's `note`, which is a diagnostic
    // channel (it also relays the peer's own words), so they keep a single
    // string: `Refusal::diagnostic` carries the layer's detail.
    let snapshot: crate::pairing_listener::SnapshotSource = std::sync::Arc::new(move || {
        let db_state = reader
            .try_state::<AppState>()
            .ok_or_else(|| Refusal::new("rust.error.stateUnavailable").diagnostic())?;
        let conn = lock_conn(&db_state).map_err(|e| e.diagnostic())?;
        crate::pairing_snapshot::read_snapshot(&conn)
    });
    // §11.5: the window is on the LAN only while pairing is on screen; the
    // panel closes it on expiry, on close, on lock and on app background.
    // §6: this window's own operations, read in Rust for the snapshot's reason
    // — the read is the app's connection, taken under the one lock every other
    // reader takes, and the listener holds it for the window's life.
    let sync_reader = app.clone();
    let sync_source: crate::pairing_listener::SyncSource = std::sync::Arc::new(move |after_seq| {
        let db_state = sync_reader
            .try_state::<AppState>()
            .ok_or_else(|| Refusal::new("rust.error.stateUnavailable").diagnostic())?;
        let conn = lock_conn(&db_state).map_err(|e| e.diagnostic())?;
        let mut statement = conn
            .prepare(
                "SELECT device_id, seq, op_id, entity_table, entity_uid, op, \
                 base_counter, counter, field_stamps, payload FROM sync_outbox \
                 WHERE seq > ? ORDER BY seq",
            )
            .map_err(|error| Refusal::from(error.to_string()).diagnostic())?;
        let rows = statement
            .query_map([after_seq as i64], |row| {
                Ok(serde_json::json!({
                    "device_id": row.get::<_, String>(0)?,
                    "seq": row.get::<_, i64>(1)? as u64,
                    "op_id": row.get::<_, String>(2)?,
                    "entity_table": row.get::<_, String>(3)?,
                    "entity_uid": row.get::<_, String>(4)?,
                    "op": row.get::<_, String>(5)?,
                    "base_counter": row.get::<_, i64>(6)? as u64,
                    "counter": row.get::<_, i64>(7)? as u64,
                    "field_stamps": row.get::<_, String>(8)?,
                    "payload": row.get::<_, String>(9)?,
                }))
            })
            .map_err(|error| Refusal::from(error.to_string()).diagnostic())?;
        let mut ops = Vec::new();
        for row in rows {
            ops.push(row.map_err(|error| Refusal::from(error.to_string()).diagnostic())?);
        }
        Ok(ops)
    });
    listener.set_sync_source(sync_source);
    // F-2: the same window also serves the vault pair at batch level, so a
    // vault set up here reaches the phone even while it holds no items —
    // the §12.3 envelope otherwise rides on rows an empty vault never has.
    let vault_reader = app.clone();
    let vault_meta_source: crate::pairing_listener::VaultMetaSource =
        std::sync::Arc::new(move || {
            let db_state = vault_reader
                .try_state::<AppState>()
                .ok_or_else(|| Refusal::new("rust.error.stateUnavailable").diagnostic())?;
            let conn = lock_conn(&db_state).map_err(|e| e.diagnostic())?;
            let (generation, verifier) = crate::pairing_snapshot::vault_metadata(&conn)?;
            Ok(verifier.map(|v| (if generation >= 1 { generation } else { 1 }, v)))
        });
    listener.set_vault_meta_source(vault_meta_source);
    listener
        .start("0.0.0.0", window, identity, Some(snapshot))
        .map_err(Refusal::from)
}

/// Close the pairing window. Idempotent, and called by the lock and app-
/// background paths as well as by the panel's own close (§11.5).
#[tauri::command]
pub fn pairing_close(state: State<'_, PairingListenerState>) -> CmdResult<PairingListenerInfo> {
    refuse_mobile_role()?;
    state.stop().map_err(Refusal::from)
}

/// Current pairing state — including the peer a code-confirmed rendezvous
/// pinned, which the panel then stores as its pin (§11.2).
#[tauri::command]
pub fn pairing_status(state: State<'_, PairingListenerState>) -> CmdResult<PairingListenerInfo> {
    refuse_mobile_role()?;
    state.status().map_err(Refusal::from)
}

/// The pairing identity's state, for the re-pair recovery (§11.2, wave 1 N2).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingIdentityStatus {
    /// Whether a keypair is stored and readable right now.
    pub present: bool,
    pub public_key: Option<String>,
    pub fingerprint: Option<String>,
    /// The key is missing over an existing pairing, or can never be opened
    /// again: the confirmed replacement is what repairs it.
    pub needs_re_pair: bool,
    /// The stored identity exists but the platform key store can no longer open
    /// it — the typed `Lost` class, never inferred from a message.
    pub lost: bool,
    /// `sync_state.re_pair_required` as stored.
    pub re_pair_required: bool,
    /// Why the identity is unusable, in the words the panel shows.
    pub note: Option<String>,
}

/// Report the identity without minting anything, so the panel can offer the
/// confirmed re-pair instead of a dead end (N2).
#[tauri::command]
pub fn pairing_identity_status(app: tauri::AppHandle) -> CmdResult<PairingIdentityStatus> {
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let (history, flagged) = {
        let conn = lock_conn(&db_state)?;
        (pairing_history(&conn)?, re_pair_required(&conn)?)
    };
    match pairing_key::inspect(history) {
        Ok(stored) => Ok(PairingIdentityStatus {
            present: stored.is_some(),
            public_key: stored.as_ref().map(|identity| identity.public_key_hex()),
            fingerprint: stored.as_ref().map(|identity| identity.fingerprint()),
            needs_re_pair: flagged,
            lost: false,
            re_pair_required: flagged,
            note: None,
        }),
        Err(error) => Ok(PairingIdentityStatus {
            present: false,
            public_key: None,
            fingerprint: None,
            needs_re_pair: error.needs_re_pair_flag() || flagged,
            lost: matches!(error, crate::pairing_key::PairingKeyError::Lost(_)),
            re_pair_required: flagged,
            note: Some(error.message().to_string()),
        }),
    }
}

/// What the phone needs from the scanned offer to reach the desktop (§11.1).
/// The device id, schema and protocol come from this device in Rust; the
/// webview supplies only what the code itself carried, and no data line (D1).
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingPhoneInput {
    pub endpoint: String,
    pub pairing_id: String,
    pub public_key: String,
    pub code: String,
}

/// The desktop's authoritative facts, opened from its sealed ack (§11.6.1).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhonePairResult {
    pub desktop_device_id: String,
    pub desktop_public_key: String,
    pub desktop_fingerprint: String,
    pub pairing_id: String,
    pub generation: u64,
    pub schema_version: u64,
    pub protocol_version: u64,
}

/// Pair this phone with the desktop whose offer was scanned (§11.1, §11.6.1).
///
/// The whole handshake happens in Rust because the long-term key does: the
/// webview never sees the secret (§11.2). Nothing is written here — the pin is
/// the caller's `sync_peers` write, made only after this returns, i.e. only
/// after the sealed hello proved this phone holds the key it presented (wave 1
/// N1, mirrored on the phone).
#[tauri::command]
pub fn pairing_phone_pair(
    app: tauri::AppHandle,
    input: PairingPhoneInput,
) -> CmdResult<PhonePairResult> {
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let (device_id, _generation, schema_version) = local_sync_facts(&db_state)?;
    let identity = load_pairing_identity(&db_state)?;
    let target = crate::pairing_client::PairingTarget {
        endpoint: &input.endpoint,
        pairing_id: &input.pairing_id,
        desktop_public_key: &input.public_key,
        code: &input.code,
    };
    let facts = crate::pairing_client::PhoneFacts {
        device_id: &device_id,
        protocol_version: PROTOCOL_VERSION,
        schema_version,
    };
    let ack = crate::pairing_client::request_pairing(&target, &facts, &identity)
        .map_err(|error| Refusal::from(error.to_string()))?;
    crate::pairing_client::send_hello(
        &target,
        &facts,
        &identity,
        &ack,
        crate::pairing_client::next_hello_counter(),
    )
    .map_err(|error| Refusal::from(error.to_string()))?;
    Ok(PhonePairResult {
        desktop_device_id: ack.desktop_device_id,
        desktop_fingerprint: pairing_key::fingerprint_of(&input.public_key),
        desktop_public_key: input.public_key,
        pairing_id: ack.pairing_id,
        generation: ack.generation,
        schema_version: ack.schema_version,
        protocol_version: ack.protocol_version,
    })
}

/// What the phone must name to pull: the pinned desktop, and the address the
/// offer carried. The key, the data line and the pairing id are the PIN's —
/// read in Rust from `sync_peers`, never taken from the caller (§11.2).
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotPullInput {
    pub endpoint: String,
    pub desktop_device_id: String,
}

/// One batch as the phone's UI receives it: still unvalidated, because
/// validation is `store.ts`'s (§8.4 — the payload is the desktop's document,
/// not this side's statement).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotBatchResult {
    /// The pairing the batch belongs to, echoed from the sealed document so the
    /// webview can refuse one that names another (§11.4) — the same check this
    /// side already made, made again where the rows are used.
    pub pairing_id: String,
    pub batch: u64,
    pub total: u64,
    pub ops: Vec<serde_json::Value>,
    pub tombstones: Vec<serde_json::Value>,
}

/// The pinned desktop's facts for one pull.
struct PinnedPull {
    pairing_id: String,
    public_key: String,
    generation: u64,
}

/// Read the pin, refusing an unpinned or revoked desktop before any socket
/// exists. This is what stops the webview from naming a peer that was never
/// proven: it supplies an address, never a key.
fn pinned_pull(db_state: &AppState, device_id: &str) -> CmdResult<PinnedPull> {
    let conn = lock_conn(db_state)?;
    let mut statement = conn
        .prepare(
            "SELECT pairing_id, public_key, generation FROM sync_peers \
             WHERE device_id = ? AND revoked_at IS NULL",
        )
        .map_err(|error| Refusal::from(error.to_string()))?;
    let mut rows = statement
        .query([device_id])
        .map_err(|error| Refusal::from(error.to_string()))?;
    let Some(row) = rows
        .next()
        .map_err(|error| Refusal::from(error.to_string()))?
    else {
        return Err(Refusal::new("rust.error.notPinned"));
    };
    let pairing_id: Option<String> = row
        .get(0)
        .map_err(|error| Refusal::from(error.to_string()))?;
    let public_key: Option<String> = row
        .get(1)
        .map_err(|error| Refusal::from(error.to_string()))?;
    // `sync_peers.generation` is a SQLite INTEGER: i64 in, u64 out.
    let generation: i64 = row
        .get(2)
        .map_err(|error| Refusal::from(error.to_string()))?;
    let generation = u64::try_from(generation).unwrap_or(0);
    let pairing_id = pairing_id
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "that pin carries no pairing id, so it cannot be pulled from (§11.4).".to_string()
        })?;
    let public_key = public_key
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "that pin carries no desktop key, so it cannot be pulled from (§11.2).".to_string()
        })?;
    Ok(PinnedPull {
        pairing_id,
        public_key,
        generation,
    })
}

/// Request one batch of the §8.4 snapshot.
///
/// The sealed exchange runs in Rust because the phone's key does (§11.2): the
/// webview receives rows, never ciphertext and never the secret. Nothing is
/// written — what the phone does with a batch is its own one transaction, at
/// the end.
#[tauri::command]
pub fn pairing_snapshot_request(
    app: tauri::AppHandle,
    input: SnapshotPullInput,
    batch: u64,
) -> CmdResult<SnapshotBatchResult> {
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let (device_id, _generation, schema_version) = local_sync_facts(&db_state)?;
    let pin = pinned_pull(&db_state, &input.desktop_device_id)?;
    let identity = load_pairing_identity(&db_state)?;
    let pull = crate::pairing_client::SnapshotPull {
        endpoint: &input.endpoint,
        pairing_id: &pin.pairing_id,
        desktop_public_key: &pin.public_key,
        desktop_device_id: &input.desktop_device_id,
        generation: pin.generation,
    };
    let facts = crate::pairing_client::PhoneFacts {
        device_id: &device_id,
        protocol_version: PROTOCOL_VERSION,
        schema_version,
    };
    let reply = crate::pairing_client::request_snapshot(
        &pull,
        &facts,
        &identity,
        crate::pairing_client::process_counters(),
        batch,
    )
    .map_err(|error| Refusal::from(error.to_string()))?;
    let list = |key: &str| {
        reply
            .get(key)
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default()
    };
    Ok(SnapshotBatchResult {
        pairing_id: pin.pairing_id.clone(),
        batch,
        total: reply
            .get("total")
            .and_then(|value| value.as_u64())
            .unwrap_or(1),
        ops: list("ops"),
        tombstones: list("tombstones"),
    })
}

/// Acknowledge one staged batch. The desktop keeps the bookkeeping; the phone
/// has still applied nothing (§8.4).
#[tauri::command]
pub fn pairing_snapshot_applied(
    app: tauri::AppHandle,
    input: SnapshotPullInput,
    batch: u64,
) -> CmdResult<()> {
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let (device_id, _generation, schema_version) = local_sync_facts(&db_state)?;
    let pin = pinned_pull(&db_state, &input.desktop_device_id)?;
    let identity = load_pairing_identity(&db_state)?;
    let pull = crate::pairing_client::SnapshotPull {
        endpoint: &input.endpoint,
        pairing_id: &pin.pairing_id,
        desktop_public_key: &pin.public_key,
        desktop_device_id: &input.desktop_device_id,
        generation: pin.generation,
    };
    let facts = crate::pairing_client::PhoneFacts {
        device_id: &device_id,
        protocol_version: PROTOCOL_VERSION,
        schema_version,
    };
    crate::pairing_client::acknowledge_batch(
        &pull,
        &facts,
        &identity,
        crate::pairing_client::process_counters(),
        batch,
    )
    .map_err(|error| Refusal::from(error.to_string()))
}

/// Acknowledge the whole snapshot, with the counts the §9.3 summary shows.
///
/// This is the only message that closes a pull, and the desktop refuses it
/// unless every batch was acknowledged: the phone must not be able to call a
/// partly-received snapshot adopted (§8.4).
#[tauri::command]
pub fn pairing_snapshot_adopted(
    app: tauri::AppHandle,
    input: SnapshotPullInput,
    rows: u64,
    tombstones: u64,
) -> CmdResult<()> {
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let (device_id, _generation, schema_version) = local_sync_facts(&db_state)?;
    let pin = pinned_pull(&db_state, &input.desktop_device_id)?;
    let identity = load_pairing_identity(&db_state)?;
    let pull = crate::pairing_client::SnapshotPull {
        endpoint: &input.endpoint,
        pairing_id: &pin.pairing_id,
        desktop_public_key: &pin.public_key,
        desktop_device_id: &input.desktop_device_id,
        generation: pin.generation,
    };
    let facts = crate::pairing_client::PhoneFacts {
        device_id: &device_id,
        protocol_version: PROTOCOL_VERSION,
        schema_version,
    };
    crate::pairing_client::acknowledge_snapshot(
        &pull,
        &facts,
        &identity,
        crate::pairing_client::process_counters(),
        rows,
        tombstones,
    )
    .map_err(|error| Refusal::from(error.to_string()))
}

/// Send one batch of this phone's own records to the pinned desktop (§9.1).
///
/// The sealed exchange runs in Rust for the same reason the pull's does
/// (§11.2): the webview hands over rows, never ciphertext and never the
/// secret. The desktop only stages the batch — its panel applies the whole
/// upload in one transaction after the commit.
#[tauri::command]
pub fn pairing_upload_batch(
    app: tauri::AppHandle,
    input: SnapshotPullInput,
    batch: u64,
    total: u64,
    ops: Vec<serde_json::Value>,
) -> CmdResult<()> {
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let (device_id, _generation, schema_version) = local_sync_facts(&db_state)?;
    let pin = pinned_pull(&db_state, &input.desktop_device_id)?;
    let identity = load_pairing_identity(&db_state)?;
    let pull = crate::pairing_client::SnapshotPull {
        endpoint: &input.endpoint,
        pairing_id: &pin.pairing_id,
        desktop_public_key: &pin.public_key,
        desktop_device_id: &input.desktop_device_id,
        generation: pin.generation,
    };
    let facts = crate::pairing_client::PhoneFacts {
        device_id: &device_id,
        protocol_version: PROTOCOL_VERSION,
        schema_version,
    };
    crate::pairing_client::send_upload_batch(
        &pull,
        &facts,
        &identity,
        crate::pairing_client::process_counters(),
        batch,
        total,
        &ops,
    )
    .map_err(|error| Refusal::from(error.to_string()))
}

/// Tell the pinned desktop every upload batch was sent (§9.1). It refuses
/// unless all of them are staged, so a resolved commit means the desktop
/// holds the whole upload — staged for its panel's one applying transaction.
#[tauri::command]
pub fn pairing_upload_commit(app: tauri::AppHandle, input: SnapshotPullInput) -> CmdResult<()> {
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let (device_id, _generation, schema_version) = local_sync_facts(&db_state)?;
    let pin = pinned_pull(&db_state, &input.desktop_device_id)?;
    let identity = load_pairing_identity(&db_state)?;
    let pull = crate::pairing_client::SnapshotPull {
        endpoint: &input.endpoint,
        pairing_id: &pin.pairing_id,
        desktop_public_key: &pin.public_key,
        desktop_device_id: &input.desktop_device_id,
        generation: pin.generation,
    };
    let facts = crate::pairing_client::PhoneFacts {
        device_id: &device_id,
        protocol_version: PROTOCOL_VERSION,
        schema_version,
    };
    crate::pairing_client::send_upload_commit(
        &pull,
        &facts,
        &identity,
        crate::pairing_client::process_counters(),
    )
    .map_err(|error| Refusal::from(error.to_string()))
}

/// The desktop's verdict on this phone's upload (§9.1), as the sealed reply
/// reported it: `pending` until its panel's apply decides, then `uploaded`
/// with the counts, or `failed` with the apply's reason.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadStatusResult {
    pub state: String,
    pub inserted: u64,
    pub already_known: u64,
    pub message: Option<String>,
}

#[tauri::command]
pub fn pairing_upload_status(
    app: tauri::AppHandle,
    input: SnapshotPullInput,
) -> CmdResult<UploadStatusResult> {
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let (device_id, _generation, schema_version) = local_sync_facts(&db_state)?;
    let pin = pinned_pull(&db_state, &input.desktop_device_id)?;
    let identity = load_pairing_identity(&db_state)?;
    let pull = crate::pairing_client::SnapshotPull {
        endpoint: &input.endpoint,
        pairing_id: &pin.pairing_id,
        desktop_public_key: &pin.public_key,
        desktop_device_id: &input.desktop_device_id,
        generation: pin.generation,
    };
    let facts = crate::pairing_client::PhoneFacts {
        device_id: &device_id,
        protocol_version: PROTOCOL_VERSION,
        schema_version,
    };
    let reply = crate::pairing_client::poll_upload_status(
        &pull,
        &facts,
        &identity,
        crate::pairing_client::process_counters(),
    )
    .map_err(|error| Refusal::from(error.to_string()))?;
    let number = |key: &str| reply.get(key).and_then(|value| value.as_u64()).unwrap_or(0);
    Ok(UploadStatusResult {
        state: reply
            .get("state")
            .and_then(|value| value.as_str())
            .unwrap_or("pending")
            .to_string(),
        inserted: number("inserted"),
        already_known: number("alreadyKnown"),
        message: reply
            .get("message")
            .and_then(|value| value.as_str())
            .map(str::to_string),
    })
}

/// The staged upload the desktop panel applies (§9.1): the pairing it belongs
/// to and every op the phone committed, as wire documents. `None` until a
/// phone commits a complete upload in this window.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadTakeResult {
    pub pairing_id: String,
    pub ops: Vec<serde_json::Value>,
}

/// Take the staged §9.1 upload for the panel's apply. Taking is once: a
/// second call returns `None`, so the same staging can never be applied
/// twice by two ticks racing (§7.2). Nothing is written here — the apply is
/// the caller's one `sync_peers`-style transaction over the app database.
#[tauri::command]
pub fn pairing_upload_take(
    state: State<'_, PairingListenerState>,
) -> CmdResult<Option<UploadTakeResult>> {
    Ok(state
        .take_upload()
        .map(|(pairing_id, ops)| UploadTakeResult { pairing_id, ops }))
}

/// What the panel's apply decided (§9.1): either the counts of a committed
/// transaction, or the failure's reason. Exactly one of the two shapes —
/// `inserted`/`alreadyKnown` together, or `error` alone.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadOutcomeInput {
    pub inserted: Option<u64>,
    pub already_known: Option<u64>,
    pub error: Option<String>,
}

/// Report the panel's apply outcome, so the listener can seal the verdict to
/// the phone. The first outcome stands; reporting twice changes nothing.
#[tauri::command]
pub fn pairing_upload_outcome(
    state: State<'_, PairingListenerState>,
    input: UploadOutcomeInput,
) -> CmdResult<()> {
    let outcome = match (input.inserted, input.already_known, input.error) {
        (Some(inserted), Some(already_known), None) => {
            crate::pairing_listener::UploadOutcome::Applied {
                inserted,
                already_known,
            }
        }
        (None, None, Some(message)) => crate::pairing_listener::UploadOutcome::Failed { message },
        _ => return Err(Refusal::new("rust.error.uploadOutcome")),
    };
    state.set_upload_outcome(outcome);
    Ok(())
}

/// The phone's facts for one §6 exchange, read once: its own id and schema from
/// the database, and the pin's key, pairing id and data line — never from the
/// webview, which supplies an address only.
struct SyncPhoneFacts {
    device_id: String,
    pairing_id: String,
    desktop_public_key: String,
    generation: u64,
    schema_version: u64,
}

fn sync_phone_facts(
    app: &tauri::AppHandle,
    input: &SnapshotPullInput,
) -> CmdResult<SyncPhoneFacts> {
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let (device_id, _generation, schema_version) = local_sync_facts(&db_state)?;
    let pin = pinned_pull(&db_state, &input.desktop_device_id)?;
    Ok(SyncPhoneFacts {
        device_id,
        pairing_id: pin.pairing_id,
        desktop_public_key: pin.public_key,
        generation: pin.generation,
        schema_version,
    })
}

/// Send one batch of this phone's operations to the pinned desktop (§6.2). The
/// sealed exchange runs in Rust because the phone's key does (§11.2).
#[tauri::command]
pub fn pairing_sync_push(
    app: tauri::AppHandle,
    input: SnapshotPullInput,
    batch: u64,
    total: u64,
    ops: Vec<serde_json::Value>,
) -> CmdResult<()> {
    let facts = sync_phone_facts(&app, &input)?;
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let identity = load_pairing_identity(&db_state)?;
    let pull = crate::pairing_client::SnapshotPull {
        endpoint: &input.endpoint,
        pairing_id: &facts.pairing_id,
        desktop_public_key: &facts.desktop_public_key,
        desktop_device_id: &input.desktop_device_id,
        generation: facts.generation,
    };
    let phone = crate::pairing_client::PhoneFacts {
        device_id: &facts.device_id,
        protocol_version: PROTOCOL_VERSION,
        schema_version: facts.schema_version,
    };
    crate::pairing_client::send_sync_push(
        &pull,
        &phone,
        &identity,
        crate::pairing_client::process_counters(),
        batch,
        total,
        &ops,
    )
    .map_err(|error| Refusal::from(error.to_string()))
}

/// Tell the pinned desktop every pushed batch was sent (§6.2).
#[tauri::command]
pub fn pairing_sync_commit(app: tauri::AppHandle, input: SnapshotPullInput) -> CmdResult<()> {
    let facts = sync_phone_facts(&app, &input)?;
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let identity = load_pairing_identity(&db_state)?;
    let pull = crate::pairing_client::SnapshotPull {
        endpoint: &input.endpoint,
        pairing_id: &facts.pairing_id,
        desktop_public_key: &facts.desktop_public_key,
        desktop_device_id: &input.desktop_device_id,
        generation: facts.generation,
    };
    let phone = crate::pairing_client::PhoneFacts {
        device_id: &facts.device_id,
        protocol_version: PROTOCOL_VERSION,
        schema_version: facts.schema_version,
    };
    crate::pairing_client::send_sync_commit(
        &pull,
        &phone,
        &identity,
        crate::pairing_client::process_counters(),
    )
    .map_err(|error| Refusal::from(error.to_string()))
}

/// One batch of the pinned desktop's own operations after `afterSeq` (§6.3).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBatchResult {
    pub pairing_id: String,
    pub batch: u64,
    pub total: u64,
    pub ops: Vec<serde_json::Value>,
}

#[tauri::command]
pub fn pairing_sync_pull(
    app: tauri::AppHandle,
    input: SnapshotPullInput,
    batch: u64,
    after_seq: u64,
) -> CmdResult<SyncBatchResult> {
    let facts = sync_phone_facts(&app, &input)?;
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let identity = load_pairing_identity(&db_state)?;
    let pull = crate::pairing_client::SnapshotPull {
        endpoint: &input.endpoint,
        pairing_id: &facts.pairing_id,
        desktop_public_key: &facts.desktop_public_key,
        desktop_device_id: &input.desktop_device_id,
        generation: facts.generation,
    };
    let phone = crate::pairing_client::PhoneFacts {
        device_id: &facts.device_id,
        protocol_version: PROTOCOL_VERSION,
        schema_version: facts.schema_version,
    };
    let reply = crate::pairing_client::pull_sync_ops(
        &pull,
        &phone,
        &identity,
        crate::pairing_client::process_counters(),
        batch,
        after_seq,
    )
    .map_err(|error| Refusal::from(error.to_string()))?;
    Ok(SyncBatchResult {
        pairing_id: facts.pairing_id,
        batch,
        total: reply
            .get("total")
            .and_then(|value| value.as_u64())
            .unwrap_or(1),
        ops: reply
            .get("ops")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default(),
    })
}

/// Report that this phone applied the desktop's operations through `throughSeq`
/// (§6.5).
#[tauri::command]
pub fn pairing_sync_applied(
    app: tauri::AppHandle,
    input: SnapshotPullInput,
    through_seq: u64,
) -> CmdResult<()> {
    let facts = sync_phone_facts(&app, &input)?;
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let identity = load_pairing_identity(&db_state)?;
    let pull = crate::pairing_client::SnapshotPull {
        endpoint: &input.endpoint,
        pairing_id: &facts.pairing_id,
        desktop_public_key: &facts.desktop_public_key,
        desktop_device_id: &input.desktop_device_id,
        generation: facts.generation,
    };
    let phone = crate::pairing_client::PhoneFacts {
        device_id: &facts.device_id,
        protocol_version: PROTOCOL_VERSION,
        schema_version: facts.schema_version,
    };
    crate::pairing_client::send_sync_applied(
        &pull,
        &phone,
        &identity,
        crate::pairing_client::process_counters(),
        through_seq,
    )
    .map_err(|error| Refusal::from(error.to_string()))
}

/// The desktop's verdict on this phone's push, as its sealed reply reported it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusResult {
    pub state: String,
    pub through_seq: u64,
    pub message: Option<String>,
}

#[tauri::command]
pub fn pairing_sync_status(
    app: tauri::AppHandle,
    input: SnapshotPullInput,
) -> CmdResult<SyncStatusResult> {
    let facts = sync_phone_facts(&app, &input)?;
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let identity = load_pairing_identity(&db_state)?;
    let pull = crate::pairing_client::SnapshotPull {
        endpoint: &input.endpoint,
        pairing_id: &facts.pairing_id,
        desktop_public_key: &facts.desktop_public_key,
        desktop_device_id: &input.desktop_device_id,
        generation: facts.generation,
    };
    let phone = crate::pairing_client::PhoneFacts {
        device_id: &facts.device_id,
        protocol_version: PROTOCOL_VERSION,
        schema_version: facts.schema_version,
    };
    let reply = crate::pairing_client::poll_sync_status(
        &pull,
        &phone,
        &identity,
        crate::pairing_client::process_counters(),
    )
    .map_err(|error| Refusal::from(error.to_string()))?;
    Ok(SyncStatusResult {
        state: reply
            .get("state")
            .and_then(|value| value.as_str())
            .unwrap_or("pending")
            .to_string(),
        through_seq: reply
            .get("throughSeq")
            .and_then(|value| value.as_u64())
            .unwrap_or(0),
        message: reply
            .get("message")
            .and_then(|value| value.as_str())
            .map(str::to_string),
    })
}

/// The staged §6 push the desktop panel applies: the operations as wire
/// documents. `None` until a phone commits a complete push in this window.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTakeResult {
    pub ops: Vec<serde_json::Value>,
}

#[tauri::command]
pub fn pairing_sync_take(
    state: State<'_, PairingListenerState>,
) -> CmdResult<Option<SyncTakeResult>> {
    refuse_mobile_role()?;
    Ok(state.take_sync_push().map(|ops| SyncTakeResult { ops }))
}

/// What the panel's engine decided about a staged push: the highest seq it
/// applied, or the refusal's own words. Exactly one of the two.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcomeInput {
    pub applied_through: Option<u64>,
    pub error: Option<String>,
}

#[tauri::command]
pub fn pairing_sync_outcome(
    state: State<'_, PairingListenerState>,
    input: SyncOutcomeInput,
) -> CmdResult<()> {
    refuse_mobile_role()?;
    let outcome = match (input.applied_through, input.error) {
        (Some(through_seq), None) => crate::pairing_listener::SyncOutcome::Applied { through_seq },
        (None, Some(message)) => crate::pairing_listener::SyncOutcome::Failed { message },
        _ => return Err(Refusal::new("rust.error.syncOutcome")),
    };
    state.set_sync_outcome(outcome);
    Ok(())
}

/// Mint a fresh pairing identity after an explicit confirmation (§11.4, N2).
///
/// Deletes only `Slot::PairingIdentity`: local notes, tasks and the database key
/// are untouched, so this is re-pairing, not a factory reset. The flag is set
/// because every peer's pin names the old key, so each peer pairs again.
#[tauri::command]
pub fn pairing_identity_replace(
    app: tauri::AppHandle,
    confirm: bool,
) -> CmdResult<PairingIdentityStatus> {
    if !confirm {
        return Err(Refusal::new("rust.error.rePairConfirm"));
    }
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let identity = pairing_key::replace_after_confirmation().map_err(|error| {
        Refusal::new("rust.error.pairingIdentity").with("detail", error.message())
    })?;
    {
        let conn = lock_conn(&db_state)?;
        mark_re_pair_required(&conn)?;
    }
    Ok(PairingIdentityStatus {
        present: true,
        public_key: Some(identity.public_key_hex()),
        fingerprint: Some(identity.fingerprint()),
        needs_re_pair: true,
        lost: false,
        re_pair_required: true,
        note: None,
    })
}

#[cfg(test)]
mod tests {
    use super::{lock_conn, mark_re_pair_required, pairing_history, re_pair_required};

    /// A database just far enough along to answer the pairing-history question:
    /// `sync_state` with its flag, and `sync_peers` with `pins` devices pinned.
    fn pairing_db(pins: usize) -> crate::db::AppState {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(
            "CREATE TABLE sync_state (
                 id INTEGER PRIMARY KEY CHECK (id = 1),
                 re_pair_required INTEGER NOT NULL DEFAULT 0,
                 updated_at TEXT NOT NULL
             );
             INSERT INTO sync_state (id, re_pair_required, updated_at)
                 VALUES (1, 0, '2026-01-01T00:00:00Z');
             CREATE TABLE sync_peers (device_id TEXT PRIMARY KEY);",
        )
        .expect("schema");
        for index in 0..pins {
            conn.execute(
                "INSERT INTO sync_peers (device_id) VALUES (?1)",
                [format!("peers-{index}")],
            )
            .expect("pin");
        }
        crate::db::AppState {
            conn: std::sync::Mutex::new(Some(conn)),
            txn_open: std::sync::atomic::AtomicBool::new(false),
            reset_terminal: std::sync::atomic::AtomicBool::new(false),
            data_dir: std::path::PathBuf::from("unused"),
        }
    }

    /// §11.2 (N2): the fail-closed decision needs one database fact — has this
    /// install ever paired — and a pin is what says so.
    #[test]
    fn the_pairing_history_is_whether_a_pin_exists() {
        let fresh = pairing_db(0);
        let conn = lock_conn(&fresh).expect("conn");
        assert_eq!(
            pairing_history(&conn).expect("history"),
            crate::pairing_key::PairingHistory::Never
        );
        drop(conn);

        let paired = pairing_db(1);
        let conn = lock_conn(&paired).expect("conn");
        assert_eq!(
            pairing_history(&conn).expect("history"),
            crate::pairing_key::PairingHistory::Paired,
            "one pin is enough to make a missing key key loss"
        );
    }

    /// The flag is what the panel reads to offer the confirmed re-pair, and
    /// recording it must move nothing else (notes and tasks stay readable).
    #[test]
    fn recording_a_required_re_pair_moves_only_the_flag() {
        let state = pairing_db(1);
        let conn = lock_conn(&state).expect("conn");
        assert!(!re_pair_required(&conn).expect("flag"));
        mark_re_pair_required(&conn).expect("mark");
        assert!(re_pair_required(&conn).expect("flag"));
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_state", [], |row| row.get(0))
            .expect("state rows");
        let peers: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_peers", [], |row| row.get(0))
            .expect("peer rows");
        assert_eq!((rows, peers), (1, 1), "only the flag may change");
    }

    /// Once factory reset has taken the connection, every DB command
    /// must fail closed with a clear message instead of touching a deleted
    /// file. All the DB commands reach the connection through `lock_conn`, so
    /// this one seam IS the behaviour of every one of them.
    #[test]
    fn db_commands_fail_closed_after_the_connection_is_taken() {
        let state = crate::db::AppState {
            conn: std::sync::Mutex::new(None),
            txn_open: std::sync::atomic::AtomicBool::new(false),
            reset_terminal: std::sync::atomic::AtomicBool::new(false),
            data_dir: std::path::PathBuf::from("unused"),
        };
        let error = match lock_conn(&state) {
            Ok(_) => panic!("a taken connection must fail closed"),
            Err(e) => e,
        };
        assert_eq!(error.key, "rust.error.dbClosed");
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
            reset_terminal: std::sync::atomic::AtomicBool::new(false),
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

    /// D6/D2: the terminal flag is set once the durable marker is written —
    /// never on command entry, and no longer only when the engine returns.
    ///
    /// A marker that cannot be recorded returns before the flag is raised, so
    /// that session still runs normally and keeps close-to-tray (the D6 rule).
    /// Once the marker IS on disk the reset can no longer be abandoned — a
    /// failed engine leaves it, and the next boot's recovery pass finishes the
    /// job — so the engine that follows (taking the connection, deleting the
    /// photo tree and the safety copies) must not leave close-to-tray armed
    /// over a terminal session. That was D2: waiting for the engine's return
    /// hid the reset result screen behind the tray for as long as the deletion
    /// ran. A source pin because the ORDER is the invariant; `factory_reset`
    /// takes an `AppHandle` and runs the engine through seams, so it is pinned
    /// the same way `lib.rs` pins its tray wiring.
    #[test]
    fn factory_reset_marks_the_session_terminal_at_the_recovery_marker() {
        let src = include_str!("commands.rs");
        let start = src
            .find("pub async fn factory_reset(")
            .expect("factory_reset exists");
        let end = src[start..]
            .find("#[tauri::command]")
            .map(|i| start + i)
            .unwrap_or(src.len());
        let body = &src[start..end];
        let marker = body
            .find("mark_reset_started(&db_state.data_dir)?")
            .expect("the reset is recorded before anything is deleted (E3)");
        let terminal = body
            .find("reset_terminal")
            .expect("the marker marks the session terminal (D6/D2)");
        let barrier = body
            .find("raise_reset()")
            .expect("the barrier is raised before the engine (E1)");
        let engine = body.find("run_factory_reset(").expect("the engine runs");
        assert!(
            marker < terminal && terminal < barrier && barrier < engine,
            "order must be: marker -> terminal -> barrier -> engine \
             (found {marker}, {terminal}, {barrier}, {engine})"
        );
        assert!(
            body[terminal..].contains(".store(true"),
            "the flag is set, not merely read"
        );
        assert_eq!(
            body.matches(".store(true").count(),
            1,
            "one store, at the marker: a second one after the engine would \
             leave the window between them with close-to-tray still armed"
        );
    }

    /// E3: the durable marker brackets the engine — recorded before the
    /// barrier and the first deletion, cleared only after a `complete`
    /// outcome. A source pin because the ORDER is the invariant: recorded
    /// too late recreates the crash window E3 describes, cleared too early
    /// loses the recovery record.
    #[test]
    fn factory_reset_records_recovery_state_around_the_engine() {
        let src = include_str!("commands.rs");
        let start = src
            .find("pub async fn factory_reset(")
            .expect("factory_reset is the entry point");
        let end = src[start..]
            .find("pub fn app_restart(")
            .map(|i| start + i)
            .expect("app_restart bounds the body");
        let body = &src[start..end];
        let mark = body
            .find("mark_reset_started")
            .expect("the reset is recorded before it starts (E3)");
        let raise = body
            .find("raise_reset()")
            .expect("the barrier is raised (E1)");
        let run = body
            .find("run_factory_reset(")
            .expect("the engine runs after both");
        let clear = body
            .find("clear_reset_marker")
            .expect("the record is cleared after (E3)");
        assert!(
            mark < raise && raise < run && run < clear,
            "record -> raise -> run -> clear: {mark} {raise} {run} {clear}"
        );
        assert!(
            body.contains("if outcome.complete"),
            "the marker survives an incomplete outcome so the next start can finish it"
        );
    }

    /// E12: the break-glass reset asks SQLite first, under the connection
    /// lock, and only then clears the flag — with `?` between the two, so a
    /// failed rollback returns while the flag still says "transaction open"
    /// and every later write refuses (restart required) instead of joining
    /// an abandoned transaction.
    #[test]
    fn db_reset_txn_reconciles_under_the_lock_before_clearing_the_flag() {
        let src = include_str!("commands.rs");
        let start = src
            .find("fn db_reset_txn(")
            .expect("the break-glass command exists");
        let end = src[start..]
            .find("#[tauri::command]")
            .map(|i| start + i)
            .expect("the next command bounds the body");
        let body = &src[start..end];
        let lock = body
            .find("lock_conn")
            .expect("everything runs under the lock");
        let reconcile = body
            .find("reconcile_open_txn(&conn)?")
            .expect("SQLite is asked, with `?` gating the store (E12)");
        let store = body
            .find("txn_open.store")
            .expect("only then is the flag cleared");
        assert!(
            lock < reconcile && reconcile < store,
            "lock -> reconcile -> store: {lock} {reconcile} {store}"
        );
    }
}
