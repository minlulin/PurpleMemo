//! The §8.4 snapshot reader: the 17 synced tables plus their tombstones, read
//! as one point in time, ready to be batched and sealed.
//!
//! Two shapes matter here, and both come from the protocol:
//!
//! * a row is `{ table, uid, stamp, fields }` — the `SyncedRow` of
//!   `src/lib/sync/bootstrap.ts`. The stamp is the §4.2 one the v9
//!   `sync_row_stamps` table keeps (`counter`, `device_id`, `op_id`); a row
//!   that has none reads as counter 0, "pre-history", which is older than any
//!   edit this database can claim.
//! * a foreign key is **not** portable: `notes.collection_id` is a local
//!   integer that means nothing on the phone. Every foreign-key column is
//!   therefore sent as `<column>_uid` (`collection_id` → `collection_uid`),
//!   holding the parent's cross-device uid, and the integer itself never
//!   leaves this device.
//!
//! Columns are read with `PRAGMA table_info` and foreign keys with
//! `PRAGMA foreign_key_list`, so a column added to a synced table is carried
//! without editing this file — the alternative (a hand-written list per table)
//! is how a snapshot silently stops carrying a field.

use rusqlite::types::ValueRef;
use rusqlite::Connection;
use serde_json::{json, Map as JsonMap, Number, Value as JsonValue};

use crate::schema::UID_TABLES;

/// §8.3's op bound, applied to rows in one batch.
pub const MAX_SNAPSHOT_BATCH_OPS: usize = 200;

/// The rows budget of one batch, not the wire's 256 KiB.
///
/// The pairing frame cap is 64 KiB — 65,536 bytes, `MAX_FRAME_BYTES`, enforced
/// by the listener, the frame module and the client — and `envelope::seal`
/// **hex**-encodes the ciphertext: the body is **2× the plaintext**, not
/// base64's 4/3. The arithmetic at the boundary, with the authenticated header
/// (~270 bytes), the `{header,body}` wrapper (~20) and the frame's 4-byte
/// length prefix:
///
/// * `48 * 1024` rows → ~98 KiB sealed: refused;
/// * `32 * 1024` rows → ~66 KiB sealed: refused, and the header alone would
///   refuse it even if the estimate were exact (2 × (32,768 + 16) = 65,568 >
///   65,536);
/// * **`30 * 1024` (30,720) → ~62 KiB sealed: fits, with ~3.5 KiB spare.**
///
/// Two tests pin this: one seals a max-size batch and asserts the framed
/// envelope fits the cap, the other seals a 32 KiB plaintext batch and asserts
/// it does not. That pair is what would have caught the 48 KiB and 32 KiB
/// figures this constant used to carry — the happy path alone would not.
pub const MAX_SNAPSHOT_BATCH_BYTES: usize = 30 * 1024;

/// The §4.2 stamp of the value a row holds — or of the write that deleted it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stamp {
    pub counter: u64,
    pub device_id: String,
    pub op_id: String,
}

/// One synced record, as the snapshot carries it.
#[derive(Debug, Clone)]
pub struct SnapshotRow {
    pub table: String,
    pub uid: String,
    pub stamp: Stamp,
    /// Column → value. No `id`, and every foreign key is `<column>_uid`.
    pub fields: JsonMap<String, JsonValue>,
}

/// A deleted record's proof (§5.1), read from `sync_tombstones`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotTombstone {
    pub table: String,
    pub uid: String,
    pub stamp: Stamp,
}

/// One consistent read of everything §8.4 says a snapshot contains.
#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    pub rows: Vec<SnapshotRow>,
    pub tombstones: Vec<SnapshotTombstone>,
}

/// One unit of transport. The receiver applies the whole snapshot in one
/// transaction (§8.4), so these boundaries are about the wire, not the data:
/// losing a batch loses nothing, because nothing is applied before the last.
#[derive(Debug, Clone)]
pub struct SnapshotBatch {
    pub index: usize,
    pub total: usize,
    pub rows: Vec<SnapshotRow>,
    pub tombstones: Vec<SnapshotTombstone>,
}

