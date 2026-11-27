// Every `unsafe` block in this crate is an explicit one: the lint keeps a future
// `unsafe fn` from silently inheriting its caller's obligations, so a new
// platform seam has to state its contract instead of wrapping the whole body.
#![deny(unsafe_op_in_unsafe_fn)]

mod biometric;
mod commands;
mod db;
// Public because the pairing envelope is the one piece of the sync boundary
// that both halves of the wire format are tested against (see the module doc).
pub mod envelope;
mod external_links;
mod file_write;
mod key_store;
mod lifecycle;
mod messages;
mod navigation;
// Public for the same reason as `envelope`: the pairing identity and the
// listener are the sync boundary both halves speak, and their API is proved by
// tests before any UI drives it. Deliberately **not** exposed as Tauri commands
// yet — the QR panel (Session 6) adds those together with the screen that asks
// the user to open the window, because an openable LAN port with no consent
// step would be worse than no port at all.
mod pairing_client;
mod pairing_counter;
pub mod pairing_key;
pub mod pairing_listener;
pub mod pairing_snapshot;
mod photos;
mod reminders;
mod reset;
mod safety_copy;
mod schema;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

// Tray icons and menus are desktop-only in Tauri 2 (`cfg(desktop)`), so a
// mobile build must not name them at all.
#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem};
#[cfg(desktop)]
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::Manager;
// Only the desktop close-to-tray watcher reads window events.
#[cfg(desktop)]
use tauri::WindowEvent;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// How long one boot-failure dialog may stay up before the process stops waiting
/// for an answer, and how often the watchdog re-checks that it is still the
/// current one. Generous on purpose: someone may be unlocking a credential store
/// or starting a session before choosing Retry.
const BOOT_FAILURE_WATCHDOG: Duration = Duration::from_secs(600);
const WATCHDOG_TICK: Duration = Duration::from_secs(5);

/// The main window's label, matching `tauri.conf.json`. Named here because
/// `focus_main_window` has to find the window to raise, and a typo in a string
/// literal would only show up as "the second launch does nothing".
const MAIN_WINDOW_LABEL: &str = "main";

/// The Tauri app-data directory name. One place, because it was previously
/// spelled out in three files that could drift (`tauri.conf.json`, the keyring
/// service name, and the log paths here).
const APP_DIR_NAME: &str = "com.minlulin.purplememo";

/// Audit log of every key disclosure *and* every key restore (key lifecycle),
/// written next to the database.
const KEY_EXPORT_LOG: &str = "key-export.log";

/// The removed LAN share's audit log. Nothing writes it any more; the
/// name stays so factory reset keeps deleting the leftover file on
/// installs that still have one.
const SHARE_LOG: &str = "share.log";

/// The boot-failure log next to the database. Part of the
/// factory-reset surface like the other two logs, so it lives in a
/// constant the reset engine can follow instead of a string literal in two
/// places.
const BOOT_ERROR_LOG: &str = "boot-error.log";

/// Added to the boot-failure message when the failure smells like a missing or
/// locked OS credential store.
const KEYRING_HINT: &str = " Hint: your OS credential store looks unavailable — Purple Memo keeps its database key there, so it cannot start without it.";

/// Bumped whenever a boot-failure dialog is replaced or the app recovers.
/// A watchdog armed for an earlier dialog sees the change and stands down, so a
/// recovered session can never be ended by a watchdog that outlived its dialog.
static WATCHDOG_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Serializes watchdog RETIREMENT against the watchdog's own exit decision
/// (E13). Both sides take this lock, so "generation changed after the last
/// check but before the exit" — the window in which a recovered app was
/// killed with the misleading "no answer" message — is closed: the two
/// decisions are totally ordered. Whoever gets the lock first decides, and
/// the other side sees that decision instead of racing it.
static WATCHDOG_EXIT: Mutex<()> = Mutex::new(());

/// Where this process's boot stands, kept where the renderer can read it.
///
/// Two F13 lessons live here. First, the WebView can be live and issuing
/// reads half a second before the database key is even unwrapped — a read
/// in that window fails with "state not managed" and the renderer's error
/// screen used to latch it for the whole session, so the renderer waits
/// for this to leave `Pending` before its first read. Second, when boot
/// does fail, `report_boot_failure`'s dialog is not the surface the phone
/// reaches; the recorded cause is what its error screen shows instead of
/// its own first failed query's symptom.
#[derive(Clone)]
pub(crate) enum BootPhase {
    Pending,
    Ready,
    Failed(String),
}

static BOOT_PHASE: Mutex<BootPhase> = Mutex::new(BootPhase::Pending);

fn record_boot_phase(phase: BootPhase) {
    *BOOT_PHASE.lock().unwrap_or_else(|e| e.into_inner()) = phase;
}

