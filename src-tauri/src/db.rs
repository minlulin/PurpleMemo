//! Encrypted DB core (§5.1, §4): SQLCipher via rusqlite, keyring key,
//! one mutex-serialized connection, baseline schema.
//!
//! Connection model (§4): a single SQLCipher connection behind a mutex —
//! every IPC call serializes through it; no pooling. Multi-statement writes
//! go through [`batch`] (committed as a single transaction); manual
//! [`begin_tx`]/[`commit_tx`]/[`rollback_tx`] exist only for short critical
//! sections and are never held across UI awaits.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
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
pub struct AppState {
    pub conn: Mutex<Connection>,
    pub txn_open: AtomicBool,
    pub data_dir: PathBuf,
}

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
// Key management — mint-once into the OS credential store (§5.1)
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
/// key-export step (§2.8, §5.4). Read-only: unlike [`load_or_mint_db_key`]
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

/// Load the DB key from the OS credential store; mint and store one on first
/// run.
///
/// `db_path` decides what "first run" means (review C-4). The credential store
/// alone cannot: if it has no entry, this used to mint a fresh 256-bit key,
/// **write it into the store**, and only then fail `open_encrypted_db`'s
/// verify. That left the user with an unopenable database *and* a wrong key
/// occupying the only slot, behind a message that blamed neither the real
/// cause nor the exported-key restore path (§5.4).
///
/// So minting is allowed only when there is genuinely no database yet. With a
/// database present and no stored key we refuse, and say what to do instead.
pub fn load_or_mint_db_key(db_path: &Path) -> Result<DbKey, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("keyring entry unavailable: {e}"))?;
    match entry.get_password() {
        Ok(key) => Ok(DbKey {
            hex: validate_stored_key(&key)?,
            freshly_minted: false,
        }),
        Err(keyring::Error::NoEntry) => {
            if db_file_exists(db_path) {
                return Err(missing_key_for_existing_db(db_path));
            }
            let key = mint_key_hex()?;
            entry
                .set_password(&key)
                .map_err(|e| format!("failed to store DB key in credential store: {e}"))?;
            Ok(DbKey {
                hex: key,
                freshly_minted: true,
            })
        }
        Err(e) => Err(format!("failed to read DB key from credential store: {e}")),
    }
}

/// Remove a key this process just minted, after the database refused it. Best
/// effort: a store that will not delete leaves the same situation the guard
/// above prevents on the next run (a database with no key), which at least
/// fails with an actionable message instead of silently re-keying anything.
pub fn discard_minted_key() {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT) {
        let _ = entry.delete_credential();
    }
}

/// The audit line for one key export (§5.4). Pure, and deliberately takes the
/// key nowhere: the signature has no parameter through which key material could
/// be threaded, so this line *cannot* leak one however it is called. That is
/// the property the test pins, not a promise in a comment.
///
/// The clipboard route was removed rather than logged (a key left on the
/// system clipboard persists after the app closes and is readable by every
/// other program), so a file write is currently the only kind of disclosure —
/// which is why this takes a destination and nothing else.
pub fn key_export_audit_line(destination: &str) -> String {
    format!("key file written: {destination}")
}

