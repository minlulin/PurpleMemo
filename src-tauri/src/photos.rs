//! Photo storage (§4): bytes are hashed (sha256) and stored content-addressed
//! at `photos/<yyyy>/<mm>/<sha256-hex>.<ext>` under the app data dir; the DB
//! keeps the relative path. Reads/deletes guard against path traversal with a
//! strict grammar — the only accepted shape is
//! `photos/<4 digits>/<2 digits>/<64 hex>.<1-8 lowercase alnum>`.
//!
//! Thumbnails (review M-02) live next to their photo as
//! `photos/<yyyy>/<mm>/<sha256-hex>.thumb.<ext>`: derived from the photo path,
//! never stored in the DB — the schema has no migrations, so a `thumb_path`
//! column would strand every existing database. The frontend never builds
//! either path itself: `photo_read_thumb`/`photo_save_thumb` take the SOURCE
//! photo path and derive the sibling internally, which also means the
//! JS-facing grammar is unchanged (a `.thumb.`-shaped path is rejected as a
//! source, since its extension would contain two dots).

use std::fs;
use std::io::ErrorKind;
use std::path::Path;
use std::sync::Mutex;

use sha2::{Digest, Sha256};

use crate::bytes_to_hex;

/// Serialize content-addressed writes *and deletes*. The destination path is
/// derived from the bytes, so concurrent saves of the same photo would
/// otherwise race on the same temporary and final paths — and a delete that
/// did not take this lock could unlink a file a concurrent save had just
/// written (or was about to rename into place), leaving the row the save
/// returned pointing at a file that no longer exists.
static PHOTO_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Save photo bytes; returns the relative path to store in the DB.
///
/// Content-addressed: identical bytes always map to the same path, so a
/// duplicate save is a no-op write.
///
/// The write is atomic: bytes go to a temp file in the same directory and
/// are renamed into place, so a crash can never leave a partial file at the
/// final path. If a file already exists there, its hash is verified first —
/// a previous crash mid-write (before this atomic scheme) could have left a
/// partial file that a bare `exists()` check would wrongly accept.
pub fn save_photo(
    data_dir: &Path,
    year_month: &str,
    bytes: &[u8],
    ext: &str,
) -> Result<String, String> {
    let _write_guard = PHOTO_WRITE_LOCK.lock().map_err(|_| {
        "photo storage is temporarily unavailable — restart Purple Memo".to_string()
    })?;
    let ext = ext.to_ascii_lowercase();
    if !is_valid_ext(&ext) {
        return Err(format!(
            "invalid photo extension {ext:?}: 1-8 lowercase letters/digits expected"
        ));
    }
    let (year, month) = parse_year_month(year_month)?;
    let digest = Sha256::digest(bytes);
    let hash: String = bytes_to_hex(digest.as_slice());
    let rel_path = format!("photos/{year}/{month}/{hash}.{ext}");
    let abs_path = data_dir.join(&rel_path);
    if let Some(parent) = abs_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    if abs_path.exists() {
        let existing =
            fs::read(&abs_path).map_err(|e| format!("read {}: {e}", abs_path.display()))?;
        let existing_hash: String = bytes_to_hex(Sha256::digest(&existing).as_slice());
        if existing_hash == hash {
            return Ok(rel_path);
        }
        // Hash mismatch: partial or corrupt file — rewrite it atomically below.
    }
    write_atomic(&abs_path, bytes, true)?;
    Ok(rel_path)
}

/// Bytes -> temp sibling -> rename. The temp path is a sibling in the same
/// directory so the rename stays on one filesystem, and it can never collide
/// with a storable path: the photo grammar allows a single dot, so
/// `<hash>.jpg.tmp` and `<hash>.thumb.jpg.tmp` are both unstorable shapes.
///
/// `replace` removes a known-bad destination first: `rename` overwrites on
/// Unix but not on Windows, and corruption recovery must behave the same on
/// every supported platform. The caller holds [`PHOTO_WRITE_LOCK`], so the
/// short remove/rename window is not observable by another write.
fn write_atomic(abs_path: &Path, bytes: &[u8], replace: bool) -> Result<(), String> {
    let Some(parent) = abs_path.parent() else {
        return Err(format!("no parent directory for {}", abs_path.display()));
    };
    fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    let Some(file_name) = abs_path.file_name().and_then(|n| n.to_str()) else {
        return Err(format!("invalid destination {}", abs_path.display()));
    };
    let tmp_path = parent.join(format!("{file_name}.tmp"));
    fs::write(&tmp_path, bytes).map_err(|e| format!("write {}: {e}", tmp_path.display()))?;
    if replace && abs_path.exists() {
        fs::remove_file(abs_path)
            .map_err(|e| format!("remove corrupt {}: {e}", abs_path.display()))?;
    }
    fs::rename(&tmp_path, abs_path).map_err(|e| {
        format!(
            "rename {} -> {}: {e}",
            tmp_path.display(),
            abs_path.display()
        )
    })
}