/// Where boot stands now.
pub(crate) fn boot_phase() -> BootPhase {
    BOOT_PHASE.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Retire every armed watchdog. Called the moment a wait state ends and when
/// the app recovers; the bump happens under [`WATCHDOG_EXIT`] so it can never
/// slip between the watchdog's final check and its exit.
fn retire_watchdog() {
    let _guard = WATCHDOG_EXIT.lock().unwrap_or_else(|e| e.into_inner());
    WATCHDOG_GENERATION.fetch_add(1, Ordering::SeqCst);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // MUST stay first. A second launch is turned away before this app
    // reaches `setup` — and therefore before `boot` — which is what keeps
    // two copies from racing the database. That race was not cosmetic:
    // both could reach `load_or_mint_db_key` while the database file did
    // not yet exist, both would mint a different key, and the loser's
    // `set_password` would overwrite the only credential-store slot with a
    // key that cannot open the database the winner just created.
    // Desktop only: there is no "second instance" on Android, where the OS
    // owns app lifetime. Gated rather than removed, so the desktop order the
    // `single_instance_is_registered_before_setup` pin protects is unchanged.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        focus_main_window(app);
    }));
    // Desktop-only surfaces, gated at registration: a phone sideloads its APK
    // and opens links through the system browser, so the mobile build must not
    // expose an updater or an opener command at all. Gating here (not only in
    // the UI) is what keeps the surface from leaking into the webview.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
    builder
        // Cancels any navigation away from the app's own origin;
        // external links go to the system browser instead (MarkdownLink).
        .plugin(navigation::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // A failed boot is *reported*, not propagated: returning `Err` here
            // tears the app down before anything could be shown, or retried.
            // The failure is typed so the dialog can act on the
            // missing-key class without matching message text.
            if let Err(failure) = boot(app.handle()) {
                report_boot_failure(app.handle(), &failure);
            } else {
                // Tray + close-to-tray only once the app actually booted: a
                // failed boot hides the window and hands over to its dialogs.
                start_session_chrome(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::db_query,
            commands::db_execute,
            commands::db_batch,
            commands::db_begin,
            commands::db_commit,
            commands::db_rollback,
            commands::db_reset_txn,
            commands::photo_save,
            commands::photo_read,
            commands::photo_read_thumb,
            commands::photo_save_thumb,
            commands::photo_delete,
            commands::db_key_save,
            commands::backup_save_file,
            commands::backup_safety_copy,
            commands::backup_import_begin,
            commands::backup_import_end,
            commands::close_to_tray_set,
            commands::paired_reachable_set,
            commands::ui_locale_set,
            commands::boot_status,
            commands::boot_retry,
            commands::export_save_file,
            commands::pairing_local,
            commands::pairing_open,
            commands::pairing_close,
            commands::pairing_status,
            commands::pairing_identity_status,
            commands::pairing_identity_replace,
            commands::pairing_phone_pair,
            commands::pairing_snapshot_request,
            commands::pairing_snapshot_applied,
            commands::pairing_snapshot_adopted,
            commands::pairing_upload_batch,
            commands::pairing_upload_commit,
            commands::pairing_upload_status,
            commands::pairing_upload_take,
            commands::pairing_upload_outcome,
            commands::pairing_sync_push,
            commands::pairing_sync_commit,
            commands::pairing_sync_pull,
            commands::pairing_sync_applied,
            commands::pairing_sync_status,
            commands::pairing_sync_take,
            commands::pairing_sync_outcome,
            commands::factory_reset,
            commands::app_restart,
            external_links::open_external_url,
            reminders::reminder_sync,
            reminders::reminder_exact_state,
            reminders::reminder_open_exact_alarm_settings,
            reminders::clipboard_copy_sensitive,
            reminders::clipboard_probe_read,
            reminders::keystore_backing,
            biometric::biometric_status,
            biometric::biometric_authenticate,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| report_run_failure(&e.to_string()));
}

/// Boot-time check of `Slot::PairingIdentity` (§11.2, wave 1 N2).
///
/// A missing identity over an existing pin, or a stored one the platform can no
/// longer open, records `sync_state.re_pair_required` so the confirmed re-pair
/// is offered. A fresh install is left alone — its identity is minted on first
/// pairing — and an unreachable key store is retryable, so neither writes
/// anything. No branch here mints a replacement over a pin.
fn surface_pairing_identity_loss(conn: &rusqlite::Connection) {
    let Ok(history) = commands::pairing_history(conn) else {
        return;
    };
    if let Err(crate::pairing_key::PairingKeyError::MissingWithPeers(_))
    | Err(crate::pairing_key::PairingKeyError::Lost(_)) = crate::pairing_key::inspect(history)
    {
        if let Err(error) = commands::mark_re_pair_required(conn) {
            // The flag could not be written, but the next pairing call still
            // fails closed the same way; only the prompt would be late.
            eprintln!("purple-memo: {error}");
        }
    }
}

/// Encrypted DB core (P1) — everything the app needs before the frontend can use
/// it: app-data dir -> platform key-store key (mint-once) -> SQLCipher open with
/// verify-before-use -> baseline schema -> managed state.
///
/// Takes an `AppHandle` rather than the `App` so the same work can be re-run
/// from the retry path, which is not on the setup thread.
///
/// Returns the failure as a typed error instead of propagating it, so the
/// caller can put it in front of the user — and so the missing-key class can
/// be told apart by type, not message text, for the restore dialog. Nothing is managed until every fallible step has succeeded, so a
/// failed attempt leaves no half-initialized state behind.
fn boot(app: &tauri::AppHandle) -> Result<(), db::KeyLoadError> {
    // Fault injection for the paths below, so they are not shipped untested:
    // in a debug build
    // `PURPLE_MEMO_FORCE_BOOT_FAILURE=keyring:2 npm run tauri dev` fails the
    // first two attempts and then starts normally, which is how the Retry path
    // is exercised end to end; `=keyring` fails every attempt. Release builds
    // ignore the variable — a shipped app must never be unstartable because of
    // an environment variable it inherited.
    #[cfg(debug_assertions)]
    if let Some(kind) = injected_boot_failure() {
        return Err(
            format!("simulated {kind} failure (PURPLE_MEMO_FORCE_BOOT_FAILURE is set)").into(),
        );
    }

    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("failed to create data dir {}: {e}", data_dir.display()))?;
    remember_data_dir(&data_dir);
    // E3: an interrupted factory reset is finished BEFORE any key work. This
    // is the whole point of the marker: a crash after the database was
    // deleted but before the key was must not fall through to the ordinary
    // first-run path, which would mint a fresh database under the old key
    // while the old photos and safety copies still existed. On success the
    // app continues into a genuine first run; on failure the marker stays,
    // the user gets the blocked components in the dialog, and Retry runs this
    // same pass again.
    if reset::reset_in_progress(&data_dir) {
        let outcome =
            reset::finish_interrupted_reset(reset::fault_injection(), &data_dir, db::delete_db_key);
        if !outcome.complete {
            return Err(format!(
                "a factory reset started in an earlier session was interrupted and could not \
                 be finished ({}); nothing further was touched — close whatever is using \
                 the app's data folder and press Retry",
                reset::blocked_summary(&outcome)
            )
            .into());
        }
        eprintln!("purple-memo: finished a factory reset that an earlier session left incomplete");
    }
    let db_path = data_dir.join(db::DB_FILE_NAME);
    // E9: record whether a real database exists BEFORE this attempt opens
    // it. The mint guard only lets a fresh key this far when there is no
    // database, so `false` means the open below is about to create the file —
    // and if initialization then fails, the file is provably new and
    // uncommitted, which is what makes removing it (rather than stranding it
    // without its key) the safe move.
    let database_preexisted = db::db_file_exists(&db_path);
    let key = match db::load_or_mint_db_key(&db_path) {
        Ok(key) => key,
        // Fail-closed handling of a lost key happens before anything is
        // opened, so no data is ever decrypted with the wrong key.
        Err(failure) => return Err(handle_key_load_failure(&data_dir, failure)),
    };
    // A key this process minted is only correct if the database it opens with
    // it verifies. If the very first run fails anyway, undo what the attempt
    // created and then take the key back out — in that order (E9): discarding
    // the key first would leave a nonempty database whose only key is gone,
    // and every later boot would offer a key restore for a database the user
    // never had.
    let opened = db::open_encrypted_db(&db_path, &key.hex).and_then(|conn| {
        db::init_schema(&conn)?;
        Ok(conn)
    });
    let conn = match opened {
        Ok(conn) => conn,
        Err(e) => {
            if key.freshly_minted {
                if database_preexisted {
                    // Unreachable under today's contract: `load_or_mint_db_key`
                    // refuses a nonempty database before it ever mints, so a
                    // freshly minted key implies no database existed. Kept as
                    // the explicit E9 precondition rather than an assumption:
                    // if the mint guard's contract ever changes, this path
                    // must fall back to the old behaviour (discard the key,
                    // touch no file) and never delete a database it cannot
                    // prove it created.
                    db::discard_minted_key();
                } else if db::remove_abandoned_new_db(&data_dir) {
                    db::discard_minted_key();
                } else {
                    // The provably-new files could not all be removed (the
                    // main file survives, sidecars may be gone). Keep the
                    // key: a file/key pair still opens on the retry, whereas
                    // discarding now is exactly the stranded state E9 names.
                    eprintln!(
                        "purple-memo: could not undo a failed first-run database \
                         ({e}); keeping its minted key so the pair stays recoverable"
                    );
                }
            }
            return Err(e.into());
        }
    };
    // §11.2 (N2): the pairing identity is checked at boot for the same reason
    // the database key is — a lost secret must surface with its own recovery
    // path, not as a bare error the first time the pairing panel is opened.
    // Nothing is minted and no data is touched: notes and tasks stay readable.
    surface_pairing_identity_loss(&conn);
    // Publish the stored close-to-tray toggle for the window-close handler,
    // which reads it from memory only (D1: it must never take the connection
    // lock on the window-event thread). This is the first value; the Settings
    // toggle and the end of an import republish it.
    refresh_close_to_tray(&conn);
    // And the paired-phone reachability toggle, same contract — the close
    // handler consults it on every hide.
    refresh_paired_reachable(&conn);
    app.manage(db::AppState {
        // `Some` until factory reset takes it; every DB command fails closed
        // with the `rust.error.dbClosed` refusal once it is `None`.
        conn: Mutex::new(Some(conn)),
        txn_open: AtomicBool::new(false),
        reset_terminal: AtomicBool::new(false),
        data_dir,
    });
    // §7.2 across restarts: seed the outbound counter allocator from the
    // device-local row and install both persistence sinks, before any command
    // can mint a counter or admit an envelope. Re-run by a retried boot; the
    // seed is `max`, so a re-install is monotonic.
    commands::install_counter_persistence(app);
    // One lifecycle barrier for the whole process (E1/E2/E5): managed as a
    // shared Arc so the pairing state consults the same instance the DB/photo
    // commands admit through and `factory_reset` raises. Re-managed together
    // on the retry path, like `AppState` above, so the pairing cannot skew.
    let lifecycle = Arc::new(lifecycle::Lifecycle::new());
    app.manage(lifecycle.clone());
    // §11.5: the pairing window is a network listener, and it consults the
    // SAME barrier — a private one would be two states pretending to be one.
    // Like sharing it starts closed: no port exists until pairing opens one.
    app.manage(pairing_listener::PairingListenerState::with_lifecycle(
        lifecycle,
    ));
    // The database is open and managed: boot has settled, and a failure
    // recorded by an earlier attempt in this process is over — the
    // renderer's error screen must not present it as current (F13).
    record_boot_phase(BootPhase::Ready);
    Ok(())
}

/// What `boot` must do about a failed key load, on this platform.
///
/// Desktop: nothing — the caller reports it, and the boot-failure dialog
/// decides (Retry, or restore an exported key file).
///
/// Android: a lost Keystore key is unrecoverable, and the design decision is
/// fail closed → wipe the mobile copy → re-pair from desktop. The wipe runs
/// through the same factory-reset engine Settings uses, so it removes exactly
/// the owned surface (database files, photos, safety copies, logs, and the
/// wrapped key plus its Keystore entry) and reports each component.
#[cfg(not(target_os = "android"))]
fn handle_key_load_failure(
    _data_dir: &std::path::Path,
    failure: db::KeyLoadError,
) -> db::KeyLoadError {
    failure
}

