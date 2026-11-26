//! The photo commands: raw-body writers for the original bytes and the
//! thumbnail, and the raw-byte reads. The photo header constants and their
//! lease helper live here because these five commands are their only users;
//! the generic raw-body/header helpers stay in the parent, shared with
//! `backup.rs`.

use std::sync::Arc;

use tauri::ipc::{Request, Response};
use tauri::Manager;

use super::{header_str, header_str_opt, lock_conn, raw_body, CmdResult};
use crate::db::AppState;
use crate::lifecycle::Lifecycle;
use crate::messages::Refusal;
use crate::photos;

/// Request header carrying the photo extension on a raw `photo_save` body.
const EXT_HEADER: &str = "x-photo-ext";
/// Request header carrying the SOURCE photo path on a raw `photo_save_thumb`
/// body — the thumbnail path itself is always derived in `photos.rs`.
const SOURCE_HEADER: &str = "x-photo-source";
/// Request header carrying the import lease on the raw photo writers (E5).
/// A raw body IS the whole request, so these commands have no argument
/// channel for it — same reason the metadata beside it rides in a header.
/// Absent means "an ordinary app write", which the lifecycle refuses while
/// an import or reset owns the data.
const LEASE_HEADER: &str = "x-import-lease";
/// E6: the per-photo ceiling, identical to `MAX_BACKUP_PHOTO_BYTES` in
/// `src/lib/backup.ts` — a photo the importer would refuse on restore must
/// never be accepted at save time, or the app writes backups it cannot read
/// back. Pinned against the TS constant by `ipc.test.ts`, because the two
/// limits living in two languages is exactly how they drift apart.
const MAX_SAVED_PHOTO_BYTES: u64 = 25 * 1024 * 1024;

/// The import lease off [`LEASE_HEADER`]: `None` for an ordinary write.
fn lease_from_header(request: &Request<'_>) -> CmdResult<Option<u64>> {
    match header_str_opt(request, LEASE_HEADER)? {
        None => Ok(None),
        Some(text) => Ok(Some(
            text.parse::<u64>()
                .map_err(|_| Refusal::new("rust.error.leaseNotNumber"))?,
        )),
    }
}

/// Store photo bytes content-addressed under `photos/<yyyy>/<mm>/`; the
/// yyyy/mm comes from SQLite's local-time clock so paths follow the user's
/// local date. Returns the relative path the feature layer stores in
/// the `photos` table.
///
/// The bytes arrive as the RAW request body (`invoke('photo_save',
/// new Uint8Array(bytes), { headers: { 'x-photo-ext': ext } })`), so a 3 MB
/// photo crosses IPC as 3 MB instead of ~12 million JSON characters.
///
/// Async + `spawn_blocking`: the SHA-256 hashing, the write, and
/// the dedupe re-hash of an existing file are the expensive part; the request
/// body and header are extracted into owned values first, before any await,
/// because the borrow does not outlive the command.
#[tauri::command]
pub async fn photo_save(app: tauri::AppHandle, request: Request<'_>) -> CmdResult<String> {
    let ext = header_str(&request, EXT_HEADER)?.to_string();
    let lease = lease_from_header(&request)?;
    let bytes = raw_body(&request)?;
    // E6: refuse at the door what the importer would refuse at restore. The
    // gallery picker reads the chosen file without a limit, so this command
    // is the one choke point every original bytes pass through — and the
    // refusal happens before any hashing, writing, or barrier ticket.
    if bytes.len() as u64 > MAX_SAVED_PHOTO_BYTES {
        return Err(Refusal::new("rust.error.photoTooLarge")
            .with(
                "size",
                format!("{:.1}", bytes.len() as f64 / (1024.0 * 1024.0)),
            )
            .with(
                "limit",
                format!("{:.0}", MAX_SAVED_PHOTO_BYTES as f64 / (1024.0 * 1024.0)),
            ));
    }
    // Admit BEFORE the date lookup and hold the ticket across the blocking
    // write (E1): a save admitted before `raise_reset` is drained before the
    // reset deletes `photos/`, and one arriving after it is refused instead
    // of recreating the tree the reset just removed.
    let lifecycle = app.state::<Arc<Lifecycle>>();
    let _ticket = lifecycle.admit(lease)?;
    let year_month: String = {
        let state = app.state::<AppState>();
        let conn = lock_conn(&state)?;
        conn.query_row("SELECT strftime('%Y/%m', 'now', 'localtime')", [], |row| {
            row.get(0)
        })
        .map_err(|e| Refusal::new("rust.error.photoWrite").with("detail", e))?
    };
    let data_dir = app.state::<AppState>().data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        photos::save_photo(&data_dir, &year_month, &bytes, &ext)
    })
    .await
    .map_err(|e| Refusal::from(e.to_string()))?
}