/// The thumbnail that belongs to a stored photo: same directory and hash,
/// with a `.thumb` marker before the extension.
///
/// Derived rather than stored (see the module docs). The source path is
/// validated first, which is what keeps the derived path out of reach of the
/// frontend: `photos/2026/10/<hash>.thumb.jpg` is not a valid SOURCE path, so
/// a caller cannot address a thumbnail file directly.
pub fn thumb_rel_path(rel_path: &str) -> Result<String, String> {
    validate_rel_path(rel_path)?;
    let (dir, file) = rel_path
        .rsplit_once('/')
        .ok_or_else(|| invalid_rel(rel_path))?;
    let (hash, ext) = file.split_once('.').ok_or_else(|| invalid_rel(rel_path))?;
    Ok(format!("{dir}/{hash}.thumb.{ext}"))
}

/// Read photo bytes by relative path (traversal-guarded).
pub fn read_photo(data_dir: &Path, rel_path: &str) -> Result<Vec<u8>, String> {
    validate_rel_path(rel_path)?;
    fs::read(data_dir.join(rel_path)).map_err(|e| format!("read {rel_path}: {e}"))
}

/// Read the thumbnail of a stored photo. The caller passes the SOURCE path;
/// the sibling thumb path is derived here. An error means "no thumbnail yet"
/// (or a source that does not exist) — the frontend then generates one.
pub fn read_thumb(data_dir: &Path, rel_path: &str) -> Result<Vec<u8>, String> {
    let thumb = thumb_rel_path(rel_path)?;
    fs::read(data_dir.join(&thumb)).map_err(|e| format!("read {thumb}: {e}"))
}

/// Write the thumbnail of a stored photo and return the derived thumb path.
/// Same atomic-write discipline as a photo save.
pub fn save_thumb(data_dir: &Path, rel_path: &str, bytes: &[u8]) -> Result<String, String> {
    let _write_guard = PHOTO_WRITE_LOCK.lock().map_err(|_| {
        "photo storage is temporarily unavailable — restart Purple Memo".to_string()
    })?;
    let thumb = thumb_rel_path(rel_path)?;
    write_atomic(&data_dir.join(&thumb), bytes, false)?;
    Ok(thumb)
}

/// Delete a photo file by relative path (traversal-guarded, idempotent). The
/// derived thumbnail goes with it, so a deleted photo leaves no orphan file.
///
/// Takes [`PHOTO_WRITE_LOCK`] like the saves do: paths are content-addressed,
/// so the file being deleted may be the very file a concurrent save of the
/// same bytes is verifying, writing or renaming into place. Serializing the
/// delete against the saves keeps "save returned this path" and "the file at
/// this path exists" from coming apart.
pub fn delete_photo(data_dir: &Path, rel_path: &str) -> Result<(), String> {
    let _write_guard = PHOTO_WRITE_LOCK.lock().map_err(|_| {
        "photo storage is temporarily unavailable — restart Purple Memo".to_string()
    })?;
    validate_rel_path(rel_path)?;
    match fs::remove_file(data_dir.join(rel_path)) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(format!("delete {rel_path}: {e}")),
    }
    // Best-effort: a thumbnail is derived data, so failing to unlink one must
    // never turn a successful (or already-done) photo delete into an error.
    if let Ok(thumb) = thumb_rel_path(rel_path) {
        let _ = fs::remove_file(data_dir.join(thumb));
    }
    Ok(())
}

fn is_valid_ext(ext: &str) -> bool {
    (1..=8).contains(&ext.len()) && ext.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn parse_year_month(year_month: &str) -> Result<(&str, &str), String> {
    let parts: Vec<&str> = year_month.split('/').collect();
    match parts.as_slice() {
        [year, month]
            if year.len() == 4
                && year.bytes().all(|b| b.is_ascii_digit())
                && month.len() == 2
                && month.bytes().all(|b| b.is_ascii_digit())
                && (1..=12).contains(&month.parse::<u32>().unwrap_or(0)) =>
        {
            Ok((year, month))
        }
        _ => Err(format!(
            "invalid year/month {year_month:?}: expected yyyy/mm"
        )),
    }
}

/// Strict grammar check — the only defense needed against traversal, since
/// the validated path is joined directly onto the data dir.
fn validate_rel_path(rel_path: &str) -> Result<(), String> {
    let rest = rel_path
        .strip_prefix("photos/")
        .ok_or_else(|| invalid_rel(rel_path))?;
    let mut segments = rest.split('/');
    let (Some(year), Some(month), Some(file), None) = (
        segments.next(),
        segments.next(),
        segments.next(),
        segments.next(),
    ) else {
        return Err(invalid_rel(rel_path));
    };
    if parse_year_month(&format!("{year}/{month}")).is_err() {
        return Err(invalid_rel(rel_path));
    }
    let Some((hash, ext)) = file.split_once('.') else {
        return Err(invalid_rel(rel_path));
    };
    let hash_ok = hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit());
    if !hash_ok || !is_valid_ext(ext) {
        return Err(invalid_rel(rel_path));
    }
    Ok(())
}

