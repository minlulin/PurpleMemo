//! Encrypted DB core: SQLCipher via rusqlite, keyring key,
//! one mutex-serialized connection, baseline schema.
//!
//! Connection model: a single SQLCipher connection behind a mutex —
//! every IPC call serializes through it; no pooling. Multi-statement writes
//! go through [`batch`] (committed as a single transaction); manual
//! [`begin_tx`]/[`commit_tx`]/[`rollback_tx`] exist only for short critical
//! sections and are never held across UI awaits.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use rusqlite::types::Value as SqlValue;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};

use crate::bytes_to_hex;
use crate::schema;

/// Database file name inside the app data dir.
pub const DB_FILE_NAME: &str = "purple-memo.db";

const KEYRING_SERVICE: &str = "com.minlulin.purplememo";
const KEYRING_ACCOUNT: &str = "db-encryption-key";
const KEY_HEX_LEN: usize = 64;

/// How long a write waits for a lock held elsewhere before giving up.
pub const BUSY_TIMEOUT_SECS: u64 = 5;

/// A JSON object keyed by column name — one result row.
pub type JsonObj = JsonMap<String, JsonValue>;

/// Shared state managed by Tauri: the single connection behind a mutex,
/// the manual-transaction flag, and the app data dir (photos root base).
///
/// The connection is an `Option` because factory reset takes it:
/// after the WAL checkpoint the connection is closed and dropped **before**
/// any database file is deleted, so the app never holds an open handle over a
/// file that is being removed. From that point on every DB command fails
/// closed with [`DB_CLOSED_MESSAGE`] instead of touching a deleted file — see
/// `commands::lock_conn` and [`close_connection_for_reset`].
pub struct AppState {
    pub conn: Mutex<Option<Connection>>,
    pub txn_open: AtomicBool,
    pub data_dir: PathBuf,
    /// D6: set once a factory-reset engine run finishes. From then on the
    /// session is terminal — the reset result screen — and closing the
    /// window must exit the process instead of hiding to tray, so the
    /// next launch is a genuine fresh start. Set on no other path, and a
    /// fresh boot constructs a fresh `AppState`, so a retried boot starts
    /// with it clear.
    pub reset_terminal: AtomicBool,
}

/// The error every DB command returns once the connection has been taken by
/// factory reset. It says what happened *and* what fixes it,
/// because after a reset the only way back is the restart into the first-run
/// boot path — the database file is gone, not merely unreachable.
pub const DB_CLOSED_MESSAGE: &str = "database is closed — restart the app";

/// One statement of a [`batch`] write.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchStatement {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<JsonValue>,
}

/// Outcome of a single write statement.
///
/// Serialized camelCase: Tauri sends command return values through serde
/// as-is (no renaming), and the JS driver (`src/data/driver.ts`) reads
/// `rowsAffected` / `lastInsertRowid` — this attribute is the IPC contract.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteOutcome {
    pub rows_affected: u64,
    pub last_insert_rowid: i64,
}

// ---------------------------------------------------------------------------
// Key management — mint-once into the OS credential store
// ---------------------------------------------------------------------------

/// Mint a fresh random 256-bit key as lowercase hex.
pub fn mint_key_hex() -> Result<String, String> {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).map_err(|e| format!("OS random source unavailable: {e}"))?;
    Ok(bytes_to_hex(&buf))
}

/// Validate a key read back from the credential store. Pure (no keyring
/// I/O) so it is unit-testable: the shape check is the whole contract.
pub fn validate_stored_key(key: &str) -> Result<String, String> {
    if is_key_hex(key) {
        Ok(key.to_string())
    } else {
        Err("stored DB encryption key is malformed".to_string())
    }
}

/// Read the DB key back out of the OS credential store for the Settings
/// key-export step. Read-only: unlike [`load_or_mint_db_key`]
/// it never mints — a missing entry is an error, not a fresh key.
pub fn read_db_key() -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("keyring entry unavailable: {e}"))?;
    match entry.get_password() {
        Ok(key) => validate_stored_key(&key),
        Err(keyring::Error::NoEntry) => Err("no DB encryption key stored".to_string()),
        Err(e) => Err(format!("failed to read DB key from credential store: {e}")),
    }
}

/// A DB key plus where it came from, so the caller knows whether it may still
/// remove it.
#[derive(Debug, Clone)]
pub struct DbKey {
    pub hex: String,
    /// True when this call minted and stored the key. If the database then
    /// fails to open, the caller MUST call [`discard_minted_key`] so a first
    /// run that never worked does not leave a key that can never open anything
    /// in the one slot the credential store has.
    pub freshly_minted: bool,
}

/// Why loading the DB key failed — with the one *recoverable* class kept
/// distinguishable by type, never by message text: when the
/// database file exists but the credential store holds no key, the boot-failure
/// dialog can offer the exported-key restore path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyLoadError {
    /// The database file exists and the OS credential store has no key. The
    /// user can recover by restoring an exported key file; nothing is ever
    /// minted over the existing database.
    MissingKeyForExistingDb(String),
    /// Everything else: keyring unavailable, stored key malformed, and so on.
    Other(String),
}

impl KeyLoadError {
    /// The user-facing message, whichever class this error is.
    pub fn message(&self) -> &str {
        match self {
            KeyLoadError::MissingKeyForExistingDb(message) | KeyLoadError::Other(message) => {
                message
            }
        }
    }

    /// True for the class the boot-failure dialog can recover from by
    /// importing an exported key file.
    pub fn is_missing_key_for_existing_db(&self) -> bool {
        matches!(self, KeyLoadError::MissingKeyForExistingDb(_))
    }
}

impl From<String> for KeyLoadError {
    fn from(message: String) -> Self {
        KeyLoadError::Other(message)
    }
}

/// Load the DB key from the OS credential store; mint and store one on first
/// run.
///
/// `db_path` decides what "first run" means. The credential store
/// alone cannot: if it has no entry, this used to mint a fresh 256-bit key,
/// **write it into the store**, and only then fail `open_encrypted_db`'s
/// verify. That left the user with an unopenable database *and* a wrong key
/// occupying the only slot, behind a message that blamed neither the real
/// cause nor the exported-key restore path.
///
/// So minting is allowed only when there is genuinely no database yet. With a
/// database present and no stored key we refuse with the typed
/// [`KeyLoadError::MissingKeyForExistingDb`] class, which the boot-failure
/// dialog turns into the restore offer.
pub fn load_or_mint_db_key(db_path: &Path) -> Result<DbKey, KeyLoadError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("keyring entry unavailable: {e}"))?;
    match entry.get_password() {
        Ok(key) => Ok(DbKey {
            hex: validate_stored_key(&key)?,
            freshly_minted: false,
        }),
        Err(keyring::Error::NoEntry) => {
            if db_file_exists(db_path) {
                return Err(KeyLoadError::MissingKeyForExistingDb(
                    missing_key_for_existing_db(db_path),
                ));
            }
            let key = mint_key_hex()?;
            store_db_key(&key)?;
            Ok(DbKey {
                hex: key,
                freshly_minted: true,
            })
        }
        Err(e) => Err(format!("failed to read DB key from credential store: {e}").into()),
    }
}

/// Write `key` into the OS credential store's single slot — the same slot
/// [`load_or_mint_db_key`] mints into on first run, and the slot the
/// exported-key restore path fills after a successful open.
pub fn store_db_key(key: &str) -> Result<(), String> {
    // Never store something that is not a key: the slot is one entry deep and
    // a malformed value would block every later run.
    validate_stored_key(key)?;
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("keyring entry unavailable: {e}"))?;
    entry
        .set_password(key)
        .map_err(|e| format!("failed to store DB key in credential store: {e}"))
}

/// Escape a filesystem path so it is safe to embed in ONE audit-log line
/// (E14).
///
/// On filesystems that allow them, a chosen filename can contain newlines or
/// other control characters; written verbatim, one key path would render as
/// several timestamped-looking lines and make the disclosure history
/// misleading to whoever reads it later. Backslash escapes make the record
/// unambiguous as well as unbreakable: a literal `\n` in a filename renders
/// as `\\n` and can never be confused with an escaped newline, at the cost of
/// showing Windows paths with doubled separators. The path itself is kept —
/// escaped, never truncated — and there is no parameter here through which
/// key material could be threaded.
fn escape_log_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for c in path.chars() {
        match c {
            // Backslash FIRST, for the reason in the doc above.
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c if c.is_control() => out.push_str(&format!("\\u{{{:x}}}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// The audit line for one key restore. Pure, and deliberately
/// takes the key nowhere — same structural property as
/// [`key_export_audit_line`]: the signature has no parameter through which key
/// material could be threaded. The path is escaped (E14) so one chosen file
/// can never split the line it is recorded on.
pub fn key_restore_audit_line(source: &str) -> String {
    format!("key restored from file: {}", escape_log_path(source))
}

/// Read a picked file's contents as an exported key candidate: trim the
/// export's trailing newline (and any surrounding whitespace), then require
/// strict 64-character hex. Pure over the contents so the validation step is
/// pinned without touching a database or a keyring.
pub fn parse_exported_key_file_contents(raw: &str) -> Result<String, String> {
    let key = raw.trim();
    if is_key_hex(key) {
        Ok(key.to_string())
    } else {
        Err("not an exported Purple Memo key file — expected 64 hex characters".to_string())
    }
}

/// Restore the DB key from an exported key file — the missing half of the
/// key-export path.
///
/// Order is the safety property: validate the candidate, re-check that a
/// nonempty database still exists at the target, prove it opens with the
/// NON-CREATING open ([`open_encrypted_db_existing`]; its `sqlite_master`
/// probe makes a wrong key fail safe and can never manufacture the file it
/// is evidence about), and only after a successful open let `store_key`
/// write it into the OS credential store, then record the audit line. A
/// wrong key, a malformed file, or a target that vanished while the dialog
/// was open therefore restores *nothing* — the store is untouched and the
/// mint guard is never involved; nothing is ever minted over an existing
/// database.
///
/// `store_key` is injected: the production caller writes to the real keyring
/// via [`store_db_key`]; tests supply a closure so no test ever touches one.
pub fn restore_db_key_from_file(
    db_path: &Path,
    key_file: &Path,
    store_key: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(), String> {
    let raw = std::fs::read_to_string(key_file)
        .map_err(|e| format!("could not read {}: {e}", key_file.display()))?;
    let key = parse_exported_key_file_contents(&raw)
        .map_err(|e| format!("{}: {e}", key_file.display()))?;
    // E11: the dialog can sit open while the target changes. A missing or
    // zero-length file must REFUSE here — a creating open would otherwise
    // initialize an empty database under the candidate key, the probe would
    // then "prove" a key that opens nothing, and the store would be written
    // with it. Recovery verifies an EXISTING database or nothing at all;
    // first-run creation belongs to `boot` alone.
    if !db_file_exists(db_path) {
        return Err(format!(
            "{} is no longer an existing database (it was moved, deleted, or replaced while this dialog was open) — check it and try again",
            db_path.display()
        ));
    }
    // Prove the key opens the database BEFORE anything is stored — with the
    // NON-CREATING open, so this proof can never manufacture the file it is
    // supposed to be evidence about. A wrong key fails here with the
    // credential store still empty.
    drop(open_encrypted_db_existing(db_path, &key)?);
    store_key(&key)?;
    // Only record a restore that actually happened — never the key itself.
    crate::note_key_restore(&key_file.display().to_string());
    Ok(())
}

/// Remove a key this process just minted, after the database refused it. Best
/// effort: a store that will not delete leaves the same situation the guard
/// above prevents on the next run (a database with no key), which at least
/// fails with an actionable message instead of silently re-keying anything.
///
/// The caller must first undo a database *this attempt created* — see
/// [`remove_abandoned_new_db`]: discarding the key while the freshly created
/// file stays would strand a database whose only key is gone (E9).
pub fn discard_minted_key() {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT) {
        let _ = entry.delete_credential();
    }
}

/// Undo a first run that failed after creating its database (E9).
///
/// Called only from the boot failure path, and only when
/// [`db_file_exists`] said no nonempty database existed before this attempt —
/// so every byte this removes was created by the attempt that is now failing.
/// Leaving the file behind would strand it: the freshly minted key is about
/// to be discarded, and a nonempty database with no key refuses every later
/// boot with a key-restore offer for a database the user never had.
///
/// The sidecars are removed first and the main file last, so a partial
/// failure can only mean "the main file is still there" — which is the safe
/// direction: the caller keeps the key when this returns `false` (never
/// discard a key whose database might survive), and the file/key pair stays
/// openable for the retry. Returns true only when all three files are
/// confirmed gone.
pub fn remove_abandoned_new_db(data_dir: &Path) -> bool {
    let paths = db_file_paths(data_dir);
    // `db_file_paths` is [main, wal, shm]; walk it backwards (shm, wal, main).
    for path in paths.iter().rev() {
        if let Err(e) = std::fs::remove_file(path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                return false;
            }
        }
    }
    paths.iter().all(|path| !path.exists())
}

/// The audit line for one key export. Pure, and deliberately takes the
/// key nowhere: the signature has no parameter through which key material could
/// be threaded, so this line *cannot* leak one however it is called. That is
/// the property the test pins, not a promise in a comment.
///
/// The clipboard route was removed rather than logged (a key left on the
/// system clipboard persists after the app closes and is readable by every
/// other program), so a file write is currently the only kind of disclosure —
/// which is why this takes a destination and nothing else.
pub fn key_export_audit_line(destination: &str) -> String {
    format!("key file written: {}", escape_log_path(destination))
}

/// The audit line for a key file that SURVIVED a failed rename (E10).
///
/// The temp holds the complete plaintext master key outside the credential
/// store — a disclosure that really happened, just not the one that was asked
/// for — so it gets its own line naming where the key now sits. Paths only,
/// escaped (E14); the signature has no channel for key material.
pub fn key_export_retained_audit_line(retained: &str, destination: &str) -> String {
    format!(
        "key file retained: {} (the write to {} failed)",
        escape_log_path(retained),
        escape_log_path(destination)
    )
}

/// Write the DB key to `path`, and record that it happened
///
/// The key is read from the credential store, used, and dropped inside this
/// function: it is never returned, so it never crosses into the webview. That is
/// the point of the command existing at all — the previous
/// `db_key_export` handed the plaintext key to the renderer on every call,
/// where it sat in React state and was also pushed onto the system clipboard,
/// which persists after the app closes and is readable by every other program
/// on the machine.
///
/// **Written atomically and without following a symlink** (review P3-5, P3-20).
/// The old form opened the destination with `truncate(true)`, which meant a
/// failure — or a symlink sitting at the path — destroyed whatever was already
/// there. The user picked this path, so the file is expected to be replaceable,
/// but "replaceable" is not "destroy the previous contents before the new ones
/// exist": a disk-full halfway through a write used to leave a truncated key file
/// that looks valid and opens nothing.
///
/// The bytes go to a randomised temp sibling in the same directory (so the
/// rename stays on one filesystem) and are renamed into place. The temp is
/// opened with `create_new` — `O_CREAT | O_EXCL`, atomic on every platform —
/// and on unix also `O_NOFOLLOW | 0o600`, so a symlink planted at a temp name
/// is refused rather than written through, and a collision is retried under a
/// fresh name instead of wedging the export. The final
/// rename replaces the target atomically; it is a rename, not a truncate, so
/// there is no window in which the path is missing or half-written.
pub fn save_db_key_file(path: &Path) -> Result<(), String> {
    // Destination shape first, so an invalid path reports the path rather than
    // a credential-store error.
    key_file_destination(path)?;
    let key = read_db_key()?;
    write_key_file(path, &key)
}

/// [`save_db_key_file`] with the key supplied by the caller.
///
/// The production entry point reads the key from the OS credential store, which
/// a test process cannot assume is populated — and that is why the write path
/// used to have no executable coverage at all. This seam lets the tests pin the
/// bytes, the mode, the replacement and the failure cleanup directly.
///
/// `#[cfg(test)]`: it exists for the suite and nothing else, and a test-only
/// seam that also ships in the binary is one more way to write a key file with
/// a value the run-time path did not produce (the compiler enforces that with
/// `dead_code` once this attribute is removed).
#[cfg(test)]
pub fn save_db_key_file_with_key(path: &Path, key: &str) -> Result<(), String> {
    key_file_destination(path)?;
    // Refuse to write something that is not a key: a malformed value would look
    // like an exported key and open nothing.
    validate_stored_key(key)?;
    write_key_file(path, key)
}

/// [`save_db_key_file_with_key`] with the rename injected as well (E10): the
/// test drives the late-rename failure that leaves the complete key in the
/// retained temp, and pins both the actionable error and the fact that the
/// file really is still there.
#[cfg(test)]
pub fn save_db_key_file_with_rename(
    path: &Path,
    key: &str,
    rename: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
    key_file_destination(path)?;
    validate_stored_key(key)?;
    write_key_file_seamed(path, key, rename)
}

/// Check that `path` can be a key destination, without touching the keyring.
fn key_file_destination(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        return Err(format!(
            "{} is a directory — pick a file name for the key",
            path.display()
        ));
    }
    let parent = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => return Err(format!("{} has no directory to write into", path.display())),
    };
    if !parent.is_dir() {
        return Err(format!("{} has no directory to write into", path.display()));
    }
    if path.file_name().and_then(|n| n.to_str()).is_none() {
        return Err(format!("invalid destination {}", path.display()));
    }
    Ok(())
}

fn write_key_file(path: &Path, key: &str) -> Result<(), String> {
    write_key_file_seamed(path, key, |from, to| std::fs::rename(from, to))
}

/// [`write_key_file`] with the rename injected so a test can force the LATE
/// failure — after the temp file already holds the complete key — which the
/// filesystem will not reliably produce on demand (the destination is
/// validated as a non-directory up front, so "rename onto a directory" is
/// closed off).
fn write_key_file_seamed(
    path: &Path,
    key: &str,
    rename: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
    use std::io::Write;
    let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) else {
        return Err(format!("{} has no directory to write into", path.display()));
    };
    let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
        return Err(format!("invalid destination {}", path.display()));
    };
    let bytes = format!("{key}\n").into_bytes();

    // A random temp name per attempt: a leftover temp from a previous failed
    // rename can never block this export, and two exports cannot collide.
    let (tmp_path, mut file) = {
        let mut opened = None;
        for _ in 0..8 {
            let mut random = [0u8; 16];
            getrandom::fill(&mut random)
                .map_err(|e| format!("OS random source unavailable: {e}"))?;
            let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
            let candidate = parent.join(format!(".{file_name}.{suffix}.purple-memo-tmp"));
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                // Owner-only: the file is the master secret for the whole database.
                options.mode(0o600);
                // Never write THROUGH a symlink planted at the temp name.
                options.custom_flags(libc::O_NOFOLLOW);
            }
            match options.open(&candidate) {
                Ok(file) => {
                    opened = Some((candidate, file));
                    break;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => {
                    return Err(format!(
                        "could not create a key file beside {}: {e}",
                        path.display()
                    ))
                }
            }
        }
        match opened {
            Some(opened) => opened,
            None => {
                return Err(format!(
                    "could not create a temporary key file beside {} after 8 attempts",
                    path.display()
                ))
            }
        }
    };

    let write_result = file.write_all(&bytes).and_then(|()| file.sync_all());
    drop(file);
    if let Err(e) = write_result {
        // Leave no temp file behind on failure, and never touch the real one.
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("could not write {}: {e}", path.display()));
    }
    if let Err(e) = rename(&tmp_path, path) {
        // Keep the temp file: it holds the only copy of a key that is still in
        // the credential store, and deleting it would throw away the user's work.
        //
        // E10: that retained temp IS a completed plaintext key file sitting
        // outside the credential store — a disclosure that really happened,
        // just not the one that was asked for. The error below names it for
        // the user; the audit line records it for everyone who reads
        // `key-export.log` afterwards, because "only record a disclosure that
        // actually happened" must cover this one too. Paths only, escaped
        // (E14) — no key material reaches the line.
        crate::note_key_retained(&tmp_path.display().to_string(), &path.display().to_string());
        return Err(format!(
            "could not write {} ({e}); the key is still at {}",
            path.display(),
            tmp_path.display()
        ));
    }
    // Only record a disclosure that actually happened.
    crate::note_key_export(&path.display().to_string());
    Ok(())
}

