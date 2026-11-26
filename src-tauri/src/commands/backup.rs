//! The backup/import file commands: the two raw-body writers that put a file
//! where the user chose (`backup_save_file`, `export_save_file`), the safety
//! copy that opens the import exclusion window, and the lease pair that
//! claims and releases it.
//!
//! Moved verbatim out of `commands.rs` (P2/Session 3). `export_save_file` stays
//! in this file after `backup_safety_copy` because `safety_copy.rs`'s source
//! pin bounds the copy's body with it.

use std::sync::Arc;

use tauri::ipc::Request;
use tauri::{Manager, State};

use super::app::refresh_close_to_tray_from;
use super::{header_str, lock_conn, raw_body, CmdResult};
use crate::db::AppState;
use crate::file_write;
use crate::lifecycle::Lifecycle;
use crate::messages::Refusal;

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
