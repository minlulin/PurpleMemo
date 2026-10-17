//! Writing the backup archive to the file the user picked (§8, review P1-1).
//!
//! This exists because the frontend cannot write it. The native save dialog
//! is granted (`dialog:default`) and returns a path, but the *write* used to go
//! through `@tauri-apps/plugin-fs`, whose `fs:write-files` permission set covers
//! every write command on every path and ships with **no** accessible-path
//! scope — the capability had no `allow` entries and `tauri.conf.json` declared
//! no `plugins.fs.scope`, so every `writeFile` call failed with `PathForbidden`.
//! Backup export was therefore broken for every user on every platform, and
//! the webview held a permission broad enough to overwrite any file the process
//! could write.
//!
//! Moving the write here fixes both at once: no fs permission is granted at
//! all, and the bytes never need a JS-side filesystem API. This follows the
//! `db_key_save` precedent — the dialog constrains the destination, and Rust
//! performs the write.
//!
//! The write is atomic (§8, review P3-14): bytes go to a temp sibling in the
//! same directory and are renamed into place, so a full disk or a crash
//! mid-write can never leave a truncated zip where a valid backup used to be.

use std::fs;
use std::path::Path;

/// Request header carrying the destination path on a raw `backup_save_file`
/// body. A raw body IS the whole request, so the path — which has no other
/// channel — travels here. Headers must be visible ASCII and a user-chosen
/// path need not be (`C:\Users\小明\backup.zip`), so the value is
/// percent-encoded; [`decode_header_path`] is the only decoder.
pub const BACKUP_PATH_HEADER: &str = "x-backup-path";

/// Suffix for the temp sibling. It cannot collide with a backup file the user
/// would name (`<chosen>.zip.purple-memo-tmp` is not a shape the save dialog
/// offers), and it lives in the destination's own directory so the rename
/// stays on one filesystem.
const TEMP_SUFFIX: &str = ".purple-memo-tmp";

/// Write `bytes` to the user-chosen `path`.
///
/// Refuses an empty payload and a destination that is an existing directory —
/// both are signs the caller lost track of what it was saving, and turning
/// them into a written file would be worse than an error. Otherwise the write
/// is atomic (see the module docs).
pub fn save_backup_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() {
        return Err("refusing to write an empty backup archive".to_string());
    }
    if path.is_dir() {
        return Err(format!(
            "{} is a directory — pick a file name for the backup",
            path.display()
        ));
    }
    let parent = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => return Err(format!("{} has no directory to write into", path.display())),
    };
    fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return Err(format!("invalid destination {}", path.display()));
    };
    let tmp_path = parent.join(format!("{file_name}{TEMP_SUFFIX}"));
    fs::write(&tmp_path, bytes).map_err(|e| format!("write {}: {e}", tmp_path.display()))?;
    if let Err(first) = fs::rename(&tmp_path, path) {
        // `rename` replaces an existing file on every platform this app ships
        // to (Windows uses `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`), so
        // this arm means something unusual refused — an exFAT/network volume,
        // or an antivirus holding the destination open. Overwriting an existing
        // backup is the normal case here, so try once more without the
        // destination in the way.
        if !path.exists() {
            let _ = fs::remove_file(&tmp_path);
            return Err(format!(
                "rename {} -> {}: {first}",
                tmp_path.display(),
                path.display()
            ));
        }
        fs::remove_file(path).map_err(|e| format!("replace {}: {e}", path.display()))?;
        if let Err(second) = fs::rename(&tmp_path, path) {
            // The temp file is deliberately left behind: it holds the bytes
            // that could not be renamed, and deleting it would destroy a backup
            // the user asked to keep.
            return Err(format!(
                "could not write {} ({}); the archive is still at {}",
                path.display(),
                second,
                tmp_path.display()
            ));
        }
    }
    Ok(())
}

/// Decode a [`BACKUP_PATH_HEADER`] value back into the path it stands for.
///
/// Unambiguous by construction: `%` is itself encoded on the way in, so a
/// literal `%20` in a file name arrives as `%2520` and cannot be mistaken for a
/// space. Every other byte — spaces, backslashes, multi-byte UTF-8 — passes
/// through untouched.
pub fn decode_header_path(encoded: &str) -> Result<String, String> {
    let bytes = encoded.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let pair = bytes
                .get(index + 1..index + 3)
                .ok_or_else(|| format!("truncated percent escape in {encoded:?}"))?;
            let high = hex_value(pair[0])?;
            let low = hex_value(pair[1])?;
            out.push(high << 4 | low);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).map_err(|_| format!("{encoded:?} does not decode to a valid path"))
}