/// Whether a database file is already there. Pure over the path (no IO beyond
/// the metadata read) so the mint guard is testable without a keyring.
pub fn db_file_exists(db_path: &Path) -> bool {
    match std::fs::metadata(db_path) {
        Ok(meta) => meta.is_file() && meta.len() > 0,
        Err(_) => false,
    }
}

/// The refusal message for "a database exists but the credential store has no
/// key". Pure, so the wording — which is the only guidance the user gets — is
/// pinned by a test rather than left to drift in the error arm. It names the
/// restore path the boot-failure dialog actually offers now.
pub fn missing_key_for_existing_db(db_path: &Path) -> String {
    format!(
        "the database {} already exists but no encryption key is in the OS credential store. \
         Purple Memo will not generate a new key over existing data. Choose Restore exported \
         key… and pick the key file you exported in Settings (Backup & key), or move the \
         database aside to start fresh — doing so discards the data in it.",
        db_path.display()
    )
}

fn is_key_hex(s: &str) -> bool {
    s.len() == KEY_HEX_LEN && s.chars().all(|c| c.is_ascii_hexdigit())
}

// ---------------------------------------------------------------------------
// Open + verify + schema
// ---------------------------------------------------------------------------

/// Open the SQLCipher database at `path` and apply the connection pragmas.
///
/// Order matters: set the key first, then **verify before use** by
/// reading `sqlite_master` — a wrong key fails here, before any schema work.
/// Then WAL mode and `foreign_keys = ON`.
pub fn open_encrypted_db(path: &Path, key_hex: &str) -> Result<Connection, String> {
    if !is_key_hex(key_hex) {
        return Err("DB key must be 64 hex characters (256 bits)".to_string());
    }
    let conn = Connection::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    set_key_and_verify(&conn, key_hex)?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("failed to enable WAL: {e}"))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("failed to enable foreign keys: {e}"))?;
    // SQLite's busy handler is off by default, which turns any contention
    // into an instant SQLITE_BUSY rather than a short wait. The
    // single in-process connection cannot contend with itself, but anything
    // else holding the file can: a second app instance, an external sqlite3
    // session, or a backup tool reading the exported DB. Five seconds is
    // well past any legitimate hold and still short enough that a genuine
    // conflict surfaces as an error rather than a hang.
    conn.busy_timeout(std::time::Duration::from_secs(BUSY_TIMEOUT_SECS))
        .map_err(|e| format!("failed to set busy timeout: {e}"))?;
    Ok(conn)
}

/// Key first, then **verify before use** by reading `sqlite_master` — the
/// shared core of both opens. A wrong key fails here, before any schema work.
fn set_key_and_verify(conn: &Connection, key_hex: &str) -> Result<(), String> {
    // SQLCipher raw-key form: PRAGMA key = "x'<hex>'".
    conn.execute_batch(&format!("PRAGMA key = \"x'{key_hex}'\";"))
        .map_err(|e| format!("failed to set DB key: {e}"))?;
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
        .map_err(|e| format!("DB key verification failed (wrong key or corrupt file): {e}"))?;
    Ok(())
}

/// [`open_encrypted_db`] for a database that must ALREADY exist (E11).
///
/// The key-restore flow proves a candidate key against the database before
/// storing it — and that proof is worthless if the open itself can
/// *create* the target: if the database was moved, deleted, or replaced with
/// an empty file while the restore dialog sat open, an ordinary creating open
/// initializes an empty SQLCipher database under **any** well-shaped candidate
/// key, the `sqlite_master` probe then happily answers for the empty file, and
/// the flow stores a key that opens nothing. So this variant never creates:
/// the connection is opened read-write but WITHOUT `SQLITE_OPEN_CREATE`, so a
/// missing target is a hard open error instead of a fresh database.
///
/// Callers must additionally re-check [`db_file_exists`] *before* calling, to
/// keep a zero-length file from reaching the probe — SQLite treats an empty
/// file as a legitimate brand-new database, which would pass verification for
/// any key. The pair of checks is what makes recovery verify an existing
/// database or nothing at all; first-run creation stays in `boot`.
pub fn open_encrypted_db_existing(path: &Path, key_hex: &str) -> Result<Connection, String> {
    if !is_key_hex(key_hex) {
        return Err("DB key must be 64 hex characters (256 bits)".to_string());
    }
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    set_key_and_verify(&conn, key_hex)?;
    Ok(conn)
}

/// The SQL that moves a database from `from` to `from + 1`, or `None` when no
/// such step is defined.
///
/// Generic over [`schema::SCHEMA_VERSION`], deliberately not a two-case match:
/// version 3 adds `2 => Some(schema::MIGRATION_2_3)` here and changes nothing
/// else. `init_schema` treats a `None` in the middle of the range as a hard
/// error before writing anything, so a forgotten step can never leave a
/// database stranded between two versions.
fn migration_step(from: i64) -> Option<&'static str> {
    match from {
        1 => Some(schema::MIGRATION_1_2),
        2 => Some(schema::MIGRATION_2_3),
        3 => Some(schema::MIGRATION_3_4),
        4 => Some(schema::MIGRATION_4_5),
        _ => None,
    }
}

/// Run one schema step in its own transaction and stamp the version it reached.
///
/// The stamp is inside the transaction and after the SQL, so `user_version` is
/// the last thing to change and a rolled-back step leaves the old version in
/// place: the database is either fully at `stamp` or exactly as it was.
fn apply_schema_step(conn: &Connection, sql: &str, stamp: i64, what: &str) -> Result<(), String> {
    conn.execute_batch("BEGIN")
        .map_err(|e| format!("failed to start the {what} transaction: {e}"))?;
    if let Err(e) = conn.execute_batch(sql) {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(format!("{what} failed and was rolled back: {e}"));
    }
    conn.execute_batch(&format!("PRAGMA user_version = {stamp};"))
        .and_then(|_| conn.execute_batch("COMMIT"))
        .map_err(|e| {
            let _ = conn.execute_batch("ROLLBACK");
            format!("failed to stamp user_version {stamp}: {e}")
        })
}

/// Bring a database up to [`schema::SCHEMA_VERSION`]
///
/// * a fresh database (`user_version = 0`) gets the whole baseline in one
///   transaction, stamped with the CURRENT version — a new install never walks
///   the step list;
/// * an older database gets one transaction per step, in order;
/// * a database already at this version is left untouched;
/// * anything else — newer, or older with a missing step — fails closed
///   without writing a byte. An older binary pointed at a migrated database
///   lands here, and the honest outcome is a refusal the user can act on, not
///   a half-written database.
pub fn init_schema(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| format!("failed to read user_version: {e}"))?;
    if version > schema::SCHEMA_VERSION {
        return Err(format!(
            "this database uses schema version {version}, but this build of Purple Memo understands at most {}. Update the app, then open it again — an older app cannot safely open a newer database, and downgrading across a schema change is not supported.",
            schema::SCHEMA_VERSION
        ));
    }
    if version == schema::SCHEMA_VERSION {
        return Ok(());
    }
    if version == 0 {
        return apply_schema_step(
            conn,
            schema::BASELINE_SQL,
            schema::SCHEMA_VERSION,
            "baseline schema",
        );
    }
    // Refuse BEFORE the first write if the range contains a step this build
    // does not have, so a gap can never be discovered halfway through.
    for step in version..schema::SCHEMA_VERSION {
        if migration_step(step).is_none() {
            return Err(format!(
                "this database uses schema version {step}, but this build has no migration from {step} to {} — refusing to touch it",
                step + 1
            ));
        }
    }
    let mut current = version;
    while current < schema::SCHEMA_VERSION {
        let Some(sql) = migration_step(current) else {
            // Unreachable: the range was checked above. Kept so the loop can
            // never spin on a `None`.
            return Err(format!("no migration from schema version {current}"));
        };
        apply_schema_step(
            conn,
            sql,
            current + 1,
            &format!("schema migration {current}"),
        )?;
        current += 1;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Factory reset — the connection and keyring seams
// ---------------------------------------------------------------------------

/// Checkpoint the WAL and then close and drop the managed connection, leaving
/// the app holding **no open database handle**.
///
/// This is the step that makes deleting the database files safe: after it
/// returns `Ok`, every DB command fails closed with [`DB_CLOSED_MESSAGE`]
/// rather than running against a file that is about to be removed. An open
/// manual transaction is rolled back first — an uncommitted transaction would
/// make the checkpoint fail, and its rows are about to be deleted anyway.
///
/// Closing removes no files; deletion is the reset engine's job. Idempotent:
/// once the connection is taken, a re-run of a partial reset finds it already
/// closed and proceeds.
pub fn close_connection_for_reset(state: &AppState) -> Result<(), String> {
    let mut guard = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    let Some(conn) = guard.as_ref() else {
        // Already closed — a safe re-run, never an error.
        return Ok(());
    };
    if state.txn_open.swap(false, Ordering::SeqCst) {
        // Best effort: an abandoned manual transaction must not survive into
        // the checkpoint (its rows are discarded by the reset regardless).
        let _ = conn.execute_batch("ROLLBACK;");
    }
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(|e| format!("could not checkpoint the WAL before the reset: {e}"))?;
    // Take the connection out of the state and drop it: the file handle is
    // released here, which is the whole point of this step.
    *guard = None;
    Ok(())
}

/// The database file plus its WAL and SHM siblings — the three files factory
/// reset removes as one component.
pub fn db_file_paths(data_dir: &Path) -> Vec<PathBuf> {
    let main = data_dir.join(DB_FILE_NAME);
    let wal = main.with_file_name(format!("{DB_FILE_NAME}-wal"));
    let shm = main.with_file_name(format!("{DB_FILE_NAME}-shm"));
    vec![main, wal, shm]
}

/// Reconcile the break-glass transaction reset with SQLite's REAL state (E12).
///
/// `db_reset_txn` is the last resort after COMMIT and ROLLBACK both failed.
/// Clearing the app's `txn_open` flag alone left SQLite's transaction open:
/// later batches then failed to BEGIN, and single writes joined the
/// abandoned transaction despite the flag saying otherwise — uncommitted
/// rows silently lost when the connection closed while the app reported a
/// clean state.
///
/// So this asks SQLite (`is_autocommit`) instead of trusting the flag, under
/// the connection lock the caller holds:
///
/// * no real transaction → the flag was merely stale, safe to clear;
/// * a real transaction → an explicit `ROLLBACK`, which is the break-glass
///   step the flag-clearing pretended to be;
/// * rollback fails → an error naming a restart, and the caller must NOT
///   clear the flag: every later write keeps refusing instead of entering a
///   transaction the app pretends is over.
pub fn reconcile_open_txn(conn: &Connection) -> Result<(), String> {
    if conn.is_autocommit() {
        return Ok(());
    }
    conn.execute_batch("ROLLBACK;").map_err(|e| {
        format!(
            "could not roll back the open transaction: {e} — the transaction \
             state was NOT cleared; restart the app before writing again"
        )
    })?;
    Ok(())
}

/// Delete the DB encryption key from the OS credential store — factory reset
/// only.
///
/// Returns `Ok(true)` when a key was removed and `Ok(false)` when there was
/// none: "already absent" is success for a reset, not an error (the same rule
/// as a missing file). **The reset engine must not call this until the
/// database files are confirmed gone** — never orphan a live database from
/// its key. This is deliberately not used anywhere else; nothing but a reset
/// may remove the key.
pub fn delete_db_key() -> Result<bool, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("keyring entry unavailable: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(true),
        // No key stored: already absent, which the reset reports as success.
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(format!(
            "failed to delete the DB key from the credential store: {e}"
        )),
    }
}

// ---------------------------------------------------------------------------
// JSON <-> SQLite value mapping
//
// Params: null / bool / number / string / array-of-bytes (blob).
// Rows:   column name -> JSON value (blob -> array of byte numbers).
// ---------------------------------------------------------------------------

