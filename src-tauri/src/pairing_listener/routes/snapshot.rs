//! The §8.4 pull: one batch at a time out of this window's single consistent
//! read, acknowledged batch by batch, adopted whole.

use std::sync::atomic::Ordering;

use serde_json::{json, Value as JsonValue};

use crate::envelope::{self, Opened, SealInput};
use crate::pairing_snapshot::MAX_SNAPSHOT_BATCH_BYTES;

use super::super::{Gate, Pin, RefusalReply};

/// The §8.4 pull, after admission: `snapshot-request` → one sealed batch,
/// `applied` → recorded, `adopted` → the whole-snapshot acknowledgement.
///
/// Nothing here writes to the database. The desktop only serves what
/// `read_snapshot` took, so an interrupted pull costs it nothing, and §8.4's one
/// applying transaction remains the phone's.
pub(crate) fn snapshot_answer(
    gate: &Gate,
    pin: &Pin,
    opened: &Opened,
) -> Result<JsonValue, RefusalReply> {
    let kind = opened
        .message
        .get("kind")
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    let batch = || {
        opened
            .message
            .get("batch")
            .and_then(JsonValue::as_u64)
            .ok_or_else(|| RefusalReply::malformed("a snapshot message names its batch."))
    };
    match kind {
        "snapshot-request" => serve_batch(gate, pin, batch()? as usize),
        "applied" => record_applied(gate, batch()? as usize),
        "adopted" => record_adopted(gate, &opened.message),
        // `admit` filtered the kind against `SNAPSHOT_ACCEPTED_KINDS`; a refusal
        // is still the right answer if that ever drifts.
        other => Err(RefusalReply::refused(
            "not-allowed",
            format!("{other:?} is not a snapshot message (§8.4)."),
        )),
    }
}

/// One batch, sealed with this window's own monotonic counter (the hello-ack
/// precedent). Asking for a batch already served re-serves it: a pull that lost
/// a reply has nothing to replay against, so it simply asks again.
pub(crate) fn serve_batch(
    gate: &Gate,
    pin: &Pin,
    requested: usize,
) -> Result<JsonValue, RefusalReply> {
    let mut stream = gate.snapshot.lock().unwrap_or_else(|e| e.into_inner());
    if stream.pairing_id.is_none() {
        let Some(source) = gate.snapshot_source.as_ref() else {
            return Err(RefusalReply::refused(
                "not-allowed",
                "this pairing window serves no snapshot (§8.4).",
            ));
        };
        // §8.4: one consistent read, taken on the first request and held for the
        // life of the window. The lock is held across it on purpose — one
        // streaming snapshot per window is the rule, not a race to be managed.
        let snapshot = source().map_err(|message| RefusalReply {
            code: "internal",
            message: format!("the snapshot could not be read: {message}"),
            status: 500,
            attempts_left: None,
        })?;
        // §8.5: a record bigger than one servable batch does not travel, and
        // pretending otherwise strands the pull on a frame the phone can never
        // accept. Refused by name, before a single batch is cut, so the phone
        // shows the record and the panel keeps the same words.
        if let Some(row) = snapshot.unservable_row() {
            let message = row.describe();
            stream.note = Some(message.clone());
            return Err(RefusalReply {
                code: "record-too-large",
                message,
                status: 409,
                attempts_left: None,
            });
        }
        stream.batches = snapshot.batches(MAX_SNAPSHOT_BATCH_BYTES);
        stream.pairing_id = Some(gate.pairing_id.clone());
        stream.served.clear();
        stream.acked.clear();
        stream.adopted = false;
    }
    // A request under a different pairing id while one snapshot streams is a
    // second window's pull arriving on this one: one streaming snapshot per
    // window (§11.4). Admission refuses a foreign pairing id as
    // `pairing-mismatch` before this, so the check is kept as the invariant it
    // guards rather than the reachable refusal.
    if stream.pairing_id.as_deref() != Some(gate.pairing_id.as_str()) {
        return Err(RefusalReply::refused(
            "snapshot-busy",
            "one snapshot streams per pairing window; finish or restart this pull (§8.4).",
        ));
    }
    let total = stream.batches.len();
    if requested >= total {
        return Err(RefusalReply::malformed(format!(
            "this snapshot has {total} batch(es); there is no batch {requested}."
        )));
    }
    // One stream, in order. A request that skips past the batch the phone has
    // not acknowledged yet is a second, parallel pull; asking again for one
    // already served is not.
    if requested != stream.acked.len() && !stream.served.contains(&requested) {
        return Err(RefusalReply::refused(
            "snapshot-busy",
            "one snapshot streams per pairing window; finish or restart this pull (§8.4).",
        ));
    }
    stream.served.insert(requested);
    let batch = stream.batches[requested].clone();
    drop(stream);

    let counter = gate.send_counter.fetch_add(1, Ordering::SeqCst) + 1;
    let wire = envelope::seal(SealInput {
        secret: &gate.local_secret,
        peer_public: &pin.public_key,
        from: &gate.local_device_id,
        to: &pin.device_id,
        message_id: &format!("snapshot:{requested}:{counter}"),
        counter,
        message: &batch.to_json(gate.pairing_id.as_str()),
        pairing_id: Some(gate.pairing_id.as_str()),
        nonce: None,
        ephemeral_secret: None,
    })
    .map_err(|message| RefusalReply {
        code: "internal",
        message,
        status: 500,
        attempts_left: None,
    })?;
    Ok(json!({
        "ok": true,
        "reason": "snapshot",
        "batch": requested,
        "total": batch.total,
        "envelope": wire,
    }))
}