#[cfg(target_os = "android")]
fn handle_key_load_failure(
    data_dir: &std::path::Path,
    failure: db::KeyLoadError,
) -> db::KeyLoadError {
    if !failure.is_key_lost() {
        return failure;
    }
    eprintln!("purple-memo: {}", failure.message());
    // No listener and no open connection exist this early in boot, so those
    // two seams are already-absent/no-op.
    let outcome = reset::run_factory_reset(
        reset::fault_injection(),
        || Ok(false),
        || Ok(()),
        data_dir,
        db::delete_db_key,
    );
    if outcome.complete {
        // The phone's armed reminders and delivery records live outside the
        // database the engine just wiped; forget them too (Android only,
        // best-effort — see reminders.rs).
        reminders::clear_reminder_state_after_reset();
    }
    let detail = if outcome.complete {
        "the phone's local copy has been wiped; pairing with the desktop app is required to \
         use Purple Memo on this device again"
            .to_string()
    } else {
        format!(
            "wiping the phone's local copy was blocked ({}); nothing further was touched, so no \
             copy can be opened until this is fixed — free whatever is holding those files and \
             try again",
            reset::blocked_summary(&outcome)
        )
    };
    db::KeyLoadError::KeyLost(format!("{}. {detail}", failure.message()))
}

/// Debug-only fault injection: `kind` (every attempt fails) or `kind:N` (the
/// first `N` attempts fail). The spec is read once per process, and the attempts
/// left are decremented per call.
#[cfg(debug_assertions)]
fn injected_boot_failure() -> Option<String> {
    use std::sync::atomic::AtomicI64;
    use std::sync::OnceLock;

    static INJECTION: OnceLock<Option<(String, AtomicI64)>> = OnceLock::new();
    let (kind, remaining) = INJECTION
        .get_or_init(|| {
            let (kind, attempts) =
                parse_injection_spec(&std::env::var("PURPLE_MEMO_FORCE_BOOT_FAILURE").ok()?)?;
            Some((kind, AtomicI64::new(attempts)))
        })
        .as_ref()?;

    let mut left = remaining.load(Ordering::SeqCst);
    while left > 0 {
        match remaining.compare_exchange(left, left - 1, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => return Some(kind.clone()),
            Err(actual) => left = actual,
        }
    }
    None
}

/// `"keyring"` -> ("keyring", every attempt); `"keyring:2"` -> ("keyring", 2).
/// An unparseable count means "always".
#[cfg(debug_assertions)]
fn parse_injection_spec(spec: &str) -> Option<(String, i64)> {
    let spec = spec.trim();
    if spec.is_empty() {
        return None;
    }
    match spec.split_once(':') {
        Some((kind, attempts)) => Some((
            kind.trim().to_string(),
            attempts.trim().parse().unwrap_or(i64::MAX),
        )),
        None => Some((spec.to_string(), i64::MAX)),
    }
}

/// Put a boot failure where the user can see it and act on it.
///
/// Called from `setup`, i.e. **before** the event loop is pumping, and returns
/// normally so the app stays up until the user answers. Tauri hands dialog work
/// to the main thread *through* the event loop, so the two things that are easy
/// to get wrong here:
///
/// * `blocking_show` would deadlock: the plugin documents it as unsafe on the
///   main-thread context, and `setup` runs on the main thread while the loop it
///   would post to has not started. The non-blocking `show` below is dispatched
///   as soon as the loop runs — which happens because this function returns.
/// * The main window is hidden first. Config windows are created before `setup`
///   runs, so it exists and its frontend loads, but every command that needs
///   managed state fails with "state not managed" — a broken-looking app behind
///   the dialog. Hiding it leaves the dialog as the only thing on screen.
///
/// Two dialog shapes, chosen by the typed failure class — never
/// by matching on message text:
///
/// * Missing key for an existing database: the **Restore exported key…**
///   dialog, whose other button is Quit (retrying unchanged would fail the
///   same way). A failed or cancelled restore falls back to the standard
///   Retry/Quit dialog, so retry and quit stay available after any attempt.
/// * Everything else: the standard Retry dialog. The likeliest failure is an
///   environment the user can fix without restarting the app: an OS credential
///   store that is locked, missing, or not reachable in this session. Quit
///   exits non-zero; the log file and stderr stay the durable record.
fn report_boot_failure(app: &tauri::AppHandle, failure: &db::KeyLoadError) {
    let locale = read_ui_locale(app);
    // The log keeps the English cause and the English hint: it is read on a
    // bug report, often on another machine, and it is the one place the
    // diagnostic must read the same whatever the interface language is (D7).
    record_boot_phase(BootPhase::Failed(failure.message().to_string()));
    let logged = if failure.is_missing_key_for_existing_db() {
        // The credential store is reachable but empty — the keyring hint
        // would blame the wrong thing.
        format!("Purple Memo failed to start: {}.", failure.message())
    } else {
        boot_failure_message(failure.message())
    };
    write_boot_error_log(&logged);
    eprintln!("{logged}");
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    arm_watchdog("the boot-failure dialog");
    let body = if failure.is_missing_key_for_existing_db() {
        messages::boot(locale).failed(failure.message())
    } else {
        boot_dialog_body(locale, failure.message())
    };
    if failure.is_missing_key_for_existing_db() {
        offer_key_restore(app.clone(), body);
    } else {
        show_retry_or_quit(app.clone(), body);
    }
}

/// The dialog's headline and cause in `locale`, carrying the credential-store
/// hint only when the cause looks like one.
fn boot_dialog_body(locale: messages::Locale, message: &str) -> String {
    let strings = messages::boot(locale);
    let hint = if looks_like_keyring_failure(message) {
        strings.keyring_hint
    } else {
        ""
    };
    format!("{}{hint}", strings.failed(message))
}

/// The standard boot-failure dialog: Retry runs boot again on a fresh thread;
/// Quit exits non-zero.
///
/// `body` carries the headline and the cause; the guidance is appended here, in
/// the same language, so a caller cannot pair one language's body with another
/// language's instruction.
fn show_retry_or_quit(app: tauri::AppHandle, body: String) {
    let strings = messages::boot(read_ui_locale(&app));
    app.dialog()
        .message(format!("{body}{}", strings.retry_guidance))
        .title(strings.title)
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCancelCustom(
            strings.retry.into(),
            strings.quit.into(),
        ))
        .show(move |retry| {
            if retry {
                retry_boot(app);
            } else {
                std::process::exit(1);
            }
        });
}

/// The missing-key dialog: offer the restore half of the
/// key-export path, with Quit as the way out.
fn offer_key_restore(app: tauri::AppHandle, body: String) {
    let strings = messages::boot(read_ui_locale(&app));
    app.dialog()
        .message(format!("{body}{}", strings.restore_guidance))
        .title(strings.title)
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCancelCustom(
            strings.restore.into(),
            strings.quit.into(),
        ))
        .show(move |restore| {
            if restore {
                pick_key_file_and_restore(app, body);
            } else {
                std::process::exit(1);
            }
        });
}

/// Ask for the exported key file, then run the restore seam.
///
/// The non-blocking file picker is the same dialog-plugin path the message
/// dialogs use, so this is safe from the boot-failure context: the pick
/// callback arrives on a plugin worker thread, where the candidate key is read,
/// validated, and *proven against the database* before anything is written to
/// the credential store. A cancel, a malformed file, or a wrong key changes
/// nothing and lands back on the standard Retry/Quit dialog — never a dead
/// end, and never a store write.
fn pick_key_file_and_restore(app: tauri::AppHandle, failure_body: String) {
    // The user answered the dialog — the clock now measures the PICKER, not
    // the answered dialog (E13): without this bump the old watchdog could
    // fire while someone is still looking through their files.
    arm_watchdog("the key file picker");
    let strings = messages::boot(read_ui_locale(&app));
    app.dialog()
        .file()
        .set_title(strings.choose_key_file)
        .pick_file(move |picked| {
            // The picker was answered — the clock now measures the restore
            // attempt itself (E13), and whichever dialog or retry follows
            // will re-arm for its own state.
            arm_watchdog("the key restore attempt");
            let Some(key_file) = picked.and_then(|handle| handle.into_path().ok()) else {
                // Picker cancelled (or the path could not be converted):
                // restore nothing, give the standard choices back.
                arm_watchdog("the boot-failure dialog");
                show_retry_or_quit(app, failure_body);
                return;
            };
            match restore_key_from_file(&key_file) {
                Ok(()) => retry_boot(app),
                Err(reason) => {
                    arm_watchdog("the boot-failure dialog");
                    let strings = messages::boot(read_ui_locale(&app));
                    show_retry_or_quit(app, strings.restore_failed(&reason));
                }
            }
        });
}