fn json_to_sql(value: &JsonValue) -> Result<SqlValue, String> {
    Ok(match value {
        JsonValue::Null => SqlValue::Null,
        JsonValue::Bool(b) => SqlValue::Integer(i64::from(*b)),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else if let Some(f) = n.as_f64() {
                SqlValue::Real(f)
            } else {
                return Err(format!("unsupported JSON number {n}"));
            }
        }
        JsonValue::String(s) => SqlValue::Text(s.clone()),
        JsonValue::Array(items) => {
            let mut bytes = Vec::with_capacity(items.len());
            for item in items {
                match item.as_u64() {
                    Some(b) if b <= u64::from(u8::MAX) => bytes.push(b as u8),
                    _ => {
                        return Err(
                            "only arrays of byte values (0-255) are supported as BLOB parameters"
                                .to_string(),
                        );
                    }
                }
            }
            SqlValue::Blob(bytes)
        }
        JsonValue::Object(_) => {
            return Err("JSON objects are not supported as SQL parameters".to_string());
        }
    })
}

fn json_params(params: &[JsonValue]) -> Result<Vec<SqlValue>, String> {
    params.iter().map(json_to_sql).collect()
}

fn sql_to_json(value: SqlValue) -> JsonValue {
    match value {
        SqlValue::Null => JsonValue::Null,
        SqlValue::Integer(i) => JsonValue::from(i),
        SqlValue::Real(f) => {
            serde_json::Number::from_f64(f).map_or(JsonValue::Null, JsonValue::Number)
        }
        SqlValue::Text(s) => JsonValue::String(s),
        SqlValue::Blob(b) => JsonValue::Array(b.into_iter().map(JsonValue::from).collect()),
    }
}

// ---------------------------------------------------------------------------
// Query / write primitives (used by the IPC commands in `commands.rs`)
// ---------------------------------------------------------------------------

/// The first `n` SQL keywords of `sql`, with leading whitespace **and
/// comments** skipped.
///
/// Stripping comments is the point: a check that only reads the first
/// whitespace-separated token sees `--` for `-- x\nCOMMIT` and `/*c*/` for
/// `/*c*/COMMIT`, while SQLite happily prepares the `COMMIT` underneath.
fn leading_keywords(sql: &str, n: usize) -> Vec<String> {
    let rest = strip_leading_noise(sql).unwrap_or("");
    rest.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|token| !token.is_empty())
        .take(n)
        .map(|k| k.to_ascii_uppercase())
        .collect()
}

/// The name of the pragma `sql` sets, or `None` when it is not a pragma.
///
/// Scanned from the raw text rather than from keyword tokens because a pragma
/// name may be dotted (`PRAGMA main.rekey`) or quoted — and SQLite accepts
/// **three** quoting forms for an identifier, not one:
///
/// * `"rekey"` — the SQL standard form,
/// * `` `rekey` `` — MySQL compatibility,
/// * `[rekey]` — MS-SQL compatibility.
///
/// All three name the same pragma, so all three must reach the guard. This
/// accepted only `"` (review P3-2), which made `PRAGMA [rekey]` scan as an
/// *empty* name: the take-while stopped at `[`, `None` became `""` via
/// `unwrap_or_default`, and neither `KEY` nor `REKEY` matched — so the one
/// statement that must never run was the one spelling the guard did not
/// recognise, while SQLite happily executed it.
fn pragma_name_of(sql: &str) -> Option<String> {
    let rest = strip_leading_noise(sql)?;
    let rest = strip_keyword(rest, "PRAGMA")?;
    let name: String = rest
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '"' | '[' | ']' | '`'))
        .collect();
    // Take the part after any schema prefix, then drop whichever quoting form
    // wrapped it: `main.[rekey]` -> `[rekey]` -> `rekey`. Repeated, because the
    // trim has to see through a nested spelling too — `["rekey"]` is not valid
    // SQLite, but a scanner that mangles it into `"rekey"` (quotes still
    // attached) would stop matching REKEY, and the fail-closed default below
    // would never see an unparseable name to catch it.
    let last = name.rsplit('.').next().unwrap_or("");
    let mut name = last.to_string();
    loop {
        let trimmed = name
            .trim_matches('"')
            .trim_matches('`')
            .trim_matches(['[', ']']);
        if trimmed.len() == name.len() {
            break;
        }
        name = trimmed.to_string();
    }
    let name = name.as_str();
    if name.is_empty() {
        None
    } else {
        Some(name.to_ascii_uppercase())
    }
}

/// Drop leading whitespace and comments, returning the remainder.
fn strip_leading_noise(mut sql: &str) -> Option<&str> {
    loop {
        sql = sql.trim_start();
        if let Some(after) = sql.strip_prefix("--") {
            sql = match after.find('\n') {
                Some(i) => &after[i + 1..],
                None => "",
            };
        } else if let Some(after) = sql.strip_prefix("/*") {
            sql = match after.find("*/") {
                Some(i) => &after[i + 2..],
                None => "",
            };
        } else {
            return Some(sql);
        }
    }
}

/// Consume `keyword` (case-insensitively) from the front of `sql`, returning
/// what follows it. Hand-rolled rather than `split_at_checked` to stay inside
/// the crate's 1.77 MSRV.
fn strip_keyword<'a>(sql: &'a str, keyword: &str) -> Option<&'a str> {
    if !sql.is_char_boundary(keyword.len()) {
        return None;
    }
    let (head, tail) = sql.split_at(keyword.len());
    if head.eq_ignore_ascii_case(keyword) {
        Some(tail)
    } else {
        None
    }
}

/// Transaction-control statements. `batch` wraps its statements in
/// BEGIN/COMMIT itself, and a COMMIT/ROLLBACK smuggled through any other
/// command would commit or abort a manual transaction behind the `txn_open`
/// flag's back — silently breaking the atomicity the feature layer relies on.
const TXN_CONTROL: [&str; 6] = ["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE"];

/// Refuse statements that escape the app's data model or break the
/// connection contract.
///
/// This is defence in depth, not a sandbox: the delivery plan already
/// establishes that the renderer is trusted (it can run arbitrary SQL and
/// read the DB key).
/// What it buys is that a bug in the TypeSQL layer — which builds some
/// statements by interpolating a validated identifier — cannot escalate into
/// destroying data or escaping the file.
///
/// Every app statement starts with SELECT/INSERT/UPDATE/DELETE/WITH or is
/// `PRAGMA foreign_keys` (the backup import toggles it), so the app's real
/// vocabulary never reaches a rejection.
fn reject_dangerous_statement(sql: &str) -> Result<(), String> {
    let keywords = leading_keywords(sql, 1);
    let first = keywords.first().map(String::as_str).unwrap_or("");

    if TXN_CONTROL.contains(&first) {
        return Err(format!(
            "transaction-control statements are not allowed here: {first}"
        ));
    }
    // ATTACH/DETACH read and write SQLite files outside this database: after an
    // ATTACH, `CREATE TABLE other.t` creates or overwrites a file anywhere the
    // process can write, and `SELECT * FROM other.t` reads any of them.
    if first == "ATTACH" || first == "DETACH" {
        return Err(format!(
            "{first} is not allowed: it reaches outside this database file"
        ));
    }
    // `PRAGMA key` replaces the key for the connection and `PRAGMA rekey`
    // re-encrypts the whole file. Either one leaves the database encrypted
    // under a key that never reaches the credential store: total data loss.
    //
    // **An unidentifiable pragma is refused rather than allowed** (review P3-2).
    // This used to read `unwrap_or_default()`, so a `PRAGMA` whose name the
    // scanner could not parse became the empty string, matched neither KEY nor
    // REKEY, and sailed through — a fail-*open* default on the one guard whose
    // failure destroys data. That exact case shipped once: `pragma_name_of`
    // accepted SQLite's `"…"` quoting but not its `` `…` `` or `[…]` forms, so
    // `PRAGMA [rekey]` scanned as empty and was allowed, while SQLite executed
    // it. The three quoting forms are now handled, and anything still
    // unparseable is refused: a spelling this scanner has never seen must not
    // be the spelling that gets through.
    if first == "PRAGMA" {
        let name = pragma_name_of(sql)
            .ok_or_else(|| "PRAGMA could not be identified and is not allowed here".to_string())?;
        if name == "KEY" || name == "REKEY" {
            return Err(
                "PRAGMA key/rekey is not allowed: it would leave the database \
                 encrypted under a key that is not in the credential store"
                    .to_string(),
            );
        }
    }
    Ok(())
}

/// Run a query and return rows as JSON objects keyed by column name.
pub fn query_rows(
    conn: &Connection,
    sql: &str,
    params: &[JsonValue],
) -> Result<Vec<JsonObj>, String> {
    // Reads get the same guard as writes. Without it
    // `db_query("COMMIT")` committed an open manual transaction while
    // `txn_open` stayed true, and `db_query("BEGIN")` opened a transaction
    // the flag did not know about — after which every `db_batch` failed with
    // "cannot start a transaction within a transaction" for the life of the
    // process.
    reject_dangerous_statement(sql)?;
    let params = json_params(params)?;
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("prepare failed: {e}"))?;
    let columns: Vec<String> = stmt
        .column_names()
        .iter()
        .map(|name| (*name).to_string())
        .collect();
    let mut rows = stmt
        .query(rusqlite::params_from_iter(params.iter()))
        .map_err(|e| format!("query failed: {e}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| format!("row fetch failed: {e}"))? {
        let mut obj = JsonObj::new();
        for (idx, col) in columns.iter().enumerate() {
            let value: SqlValue = row
                .get(idx)
                .map_err(|e| format!("column {col} read failed: {e}"))?;
            obj.insert(col.clone(), sql_to_json(value));
        }
        out.push(obj);
    }
    Ok(out)
}

/// Run a single write statement **without** the statement guard.
///
/// Only `batch` (which pre-validates the whole list before opening the
/// transaction) and tests may use this; every other caller goes through
/// [`execute`], which is the guarded public entry point (the guard
/// must never be silently skipped by a change to `execute` — `batch` is
/// the one place that deliberately runs it up front instead).
fn execute_inner(
    conn: &Connection,
    sql: &str,
    params: &[JsonValue],
) -> Result<ExecuteOutcome, String> {
    let params = json_params(params)?;
    let rows_affected = conn
        .execute(sql, rusqlite::params_from_iter(params.iter()))
        .map_err(|e| format!("execute failed: {e}"))?;
    Ok(ExecuteOutcome {
        rows_affected: rows_affected as u64,
        last_insert_rowid: conn.last_insert_rowid(),
    })
}

/// Run a single write statement (guarded); returns affected-row count +
/// rowid. The public API — the statement guard lives here.
pub fn execute(
    conn: &Connection,
    sql: &str,
    params: &[JsonValue],
) -> Result<ExecuteOutcome, String> {
    reject_dangerous_statement(sql)?;
    execute_inner(conn, sql, params)
}

/// Undo the transaction `batch` opened, and report honestly.
///
/// A failed ROLLBACK used to be discarded with `let _`, which left the
/// connection *inside* a transaction while `txn_open` stayed false. Every
/// later `db_batch` then failed at BEGIN and every `db_execute` failed with
/// "cannot start a transaction within a transaction" — a permanent wedge with
/// no message explaining it and no path out but a restart. The
/// error text asserted a rollback that may not have happened, so the caller
/// could not even tell this case from an ordinary statement failure.
fn rollback_after_failure(conn: &Connection, what: &str) -> String {
    match conn.execute_batch("ROLLBACK") {
        Ok(()) => format!("batch {what} failed and was rolled back"),
        Err(rollback_err) => format!(
            "batch {what} failed AND the rollback failed ({rollback_err}); \
             the connection is left mid-transaction and every later write will \
             fail until Purple Memo is restarted"
        ),
    }
}

/// Run several writes as a single transaction — all-or-nothing
pub fn batch(conn: &Connection, statements: &[BatchStatement]) -> Result<(), String> {
    for (idx, stmt) in statements.iter().enumerate() {
        reject_dangerous_statement(&stmt.sql)
            .map_err(|e| format!("batch statement {idx} rejected: {e}"))?;
    }
    conn.execute_batch("BEGIN")
        .map_err(|e| format!("batch begin failed: {e}"))?;
    for (idx, stmt) in statements.iter().enumerate() {
        // `execute_inner`, not `execute`: the guard already ran above, over
        // the whole list, before BEGIN — running it again per statement would
        // duplicate the check and obscure which guard is load-bearing.
        if let Err(e) = execute_inner(conn, &stmt.sql, &stmt.params) {
            return Err(format!(
                "{rollback_note}: {e}",
                rollback_note = rollback_after_failure(conn, &format!("statement {idx}"))
            ));
        }
    }
    if let Err(e) = conn.execute_batch("COMMIT") {
        return Err(format!(
            "{rollback_note}: {e}",
            rollback_note = rollback_after_failure(conn, "commit")
        ));
    }
    Ok(())
}

/// Start a manual transaction (short critical sections only — never held across UI awaits).
pub fn begin_tx(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("BEGIN")
        .map_err(|e| format!("begin failed: {e}"))
}

/// Commit the manual transaction.
pub fn commit_tx(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("COMMIT")
        .map_err(|e| format!("commit failed: {e}"))
}

/// Roll back the manual transaction.
pub fn rollback_tx(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("ROLLBACK")
        .map_err(|e| format!("rollback failed: {e}"))
}