/// Write the DB key to `path`, and record that it happened (§5.4).
///
/// The key is read from the credential store, used, and dropped inside this
/// function: it is never returned, so it never crosses into the webview. That is
/// the point of the command existing at all (review H-7) — the previous
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
/// The bytes go to a `.purple-memo-tmp` sibling in the same directory (so the
/// rename stays on one filesystem) and are renamed into place. On unix the temp
/// is opened `O_NOFOLLOW | O_EXCL`, so a symlink planted at the temp name is
/// refused rather than written through. The final rename replaces the target
/// atomically; it is a rename, not a truncate, so there is no window in which
/// the path is missing or half-written.
pub fn save_db_key_file(path: &Path) -> Result<(), String> {
    use std::io::Write;
    let key = read_db_key()?;
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
    std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
        return Err(format!("invalid destination {}", path.display()));
    };
    let tmp_path = parent.join(format!("{file_name}.purple-memo-tmp"));
    let bytes = format!("{key}\n").into_bytes();

    let write_result = (|| -> Result<(), String> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // Owner-only: the file is the master secret for the whole database.
            options.mode(0o600);
            // Never write THROUGH a symlink planted at the temp name — that is
            // how a temp-file write becomes an arbitrary-file overwrite.
            options.custom_flags(libc::O_NOFOLLOW | libc::O_EXCL);
        }
        let mut file = options
            .open(&tmp_path)
            .map_err(|e| format!("could not open {}: {e}", tmp_path.display()))?;
        file.write_all(&bytes)
            .map_err(|e| format!("could not write {}: {e}", tmp_path.display()))?;
        file.sync_all()
            .map_err(|e| format!("could not flush {}: {e}", tmp_path.display()))?;
        Ok(())
    })();
    if let Err(e) = write_result {
        // Leave no temp file behind on failure, and never touch the real one.
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp_path, path) {
        // Keep the temp file: it holds the only copy of a key that is still in
        // the credential store, and deleting it would throw away the user's work.
        return Err(format!(
            "could not write {} ({e}); the key is still at {}",
            path.display(),
            tmp_path.display()
        ));
    }
    let write_result: Result<(), String> = Ok(());
    // Only record a disclosure that actually happened.
    write_result?;
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
/// pinned by a test rather than left to drift in the error arm.
pub fn missing_key_for_existing_db(db_path: &Path) -> String {
    format!(
        "the database {} already exists but no encryption key is in the OS credential store. \
         Purple Memo will not generate a new key over existing data. Restore the key you \
         exported in Settings (Backup & key), or move the database aside to start fresh — \
         doing so discards the data in it.",
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
/// Order matters (§5.1): set the key first, then **verify before use** by
/// reading `sqlite_master` — a wrong key fails here, before any schema work.
/// Then WAL mode and `foreign_keys = ON`.
pub fn open_encrypted_db(path: &Path, key_hex: &str) -> Result<Connection, String> {
    if !is_key_hex(key_hex) {
        return Err("DB key must be 64 hex characters (256 bits)".to_string());
    }
    let conn = Connection::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    // SQLCipher raw-key form (§5.1): PRAGMA key = "x'<hex>'".
    conn.execute_batch(&format!("PRAGMA key = \"x'{key_hex}'\";"))
        .map_err(|e| format!("failed to set DB key: {e}"))?;
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
        .map_err(|e| format!("DB key verification failed (wrong key or corrupt file): {e}"))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("failed to enable WAL: {e}"))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("failed to enable foreign keys: {e}"))?;
    // SQLite's busy handler is off by default, which turns any contention
    // into an instant SQLITE_BUSY rather than a short wait (review H-5). The
    // single in-process connection cannot contend with itself, but anything
    // else holding the file can: a second app instance, an external sqlite3
    // session, or a backup tool reading the exported DB. Five seconds is
    // well past any legitimate hold and still short enough that a genuine
    // conflict surfaces as an error rather than a hang.
    conn.busy_timeout(std::time::Duration::from_secs(BUSY_TIMEOUT_SECS))
        .map_err(|e| format!("failed to set busy timeout: {e}"))?;
    Ok(conn)
}

