//! The §6 exchange: the phone's ops staged for the panel's apply, this
//! device's own ops served from the window's single outbox read.

use std::collections::HashSet;
use std::sync::atomic::Ordering;

use serde_json::{json, Value as JsonValue};

use crate::envelope::{self, Opened, SealInput};

use super::super::{
    est_sync_op_bytes, Gate, Pin, RefusalReply, SyncOutcome, SyncPullStream, MAX_FRAME_BYTES,
    MAX_SYNC_BATCH_BYTES, MAX_SYNC_OP_BYTES, MAX_UPLOAD_BATCHES, MAX_UPLOAD_BATCH_OPS,
};

/// The §6 exchange, after admission. The route carries both directions on
/// purpose: a sync is one exchange, and the phone drives every step of it.
pub(crate) fn sync_answer(
    gate: &Gate,
    pin: &Pin,
    opened: &Opened,
) -> Result<JsonValue, RefusalReply> {
    let kind = opened
        .message
        .get("kind")
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    match kind {
        "sync-push" => stage_sync_push(gate, &opened.message),
        "sync-commit" => commit_sync_push(gate),
        "sync-pull" => serve_sync_ops(gate, pin, &opened.message),
        "sync-applied" => record_sync_applied(gate, &opened.message),
        "sync-status" => sync_status_reply(gate, pin),
        // `admit` filtered the kind against `SYNC_ACCEPTED_KINDS`; a refusal is
        // still the right answer if that ever drifts.
        other => Err(RefusalReply::refused(
            "not-allowed",
            format!("{other:?} is not a sync message (§6)."),
        )),
    }
}

/// Stage one batch of the phone's ops (§6.2, §7.6). The upload's rule, because
/// it is the same fact: staging is not applying, so a batch whose reply was
/// lost may be sent again unchanged and is acknowledged again. A different
/// batch under a staged index, or an index out of order, is refused by name:
/// one push streams per window.
pub(crate) fn stage_sync_push(gate: &Gate, message: &JsonValue) -> Result<JsonValue, RefusalReply> {
    let number = |key: &str| message.get(key).and_then(JsonValue::as_u64);
    let batch = number("batch")
        .ok_or_else(|| RefusalReply::malformed("a sync batch names its index (§6.2)."))?
        as usize;
    let total = number("total")
        .ok_or_else(|| RefusalReply::malformed("a sync batch names its batch count (§6.2)."))?
        as usize;
    if total == 0 || total > MAX_UPLOAD_BATCHES {
        return Err(RefusalReply::malformed(format!(
            "a push is 1..={MAX_UPLOAD_BATCHES} batches; this one declares {total}."
        )));
    }
    if batch >= total {
        return Err(RefusalReply::malformed(format!(
            "this push has {total} batch(es); there is no batch {batch}."
        )));
    }
    let Some(ops) = message.get("ops").and_then(JsonValue::as_array) else {
        return Err(RefusalReply::malformed(
            "a sync batch carries its operations as an ops array (§6.2).",
        ));
    };
    if ops.len() > MAX_UPLOAD_BATCH_OPS {
        return Err(RefusalReply::malformed(format!(
            "one sync batch is at most {MAX_UPLOAD_BATCH_OPS} operations (§8.3); this one carries {}.",
            ops.len()
        )));
    }
    // Structural only: an operation is a document naming its record and its
    // place in the sender's sequence. Whether it may be applied — the table,
    // the kind, the payload's fields — is the engine's §7.7 decision, which
    // runs before a single statement exists. Staging an op the engine would
    // refuse is harmless precisely because it can never be applied unvalidated.
    for op in ops {
        let names_its_place = op.get("entity_table").and_then(JsonValue::as_str).is_some()
            && op.get("entity_uid").and_then(JsonValue::as_str).is_some()
            && op.get("seq").and_then(JsonValue::as_u64).is_some();
        if !names_its_place {
            return Err(RefusalReply::malformed(
                "every pushed operation names its table, its record and its seq (§6.2).",
            ));
        }
    }

    let mut sync = gate.sync.lock().unwrap_or_else(|e| e.into_inner());
    if sync.push_committed {
        return Err(RefusalReply::refused(
            "sync-busy",
            "this window's push was already committed; a new push opens a new window.",
        ));
    }
    match sync.push_total {
        None => sync.push_total = Some(total),
        Some(declared) if declared != total => {
            return Err(RefusalReply::malformed(format!(
                "this push declared {declared} batch(es) with its first batch, not {total}."
            )));
        }
        Some(_) => {}
    }
    if batch < sync.push_batches.len() {
        if sync.push_batches[batch] == *ops {
            return Ok(json!({
                "ok": true,
                "reason": "staged",
                "batch": batch,
                "total": total,
                "ops": sync.push_count(),
            }));
        }
        return Err(RefusalReply::refused(
            "sync-busy",
            "a different batch already holds this index; one push streams per window.",
        ));
    }
    if batch > sync.push_batches.len() {
        return Err(RefusalReply::refused(
            "sync-busy",
            "sync batches land in order; an earlier batch has not arrived.",
        ));
    }
    sync.push_batches.push(ops.clone());
    Ok(json!({
        "ok": true,
        "reason": "staged",
        "batch": batch,
        "total": total,
        "ops": sync.push_count(),
    }))
}