/// Run the restore seam against the known data dir. The single production
/// entry point for the restore itself — validate, prove the key opens the
/// database, then store — so the boot dialog cannot drift from the seam.
fn restore_key_from_file(key_file: &std::path::Path) -> Result<(), String> {
    let data_dir =
        dirs_next_to_db().ok_or_else(|| "the app data directory is not known".to_string())?;
    let db_path = data_dir.join(db::DB_FILE_NAME);
    db::restore_db_key_from_file(&db_path, key_file, db::store_db_key)
}

/// The user chose Retry, having had the chance to fix whatever blocked startup.
///
/// Runs the boot work on a fresh thread: the dialog callback arrives on one of
/// the plugin's worker threads and must not block while a database is opened and
/// a keyring is queried. On success the window comes back — reloaded first,
/// because its frontend loaded while every command was failing with "state not
/// managed" and would otherwise stay on its error screen. On failure the dialog
/// is shown again.
pub(crate) fn retry_boot(app: tauri::AppHandle) {
    // The answer arrived — the clock now measures the retry attempt (E13).
    // Re-arming here (rather than only on the next failure) is what keeps a
    // slow-but-recoverable boot from being killed by the timer that was set
    // for the dialog the user already dismissed.
    arm_watchdog("the retry attempt");
    std::thread::spawn(move || match boot(&app) {
        Ok(()) => {
            // Retire every watchdog armed for a dialog in this session before
            // touching anything else: the app is healthy now and must not be
            // ended by a timer that was set for a failure that is over. Under
            // the shared lock (E13), so the retirement cannot land between a
            // watchdog's final check and its exit.
            retire_watchdog();
            note_boot_recovery();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.reload();
                let _ = window.show();
                let _ = window.set_focus();
            }
            // A boot that succeeded late still gets its tray — the guard in
            // start_session_chrome keeps a first-boot success from doubling it.
            start_session_chrome(&app);
        }
        Err(failure) => report_boot_failure(&app, &failure),
    });
}

/// Arm a watchdog for the wait state that just began, named by
/// `waiting_for` (E13).
///
/// The dialogs, the file picker, and a retry attempt all live in this
/// process, so the process has to outlive them — but a process with a hidden
/// window and no wait in progress is a zombie nobody can answer. Every new
/// state re-arms (bumping the generation stands the previous watchdog down),
/// a successful retry retires the lot, and the timer therefore only ever
/// measures time spent waiting on the state its label names — an answer
/// immediately moves the clock to the next state instead of letting the old
/// timer fire mid-retry or mid-picker with a message about a dialog nobody
/// is looking at.
fn arm_watchdog(waiting_for: &'static str) {
    let generation = WATCHDOG_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        let mut waited = Duration::ZERO;
        while waited < BOOT_FAILURE_WATCHDOG {
            std::thread::sleep(WATCHDOG_TICK);
            waited += WATCHDOG_TICK;
            if WATCHDOG_GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
        }
        // The final decision runs under the same lock retirement bumps
        // (E13): a retirement is either already visible to the load above —
        // then we stand down — or it waits here while we exit. It can no
        // longer land between the check and the exit, which is how a
        // successfully recovered app used to be killed with a message about
        // an answer the user had already given.
        let _guard = WATCHDOG_EXIT.lock().unwrap_or_else(|e| e.into_inner());
        if WATCHDOG_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        eprintln!("purple-memo: no answer while waiting for {waiting_for}; exiting");
        std::process::exit(1);
    });
}

/// Tray menu item ids — matched literally by the tray's menu-event handler,
/// so a typo here is a menu item that silently does nothing.
const TRAY_SHOW_ID: &str = "show";
const TRAY_QUIT_ID: &str = "quit";

/// Settings key behind the close-to-tray toggle. The frontend writes it
/// (`SETTING_KEYS.closeToTray` in `src/lib/settings.ts`) and publishes the new
/// value through `commands::close_to_tray_set`; Rust seeds the mirror below
/// from the stored row, so flipping the toggle applies to the very next close
/// without a restart (§B.3).
const CLOSE_TO_TRAY_KEY: &str = "close_to_tray";

/// The close-to-tray decision, held in memory for the window-close handler.
///
/// The handler runs on the event loop, and the database connection mutex is
/// held there for whole operations — `db_batch` replays an import's statements
/// in one call, and `backup_safety_copy` holds it across the WAL checkpoint and
/// the database-file copy. Reading the setting from the database on that path
/// (which this used to do, on every close) could therefore freeze the UI — and
/// the close itself — for the duration of an import or a safety copy.
///
/// So the row is *published* here instead, and the handler only loads an
/// atomic:
///
/// * seeded ON, the same fail-safe default as the missing-row rule
///   ([`parse_close_to_tray`]) — a mirror that was never published keeps the
///   process alive rather than quitting on a surprise;
/// * published at boot ([`refresh_close_to_tray`]), at the end of a backup
///   import (which replaced the `settings` table the row lives in), and by
///   `commands::close_to_tray_set` when the Settings toggle persists a value.
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);

/// Publish `enabled` as the close-to-tray decision. One writer shape, so every
/// publisher goes through the same store rather than open-coding one.
pub(crate) fn publish_close_to_tray(enabled: bool) {
    CLOSE_TO_TRAY.store(enabled, Ordering::SeqCst);
}

/// Read the stored toggle from `conn` and publish it for the close handler.
///
/// Runs wherever the row can change — boot (the first value) and the end of a
/// backup import — and never on the window-event path. An unreadable row goes
/// through the tested parser, so the missing-row and corrupt-row rules are the
/// same here as they are everywhere else.
pub(crate) fn refresh_close_to_tray(conn: &rusqlite::Connection) {
    let raw = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [CLOSE_TO_TRAY_KEY],
            |row| row.get::<_, String>(0),
        )
        .ok();
    publish_close_to_tray(parse_close_to_tray(raw.as_deref()));
}

/// Install the session chrome — tray icon plus close-to-tray — exactly once.
/// Called after a successful `boot` and again after a successful Retry, since
/// a boot failure tears the app down before there is anything to tray.
///
/// The tray comes first on purpose: without a tray icon there is nowhere to
/// Show the window from, so hiding on close would strand an invisible process.
/// If the tray cannot be built, close keeps today's behaviour (it quits) and
/// the reason goes to stderr.
#[cfg(desktop)]
fn start_session_chrome(app: &tauri::AppHandle) {
    static INSTALLED: AtomicBool = AtomicBool::new(false);
    if INSTALLED.load(Ordering::SeqCst) {
        return;
    }
    if let Err(reason) = install_tray(app) {
        eprintln!("purple-memo: tray unavailable, close keeps quitting: {reason}");
        return;
    }
    watch_close_to_tray(app);
    INSTALLED.store(true, Ordering::SeqCst);
}

/// Mobile has no tray and no close-to-tray: Android owns the app's lifetime
/// (task switcher, back gesture), so there is no session chrome to install.
#[cfg(mobile)]
fn start_session_chrome(_app: &tauri::AppHandle) {}

/// Where the renderer's chosen language is remembered.
///
/// Beside the database rather than in it: the tray is built, and the
/// boot-failure dialogs can run, before — or without — a database connection,
/// and the interface language is not user data. A factory reset that removes
/// it costs one launch in English, which the renderer then corrects.
const UI_LOCALE_FILE: &str = "ui-locale";

/// The language the tray and the boot dialogs speak.
///
/// A missing or unreadable marker answers English: those surfaces have no
/// renderer to ask, and English is the catalogue's source of truth.
fn read_ui_locale(app: &tauri::AppHandle) -> messages::Locale {
    app.path()
        .app_data_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join(UI_LOCALE_FILE)).ok())
        .and_then(|tag| messages::Locale::parse(&tag))
        .unwrap_or(messages::Locale::En)
}

/// The tray's live handles, so a language switch relabels the menu instead of
/// rebuilding it (D7).
#[cfg(desktop)]
struct TrayHandles {
    show: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
    tray: TrayIcon<tauri::Wry>,
}

#[cfg(desktop)]
static TRAY_HANDLES: Mutex<Option<TrayHandles>> = Mutex::new(None);

