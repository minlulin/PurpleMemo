//! The database commands: reads, single and batched writes, the manual
//! transaction family (begin/commit/rollback, plus the break-glass
//! `db_reset_txn`) and the one-way key export that writes the key to a file
//! the user chose.
//!
//! Moved verbatim out of `commands.rs` (P2/Session 3); the shared items they
//! use — `lock_conn`, `CmdResult` and `refuse_mobile_role` — stay in the
//! parent.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde_json::Value as JsonValue;
use tauri::Manager;

use super::{lock_conn, refuse_mobile_role, CmdResult};
use crate::db::{self, AppState, BatchStatement, ExecuteOutcome, JsonObj};
use crate::lifecycle::Lifecycle;
use crate::messages::Refusal;

/// SELECT-ish reads: rows as JSON objects keyed by column name.
///
/// Async + `spawn_blocking` (P1/B3): a slow FTS query or a large scan ran on
/// the main thread, where Tauri executes a synchronous command, so every
/// page's reads serialized on the UI thread. The work is unchanged and still
/// serializes — the single connection's mutex, taken *inside* the blocking
/// closure and never held across an `.await`, is what preserves ordering now,
/// not the thread.
#[tauri::command]
pub async fn db_query(
    app: tauri::AppHandle,
    sql: String,
    params: Option<Vec<JsonValue>>,
) -> CmdResult<Vec<JsonObj>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = lock_conn(&state)?;
        db::query_rows(&conn, &sql, params.as_deref().unwrap_or(&[])).map_err(Refusal::from)
    })
    .await
    .map_err(|e| Refusal::from(e.to_string()))?
}

/// Single write: returns affected-row count + last insert rowid.
///
/// Async + `spawn_blocking`, same reason and same shape as [`db_query`]:
/// every page's writes serialized on the main thread. The admission order is
/// preserved exactly — admitted on the blocking thread before anything is
/// locked, ticket declared before the guard.
#[tauri::command]
pub async fn db_execute(
    app: tauri::AppHandle,
    sql: String,
    params: Option<Vec<JsonValue>>,
    lease: Option<u64>,
) -> CmdResult<ExecuteOutcome> {
    tauri::async_runtime::spawn_blocking(move || {
        let lifecycle = app.state::<Arc<Lifecycle>>();
        // Admit first, and declare the ticket BEFORE the connection guard: the
        // ticket then drops after it, so when `begin_import`'s drain returns no
        // admitted writer can still hold the connection — which is what lets the
        // safety copy know its snapshot has no writer landing behind it (E5).
        let _ticket = lifecycle.admit(lease)?;
        let state = app.state::<AppState>();
        let conn = lock_conn(&state)?;
        db::execute(&conn, &sql, params.as_deref().unwrap_or(&[])).map_err(Refusal::from)
    })
    .await
    .map_err(|e| Refusal::from(e.to_string()))?
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
///
/// Async + `spawn_blocking` like every other DB command (B3): each step is a
/// SQLCipher round trip under the one connection lock, so none of the four may
/// run on the main thread. The order is untouched — admission, then the lock,
/// then the flag, then SQLite — and the ticket stays declared before the guard
/// (E5), so the import drain still sees every writer.
#[tauri::command]
pub async fn db_begin(app: tauri::AppHandle) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let lifecycle = app.state::<Arc<Lifecycle>>();
        let _ticket = lifecycle.admit(None)?;
        let state = app.state::<AppState>();
        let conn = lock_conn(&state)?;
        if state.txn_open.swap(true, Ordering::SeqCst) {
            return Err(Refusal::new("rust.error.txnAlreadyOpen"));
        }
        if let Err(e) = db::begin_tx(&conn) {
            state.txn_open.store(false, Ordering::SeqCst);
            return Err(Refusal::from(e));
        }
        Ok(())
    })
    .await
    .map_err(|e| Refusal::from(e.to_string()))?
}