/// Every batch is staged: the panel may take the push. A second commit is a
/// `replayed` refusal (§7.2) and one before the last batch is `malformed`.
pub(crate) fn commit_sync_push(gate: &Gate) -> Result<JsonValue, RefusalReply> {
    let mut sync = gate.sync.lock().unwrap_or_else(|e| e.into_inner());
    if sync.push_committed {
        return Err(RefusalReply::refused(
            "replayed",
            "this push was already committed in this window (§7.2).",
        ));
    }
    let Some(total) = sync.push_total else {
        return Err(RefusalReply::malformed(
            "no sync batch has arrived in this window, so there is nothing to commit.",
        ));
    };
    if sync.push_batches.len() != total {
        return Err(RefusalReply::malformed(format!(
            "{} of {total} batch(es) were staged; a commit names the whole push.",
            sync.push_batches.len()
        )));
    }
    sync.push_committed = true;
    Ok(json!({
        "ok": true,
        "reason": "sync-committed",
        "total": total,
        "ops": sync.push_count(),
        "highestSeq": sync.highest_pushed_seq(),
    }))
}

/// Serve one batch of this window's own ops (§6.3).
///
/// The read happens on the FIRST pull and is held for the window, exactly as
/// the snapshot's is: a phone that asks twice for one batch gets the same rows,
/// and a phone that asks from a different position is asking for a second read
/// this window does not do.
pub(crate) fn serve_sync_ops(
    gate: &Gate,
    pin: &Pin,
    message: &JsonValue,
) -> Result<JsonValue, RefusalReply> {
    let number = |key: &str| message.get(key).and_then(JsonValue::as_u64);
    let batch = number("batch")
        .ok_or_else(|| RefusalReply::malformed("a sync-pull names its batch."))?
        as usize;
    let after_seq = number("afterSeq").ok_or_else(|| {
        RefusalReply::malformed(
            "a sync-pull says which of this device's operations it already has.",
        )
    })?;
    let mut sync = gate.sync.lock().unwrap_or_else(|e| e.into_inner());
    if sync.pull.is_none() {
        let Some(source) = gate.sync_source.as_ref() else {
            return Err(RefusalReply::refused(
                "not-allowed",
                "this window serves no sync operations of its own.",
            ));
        };
        let rows = source(after_seq).map_err(|message| RefusalReply {
            code: "internal",
            message,
            status: 500,
            attempts_left: None,
        })?;
        // One batch even when it is empty: the end of a pull is a batch with
        // nothing after it, never an error and never silence.
        //
        // Cut with the snapshot's discipline (§8.3): ops in seq order, a
        // boundary BEFORE the op that would cross the budget. Before SW-04 the
        // count-only cut let a batch's encoded body pass the frame cap, and the
        // handler's `encode_frame` fallback answered 200 with an empty body —
        // the phone read a malformed batch after its push had committed and
        // wedged. A single op larger than the batch budget still travels alone
        // (a record that cannot be sent is worse than a frame over target); one
        // larger than the frame can carry is refused by name, never dropped.
        let mut batches: Vec<Vec<JsonValue>> = Vec::new();
        let mut current: Vec<JsonValue> = Vec::new();
        let mut bytes = 0usize;
        for row in rows {
            let size = est_sync_op_bytes(&row);
            if size > MAX_SYNC_OP_BYTES {
                let names = json!({ "seq": row.get("seq").cloned().unwrap_or(JsonValue::Null),
                                    "table": row.get("entity_table").cloned().unwrap_or(JsonValue::Null) });
                return Err(RefusalReply::refused(
                    "sync-op-too-large",
                    format!(
                        "op {names} is {size} bytes and cannot fit a {MAX_FRAME_BYTES}-byte pairing frame alone; it is refused by name rather than sent truncated (§8.3)."
                    ),
                ));
            }
            if !current.is_empty()
                && (current.len() >= MAX_UPLOAD_BATCH_OPS || bytes + size > MAX_SYNC_BATCH_BYTES)
            {
                batches.push(std::mem::take(&mut current));
                bytes = 0;
            }
            bytes += size;
            current.push(row);
        }
        if !current.is_empty() || batches.is_empty() {
            batches.push(current);
        }
        // F-2: the vault pair is read with the ops, once per held pull. A
        // failed read serves no carriage rather than failing the pull: the
        // carriage is state sync, retried by the next window, while a
        // refused pull would wedge the ops themselves behind it.
        let vault_meta = gate
            .vault_meta_source
            .as_ref()
            .and_then(|source| source().ok())
            .flatten();
        sync.pull = Some(SyncPullStream {
            after_seq: Some(after_seq),
            batches,
            vault_meta,
            served: HashSet::new(),
        });
    }
    let Some(pull) = sync.pull.as_mut() else {
        return Err(RefusalReply::malformed("the sync read is not held."));
    };
    if pull.after_seq != Some(after_seq) {
        return Err(RefusalReply::refused(
            "sync-mismatch",
            "this window already served a pull from another position; a new one opens a new window.",
        ));
    }
    let total = pull.batches.len();
    if batch >= total {
        return Err(RefusalReply::malformed(format!(
            "this pull has {total} batch(es); there is no batch {batch}."
        )));
    }
    let ops = pull.batches[batch].clone();
    let vault_meta = pull.vault_meta.clone();
    pull.served.insert(batch);
    drop(sync);

    let mut reply = json!({
        "kind": "sync-ops",
        "pairingId": gate.pairing_id,
        "batch": batch,
        "total": total,
        "ops": ops,
    });
    if let Some((generation, verifier)) = vault_meta {
        reply["vaultMeta"] = json!({
            "generation": generation,
            "verifier": verifier,
        });
    }
    let counter = gate.send_counter.fetch_add(1, Ordering::SeqCst) + 1;
    let wire = envelope::seal(SealInput {
        secret: &gate.local_secret,
        peer_public: &pin.public_key,
        from: &gate.local_device_id,
        to: &pin.device_id,
        message_id: &format!("sync-ops:{counter}"),
        counter,
        message: &reply,
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
        "reason": "sync-ops",
        "envelope": wire,
    }))
}