fn invalid_rel(rel_path: &str) -> String {
    format!("invalid photo path {rel_path:?}")
}

// ---------------------------------------------------------------------------
// Tests — run with `cargo test` (P1 gate)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let n = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir()
                .join(format!("purple-memo-p1-photos-{}-{n}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn save_read_delete_roundtrip() {
        let dir = TempDir::new();
        let bytes = b"fake jpeg bytes \xFF\xD8\xFF";
        let rel = save_photo(&dir.0, "2026/10", bytes, "jpg").expect("save");
        assert!(
            rel.starts_with("photos/2026/10/") && rel.ends_with(".jpg"),
            "unexpected rel path: {rel}"
        );
        let hash = Sha256::digest(bytes);
        let hex: String = hash.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(rel, format!("photos/2026/10/{hex}.jpg"));

        let read_back = read_photo(&dir.0, &rel).expect("read");
        assert_eq!(read_back, bytes, "bytes must roundtrip unchanged");

        delete_photo(&dir.0, &rel).expect("delete");
        assert!(read_photo(&dir.0, &rel).is_err(), "gone after delete");
        // Idempotent delete of an already-missing photo.
        delete_photo(&dir.0, &rel).expect("second delete is a no-op");
    }

    #[test]
    fn identical_bytes_dedupe_to_one_file() {
        let dir = TempDir::new();
        let rel1 = save_photo(&dir.0, "2026/10", b"same", "png").expect("first");
        let rel2 = save_photo(&dir.0, "2026/10", b"same", "png").expect("second");
        assert_eq!(rel1, rel2, "content addressing must dedupe");
        let files: Vec<_> = fs::read_dir(dir.0.join("photos/2026/10"))
            .expect("dir")
            .collect();
        assert_eq!(files.len(), 1, "one physical file for identical bytes");
        // Different bytes -> different path.
        let rel3 = save_photo(&dir.0, "2026/10", b"other", "png").expect("third");
        assert_ne!(rel1, rel3);
    }

    #[test]
    fn corrupt_existing_file_is_replaced() {
        let dir = TempDir::new();
        let bytes = b"correct bytes";
        let rel = save_photo(&dir.0, "2026/10", bytes, "jpg").expect("seed");
        fs::write(dir.0.join(&rel), b"corrupt").expect("corrupt file");

        let repaired = save_photo(&dir.0, "2026/10", bytes, "jpg").expect("repair");
        assert_eq!(repaired, rel);
        assert_eq!(read_photo(&dir.0, &rel).expect("read repaired"), bytes);
    }

    #[test]
    fn invalid_extensions_and_year_month_rejected() {
        let dir = TempDir::new();
        for bad_ext in ["", "jp/g", "..", "a".repeat(9).as_str(), "jpg;rm"] {
            assert!(
                save_photo(&dir.0, "2026/10", b"x", bad_ext).is_err(),
                "ext {bad_ext:?} must be rejected"
            );
        }
        // Uppercase normalizes rather than errors.
        save_photo(&dir.0, "2026/10", b"x", "PNG").expect("uppercase ext normalizes");
        for bad_ym in ["2026", "2026-10", "26/10", "2026/13", "2026/00", "ab/cd"] {
            assert!(
                save_photo(&dir.0, bad_ym, b"x", "jpg").is_err(),
                "year/month {bad_ym:?} must be rejected"
            );
        }
    }

    #[test]
    fn delete_photo_waits_for_the_write_lock() {
        // The regression test for the unlocked delete: while the write lock
        // is held (as a save would hold it), a delete of the same file must
        // not complete; once the lock is released it goes through. Without
        // the lock in `delete_photo` the delete finishes immediately and the
        // first assertion fails.
        let dir = TempDir::new();
        let rel = save_photo(&dir.0, "2026/10", b"lock race bytes", "jpg").expect("save");
        let (tx, rx) = std::sync::mpsc::channel();
        let guard = PHOTO_WRITE_LOCK.lock().expect("hold the write lock");
        let dir_path = dir.0.clone();
        let rel_clone = rel.clone();
        let deleter = std::thread::spawn(move || {
            let result = delete_photo(&dir_path, &rel_clone);
            let _ = tx.send(result);
        });
        assert!(
            rx.recv_timeout(std::time::Duration::from_millis(200))
                .is_err(),
            "delete must wait for the photo write lock, not race the save side"
        );
        drop(guard);
        rx.recv_timeout(std::time::Duration::from_secs(5))
            .expect("delete must complete once the lock is released")
            .expect("delete");
        deleter.join().expect("deleter thread");
        assert!(!dir.0.join(&rel).exists(), "file deleted after the wait");
    }

    #[test]
    fn thumb_path_is_derived_from_the_photo_path() {
        let hash = "a".repeat(64);
        assert_eq!(
            thumb_rel_path(&format!("photos/2026/10/{hash}.jpg")).expect("derive"),
            format!("photos/2026/10/{hash}.thumb.jpg")
        );
        // A source path that is not a photo has no thumbnail.
        for bad in [
            format!("photos/2026/10/{hash}.thumb.jpg"),
            "photos/2026/10/short.jpg".to_string(),
            "../photos/2026/10/x.jpg".to_string(),
        ] {
            assert!(
                thumb_rel_path(&bad).is_err(),
                "{bad:?} must not derive a thumbnail"
            );
        }
    }

    #[test]
    fn thumb_shaped_paths_are_rejected_as_photo_paths() {
        // The frontend can only ever name a SOURCE photo, so a thumb file is
        // unreachable directly: two dots in the extension fails the grammar.
        let dir = TempDir::new();
        let hash = "b".repeat(64);
        let thumb_shaped = format!("photos/2026/10/{hash}.thumb.jpg");
        assert!(read_photo(&dir.0, &thumb_shaped).is_err());
        assert!(delete_photo(&dir.0, &thumb_shaped).is_err());
        assert!(read_thumb(&dir.0, &thumb_shaped).is_err());
    }

    #[test]
    fn thumb_save_read_delete_roundtrip_and_sibling_cleanup() {
        let dir = TempDir::new();
        let rel = save_photo(&dir.0, "2026/10", b"photo bytes", "jpg").expect("save");
        // No thumbnail yet: the frontend generates one on demand.
        assert!(
            read_thumb(&dir.0, &rel).is_err(),
            "no thumb before saving one"
        );

        let thumb = save_thumb(&dir.0, &rel, b"thumb bytes").expect("save thumb");
        assert!(thumb.ends_with(".thumb.jpg"), "unexpected thumb: {thumb}");
        assert_eq!(
            read_thumb(&dir.0, &rel).expect("read thumb"),
            b"thumb bytes"
        );
        // Re-saving replaces it in place rather than creating a second file.
        assert_eq!(
            save_thumb(&dir.0, &rel, b"new thumb").expect("resave"),
            thumb
        );
        assert_eq!(read_thumb(&dir.0, &rel).expect("read again"), b"new thumb");

        // Deleting the photo takes its thumbnail with it.
        delete_photo(&dir.0, &rel).expect("delete");
        assert!(!dir.0.join(&rel).exists(), "photo file gone");
        assert!(!dir.0.join(&thumb).exists(), "thumb file gone");
        assert!(read_thumb(&dir.0, &rel).is_err());
        // Idempotent: deleting an already-deleted photo still succeeds.
        delete_photo(&dir.0, &rel).expect("second delete is a no-op");
    }

    #[test]
    fn thumb_save_requires_a_valid_source_path() {
        let dir = TempDir::new();
        for bad in [
            "photos/2026/13/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg",
            "photos/2026/10/../evil.jpg",
            "not-a-photo.jpg",
        ] {
            assert!(
                save_thumb(&dir.0, bad, b"x").is_err(),
                "{bad:?} must not accept a thumbnail write"
            );
        }
    }

    #[test]
    fn path_traversal_rejected_on_read_and_delete() {
        let dir = TempDir::new();
        let evil = [
            "../secret.jpg",
            "photos/../../secret.jpg",
            "photos/2026/10/../../../windows/system32/config",
            "photos/2026/10",
            "photos/2026/10/",
            "photos/2026/10/notahexhash.jpg",
            "photos/2026/10/../../../../etc/passwd",
            "photos/9999/99/0000000000000000000000000000000000000000000000000000000000000000.jpg",
            "C:/Windows/win.ini",
            "photos\\2026\\10\\deadbeef.jpg",
        ];
        for path in evil {
            assert!(
                read_photo(&dir.0, path).is_err(),
                "read of {path:?} must be rejected"
            );
            assert!(
                delete_photo(&dir.0, path).is_err(),
                "delete of {path:?} must be rejected"
            );
        }
    }
}