// ---------------------------------------------------------------------------
// Tests — run with `cargo test` (P1 gate)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Self-cleaning temp dir for file-backed DB tests.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let n = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir()
                .join(format!("purple-memo-p1-{tag}-{}-{n}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }

        fn db_path(&self) -> PathBuf {
            self.0.join(DB_FILE_NAME)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn open_baseline(tag: &str) -> (TempDir, Connection) {
        let dir = TempDir::new(tag);
        let key = mint_key_hex().expect("mint key");
        let conn = open_encrypted_db(&dir.db_path(), &key).expect("open encrypted db");
        init_schema(&conn).expect("init schema");
        (dir, conn)
    }

    fn table_count(conn: &Connection) -> i64 {
        // Exclude SQLite internals and FTS5 shadow tables — the plan's "29"
        // counts notes_fts itself, not its _data/_idx/_docsize/_config/
        // _content internals.
        conn.query_row(
            "SELECT count(*) FROM sqlite_master
             WHERE type = 'table'
               AND name NOT LIKE 'sqlite_%'
               AND name NOT GLOB '*_data'
               AND name NOT GLOB '*_idx'
               AND name NOT GLOB '*_docsize'
               AND name NOT GLOB '*_config'
               AND name NOT GLOB '*_content'",
            [],
            |row| row.get(0),
        )
        .expect("count tables")
    }

    fn scalar_i64(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0))
            .expect("scalar query")
    }

    // -- Key minting must never re-key an existing database -------

    #[test]
    fn no_database_means_first_run() {
        let dir = TempDir::new("first-run");
        assert!(
            !db_file_exists(&dir.db_path()),
            "a fresh data dir has no database, so minting is allowed"
        );
    }

    #[test]
    fn a_non_empty_database_file_counts_as_existing() {
        let dir = TempDir::new("exists");
        let key = mint_key_hex().expect("mint key");
        open_encrypted_db(&dir.db_path(), &key).expect("open encrypted db");
        assert!(db_file_exists(&dir.db_path()));
    }

    #[test]
    fn a_zero_length_file_is_not_treated_as_a_database() {
        // SQLCipher creating/verifying must not be blocked by an empty
        // placeholder left behind by an interrupted first run.
        let dir = TempDir::new("empty-file");
        std::fs::write(dir.db_path(), b"").expect("write placeholder");
        assert!(!db_file_exists(&dir.db_path()));
    }

    #[test]
    fn a_directory_is_not_treated_as_a_database() {
        let dir = TempDir::new("dir-db");
        std::fs::create_dir(dir.db_path()).expect("create dir");
        assert!(!db_file_exists(&dir.db_path()));
    }

    #[test]
    fn the_missing_key_refusal_names_the_restore_paths() {
        // This message is the user's only guidance, and the old behaviour
        // reported "wrong key or corrupt file" — which named neither the real
        // cause nor what to do about it.
        let msg = missing_key_for_existing_db(Path::new("/data/purple-memo.db"));
        assert!(msg.contains("purple-memo.db"), "names the database: {msg}");
        assert!(
            msg.to_lowercase().contains("credential store"),
            "says where the key should have been: {msg}"
        );
        assert!(
            msg.to_lowercase().contains("export"),
            "points at the exported-key restore path: {msg}"
        );
        assert!(
            msg.contains("Restore exported"),
            "names the restore action the boot-failure dialog offers: {msg}"
        );
        assert!(
            msg.to_lowercase().contains("will not generate"),
            "states plainly that nothing was overwritten: {msg}"
        );
    }

    #[test]
    fn the_mint_guard_does_not_leak_key_material_in_its_error() {
        let dir = TempDir::new("no-leak");
        let key = mint_key_hex().expect("mint key");
        open_encrypted_db(&dir.db_path(), &key).expect("open");
        let msg = missing_key_for_existing_db(&dir.db_path());
        assert!(!msg.contains(&key), "the refusal must not echo a key");
    }

    // -- Exported-key restore ------------------------------------

    /// Build an existing encrypted database plus its exported key file, the
    /// exact pair a user holds when the credential store lost the key.
    fn seeded_with_export(tag: &str) -> (TempDir, std::path::PathBuf, String) {
        let dir = TempDir::new(tag);
        let key = mint_key_hex().expect("mint key");
        {
            let conn = open_encrypted_db(&dir.db_path(), &key).expect("open");
            init_schema(&conn).expect("init schema");
        }
        // The export writes "key\n" (see `write_key_file`); a real restore
        // reads that shape back and trims it.
        let key_file = dir.0.join("purple-memo-db-key.txt");
        std::fs::write(&key_file, format!("{key}\n")).expect("write key file");
        (dir, key_file, key)
    }

    #[test]
    fn a_valid_exported_key_restores_and_the_boot_can_proceed() {
        let (dir, key_file, key) = seeded_with_export("restore-ok");
        let stored = std::sync::Mutex::new(None::<String>);
        restore_db_key_from_file(&dir.db_path(), &key_file, |candidate| {
            *stored.lock().expect("store lock") = Some(candidate.to_string());
            Ok(())
        })
        .expect("a valid exported key must restore");
        let stored_key = stored
            .lock()
            .expect("store lock")
            .clone()
            .expect("store_key must have been called with the key");
        assert_eq!(stored_key, key, "the store receives the key from the file");
        // "Boot can proceed": the stored key opens the database through the
        // same open path boot uses, and the schema is there.
        let conn = open_encrypted_db(&dir.db_path(), &stored_key).expect("boot open");
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(version, schema::SCHEMA_VERSION);
    }

    #[test]
    fn a_wrong_key_is_refused_with_the_store_still_empty() {
        let (dir, key_file, _key) = seeded_with_export("restore-wrong");
        // A different *valid* key: strict hex, wrong value — the sqlite_master
        // probe is what refuses it, fail-safe, before anything is stored.
        let wrong = mint_key_hex().expect("mint wrong key");
        std::fs::write(&key_file, format!("{wrong}\n")).expect("overwrite key file");
        let mut store_calls = 0u32;
        let result = restore_db_key_from_file(&dir.db_path(), &key_file, |_| {
            store_calls += 1;
            Ok(())
        });
        assert!(result.is_err(), "a wrong key must be refused");
        assert_eq!(
            store_calls, 0,
            "the credential store must not be written on a wrong key"
        );
    }

    #[test]
    fn a_malformed_file_is_rejected_before_any_open_attempt() {
        let dir = TempDir::new("restore-malformed");
        let key_file = dir.0.join("not-a-key.txt");
        std::fs::write(&key_file, "correct horse battery staple\n").expect("write junk");
        // A database path whose parent directory does not exist: if the open
        // step ever ran before validation, the error would be an "open …" I/O
        // failure instead of the format refusal below.
        let missing_db = dir.0.join("no-such-dir").join("purple-memo.db");
        let mut store_calls = 0u32;
        let result = restore_db_key_from_file(&missing_db, &key_file, |_| {
            store_calls += 1;
            Ok(())
        });
        let err = result.expect_err("a malformed file must be refused");
        assert!(err.contains("64 hex"), "explains the expected shape: {err}");
        assert!(
            !err.contains("open "),
            "validation happens before any open attempt: {err}"
        );
        assert_eq!(store_calls, 0, "nothing is stored for a malformed file");
    }

    #[test]
    fn restore_refuses_a_database_that_vanished_instead_of_recreating_it() {
        // E11: the restore dialog can sit open while the database is moved,
        // deleted, or emptied. The old CREATING open would then initialize an
        // empty database under the candidate key, the sqlite_master probe
        // would "prove" that empty file against ANY well-formed key, and the
        // flow would store it — recovery appearing to succeed into an empty
        // workspace behind the wrong key. Fail closed instead: nothing
        // created, nothing stored.
        let dir = TempDir::new("restore-vanished");
        let key = mint_key_hex().expect("mint key");
        let key_file = dir.0.join("key.txt");
        std::fs::write(&key_file, format!("{key}\n")).expect("write key file");
        let db = dir.0.join(DB_FILE_NAME);
        let store_calls = std::cell::Cell::new(0u32);

        // Case 1: the database is gone entirely.
        let error = restore_db_key_from_file(&db, &key_file, |_| {
            store_calls.set(store_calls.get() + 1);
            Ok(())
        })
        .expect_err("a vanished database must refuse");
        assert!(
            error.contains("no longer an existing database"),
            "names the real situation: {error}"
        );
        assert!(
            !db.exists(),
            "the check must not have created anything (E11)"
        );

        // Case 2: the database exists but is empty — SQLite would treat the
        // zero-length file as a brand-new database and the probe would pass
        // for any candidate key, so it must be refused before the open too.
        std::fs::write(&db, b"").expect("plant an empty file");
        restore_db_key_from_file(&db, &key_file, |_| {
            store_calls.set(store_calls.get() + 1);
            Ok(())
        })
        .expect_err("an empty file must refuse as well");

        assert_eq!(
            store_calls.get(),
            0,
            "the credential store must never be written for a target that is not a database"
        );
        assert_eq!(
            std::fs::metadata(&db).expect("metadata").len(),
            0,
            "the empty file must be untouched — no initialization may happen"
        );
    }

    #[test]
    fn the_key_restore_audit_line_has_no_channel_for_key_material() {
        let key = mint_key_hex().expect("mint key");
        let line = key_restore_audit_line("/home/me/purple-memo-db-key.txt");
        assert!(!line.contains(&key), "the line must not echo a key");
        assert!(!line.contains("x'"), "no SQLCipher key literal form");
        assert!(
            line.contains("/home/me/purple-memo-db-key.txt"),
            "names the source file: {line}"
        );
        assert!(
            line.to_lowercase().contains("key restored"),
            "says what happened: {line}"
        );
    }

    #[test]
    fn a_key_path_cannot_split_or_forge_the_audit_line_it_is_recorded_on() {
        // E14: on a filesystem that allows them, a chosen filename can carry
        // newlines and control characters. Written verbatim, ONE key path
        // would render as several timestamped-looking lines and make the
        // disclosure history say something that never happened. Every audit
        // line that embeds a path must stay exactly one line, with the path
        // preserved as a visible escape rather than dropped.
        let forged = "/home/me/keys/innocent.txt\n2026-10-28T00:00:00Z key file written: /attacker/pick.txt\r\n\t";
        for line in [
            key_export_audit_line(forged),
            key_restore_audit_line(forged),
            key_export_retained_audit_line(forged, forged),
        ] {
            assert!(!line.contains('\n'), "one path, one line: {line:?}");
            assert!(!line.contains('\r'), "no carriage return either: {line:?}");
            assert!(
                line.contains("\\n"),
                "the newline survives as a visible escape, not a break: {line:?}"
            );
            assert!(
                line.contains("attacker/pick.txt"),
                "the forged content stays visible as escaped text: {line:?}"
            );
        }
    }

    #[test]
    fn an_escaped_key_path_is_unambiguous() {
        // Escaping the backslash FIRST is what keeps the two cases apart: a
        // real newline renders as `\n`, while a literal backslash-n in a
        // filename renders as `\\n`. Without the doubling the two would be
        // indistinguishable and the record would still be forgeable by
        // reading. Windows separators are doubled as the cost — deliberate.
        let real_newline = key_export_audit_line("C:\\keys\nstolen.txt");
        let literal_backslash_n = key_export_audit_line(r"C:\keys\nstolen.txt");
        assert!(
            real_newline.contains(r"keys\nstolen"),
            "a real newline is the two-char escape: {real_newline}"
        );
        assert!(
            literal_backslash_n.contains(r"keys\\nstolen"),
            "a literal backslash-n keeps its doubled backslash: {literal_backslash_n}"
        );
        assert_ne!(
            real_newline, literal_backslash_n,
            "the two inputs must never render identically"
        );
        assert!(
            literal_backslash_n.contains(r"C:\\keys"),
            "windows separators are doubled: {literal_backslash_n}"
        );
    }

    #[test]
    fn parse_exported_key_file_contents_trims_and_checks_strictly() {
        let key = mint_key_hex().expect("mint key");
        assert_eq!(
            parse_exported_key_file_contents(&format!("{key}\n")).expect("trimmed key"),
            key,
            "the export's trailing newline is trimmed"
        );
        assert_eq!(
            parse_exported_key_file_contents(&format!("  {key}  ")).expect("padded key"),
            key,
            "surrounding whitespace is trimmed"
        );
        let too_long_hex = "a".repeat(65);
        let hex_plus_junk = format!("{key}zz");
        for bad in [
            "",
            "xyz",
            "0123",
            too_long_hex.as_str(),
            hex_plus_junk.as_str(),
        ] {
            assert!(
                parse_exported_key_file_contents(bad).is_err(),
                "{bad:?} must be refused"
            );
        }
    }

    // -- Key export ----------------------------------------

    #[test]
    fn the_audit_line_has_no_channel_through_which_a_key_could_leak() {
        // The property that matters is structural, so this asserts it by
        // construction: a realistic key is nowhere in the rendered line, and
        // the line names the destination and the action, which is the whole
        // point of an audit record.
        let key = mint_key_hex().expect("mint key");
        let line = key_export_audit_line("/home/me/key.txt");
        assert!(!line.contains(&key));
        assert!(!line.contains("x'"), "no SQLCipher key literal form");
        assert!(line.contains("/home/me/key.txt"), "names the destination");
        assert!(
            line.to_lowercase().contains("key file written"),
            "says what happened: {line}"
        );
    }

    #[test]
    fn saving_the_key_file_does_not_return_the_key() {
        // The compile-time half of `save_db_key_file` returns `Result<(), _>`,
        // so there is no return path by which the plaintext key could reach the
        // webview. Asserted here because a future "just return it too" edit is
        // the exact regression being prevented.
        let dir = TempDir::new("key-save");
        let out = dir.0.join("key.txt");
        let result: Result<(), String> = save_db_key_file(&out);
        // Whether it succeeds depends on the machine's credential store, so
        // only the shape is asserted — never the value on either path.
        if let Err(message) = result {
            let key = mint_key_hex().expect("mint key");
            assert!(!message.contains(&key), "errors must not echo a key");
        }
    }

    #[test]
    fn a_key_file_write_reports_the_path_not_the_key() {
        // Destination validation runs before the credential store, so this
        // path fails for its own reason even on a machine with no stored key —
        // and the message names the destination, never key material.
        //
        // The parent is temp-relative and definitely absent: a fixed path like
        // `/definitely/not/a/real/dir/key.txt` is not hermetic — an earlier run
        // of the old implementation (which created parent directories) left
        // exactly that tree behind on the test drive, and the key was then
        // written into it.
        let dir = TempDir::new("key-no-parent");
        let unwritable = dir.0.join("no-such-dir").join("key.txt");
        let key = mint_key_hex().expect("mint key");
        let message = save_db_key_file(&unwritable).expect_err("no such parent directory");
        assert!(!message.contains(&key), "must not echo a key: {message}");
        assert!(
            message.contains("key.txt"),
            "should name the destination: {message}"
        );
        assert!(
            !dir.0.join("no-such-dir").exists(),
            "validation must not create the missing directory"
        );
    }

    #[test]
    fn a_key_file_write_refuses_a_directory_destination() {
        // P3-20: the old form opened the destination with `truncate(true)` and
        // only learned it was a directory afterwards, by failing to write. The
        // refusal is now explicit, so the user gets a message that names the
        // problem instead of "could not open ...".
        let dir = TempDir::new("key-dir-dest");
        let key = mint_key_hex().expect("mint key");
        let message =
            save_db_key_file_with_key(&dir.0, &key).expect_err("a directory is not a file");
        assert!(
            message.contains("directory"),
            "should say the destination is a directory: {message}"
        );
    }

    #[test]
    fn a_key_file_write_uses_a_private_file_and_the_exact_key() {
        // the properties the module promises were never executed by
        // a test, because the only entry point read the credential store. With
        // the key supplied, they are pinned directly: exact bytes, owner-only
        // mode on unix, no temp left behind.
        let dir = TempDir::new("key-content");
        let out = dir.0.join("key.txt");
        let key = mint_key_hex().expect("mint key");
        save_db_key_file_with_key(&out, &key).expect("write the key");
        assert_eq!(
            std::fs::read_to_string(&out).expect("read back"),
            format!("{key}\n"),
            "the file must hold the key and a newline, nothing else"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&out)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "the key file must be owner-only");
        }
        let leftovers: Vec<_> = std::fs::read_dir(&dir.0)
            .expect("read temp dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".purple-memo-tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "a successful save must consume its temp file: {leftovers:?}"
        );
    }

    #[test]
    fn a_key_file_write_replaces_an_existing_key_file() {
        // A re-export replaces the old key file in one atomic rename, leaving
        // exactly one file — no `.1`, no temp sibling.
        let dir = TempDir::new("key-replace");
        let out = dir.0.join("key.txt");
        let first = mint_key_hex().expect("mint key");
        let second = mint_key_hex().expect("mint key");
        save_db_key_file_with_key(&out, &first).expect("first save");
        save_db_key_file_with_key(&out, &second).expect("second save");
        assert_eq!(
            std::fs::read_to_string(&out).expect("read back"),
            format!("{second}\n")
        );
        assert_eq!(
            std::fs::read_dir(&dir.0).expect("read dir").count(),
            1,
            "re-export must leave one file and no temp"
        );
    }

    #[test]
    fn a_key_file_write_succeeds_despite_stale_temps_from_earlier_attempts() {
        // the old implementation used ONE fixed temp name with O_EXCL and
        // deliberately kept the temp after a failed rename ("it holds the only
        // copy of a key"), so after a single failure every later export to that
        // destination failed with `File exists` until the user deleted the
        // leftover by hand. Plant both the old fixed name and a random-suffixed
        // sibling — neither may block a fresh export, which is exactly the
        // behaviour the randomised-temp retry loop exists to guarantee.
        let dir = TempDir::new("key-stale-temp");
        let out = dir.0.join("key.txt");
        let fixed = dir.0.join("key.txt.purple-memo-tmp");
        let random = dir.0.join(".key.txt.00ff.purple-memo-tmp");
        std::fs::write(&fixed, "stale key material\n").expect("plant the old fixed temp");
        std::fs::write(&random, "stale key material\n").expect("plant a random-suffixed temp");
        let key = mint_key_hex().expect("mint key");
        save_db_key_file_with_key(&out, &key)
            .expect("a leftover temp must not wedge the next export");
        assert_eq!(
            std::fs::read_to_string(&out).expect("read back"),
            format!("{key}\n"),
            "the export must land in the destination, not in a temp"
        );
    }

    #[test]
    fn a_late_rename_failure_keeps_the_complete_key_and_says_where_it_is() {
        // E10, behavioural half: the temp file is fully written and synced
        // before the rename, so a failure THERE leaves a complete plaintext
        // key on disk. The error must keep naming it (the user's way out),
        // the bytes must really be the key (not a partial write), and the
        // destination — never created — must stay untouched.
        let dir = TempDir::new("key-late-rename");
        let out = dir.0.join("key.txt");
        let key = mint_key_hex().expect("mint key");
        let error = save_db_key_file_with_rename(&out, &key, |_, _| {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "simulated late rename failure",
            ))
        })
        .expect_err("the rename failure must surface");

        assert!(
            error.contains("the key is still at"),
            "the error keeps pointing at the retained file: {error}"
        );
        assert!(!out.exists(), "the destination was never created");

        let temps: Vec<String> = std::fs::read_dir(&dir.0)
            .expect("read temp dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".purple-memo-tmp"))
            .collect();
        assert_eq!(temps.len(), 1, "exactly one retained temp: {temps:?}");
        assert_eq!(
            std::fs::read_to_string(dir.0.join(&temps[0])).expect("read temp"),
            format!("{key}\n"),
            "the retained temp holds the COMPLETE key — that is why it survives"
        );
    }

    #[test]
    fn a_retained_key_file_gets_an_audit_line() {
        // E10, record half: only a successful rename used to record anything,
        // so a completed key file left behind by a late failure existed with
        // no entry in `key-export.log`. The note sits inside the rename-error
        // branch — pinned from source, like the other ordering invariants
        // here; the audit write itself is `append_audit_line`, which the
        // suite deliberately does not drive (best-effort, needs the data dir).
        let src = include_str!("db.rs");
        let start = src
            .find("if let Err(e) = rename(&tmp_path, path)")
            .expect("the late rename branch exists");
        let end = src[start..]
            .find("crate::note_key_export(")
            .map(|i| start + i)
            .expect("the success-side note bounds the branch");
        let branch = &src[start..end];
        let note = branch
            .find("crate::note_key_retained(")
            .expect("a retained key file must be recorded in the audit trail (E10)");
        let reported = branch
            .find("the key is still at")
            .expect("the error still names the retained path");
        assert!(
            note < reported,
            "recorded before the error returns: {note} vs {reported}"
        );
    }

    #[test]
    fn a_key_file_write_refuses_a_malformed_key() {
        // Nothing that is not a 64-hex key may be written: a malformed value
        // would look like an exported key and open nothing.
        let dir = TempDir::new("key-malformed");
        let out = dir.0.join("key.txt");
        let message = save_db_key_file_with_key(&out, "not-a-key")
            .expect_err("a malformed key must be refused");
        assert!(message.contains("malformed"), "{message}");
        assert!(!out.exists(), "nothing may be written for a bad key");
    }

    #[test]
    fn a_key_file_write_leaves_the_previous_file_intact_on_failure() {
        // P3-20: the destructive part of `truncate(true)` was that the old
        // contents were gone before the new bytes existed. A *failed* save must
        // not have emptied the file the user already had.
        let dir = TempDir::new("key-overwrite");
        let out = dir.0.join("key.txt");
        let previous = b"the key I already exported\n";
        std::fs::write(&out, previous).expect("seed the destination");

        // A path whose parent is a *file* cannot be created, so the write fails
        // before the temp file is opened.
        let blocked = dir.0.join("blocker").join("key.txt");
        std::fs::write(dir.0.join("blocker"), b"i am a file, not a directory")
            .expect("create the blocking file");
        let key = mint_key_hex().expect("mint key");
        let _ = save_db_key_file_with_key(&blocked, &key);

        assert_eq!(
            std::fs::read_to_string(&out).expect("read back"),
            String::from_utf8_lossy(previous),
            "an unrelated failed save must not have truncated the existing file"
        );
    }

    #[test]
    fn a_key_file_write_leaves_no_temp_file_when_it_fails() {
        // The temp file is the first thing written, so a failure before the
        // rename must not leave a partial key file sitting next to it.
        let dir = TempDir::new("key-temp-cleanup");
        let blocked = dir.0.join("blocker").join("key.txt");
        std::fs::write(dir.0.join("blocker"), b"not a directory").expect("blocking file");
        let key = mint_key_hex().expect("mint key");
        let _ = save_db_key_file_with_key(&blocked, &key);

        let leftovers: Vec<_> = std::fs::read_dir(&dir.0)
            .expect("read temp dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".purple-memo-tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "failed save left temp files behind: {leftovers:?}"
        );
    }

    // -- FTS5-under-SQLCipher spike (P1 scope) ------------------------------

    #[test]
    fn fts5_available_under_sqlcipher() {
        let conn = Connection::open_in_memory().expect("in-memory sqlcipher");
        conn.execute_batch("CREATE VIRTUAL TABLE docs USING fts5(title, body);")
            .expect("FTS5 must be compiled into SQLCipher");
        conn.execute(
            "INSERT INTO docs(title, body) VALUES (?1, ?2)",
            ["Purple Memo", "offline first notebook"],
        )
        .expect("insert into fts5");
        let hits = scalar_i64(
            &conn,
            "SELECT count(*) FROM docs WHERE docs MATCH 'notebook'",
        );
        assert_eq!(hits, 1);
        let misses = scalar_i64(
            &conn,
            "SELECT count(*) FROM docs WHERE docs MATCH 'nonexistentterm'",
        );
        assert_eq!(misses, 0);
    }

    // -- Encryption: mint-once, verify-before-use, wrong key rejected ------

    #[test]
    fn minted_key_is_64_hex_chars() {
        let key = mint_key_hex().expect("mint");
        assert!(is_key_hex(&key), "key must be 64 hex chars: {key}");
        let key2 = mint_key_hex().expect("mint");
        assert_ne!(key, key2, "distinct mints must be distinct keys");
    }

    #[test]
    fn validate_stored_key_accepts_64_hex_and_rejects_garbage() {
        let good = mint_key_hex().expect("mint");
        assert_eq!(validate_stored_key(&good).expect("valid key"), good);
        for bad in [
            "",
            "short",
            &"zz".repeat(32),
            &"0".repeat(63),
            &"0".repeat(65),
        ] {
            assert!(
                validate_stored_key(bad).is_err(),
                "must reject malformed key: {bad}"
            );
        }
    }

    #[test]
    fn encrypted_db_roundtrip_and_wrong_key_rejected() {
        let dir = TempDir::new("crypto");
        let key = mint_key_hex().expect("mint");
        {
            let conn = open_encrypted_db(&dir.db_path(), &key).expect("open + verify");
            conn.execute_batch("CREATE TABLE probe (v TEXT NOT NULL);")
                .expect("create table");
            conn.execute("INSERT INTO probe(v) VALUES ('secret')", [])
                .expect("insert");
        }
        // Right key: data comes back.
        let conn = open_encrypted_db(&dir.db_path(), &key).expect("reopen + verify");
        let value: String = conn
            .query_row("SELECT v FROM probe", [], |row| row.get(0))
            .expect("read probe");
        assert_eq!(value, "secret");
        drop(conn);

        // Wrong key: verification fails before any schema/data access.
        let wrong = "0".repeat(KEY_HEX_LEN);
        let err =
            open_encrypted_db(&dir.db_path(), &wrong).expect_err("wrong key must be rejected");
        assert!(
            err.contains("verification failed"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn malformed_keys_are_rejected_before_open() {
        let dir = TempDir::new("badkey");
        for bad in ["", "short", &"zz".repeat(32)] {
            assert!(open_encrypted_db(&dir.db_path(), bad).is_err());
        }
    }

    // -- Baseline schema: 32 tables, user_version = SCHEMA_VERSION, seeds, FK on

    #[test]
    fn baseline_schema_has_32_tables_and_the_declared_user_version() {
        // The number lives in schema::SCHEMA_VERSION; the old name hard-coded
        // `user_version 4` and went stale when v5 landed.
        let (_dir, conn) = open_baseline("schema");
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(version, schema::SCHEMA_VERSION);
        assert_eq!(table_count(&conn), 32);
    }

    // -- Hot foreign-key columns are indexed ---------------------

    #[test]
    fn expected_indexes_exist() {
        // Both the baseline and every migration carry these, so a fresh install
        // and an upgraded one are pinned against silent removal.
        let (_dir, conn) = open_baseline("indexes");
        for name in [
            "idx_notes_collection",
            "idx_contact_channels_contact",
            "idx_inbox_items_status",
            "idx_trash_items_entity",
            "idx_trash_items_deleted",
        ] {
            let count: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type='index' AND name=?",
                    [name],
                    |r| r.get(0),
                )
                .expect("index query");
            assert_eq!(count, 1, "index {name} must exist in the baseline schema");
        }
    }

    #[test]
    fn baseline_schema_seeds_wallets_and_categories() {
        let (_dir, conn) = open_baseline("seeds");
        assert_eq!(scalar_i64(&conn, "SELECT count(*) FROM wallets"), 5);
        assert_eq!(
            scalar_i64(&conn, "SELECT count(*) FROM expense_categories"),
            7
        );
        assert_eq!(
            scalar_i64(&conn, "SELECT count(*) FROM income_categories"),
            4
        );
        // Business income category is required by the paid-in-full flow.
        let business = scalar_i64(
            &conn,
            "SELECT count(*) FROM income_categories WHERE name = 'Business'",
        );
        assert_eq!(business, 1);
    }

    #[test]
    fn init_schema_is_idempotent_and_fresh_only() {
        let (_dir, conn) = open_baseline("idempotent");
        init_schema(&conn).expect("second init is a no-op");
        assert_eq!(table_count(&conn), 32);
    }

    // -- Sequential, forward-only migrations --------

    /// A database that looks exactly like a version-1 install: the current
    /// baseline with everything version 2 and later added removed again, stamped
    /// 1.
    ///
    /// Built by subtraction because `BASELINE_SQL` is one string that cannot be
    /// split by version — and "the baseline minus what came later" IS what a v1
    /// database is. The seeded rows are the point: a migration test against an
    /// empty database proves nothing about what it preserved.
    fn seeded_v1(tag: &str) -> (TempDir, Connection) {
        let dir = TempDir::new(tag);
        let key = mint_key_hex().expect("mint key");
        let conn = open_encrypted_db(&dir.db_path(), &key).expect("open encrypted db");
        conn.execute_batch(schema::BASELINE_SQL)
            .expect("apply baseline");
        conn.execute_batch(
            "DROP INDEX idx_links_a;
             DROP INDEX idx_links_b;
             DROP TABLE links;
             DROP INDEX idx_trash_items_entity;
             DROP INDEX idx_trash_items_deleted;
             DROP TABLE trash_items;
             DROP INDEX idx_inbox_items_status;
             DROP TABLE inbox_items;
             DROP INDEX idx_photo_refs_unique;
             DROP INDEX idx_reminders_fired_at;",
        )
        .expect("strip v2+ additions");
        conn.pragma_update(None, "user_version", 1i64)
            .expect("stamp v1");
        conn.execute_batch(
            "INSERT INTO collections (id, name, created_at) VALUES (1, 'Work', '2026-01-01');
             INSERT INTO notes (id, title, content, tags, collection_id, pinned, archived, created_at, updated_at)
               VALUES (1, 'Kept', 'body that fts must still find', 'a,b', 1, 0, 0, '2026-01-01', '2026-01-02');
             INSERT INTO settings (key, value) VALUES ('theme', 'dark');
             INSERT INTO tasks (id, title, due_date, done, repeat, note, created_at)
               VALUES (1, 'Existing task', NULL, 0, 'none', '', '2026-01-01');
             INSERT INTO journal_entries (id, entry_date, content, created_at, updated_at)
               VALUES (1, '2026-01-01', 'existing journal text', '2026-01-01', '2026-01-01');
             INSERT INTO contacts (id, name, address, birthday, notes, created_at)
               VALUES (1, 'A Contact', '', NULL, '', '2026-01-01');
             INSERT INTO contact_channels (id, contact_id, kind, value, is_primary, sort_order)
               VALUES (1, 1, 'phone', '123', 1, 0);",
        )
        .expect("seed representative v1 rows");
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(version, 1, "the fixture must be a v1 database");
        (dir, conn)
    }

    #[test]
    fn the_step_list_covers_every_version_gap() {
        // The framework is generic, so this is derived from SCHEMA_VERSION
        // rather than hard-coded: version 3 adds a migration and nothing here
        // changes. The upper bound matters as much as the gaps — a step past
        // the current version would never run, and would hide a typo.
        for step in 1..schema::SCHEMA_VERSION {
            assert!(
                migration_step(step).is_some(),
                "no migration defined from version {step}"
            );
        }
        assert_eq!(migration_step(schema::SCHEMA_VERSION), None);
        assert_eq!(
            migration_step(0),
            None,
            "a fresh database uses the baseline"
        );
    }

    #[test]
    fn a_v1_database_migrates_to_the_current_version_and_keeps_everything() {
        let (_dir, conn) = seeded_v1("migrate");
        assert_eq!(
            scalar_i64(
                &conn,
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='inbox_items'"
            ),
            0,
            "the fixture starts without the inbox"
        );

        init_schema(&conn).expect("migrate 1 -> current");

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(version, schema::SCHEMA_VERSION);
        assert_eq!(table_count(&conn), 32);
        // Data, FTS content, settings and foreign-key rows all survived.
        assert_eq!(scalar_i64(&conn, "SELECT count(*) FROM notes"), 1);
        let collection: i64 = conn
            .query_row("SELECT collection_id FROM notes WHERE id = 1", [], |r| {
                r.get(0)
            })
            .expect("note row");
        assert_eq!(collection, 1, "the note still points at its collection");
        assert_eq!(
            scalar_i64(
                &conn,
                "SELECT count(*) FROM notes_fts WHERE notes_fts MATCH 'fts'"
            ),
            1,
            "the FTS index still answers"
        );
        assert_eq!(
            conn.query_row("SELECT value FROM settings WHERE key = 'theme'", [], |r| {
                r.get::<_, String>(0)
            })
            .expect("settings row"),
            "dark"
        );
        assert_eq!(scalar_i64(&conn, "SELECT count(*) FROM tasks"), 1);
        assert_eq!(scalar_i64(&conn, "SELECT count(*) FROM journal_entries"), 1);
        assert_eq!(
            scalar_i64(
                &conn,
                "SELECT count(*) FROM contact_channels WHERE contact_id = 1"
            ),
            1
        );
        // Seeds from the baseline are still there — a migration must not
        // re-seed a database that already had them.
        assert_eq!(scalar_i64(&conn, "SELECT count(*) FROM wallets"), 5);
    }

    #[test]
    fn a_migrated_database_has_the_same_inbox_structure_as_a_fresh_baseline() {
        // The baseline and MIGRATION_1_2 repeat this DDL in two places (one raw
        // string cannot reference a const), so the agreement is pinned here
        // instead of trusted to a comment.
        let (_fresh_dir, fresh) = open_baseline("structure-fresh");
        let (_v1_dir, migrated) = seeded_v1("structure-migrated");
        init_schema(&migrated).expect("migrate");
        for name in ["inbox_items", "idx_inbox_items_status"] {
            let a: String = fresh
                .query_row(
                    "SELECT ifnull(sql, '') FROM sqlite_master WHERE name = ?",
                    [name],
                    |r| r.get(0),
                )
                .expect("fresh structure");
            let b: String = migrated
                .query_row(
                    "SELECT ifnull(sql, '') FROM sqlite_master WHERE name = ?",
                    [name],
                    |r| r.get(0),
                )
                .expect("migrated structure");
            assert_eq!(
                normalize_sql(&a),
                normalize_sql(&b),
                "{name} differs between a fresh baseline and a migrated database"
            );
        }
    }

    /// SQLite records the DDL as it was typed, so two textually different but
    /// equivalent definitions compare equal here and not in `assert_eq!`. Comments
    /// are dropped too: the two copies of this DDL sit under different explanatory
    /// comments, and only the DDL itself has to agree.
    fn normalize_sql(sql: &str) -> String {
        sql.lines()
            .filter(|line| !line.trim_start().starts_with("--"))
            .flat_map(|line| line.split_whitespace())
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[test]
    fn a_failed_migration_rolls_back_and_keeps_the_old_version() {
        let (_dir, conn) = seeded_v1("rollback");
        // The obstacle a real user could hit: an unrelated table already
        // sitting on the name the migration needs.
        conn.execute_batch("CREATE TABLE inbox_items (id INTEGER PRIMARY KEY)")
            .expect("plant the obstacle");
        let err = init_schema(&conn).expect_err("the migration must fail");
        assert!(
            err.contains("rolled back"),
            "the failure must name the rollback: {err}"
        );
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(
            version, 1,
            "a failed step must leave the old version stamped"
        );
        // And it must have changed nothing: the obstacle is still the
        // stranger it was, with none of the real columns.
        let columns = scalar_i64(
            &conn,
            "SELECT count(*) FROM pragma_table_info('inbox_items')",
        );
        assert_eq!(columns, 1, "the planted table must be untouched");
        // 29 v1 tables plus the planted stranger; the real one never appeared.
        assert_eq!(table_count(&conn), 30);
    }

    #[test]
    fn a_failed_migration_can_be_retried_once_the_obstacle_is_gone() {
        let (_dir, conn) = seeded_v1("retry");
        conn.execute_batch("CREATE TABLE inbox_items (id INTEGER PRIMARY KEY)")
            .expect("plant the obstacle");
        assert!(init_schema(&conn).is_err());
        conn.execute_batch("DROP TABLE inbox_items")
            .expect("clear the obstacle");
        init_schema(&conn).expect("the retry must succeed");
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(version, schema::SCHEMA_VERSION);
        assert_eq!(table_count(&conn), 32);
    }

    #[test]
    fn a_database_newer_than_this_build_is_refused_without_writing() {
        let (_dir, conn) = seeded_v1("newer");
        // A database from a hypothetical later build: stamped ahead of us, with
        // a table this build has never heard of.
        conn.execute_batch("CREATE TABLE future_feature (id INTEGER PRIMARY KEY)")
            .expect("plant a future table");
        conn.pragma_update(None, "user_version", schema::SCHEMA_VERSION + 1)
            .expect("stamp a future version");
        let tables_before = table_count(&conn);

        let err = init_schema(&conn).expect_err("a newer database must be refused");
        assert!(err.contains("newer"), "unexpected error: {err}");
        assert!(
            err.contains("downgrading"),
            "the refusal must say that downgrading is unsupported: {err}"
        );
        // Nothing was written: the version is untouched and no migration ran.
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(version, schema::SCHEMA_VERSION + 1);
        assert_eq!(
            table_count(&conn),
            tables_before,
            "no table was added or dropped"
        );
        assert_eq!(
            scalar_i64(
                &conn,
                "SELECT count(*) FROM sqlite_master WHERE name = 'inbox_items'"
            ),
            0,
            "the migration must not have run"
        );
        assert_eq!(
            scalar_i64(
                &conn,
                "SELECT count(*) FROM sqlite_master WHERE name = 'links'"
            ),
            0,
            "not even the newest migration ran"
        );
    }

    #[test]
    fn an_older_build_refuses_a_migrated_database_copy() {
        // downgrading across a schema migration is unsupported, and it
        // has to be tested on a COPY of a real migrated database rather than
        // asserted from reading the code. The legacy rule below is the pre-
        // The original `init_schema` behaviour: it knew exactly one version and
        // refused everything else.
        fn legacy_v1_would_open(conn: &Connection) -> Result<(), String> {
            let version: i64 = conn
                .pragma_query_value(None, "user_version", |row| row.get(0))
                .map_err(|e| e.to_string())?;
            if version > 1 {
                return Err(format!(
                    "DB user_version {version} is newer than supported 1; refusing to touch it"
                ));
            }
            Ok(())
        }

        let dir = TempDir::new("downgrade");
        let key = mint_key_hex().expect("mint key");
        {
            let conn = open_encrypted_db(&dir.db_path(), &key).expect("open");
            conn.execute_batch(schema::BASELINE_SQL).expect("baseline");
            conn.execute_batch(
                "DROP INDEX idx_links_a;
                 DROP INDEX idx_links_b;
                 DROP TABLE links;
                 DROP INDEX idx_trash_items_entity;
                 DROP INDEX idx_trash_items_deleted;
                 DROP TABLE trash_items;
                 DROP INDEX idx_inbox_items_status;
                 DROP TABLE inbox_items;
                 DROP INDEX idx_photo_refs_unique;
                 DROP INDEX idx_reminders_fired_at;",
            )
            .expect("strip v2+");
            conn.pragma_update(None, "user_version", 1i64)
                .expect("stamp v1");
            conn.execute_batch(
                "INSERT INTO collections (id, name, created_at) VALUES (7, 'marker', '2026-01-01');",
            )
            .expect("seed a marker row the refusal must not touch");
            init_schema(&conn).expect("migrate to the current version");
            // Checkpoint so the copy below carries every committed row.
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .expect("checkpoint");
        }

        // The copy is what gets handed to the "older binary".
        let copy = dir.0.join("migrated-copy.db");
        std::fs::copy(dir.db_path(), &copy).expect("copy the migrated database");
        let old_app = open_encrypted_db(&copy, &key).expect("open the copy");
        let err = legacy_v1_would_open(&old_app).expect_err("v1 must refuse a newer database");
        assert!(err.contains("newer than supported 1"), "unexpected: {err}");

        // The refusal wrote nothing: still at the current version, still the
        // rows, still no rows invented by a half-run migration.
        let version: i64 = old_app
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(version, schema::SCHEMA_VERSION);
        assert_eq!(scalar_i64(&old_app, "SELECT count(*) FROM inbox_items"), 0);
        assert_eq!(
            scalar_i64(&old_app, "SELECT count(*) FROM collections WHERE id = 7"),
            1,
            "the marker row must survive the refusal untouched"
        );
    }

    #[test]
    fn the_inbox_table_refuses_what_it_should() {
        let (_dir, conn) = open_baseline("inbox-ddl");
        // Capture must have something in it.
        for bad in ["", "   ", "\n\t "] {
            let err = conn.execute(
                "INSERT INTO inbox_items (body, created_at) VALUES (?1, '2026-01-01')",
                [bad],
            );
            assert!(err.is_err(), "whitespace-only body {bad:?} must be refused");
        }
        conn.execute(
            "INSERT INTO inbox_items (body, created_at) VALUES ('a thought', '2026-01-01')",
            [],
        )
        .expect("a real capture is accepted");
        // A converted row must name its target...
        assert!(
            conn.execute(
                "UPDATE inbox_items SET status = 'converted' WHERE id = 1",
                [],
            )
            .is_err(),
            "converted without a target must be refused"
        );
        conn.execute(
            "UPDATE inbox_items SET status = 'converted', converted_type = 'note', converted_id = 7 WHERE id = 1",
            [],
        )
        .expect("converted with a target is accepted");
        // ...and an archived row must not.
        assert!(
            conn.execute(
                "UPDATE inbox_items SET status = 'archived', converted_type = 'note', converted_id = 7 WHERE id = 1",
                [],
            )
            .is_err(),
            "archived rows must not carry a target"
        );
        assert!(
            conn.execute("UPDATE inbox_items SET status = 'weird' WHERE id = 1", [],)
                .is_err(),
            "an unknown status must be refused"
        );
        assert!(
            conn.execute(
                "UPDATE inbox_items SET converted_type = 'calendar' WHERE id = 1",
                [],
            )
            .is_err(),
            "an unknown target type must be refused"
        );
    }

    /// A database that looks exactly like a version-2 install: the current
    /// baseline with everything version 3+ added removed again, stamped 2, and
    /// carrying the rows a real user would have by then.
    fn seeded_v2(tag: &str) -> (TempDir, Connection) {
        let dir = TempDir::new(tag);
        let key = mint_key_hex().expect("mint key");
        let conn = open_encrypted_db(&dir.db_path(), &key).expect("open encrypted db");
        conn.execute_batch(schema::BASELINE_SQL)
            .expect("apply baseline");
        conn.execute_batch(
            "DROP INDEX idx_links_a;
             DROP INDEX idx_links_b;
             DROP TABLE links;
             DROP INDEX idx_trash_items_entity;
             DROP INDEX idx_trash_items_deleted;
             DROP TABLE trash_items;
             DROP INDEX idx_photo_refs_unique;
             DROP INDEX idx_reminders_fired_at;",
        )
        .expect("strip v3 additions");
        conn.pragma_update(None, "user_version", 2i64)
            .expect("stamp v2");
        conn.execute_batch(
            "INSERT INTO collections (id, name, created_at) VALUES (1, 'Work', '2026-01-01');
             INSERT INTO notes (id, title, content, tags, collection_id, pinned, archived, created_at, updated_at)
               VALUES (1, 'Kept', 'a v2 note', '', 1, 0, 0, '2026-01-01', '2026-01-01'),
                      (2, 'Archived one', 'still here', '', NULL, 0, 1, '2026-01-01', '2026-01-01');
             INSERT INTO tasks (id, title, due_date, done, repeat, note, created_at)
               VALUES (1, 'v2 task', NULL, 0, 'none', '', '2026-01-01');
             INSERT INTO contacts (id, name, address, birthday, notes, created_at)
               VALUES (1, 'v2 Contact', '', NULL, '', '2026-01-01');
             INSERT INTO inbox_items (body, status, created_at) VALUES ('a capture', 'open', '2026-01-01');",
        )
        .expect("seed representative v2 rows");
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(version, 2, "the fixture must be a v2 database");
        (dir, conn)
    }

    fn seeded_v3(tag: &str) -> (TempDir, Connection) {
        let dir = TempDir::new(tag);
        let key = mint_key_hex().expect("mint key");
        let conn = open_encrypted_db(&dir.db_path(), &key).expect("open encrypted db");
        conn.execute_batch(schema::BASELINE_SQL)
            .expect("apply baseline");
        conn.execute_batch(
            "DROP INDEX idx_trash_items_entity;
             DROP INDEX idx_trash_items_deleted;
             DROP TABLE trash_items;
             DROP INDEX idx_photo_refs_unique;
             DROP INDEX idx_reminders_fired_at;",
        )
        .expect("strip v4 addition");
        conn.pragma_update(None, "user_version", 3i64)
            .expect("stamp v3");
        (dir, conn)
    }

    #[test]
    fn a_v3_database_migrates_to_the_current_version_and_matches_the_baseline() {
        let (_dir, migrated) = seeded_v3("trash-migration");
        let (_fresh_dir, fresh) = open_baseline("trash-baseline");
        init_schema(&migrated).expect("migrate 3 -> 4");
        assert_eq!(table_count(&migrated), 32);
        for name in [
            "trash_items",
            "idx_trash_items_entity",
            "idx_trash_items_deleted",
        ] {
            let fresh_sql: String = fresh
                .query_row(
                    "SELECT ifnull(sql, '') FROM sqlite_master WHERE name = ?",
                    [name],
                    |row| row.get(0),
                )
                .expect("fresh structure");
            let migrated_sql: String = migrated
                .query_row(
                    "SELECT ifnull(sql, '') FROM sqlite_master WHERE name = ?",
                    [name],
                    |row| row.get(0),
                )
                .expect("migrated structure");
            assert_eq!(
                normalize_sql(&fresh_sql),
                normalize_sql(&migrated_sql),
                "{name} differs between fresh baseline and migration"
            );
        }
    }

    /// A database that looks exactly like a version-4 install (the first
    /// release): the current baseline with the two version-5 indexes removed
    /// again, stamped 4, and holding the duplicate `photo_refs` rows the
    /// unconstrained table allowed.
    fn seeded_v4(tag: &str) -> (TempDir, Connection) {
        let dir = TempDir::new(tag);
        let key = mint_key_hex().expect("mint key");
        let conn = open_encrypted_db(&dir.db_path(), &key).expect("open encrypted db");
        conn.execute_batch(schema::BASELINE_SQL)
            .expect("apply baseline");
        conn.execute_batch(
            "DROP INDEX idx_photo_refs_unique;
             DROP INDEX idx_reminders_fired_at;",
        )
        .expect("strip v5 additions");
        conn.pragma_update(None, "user_version", 4i64)
            .expect("stamp v4");
        conn.execute_batch(
            "INSERT INTO photos (id, rel_path, sha256, ext, size_bytes, taken_date, note, created_at)
               VALUES (1, 'photos/a.jpg', 'sha', 'jpg', 10, NULL, '', '2026-01-01');
             INSERT INTO photo_refs (id, photo_id, entity_type, entity_id)
               VALUES (10, 1, 'note', 1),
                      (11, 1, 'note', 1),
                      (12, 1, 'note', 2);",
        )
        .expect("seed duplicate refs");
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(version, 4, "the fixture must be a v4 database");
        (dir, conn)
    }

    #[test]
    fn a_v4_database_migrates_to_v5_and_de_duplicates_photo_refs() {
        let (_dir, migrated) = seeded_v4("phase9-migration");
        let (_fresh_dir, fresh) = open_baseline("phase9-baseline");
        init_schema(&migrated).expect("migrate 4 -> 5");

        let version: i64 = migrated
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(version, schema::SCHEMA_VERSION);

        // The duplicate collapses onto the oldest row; the distinct link is
        // kept, so de-duplication never costs a user a real association.
        let mut statement = migrated
            .prepare("SELECT id, entity_id FROM photo_refs ORDER BY id")
            .expect("prepare photo_refs read");
        let rows: Vec<(i64, i64)> = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("read photo_refs")
            .collect::<Result<_, _>>()
            .expect("collect photo_refs");
        drop(statement);
        assert_eq!(rows, vec![(10, 1), (12, 2)]);

        // From now on SQLite refuses the duplicate, not just the page.
        assert!(
            migrated
                .execute(
                    "INSERT INTO photo_refs (photo_id, entity_type, entity_id) VALUES (1, 'note', 1)",
                    [],
                )
                .is_err(),
            "a duplicate photo reference must be refused by the schema"
        );

        for name in ["idx_photo_refs_unique", "idx_reminders_fired_at"] {
            let fresh_sql: String = fresh
                .query_row(
                    "SELECT ifnull(sql, '') FROM sqlite_master WHERE name = ?",
                    [name],
                    |row| row.get(0),
                )
                .expect("fresh structure");
            let migrated_sql: String = migrated
                .query_row(
                    "SELECT ifnull(sql, '') FROM sqlite_master WHERE name = ?",
                    [name],
                    |row| row.get(0),
                )
                .expect("migrated structure");
            assert!(!fresh_sql.is_empty(), "{name} missing from the baseline");
            assert_eq!(
                normalize_sql(&fresh_sql),
                normalize_sql(&migrated_sql),
                "{name} differs between fresh baseline and migration"
            );
        }
    }

    #[test]
    fn a_failed_trash_migration_rolls_back_and_can_be_retried() {
        let (_dir, conn) = seeded_v3("trash-rollback");
        conn.execute_batch("CREATE TABLE trash_items (id INTEGER PRIMARY KEY)")
            .expect("plant migration obstacle");
        let error = init_schema(&conn).expect_err("migration should fail");
        assert!(error.contains("rolled back"), "unexpected error: {error}");
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read version");
        assert_eq!(version, 3);
        assert_eq!(
            scalar_i64(
                &conn,
                "SELECT count(*) FROM pragma_table_info('trash_items')"
            ),
            1,
            "the obstruction remains untouched"
        );
        conn.execute_batch("DROP TABLE trash_items")
            .expect("remove migration obstacle");
        init_schema(&conn).expect("retry succeeds");
        assert_eq!(table_count(&conn), 32);
    }

    #[test]
    fn a_v2_database_migrates_to_the_current_version_and_keeps_everything() {
        let (_dir, conn) = seeded_v2("migrate-v4");
        assert_eq!(
            scalar_i64(
                &conn,
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='links'"
            ),
            0,
            "the fixture starts without links"
        );

        init_schema(&conn).expect("migrate 2 -> 3 -> 4");

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(version, schema::SCHEMA_VERSION);
        assert_eq!(table_count(&conn), 32);
        // Everything version 2 held is still there, including what the v2
        // migration added — a v2 database is one that already had the capture inbox.
        assert_eq!(scalar_i64(&conn, "SELECT count(*) FROM notes"), 2);
        assert_eq!(scalar_i64(&conn, "SELECT count(*) FROM tasks"), 1);
        assert_eq!(scalar_i64(&conn, "SELECT count(*) FROM contacts"), 1);
        assert_eq!(scalar_i64(&conn, "SELECT count(*) FROM inbox_items"), 1);
        assert_eq!(
            scalar_i64(&conn, "SELECT archived FROM notes WHERE id = 2"),
            1,
            "an archived note stays archived"
        );
        assert_eq!(scalar_i64(&conn, "SELECT count(*) FROM wallets"), 5);
    }

    #[test]
    fn a_v1_database_walks_every_step_in_order() {
        // The real upgrade path for someone on the pre-capture release: 1 -> 2
        // -> 3 -> 4, one transaction per step.
        let (_dir, conn) = seeded_v1("walk-1-to-4");
        init_schema(&conn).expect("migrate 1 -> 2 -> 3 -> 4");
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(version, schema::SCHEMA_VERSION);
        assert_eq!(table_count(&conn), 32);
        assert_eq!(
            scalar_i64(
                &conn,
                "SELECT count(*) FROM sqlite_master WHERE name='inbox_items'"
            ),
            1
        );
        assert_eq!(
            scalar_i64(
                &conn,
                "SELECT count(*) FROM sqlite_master WHERE name='links'"
            ),
            1
        );
        assert_eq!(
            scalar_i64(
                &conn,
                "SELECT count(*) FROM sqlite_master WHERE name='trash_items'"
            ),
            1
        );
        // A second run changes nothing.
        init_schema(&conn).expect("second run is a no-op");
        assert_eq!(table_count(&conn), 32);
    }

    #[test]
    fn a_failed_links_migration_rolls_back_and_retries() {
        let (_dir, conn) = seeded_v2("links-rollback");
        conn.execute_batch("CREATE TABLE links (id INTEGER PRIMARY KEY)")
            .expect("plant the obstacle");
        let err = init_schema(&conn).expect_err("the migration must fail");
        assert!(err.contains("rolled back"), "unexpected error: {err}");
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(version, 2, "a failed step keeps the old version");
        assert_eq!(
            scalar_i64(&conn, "SELECT count(*) FROM pragma_table_info('links')"),
            1,
            "the planted table is untouched"
        );
        conn.execute_batch("DROP TABLE links").expect("clear it");
        init_schema(&conn).expect("the retry succeeds");
        assert_eq!(table_count(&conn), 32);
    }

    #[test]
    fn a_migrated_links_table_matches_a_fresh_baseline() {
        let (_fresh_dir, fresh) = open_baseline("links-structure-fresh");
        let (_v2_dir, migrated) = seeded_v2("links-structure-migrated");
        init_schema(&migrated).expect("migrate");
        for name in ["links", "idx_links_a", "idx_links_b"] {
            let a: String = fresh
                .query_row(
                    "SELECT ifnull(sql, '') FROM sqlite_master WHERE name = ?",
                    [name],
                    |r| r.get(0),
                )
                .expect("fresh");
            let b: String = migrated
                .query_row(
                    "SELECT ifnull(sql, '') FROM sqlite_master WHERE name = ?",
                    [name],
                    |r| r.get(0),
                )
                .expect("migrated");
            assert_eq!(
                normalize_sql(&a),
                normalize_sql(&b),
                "{name} differs between a fresh baseline and a migrated database"
            );
        }
    }

    #[test]
    fn the_links_table_refuses_what_it_should() {
        let (_dir, conn) = open_baseline("links-ddl");
        let ok = "INSERT INTO links (kind, type_a, id_a, type_b, id_b, created_at)
                  VALUES ('related', ?, ?, ?, ?, '2026-10-19')";
        // Canonical order first: 'contact' < 'note' < 'task' by BINARY.
        conn.execute(ok, ["contact", "1", "note", "1"])
            .expect("contact before note is canonical");
        conn.execute(ok, ["note", "2", "note", "3"])
            .expect("same type, ascending id");
        // The same relationship again, in either direction, is one row.
        assert!(
            conn.execute(ok, ["contact", "1", "note", "1"]).is_err(),
            "a duplicate pair must be refused"
        );
        assert!(
            conn.execute(
                "INSERT INTO links (kind, type_a, id_a, type_b, id_b, created_at)
                 VALUES ('related', 'note', 1, 'contact', 1, '2026-10-19')",
                []
            )
            .is_err(),
            "the reverse of an existing pair is the same relationship"
        );
        // An entity related to itself is not a relationship.
        assert!(
            conn.execute(ok, ["note", "5", "note", "5"]).is_err(),
            "a self-link must be refused"
        );
        // Non-canonical storage is refused at the storage layer, not only in TS.
        assert!(
            conn.execute(ok, ["task", "1", "contact", "1"]).is_err(),
            "an out-of-order pair must be refused"
        );
        // Unknown kinds and types, and non-positive ids.
        assert!(
            conn.execute(
                "INSERT INTO links (kind, type_a, id_a, type_b, id_b, created_at)
                 VALUES ('parent', 'note', 1, 'task', 1, '2026-10-19')",
                []
            )
            .is_err(),
            "an unknown kind must be refused"
        );
        assert!(
            conn.execute(
                "INSERT INTO links (kind, type_a, id_a, type_b, id_b, created_at)
                 VALUES ('related', 'journal', 1, 'task', 1, '2026-10-19')",
                []
            )
            .is_err(),
            "an unlinkable type must be refused"
        );
        for bad_id in ["0", "-3"] {
            assert!(
                conn.execute(ok, ["contact", bad_id, "note", "9"]).is_err(),
                "id {bad_id} must be refused"
            );
        }
        // A link row is not a foreign key, so this insert SUCCEEDS: endpoint
        // existence is the application's rule, checked in one statement by
        // `entityLinks.ts`. Pinned here so the absence is a fact, not a
        // surprise in a later phase.
        conn.execute(ok, ["contact", "999", "task", "999"])
            .expect("endpoint existence is not the table's job to enforce");
        assert_eq!(scalar_i64(&conn, "SELECT count(*) FROM links"), 3);
    }

    #[test]
    fn links_can_be_found_from_either_end() {
        let (_dir, conn) = open_baseline("links-index");
        conn.execute(
            "INSERT INTO links (kind, type_a, id_a, type_b, id_b, created_at)
             VALUES ('related', 'note', 1, 'task', 7, '2026-10-19')",
            [],
        )
        .expect("link note 1 <-> task 7");
        for sql in [
            "SELECT id_b FROM links WHERE type_a = 'note' AND id_a = 1",
            "SELECT id_a FROM links WHERE type_b = 'task' AND id_b = 7",
        ] {
            let found: i64 = conn.query_row(sql, [], |r| r.get(0)).expect(sql);
            assert!(found > 0, "a relationship must be reachable from both ends");
        }
        assert_eq!(
            scalar_i64(
                &conn,
                "SELECT count(*) FROM sqlite_master WHERE name = 'idx_links_a'"
            ),
            1
        );
        assert_eq!(
            scalar_i64(
                &conn,
                "SELECT count(*) FROM sqlite_master WHERE name = 'idx_links_b'"
            ),
            1
        );
    }

    #[test]
    fn foreign_keys_and_checks_enforced() {
        let (_dir, conn) = open_baseline("fk");
        // FK: expense entry naming a nonexistent wallet must fail.
        let fk_err = conn.execute(
            "INSERT INTO expense_entries
               (amount_cents, category_id, wallet_id, entry_date, created_at)
             VALUES (1500, 1, 99999, '2026-10-09', '2026-10-09')",
            [],
        );
        assert!(fk_err.is_err(), "FK violation must be rejected");
        // CHECK: non-positive money must fail.
        let check_err = conn.execute(
            "INSERT INTO expense_entries
               (amount_cents, category_id, wallet_id, entry_date, created_at)
             VALUES (-5, 1, 1, '2026-10-09', '2026-10-09')",
            [],
        );
        assert!(check_err.is_err(), "CHECK violation must be rejected");
        // Happy path with seeds (wallet 1 + category 1 exist).
        conn.execute(
            "INSERT INTO expense_entries
               (amount_cents, category_id, wallet_id, entry_date, created_at)
             VALUES (1500, 1, 1, '2026-10-09', '2026-10-09')",
            [],
        )
        .expect("valid insert");
    }

    #[test]
    fn settings_table_is_usable() {
        let (_dir, conn) = open_baseline("settings");
        execute(
            &conn,
            "INSERT INTO settings(key, value) VALUES (?1, ?2)",
            &[json!("theme"), json!("dark")],
        )
        .expect("insert setting");
        execute(
            &conn,
            "INSERT INTO settings(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            &[json!("theme"), json!("light")],
        )
        .expect("upsert setting");
        let rows = query_rows(
            &conn,
            "SELECT value FROM settings WHERE key = ?1",
            &[json!("theme")],
        )
        .expect("read setting");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("value"), Some(&json!("light")));
    }

    // -- notes_fts triggers (title/content/tags/folder) --------------------

    #[test]
    fn notes_fts_triggers_track_insert_update_delete() {
        let (_dir, conn) = open_baseline("fts");
        execute(
            &conn,
            "INSERT INTO collections (name, created_at) VALUES (?1, ?2)",
            &[json!("Ideas"), json!("2026-10-09")],
        )
        .expect("insert collection");
        execute(
            &conn,
            "INSERT INTO notes (title, content, tags, collection_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, 1, '2026-10-09', '2026-10-09')",
            &[
                json!("Grocery budget"),
                json!("buy purple yams"),
                json!("money,food"),
            ],
        )
        .expect("insert note");

        let count = |term: &str| -> i64 {
            scalar_i64(
                &conn,
                &format!("SELECT count(*) FROM notes_fts WHERE notes_fts MATCH '{term}'"),
            )
        };
        assert_eq!(count("yams"), 1, "content indexed");
        assert_eq!(count("money"), 1, "tags indexed");
        assert_eq!(count("ideas"), 1, "folder (collection name) indexed");
        assert_eq!(count("budget"), 1, "title indexed");

        execute(
            &conn,
            "UPDATE notes SET title = 'Grocery plan' WHERE id = 1",
            &[],
        )
        .expect("update note");
        assert_eq!(count("budget"), 0, "old title token dropped");
        assert_eq!(count("plan"), 1, "new title token indexed");

        conn.execute("DELETE FROM notes WHERE id = 1", [])
            .expect("delete note");
        assert_eq!(count("plan"), 0, "delete removes fts row");
        assert_eq!(count("yams"), 0);
    }

    // -- db_batch atomicity, transactions, parameter binding ----------------

    #[test]
    fn db_batch_is_atomic() {
        let (_dir, conn) = open_baseline("batch");
        let good = BatchStatement {
            sql: "INSERT INTO settings(key, value) VALUES (?1, ?2)".to_string(),
            params: vec![json!("k1"), json!("v1")],
        };
        // Duplicate keys inside one statement -> UNIQUE violation mid-batch.
        let bad = BatchStatement {
            sql: "INSERT INTO settings(key, value) VALUES ('dup', 'x'), ('dup', 'y')".to_string(),
            params: vec![],
        };
        let err = batch(&conn, &[good.clone(), bad]).expect_err("batch must fail");
        assert!(err.contains("rolled back"), "unexpected error: {err}");
        let rows = scalar_i64(&conn, "SELECT count(*) FROM settings");
        assert_eq!(rows, 0, "failed batch must leave no rows behind");

        // A clean batch commits everything.
        batch(
            &conn,
            &[
                good,
                BatchStatement {
                    sql: "INSERT INTO settings(key, value) VALUES (?1, ?2)".to_string(),
                    params: vec![json!("k2"), json!("v2")],
                },
            ],
        )
        .expect("clean batch commits");
        assert_eq!(scalar_i64(&conn, "SELECT count(*) FROM settings"), 2);
    }

    #[test]
    fn manual_transaction_commit_and_rollback() {
        let (_dir, conn) = open_baseline("tx");
        conn.execute_batch("CREATE TABLE t (v TEXT NOT NULL)")
            .expect("scratch table");

        // Rollback discards.
        begin_tx(&conn).expect("begin");
        conn.execute("INSERT INTO t(v) VALUES ('gone')", [])
            .unwrap();
        rollback_tx(&conn).expect("rollback");
        assert_eq!(scalar_i64(&conn, "SELECT count(*) FROM t"), 0);

        // Commit keeps.
        begin_tx(&conn).expect("begin");
        conn.execute("INSERT INTO t(v) VALUES ('kept')", [])
            .unwrap();
        commit_tx(&conn).expect("commit");
        assert_eq!(scalar_i64(&conn, "SELECT count(*) FROM t"), 1);

        // Nested begin is rejected by SQLite itself.
        begin_tx(&conn).expect("begin");
        assert!(begin_tx(&conn).is_err(), "nested begin must fail");
        rollback_tx(&conn).expect("cleanup rollback");

        // Commit/rollback without a transaction fail.
        assert!(commit_tx(&conn).is_err());
        assert!(rollback_tx(&conn).is_err());

        // A batch's own statements run inside the batch's transaction, so a
        // transaction-control statement smuggled into `execute` or any batch
        // statement is refused (the `txn_open` state machine).
        // `batch` while a manual transaction is already open is refused by
        // `db_batch` in commands.rs (flag check, not reachable here); at this
        // layer the equivalent guard is: an open manual transaction makes a
        // second BEGIN fail, and a COMMIT smuggled through `execute` is
        // rejected before it can close the manual transaction behind the
        // flag's back.
        begin_tx(&conn).expect("begin");
        let err = execute(&conn, "COMMIT", &[]).expect_err("COMMIT must be refused");
        assert!(err.contains("not allowed"), "unexpected error: {err}");
        assert!(begin_tx(&conn).is_err(), "manual txn still open");
        rollback_tx(&conn).expect("cleanup rollback");
    }

    // -- E12: the break-glass reconcile ----------------------------------

    #[test]
    fn reconcile_rolls_back_a_real_transaction_for_real() {
        // E12: `db_reset_txn` used to clear only the flag, leaving SQLite's
        // transaction open — later writes would join it and vanish on close.
        // The reconcile must actually end the transaction SQLite's side.
        let (_dir, conn) = open_baseline("reconcile-open");
        conn.execute_batch("CREATE TABLE t (v TEXT NOT NULL)")
            .expect("scratch table");
        begin_tx(&conn).expect("begin");
        conn.execute("INSERT INTO t(v) VALUES ('abandoned')", [])
            .expect("uncommitted row");
        assert!(!conn.is_autocommit(), "a transaction really is open");

        reconcile_open_txn(&conn).expect("the rollback is the break-glass step");

        assert!(
            conn.is_autocommit(),
            "SQLite agrees the transaction is over"
        );
        assert_eq!(
            scalar_i64(&conn, "SELECT count(*) FROM t"),
            0,
            "the abandoned rows are discarded, not silently kept"
        );
        // And the connection is usable again — the state the flag promised.
        begin_tx(&conn).expect("a fresh transaction after the reconcile");
        rollback_tx(&conn).expect("cleanup");
    }

    #[test]
    fn reconcile_is_a_noop_when_no_transaction_is_open() {
        // The flag can be stale in the other direction (already committed,
        // never cleared): reconciling must succeed without doing anything.
        let (_dir, conn) = open_baseline("reconcile-idle");
        assert!(conn.is_autocommit());
        reconcile_open_txn(&conn).expect("idempotent");
        reconcile_open_txn(&conn).expect("and still idempotent");
        conn.execute("INSERT INTO settings (key, value) VALUES ('k', 'v')", [])
            .expect("ordinary writes still work");
        assert!(conn.is_autocommit(), "autocommit writes commit as ever");
    }

    // -- The statement guard --------------------------------

    #[test]
    fn db_query_cannot_commit_or_begin_around_the_txn_flag() {
        // the guard used to run on writes only, so a READ could commit an
        // open manual transaction while `txn_open` stayed true, or open one
        // the flag never knew about — after which every batch failed for the
        // life of the process.
        let (_dir, conn) = open_baseline("query-txn");
        conn.execute_batch("CREATE TABLE t (v TEXT NOT NULL)")
            .expect("scratch table");

        begin_tx(&conn).expect("begin");
        conn.execute("INSERT INTO t(v) VALUES ('x')", []).unwrap();

        for smuggled in [
            "COMMIT",
            "BEGIN",
            "END",
            "ROLLBACK",
            "SAVEPOINT s",
            "RELEASE s",
        ] {
            let err = query_rows(&conn, smuggled, &[])
                .expect_err("db_query must refuse transaction control");
            assert!(
                err.contains("transaction-control"),
                "{smuggled} gave: {err}"
            );
        }
        // The transaction is untouched, so the flag still matches reality.
        assert!(
            begin_tx(&conn).is_err(),
            "the manual txn must still be open"
        );
        rollback_tx(&conn).expect("cleanup rollback");
        assert_eq!(scalar_i64(&conn, "SELECT count(*) FROM t"), 0);
    }

    #[test]
    fn the_guard_sees_through_leading_comments() {
        // the old check read only the first whitespace-separated token, so
        // `-- x\nCOMMIT` and `/*c*/COMMIT` both passed while SQLite happily
        // prepared the COMMIT underneath.
        for smuggled in [
            "-- a helpful comment\nCOMMIT",
            "/*c*/COMMIT",
            "  \n\t -- comment\n  ROLLBACK",
            "/* multi\nline */ BEGIN",
        ] {
            let err = reject_dangerous_statement(smuggled)
                .expect_err("a comment must not hide the statement");
            assert!(
                err.contains("transaction-control"),
                "{smuggled:?} gave: {err}"
            );
        }
    }

    #[test]
    fn attach_and_detach_are_refused() {
        // After an ATTACH, `CREATE TABLE other.t` creates or overwrites a file
        // anywhere the process can write, and `SELECT * FROM other.t` reads
        // any SQLite file on disk.
        for smuggled in [
            "ATTACH DATABASE '/tmp/evil.db' AS other",
            "attach database '/tmp/evil.db' as other",
            "  -- note\n  ATTACH DATABASE 'x' AS y",
            "DETACH DATABASE other",
        ] {
            let err =
                reject_dangerous_statement(smuggled).expect_err("ATTACH/DETACH must be refused");
            assert!(
                err.contains("outside this database"),
                "{smuggled:?} gave: {err}"
            );
        }
    }

    #[test]
    fn pragma_key_and_rekey_are_refused() {
        // `PRAGMA rekey` re-encrypts the whole file under a key that never
        // reaches the credential store: silent, total data loss.
        for smuggled in [
            "PRAGMA key = \"x'00'\"",
            "PRAGMA rekey = \"x'00'\"",
            "pragma rekey=\"x'00'\"",
            "  PRAGMA main.rekey = \"x'00'\"",
            "PRAGMA \"rekey\" = \"x'00'\"",
            "-- c\nPRAGMA rekey = \"x'00'\"",
            // The three SQLite identifier-quoting forms. Only `"` was accepted
            // before review P3-2, so these three scanned as an EMPTY name,
            // matched neither KEY nor REKEY, and reached SQLite — which then
            // re-encrypted the database exactly as the guard exists to prevent.
            "PRAGMA [rekey] = \"x'00'\"",
            "PRAGMA [key] = \"x'00'\"",
            "PRAGMA `rekey` = \"x'00'\"",
            "PRAGMA `key` = \"x'00'\"",
            "  PRAGMA main.[rekey] = \"x'00'\"",
            "PRAGMA [main].[rekey] = \"x'00'\"",
            "PRAGMA [\"rekey\"] = \"x'00'\"",
            "-- c\nPRAGMA [rekey] = \"x'00'\"",
        ] {
            let err =
                reject_dangerous_statement(smuggled).expect_err("PRAGMA key/rekey must be refused");
            assert!(err.contains("credential store"), "{smuggled:?} gave: {err}");
        }
    }

    #[test]
    fn the_guard_allows_every_statement_the_app_actually_issues() {
        // A guard that broke real SQL would be worse than none. This is the
        // app's whole vocabulary, including the only pragma the frontend uses
        // (the backup import toggles foreign_keys) and partial UPDATE lists
        // built by interpolating validated identifiers.
        for legit in [
            "SELECT * FROM settings WHERE key = ?",
            "SELECT 1",
            "WITH x AS (SELECT 1) SELECT * FROM x",
            "INSERT INTO settings (key, value) VALUES (?, ?)",
            "UPDATE vault_items SET ciphertext = ?, salt = ?, iv = ?, updated_at = ? WHERE id = ?",
            "DELETE FROM vault_items WHERE id = ?",
            // backup.ts toggles these around the import.
            "PRAGMA foreign_keys = OFF",
            "PRAGMA foreign_keys = ON",
            "PRAGMA user_version",
            // Comments are legal prefix on a legitimate statement.
            "-- pick the newest\nSELECT * FROM notes ORDER BY created_at DESC",
            "/* filtered */ DELETE FROM drafts WHERE id = ?",
        ] {
            reject_dangerous_statement(legit)
                .unwrap_or_else(|e| panic!("{legit:?} must be allowed, got: {e}"));
        }
    }

    #[test]
    fn a_batch_rolls_back_and_says_so() {
        let (_dir, conn) = open_baseline("batch-rollback");
        let err = batch(
            &conn,
            &[
                BatchStatement {
                    sql: "INSERT INTO settings(key, value) VALUES (?1, ?2)".to_string(),
                    params: vec![json!("k1"), json!("v1")],
                },
                BatchStatement {
                    sql: "INSERT INTO nope_missing_table(x) VALUES (1)".to_string(),
                    params: vec![],
                },
            ],
        )
        .expect_err("the second statement must fail the batch");
        assert!(err.contains("rolled back"), "unexpected error: {err}");
        // Nothing survived.
        assert_eq!(scalar_i64(&conn, "SELECT count(*) FROM settings"), 0);
        // And the connection is usable again.
        batch(
            &conn,
            &[BatchStatement {
                sql: "INSERT INTO settings(key, value) VALUES (?1, ?2)".to_string(),
                params: vec![json!("k1"), json!("v1")],
            }],
        )
        .expect("the connection is not wedged");
        assert_eq!(scalar_i64(&conn, "SELECT count(*) FROM settings"), 1);
    }

    // -- Connection pragmas --------------------------------------

    #[test]
    fn the_connection_waits_for_a_busy_lock_instead_of_failing_instantly() {
        let dir = TempDir::new("busy");
        let key = mint_key_hex().expect("mint key");
        let conn = open_encrypted_db(&dir.db_path(), &key).expect("open");

        // WAL and FK enforcement are still on (they were already asserted
        // nowhere, which is the other half of this gap).
        let journal: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .expect("journal_mode");
        assert_eq!(journal.to_lowercase(), "wal");
        let fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .expect("foreign_keys");
        assert_eq!(fk, 1, "foreign_keys must be enforced");

        // The busy handler is actually installed.
        let timeout_ms: i64 = conn
            .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
            .expect("busy_timeout");
        assert_eq!(timeout_ms, (BUSY_TIMEOUT_SECS * 1000) as i64);
    }

    #[test]
    fn a_contended_write_waits_for_the_lock_instead_of_failing_instantly() {
        // SQLite's busy handler is off by default, so any contention was
        // an instant SQLITE_BUSY. The app connection's timeout is asserted in
        // `the_connection_waits_for_a_busy_lock_instead_of_failing_instantly`;
        // here we prove the mechanism itself — a blocked writer waits, and is
        // only refused once the timeout is actually spent.
        let dir = TempDir::new("busy2");
        let key = mint_key_hex().expect("mint key");
        let holder = open_encrypted_db(&dir.db_path(), &key).expect("open holder");
        init_schema(&holder).expect("init schema");

        let contender = open_encrypted_db(&dir.db_path(), &key).expect("open contender");
        // A short timeout so the test stays fast; the app uses 5 s.
        contender
            .busy_timeout(std::time::Duration::from_millis(300))
            .expect("set short timeout");

        // Hold a write transaction open from the other connection.
        begin_tx(&holder).expect("begin");
        holder
            .execute("INSERT INTO settings(key, value) VALUES ('k', 'v')", [])
            .expect("writer takes the lock");

        let started = std::time::Instant::now();
        let result = contender.execute("INSERT INTO settings(key, value) VALUES ('k2', 'v2')", []);
        let waited = started.elapsed();

        assert!(result.is_err(), "the contended write must be refused");
        assert!(
            waited >= std::time::Duration::from_millis(250),
            "the writer must WAIT for the lock, not fail instantly (waited {waited:?})"
        );

        // Once the holder is done the same statement succeeds, so the refusal
        // was contention and not a broken connection.
        commit_tx(&holder).expect("release the lock");
        contender
            .execute("INSERT INTO settings(key, value) VALUES ('k2', 'v2')", [])
            .expect("the write succeeds once the lock is free");
    }

    #[test]
    fn param_binding_and_row_mapping_roundtrip() {
        let conn = Connection::open_in_memory().expect("in-memory");
        conn.execute_batch("CREATE TABLE t (i INTEGER, r REAL, s TEXT, b BLOB, n TEXT)")
            .expect("scratch table");
        let outcome = execute(
            &conn,
            "INSERT INTO t (i, r, s, b, n) VALUES (?1, ?2, ?3, ?4, ?5)",
            &[
                json!(42),
                json!(1.5),
                json!("hello"),
                json!([1, 2, 255]),
                JsonValue::Null,
            ],
        )
        .expect("insert with params");
        assert_eq!(outcome.rows_affected, 1);
        assert_eq!(outcome.last_insert_rowid, 1);

        let rows = query_rows(
            &conn,
            "SELECT i, r, s, b, n FROM t WHERE i = ?1",
            &[json!(42)],
        )
        .expect("read back");
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.get("i"), Some(&json!(42)));
        assert_eq!(row.get("r"), Some(&json!(1.5)));
        assert_eq!(row.get("s"), Some(&json!("hello")));
        assert_eq!(row.get("b"), Some(&json!([1, 2, 255])));
        assert_eq!(row.get("n"), Some(&JsonValue::Null));

        // Unsupported param shapes are rejected, not mangled.
        assert!(execute(&conn, "INSERT INTO t (i) VALUES (?1)", &[json!({"a": 1})],).is_err());
        assert!(execute(&conn, "INSERT INTO t (b) VALUES (?1)", &[json!([1, 300])],).is_err());
    }

    // -- IPC contract with the JS driver (src/data/driver.ts) ----------------

    #[test]
    fn execute_outcome_serializes_camel_case_for_the_js_driver() {
        let outcome = ExecuteOutcome {
            rows_affected: 3,
            last_insert_rowid: 42,
        };
        let v = serde_json::to_value(&outcome).expect("serialize outcome");
        assert_eq!(v.get("rowsAffected"), Some(&json!(3)));
        assert_eq!(v.get("lastInsertRowid"), Some(&json!(42)));
        assert!(
            v.get("rows_affected").is_none() && v.get("last_insert_rowid").is_none(),
            "snake_case keys must not cross the IPC boundary: {v}"
        );
    }

    // -- Error messages that reach the renderer ----------------

    #[test]
    fn query_and_execute_errors_name_the_operation_but_never_the_statement() {
        // Every driver error used to append `\nSQL: {sql}` — the full
        // statement — into a string the renderer shows to the user. Values are
        // bound, so this was never injection, but a future statement that
        // interpolated text would put a note's content into an error banner,
        // and every screenshot of a failure carried raw SQL. The statement is
        // gone from the message; the operation and the driver's own reason
        // stay.
        let conn = Connection::open_in_memory().expect("in-memory");

        let secret = "the private note body nobody asked to see";
        let prep = query_rows(
            &conn,
            &format!("SELECT * FROM no_such_table WHERE body = '{secret}'"),
            &[],
        )
        .expect_err("no such table must fail at prepare");
        assert!(
            prep.contains("prepare failed:"),
            "the operation must be named: {prep}"
        );
        assert!(!prep.contains("SQL:"), "no statement text: {prep}");
        assert!(
            !prep.contains(secret),
            "no fragment of the statement may leak: {prep}"
        );

        execute(
            &conn,
            "CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
            &[],
        )
        .expect("create the table");
        let exec = execute(&conn, "INSERT INTO kv (k, v) VALUES ('a', NULL)", &[])
            .expect_err("NULL violates NOT NULL");
        assert!(
            exec.contains("execute failed:"),
            "the operation must be named: {exec}"
        );
        assert!(!exec.contains("SQL:"), "no statement text: {exec}");
        assert!(
            !exec.contains("INSERT INTO"),
            "no statement fragment may leak: {exec}"
        );
    }
}

