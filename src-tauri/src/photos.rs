//! Photo storage (§4): bytes are hashed (sha256) and stored content-addressed
//! at `photos/<yyyy>/<mm>/<sha256-hex>.<ext>` under the app data dir; the DB
//! keeps the relative path. Reads/deletes guard against path traversal with a
//! strict grammar — the only accepted shape is
//! `photos/<4 digits>/<2 digits>/<64 hex>.<1-8 lowercase alnum>`.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use sha2::{Digest, Sha256};

/// Save photo bytes; returns the relative path to store in the DB.
///
/// Content-addressed: identical bytes always map to the same path, so a
/// duplicate save is a no-op write.
pub fn save_photo(
    data_dir: &Path,
    year_month: &str,
    bytes: &[u8],
    ext: &str,
) -> Result<String, String> {
    let ext = ext.to_ascii_lowercase();
    if !is_valid_ext(&ext) {
        return Err(format!(
            "invalid photo extension {ext:?}: 1-8 lowercase letters/digits expected"
        ));
    }
    let (year, month) = parse_year_month(year_month)?;
    let digest = Sha256::digest(bytes);
    let hash: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    let rel_path = format!("photos/{year}/{month}/{hash}.{ext}");
    let abs_path = data_dir.join(&rel_path);
    if let Some(parent) = abs_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    if !abs_path.exists() {
        fs::write(&abs_path, bytes).map_err(|e| format!("write {}: {e}", abs_path.display()))?;
    }
    Ok(rel_path)
}

/// Read photo bytes by relative path (traversal-guarded).
pub fn read_photo(data_dir: &Path, rel_path: &str) -> Result<Vec<u8>, String> {
    validate_rel_path(rel_path)?;
    fs::read(data_dir.join(rel_path)).map_err(|e| format!("read {rel_path}: {e}"))
}

/// Delete a photo file by relative path (traversal-guarded, idempotent).
pub fn delete_photo(data_dir: &Path, rel_path: &str) -> Result<(), String> {
    validate_rel_path(rel_path)?;
    match fs::remove_file(data_dir.join(rel_path)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete {rel_path}: {e}")),
    }
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