/// The phone staged a batch. The desktop records it so a pull can be followed
/// and a duplicate acknowledged batch is `replayed`; it applies nothing.
pub(crate) fn record_applied(gate: &Gate, requested: usize) -> Result<JsonValue, RefusalReply> {
    let mut stream = gate.snapshot.lock().unwrap_or_else(|e| e.into_inner());
    let Some(total) = stream.pairing_id.as_ref().map(|_| stream.batches.len()) else {
        return Err(RefusalReply::refused(
            "snapshot-busy",
            "no snapshot is streaming in this window (§8.4).",
        ));
    };
    if requested >= total {
        return Err(RefusalReply::malformed(format!(
            "this snapshot has {total} batch(es); there is no batch {requested}."
        )));
    }
    if stream.acked.contains(&requested) {
        return Err(RefusalReply::refused(
            "replayed",
            "that batch was already acknowledged in this pull (§7.2).",
        ));
    }
    if !stream.served.contains(&requested) {
        return Err(RefusalReply::malformed(
            "that batch was never served in this pull.",
        ));
    }
    stream.acked.insert(requested);
    Ok(json!({
        "ok": true,
        "reason": "applied",
        "batch": requested,
        "total": total,
    }))
}

/// The whole-snapshot acknowledgement (§8.4). It closes the pull only once every
/// batch was acknowledged: "applied the last one" is not "applied all of them".
pub(crate) fn record_adopted(gate: &Gate, message: &JsonValue) -> Result<JsonValue, RefusalReply> {
    let count = |key: &str| {
        message
            .get("counts")
            .and_then(|counts| counts.get(key))
            .and_then(JsonValue::as_u64)
            .unwrap_or(0)
    };
    let mut stream = gate.snapshot.lock().unwrap_or_else(|e| e.into_inner());
    let Some(total) = stream.pairing_id.as_ref().map(|_| stream.batches.len()) else {
        return Err(RefusalReply::refused(
            "snapshot-busy",
            "no snapshot is streaming in this window (§8.4).",
        ));
    };
    if stream.adopted {
        return Err(RefusalReply::refused(
            "replayed",
            "this snapshot was already adopted (§7.2).",
        ));
    }
    if stream.acked.len() != total {
        return Err(RefusalReply::malformed(format!(
            "{} of {total} batch(es) were acknowledged; an adoption acknowledges the whole \
             snapshot (§8.4).",
            stream.acked.len()
        )));
    }
    stream.adopted = true;
    Ok(json!({
        "ok": true,
        "reason": "adopted",
        "total": total,
        "rows": count("rows"),
        "tombstones": count("tombstones"),
    }))
}

#[cfg(test)]
pub(super) mod tests {
    use super::super::super::tests::*;
    use super::super::super::*;
    use super::*;
    use crate::envelope::OpenInput;
    use rusqlite::Connection;
    use serde_json::json;

