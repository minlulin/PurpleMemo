//! The 10 Rust IPC commands (§4): `db_query`, `db_execute`, `db_batch`,
//! `db_begin`, `db_commit`, `db_rollback`, `photo_save`, `photo_read`,
//! `photo_delete`, `db_key_export` (read-only keyring read, §5.4).
//!
//! Every command serializes through the single mutex-protected connection
//! (§4 — no pooling). UI pages never call these directly; they go through
//! the feature libraries and the data driver (P2).

use std::sync::atomic::Ordering;
use std::sync::MutexGuard;

use rusqlite::Connection;
use serde_json::Value as JsonValue;
use tauri::State;

use crate::db::{self, AppState, BatchStatement, ExecuteOutcome, JsonObj};
use crate::photos;

type CmdResult<T> = Result<T, String>;

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
#[tauri::command]
pub fn photo_save(state: State<'_, AppState>, bytes: Vec<u8>, ext: String) -> CmdResult<String> {
    let year_month: String = {
        let conn = lock_conn(&state)?;
        conn.query_row("SELECT strftime('%Y/%m', 'now', 'localtime')", [], |row| {
            row.get(0)
        })
        .map_err(|e| format!("local date lookup failed: {e}"))?
    };
    photos::save_photo(&state.data_dir, &year_month, &bytes, &ext)
}

/// Read photo bytes by DB-relative path (traversal-guarded).
#[tauri::command]
pub fn photo_read(state: State<'_, AppState>, rel_path: String) -> CmdResult<Vec<u8>> {
    photos::read_photo(&state.data_dir, &rel_path)
}

/// Delete a photo file by DB-relative path (traversal-guarded, idempotent).
/// DB rows referencing it are the feature layer's concern (P3e).
#[tauri::command]
pub fn photo_delete(state: State<'_, AppState>, rel_path: String) -> CmdResult<()> {
    photos::delete_photo(&state.data_dir, &rel_path)
}

/// Read the DB encryption key back out of the OS credential store for the
/// Settings key-export step (§2.8, §5.4). Read-only: never mints, never
/// touches the DB connection — the UI copies the key into its own file,
/// never into the backup zip.
#[tauri::command]
pub fn db_key_export() -> CmdResult<String> {
    db::read_db_key()
}