/// The phone applied this device's ops through `throughSeq`. Recorded for the
/// panel, which turns it into a §6.5 acknowledgement on its next tick — the
/// listener writes nothing itself.
pub(crate) fn record_sync_applied(
    gate: &Gate,
    message: &JsonValue,
) -> Result<JsonValue, RefusalReply> {
    let Some(through) = message.get("throughSeq").and_then(JsonValue::as_u64) else {
        return Err(RefusalReply::malformed(
            "sync-applied names the seq it applied through (§6.5).",
        ));
    };
    let mut sync = gate.sync.lock().unwrap_or_else(|e| e.into_inner());
    sync.applied_through = Some(
        sync.applied_through
            .map_or(through, |held| held.max(through)),
    );
    Ok(json!({
        "ok": true,
        "reason": "sync-applied",
        "throughSeq": through,
    }))
}

/// What the panel's apply decided, sealed back — the one sync reply the phone
/// acts on, so it is sealed and counter-guarded like a snapshot batch: a forged
/// "applied" would let the phone prune ops the desktop never held (§6.5).
pub(crate) fn sync_status_reply(gate: &Gate, pin: &Pin) -> Result<JsonValue, RefusalReply> {
    let (state, through, message) = {
        let sync = gate.sync.lock().unwrap_or_else(|e| e.into_inner());
        match &sync.push_outcome {
            Some(SyncOutcome::Applied { through_seq }) => ("applied", Some(*through_seq), None),
            Some(SyncOutcome::Failed { message }) => ("failed", None, Some(message.clone())),
            None => ("pending", None, None),
        }
    };
    let mut reply = json!({
        "kind": "sync-status",
        "pairingId": gate.pairing_id,
        "state": state,
    });
    if let Some(through) = through {
        reply["throughSeq"] = json!(through);
    }
    if let Some(message) = message {
        reply["message"] = json!(message);
    }
    let counter = gate.send_counter.fetch_add(1, Ordering::SeqCst) + 1;
    let wire = envelope::seal(SealInput {
        secret: &gate.local_secret,
        peer_public: &pin.public_key,
        from: &gate.local_device_id,
        to: &pin.device_id,
        message_id: &format!("sync-status:{counter}"),
        counter,
        message: &reply,
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
        "reason": "sync-status",
        "envelope": wire,
    }))
}