/// Record the renderer's language for the surfaces that run before it, and
/// relabel the tray if it is already up.
///
/// Called from `ui_locale_set` at boot and whenever Settings changes the
/// language. Writing the marker is best effort: a read-only data dir must not
/// make a language switch fail in a UI that has already re-rendered.
pub(crate) fn publish_ui_locale(app: &tauri::AppHandle, locale: messages::Locale) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join(UI_LOCALE_FILE), locale.code());
    }
    #[cfg(desktop)]
    {
        let labels = messages::tray(locale);
        let handles = TRAY_HANDLES.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(handles) = handles.as_ref() {
            let _ = handles.show.set_text(labels.show);
            let _ = handles.quit.set_text(labels.quit);
            let _ = handles.tray.set_tooltip(Some(labels.tooltip));
        }
    }
}

/// The tray icon: the existing app icon and exactly two menu items —
/// "Show Purple Memo" (restore the window) and "Quit" (full exit), in the
/// language the marker records. No new artwork, no other actions (plan §B.2.3 /
/// §B.2.5).
#[cfg(desktop)]
fn install_tray(app: &tauri::AppHandle) -> Result<(), String> {
    let icon = app
        .default_window_icon()
        .ok_or_else(|| "the default window icon is missing".to_string())?
        .clone()
        .to_owned();
    let labels = messages::tray(read_ui_locale(app));
    let show = MenuItem::with_id(app, TRAY_SHOW_ID, labels.show, true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, TRAY_QUIT_ID, labels.quit, true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&show, &quit]).map_err(|e| e.to_string())?;
    let tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip(labels.tooltip)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            TRAY_SHOW_ID => focus_main_window(app),
            // `exit` leaves through Tauri's exit path, not the window's
            // CloseRequested — the tray's Quit can never be intercepted by
            // close-to-tray and turned into a hide.
            TRAY_QUIT_ID => app.exit(0),
            _ => {}
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    // Kept so `publish_ui_locale` can relabel the menu in place: rebuilding the
    // tray to change two words would blink the icon and lose its state.
    let mut handles = TRAY_HANDLES.lock().unwrap_or_else(|e| e.into_inner());
    *handles = Some(TrayHandles { show, quit, tray });
    Ok(())
}

/// Close-to-tray (plan §B.2.1): while the toggle says so, closing the main
/// window hides it instead of destroying it, so the process — and the
/// reminder poll with it — keeps running.
#[cfg(desktop)]
fn watch_close_to_tray(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            if close_to_tray_enabled(&handle) {
                api.prevent_close();
                // §11.5 / durable pairing: with paired-phone reachability ON
                // (the default), hiding the window keeps the paired phone
                // connected — the dock icon is the app, the window is a view.
                // With it OFF, closing the window is the pairing port's stop
                // as well (the lock path raises the epoch for the same reason,
                // so a window still opening cannot bind behind the hidden app).
                if !paired_reachable_enabled() {
                    if let Some(pairing) =
                        handle.try_state::<pairing_listener::PairingListenerState>()
                    {
                        let _ = pairing.stop_for_lock();
                    }
                }
                if let Some(window) = handle.get_webview_window(MAIN_WINDOW_LABEL) {
                    let _ = window.hide();
                }
            }
        }
    });
}

/// The toggle, as the close handler sees it (§B.3): the in-memory mirror, read
/// on every close and never from the settings table — this runs on the
/// window-event thread, where the connection must not be touched (see
/// [`CLOSE_TO_TRAY`]). The value is still the current one, because every writer
/// of the row publishes it before the next close.
///
/// No managed state (a failed boot) answers "on": that is the default
/// keep-the-process-alive rule, and a boot that failed is exactly the path
/// where quitting silently would be the worst surprise.
#[cfg(desktop)]
fn close_to_tray_enabled(app: &tauri::AppHandle) -> bool {
    let Some(state) = app.try_state::<db::AppState>() else {
        return true;
    };
    // D6: a reset-terminal session bypasses the tray entirely. After a
    // reset the database connection is taken, so without this check the
    // default-on rule would hide the terminal screen instead of exiting
    // — and the next launch would merely raise the hidden window rather
    // than starting fresh, making the "close and start it yourself"
    // guidance false. Scoped to this flag only; the toggle path below
    // is untouched.
    if state.reset_terminal.load(Ordering::SeqCst) {
        return false;
    }
    CLOSE_TO_TRAY.load(Ordering::SeqCst)
}

/// The stored close-to-tray value. Default ON: a missing row (every install
/// that predates the key) and an unreadable row both keep today's behaviour of
/// the app staying alive — only an explicit JSON `false` restores "close
/// quits".
fn parse_close_to_tray(raw: Option<&str>) -> bool {
    match raw {
        None => true,
        Some(text) => serde_json::from_str::<bool>(text).unwrap_or(true),
    }
}

/// Settings key behind the paired-phone reachability toggle (durable
/// pairing). The frontend writes it (`SETTING_KEYS.pairedPhoneReachable` in
/// `src/lib/settings.ts`) and republishes through
/// `commands::paired_reachable_set`; Rust seeds the mirror at boot, so the
/// close path never touches the connection for it (same contract as the
/// close-to-tray mirror above).
const PAIRED_REACHABLE_KEY: &str = "paired_phone_reachable";

/// Whether the paired phone may stay connected while the app runs.
///
/// Default ON: a missing row (every install that predates the key) and an
/// unreadable row both keep the durable-pairing default — only an explicit
/// JSON `false` turns it off, which makes the hidden window the §11.5 stop
/// again (lock, close and background all close the port).
static PAIRED_REACHABLE: AtomicBool = AtomicBool::new(true);

/// Publish `enabled` as the reachability decision. One writer shape, so every
/// publisher goes through the same store rather than open-coding one.
pub(crate) fn publish_paired_reachable(enabled: bool) {
    PAIRED_REACHABLE.store(enabled, Ordering::SeqCst);
}

/// Read the stored toggle from `conn` and publish it. Mirror of
/// [`refresh_close_to_tray`]; runs at boot and at the end of a backup import.
pub(crate) fn refresh_paired_reachable(conn: &rusqlite::Connection) {
    let raw = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [PAIRED_REACHABLE_KEY],
            |row| row.get::<_, String>(0),
        )
        .ok();
    publish_paired_reachable(parse_paired_reachable(raw.as_deref()));
}

/// The stored reachability value. Only an explicit JSON `false` turns it off —
/// the same missing-row and corrupt-row rule as [`parse_close_to_tray`], for
/// the same reason.
fn parse_paired_reachable(raw: Option<&str>) -> bool {
    match raw {
        None => true,
        Some(text) => serde_json::from_str::<bool>(text).unwrap_or(true),
    }
}

/// The reachability decision, as the window-close handler sees it. Memory
/// only — the handler runs on the event loop. Desktop-only: there is no
/// close-to-tray on mobile, and Android owns the app's lifetime.
#[cfg(desktop)]
fn paired_reachable_enabled() -> bool {
    PAIRED_REACHABLE.load(Ordering::SeqCst)
}

/// Raise and un-minimise the main window, so the copy that is already running
/// answers the user who just launched it again.
///
/// Focusing is the whole behaviour: a message box was the alternative, but the
/// person who double-clicked the icon wants their notebook, not a modal — and
/// when the running copy is sitting on the boot-failure dialog, bringing its
/// window forward is already how that dialog gets attention.
///
/// Best-effort throughout: a window that is already gone, or a platform that
/// refuses the request, must not turn a harmless second launch into a crash.
fn focus_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    // `unminimize` is desktop-only; raising the window is all a mobile second
    // launch can ask for.
    #[cfg(desktop)]
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// `run` itself failed — window creation, the event loop, or a `setup` error
/// that was not caught. There is no loop left to dispatch a dialog on, so the
/// log file and stderr are all that can be done. Never returns.
fn report_run_failure(message: &str) -> ! {
    let full = boot_failure_message(message);
    write_boot_error_log(&full);
    eprintln!("{full}");
    std::process::exit(1);
}

/// The one message both failure paths show, so a user reporting a problem
/// quotes the same line wherever they saw it.
fn boot_failure_message(message: &str) -> String {
    let hint = if looks_like_keyring_failure(message) {
        KEYRING_HINT
    } else {
        ""
    };
    format!("Purple Memo failed to start: {message}.{hint}")
}

/// Best-effort `boot-error.log` next to the DB. The write may fail when the
/// data dir is itself the problem — stderr is the backstop.
fn write_boot_error_log(full: &str) {
    if let Some(mut dir) = dirs_next_to_db() {
        dir.push(BOOT_ERROR_LOG);
        let _ = std::fs::write(&dir, format!("{full}\n"));
    }
}

/// Record that a retry worked, so the log does not read as an app that never
/// started. Appends to the file `write_boot_error_log` wrote.
fn note_boot_recovery() {
    use std::io::Write;
    if let Some(mut path) = dirs_next_to_db() {
        path.push(BOOT_ERROR_LOG);
        if let Ok(mut file) = std::fs::OpenOptions::new().append(true).open(&path) {
            let _ = writeln!(file, "recovered: the app started after Retry");
        }
    }
}