impl SnapshotBatch {
    /// The wire document one batch travels as (§8.4). It is sealed whole and
    /// is the only thing in the envelope's plaintext: `kind`, the pairing it
    /// belongs to, its index out of `total`, and the ops and tombstones it
    /// carries.
    pub fn to_json(&self, pairing_id: &str) -> JsonValue {
        json!({
            "kind": "snapshot",
            "pairingId": pairing_id,
            "batch": self.index,
            "total": self.total,
            "ops": self.rows.iter().map(row_json).collect::<Vec<_>>(),
            "tombstones": self.tombstones.iter().map(tombstone_json).collect::<Vec<_>>(),
        })
    }
}

fn stamp_json(stamp: &Stamp) -> JsonValue {
    json!({
        "counter": stamp.counter,
        "deviceId": stamp.device_id,
        "opId": stamp.op_id,
    })
}

fn row_json(row: &SnapshotRow) -> JsonValue {
    json!({
        "table": row.table,
        "uid": row.uid,
        "stamp": stamp_json(&row.stamp),
        "fields": JsonValue::Object(row.fields.clone()),
    })
}

fn tombstone_json(tombstone: &SnapshotTombstone) -> JsonValue {
    json!({
        "table": tombstone.table,
        "uid": tombstone.uid,
        "stamp": stamp_json(&tombstone.stamp),
    })
}

impl Snapshot {
    /// Cut the read into batches under the frame's budget (§8.3).
    ///
    /// A single row larger than the budget still travels — a record that cannot
    /// be sent is worse than a frame that is over the target — and is the only
    /// case where a batch exceeds `max_bytes`.
    pub fn batches(&self, max_bytes: usize) -> Vec<SnapshotBatch> {
        let mut cuts: Vec<(Vec<SnapshotRow>, Vec<SnapshotTombstone>)> = Vec::new();
        let mut rows: Vec<SnapshotRow> = Vec::new();
        let mut tombstones: Vec<SnapshotTombstone> = Vec::new();
        let mut bytes = 0usize;
        for row in &self.rows {
            let size = est_row_bytes(row);
            if !rows.is_empty()
                && (rows.len() >= MAX_SNAPSHOT_BATCH_OPS || bytes + size > max_bytes)
            {
                cuts.push((std::mem::take(&mut rows), Vec::new()));
                bytes = 0;
            }
            bytes += size;
            rows.push(row.clone());
        }
        // Tombstones travel with the last data rows when they fit; otherwise
        // they get batches of their own.
        for tombstone in &self.tombstones {
            let size = est_tombstone_bytes(tombstone);
            if (!rows.is_empty() || !tombstones.is_empty())
                && (rows.len() + tombstones.len() >= MAX_SNAPSHOT_BATCH_OPS
                    || bytes + size > max_bytes)
            {
                cuts.push((std::mem::take(&mut rows), std::mem::take(&mut tombstones)));
                bytes = 0;
            }
            bytes += size;
            tombstones.push(tombstone.clone());
        }
        // §8.4: an empty desktop is still a snapshot, and the exchange needs a
        // batch 0 to request and acknowledge. A snapshot with no cuts would
        // leave the phone with nothing to ask for and no way to adopt.
        if !rows.is_empty() || !tombstones.is_empty() || cuts.is_empty() {
            cuts.push((rows, tombstones));
        }
        let total = cuts.len();
        cuts.into_iter()
            .enumerate()
            .map(|(index, (rows, tombstones))| SnapshotBatch {
                index,
                total,
                rows,
                tombstones,
            })
            .collect()
    }

    pub fn record_count(&self) -> usize {
        self.rows.len()
    }

    pub fn tombstone_count(&self) -> usize {
        self.tombstones.len()
    }
}

fn est_row_bytes(row: &SnapshotRow) -> usize {
    // + 96 for the table, uid, stamp and the op's own keys.
    JsonValue::Object(row.fields.clone()).to_string().len()
        + row.table.len()
        + row.uid.len()
        + row.stamp.device_id.len()
        + row.stamp.op_id.len()
        + 96
}

fn est_tombstone_bytes(tombstone: &SnapshotTombstone) -> usize {
    tombstone.table.len() + tombstone.uid.len() + tombstone.stamp.device_id.len() + 64
}

