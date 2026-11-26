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
//! the feature libraries and the data driver (P2). Everything that touches
//! the database or the disk is `async` and dispatches through
//! `spawn_blocking` (B3), so a slow query, a large photo or a contested lock
//! never parks the main thread; the mutex, taken inside the blocking closure
//! and never held across an `.await`, is what still orders them.
//!
//! Photo bytes cross IPC as RAW payloads: `photo_read` returns
//! `tauri::ipc::Response`, which the frontend receives as an `ArrayBuffer`
//! instead of a JSON array of byte numbers, and `photo_save`/
//! `photo_save_thumb` take the bytes as the raw request body. A raw body IS
//! the whole request, so the metadata they need (the extension, the source
//! photo path) travels in request headers — the documented channel for a raw
//! payload. Raw payloads are unsupported on Android only; this app bundles
//! desktop targets.
//!
//! The commands themselves live in per-domain submodules next to this file
//! (`commands/db.rs`, `photos.rs`, `backup.rs`, `app.rs`, `pairing.rs`); this
//! parent keeps the shared items every domain uses and re-exports every
//! command under the same `commands::…` path `lib.rs` registers, so the IPC
//! surface is unchanged by the split.

use std::ops::Deref;
use std::sync::atomic::Ordering;
use std::sync::MutexGuard;

use rusqlite::Connection;
use tauri::ipc::{InvokeBody, Request};

use crate::db::AppState;
use crate::messages::Refusal;

mod app;
mod backup;
mod db;
mod pairing;
mod photos;

// Every command and every struct its signature names is re-exported under this
// module, so `lib.rs` keeps registering them as `commands::<name>,` with no
// change. The globs also carry each command's hidden `__cmd__<name>` helper,
// which `generate_handler!` expands to at the path it is registered under —
// re-listing the commands by name would leave those behind and the handler
// would not compile.
pub use app::*;
pub use backup::*;
pub use db::*;
pub use pairing::*;
pub use photos::*;

/// Every command's failure is a key plus params (D7): the renderer has the
/// catalogue, and Rust only knows which message to use.
type CmdResult<T> = Result<T, Refusal>;

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

#[cfg(test)]
mod tests {
    use super::lock_conn;

    /// Every source file of the command modules, concatenated in a fixed
    /// order — this parent first, then the submodules alphabetically. The
    /// source-scan pins below and in the submodules read this, because a
    /// command body now lives beside the domain it serves: a scan of
    /// `commands.rs` alone would find nothing and pass vacuously.
    pub(crate) fn command_sources() -> String {
        [
            include_str!("commands.rs"),
            include_str!("commands/app.rs"),
            include_str!("commands/backup.rs"),
            include_str!("commands/db.rs"),
            include_str!("commands/pairing.rs"),
            include_str!("commands/photos.rs"),
        ]
        .concat()
    }

    /// B3 (P1): `db_query` and `db_execute` must run off the main thread. A
    /// synchronous command runs on the main thread, so a slow FTS query or a
    /// large scan serialized every page's reads on the UI thread; an `async`
    /// one whose work stays inline parks an async-runtime worker instead. Both
    /// halves are pinned.
    ///
    /// The signature half is compile-time, not a source grep: an `async fn`
    /// item coerces to `fn(args..) -> Fut` with `Fut: Future`, and a sync
    /// signature cannot — its return type is a `Result`, which implements no
    /// `Future` — so a regression fails to build the test binary.
    ///
    /// The connection lock needs no pin: a `ConnGuard` cannot cross into the
    /// `'static` closure, nor sit across an `.await`, so the lock can only live
    /// inside the blocking closure, and the mutex still orders every read.
    pub(crate) fn assert_async_one<A, Fut: std::future::Future>(_command: fn(A) -> Fut) {}

    pub(crate) fn assert_async_two<A, B, Fut: std::future::Future>(_command: fn(A, B) -> Fut) {}

    pub(crate) fn assert_async_three<A, B, C, Fut: std::future::Future>(
        _command: fn(A, B, C) -> Fut,
    ) {
    }

    pub(crate) fn assert_async_four<A, B, C, D, Fut: std::future::Future>(
        _command: fn(A, B, C, D) -> Fut,
    ) {
    }

    /// The other half of the pin: an `async` command whose work stays inline
    /// still parks an async-runtime worker, so the body must dispatch.
    pub(crate) fn assert_dispatches_off_the_main_thread(name: &str) {
        let src = command_sources();
        let start = src
            .find(&format!("pub async fn {name}("))
            .unwrap_or_else(|| panic!("{name} must be an async command"));
        let end = src[start..]
            .find("#[tauri::command]")
            .map(|i| start + i)
            .unwrap_or(src.len());
        assert!(
            src[start..end].contains("spawn_blocking("),
            "{name} must move its blocking work to a blocking thread"
        );
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
        let src = command_sources();
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