    pub(crate) fn seeded_db(extra_notes: usize, body: usize) -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(crate::schema::BASELINE_SQL)
            .expect("baseline schema");
        seed_all(&conn, extra_notes, body);
        conn
    }

    /// One row in each of the 17 tables with its foreign keys resolved, plus
    /// `extra_notes` notes of `body` bytes each, plus one tombstone.
    pub(crate) fn seed_all(conn: &Connection, extra_notes: usize, body: usize) {
        let col = "c0000000-0000-4000-8000-000000000001";
        let wallet = "c0000000-0000-4000-8000-000000000002";
        let income = "c0000000-0000-4000-8000-000000000003";
        let expense = "c0000000-0000-4000-8000-000000000004";
        let shop = "c0000000-0000-4000-8000-000000000005";
        let habit = "c0000000-0000-4000-8000-000000000006";
        let list = "c0000000-0000-4000-8000-000000000007";
        // Distinct names: the baseline seeds its own collections, wallets and
        // categories, and every one of those names is UNIQUE.
        let mut sql = format!(
            "INSERT INTO collections (uid, name, created_at) VALUES ('{col}', 'Pull work', '2026-01-01');
             INSERT INTO wallets (uid, name, created_at) VALUES ('{wallet}', 'Pull cash', '2026-01-01');
             INSERT INTO income_categories (uid, name, created_at) VALUES ('{income}', 'Pull salary', '2026-01-01');
             INSERT INTO expense_categories (uid, name, created_at) VALUES ('{expense}', 'Pull food', '2026-01-01');
             INSERT INTO shops (uid, name, created_at) VALUES ('{shop}', 'Pull shop', '2026-01-01');
             INSERT INTO habits (uid, name, created_at) VALUES ('{habit}', 'Pull run', '2026-01-01');
             INSERT INTO shopping_lists (uid, name, created_at) VALUES ('{list}', 'Pull groceries', '2026-01-01');
             INSERT INTO notes (uid, title, content, collection_id, created_at, updated_at)
               VALUES ('c0000000-0000-4000-8000-000000000011', 'Note', 'body',
                       (SELECT id FROM collections WHERE uid = '{col}'), '2026-01-01', '2026-01-01');
             INSERT INTO tasks (uid, title, created_at)
               VALUES ('c0000000-0000-4000-8000-000000000012', 'Task', '2026-01-01');
             INSERT INTO reminders (uid, title, remind_at, created_at)
               VALUES ('c0000000-0000-4000-8000-000000000013', 'Remind', '2026-01-02', '2026-01-01');
             INSERT INTO income_entries (uid, amount_cents, category_id, wallet_id, entry_date, created_at)
               VALUES ('c0000000-0000-4000-8000-000000000014', 100,
                       (SELECT id FROM income_categories WHERE uid = '{income}'),
                       (SELECT id FROM wallets WHERE uid = '{wallet}'), '2026-01-01', '2026-01-01');
             INSERT INTO expense_entries (uid, amount_cents, category_id, wallet_id, entry_date, created_at)
               VALUES ('c0000000-0000-4000-8000-000000000015', 100,
                       (SELECT id FROM expense_categories WHERE uid = '{expense}'),
                       (SELECT id FROM wallets WHERE uid = '{wallet}'), '2026-01-01', '2026-01-01');
             INSERT INTO jobs (uid, title, shop_id, total_cents, job_date, created_at)
               VALUES ('c0000000-0000-4000-8000-000000000016', 'Job',
                       (SELECT id FROM shops WHERE uid = '{shop}'), 100, '2026-01-01', '2026-01-01');
             INSERT INTO loans (uid, counterparty, direction, amount_cents, created_at)
               VALUES ('c0000000-0000-4000-8000-000000000017', 'Friend', 'lent', 100, '2026-01-01');
             INSERT INTO habit_logs (uid, habit_id, log_date)
               VALUES ('c0000000-0000-4000-8000-000000000018',
                       (SELECT id FROM habits WHERE uid = '{habit}'), '2026-01-01');
             INSERT INTO shopping_items (uid, list_id, text)
               VALUES ('c0000000-0000-4000-8000-000000000019',
                       (SELECT id FROM shopping_lists WHERE uid = '{list}'), 'Milk');
             INSERT INTO vault_items (uid, title, ciphertext, salt, iv, created_at, updated_at)
               VALUES ('c0000000-0000-4000-8000-00000000001a', 'Vault', 'c', 's', 'i',
                       '2026-01-01', '2026-01-01');
             INSERT INTO sync_tombstones (entity_table, entity_uid, counter, device_id, op_id, deleted_at)
               VALUES ('tasks', 'c0000000-0000-4000-8000-0000000000ff', 3, 'dev-2', 'op-9', '2026-01-01');"
        );
        let content = "x".repeat(body);
        for index in 0..extra_notes {
            sql.push_str(&format!(
                "INSERT INTO notes (uid, title, content, created_at, updated_at)
                   VALUES ('d{index:07x}-0000-4000-8000-000000000000', 'Bulk {index}', '{content}',
                           '2026-01-01', '2026-01-01');"
            ));
        }
        conn.execute_batch(&sql).expect("seed the 17 tables");
    }

    pub(crate) fn snapshot_source(conn: Arc<Mutex<Connection>>) -> SnapshotSource {
        Arc::new(move || {
            let conn = conn.lock().unwrap_or_else(|e| e.into_inner());
            crate::pairing_snapshot::read_snapshot(&conn)
        })
    }

    pub(crate) fn started_with_snapshot(
        revoked: bool,
        conn: Arc<Mutex<Connection>>,
    ) -> (PairingListenerState, u16) {
        let state = PairingListenerState::default();
        let info = state
            .start(
                "127.0.0.1",
                0,
                window(revoked),
                desktop_identity(),
                Some(snapshot_source(conn)),
            )
            .expect("start the pairing listener");
        (state, info.port.expect("a bound port"))
    }

    /// A snapshot message from the pinned phone, sealed and framed. It carries
    /// the same protocol/schema/generation fields a hello does — admission is
    /// the same admission — plus the pairing id and its own kind.
    pub(crate) fn seal_snapshot(counter: u64, message: &JsonValue) -> Vec<u8> {
        let mut body = message.clone();
        let object = body
            .as_object_mut()
            .expect("a snapshot message is an object");
        object.insert("pairingId".to_string(), json!("pair-1"));
        object.insert("protocolVersion".to_string(), json!(1));
        object.insert("schemaVersion".to_string(), json!(8));
        object.insert("generation".to_string(), json!(1));
        let wire = envelope::seal(SealInput {
            secret: &PHONE_SECRET,
            peer_public: &envelope::public_key(&DESKTOP_SECRET),
            from: PHONE_ID,
            to: DESKTOP_ID,
            message_id: &format!("snapshot-{counter}"),
            counter,
            message: &body,
            pairing_id: Some("pair-1"),
            nonce: None,
            ephemeral_secret: None,
        })
        .expect("seal the snapshot message");
        encode_frame(&wire).expect("frame it")
    }

    pub(crate) fn post_snapshot(port: u16, body: &[u8]) -> (u16, String) {
        let (status, raw) = request(port, "POST /pair/snapshot", body);
        let text =
            decode_frame(&raw).unwrap_or_else(|_| String::from_utf8_lossy(&raw).into_owned());
        (status, text)
    }

    /// Open one sealed batch, with `last` as the highest desktop counter the
    /// phone has already accepted. Returns the batch document and its counter.
    pub(crate) fn opened_batch(reply: &str, last: u64) -> (JsonValue, u64) {
        let parsed: JsonValue = serde_json::from_str(reply).expect("reply json");
        let wire = parsed["envelope"].as_str().expect("a sealed batch");
        let opened = envelope::open(OpenInput {
            secret: &PHONE_SECRET,
            peer_public: &envelope::public_key(&DESKTOP_SECRET),
            local_device_id: PHONE_ID,
            expected_from: DESKTOP_ID,
            last_counter: last,
            pairing_id: Some("pair-1"),
            raw: wire,
        })
        .expect("the phone opens the batch");
        (opened.message, opened.header.counter)
    }

    #[test]
    fn a_snapshot_pulls_batch_by_batch_and_adopts_whole() {
        let conn = Arc::new(Mutex::new(seeded_db(45, 2000)));
        let expected = {
            let conn = conn.lock().unwrap_or_else(|e| e.into_inner());
            let read = crate::pairing_snapshot::read_snapshot(&conn).expect("read");
            (read.record_count(), read.tombstone_count())
        };
        let (state, port) = started_with_snapshot(false, Arc::clone(&conn));

        let mut phone = 0u64;
        let mut desktop = 0u64;
        let mut batch = 0u64;
        let mut total: u64;
        let mut rows = 0usize;
        let mut tombstones = 0usize;
        loop {
            phone += 1;
            let (status, reply) = post_snapshot(
                port,
                &seal_snapshot(
                    phone,
                    &json!({ "kind": "snapshot-request", "batch": batch }),
                ),
            );
            assert_eq!(status, 200, "{reply}");
            let (document, counter) = opened_batch(&reply, desktop);
            desktop = counter;
            assert_eq!(document["kind"], json!("snapshot"));
            assert_eq!(document["pairingId"], json!("pair-1"));
            assert_eq!(document["batch"], json!(batch));
            total = document["total"].as_u64().expect("a total");
            rows += document["ops"].as_array().expect("ops").len();
            tombstones += document["tombstones"].as_array().expect("tombstones").len();

            phone += 1;
            let (status, ack) = post_snapshot(
                port,
                &seal_snapshot(phone, &json!({ "kind": "applied", "batch": batch })),
            );
            assert_eq!(status, 200, "{ack}");
            let ack: JsonValue = serde_json::from_str(&ack).expect("ack json");
            assert_eq!(ack["reason"], json!("applied"));
            batch += 1;
            if batch >= total {
                break;
            }
        }
        assert!(
            total >= 3,
            "the seeded desktop is cut into at least three batches, got {total}"
        );
        assert_eq!(rows, expected.0, "every row of every table travelled once");
        assert_eq!(tombstones, expected.1);

        phone += 1;
        let (status, reply) = post_snapshot(
            port,
            &seal_snapshot(
                phone,
                &json!({
                    "kind": "adopted",
                    "counts": { "rows": rows, "tombstones": tombstones },
                }),
            ),
        );
        assert_eq!(status, 200, "{reply}");
        let adopted: JsonValue = serde_json::from_str(&reply).expect("adopted json");
        assert_eq!(adopted["reason"], json!("adopted"));
        assert_eq!(adopted["rows"], json!(rows as u64));
        assert_eq!(adopted["tombstones"], json!(tombstones as u64));
        assert_eq!(adopted["total"], json!(total));
        state.stop().expect("stop");
    }

    #[test]
    fn a_burmese_note_travels_intact_measured_in_utf8_bytes() {
        // The N8 lesson: Rust's `String::len` is UTF-8 bytes (3 per Burmese
        // character here), and the batch budget is measured in those — never in
        // characters, never in JS UTF-16 units.
        let burmese = "မြန်မာစာ".repeat(400);
        // 3,200 characters at 3 UTF-8 bytes each: 9,600 bytes, never 3,200.
        assert_eq!(burmese.chars().count(), 3200);
        assert_eq!(burmese.len(), 9600);
        let conn = Arc::new(Mutex::new(seeded_db(0, 0)));
        {
            let conn = conn.lock().unwrap_or_else(|e| e.into_inner());
            conn.execute_batch(&format!(
                "INSERT INTO notes (uid, title, content, created_at, updated_at)
                   VALUES ('e0000000-0000-4000-8000-000000000001', 'မြန်မာ', '{burmese}',
                           '2026-01-01', '2026-01-01');"
            ))
            .expect("seed the Burmese note");
        }
        let (state, port) = started_with_snapshot(false, conn);
        let (status, reply) = post_snapshot(
            port,
            &seal_snapshot(1, &json!({ "kind": "snapshot-request", "batch": 0 })),
        );
        assert_eq!(status, 200, "{reply}");
        let (document, _) = opened_batch(&reply, 0);
        let op = document["ops"]
            .as_array()
            .expect("ops")
            .iter()
            .find(|op| op["uid"] == json!("e0000000-0000-4000-8000-000000000001"))
            .expect("the Burmese note is in the snapshot");
        assert_eq!(op["fields"]["content"], json!(burmese));
        assert_eq!(op["fields"]["title"], json!("မြန်မာ"));
        state.stop().expect("stop");
    }

    #[test]
    fn a_revoked_peer_never_reaches_the_snapshot_reader() {
        let reads = Arc::new(AtomicU64::new(0));
        let counter = Arc::clone(&reads);
        let state = PairingListenerState::default();
        let info = state
            .start(
                "127.0.0.1",
                0,
                window(true),
                desktop_identity(),
                Some(Arc::new(move || {
                    counter.fetch_add(1, Ordering::SeqCst);
                    Ok(crate::pairing_snapshot::Snapshot::default())
                })),
            )
            .expect("start");
        let (status, reply) = post_snapshot(
            info.port.expect("port"),
            &seal_snapshot(1, &json!({ "kind": "snapshot-request", "batch": 0 })),
        );
        assert_eq!(status, 403, "{reply}");
        assert_eq!(refusal_reason(&reply), "revoked");
        assert!(
            !reply.contains("envelope"),
            "not one batch byte leaves a revoked pairing: {reply}"
        );
        assert_eq!(
            reads.load(Ordering::SeqCst),
            0,
            "the reader was never called"
        );
        state.stop().expect("stop");
    }

    #[test]
    fn a_snapshot_request_from_another_pairing_is_a_mismatch() {
        let conn = Arc::new(Mutex::new(seeded_db(0, 0)));
        let (state, port) = started_with_snapshot(false, conn);
        // Sealed under this pairing's salt (so it opens), but claiming another
        // pairing in its payload: the pairing-id check is what refuses it.
        let wire = envelope::seal(SealInput {
            secret: &PHONE_SECRET,
            peer_public: &envelope::public_key(&DESKTOP_SECRET),
            from: PHONE_ID,
            to: DESKTOP_ID,
            message_id: "foreign-pairing",
            counter: 1,
            message: &json!({
                "kind": "snapshot-request",
                "batch": 0,
                "pairingId": "pair-9",
                "protocolVersion": 1,
                "schemaVersion": 8,
                "generation": 1,
            }),
            pairing_id: Some("pair-1"),
            nonce: None,
            ephemeral_secret: None,
        })
        .expect("seal");
        let (status, reply) = post_snapshot(port, &encode_frame(&wire).expect("frame"));
        assert_eq!(status, 403, "{reply}");
        assert_eq!(refusal_reason(&reply), "pairing-mismatch");
        state.stop().expect("stop");
    }

    #[test]
    fn a_replayed_snapshot_envelope_is_refused_and_a_re_request_re_serves() {
        let conn = Arc::new(Mutex::new(seeded_db(0, 0)));
        let (state, port) = started_with_snapshot(false, conn);
        let frame = seal_snapshot(1, &json!({ "kind": "snapshot-request", "batch": 0 }));
        assert_eq!(post_snapshot(port, &frame).0, 200);
        let (status, reply) = post_snapshot(port, &frame);
        assert_eq!(status, 403, "{reply}");
        assert_eq!(refusal_reason(&reply), "replayed");
        // A fresh envelope for the same batch is a re-request, not a replay:
        // the batch is served again, unchanged.
        let (status, reply) = post_snapshot(
            port,
            &seal_snapshot(2, &json!({ "kind": "snapshot-request", "batch": 0 })),
        );
        assert_eq!(status, 200, "{reply}");
        let (document, _) = opened_batch(&reply, 0);
        assert_eq!(document["batch"], json!(0));
        state.stop().expect("stop");
    }

    #[test]
    fn a_second_stream_cannot_skip_ahead_and_an_early_adoption_is_refused() {
        let conn = Arc::new(Mutex::new(seeded_db(45, 2000)));
        let (state, port) = started_with_snapshot(false, conn);

        // Batch 2 before batch 0 is a second, parallel pull.
        let (status, reply) = post_snapshot(
            port,
            &seal_snapshot(1, &json!({ "kind": "snapshot-request", "batch": 2 })),
        );
        assert_eq!(status, 403, "{reply}");
        assert_eq!(refusal_reason(&reply), "snapshot-busy");

        // The pull's own start is served, and adoption before the last batch is
        // not an adoption of the whole snapshot (§8.4).
        assert_eq!(
            post_snapshot(
                port,
                &seal_snapshot(2, &json!({ "kind": "snapshot-request", "batch": 0 }))
            )
            .0,
            200
        );
        let (status, reply) = post_snapshot(
            port,
            &seal_snapshot(
                3,
                &json!({ "kind": "adopted", "counts": { "rows": 0, "tombstones": 0 } }),
            ),
        );
        assert_eq!(status, 400, "{reply}");
        assert_eq!(refusal_reason(&reply), "malformed");
        state.stop().expect("stop");
    }

    #[test]
    fn a_batch_acknowledged_twice_is_a_replay() {
        let conn = Arc::new(Mutex::new(seeded_db(0, 0)));
        let (state, port) = started_with_snapshot(false, conn);
        assert_eq!(
            post_snapshot(
                port,
                &seal_snapshot(1, &json!({ "kind": "snapshot-request", "batch": 0 }))
            )
            .0,
            200
        );
        assert_eq!(
            post_snapshot(
                port,
                &seal_snapshot(2, &json!({ "kind": "applied", "batch": 0 }))
            )
            .0,
            200
        );
        let (status, reply) = post_snapshot(
            port,
            &seal_snapshot(3, &json!({ "kind": "applied", "batch": 0 })),
        );
        assert_eq!(status, 403, "{reply}");
        assert_eq!(refusal_reason(&reply), "replayed");
        state.stop().expect("stop");
    }

    #[test]
    fn the_snapshot_route_speaks_only_its_own_kinds() {
        let conn = Arc::new(Mutex::new(seeded_db(0, 0)));
        let (state, port) = started_with_snapshot(false, conn);
        let (status, reply) = post_snapshot(port, &seal_snapshot(1, &json!({ "kind": "hello" })));
        assert_eq!(status, 403, "{reply}");
        assert_eq!(refusal_reason(&reply), "not-allowed");
        state.stop().expect("stop");
    }

    #[test]
    fn an_interrupted_pull_re_takes_the_snapshot_from_the_start() {
        let conn = Arc::new(Mutex::new(seeded_db(45, 2000)));
        let reads = Arc::new(AtomicU64::new(0));
        let counted = Arc::clone(&reads);
        let source_conn = Arc::clone(&conn);
        let source: SnapshotSource = Arc::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            let conn = source_conn.lock().unwrap_or_else(|e| e.into_inner());
            crate::pairing_snapshot::read_snapshot(&conn)
        });
        let state = PairingListenerState::default();
        let info = state
            .start(
                "127.0.0.1",
                0,
                window(false),
                desktop_identity(),
                Some(source),
            )
            .expect("start");
        let port = info.port.expect("port");

        // Pull two batches and acknowledge them, then stop dead mid-pull. The
        // desktop applied nothing, so there is no cursor to resume from.
        let mut phone = 0u64;
        let mut desktop = 0u64;
        for batch in 0..2u64 {
            phone += 1;
            let (status, reply) = post_snapshot(
                port,
                &seal_snapshot(
                    phone,
                    &json!({ "kind": "snapshot-request", "batch": batch }),
                ),
            );
            assert_eq!(status, 200, "{reply}");
            let (_, counter) = opened_batch(&reply, desktop);
            desktop = counter;
            phone += 1;
            assert_eq!(
                post_snapshot(
                    port,
                    &seal_snapshot(phone, &json!({ "kind": "applied", "batch": batch }))
                )
                .0,
                200
            );
        }
        assert_eq!(reads.load(Ordering::SeqCst), 1, "one read per window");
        state.stop().expect("stop");

        // A second window re-takes it and serves batch 0 again, whole.
        let (second, port) = started_with_snapshot(false, Arc::clone(&conn));
        let (status, reply) = post_snapshot(
            port,
            &seal_snapshot(1, &json!({ "kind": "snapshot-request", "batch": 0 })),
        );
        assert_eq!(status, 200, "{reply}");
        let (document, _) = opened_batch(&reply, 0);
        assert_eq!(document["batch"], json!(0));
        assert!(!document["ops"].as_array().expect("ops").is_empty());
        second.stop().expect("stop");
    }
}
