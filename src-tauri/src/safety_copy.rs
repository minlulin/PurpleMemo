//! The pre-import safety copy.
//!
//! Importing a backup deletes every row in every table and unlinks the photo
//! files the incoming archive does not contain. That was the only destructive
//! action in the app with no automatic copy behind it: one confirmed click, and
//! the previous data existed nowhere.
//!
//! The copy is a *file* copy, not a backup archive. Two reasons:
//!
//! * The database file is SQLCipher-encrypted already, so copying it leaks
//!   nothing — building a plaintext zip of the same rows would write the user's
//!   notes to disk in the clear, which is the opposite of what the at-rest
//!   encryption is for.
//! * It needs no password, no key, and no serialization of the schema: it is
//!   the exact bytes the app was running from.
//!
//! The WAL is checkpointed and the database file is copied as one step under
//! the connection lock, so no command can write between the
//! flush and the copy — the copied file cannot be torn. The photo tree is
//! copied after the lock is released, because it is large and no command
//! writes into it mid-import. Photos are copied as a tree because the import
//! unlinks the ones it does not re-create.
//!
//! Restoring one is a manual operation (stop the app, replace the database and
//! `photos/` in app-data): restoring in-app would itself need a pre-restore
//! copy, and a half-implemented version of that is worse than a documented
//! file copy. `README.txt` is written into the copy so the folder explains
//! itself.

use std::fs;
use std::path::{Path, PathBuf};

/// Folder under the app-data dir holding every safety copy. `pub(crate)`
/// because factory reset removes the whole tree as one component —
/// the name must not be able to drift from the folder this module writes.
pub(crate) const SAFETY_DIR: &str = "backups";

/// Folder the photo library lives in, relative to app-data. `pub(crate)` for
/// the same factory-reset reason as [`SAFETY_DIR`].
pub(crate) const PHOTOS_DIR: &str = "photos";

/// Where the copies live.
pub fn safety_root(data_dir: &Path) -> PathBuf {
    data_dir.join(SAFETY_DIR)
}

/// Turn a caller-supplied label into one safe path component.
///
/// The renderer only ever passes a timestamp, but this is the one place a
/// renderer string reaches a path, so it is whitelisted rather than trusted:
/// everything outside `[A-Za-z0-9._-]` becomes `-`, leading/trailing dots and
/// dashes are trimmed (so the result can never be `.`/`..` or a hidden name),
/// and an empty result falls back to `pre-import`.
pub fn folder_name(label: &str) -> String {
    let cleaned: String = label
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(['-', '.']).to_string();
    if trimmed.is_empty() {
        "pre-import".to_string()
    } else {
        format!("pre-import-{trimmed}")
    }
}

/// Step 1 of the safety copy: create the destination folder and copy the
/// database file into it.
///
/// The caller (commands::backup_safety_copy) runs this while holding the
/// connection lock with the WAL already checkpointed, so the flush and the
/// copy are one locked step: no other command can write to the database
/// file mid-copy.
///
/// Refuses when there is no database to copy — a "safety copy" that silently
/// copied nothing would be worse than the error, because the caller's whole
/// reason for calling is that it is about to destroy the original.
pub fn copy_database_for_import(data_dir: &Path, label: &str) -> Result<PathBuf, String> {
    let db_path = data_dir.join(crate::db::DB_FILE_NAME);
    if !db_path.is_file() {
        return Err(format!(
            "no database at {} to copy — import cancelled",
            db_path.display()
        ));
    }
    let dest = unique_dir(&safety_root(data_dir).join(folder_name(label)))?;
    let db_name = db_path
        .file_name()
        .ok_or_else(|| "database file has no name".to_string())?;
    fs::copy(&db_path, dest.join(db_name))
        .map_err(|e| format!("copy {}: {e}", db_path.display()))?;
    Ok(dest)
}

