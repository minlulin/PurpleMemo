mod commands;
mod db;
mod navigation;
mod photos;
mod schema;
mod share;

use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        // Cancels any navigation away from the app's own origin (review L-01);
        // external links go to the system browser instead (MarkdownLink).
        .plugin(navigation::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // Encrypted DB core (P1): app-data dir -> keyring key (mint-once)
            // -> SQLCipher open with verify-before-use -> baseline schema.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)
                .map_err(|e| format!("failed to create data dir {}: {e}", data_dir.display()))?;
            let key = db::load_or_mint_db_key()?;
            let conn = db::open_encrypted_db(&data_dir.join(db::DB_FILE_NAME), &key)?;
            db::init_schema(&conn)?;
            app.manage(db::AppState {
                conn: Mutex::new(conn),
                txn_open: AtomicBool::new(false),
                data_dir,
            });
            // LAN sharing (§8) starts OFF — it is opt-in per session and
            // must never be re-enabled silently by a restart.
            app.manage(share::ShareState::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::db_query,
            commands::db_execute,
            commands::db_batch,
            commands::db_begin,
            commands::db_commit,
            commands::db_rollback,
            commands::photo_save,
            commands::photo_read,
            commands::photo_read_thumb,
            commands::photo_save_thumb,
            commands::photo_delete,
            commands::db_key_export,
            commands::share_start,
            commands::share_stop,
            commands::share_status,
            commands::share_publish,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| report_boot_failure(&e.to_string()));
}

/// A setup failure used to propagate out of `run()` into
/// `.expect("error while running Purple Memo")` — with `panic = "abort"` in
/// the release profile that meant no window, no dialog and no log, just a
/// process that exits (review L-04). The most plausible trigger is
/// environmental: a desktop where the OS credential store is unavailable can
/// never create a keyring entry, so the app would be permanently
/// unlaunchable with no explanation.
///
/// Instead: write a `boot-error.log` diagnostic next to the DB (best-effort —
/// the failure may itself be "cannot create the data dir"), print the message
/// to stderr, and exit non-zero. The log carries the keyring hint when the
/// failure smells like a credential-store problem. This never returns.
fn report_boot_failure(message: &str) -> ! {
    let hint = if looks_like_keyring_failure(message) {
        " Hint: your OS credential store looks unavailable — Purple Memo keeps its database key there, so it cannot start without it."
    } else {
        ""
    };
    let full = format!("Purple Memo failed to start: {message}.{hint}");
    // Best-effort diagnostic file next to the DB (may fail when the data dir
    // itself is the problem — stderr below is the backstop).
    if let Some(mut dir) = dirs_next_to_db() {
        dir.push("boot-error.log");
        let _ = std::fs::write(&dir, format!("{full}\n"));
    }
    eprintln!("{full}");
    std::process::exit(1);
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

/// App-data dir without a running app: mirrors what `setup` resolves via
/// `app.path().app_data_dir()`. Returns None when the platform home cannot
/// be determined — the caller treats that as "stderr only".
#[cfg(target_os = "windows")]
fn dirs_next_to_db() -> Option<std::path::PathBuf> {
    std::env::var_os("APPDATA")
        .map(|base| std::path::PathBuf::from(base).join("com.minlulin.purplememo"))
}

#[cfg(not(target_os = "windows"))]
fn dirs_next_to_db() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .map(|base| std::path::PathBuf::from(base).join(".local/share/com.minlulin.purplememo"))
}

#[cfg(test)]
mod boot_failure_tests {
    use super::looks_like_keyring_failure;

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
}