#[cfg(test)]
mod factory_reset_seam_tests {
    use super::{close_connection_for_reset, db_file_paths, AppState, DB_FILE_NAME};
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;
    use std::sync::Mutex;

    /// Self-cleaning temp dir (the `mod tests` helper is private to it).
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("purple-memo-p9-db-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }

        fn db_path(&self) -> PathBuf {
            self.0.join(DB_FILE_NAME)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Pins the three file names factory reset removes as one component. A
    /// renamed sidecar that this list did not follow would survive a "reset
    /// complete" as leftover user data.
    #[test]
    fn db_file_paths_names_the_database_and_both_sidecars() {
        let paths = db_file_paths(std::path::Path::new("/data"));
        let names: Vec<String> = paths
            .iter()
            .map(|p| {
                p.file_name()
                    .expect("file name")
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert_eq!(
            names,
            vec![
                DB_FILE_NAME.to_string(),
                format!("{DB_FILE_NAME}-wal"),
                format!("{DB_FILE_NAME}-shm"),
            ]
        );
    }

    /// The whole point : after `close_connection_for_reset`
    /// the app holds no open handle over the database, so the files can be
    /// deleted safely and every later DB command fails closed. Files are NOT
    /// removed here — deletion belongs to the reset engine. Closing twice is
    /// a no-op, because a partial reset must be safe to re-run.
    #[test]
    fn closing_the_connection_for_reset_takes_the_handle_without_touching_files() {
        let dir = TempDir::new("reset-close");
        let key = super::mint_key_hex().expect("mint key");
        let conn = super::open_encrypted_db(&dir.db_path(), &key).expect("open");
        super::init_schema(&conn).expect("schema");
        let state = AppState {
            conn: Mutex::new(Some(conn)),
            txn_open: AtomicBool::new(false),
            reset_terminal: AtomicBool::new(false),
            data_dir: dir.0.clone(),
        };

        close_connection_for_reset(&state).expect("close");
        assert!(
            state.conn.lock().expect("lock").is_none(),
            "the managed connection must be gone after the reset closes it"
        );
        assert!(
            dir.db_path().exists(),
            "closing removes no files — that is the reset engine's job"
        );

        close_connection_for_reset(&state).expect("a re-run must find it already closed");
    }

    /// A manual transaction left open must not survive into the checkpoint
    /// (it would make the checkpoint fail, and its rows are discarded by the
    /// reset anyway). The flag is cleared with it.
    #[test]
    fn closing_the_connection_rolls_back_an_open_manual_transaction() {
        let dir = TempDir::new("reset-close-txn");
        let key = super::mint_key_hex().expect("mint key");
        let conn = super::open_encrypted_db(&dir.db_path(), &key).expect("open");
        super::init_schema(&conn).expect("schema");
        let state = AppState {
            conn: Mutex::new(Some(conn)),
            txn_open: AtomicBool::new(true),
            reset_terminal: AtomicBool::new(false),
            data_dir: dir.0.clone(),
        };
        // Open a real manual transaction behind the flag's back, exactly like
        // a UI that ignored the "never across awaits" rule.
        state
            .conn
            .lock()
            .expect("lock")
            .as_ref()
            .expect("connection")
            .execute_batch("BEGIN;")
            .expect("begin");

        close_connection_for_reset(&state).expect("close");
        assert!(
            !state.txn_open.load(super::Ordering::SeqCst),
            "the flag must be cleared"
        );
        assert!(state.conn.lock().expect("lock").is_none());
    }
}