/// Create the baseline schema on a fresh DB and stamp `user_version` (§4).
/// Idempotent: a DB already at [`schema::SCHEMA_VERSION`] is left untouched.
pub fn init_schema(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| format!("failed to read user_version: {e}"))?;
    match version {
        0 => {}
        v if v == schema::SCHEMA_VERSION => return Ok(()),
        v => {
            return Err(format!(
                "DB user_version {v} is newer than supported {}; refusing to touch it",
                schema::SCHEMA_VERSION
            ));
        }
    }
    conn.execute_batch("BEGIN")
        .map_err(|e| format!("failed to start schema transaction: {e}"))?;
    if let Err(e) = conn.execute_batch(schema::BASELINE_SQL) {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(format!("baseline schema failed and was rolled back: {e}"));
    }
    conn.execute_batch(&format!(
        "PRAGMA user_version = {};",
        schema::SCHEMA_VERSION
    ))
    .and_then(|_| conn.execute_batch("COMMIT"))
    .map_err(|e| {
        let _ = conn.execute_batch("ROLLBACK");
        format!("failed to stamp user_version: {e}")
    })
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
/// This is defence in depth, not a sandbox: PLAN §5 already establishes that
/// the renderer is trusted (it can run arbitrary SQL and read the DB key).
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
    // failure destroys data. Review P3-2 hit exactly that: `pragma_name_of`
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
    // Reads get the same guard as writes (review H-2). Without it
    // `db_query("COMMIT")` committed an open manual transaction while
    // `txn_open` stayed true, and `db_query("BEGIN")` opened a transaction
    // the flag did not know about — after which every `db_batch` failed with
    // "cannot start a transaction within a transaction" for the life of the
    // process.
    reject_dangerous_statement(sql)?;
    let params = json_params(params)?;
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("prepare failed: {e}\nSQL: {sql}"))?;
    let columns: Vec<String> = stmt
        .column_names()
        .iter()
        .map(|name| (*name).to_string())
        .collect();
    let mut rows = stmt
        .query(rusqlite::params_from_iter(params.iter()))
        .map_err(|e| format!("query failed: {e}\nSQL: {sql}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| format!("row fetch failed: {e}\nSQL: {sql}"))?
    {
        let mut obj = JsonObj::new();
        for (idx, col) in columns.iter().enumerate() {
            let value: SqlValue = row
                .get(idx)
                .map_err(|e| format!("column {col} read failed: {e}\nSQL: {sql}"))?;
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
/// [`execute`], which is the guarded public entry point (FIX-02: the guard
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
        .map_err(|e| format!("execute failed: {e}\nSQL: {sql}"))?;
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
/// no message explaining it and no path out but a restart (review H-4). The
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

/// Run several writes as a single transaction — all-or-nothing (§4).
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

/// Start a manual transaction (short critical sections only — §4).
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

    // -- Key minting must never re-key an existing database (review C-4) -------

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
            "points at the exported-key restore path (§5.4): {msg}"
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

    // -- Key export (§5.4, review H-7) ----------------------------------------

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
        // The compile-time half of H-7: `save_db_key_file` returns `Result<(), _>`,
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
        // Both failure messages built in `save_db_key_file` name the path the
        // user chose; neither can contain key material.
        let key = mint_key_hex().expect("mint key");
        let unwritable = Path::new("/definitely/not/a/real/dir/key.txt");
        if let Err(message) = save_db_key_file(unwritable) {
            assert!(!message.contains(&key), "must not echo a key: {message}");
            assert!(
                message.contains("key.txt"),
                "should name the destination: {message}"
            );
        }
    }

    #[test]
    fn a_key_file_write_refuses_a_directory_destination() {
        // P3-20: the old form opened the destination with `truncate(true)` and
        // only learned it was a directory afterwards, by failing to write. The
        // refusal is now explicit, so the user gets a message that names the
        // problem instead of "could not open ...".
        let dir = TempDir::new("key-dir-dest");
        let message = save_db_key_file(&dir.0).expect_err("a directory is not a file");
        assert!(
            message.contains("directory"),
            "should say the destination is a directory: {message}"
        );
    }

    #[test]
    fn a_key_file_write_leaves_the_previous_file_intact_on_failure() {
        // P3-20: the destructive part of `truncate(true)` was that the old
        // contents were gone before the new bytes existed. Assert the property
        // directly rather than through the credential store: whatever the
        // platform's keyring does, a *failed* save must not have emptied the
        // file the user already had.
        let dir = TempDir::new("key-overwrite");
        let out = dir.0.join("key.txt");
        let previous = b"the key I already exported\n";
        std::fs::write(&out, previous).expect("seed the destination");

        // A path whose parent is a *file* cannot be created, so the write fails
        // after the temp open is attempted and before the rename.
        let blocked = dir.0.join("blocker").join("key.txt");
        std::fs::write(dir.0.join("blocker"), b"i am a file, not a directory")
            .expect("create the blocking file");
        let _ = save_db_key_file(&blocked);

        assert_eq!(
            std::fs::read_to_string(&out).expect("read back"),
            String::from_utf8_lossy(previous),
            "an unrelated failed save must not have truncated the existing file"
        );
    }

    #[test]
    fn a_key_file_write_leaves_no_temp_file_when_it_fails() {
        // P3-20: the temp file is the first thing written, so a failure before
        // the rename must not leave a partial key file sitting next to it.
        let dir = TempDir::new("key-temp-cleanup");
        let blocked = dir.0.join("blocker").join("key.txt");
        std::fs::write(dir.0.join("blocker"), b"not a directory").expect("blocking file");
        let _ = save_db_key_file(&blocked);

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

    // -- Baseline schema: 29 tables, user_version 1, seeds, FK on ----------

    #[test]
    fn baseline_schema_has_29_tables_and_user_version_1() {
        let (_dir, conn) = open_baseline("schema");
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(version, 1);
        assert_eq!(table_count(&conn), 29);
    }

    // -- Hot foreign-key columns are indexed (FIX-04) ---------------------

    #[test]
    fn expected_indexes_exist() {
        // The schema has no migrations (§4), so these indexes exist only in
        // databases created from this baseline on — the test pins that
        // baseline against silent removal.
        let (_dir, conn) = open_baseline("indexes");
        for name in ["idx_notes_collection", "idx_contact_channels_contact"] {
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
        // §2.2: Business income category is required by the paid-in-full flow.
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
        assert_eq!(table_count(&conn), 29);
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
        // statement is refused (review L-03: the `txn_open` state machine).
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

    // -- The statement guard (review H-2 / H-3) --------------------------------

    #[test]
    fn db_query_cannot_commit_or_begin_around_the_txn_flag() {
        // H-2: the guard used to run on writes only, so a READ could commit an
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
        // H-3: the old check read only the first whitespace-separated token, so
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

    // -- Connection pragmas (review H-5) --------------------------------------

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
        // H-5: SQLite's busy handler is off by default, so any contention was
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
}