/// True when the boot message smells like an OS-credential-store problem
/// (keyring backend missing, locked, or denied) rather than a corrupt DB.
fn looks_like_keyring_failure(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    [
        "keyring",
        "credential",
        "secret-service",
        "keychain",
        "dbus",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// The app-data dir, remembered once `boot` resolves it.
///
/// The log writers can run with no `AppHandle` — `report_run_failure` fires
/// when there is no event loop left — so they cannot call `app_data_dir()`
/// themselves. Re-deriving the path from environment variables instead was
/// wrong on macOS, which is a shipped target: the real directory is
/// `~/Library/Application Support/<id>`, the guessed `~/.local/share/<id>`
/// does not exist, and the write failed into a discarded `Result` — so the
/// "durable record" the plan promises never actually happened there.
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Remember the resolved data dir so later code can reach it without a handle.
fn remember_data_dir(dir: &std::path::Path) {
    let _ = DATA_DIR.set(dir.to_path_buf());
}

/// Lowercase hex of a byte slice — the single copy shared by the key mint
/// (`db::mint_key_hex`) and the photo content hash (`photos::save_photo`),
/// which previously each rolled their own.
pub(crate) fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Append one timestamped line to `name` in the app-data dir.
///
/// Best-effort: refusing to do the thing because the audit write failed would
/// be worse than a missing record, and these are for the user's benefit after
/// the fact, not controls on the operation.
fn append_audit_line(name: &str, line: &str) {
    use std::io::Write;
    let Some(mut path) = dirs_next_to_db() else {
        return;
    };
    path.push(name);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "{timestamp} {line}", timestamp = timestamp_utc());
    }
}

/// Append one key-export record to `key-export.log`, next to the database.
///
/// This is the audit trail for the single most sensitive thing the app can do:
/// let the database's master key out of the credential store. The line records
/// when and where it went and nothing else — see [`db::key_export_audit_line`],
/// which has no parameter through which key material could be threaded.
pub(crate) fn note_key_export(destination: &str) {
    append_audit_line(KEY_EXPORT_LOG, &db::key_export_audit_line(destination));
}

/// Append one key-restore record to `key-export.log`, next to the database.
///
/// The counterpart to [`note_key_export`]: the line records when
/// and from which file a key was restored into the credential store, and
/// nothing else — see [`db::key_restore_audit_line`], which has no parameter
/// through which key material could be threaded.
pub(crate) fn note_key_restore(source: &str) {
    append_audit_line(KEY_EXPORT_LOG, &db::key_restore_audit_line(source));
}

/// Append one retained-key-file record to `key-export.log` (E10).
///
/// A failed rename leaves the COMPLETE plaintext key on disk at a temp path:
/// a real disclosure that never got an audit line, because only the
/// successful rename used to record anything. This closes that gap — the
/// record names where the key now sits, so a retained temp can never be
/// overlooked by someone reading the disclosure history. Same structural
/// property as its siblings: [`db::key_export_retained_audit_line`] takes
/// paths only, and escapes them (E14), so there is no parameter through which
/// key material could be threaded.
pub(crate) fn note_key_retained(retained: &str, destination: &str) {
    append_audit_line(
        KEY_EXPORT_LOG,
        &db::key_export_retained_audit_line(retained, destination),
    );
}

/// RFC 3339 in UTC. Hand-rolled rather than pulling in a date crate for one
/// audit line: days-from-civil, which is exact for the proleptic Gregorian
/// calendar and needs no lookup tables.
fn timestamp_utc() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format_timestamp_utc(secs)
}

/// Format `secs` since the Unix epoch as RFC 3339 UTC.
///
/// The date math, split out from [`timestamp_utc`] so tests can pin known
/// instants (epoch, year boundaries, leap days) against it without a real
/// clock — the shape check in `key_export_log_tests` proves the
/// format, not the calendar.
fn format_timestamp_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    if m <= 2 {
        y += 1;
    }
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// App-data dir without a running app. The remembered value wins once `boot`
/// has resolved it; the environment fallback exists only for the paths that
/// run before that (or after it failed).
pub(crate) fn dirs_next_to_db() -> Option<std::path::PathBuf> {
    if let Some(dir) = DATA_DIR.get() {
        return Some(dir.clone());
    }
    dirs_next_to_db_from_env()
}

#[cfg(target_os = "windows")]
fn dirs_next_to_db_from_env() -> Option<std::path::PathBuf> {
    std::env::var_os("APPDATA").map(|base| std::path::PathBuf::from(base).join(APP_DIR_NAME))
}