fn hex_value(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(format!("{byte:?} is not a hex digit in a percent escape")),
    }
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
        /// One directory per test: `cargo test` runs these in parallel threads
        /// in one process, so a shared name would have them clobbering (and
        /// deleting) each other's files.
        fn new(label: &str) -> Self {
            let n = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!(
                "purple-memo-p1-backup-file-{}-{label}-{n}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// The encoder lives in `driver.ts`; these are the strings it produces for
    /// the paths that actually occur. `ipc.test.ts` pins the header NAME and
    /// the encoder itself, so a drift on either side fails the gate.
    fn encoded(path: &str) -> String {
        let mut out = String::new();
        for byte in path.as_bytes() {
            if (0x20..=0x7e).contains(byte) && *byte != b'%' {
                out.push(*byte as char);
            } else {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
        out
    }

    #[test]
    fn header_paths_round_trip() {
        for path in [
            r"C:\Users\purple\backups\backup.zip",
            r"C:\Program Files\Purple Memo\a b.zip",
            r"/home/purple/backups/backup.zip",
            r"C:\Users\小明\备份\purple-memo-backup.zip",
            r"C:\Users\p\100%-done.zip",
            r"C:\Users\p\a+b&c=d.zip",
            r"C:\emoji-🙂\backup.zip",
        ] {
            let encoded = encoded(path);
            assert!(
                encoded.is_ascii(),
                "header value must be ASCII: {encoded:?}"
            );
            assert_eq!(decode_header_path(&encoded).expect("decode"), path);
        }
    }

    #[test]
    fn an_unencoded_path_survives_untouched() {
        assert_eq!(
            decode_header_path(r"C:\backups\backup.zip").expect("decode"),
            r"C:\backups\backup.zip"
        );
    }

    #[test]
    fn malformed_percent_escapes_are_refused() {
        for bad in ["C:\\a%2", "C:\\a%", "%", "%zz", "%2z"] {
            assert!(decode_header_path(bad).is_err(), "{bad:?} must not decode");
        }
    }

    #[test]
    fn bytes_that_are_not_a_path_are_refused() {
        // A lone `%FF` is not valid UTF-8, so it cannot name a file.
        assert!(decode_header_path("%FF").is_err());
    }

    #[test]
    fn a_backup_is_written_where_the_user_asked() {
        let dir = TempDir::new("asked");
        let out = dir.path("purple-memo-backup.zip");
        save_backup_file(&out, b"PK\x03\x04 archive bytes").expect("save");
        assert_eq!(
            fs::read(&out).expect("read back"),
            b"PK\x03\x04 archive bytes"
        );
        assert!(
            !dir.path(&format!("purple-memo-backup.zip{TEMP_SUFFIX}"))
                .exists(),
            "the temp sibling must not survive a successful write"
        );
    }

    #[test]
    fn re_exporting_over_an_existing_backup_replaces_it() {
        let dir = TempDir::new("replace");
        let out = dir.path("backup.zip");
        save_backup_file(&out, b"old archive").expect("first save");
        save_backup_file(&out, b"new archive").expect("second save");
        assert_eq!(fs::read(&out).expect("read back"), b"new archive");
    }

    #[test]
    fn a_failed_save_never_leaves_a_partial_archive() {
        let dir = TempDir::new("failed");
        // A directory cannot be replaced by a file, so the rename fails. The
        // bytes that were already written must not be left under the name the
        // user is looking at.
        let out = dir.path("backup.zip");
        fs::create_dir_all(dir.path("backup.zip")).expect("make dir");
        assert!(save_backup_file(&out, b"archive").is_err());
        assert!(out.is_dir(), "the destination is untouched");
    }

    #[test]
    fn an_empty_archive_and_a_directory_destination_are_refused() {
        let dir = TempDir::new("refused");
        assert!(
            save_backup_file(&dir.path("empty.zip"), b"").is_err(),
            "an empty archive is never a backup"
        );
        assert!(
            save_backup_file(&dir.0, b"archive").is_err(),
            "a directory is not a backup destination"
        );
    }

    #[test]
    fn an_unwritable_directory_is_reported_with_its_path() {
        let dir = TempDir::new("newdir");
        let missing = dir.path("no-such-dir/nested/backup.zip");
        // `create_dir_all` makes the parent, so this succeeds — which is the
        // point: the save dialog can hand back a path in a folder the user is
        // creating, and it must not fail for that reason.
        save_backup_file(&missing, b"archive").expect("save into a new folder");
        assert!(missing.exists());
    }
}