/// Read every synced table and tombstone as one point in time (§8.4).
///
/// The read holds one deferred transaction, so a write that lands while the
/// snapshot is being taken is either wholly inside it or wholly after it — the
/// phone never receives half of a parent and child from two different moments.
/// A connection that is already inside a transaction is read as-is (the caller
/// owns that boundary) rather than nested.
pub fn read_snapshot(conn: &Connection) -> Result<Snapshot, String> {
    let own_transaction = conn.is_autocommit();
    if own_transaction {
        conn.execute_batch("BEGIN DEFERRED")
            .map_err(|e| format!("could not start the snapshot read: {e}"))?;
    }
    let result = read_all(conn);
    if own_transaction {
        let _ = conn.execute_batch(if result.is_ok() { "COMMIT" } else { "ROLLBACK" });
    }
    result
}

fn read_all(conn: &Connection) -> Result<Snapshot, String> {
    let device_id: String = conn
        .query_row("SELECT device_id FROM sync_state WHERE id = 1", [], |row| {
            row.get(0)
        })
        .map_err(|e| format!("could not read this device's id: {e}"))?;
    let mut rows = Vec::new();
    for table in UID_TABLES {
        rows.extend(read_table(conn, table, &device_id)?);
    }
    let tombstones = read_tombstones(conn)?;
    Ok(Snapshot { rows, tombstones })
}

fn column_names(conn: &Connection, table: &str) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| format!("could not read {table}'s columns: {e}"))?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("could not read {table}'s columns: {e}"))?;
    names
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("could not read {table}'s columns: {e}"))
}

/// (from column, parent table) for each foreign key, in declaration order.
fn foreign_keys(conn: &Connection, table: &str) -> Result<Vec<(String, String)>, String> {
    let mut statement = conn
        .prepare(&format!("PRAGMA foreign_key_list({table})"))
        .map_err(|e| format!("could not read {table}'s foreign keys: {e}"))?;
    let keys = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(3)?, row.get::<_, String>(2)?))
        })
        .map_err(|e| format!("could not read {table}'s foreign keys: {e}"))?;
    keys.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("could not read {table}'s foreign keys: {e}"))
}

fn read_table(conn: &Connection, table: &str, device_id: &str) -> Result<Vec<SnapshotRow>, String> {
    let columns = column_names(conn, table)?;
    let keys = foreign_keys(conn, table)?;

    let mut selects: Vec<String> = Vec::new();
    let mut joins: Vec<String> = Vec::new();
    let mut field_names: Vec<String> = Vec::new();
    for column in &columns {
        if column == "id" || column == "uid" {
            continue;
        }
        match keys.iter().position(|(from, _)| from == column) {
            Some(index) => {
                let parent = &keys[index].1;
                joins.push(format!(
                    "LEFT JOIN \"{parent}\" fk{index} ON fk{index}.id = t.\"{column}\""
                ));
                selects.push(format!("fk{index}.uid"));
                // `collection_id` travels as `collection_uid`: the parent's
                // cross-device identity, not this device's rowid.
                field_names.push(match column.strip_suffix("_id") {
                    Some(base) => format!("{base}_uid"),
                    None => format!("{column}_uid"),
                });
            }
            None => {
                selects.push(format!("t.\"{column}\""));
                field_names.push(column.clone());
            }
        }
    }
    let select = if selects.is_empty() {
        "NULL".to_string()
    } else {
        selects.join(", ")
    };
    let sql = format!(
        "SELECT t.uid, {select}, s.counter, s.device_id, s.op_id \
         FROM \"{table}\" t {joins} \
         LEFT JOIN sync_row_stamps s \
           ON s.entity_table = ?1 AND s.entity_uid = t.uid \
         WHERE t.uid IS NOT NULL ORDER BY t.uid",
        joins = joins.join(" "),
    );

    let mut statement = conn
        .prepare(&sql)
        .map_err(|e| format!("could not read {table}: {e}"))?;
    let mut rows = statement
        .query([table])
        .map_err(|e| format!("could not read {table}: {e}"))?;
    let stamp_base = 1 + field_names.len();
    let mut out = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| format!("could not read {table}: {e}"))?
    {
        let uid: String = row
            .get(0)
            .map_err(|e| format!("could not read {table}.uid: {e}"))?;
        let mut fields = JsonMap::new();
        for (index, name) in field_names.iter().enumerate() {
            let value = row
                .get_ref(index + 1)
                .map_err(|e| format!("could not read {table}.{name}: {e}"))?;
            fields.insert(name.clone(), json_value(value, table, name)?);
        }
        let counter: Option<i64> = row
            .get(stamp_base)
            .map_err(|e| format!("could not read {table}'s stamp: {e}"))?;
        let stamp_device: Option<String> = row
            .get(stamp_base + 1)
            .map_err(|e| format!("could not read {table}'s stamp: {e}"))?;
        let stamp_op: Option<String> = row
            .get(stamp_base + 2)
            .map_err(|e| format!("could not read {table}'s stamp: {e}"))?;
        out.push(SnapshotRow {
            table: table.to_string(),
            uid,
            stamp: Stamp {
                counter: counter.unwrap_or(0).max(0) as u64,
                device_id: stamp_device.unwrap_or_else(|| device_id.to_string()),
                op_id: stamp_op.unwrap_or_else(|| "unstamped".to_string()),
            },
            fields,
        });
    }
    Ok(out)
}

