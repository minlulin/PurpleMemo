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
//! Two guarantees the copy gives its caller, both (E7/E8):
//!
//! * **Durable before it returns.** Every file written here is synced to the
//!   device, so `Ok` means *survives a crash*, not *handed to the OS* — the
//!   import's destructive phase must not start on a copy that a power cut
//!   could dissolve.
//! * **One symlink policy at every level.** The photo root is inspected
//!   without following, and a link anywhere in the tree refuses the copy
//!   outright. A link is never followed into (external bytes would poison
//!   the copy) and never silently skipped (a skipped descendant is a photo
//!   the import would delete without an undo). Factory reset likewise
//!   removes links without following them — see `reset.rs`.
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
/// file mid-copy. The copied file is then synced to the device (E7) before
/// this returns — the caller treats `Ok` as "the undo copy exists", and the
/// destructive phase must not start on bytes the OS has merely accepted.
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
    let copied = dest.join(db_name);
    fs::copy(&db_path, &copied).map_err(|e| format!("copy {}: {e}", db_path.display()))?;
    sync_file(&copied)?;
    Ok(dest)
}

/// Step 2 of the safety copy: the photo tree and the self-explaining
/// README.txt, into the folder step 1 created.
///
/// Runs OUTSIDE the connection lock: the tree can be ~110 MiB,
/// and holding the database mutex across it would stall every DB command for
/// the duration of the copy. Nothing in this step touches the database file.
///
/// The photo root is inspected with `symlink_metadata` first (E8): a linked
/// root is refused outright rather than followed out of the app-data dir —
/// a copy that walked into an external tree would either smuggle foreign
/// files into the undo copy or, worse, be trusted as complete when it was not.
pub fn copy_photos_for_import(data_dir: &Path, dest: &Path) -> Result<(), String> {
    let photos = data_dir.join(PHOTOS_DIR);
    match fs::symlink_metadata(&photos) {
        Ok(meta) => {
            if is_link_like(meta.file_type(), &meta) {
                return Err(link_refusal(&photos));
            }
            if meta.is_dir() {
                copy_tree(&photos, &dest.join(PHOTOS_DIR))?;
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("could not inspect {}: {e}", photos.display())),
    }
    write_readme(dest)?;
    Ok(())
}

/// Flush one copied file's bytes down to the device (E7).
///
/// `fs::copy` only hands bytes to the OS: without this, "the safety copy
/// succeeded" means *handed over*, not *survives a crash*, and the import's
/// destructive phase would not be gated on a durable copy. Opened read-write
/// because `sync_all` needs write access on Windows (`FlushFileBuffers`
/// refuses a read-only handle), while `fsync` would not. Directory entries
/// themselves are covered by the filesystems the app ships on — NTFS, APFS
/// and ext4 all journal link metadata — once the file's data is flushed;
/// this is the same protocol `file_write` already uses for exports, and a
/// failure here cancels the import like any other copy failure.
fn sync_file(path: impl AsRef<Path>) -> Result<(), String> {
    let path = path.as_ref();
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .and_then(|file| file.sync_all())
        .map_err(|e| format!("could not flush {}: {e}", path.display()))
}

/// True for any entry that is not a plain file or a plain directory (E8): a
/// symlink on every platform, and on Windows any other reparse point —
/// notably directory junctions, which Rust's `FileType::is_symlink` does NOT
/// report (they are `IO_REPARSE_TAG_MOUNT_POINT`) but which enumerate with
/// the directory attribute, so a walk that trusted `is_dir()` alone would
/// follow one straight out of the app-data dir.
fn is_link_like(file_type: fs::FileType, meta: &fs::Metadata) -> bool {
    if file_type.is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        let _ = meta;
        false
    }
}