#[cfg(target_os = "macos")]
fn dirs_next_to_db_from_env() -> Option<std::path::PathBuf> {
    // Tauri resolves `app_data_dir` to ~/Library/Application Support/<id>.
    std::env::var_os("HOME").map(|home| {
        std::path::PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join(APP_DIR_NAME)
    })
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn dirs_next_to_db_from_env() -> Option<std::path::PathBuf> {
    // Honour XDG_DATA_HOME when it holds an absolute path (the
    // XDG spec's rule, and the behaviour of the dirs crate), falling back to
    // the spec's default ~/.local/share only when the variable is unset or
    // unusable.
    std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .filter(|base| base.is_absolute())
        .map(|base| base.join(APP_DIR_NAME))
        .or_else(|| {
            std::env::var_os("HOME").map(|home| {
                std::path::PathBuf::from(home)
                    .join(".local/share")
                    .join(APP_DIR_NAME)
            })
        })
}

#[cfg(test)]
mod platform_path_tests {
    /// The Linux/other fallback must honour `XDG_DATA_HOME`
    /// instead of always writing `~/.local/share` next to a possibly
    /// relocated home. Pinned as source text because the function is
    /// `cfg`-gated to platforms this test never runs on.
    #[test]
    fn the_linux_data_dir_fallback_honours_xdg_data_home() {
        let src = include_str!("lib.rs");
        let start = src
            .find("#[cfg(not(any(target_os = \"windows\", target_os = \"macos\")))]")
            .expect("the non-windows/macos fallback exists");
        let end = src
            .find("#[cfg(test)]")
            .expect("the test modules follow the helpers");
        let body = &src[start..end];
        assert!(
            body.contains("XDG_DATA_HOME"),
            "the fallback must read XDG_DATA_HOME before ~/.local/share"
        );
        assert!(
            body.contains(".local/share"),
            "the spec default remains the fallback"
        );
    }
}

#[cfg(test)]
mod builder_order_tests {
    /// `tauri_plugin_single_instance` must stay registered
    /// BEFORE `.setup(`, so a second launch is turned away before `boot`
    /// can race the database key. RELEASE.md notes that nothing in the code
    /// fails if the order slips — this pin is what fails instead.
    #[test]
    fn single_instance_is_registered_before_setup() {
        let src = include_str!("lib.rs");
        let single = src
            .find(".plugin(tauri_plugin_single_instance")
            .expect("the single-instance plugin is registered");
        let setup = src.find(".setup(").expect("the builder has a setup hook");
        assert!(
            single < setup,
            "single-instance registration must precede .setup( so a second \
             launch is turned away before boot: registration at {single}, \
             setup at {setup}"
        );
    }
}

/// Tray + close-to-tray (plan §B): the tray exists, offers exactly two
/// actions, close is intercepted to hide instead of destroy, and a second
/// launch brings the hidden window back. Most of this is OS-level behaviour a
/// unit test cannot reach, so the source pins below are what fails when the
/// wiring silently disappears; the checklist in plan §B.4 is the acceptance.
#[cfg(test)]
mod tray_tests {
    const SRC: &str = include_str!("lib.rs");

    /// The function body of a top-level `fn`, for source pins.
    fn body_of(name: &str) -> &'static str {
        let start = SRC.find(name).unwrap_or_else(|| panic!("{name} exists"));
        let rest = &SRC[start..];
        let end = rest.find("\nfn ").unwrap_or(rest.len());
        &rest[..end]
    }

    #[test]
    fn the_tray_feature_flag_is_enabled() {
        // `tauri::tray` is cfg-gated behind the opt-in `tray-icon` feature,
        // which is NOT a default — without this line the tray does not compile.
        let manifest = include_str!("../Cargo.toml");
        assert!(
            manifest.contains("\"tray-icon\""),
            "Cargo.toml must enable tauri's tray-icon feature"
        );
    }

    #[test]
    fn the_tray_offers_exactly_two_actions_and_uses_the_app_icon() {
        let body = body_of("fn install_tray");
        assert_eq!(
            body.matches("MenuItem::with_id").count(),
            2,
            "exactly two menu items: Show and Quit (plan §B.2.3)"
        );
        assert!(body.contains("TRAY_SHOW_ID"), "Show Purple Memo");
        assert!(body.contains("TRAY_QUIT_ID"), "Quit");
        assert!(
            body.contains("default_window_icon"),
            "the tray reuses the existing app icon (plan §B.2.5)"
        );
        assert!(
            body.contains("focus_main_window(app)"),
            "Show restores the window"
        );
        assert!(
            body.contains("app.exit(0)"),
            "Quit exits the process for real — never hide"
        );
    }

    #[test]
    fn closing_the_window_hides_to_the_tray_instead_of_destroying_it() {
        let body = body_of("fn watch_close_to_tray");
        let intercepted = body
            .find("WindowEvent::CloseRequested")
            .expect("the close request is intercepted");
        let prevented = body
            .find("api.prevent_close()")
            .expect("the close is cancelled, not processed");
        let gated = body
            .find("close_to_tray_enabled")
            .expect("the toggle is consulted on every close");
        let hidden = body
            .find(".hide()")
            .expect("the window is hidden rather than destroyed");
        assert!(
            intercepted < gated && gated < prevented && prevented < hidden,
            "order must be: see the close -> ask the toggle -> cancel it -> \
             hide; the gate must come first or an off-toggle close would be \
             cancelled with nothing left to show"
        );
    }

    /// D1: the close handler runs on the event loop, where the connection
    /// mutex is held for whole operations — a `db_batch` replays an import in
    /// one call, and the safety copy holds it across its checkpoint and file
    /// copy. Reading the settings row on that path, on every close, could
    /// freeze the UI for the duration; the handler must only load the mirror.
    #[test]
    fn the_close_handler_reads_the_mirror_and_never_the_database() {
        let body = body_of("fn close_to_tray_enabled");
        assert!(
            body.contains("CLOSE_TO_TRAY.load"),
            "the close decision comes from the in-memory mirror: {body}"
        );
        assert!(
            !body.contains("SELECT "),
            "no SQL may run on the window-event path (D1): {body}"
        );
        assert!(
            !body.contains(".conn"),
            "nor may the connection lock be taken there (D1): {body}"
        );
    }

    /// The mirror is only as fresh as its publishers, so every place the row
    /// can change publishes it: boot, the Settings toggle, and the end of an
    /// import (which replaces the `settings` table the row lives in).
    #[test]
    fn the_mirror_is_published_wherever_the_row_can_change() {
        assert!(
            SRC.contains("refresh_close_to_tray(&conn);"),
            "boot seeds the mirror before any window can be closed"
        );
        // `commands.rs` is the parent of the per-domain submodules, so the
        // publishers live beside it: read the whole family in a fixed order
        // instead of the parent alone, or the scan would pass on a file that no
        // longer holds either string.
        let commands = [
            include_str!("commands.rs"),
            include_str!("commands/app.rs"),
            include_str!("commands/backup.rs"),
            include_str!("commands/db.rs"),
            include_str!("commands/pairing.rs"),
            include_str!("commands/photos.rs"),
        ]
        .concat();
        assert!(
            commands.contains("crate::refresh_close_to_tray(&conn);"),
            "an import republishes it — the import replaced the settings table"
        );
        assert!(
            commands.contains("crate::publish_close_to_tray(enabled);"),
            "the Settings toggle publishes the value it just wrote"
        );
        assert!(
            SRC.contains("commands::close_to_tray_set,"),
            "and that command is reachable from the webview"
        );
    }

    /// The mirror is the whole decision now, so its semantics are pinned
    /// directly: it can only be what a publisher stored, and its own starting
    /// point is the fail-safe "on".
    #[test]
    fn the_mirror_holds_what_was_published() {
        use super::{publish_close_to_tray, CLOSE_TO_TRAY};
        use std::sync::atomic::Ordering;
        publish_close_to_tray(true);
        assert!(CLOSE_TO_TRAY.load(Ordering::SeqCst), "default is on");
        publish_close_to_tray(false);
        assert!(
            !CLOSE_TO_TRAY.load(Ordering::SeqCst),
            "an explicit false turns close into a quit"
        );
        // Leave the process-wide mirror as every other test, and a real boot,
        // expects it.
        publish_close_to_tray(true);
    }

    /// F13: the boot phase is what the renderer's first read waits on and
    /// its error screen shows, so the record must track the transitions
    /// exactly — a failure carries its cause, a later failure replaces it,
    /// and a successful boot settles at ready, or a recovered app would
    /// keep presenting a cause that is no longer current.
    #[test]
    fn the_boot_phase_record_tracks_failure_and_recovery() {
        use super::{boot_phase, record_boot_phase, BootPhase};
        record_boot_phase(BootPhase::Failed("first cause".to_string()));
        assert!(matches!(boot_phase(), BootPhase::Failed(c) if c == "first cause"));
        record_boot_phase(BootPhase::Failed("second cause".to_string()));
        assert!(
            matches!(boot_phase(), BootPhase::Failed(c) if c == "second cause"),
            "a later failure replaces the earlier cause"
        );
        record_boot_phase(BootPhase::Ready);
        assert!(
            matches!(boot_phase(), BootPhase::Ready),
            "a successful boot settles at ready"
        );
    }

    #[test]
    fn a_reset_terminal_session_bypasses_close_to_tray() {
        let body = body_of("fn close_to_tray_enabled");
        let flag = body
            .find("reset_terminal")
            .expect("the terminal flag is consulted (D6)");
        let toggle = body
            .find("CLOSE_TO_TRAY.load")
            .expect("the normal toggle path still exists");
        assert!(
            flag < toggle,
            "the terminal check must come before the default-on toggle, \
             or a closed DB would hide the terminal screen instead of exiting"
        );
    }

    #[test]
    fn close_to_tray_defaults_on_and_only_an_explicit_false_turns_it_off() {
        use super::parse_close_to_tray;
        // Absent row = every install that predates the key: they must all keep
        // today's "the app stays alive" behaviour without a migration.
        assert!(parse_close_to_tray(None), "missing row defaults to ON");
        assert!(parse_close_to_tray(Some("true")));
        assert!(!parse_close_to_tray(Some("false")), "explicitly off");
        // Anything that is not JSON `false` keeps the process alive behind the
        // tray — a corrupt row must never make close silently quit.
        assert!(parse_close_to_tray(Some("not json")));
        assert!(
            parse_close_to_tray(Some("\"false\"")),
            "only a JSON false turns it off"
        );
    }

    #[test]
    fn a_second_launch_restores_the_main_window() {
        // The single-instance callback must show the hidden window (plan
        // §B.2.4): with the app trayed, a second launch that does nothing
        // reads as a dead launch.
        let single = SRC
            .find(".plugin(tauri_plugin_single_instance")
            .expect("the single-instance plugin is registered");
        let setup = SRC.find(".setup(").expect("the builder has a setup hook");
        let callback = &SRC[single..setup];
        assert!(
            callback.contains("focus_main_window(app)"),
            "the second-launch callback must raise and show the main window"
        );
    }
}

#[cfg(test)]
mod key_export_log_tests {
    use super::timestamp_utc;

    #[test]
    fn the_audit_timestamp_is_rfc3339_utc() {
        // The log is read by a person, months later, possibly to explain when a
        // database was opened. It has to be sortable and unambiguous.
        let stamp = timestamp_utc();
        assert_eq!(stamp.len(), 20, "YYYY-MM-DDTHH:MM:SSZ");
        assert!(
            stamp.ends_with('Z'),
            "UTC is stated explicitly, not assumed: {stamp}"
        );
        let (date, time) = stamp.split_once('T').expect("date and time");
        let date_parts: Vec<i64> = date
            .split('-')
            .map(|p| p.parse().expect("numeric date part"))
            .collect();
        let time_parts: Vec<i64> = time
            .trim_end_matches('Z')
            .split(':')
            .map(|p| p.parse().expect("numeric time part"))
            .collect();
        assert_eq!(date_parts.len(), 3, "year-month-day");
        assert_eq!(time_parts.len(), 3, "hour-minute-second");
        let (y, m, d) = (date_parts[0], date_parts[1], date_parts[2]);
        let (hh, mm, ss) = (time_parts[0], time_parts[1], time_parts[2]);
        assert!((1..=12).contains(&m), "month in range: {stamp}");
        assert!((1..=31).contains(&d), "day in range: {stamp}");
        assert!((2020..2200).contains(&y), "a plausible year: {stamp}");
        assert!(
            hh < 24 && mm < 60 && ss < 60,
            "clock fields in range: {stamp}"
        );
    }
}