#[cfg(test)]
mod tests {
    use super::super::super::tests::*;
    use super::super::super::*;
    use super::super::snapshot::tests::{
        opened_batch, post_snapshot, seal_snapshot, seeded_db, started_with_snapshot,
    };
    use super::super::upload::tests::{post_upload, seal_upload, upload_op};
    use super::*;
    use serde_json::json;
    use std::sync::atomic::AtomicU64;
    use std::sync::Arc;

    // -----------------------------------------------------------------------
    // §6 — the ongoing exchange: pushed ops staged, pulled ops read once.
    // -----------------------------------------------------------------------

    /// One of this device's own operations, as `sync_outbox` hands it over.
    fn sync_op(seq: u64) -> JsonValue {
        json!({
            "device_id": PHONE_ID,
            "seq": seq,
            "op_id": format!("op-{seq}"),
            "entity_table": "notes",
            "entity_uid": format!("11111111-1111-4111-8111-{seq:012}"),
            "op": "create",
            "base_counter": 0,
            "counter": seq,
            "field_stamps": "{}",
            "payload": "{}",
        })
    }

    fn seal_sync(counter: u64, message: &JsonValue) -> Vec<u8> {
        let mut body = message.clone();
        let object = body.as_object_mut().expect("a sync message is an object");
        object.insert("pairingId".to_string(), json!("pair-1"));
        object.insert("protocolVersion".to_string(), json!(1));
        object.insert("schemaVersion".to_string(), json!(8));
        object.insert("generation".to_string(), json!(1));
        let wire = envelope::seal(SealInput {
            secret: &PHONE_SECRET,
            peer_public: &envelope::public_key(&DESKTOP_SECRET),
            from: PHONE_ID,
            to: DESKTOP_ID,
            message_id: &format!("sync-{counter}"),
            counter,
            message: &body,
            pairing_id: Some("pair-1"),
            nonce: None,
            ephemeral_secret: None,
        })
        .expect("seal the sync message");
        encode_frame(&wire).expect("frame it")
    }

    fn post_sync(port: u16, body: &[u8]) -> (u16, String) {
        let (status, raw) = request(port, "POST /pair/sync", body);
        let text =
            decode_frame(&raw).unwrap_or_else(|_| String::from_utf8_lossy(&raw).into_owned());
        (status, text)
    }

    /// A window that serves `rows` operations of its own, and counts the reads
    /// so "once per window" is an assertion rather than a hope.
    fn started_with_sync(revoked: bool, rows: u64) -> (PairingListenerState, u16, Arc<AtomicU64>) {
        let reads = Arc::new(AtomicU64::new(0));
        let counted = Arc::clone(&reads);
        let source: SyncSource = Arc::new(move |after_seq| {
            counted.fetch_add(1, Ordering::SeqCst);
            Ok((1..=rows)
                .filter(|seq| *seq > after_seq)
                .map(sync_op)
                .collect())
        });
        let state = PairingListenerState::default();
        state.set_sync_source(source);
        let info = state
            .start("127.0.0.1", window(revoked), desktop_identity(), None)
            .expect("start");
        (state, info.port.expect("port"), reads)
    }

