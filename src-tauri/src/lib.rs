mod backup_file;
mod commands;
mod db;
mod navigation;
mod photos;
mod schema;
mod share;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// How long one boot-failure dialog may stay up before the process stops waiting
/// for an answer, and how often the watchdog re-checks that it is still the
/// current one. Generous on purpose: someone may be unlocking a credential store
/// or starting a session before choosing Retry.
const BOOT_FAILURE_WATCHDOG: Duration = Duration::from_secs(600);
const WATCHDOG_TICK: Duration = Duration::from_secs(5);

/// Button labels, in one place so the dialog and its guidance cannot drift.
const RETRY_LABEL: &str = "Retry";
const QUIT_LABEL: &str = "Quit";

/// The main window's label, matching `tauri.conf.json`. Named here because
/// `focus_main_window` has to find the window to raise, and a typo in a string
/// literal would only show up as "the second launch does nothing".
const MAIN_WINDOW_LABEL: &str = "main";

/// The Tauri app-data directory name. One place, because it was previously
/// spelled out in three files that could drift (`tauri.conf.json`, the keyring
/// service name, and the log paths here).
const APP_DIR_NAME: &str = "com.minlulin.purplememo";

/// Audit log of every key disclosure (§5.4), written next to the database.
const KEY_EXPORT_LOG: &str = "key-export.log";

/// Audit log of every LAN-share disclosure (§8), written next to the database.
const SHARE_LOG: &str = "share.log";

/// Added to the dialog body — the log line stays the plain, quotable failure.
const RETRY_GUIDANCE: &str = " Fix that and choose Retry, or choose Quit to close Purple Memo.";

/// Added to the boot-failure message when the failure smells like a missing or
/// locked OS credential store.
const KEYRING_HINT: &str = " Hint: your OS credential store looks unavailable — Purple Memo keeps its database key there, so it cannot start without it.";

/// Bumped whenever a boot-failure dialog is replaced or the app recovers.
/// A watchdog armed for an earlier dialog sees the change and stands down, so a
/// recovered session can never be ended by a watchdog that outlived its dialog.
static WATCHDOG_GENERATION: AtomicU64 = AtomicU64::new(0);

pub fn run() {
    tauri::Builder::default()
        // MUST stay first. A second launch is turned away before this app
        // reaches `setup` — and therefore before `boot` — which is what keeps
        // two copies from racing the database. That race was not cosmetic:
        // both could reach `load_or_mint_db_key` while the database file did
        // not yet exist, both would mint a different key, and the loser's
        // `set_password` would overwrite the only credential-store slot with a
        // key that cannot open the database the winner just created (C-4).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main_window(app);
        }))
        // Cancels any navigation away from the app's own origin (review L-01);
        // external links go to the system browser instead (MarkdownLink).
        .plugin(navigation::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // A failed boot is *reported*, not propagated: returning `Err` here
            // tears the app down before anything could be shown, or retried
            // (review L-04).
            if let Err(message) = boot(app.handle()) {
                report_boot_failure(app.handle(), &message);
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
            commands::share_arm,
            commands::share_start,
            commands::share_stop,
            commands::share_status,
            commands::share_publish,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| report_run_failure(&e.to_string()));
}

/// Encrypted DB core (P1) — everything the app needs before the frontend can use
/// it: app-data dir -> keyring key (mint-once) -> SQLCipher open with
/// verify-before-use -> baseline schema -> managed state.
///
/// Takes an `AppHandle` rather than the `App` so the same work can be re-run
/// from the retry path, which is not on the setup thread.
///
/// Returns the failure as a message instead of propagating it, so the caller can
/// put it in front of the user. Nothing is managed until every fallible step has
/// succeeded, so a failed attempt leaves no half-initialized state behind.
fn boot(app: &tauri::AppHandle) -> Result<(), String> {
    // Fault injection for the paths below, so they are not shipped untested
    // (review L-04): in a debug build
    // `PURPLE_MEMO_FORCE_BOOT_FAILURE=keyring:2 npm run tauri dev` fails the
    // first two attempts and then starts normally, which is how the Retry path
    // is exercised end to end; `=keyring` fails every attempt. Release builds
    // ignore the variable — a shipped app must never be unstartable because of
    // an environment variable it inherited.
    #[cfg(debug_assertions)]
    if let Some(kind) = injected_boot_failure() {
        return Err(format!(
            "simulated {kind} failure (PURPLE_MEMO_FORCE_BOOT_FAILURE is set)"
        ));
    }

    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("failed to create data dir {}: {e}", data_dir.display()))?;
    remember_data_dir(&data_dir);
    let db_path = data_dir.join(db::DB_FILE_NAME);
    let key = db::load_or_mint_db_key(&db_path)?;
    // A key this process minted is only correct if the database it opens with
    // it verifies. If the very first run fails anyway, take the key back out
    // rather than leave an unopenable key in the credential store's only slot
    // (review C-4).
    let opened = db::open_encrypted_db(&db_path, &key.hex).and_then(|conn| {
        db::init_schema(&conn)?;
        Ok(conn)
    });
    let conn = match opened {
        Ok(conn) => conn,
        Err(e) => {
            if key.freshly_minted {
                db::discard_minted_key();
            }
            return Err(e);
        }
    };
    app.manage(db::AppState {
        conn: Mutex::new(conn),
        txn_open: AtomicBool::new(false),
        data_dir,
    });
    // LAN sharing (§8) starts OFF — it is opt-in per session and must never be
    // re-enabled silently by a restart.
    app.manage(share::ShareState::new());
    Ok(())
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

