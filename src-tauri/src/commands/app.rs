//! The app-level commands: the close-to-tray mirror's publishers, the
//! interface locale, the boot status pair and the factory-reset engine.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::Serialize;
use tauri::Manager;

use super::{lock_conn, CmdResult};
use crate::db::{self, AppState};
use crate::lifecycle::Lifecycle;
use crate::messages::{self, Refusal};

/// Republish the close-to-tray mirror from the live connection, if there is
/// one. A closed connection leaves the mirror as it was, and its default is the
/// same "on" the absent-row rule gives.
pub(super) fn refresh_close_to_tray_from(app: &tauri::AppHandle) {
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

#[cfg(test)]
mod tests {
    use crate::commands::tests::command_sources;

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
        let src = command_sources();
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
        let src = command_sources();
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
}