/// Step 2 of the safety copy: the photo tree and the self-explaining
/// README.txt, into the folder step 1 created.
///
/// Runs OUTSIDE the connection lock: the tree can be ~110 MiB,
/// and holding the database mutex across it would stall every DB command for
/// the duration of the copy. Nothing in this step touches the database file.
pub fn copy_photos_for_import(data_dir: &Path, dest: &Path) -> Result<(), String> {
    let photos = data_dir.join(PHOTOS_DIR);
    if photos.is_dir() {
        copy_tree(&photos, &dest.join(PHOTOS_DIR))?;
    }
    write_readme(dest)?;
    Ok(())
}

/// Create `base`, or the first free `base-2`, `base-3`, … so a second import in
/// the same minute never overwrites the first copy.
fn unique_dir(base: &Path) -> Result<PathBuf, String> {
    let parent = base
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", base.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    let name = base
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("invalid safety-copy name {}", base.display()))?
        .to_string();
    for attempt in 1..100 {
        let candidate = if attempt == 1 {
            base.to_path_buf()
        } else {
            parent.join(format!("{name}-{attempt}"))
        };
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("create {}: {e}", candidate.display())),
        }
    }
    Err(format!("could not find a free name for {name}"))
}

/// Recursive copy. Symlinks are skipped — not followed and not copied — so a
/// copy can never pull in bytes from outside the photo tree.
fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| format!("create {}: {e}", to.display()))?;
    let entries = fs::read_dir(from).map_err(|e| format!("read {}: {e}", from.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("read {}: {e}", from.display()))?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|e| format!("stat {}: {e}", source.display()))?;
        if file_type.is_dir() {
            copy_tree(&source, &target)?;
        } else if file_type.is_file() {
            fs::copy(&source, &target).map_err(|e| format!("copy {}: {e}", source.display()))?;
        } else if file_type.is_symlink() {
            // Skipped entirely — not followed, not copied: a symlinked photo
            // directory is not something this app creates, and following it
            // would copy arbitrary files.
            continue;
        }
    }
    Ok(())
}

