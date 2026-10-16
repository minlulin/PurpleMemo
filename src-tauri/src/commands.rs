//! The Rust IPC commands (§4): `db_query`, `db_execute`, `db_batch`,
//! `db_begin`, `db_commit`, `db_rollback`, `photo_save`, `photo_read`,
//! `photo_read_thumb`, `photo_save_thumb`, `photo_delete`,
//! `db_key_save` (write the key to a file the user chose, §5.4), plus the
//! P5 share controls — `share_arm`, `share_start`, `share_stop`, `share_status`,
//! `share_publish` (§8). The share commands touch no SQL: they only control
//! the listener and the snapshot bytes the desktop published.
//!
//! Every command serializes through the single mutex-protected connection
//! (§4 — no pooling). UI pages never call these directly; they go through
//! the feature libraries and the data driver (P2).
//!
//! Photo bytes cross IPC as RAW payloads (review M-02): `photo_read` returns
//! `tauri::ipc::Response`, which the frontend receives as an `ArrayBuffer`
//! instead of a JSON array of byte numbers, and `photo_save`/
//! `photo_save_thumb` take the bytes as the raw request body. A raw body IS
//! the whole request, so the metadata they need (the extension, the source
//! photo path) travels in request headers — the documented channel for a raw
//! payload. Raw payloads are unsupported on Android only; this app bundles
//! desktop targets.

use std::sync::atomic::Ordering;
use std::sync::MutexGuard;

use rusqlite::Connection;
use serde_json::Value as JsonValue;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

use crate::db::{self, AppState, BatchStatement, ExecuteOutcome, JsonObj};
use crate::photos;
use crate::share::{ShareInfo, ShareState};

type CmdResult<T> = Result<T, String>;

/// Request header carrying the photo extension on a raw `photo_save` body.
const EXT_HEADER: &str = "x-photo-ext";
/// Request header carrying the SOURCE photo path on a raw `photo_save_thumb`
/// body — the thumbnail path itself is always derived in `photos.rs`.
const SOURCE_HEADER: &str = "x-photo-source";

fn raw_body<'a>(request: &'a Request<'_>) -> CmdResult<&'a [u8]> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
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

fn lock_conn(state: &AppState) -> CmdResult<MutexGuard<'_, Connection>> {
    state
        .conn
        .lock()
        .map_err(|_| "database mutex poisoned".to_string())
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
    sql: String,
    params: Option<Vec<JsonValue>>,
) -> CmdResult<ExecuteOutcome> {
    let conn = lock_conn(&state)?;
    db::execute(&conn, &sql, params.as_deref().unwrap_or(&[]))
}

/// Multi-statement writes, committed as one transaction inside Rust (§4).
#[tauri::command]
pub fn db_batch(state: State<'_, AppState>, statements: Vec<BatchStatement>) -> CmdResult<()> {
    let conn = lock_conn(&state)?;
    if state.txn_open.load(Ordering::SeqCst) {
        return Err("db_batch is not allowed while a manual transaction is open".to_string());
    }
    db::batch(&conn, &statements)
}

/// Start a manual transaction — short critical sections only (§4), the UI
/// must never hold it across awaits.
///
/// These commands are intentionally retained even though no app code calls
/// them today (review L-03): the plan mandates the surface, and every
/// multi-statement write already goes through [`db_batch`]. An abandoned
/// manual transaction makes [`db_batch`] fail until the app restarts or
/// something rolls it back.
///
/// The flag is only trustworthy because no *other* command can end a
/// transaction behind its back: `db::reject_dangerous_statement` now runs on
/// reads as well as writes, so `db_query` cannot COMMIT an open transaction or
/// BEGIN one the flag never saw. `db::tests::db_query_cannot_commit_or_begin_around_the_txn_flag`
/// is the regression that keeps it that way.
#[tauri::command]
pub fn db_begin(state: State<'_, AppState>) -> CmdResult<()> {
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
/// UI can still roll back.
#[tauri::command]
pub fn db_commit(state: State<'_, AppState>) -> CmdResult<()> {
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
pub fn db_rollback(state: State<'_, AppState>) -> CmdResult<()> {
    let conn = lock_conn(&state)?;
    if !state.txn_open.load(Ordering::SeqCst) {
        return Err("no open transaction to roll back".to_string());
    }
    db::rollback_tx(&conn)?;
    state.txn_open.store(false, Ordering::SeqCst);
    Ok(())
}

/// Store photo bytes content-addressed under `photos/<yyyy>/<mm>/`; the
/// yyyy/mm comes from SQLite's local-time clock so paths follow the user's
/// local date (§4). Returns the relative path the feature layer stores in
/// the `photos` table.
///
/// The bytes arrive as the RAW request body (`invoke('photo_save',
/// new Uint8Array(bytes), { headers: { 'x-photo-ext': ext } })`), so a 3 MB
/// photo crosses IPC as 3 MB instead of ~12 million JSON characters.
#[tauri::command]
pub fn photo_save(state: State<'_, AppState>, request: Request<'_>) -> CmdResult<String> {
    let ext = header_str(&request, EXT_HEADER)?.to_string();
    let bytes = raw_body(&request)?;
    let year_month: String = {
        let conn = lock_conn(&state)?;
        conn.query_row("SELECT strftime('%Y/%m', 'now', 'localtime')", [], |row| {
            row.get(0)
        })
        .map_err(|e| format!("local date lookup failed: {e}"))?
    };
    photos::save_photo(&state.data_dir, &year_month, bytes, &ext)
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
#[tauri::command]
pub fn photo_save_thumb(state: State<'_, AppState>, request: Request<'_>) -> CmdResult<String> {
    let source = header_str(&request, SOURCE_HEADER)?.to_string();
    let bytes = raw_body(&request)?;
    photos::save_thumb(&state.data_dir, &source, bytes)
}

/// Delete a photo file by DB-relative path (traversal-guarded, idempotent).
/// The derived thumbnail is deleted with it; DB rows referencing the photo are
/// the feature layer's concern (P3e).
#[tauri::command]
pub fn photo_delete(state: State<'_, AppState>, rel_path: String) -> CmdResult<()> {
    photos::delete_photo(&state.data_dir, &rel_path)
}

/// Write the DB encryption key to a file the user chose (§2.8, §5.4).
///
/// The path comes from the native save dialog and travels here as a plain
/// string — a path is not a secret, and the dialog is what constrains it. The
/// key does not come back: [`db::save_db_key_file`] reads it from the
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

/// Record that the user confirmed the LAN-share consent prompt, and return a
/// one-shot token for [`share_start`] (§8, review H-8).
///
/// Issuing a token is not consent — only starting the server consumes it, and
/// only once. Splitting it out means the bare `share_start` call, which is what
/// an accident or a stray invocation looks like, no longer opens a listener on
/// its own.
#[tauri::command]
pub fn share_arm(state: State<'_, ShareState>) -> CmdResult<String> {
    state.arm()
}

/// Turn on the read-only LAN share (§8): binds a fresh port, mints a pairing
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

/// Current share state — also reports a server that stopped itself after
/// repeated wrong pairing codes.
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