    #[test]
    fn a_push_is_staged_for_the_panel_and_applies_nothing_itself() {
        let (state, port, _) = started_with_sync(false, 0);
        let (status, reply) = post_sync(
            port,
            &seal_sync(
                1,
                &json!({ "kind": "sync-push", "batch": 0, "total": 1, "ops": [sync_op(1), sync_op(2)] }),
            ),
        );
        assert_eq!(status, 200, "{reply}");
        let reply: JsonValue = serde_json::from_str(&reply).expect("reply json");
        assert_eq!(reply["reason"], json!("staged"));
        assert_eq!(reply["ops"], json!(2));

        // Nothing is applied by staging: the panel has nothing to take until
        // the phone commits, and no verdict exists before the panel decides.
        let info = state.status().expect("status");
        assert_eq!(info.sync_state.as_deref(), Some("receiving"));
        assert_eq!(info.sync_ops, 2);
        assert_eq!(info.sync_note, None);
        assert!(
            state.take_sync_push().is_none(),
            "uncommitted: nothing to take"
        );
        state.stop().expect("stop");
    }

    #[test]
    fn push_batches_land_in_order_and_an_identical_resend_is_acked() {
        let (state, port, _) = started_with_sync(false, 0);

        // Batch 1 before batch 0 is a skipped index.
        let (status, reply) = post_sync(
            port,
            &seal_sync(
                1,
                &json!({ "kind": "sync-push", "batch": 1, "total": 2, "ops": [sync_op(2)] }),
            ),
        );
        assert_eq!(status, 403, "{reply}");
        assert_eq!(refusal_reason(&reply), "sync-busy");

        let (status, _) = post_sync(
            port,
            &seal_sync(
                2,
                &json!({ "kind": "sync-push", "batch": 0, "total": 2, "ops": [sync_op(1)] }),
            ),
        );
        assert_eq!(status, 200);

        // The same batch again (its reply was lost) is acknowledged, not
        // refused: a staging is not an apply (§7.2).
        let (status, reply) = post_sync(
            port,
            &seal_sync(
                3,
                &json!({ "kind": "sync-push", "batch": 0, "total": 2, "ops": [sync_op(1)] }),
            ),
        );
        assert_eq!(status, 200, "{reply}");
        assert_eq!(
            serde_json::from_str::<JsonValue>(&reply).expect("json")["ops"],
            json!(1),
            "the re-send staged nothing twice"
        );

        // A different batch under a staged index is a second push.
        let (status, reply) = post_sync(
            port,
            &seal_sync(
                4,
                &json!({ "kind": "sync-push", "batch": 0, "total": 2, "ops": [sync_op(9)] }),
            ),
        );
        assert_eq!(status, 403, "{reply}");
        assert_eq!(refusal_reason(&reply), "sync-busy");

        // A commit before the last batch is malformed.
        let (status, reply) = post_sync(port, &seal_sync(5, &json!({ "kind": "sync-commit" })));
        assert_eq!(status, 400, "{reply}");

        let (status, _) = post_sync(
            port,
            &seal_sync(
                6,
                &json!({ "kind": "sync-push", "batch": 1, "total": 2, "ops": [sync_op(2)] }),
            ),
        );
        assert_eq!(status, 200);
        let (status, reply) = post_sync(port, &seal_sync(7, &json!({ "kind": "sync-commit" })));
        assert_eq!(status, 200, "{reply}");
        let reply: JsonValue = serde_json::from_str(&reply).expect("reply json");
        assert_eq!(reply["reason"], json!("sync-committed"));
        assert_eq!(reply["highestSeq"], json!(2));

        // Committed once: the panel takes the whole staging once, in order.
        let ops = state.take_sync_push().expect("the staged push");
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[0]["seq"], json!(1));
        assert_eq!(ops[1]["seq"], json!(2));
        assert!(state.take_sync_push().is_none(), "taken once");

