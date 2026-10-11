mod commands;
mod db;
mod photos;
mod schema;

use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
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
            commands::photo_delete,
            commands::db_key_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Purple Memo");
}