/// Read photo bytes by DB-relative path (traversal-guarded). The response is
/// raw bytes: the frontend receives an `ArrayBuffer`, not a JSON array.
#[tauri::command]
pub async fn photo_read(app: tauri::AppHandle, rel_path: String) -> CmdResult<Response> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        Ok(Response::new(photos::read_photo(
            &state.data_dir,
            &rel_path,
        )?))
    })
    .await
    .map_err(|e| Refusal::from(e.to_string()))?
}

/// Read the thumbnail of a photo, given the SOURCE photo's relative path.
/// Errors when no thumbnail has been stored yet — the frontend then generates
/// one from the full bytes and saves it with `photo_save_thumb`.
#[tauri::command]
pub async fn photo_read_thumb(
    app: tauri::AppHandle,
    source_rel_path: String,
) -> CmdResult<Response> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        Ok(Response::new(photos::read_thumb(
            &state.data_dir,
            &source_rel_path,
        )?))
    })
    .await
    .map_err(|e| Refusal::from(e.to_string()))?
}

/// Store the thumbnail of a photo (raw bytes; the source photo path travels
/// in the `x-photo-source` header). Returns the derived thumbnail path.
///
/// Async + `spawn_blocking`: same freeze class as
/// [`photo_save`]; the header and body are owned before the first await.
#[tauri::command]
pub async fn photo_save_thumb(app: tauri::AppHandle, request: Request<'_>) -> CmdResult<String> {
    let source = header_str(&request, SOURCE_HEADER)?.to_string();
    let lease = lease_from_header(&request)?;
    let bytes = raw_body(&request)?;
    // Same barrier as `photo_save` (E1) — this command used to check nothing
    // at all and was callable after the connection had been taken.
    let lifecycle = app.state::<Arc<Lifecycle>>();
    let _ticket = lifecycle.admit(lease)?;
    let state = app.state::<AppState>();
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || photos::save_thumb(&data_dir, &source, &bytes))
        .await
        .map_err(|e| Refusal::from(e.to_string()))?
}

/// Delete a photo file by DB-relative path (traversal-guarded, idempotent).
/// The derived thumbnail is deleted with it; DB rows referencing the photo are
/// the feature layer's concern (P3e).
#[tauri::command]
pub async fn photo_delete(
    app: tauri::AppHandle,
    rel_path: String,
    lease: Option<u64>,
) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        // An import deletes the photos its archive no longer references; anyone
        // else is refused while a window or reset owns the data (E1/E5).
        let lifecycle = app.state::<Arc<Lifecycle>>();
        let _ticket = lifecycle.admit(lease)?;
        let state = app.state::<AppState>();
        photos::delete_photo(&state.data_dir, &rel_path)
    })
    .await
    .map_err(|e| Refusal::from(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use crate::commands::tests::{
        assert_async_three, assert_async_two, assert_dispatches_off_the_main_thread,
    };

    /// B3 part 2: the photo reads and delete. Same two halves as the DB pin, so
    /// no edit can quietly move one of them back onto the main thread.
    #[test]
    fn the_photo_commands_run_off_the_main_thread() {
        assert_async_two::<tauri::AppHandle, String, _>(super::photo_read);
        assert_async_two::<tauri::AppHandle, String, _>(super::photo_read_thumb);
        assert_async_three::<tauri::AppHandle, String, Option<u64>, _>(super::photo_delete);

        for name in ["photo_read", "photo_read_thumb", "photo_delete"] {
            assert_dispatches_off_the_main_thread(name);
        }
    }
}