        // And a second commit is a replay.
        let (status, reply) = post_sync(port, &seal_sync(8, &json!({ "kind": "sync-commit" })));
        assert_eq!(status, 403, "{reply}");
        assert_eq!(refusal_reason(&reply), "replayed");
        state.stop().expect("stop");
    }

    #[test]
    fn a_pull_serves_only_rows_after_its_position_and_reads_once() {
        let (state, port, reads) = started_with_sync(false, 5);

        let (status, reply) = post_sync(
            port,
            &seal_sync(
                1,
                &json!({ "kind": "sync-pull", "batch": 0, "afterSeq": 2 }),
            ),
        );
        assert_eq!(status, 200, "{reply}");
        let (document, _) = opened_batch(&reply, 0);
        assert_eq!(document["kind"], json!("sync-ops"));
        assert_eq!(document["pairingId"], json!("pair-1"));
        let ops = document["ops"].as_array().expect("ops");
        assert_eq!(ops.len(), 3, "rows 3, 4 and 5 only");
        assert_eq!(ops[0]["seq"], json!(3));
        assert_eq!(ops[2]["seq"], json!(5));

        // Asking for the same batch again re-serves the same read, for a reply
        // that was lost; a batch that was never read is malformed, not empty.
        let (status, again) = post_sync(
            port,
            &seal_sync(
                2,
                &json!({ "kind": "sync-pull", "batch": 0, "afterSeq": 2 }),
            ),
        );
        assert_eq!(status, 200, "{again}");
        let (document, _) = opened_batch(&again, 0);
        assert_eq!(document["ops"], json!(ops));
        let (status, reply) = post_sync(
            port,
            &seal_sync(
                3,
                &json!({ "kind": "sync-pull", "batch": 1, "afterSeq": 2 }),
            ),
        );
        assert_eq!(status, 400, "{reply}");

        // A second read from another position is a second pull this window
        // does not do.
        let (status, reply) = post_sync(
            port,
            &seal_sync(
                4,
                &json!({ "kind": "sync-pull", "batch": 0, "afterSeq": 0 }),
            ),
        );
        assert_eq!(status, 403, "{reply}");
        assert_eq!(refusal_reason(&reply), "sync-mismatch");
        assert_eq!(reads.load(Ordering::SeqCst), 1, "one read per window");
        state.stop().expect("stop");
    }

    #[test]
    fn a_revoked_peer_is_refused_on_the_sync_route_before_admit() {
        let (state, port, reads) = started_with_sync(true, 5);
        let (status, reply) = post_sync(
            port,
            &seal_sync(
                1,
                &json!({ "kind": "sync-push", "batch": 0, "total": 1, "ops": [sync_op(1)] }),
            ),
        );
        assert_eq!(status, 403, "{reply}");
        assert_eq!(refusal_reason(&reply), "revoked");
        assert_eq!(
            reads.load(Ordering::SeqCst),
            0,
            "not one op leaves the desktop for a revoked peer"
        );
        state.stop().expect("stop");
    }

    #[test]
    fn the_sync_verdict_opens_with_the_windows_keys_and_no_one_elses() {
        let (state, port, _) = started_with_sync(false, 0);
        let (status, reply) = post_sync(
            port,
            &seal_sync(
                1,
                &json!({ "kind": "sync-push", "batch": 0, "total": 1, "ops": [sync_op(1)] }),
            ),
        );
        assert_eq!(status, 200, "{reply}");
        assert_eq!(
            post_sync(port, &seal_sync(2, &json!({ "kind": "sync-commit" }))).0,
            200
        );
        state.take_sync_push().expect("taken");

        // Pending until the panel's engine decides.
        let (status, reply) = post_sync(port, &seal_sync(3, &json!({ "kind": "sync-status" })));
        assert_eq!(status, 200, "{reply}");
        let (document, desktop) = opened_batch(&reply, 0);
        assert_eq!(document["kind"], json!("sync-status"));
        assert_eq!(document["state"], json!("pending"));

        state.set_sync_outcome(SyncOutcome::Applied { through_seq: 1 });
        let (status, reply) = post_sync(port, &seal_sync(4, &json!({ "kind": "sync-status" })));
        assert_eq!(status, 200, "{reply}");
        let (document, _) = opened_batch(&reply, desktop);
        assert_eq!(document["state"], json!("applied"));
        assert_eq!(document["throughSeq"], json!(1));
        assert_eq!(document["pairingId"], json!("pair-1"));

        // The same message sealed by another key never reaches the route: the
        // verdict is opened with the pinned peer's key or not at all (§11.2).
        let forged = envelope::seal(SealInput {
            secret: &OTHER_SECRET,
            peer_public: &envelope::public_key(&DESKTOP_SECRET),
            from: PHONE_ID,
            to: DESKTOP_ID,
            message_id: "sync-status-forged",
            counter: 5,
            message: &json!({ "kind": "sync-status", "pairingId": "pair-1", "protocolVersion": 1, "schemaVersion": 8, "generation": 1 }),
            pairing_id: Some("pair-1"),
            nonce: None,
            ephemeral_secret: None,
        })
        .expect("seal the forged message");
        let frame = encode_frame(&forged).expect("frame the forged message");
        let (status, reply) = request(port, "POST /pair/sync", &frame);
        let body =
            decode_frame(&reply).unwrap_or_else(|_| String::from_utf8_lossy(&reply).into_owned());
        assert_eq!(status, 403, "{body}");
        assert_eq!(refusal_reason(&body), "unauthenticated");
        state.stop().expect("stop");
    }

    #[test]
    fn a_revoked_peer_cannot_upload() {
        let (state, port) = started(true);
        let (status, reply) = post_upload(
            port,
            &seal_upload(
                1,
                &json!({ "kind": "upload", "batch": 0, "total": 1, "ops": [upload_op("11111111-1111-4111-8111-111111111111")] }),
            ),
        );
        assert_eq!(status, 403, "{reply}");
        assert_eq!(refusal_reason(&reply), "revoked");
        state.stop().expect("stop");
    }

    /// One of this device's ops carrying a payload of `bytes` bytes — the
    /// mid-size create SW-04's budget has to cut between.
    fn padded_sync_op(seq: u64, bytes: usize) -> JsonValue {
        let mut op = sync_op(seq);
        op["payload"] = json!(format!("{{\"note\":\"{}\"}}", "x".repeat(bytes)));
        op
    }

    /// A window serving `ops`, whatever they are (the count-only helper above
    /// cannot express a byte-sized stream).
    fn started_with_ops(ops: Vec<JsonValue>) -> (PairingListenerState, u16) {
        let source: SyncSource = Arc::new(move |after_seq| {
            Ok(ops
                .iter()
                .filter(|op| op["seq"].as_u64().is_some_and(|seq| seq > after_seq))
                .cloned()
                .collect())
        });
        let state = PairingListenerState::default();
        state.set_sync_source(source);
        let info = state
            .start("127.0.0.1", window(false), desktop_identity(), None)
            .expect("start");
        (state, info.port.expect("port"))
    }

    /// A window serving `ops` and a vault pair (F-2): the pull replies must
    /// carry the pair at batch level, because an item-less vault has no op
    /// to carry it.
    fn started_with_ops_and_vault(ops: Vec<JsonValue>) -> (PairingListenerState, u16) {
        let source: SyncSource = Arc::new(move |after_seq| {
            Ok(ops
                .iter()
                .filter(|op| op["seq"].as_u64().is_some_and(|seq| seq > after_seq))
                .cloned()
                .collect())
        });
        let state = PairingListenerState::default();
        state.set_sync_source(source);
        state.set_vault_meta_source(Arc::new(|| Ok(Some((2, "sealed-verifier".to_string())))));
        let info = state
            .start("127.0.0.1", window(false), desktop_identity(), None)
            .expect("start");
        (state, info.port.expect("port"))
    }

    #[test]
    fn a_pull_reply_carries_the_vault_pair_when_one_is_set_up() {
        let (state, port) = started_with_ops_and_vault(vec![sync_op(1)]);
        let (status, reply) = post_sync(
            port,
            &seal_sync(
                1,
                &json!({ "kind": "sync-pull", "batch": 0, "afterSeq": 0 }),
            ),
        );
        assert_eq!(status, 200, "{reply}");
        let (document, _counter) = opened_batch(&reply, 0);
        assert_eq!(document["vaultMeta"]["generation"], json!(2));
        assert_eq!(document["vaultMeta"]["verifier"], json!("sealed-verifier"));
        drop(state);
    }

    #[test]
    fn a_pull_cuts_its_batches_by_bytes_and_loses_no_op() {
        let ops: Vec<JsonValue> = (1..=5).map(|seq| padded_sync_op(seq, 8 * 1024)).collect();
        let (state, port) = started_with_ops(ops);

        let (status, reply) = post_sync(
            port,
            &seal_sync(
                1,
                &json!({ "kind": "sync-pull", "batch": 0, "afterSeq": 0 }),
            ),
        );
        assert_eq!(status, 200, "{reply}");
        let (first, mut desktop) = opened_batch(&reply, 0);
        let total = first["total"].as_u64().expect("total") as usize;
        assert!(
            total > 1,
            "{} bytes of ops cannot be one {MAX_SYNC_BATCH_BYTES}-byte batch",
            5 * 8 * 1024
        );

        let mut seen: Vec<u64> = Vec::new();
        for batch in 0..total {
            let document = if batch == 0 {
                first.clone()
            } else {
                let (status, reply) = post_sync(
                    port,
                    &seal_sync(
                        (batch as u64) + 1,
                        &json!({ "kind": "sync-pull", "batch": batch, "afterSeq": 0 }),
                    ),
                );
                assert_eq!(status, 200, "batch {batch}: {reply}");
                let (document, counter) = opened_batch(&reply, desktop);
                desktop = counter;
                document
            };
            let entries = document["ops"].as_array().expect("ops");
            let bytes: usize = entries.iter().map(est_sync_op_bytes).sum();
            assert!(
                bytes <= MAX_SYNC_BATCH_BYTES,
                "every batch rides its budget ({batch}: {bytes} bytes)"
            );
            seen.extend(entries.iter().filter_map(|op| op["seq"].as_u64()));
        }
        assert_eq!(seen, vec![1, 2, 3, 4, 5], "every op arrives, in seq order");
        state.stop().expect("stop");
    }

    #[test]
    fn an_op_too_large_for_a_frame_is_refused_by_name() {
        // Over half the frame in plaintext: sealed, it could never fit, so the
        // serving side names it instead of cutting a batch that cannot encode.
        let (state, port) = started_with_ops(vec![padded_sync_op(1, MAX_SYNC_OP_BYTES)]);
        let (status, reply) = post_sync(
            port,
            &seal_sync(
                1,
                &json!({ "kind": "sync-pull", "batch": 0, "afterSeq": 0 }),
            ),
        );
        assert_eq!(status, 403, "{reply}");
        assert_eq!(refusal_reason(&reply), "sync-op-too-large");
        state.stop().expect("stop");
    }

    #[test]
    fn a_record_too_large_to_copy_is_refused_by_name_and_reaches_the_panel() {
        let conn = Arc::new(Mutex::new(seeded_db(0, 0)));
        {
            let conn = conn.lock().unwrap_or_else(|e| e.into_inner());
            conn.execute_batch(&format!(
                "INSERT INTO notes (uid, title, content, created_at, updated_at)
                   VALUES ('f0000000-0000-4000-8000-000000000001', 'Giant note', '{}',
                           '2026-01-01', '2026-01-01');",
                "x".repeat(crate::pairing_snapshot::MAX_SERVABLE_ROW_BYTES)
            ))
            .expect("seed a note over the servable limit");
        }
        let (state, port) = started_with_snapshot(false, Arc::clone(&conn));

        let (status, reply) = post_snapshot(
            port,
            &seal_snapshot(1, &json!({ "kind": "snapshot-request", "batch": 0 })),
        );
        assert_eq!(status, 409, "{reply}");
        assert_eq!(refusal_reason(&reply), "record-too-large");
        let parsed: JsonValue = serde_json::from_str(&reply).expect("reply json");
        let message = parsed["message"].as_str().expect("a reason");
        assert!(message.contains("notes"), "{message}");
        assert!(
            message.contains("f0000000-0000-4000-8000-000000000001"),
            "the record is named: {message}"
        );
        assert!(message.contains("Giant note"), "{message}");

        // The panel's own status carries the same words, so the desktop says
        // why adoption cannot proceed instead of stalling silently.
        let info = state.status().expect("status");
        assert_eq!(info.note.as_deref(), Some(message));
        state.stop().expect("stop");
    }
}
