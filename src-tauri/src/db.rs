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

use crate::schema;

/// Database file name inside the app data dir.
pub const DB_FILE_NAME: &str = "purple-memo.db";

const KEYRING_SERVICE: &str = "com.minlulin.purplememo";
const KEYRING_ACCOUNT: &str = "db-encryption-key";
const KEY_HEX_LEN: usize = 64;

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

/// Load the DB key from the OS credential store; mint and store one on first
/// run. Never re-mints over an existing entry.
pub fn load_or_mint_db_key() -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("keyring entry unavailable: {e}"))?;
    match entry.get_password() {
        Ok(key) => {
            if is_key_hex(&key) {
                Ok(key)
            } else {
                Err("stored DB encryption key is malformed".to_string())
            }
        }
        Err(keyring::Error::NoEntry) => {
            let key = mint_key_hex()?;
            entry
                .set_password(&key)
                .map_err(|e| format!("failed to store DB key in credential store: {e}"))?;
            Ok(key)
        }
        Err(e) => Err(format!("failed to read DB key from credential store: {e}")),
    }
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
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

/// Run a query and return rows as JSON objects keyed by column name.
pub fn query_rows(
    conn: &Connection,
    sql: &str,
    params: &[JsonValue],
) -> Result<Vec<JsonObj>, String> {
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

/// Reject transaction-control statements on the write path (§4). `batch`
/// wraps its statements in BEGIN/COMMIT itself, and a COMMIT/ROLLBACK smuggled
/// through `execute` would commit or abort a manual transaction behind the
/// `txn_open` flag's back — silently breaking the atomicity the feature layer
/// relies on. All app SQL is generated by the feature libraries and starts
/// with SELECT/INSERT/UPDATE/DELETE/WITH, so legitimate statements never hit
/// this.
fn reject_txn_control(sql: &str) -> Result<(), String> {
    let first = sql
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    match first.as_str() {
        "BEGIN" | "COMMIT" | "END" | "ROLLBACK" | "SAVEPOINT" | "RELEASE" => Err(format!(
            "transaction-control statements are not allowed here: {first}"
        )),
        _ => Ok(()),
    }
}

/// Run a single write statement; returns affected-row count + rowid.
pub fn execute(
    conn: &Connection,
    sql: &str,
    params: &[JsonValue],
) -> Result<ExecuteOutcome, String> {
    reject_txn_control(sql)?;
    let params = json_params(params)?;
    let rows_affected = conn
        .execute(sql, rusqlite::params_from_iter(params.iter()))
        .map_err(|e| format!("execute failed: {e}\nSQL: {sql}"))?;
    Ok(ExecuteOutcome {
        rows_affected: rows_affected as u64,
        last_insert_rowid: conn.last_insert_rowid(),
    })
}

/// Run several writes as a single transaction — all-or-nothing (§4).
pub fn batch(conn: &Connection, statements: &[BatchStatement]) -> Result<(), String> {
    for (idx, stmt) in statements.iter().enumerate() {
        reject_txn_control(&stmt.sql)
            .map_err(|e| format!("batch statement {idx} rejected: {e}"))?;
    }
    conn.execute_batch("BEGIN")
        .map_err(|e| format!("batch begin failed: {e}"))?;
    for (idx, stmt) in statements.iter().enumerate() {
        if let Err(e) = execute(conn, &stmt.sql, &stmt.params) {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(format!(
                "batch statement {idx} failed and was rolled back: {e}"
            ));
        }
    }
    conn.execute_batch("COMMIT").map_err(|e| {
        let _ = conn.execute_batch("ROLLBACK");
        format!("batch commit failed: {e}")
    })
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