/// Put a boot failure where the user can see it and act on it (review L-04).
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
/// The dialog offers Retry, because the likeliest failure is an environment the
/// user can fix without restarting the app: an OS credential store that is
/// locked, missing, or not reachable in this session. Quit exits non-zero; the
/// log file and stderr stay the durable record.
fn report_boot_failure(app: &tauri::AppHandle, message: &str) {
    let full = boot_failure_message(message);
    write_boot_error_log(&full);
    eprintln!("{full}");
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    arm_watchdog();
    let handle = app.clone();
    app.dialog()
        .message(format!("{full}{RETRY_GUIDANCE}"))
        .title("Purple Memo can't start")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCancelCustom(
            RETRY_LABEL.into(),
            QUIT_LABEL.into(),
        ))
        .show(move |retry| {
            if retry {
                retry_boot(handle);
            } else {
                std::process::exit(1);
            }
        });
}

/// The user chose Retry, having had the chance to fix whatever blocked startup.
///
/// Runs the boot work on a fresh thread: the dialog callback arrives on one of
/// the plugin's worker threads and must not block while a database is opened and
/// a keyring is queried. On success the window comes back — reloaded first,
/// because its frontend loaded while every command was failing with "state not
/// managed" and would otherwise stay on its error screen. On failure the dialog
/// is shown again.
fn retry_boot(app: tauri::AppHandle) {
    std::thread::spawn(move || match boot(&app) {
        Ok(()) => {
            // Retire every watchdog armed for a dialog in this session before
            // touching anything else: the app is healthy now and must not be
            // ended by a timer that was set for a failure that is over.
            WATCHDOG_GENERATION.fetch_add(1, Ordering::SeqCst);
            note_boot_recovery();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.reload();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        Err(message) => report_boot_failure(&app, &message),
    });
}

/// Arm a watchdog for the dialog that was just shown.
///
/// The dialog lives in this process, so the process has to outlive it — but a
/// process with a hidden window and no dialog on screen is a zombie nobody can
/// answer. If a dialog never renders (no display, broken portal, dialog backend
/// failure), this is what ends the wait. Every new dialog re-arms, and a
/// successful retry retires the lot, so the timer only ever measures time spent
/// waiting on the current dialog.
fn arm_watchdog() {
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
        eprintln!("purple-memo: no answer to the boot-failure dialog; exiting");
        std::process::exit(1);
    });
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
        dir.push("boot-error.log");
        let _ = std::fs::write(&dir, format!("{full}\n"));
    }
}

/// Record that a retry worked, so the log does not read as an app that never
/// started. Appends to the file `write_boot_error_log` wrote.
fn note_boot_recovery() {
    use std::io::Write;
    if let Some(mut path) = dirs_next_to_db() {
        path.push("boot-error.log");
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
/// which previously each rolled their own (FIX-07).
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

/// Append one LAN-share disclosure to `share.log`.
///
/// Starting the share server puts a read-only view of the user's money and
/// notes on the local network. The user finds out by looking in Settings; this
/// is how they find out *afterwards*, including if the machine was not theirs
/// at the time. The encryption key is never recorded — see [`share::ShareEvent`].
pub(crate) fn note_share_event(event: share::ShareEvent) {
    append_audit_line(SHARE_LOG, &event.audit_line());
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
/// clock (FIX-06) — the shape check in `key_export_log_tests` proves the
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
fn dirs_next_to_db() -> Option<std::path::PathBuf> {
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
    std::env::var_os("HOME").map(|home| {
        std::path::PathBuf::from(home)
            .join(".local/share")
            .join(APP_DIR_NAME)
    })
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

    /// Pinned against known-correct RFC 3339 instants (FIX-06). The shape
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
}