/// The one refusal both link checks return (E8) — one policy, one wording,
/// always fail-closed before the destructive phase.
fn link_refusal(path: &Path) -> String {
    format!(
        "{} is a link (symlink or junction) — the safety copy refuses to \
         follow links out of the photo tree, because a copy built on them \
         cannot be trusted to hold the original. Replace the link with a \
         real folder and try again — import cancelled before anything was \
         replaced",
        path.display()
    )
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

/// Recursive copy under the one symlink policy (E8): a link at ANY level
/// refuses the copy instead of being silently skipped — a skipped descendant
/// is a photo the live library could read but the undo copy would not hold,
/// and the import is about to delete the original. Anything that is not a
/// plain file or directory refuses too, so a special file is never copied by
/// accident. Every file that IS copied is flushed before the walk returns
/// (E7).
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
        // Link check BEFORE the directory branch: a Windows junction carries
        // the directory attribute, so `is_dir()` alone would walk into it.
        let meta = entry
            .metadata()
            .map_err(|e| format!("stat {}: {e}", source.display()))?;
        if is_link_like(file_type, &meta) {
            return Err(link_refusal(&source));
        }
        if file_type.is_dir() {
            copy_tree(&source, &target)?;
        } else if file_type.is_file() {
            fs::copy(&source, &target).map_err(|e| format!("copy {}: {e}", source.display()))?;
            sync_file(target)?;
        } else {
            // Not a link, not a plain file — a fifo, device, or other special
            // entry. Refuse rather than silently omit it: the import this
            // copy exists for is about to delete the original tree.
            return Err(format!(
                "{} is not a regular file — the safety copy only copies plain \
                 files and directories; import cancelled before anything was \
                 replaced",
                source.display()
            ));
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
        .map_err(|e| format!("write {}: {e}", dest.join("README.txt").display()))?;
    sync_file(dest.join("README.txt"))?;
    Ok(())
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

    // -- E7: the copy is durable before it reports success ----------------

    #[test]
    fn a_file_that_cannot_be_flushed_is_an_error_naming_it() {
        // The flush is part of the copy's contract: if it cannot happen, the
        // caller must learn about it — a silently unflushed "successful"
        // copy is exactly the E7 gap.
        let root = TempDir::new("sync-fail");
        let missing = root.0.join("never-written.bin");
        let error = sync_file(missing).expect_err("no file, no flush");
        assert!(
            error.contains("could not flush"),
            "names the operation: {error}"
        );
    }

    #[test]
    fn every_writer_in_the_copy_flushes_what_it_wrote() {
        // E7 source pin: all three writers — database file, photo tree,
        // README — must sync their output, so `Ok` from any of them means
        // *durable*, not *handed to the OS*.
        let src = include_str!("safety_copy.rs");
        for (function, call) in [
            ("copy_database_for_import", "sync_file(&copied)"),
            ("copy_tree", "sync_file(target)"),
            ("write_readme", "sync_file(dest.join(\"README.txt\"))"),
        ] {
            let marker = format!("fn {function}(");
            let start = src.find(&marker).expect("the writer exists");
            let rest = &src[start..];
            // rustfmt closes every function at column 0, so the first `\n}`
            // ends this one; inner blocks are indented.
            let end = rest.find("\n}").map(|i| i + 2).unwrap_or(rest.len());
            assert!(
                rest[..end].contains(call),
                "{function} must flush the file it wrote (E7): missing {call}"
            );
        }
    }

    // -- E8: one symlink policy at every level ----------------------------

    /// Plant a link without privileges: a real symlink on unix, a directory
    /// junction on Windows (`mklink /J` needs none) — and a junction is
    /// precisely the entry Rust's `is_symlink()` does not report while it
    /// still enumerates as a directory, which is what the policy check must
    /// catch.
    fn plant_link(link: &Path, target: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).expect("create the symlink");
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd")
                .arg("/C")
                .arg("mklink")
                .arg("/J")
                .arg(link)
                .arg(target)
                .status()
                .expect("run mklink");
            assert!(status.success(), "mklink /J must create the junction");
        }
    }

    #[test]
    fn a_linked_photos_root_refuses_the_copy_instead_of_following_it() {
        // E8: a linked root used to be followed (`is_dir` traverses it), so
        // the undo copy could pull in an external tree — or, once reset
        // removed only the link, leave the originals outside app-data while
        // the app believed they were gone. Refuse before the destructive
        // phase instead.
        let root = TempDir::new("linked-root");
        let data = seed_app_data(&root.0);
        let outside = root.0.join("outside");
        fs::create_dir_all(&outside).expect("outside dir");
        fs::write(outside.join("secret.jpg"), b"external").expect("external photo");
        let photos = data.join(PHOTOS_DIR);
        fs::remove_dir_all(&photos).expect("clear the real photos dir");
        plant_link(&photos, &outside);

        let dest = copy_database_for_import(&data, "2026-10-20").expect("db step");
        let error =
            copy_photos_for_import(&data, &dest).expect_err("a linked root must refuse the copy");
        assert!(error.contains("link"), "names the policy: {error}");
        assert!(
            error.contains("import cancelled"),
            "fail-closed, and says so: {error}"
        );
        assert!(
            !dest.join(PHOTOS_DIR).join("secret.jpg").exists(),
            "nothing outside the photo tree may be copied"
        );
        assert!(
            outside.join("secret.jpg").exists(),
            "the external target is never touched"
        );
    }

    #[test]
    fn a_link_inside_the_photo_tree_refuses_the_copy_too() {
        // The same policy one level down (E8): the old walk silently
        // SKIPPED links, which meant a photo the live library could read
        // would be missing from the very copy that justifies deleting it.
        let root = TempDir::new("linked-inner");
        let data = seed_app_data(&root.0);
        let outside = root.0.join("outside");
        fs::create_dir_all(&outside).expect("outside dir");
        fs::write(outside.join("secret.jpg"), b"external").expect("external photo");
        // Built from components, not a literal with forward slashes: `cmd`
        // would parse `/2026` as a switch when mklink receives the path.
        let nested = data
            .join(PHOTOS_DIR)
            .join("2026")
            .join("10")
            .join("linked-dir");
        plant_link(&nested, &outside);

        let dest = copy_database_for_import(&data, "2026-10-20").expect("db step");
        let error =
            copy_photos_for_import(&data, &dest).expect_err("a nested link must refuse the copy");
        assert!(error.contains("link"), "names the policy: {error}");
        assert!(error.contains("import cancelled"), "{error}");
        assert!(
            !dest
                .join(PHOTOS_DIR)
                .join("2026/10/linked-dir/secret.jpg")
                .exists(),
            "the walk must stop before following anything out of the tree"
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