fn read_tombstones(conn: &Connection) -> Result<Vec<SnapshotTombstone>, String> {
    let mut statement = conn
        .prepare(
            "SELECT entity_table, entity_uid, counter, device_id, op_id \
             FROM sync_tombstones ORDER BY entity_table, entity_uid",
        )
        .map_err(|e| format!("could not read tombstones: {e}"))?;
    let mut rows = statement
        .query([])
        .map_err(|e| format!("could not read tombstones: {e}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| format!("could not read tombstones: {e}"))?
    {
        let table: String = row
            .get(0)
            .map_err(|e| format!("could not read a tombstone: {e}"))?;
        // §2.1: only the 17 tables can have a tombstone; anything else in this
        // table is corruption and must not be shipped anywhere.
        if !UID_TABLES.contains(&table.as_str()) {
            return Err(format!(
                "a tombstone names {table}, which is not a synced table (§2.1)"
            ));
        }
        out.push(SnapshotTombstone {
            table,
            uid: row
                .get(1)
                .map_err(|e| format!("could not read a tombstone: {e}"))?,
            stamp: Stamp {
                counter: row
                    .get::<_, i64>(2)
                    .map_err(|e| format!("could not read a tombstone: {e}"))?
                    .max(0) as u64,
                device_id: row
                    .get(3)
                    .map_err(|e| format!("could not read a tombstone: {e}"))?,
                op_id: row
                    .get(4)
                    .map_err(|e| format!("could not read a tombstone: {e}"))?,
            },
        });
    }
    Ok(out)
}

fn json_value(value: ValueRef<'_>, table: &str, column: &str) -> Result<JsonValue, String> {
    Ok(match value {
        ValueRef::Null => JsonValue::Null,
        ValueRef::Integer(number) => JsonValue::Number(Number::from(number)),
        ValueRef::Real(number) => Number::from_f64(number)
            .map(JsonValue::Number)
            .ok_or_else(|| format!("{table}.{column} is not a finite number"))?,
        ValueRef::Text(bytes) => JsonValue::String(
            std::str::from_utf8(bytes)
                .map_err(|_| format!("{table}.{column} is not valid UTF-8"))?
                .to_string(),
        ),
        // No synced table stores a blob; one that starts to must be given a
        // deliberate encoding rather than a guess here.
        ValueRef::Blob(_) => {
            return Err(format!(
                "{table}.{column} is a blob, which the snapshot has no encoding for"
            ))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::{self, SealInput, KEY_BYTES};
    use crate::schema::BASELINE_SQL;

    const NOTE: &str = "11111111-1111-4111-8111-111111111111";
    const COLLECTION: &str = "22222222-2222-4222-8222-222222222222";

    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(BASELINE_SQL).expect("apply baseline");
        conn
    }

    fn device_id(conn: &Connection) -> String {
        conn.query_row("SELECT device_id FROM sync_state WHERE id = 1", [], |r| {
            r.get(0)
        })
        .expect("device id")
    }

    fn seed_note(conn: &Connection) {
        // By uid, not a literal rowid: the baseline may already hold rows.
        conn.execute_batch(&format!(
            "INSERT INTO collections (uid, name, created_at)
               VALUES ('{COLLECTION}', 'Work', '2026-01-01');
             INSERT INTO notes (uid, title, content, tags, collection_id, created_at, updated_at)
               VALUES ('{NOTE}', 'Note', 'body', '',
                       (SELECT id FROM collections WHERE uid = '{COLLECTION}'),
                       '2026-01-01', '2026-01-01');"
        ))
        .expect("seed note");
    }

    #[test]
    fn a_row_carries_its_foreign_keys_as_uids_and_its_own_stamp() {
        let conn = db();
        seed_note(&conn);
        conn.execute_batch(
            "INSERT INTO sync_row_stamps (entity_table, entity_uid, counter, device_id, op_id, field_stamps, updated_at)
             VALUES ('notes', '11111111-1111-4111-8111-111111111111', 7, 'dev-1', 'op-1', '{}', '2026-01-01T00:00:00Z');",
        )
        .expect("stamp");

        let snapshot = read_snapshot(&conn).expect("snapshot");
        let note = snapshot
            .rows
            .iter()
            .find(|row| row.uid == NOTE)
            .expect("the note travelled");
        assert_eq!(note.table, "notes");
        assert_eq!(
            note.fields
                .get("collection_uid")
                .and_then(|value| value.as_str()),
            Some(COLLECTION),
            "a foreign key travels as the parent's uid, never as a local rowid"
        );
        assert!(note.fields.get("collection_id").is_none());
        assert!(note.fields.get("id").is_none());
        assert_eq!(
            note.fields.get("title").and_then(|v| v.as_str()),
            Some("Note")
        );
        assert_eq!(
            note.stamp,
            Stamp {
                counter: 7,
                device_id: "dev-1".to_string(),
                op_id: "op-1".to_string(),
            }
        );
    }

    #[test]
    fn a_row_without_a_stamp_reads_as_pre_history() {
        let conn = db();
        // The baseline's seeded wallets never went through a mutation.
        let snapshot = read_snapshot(&conn).expect("snapshot");
        let wallet = snapshot
            .rows
            .iter()
            .find(|row| row.table == "wallets")
            .expect("a seeded wallet");
        assert_eq!(wallet.stamp.counter, 0);
        assert_eq!(wallet.stamp.op_id, "unstamped");
        assert_eq!(wallet.stamp.device_id, device_id(&conn));
    }

    #[test]
    fn tombstones_travel_with_their_delete_stamp() {
        let conn = db();
        seed_note(&conn);
        conn.execute_batch(&format!(
            "DELETE FROM notes WHERE uid = '{NOTE}';
             INSERT INTO sync_tombstones (entity_table, entity_uid, counter, device_id, op_id, deleted_at)
             VALUES ('notes', '{NOTE}', 4, 'dev-2', 'op-9', '2026-01-01');"
        ))
        .expect("tombstone");

        let snapshot = read_snapshot(&conn).expect("snapshot");
        assert_eq!(
            snapshot.tombstones,
            vec![SnapshotTombstone {
                table: "notes".to_string(),
                uid: NOTE.to_string(),
                stamp: Stamp {
                    counter: 4,
                    device_id: "dev-2".to_string(),
                    op_id: "op-9".to_string(),
                },
            }]
        );
        // A tombstoned row is not in the live rows: the pair is the delete.
        assert!(snapshot.rows.iter().all(|row| row.uid != NOTE));
    }

    #[test]
    fn only_synced_tables_travel() {
        let conn = db();
        seed_note(&conn);

        let snapshot = read_snapshot(&conn).expect("snapshot");
        let tables: Vec<&str> = snapshot.rows.iter().map(|row| row.table.as_str()).collect();
        assert!(
            tables.iter().all(|table| UID_TABLES.contains(table)),
            "every row names one of the 17 tables (§2.1)"
        );
        assert!(tables.contains(&"notes"));
        // §2.2: the database holds many other tables; none of them travels.
        assert!(!tables.contains(&"photos"));
        assert!(!tables.contains(&"trash_items"));
        assert!(!tables.contains(&"settings"));
    }

    #[test]
    fn a_tombstone_for_a_table_outside_the_allowlist_is_refused() {
        let conn = db();
        conn.execute_batch(
            "INSERT INTO sync_tombstones (entity_table, entity_uid, counter, device_id, op_id, deleted_at)
             VALUES ('photos', 'photo-1', 1, 'dev', 'op', '2026-01-01');",
        )
        .expect("planted tombstone");

        let error = read_snapshot(&conn).expect_err("a leak is not a snapshot");
        assert!(error.contains("photos"), "{error}");
    }

    #[test]
    fn the_read_leaves_no_transaction_open() {
        let conn = db();
        seed_note(&conn);
        read_snapshot(&conn).expect("snapshot");
        assert!(conn.is_autocommit(), "the reader owns its transaction");
    }

    #[test]
    fn batches_respect_the_byte_budget_and_never_drop_a_row() {
        let conn = db();
        seed_note(&conn);
        let snapshot = read_snapshot(&conn).expect("snapshot");
        assert!(snapshot.record_count() > 1);

        let batches = snapshot.batches(256);
        assert!(
            batches.len() > 1,
            "256 bytes cannot hold the whole snapshot"
        );
        assert_eq!(batches[0].index, 0);
        assert_eq!(batches[0].total, batches.len());
        let mut seen = 0;
        for batch in &batches {
            let bytes: usize = batch.rows.iter().map(est_row_bytes).sum::<usize>()
                + batch
                    .tombstones
                    .iter()
                    .map(est_tombstone_bytes)
                    .sum::<usize>();
            assert!(
                bytes <= 256 || batch.rows.len() + batch.tombstones.len() == 1,
                "only a single oversized row may exceed the budget"
            );
            seen += batch.rows.len();
        }
        assert_eq!(seen, snapshot.record_count(), "no row is lost at a cut");
    }

    #[test]
    fn tombstones_are_batched_too() {
        let conn = db();
        conn.execute_batch(&format!(
            "DELETE FROM notes WHERE uid = '{NOTE}';
             INSERT INTO sync_tombstones (entity_table, entity_uid, counter, device_id, op_id, deleted_at)
             VALUES ('notes', '{NOTE}', 4, 'dev-2', 'op-9', '2026-01-01');"
        ))
        .expect("tombstone");
        let snapshot = read_snapshot(&conn).expect("snapshot");
        let batches = snapshot.batches(MAX_SNAPSHOT_BATCH_BYTES);
        let tombstoned: usize = batches.iter().map(|batch| batch.tombstones.len()).sum();
        assert_eq!(tombstoned, snapshot.tombstone_count());
        assert_eq!(batches.len(), 1);
    }

    #[test]
    fn an_empty_snapshot_still_has_one_batch_to_adopt() {
        // §8.4: an empty desktop is a snapshot too. With no batch 0 the phone
        // would have nothing to request and could never adopt.
        let batches = Snapshot::default().batches(MAX_SNAPSHOT_BATCH_BYTES);
        assert_eq!(batches.len(), 1);
        assert!(batches[0].rows.is_empty());
        assert!(batches[0].tombstones.is_empty());
        assert_eq!(batches[0].index, 0);
        assert_eq!(batches[0].total, 1);
    }

    // ------------------------------------------------------------------
    // §8.4's transport bound. `envelope::seal` hex-encodes the ciphertext,
    // so the wire is 2x the plaintext, not base64's 4/3 — the number both the
    // 48 KiB and the 32 KiB figures got wrong.
    // ------------------------------------------------------------------

    const DESKTOP: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const PHONE: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    fn one_batch(rows: Vec<SnapshotRow>) -> SnapshotBatch {
        SnapshotBatch {
            index: 0,
            total: 1,
            rows,
            tombstones: Vec::new(),
        }
    }

    fn plaintext_len(batch: &SnapshotBatch) -> usize {
        serde_json::to_vec(&batch.to_json("pair-1"))
            .expect("serialize the batch")
            .len()
    }

    /// One note row whose `content` is `chars` ASCII bytes long.
    fn padded_row(chars: usize) -> SnapshotRow {
        let mut fields = JsonMap::new();
        fields.insert("title".to_string(), json!("Note"));
        fields.insert("content".to_string(), json!("x".repeat(chars)));
        fields.insert("tags".to_string(), json!(""));
        fields.insert("collection_uid".to_string(), JsonValue::Null);
        fields.insert("pinned".to_string(), json!(0));
        fields.insert("archived".to_string(), json!(0));
        fields.insert("created_at".to_string(), json!("2026-01-01T00:00:00Z"));
        fields.insert("updated_at".to_string(), json!("2026-01-01T00:00:00Z"));
        SnapshotRow {
            table: "notes".to_string(),
            uid: "11111111-1111-4111-8111-111111111111".to_string(),
            stamp: Stamp {
                counter: 1,
                device_id: DESKTOP.to_string(),
                op_id: "op-1".to_string(),
            },
            fields,
        }
    }

    /// A batch whose reader-estimated size lands on `target` — the budget
    /// `batches(max_bytes)` actually enforces.
    fn batch_of_estimate(target: usize) -> SnapshotBatch {
        let empty = est_row_bytes(&padded_row(0));
        let mut rows: Vec<SnapshotRow> = Vec::new();
        let mut used = 0usize;
        while used + empty + 4096 <= target {
            let row = padded_row(4000);
            used += est_row_bytes(&row);
            rows.push(row);
        }
        let pad = target.saturating_sub(used + empty);
        rows.push(padded_row(pad));
        one_batch(rows)
    }

    /// A batch whose *serialized plaintext* is at least `target` bytes — the
    /// quantity the frame cap is really about.
    fn batch_of_plaintext(target: usize) -> SnapshotBatch {
        let mut pad = target.saturating_sub(plaintext_len(&one_batch(vec![padded_row(0)])));
        let mut batch = one_batch(vec![padded_row(pad)]);
        while plaintext_len(&batch) < target {
            pad += target - plaintext_len(&batch);
            batch = one_batch(vec![padded_row(pad)]);
        }
        batch
    }

    fn seal_batch(batch: &SnapshotBatch) -> String {
        envelope::seal(SealInput {
            secret: &[0x11u8; KEY_BYTES],
            peer_public: &envelope::public_key(&[0x22u8; KEY_BYTES]),
            from: DESKTOP,
            to: PHONE,
            message_id: "snapshot:0:1",
            counter: 1,
            message: &batch.to_json("pair-1"),
            pairing_id: Some("pair-1"),
            nonce: None,
            ephemeral_secret: None,
        })
        .expect("seal the batch")
    }

    #[test]
    fn a_batch_travels_as_the_documented_document() {
        let wire = one_batch(vec![padded_row(4)]).to_json("pair-1");
        assert_eq!(wire["kind"], json!("snapshot"));
        assert_eq!(wire["pairingId"], json!("pair-1"));
        assert_eq!(wire["batch"], json!(0));
        assert_eq!(wire["total"], json!(1));
        assert_eq!(wire["tombstones"], json!([]));
        let op = &wire["ops"][0];
        assert_eq!(op["table"], json!("notes"));
        assert_eq!(op["stamp"]["counter"], json!(1));
        assert_eq!(op["stamp"]["deviceId"], json!(DESKTOP));
        assert_eq!(op["stamp"]["opId"], json!("op-1"));
        assert_eq!(op["fields"]["content"], json!("xxxx"));
        assert!(
            op.get("id").is_none(),
            "a local rowid never leaves its device"
        );
    }

    /// The test the 48 KiB and 32 KiB figures would both have failed.
    #[test]
    fn a_max_size_batch_seals_and_frames_inside_the_cap() {
        let batch = batch_of_estimate(MAX_SNAPSHOT_BATCH_BYTES);
        assert_eq!(
            batch.rows.iter().map(est_row_bytes).sum::<usize>(),
            MAX_SNAPSHOT_BATCH_BYTES,
            "a full budget of rows"
        );
        let wire = seal_batch(&batch);
        let framed = crate::pairing_listener::encode_frame(&wire)
            .expect("30 KiB of rows must fit one 64 KiB frame");
        assert!(
            framed.len() <= crate::pairing_listener::MAX_FRAME_BYTES,
            "{} bytes framed",
            framed.len()
        );
    }

    #[test]
    fn a_thirty_two_kib_batch_does_not_fit() {
        let batch = batch_of_plaintext(32 * 1024);
        assert!(plaintext_len(&batch) >= 32 * 1024);
        let wire = seal_batch(&batch);
        assert!(
            crate::pairing_listener::encode_frame(&wire).is_err(),
            "32 KiB of plaintext is 64 KiB of hex before the header: it cannot frame"
        );
    }
}