/// A note in the copy itself, so the folder is self-explanatory months later.
fn write_readme(dest: &Path) -> Result<(), String> {
    let text = "Purple Memo pre-import safety copy\n\
                \n\
                Written automatically before a backup import replaced the app's data.\n\
                It contains:\n\
                \n\
                * the SQLCipher database file, exactly as it was — encrypted with your\n\
                  database key, which is NOT in this folder;\n\
                * photos/ — the photo library, including files the import would have\n\
                  unlinked.\n\
                \n\
                To restore it by hand: quit Purple Memo, then replace the database file\n\
                and the photos/ folder in the app-data directory with the ones here.\n\
                Keep this folder's copies until the import has been checked.\n";
    fs::write(dest.join("README.txt"), text)
        .map_err(|e| format!("write {}: {e}", dest.join("README.txt").display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let base = std::env::temp_dir().join(format!(
                "purple-memo-safety-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            fs::create_dir_all(&base).expect("temp dir");
            Self(base)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn seed_app_data(root: &Path) -> PathBuf {
        let data = root.join("app-data");
        fs::create_dir_all(data.join("photos/2026/10")).expect("photos dir");
        fs::write(data.join(crate::db::DB_FILE_NAME), b"encrypted-bytes").expect("db");
        fs::write(data.join("photos/2026/10/abc.jpg"), b"photo-bytes").expect("photo");
        data
    }

    /// Both steps in sequence, as `backup_safety_copy` runs them (the lock it
    /// holds around step 1 has no meaning at this level).
    fn copy_all(data_dir: &Path, label: &str) -> Result<PathBuf, String> {
        let dest = copy_database_for_import(data_dir, label)?;
        copy_photos_for_import(data_dir, &dest)?;
        Ok(dest)
    }

    #[test]
    fn a_copy_holds_the_database_and_every_photo() {
        let root = TempDir::new("copy");
        let data = seed_app_data(&root.0);
        let dest = copy_all(&data, "2026-10-20T14-05").expect("copy");

        assert_eq!(
            fs::read(dest.join(crate::db::DB_FILE_NAME)).expect("db copy"),
            b"encrypted-bytes"
        );
        assert_eq!(
            fs::read(dest.join("photos/2026/10/abc.jpg")).expect("photo copy"),
            b"photo-bytes"
        );
        assert!(
            dest.join("README.txt").is_file(),
            "the copy explains itself"
        );
    }

    #[test]
    fn a_copy_never_overwrites_an_earlier_one() {
        // Two imports inside the same minute get the same label; the second
        // must not replace the copy of the data the first one destroyed.
        let root = TempDir::new("twice");
        let data = seed_app_data(&root.0);
        let first = copy_all(&data, "same").expect("first copy");
        fs::write(data.join(crate::db::DB_FILE_NAME), b"after-first").expect("db");
        let second = copy_all(&data, "same").expect("second copy");
        assert_ne!(first, second);
        assert_eq!(
            fs::read(first.join(crate::db::DB_FILE_NAME)).expect("first db"),
            b"encrypted-bytes"
        );
        assert_eq!(
            fs::read(second.join(crate::db::DB_FILE_NAME)).expect("second db"),
            b"after-first"
        );
    }

    #[test]
    fn a_missing_database_is_an_error_not_an_empty_copy() {
        let root = TempDir::new("missing");
        let data = root.0.join("app-data");
        fs::create_dir_all(&data).expect("data dir");
        let error = copy_database_for_import(&data, "x").expect_err("must refuse");
        assert!(error.contains("import cancelled"), "unexpected: {error}");
    }

    #[test]
    fn the_checkpoint_and_database_copy_are_one_locked_step() {
        // The caller must checkpoint AND copy the database file
        // inside the same `lock_conn` scope, with the photo tree copying
        // after it. A source pin keeps the two from drifting apart.
        let src = include_str!("commands.rs");
        let start = src
            .find("pub async fn backup_safety_copy")
            .expect("backup_safety_copy is the caller");
        let end = src
            .find("pub async fn export_save_file")
            .expect("the next command bounds the body");
        let body = &src[start..end];
        let lock = body
            .find("lock_conn")
            .expect("the copy runs under the connection lock");
        let checkpoint = body
            .find("wal_checkpoint")
            .expect("the WAL is flushed first");
        let db_copy = body
            .find("copy_database_for_import")
            .expect("the database copy is part of the locked step");
        let photos_copy = body
            .find("copy_photos_for_import")
            .expect("the photo tree copies too");
        assert!(
            lock < checkpoint && checkpoint < db_copy,
            "lock < checkpoint < database copy: {lock} {checkpoint} {db_copy}"
        );
        // The database copy must sit inside the `let dest = { … };` lock
        // scope, and the photo copy after that scope releases the guard.
        let block = body
            .find("let dest = {")
            .expect("the locked step is one block");
        let block_end = body[db_copy..]
            .find("};")
            .map(|i| i + db_copy)
            .expect("the locked block closes");
        assert!(
            block < db_copy && db_copy < block_end && block_end < photos_copy,
            "database copy inside the lock, photo copy after it: {block} {db_copy} {block_end} {photos_copy}"
        );
    }

    #[test]
    fn a_label_can_never_escape_the_backups_folder() {
        // The label is the only renderer-supplied fragment in a path.
        for label in ["../../etc/passwd", "..", ".", "", "C:\\Windows\\x"] {
            let name = folder_name(label);
            assert!(!name.contains('/'), "{label} -> {name}");
            assert!(!name.contains('\\'), "{label} -> {name}");
            assert!(!name.starts_with('.'), "{label} -> {name}");
            assert_eq!(
                Path::new(&name).components().count(),
                1,
                "{label} -> {name}"
            );
        }
        assert_eq!(
            folder_name("2026-10-20T14-05"),
            "pre-import-2026-10-20T14-05"
        );
        assert_eq!(folder_name(""), "pre-import");
    }
}