/// Commit the manual transaction. On failure the open flag stays set so the
/// caller may still call [`db_rollback`]. If rollback also fails, call
/// [`db_reset_txn`] to clear the flag; the uncommitted rows are lost.
#[tauri::command]
pub async fn db_commit(app: tauri::AppHandle) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let lifecycle = app.state::<Arc<Lifecycle>>();
        let _ticket = lifecycle.admit(None)?;
        let state = app.state::<AppState>();
        let conn = lock_conn(&state)?;
        if !state.txn_open.load(Ordering::SeqCst) {
            return Err(Refusal::new("rust.error.noTxnToCommit"));
        }
        db::commit_tx(&conn)?;
        state.txn_open.store(false, Ordering::SeqCst);
        Ok(())
    })
    .await
    .map_err(|e| Refusal::from(e.to_string()))?
}

/// Roll back the manual transaction.
#[tauri::command]
pub async fn db_rollback(app: tauri::AppHandle) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let lifecycle = app.state::<Arc<Lifecycle>>();
        let _ticket = lifecycle.admit(None)?;
        let state = app.state::<AppState>();
        let conn = lock_conn(&state)?;
        if !state.txn_open.load(Ordering::SeqCst) {
            return Err(Refusal::new("rust.error.noTxnToRollback"));
        }
        db::rollback_tx(&conn)?;
        state.txn_open.store(false, Ordering::SeqCst);
        Ok(())
    })
    .await
    .map_err(|e| Refusal::from(e.to_string()))?
}

/// Clear the manual-transaction flag without touching the DB.
///
/// Break-glass only: use this if `db_commit` AND `db_rollback` both
/// failed (e.g., connection died) and the flag is stuck, which would
/// block every future `db_batch`. A lost transaction means the rows
/// from the last `db_begin` are gone; the caller is responsible for
/// re-reading and reconciling state.
#[tauri::command]
pub async fn db_reset_txn(app: tauri::AppHandle) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let lifecycle = app.state::<Arc<Lifecycle>>();
        let _ticket = lifecycle.admit(None)?;
        let state = app.state::<AppState>();
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
    })
    .await
    .map_err(|e| Refusal::from(e.to_string()))?
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
pub async fn db_key_save(path: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        refuse_mobile_role()?;
        db::save_db_key_file(std::path::Path::new(&path))
            .map_err(|e| Refusal::new("rust.error.keyWrite").with("detail", e))
    })
    .await
    .map_err(|e| Refusal::from(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use crate::commands::tests::{
        assert_async_four, assert_async_one, assert_async_three,
        assert_dispatches_off_the_main_thread, command_sources,
    };

    #[test]
    fn db_query_and_db_execute_run_off_the_main_thread() {
        type Params = Option<Vec<super::JsonValue>>;
        assert_async_three::<tauri::AppHandle, String, Params, _>(super::db_query);
        assert_async_four::<tauri::AppHandle, String, Params, Option<u64>, _>(super::db_execute);
        assert_dispatches_off_the_main_thread("db_query");
        assert_dispatches_off_the_main_thread("db_execute");
    }

    /// B3 part 2: the manual transaction family and the key export. Same two
    /// halves as the pin above, so no edit can quietly move one of them back
    /// onto the main thread.
    #[test]
    fn the_txn_and_key_commands_run_off_the_main_thread() {
        assert_async_one::<tauri::AppHandle, _>(super::db_begin);
        assert_async_one::<tauri::AppHandle, _>(super::db_commit);
        assert_async_one::<tauri::AppHandle, _>(super::db_rollback);
        assert_async_one::<tauri::AppHandle, _>(super::db_reset_txn);
        assert_async_one::<String, _>(super::db_key_save);

        for name in [
            "db_begin",
            "db_commit",
            "db_rollback",
            "db_reset_txn",
            "db_key_save",
        ] {
            assert_dispatches_off_the_main_thread(name);
        }
    }

    /// E12: the break-glass reset asks SQLite first, under the connection
    /// lock, and only then clears the flag — with `?` between the two, so a
    /// failed rollback returns while the flag still says "transaction open"
    /// and every later write refuses (restart required) instead of joining
    /// an abandoned transaction.
    #[test]
    fn db_reset_txn_reconciles_under_the_lock_before_clearing_the_flag() {
        let src = command_sources();
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