#[cfg(test)]
mod timestamp_tests {
    use super::format_timestamp_utc;

    /// Pinned against known-correct RFC 3339 instants. The shape
    /// check in `key_export_log_tests` only proves the *format*; these pin
    /// the calendar math itself at the places days-from-civil breaks if it
    /// ever breaks: the epoch, a year boundary, and a leap day.
    #[test]
    fn unix_epoch() {
        assert_eq!(format_timestamp_utc(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn year_2021_new_year() {
        // 2021-01-01T00:00:00Z = 1609459200
        assert_eq!(format_timestamp_utc(1609459200), "2021-01-01T00:00:00Z");
    }

    #[test]
    fn leap_day_2024() {
        // 2024-02-29T12:00:00Z = 1709208000
        assert_eq!(format_timestamp_utc(1709208000), "2024-02-29T12:00:00Z");
    }
}

#[cfg(test)]
mod boot_failure_tests {
    use super::{boot_failure_message, looks_like_keyring_failure, KEYRING_HINT};

    #[test]
    fn keyring_failures_are_recognized_for_the_startup_hint() {
        for message in [
            "keyring entry unavailable: platform failure",
            "failed to read DB key from credential store: denied",
            "secret-service: no dbus session",
            "Keychain access denied",
        ] {
            assert!(
                looks_like_keyring_failure(message),
                "{message:?} should read as a credential-store problem"
            );
        }
    }

    #[test]
    fn db_failures_do_not_get_the_keyring_hint() {
        for message in [
            "failed to create data dir C:\\x: access denied",
            "DB key verification failed (wrong key or corrupt file)",
            "baseline schema failed and was rolled back: syntax error",
        ] {
            assert!(
                !looks_like_keyring_failure(message),
                "{message:?} must not read as a credential-store problem"
            );
        }
    }

    #[test]
    fn the_reported_message_carries_the_cause_and_the_keyring_hint() {
        let message = boot_failure_message("keyring entry unavailable: platform failure");
        assert!(
            message.contains("keyring entry unavailable: platform failure"),
            "the cause must survive into the message: {message}"
        );
        assert!(
            message.ends_with(KEYRING_HINT),
            "a credential-store failure must carry the hint: {message}"
        );
    }

    #[test]
    fn a_db_failure_is_reported_without_the_hint() {
        let message = boot_failure_message("open /x/y.db: no such file or directory");
        assert!(message.contains("open /x/y.db: no such file or directory"));
        assert!(
            !message.contains("credential store"),
            "the hint must not appear on a non-keyring failure: {message}"
        );
    }

    /// The Retry path is exercised by failing the first N attempts, so the
    /// syntax the verification run depends on is pinned here.
    #[cfg(debug_assertions)]
    #[test]
    fn the_injection_spec_reads_a_kind_and_an_optional_attempt_count() {
        use super::parse_injection_spec;
        assert_eq!(
            parse_injection_spec("keyring"),
            Some(("keyring".into(), i64::MAX))
        );
        assert_eq!(
            parse_injection_spec(" keyring:2 "),
            Some(("keyring".into(), 2))
        );
        assert_eq!(
            parse_injection_spec("keyring:0"),
            Some(("keyring".into(), 0))
        );
        assert_eq!(
            parse_injection_spec("keyring:not-a-number"),
            Some(("keyring".into(), i64::MAX))
        );
        assert_eq!(parse_injection_spec("   "), None);
    }

    /// The body of `boot`, bounded by the next free function — the seam the
    /// two ordering pins below read. `boot` itself takes an `AppHandle`, so
    /// the ordering it must keep is pinned from source, the same way
    /// `commands.rs` pins its writer gate and `safety_copy.rs` its lock scope.
    fn boot_body() -> &'static str {
        let src = include_str!("lib.rs");
        let start = src
            .find("fn boot(app: &tauri::AppHandle)")
            .expect("boot exists");
        let end = src[start..]
            .find("fn injected_boot_failure(")
            .map(|i| start + i)
            .expect("injected_boot_failure bounds the body");
        &src[start..end]
    }

    /// E3: the interrupted-reset recovery must run before the boot loads or
    /// mints any key. Reversed, the first run after a crash would mint a
    /// fresh database under the old key while the old photos still existed —
    /// precisely the defect.
    #[test]
    fn boot_recovers_an_interrupted_reset_before_it_touches_any_key() {
        let body = boot_body();
        let marker = body
            .find("reset_in_progress")
            .expect("boot consults the durable reset marker (E3)");
        let finish = body
            .find("finish_interrupted_reset")
            .expect("and finishes the interrupted run");
        let mint = body
            .find("load_or_mint_db_key")
            .expect("before any key is loaded or minted");
        assert!(
            marker < finish && finish < mint,
            "recovery must precede key work: {marker} {finish} {mint}"
        );
    }

    /// E9: whether a database preexisted is measured before the open that
    /// can create one; a failure of that first run undoes the provably-new
    /// file BEFORE the freshly minted key is discarded, and only under the
    /// `database_preexisted` guard — an existing database is never removed.
    #[test]
    fn a_failed_first_run_undoes_its_own_database_before_discarding_the_key() {
        let body = boot_body();
        let preexisting = body
            .find("database_preexisted")
            .expect("boot records whether a database existed first (E9)");
        let open = body
            .find("open_encrypted_db")
            .expect("the open is the step that can create the file");
        assert!(
            preexisting < open,
            "measured before the open: {preexisting} vs {open}"
        );
        let cleanup = body
            .find("remove_abandoned_new_db")
            .expect("the provably-new file is undone (E9)");
        // Discard AFTER the cleanup call — the branch where the file was
        // removed. (The first `discard_minted_key` in source is the
        // pre-existing-database branch, which legitimately precedes it.)
        let _discard_after_cleanup = body[cleanup..]
            .find("discard_minted_key")
            .expect("the minted key is discarded once the cleanup ran");
        assert!(
            body.contains("if database_preexisted"),
            "the cleanup must stay behind its guard: an existing database is never removed"
        );
    }

    /// E13: the watchdog is scoped to one NAMED wait state at a time — every
    /// answer re-arms for the next state instead of letting the old timer
    /// keep counting — and its final exit decision shares a lock with
    /// retirement, so it can no longer fire in the window between the last
    /// generation check and the exit (how a recovered app used to be killed
    /// with a message about an answer nobody still owed).
    #[test]
    fn the_watchdog_is_state_scoped_and_its_exit_is_synchronized() {
        let src = include_str!("lib.rs");

        // The exit decision: under the shared lock, re-checking the
        // generation there, and naming the state it gave up on.
        let start = src.find("fn arm_watchdog(").expect("the watchdog exists");
        let end = src[start..]
            .find("\nfn ")
            .map(|i| start + i)
            .expect("bounds the body");
        let body = &src[start..end];
        let lock = body
            .find("WATCHDOG_EXIT")
            .expect("the final decision takes the shared lock (E13)");
        assert!(
            body[lock..].contains("WATCHDOG_GENERATION.load"),
            "and re-checks the generation under it"
        );
        assert!(
            body.contains("{waiting_for}"),
            "the exit message names the state it was waiting on"
        );

        // Retirement takes the same lock before it bumps.
        let retire = src.find("fn retire_watchdog()").expect("retirement exists");
        let r_lock = src[retire..]
            .find("WATCHDOG_EXIT")
            .expect("retirement locks too");
        let r_bump = src[retire..]
            .find("fetch_add")
            .expect("and bumps the generation");
        assert!(r_lock < r_bump, "lock before bump: {r_lock} vs {r_bump}");

        // Every entry point arms its own labelled state, and no unlabelled
        // arm is left behind — an anonymous arm is the E13 bug. The needle
        // is assembled so this assertion cannot match its own source.
        let unlabelled = format!("{}();", "arm_watchdog");
        assert!(
            !src.contains(&unlabelled),
            "every arm_watchdog call must name its wait state"
        );
        for (site, state) in [
            ("fn retry_boot(", "the retry attempt"),
            ("fn pick_key_file_and_restore(", "the key file picker"),
        ] {
            let from = src.find(site).expect("the entry point exists");
            let to = src[from..]
                .find("\nfn ")
                .map(|i| from + i)
                .unwrap_or(src.len());
            assert!(
                src[from..to].contains(state),
                "{site} must arm a watchdog for its own state (E13)"
            );
        }
        assert!(
            src.contains("retire_watchdog();"),
            "a successful recovery retires under the shared lock"
        );
    }
}
