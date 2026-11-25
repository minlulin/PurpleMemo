//! The §9.1 upload: the phone's own records staged batch by batch, applied by
//! the panel in one transaction, and its verdict sealed back.

use std::sync::atomic::Ordering;

use serde_json::{json, Value as JsonValue};

use crate::envelope::{self, Opened, SealInput};

use super::super::{
    Gate, Pin, RefusalReply, UploadOutcome, MAX_UPLOAD_BATCHES, MAX_UPLOAD_BATCH_OPS,
};

/// The §9.1 upload, after admission: `upload` → one batch staged,
/// `upload-commit` → the staging is complete, `upload-status` → the panel's
/// verdict, sealed.
///
/// Nothing here writes to the database either — the mirror of the pull. The
/// panel takes the staged ops and applies them in one transaction; this side
/// only holds them and reports what the panel decided.
pub(crate) fn upload_answer(
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
        "upload" => stage_upload(gate, &opened.message),
        "upload-commit" => commit_upload(gate),
        "upload-status" => upload_status_reply(gate, pin),
        // `admit` filtered the kind against `UPLOAD_ACCEPTED_KINDS`; a refusal
        // is still the right answer if that ever drifts.
        other => Err(RefusalReply::refused(
            "not-allowed",
            format!("{other:?} is not an upload message (§9.1)."),
        )),
    }
}

/// Stage one batch of the phone's own records. Batches land in order; a
/// re-sent batch whose reply was lost is acknowledged again when it is the
/// same batch, because a staging is not an apply (§7.2) — the phone restarts
/// nothing for a dropped ack. A batch that disagrees with the one already
/// staged under its index is a second, different upload in one window, and
/// that is refused: one upload streams per window, like one snapshot.
pub(crate) fn stage_upload(gate: &Gate, message: &JsonValue) -> Result<JsonValue, RefusalReply> {
    let number = |key: &str| message.get(key).and_then(JsonValue::as_u64);
    let batch = number("batch")
        .ok_or_else(|| RefusalReply::malformed("an upload batch names its index (§9.1)."))?
        as usize;
    let total = number("total")
        .ok_or_else(|| RefusalReply::malformed("an upload batch names its batch count (§9.1)."))?
        as usize;
    if total == 0 || total > MAX_UPLOAD_BATCHES {
        return Err(RefusalReply::malformed(format!(
            "an upload is 1..={MAX_UPLOAD_BATCHES} batches; this one declares {total}."
        )));
    }
    if batch >= total {
        return Err(RefusalReply::malformed(format!(
            "this upload has {total} batch(es); there is no batch {batch}."
        )));
    }
    let Some(ops) = message.get("ops").and_then(JsonValue::as_array) else {
        return Err(RefusalReply::malformed(
            "an upload batch carries its records as an ops array (§9.1).",
        ));
    };
    if ops.len() > MAX_UPLOAD_BATCH_OPS {
        return Err(RefusalReply::malformed(format!(
            "one upload batch is at most {MAX_UPLOAD_BATCH_OPS} records (§8.3); this one carries {}.",
            ops.len()
        )));
    }
    // Structural only — every op names its record. The deep §3.4 validation
    // (allowlist, uid and stamp shape, field sets) is the apply's, in the
    // panel, before any statement is built: staging a malformed op is
    // harmless precisely because it can never be applied unvalidated.
    for op in ops {
        let names_its_record = op.get("table").and_then(JsonValue::as_str).is_some()
            && op.get("uid").and_then(JsonValue::as_str).is_some();
        if !names_its_record {
            return Err(RefusalReply::malformed(
                "every uploaded record names its table and uid (§9.1).",
            ));
        }
    }

    let mut upload = gate.upload.lock().unwrap_or_else(|e| e.into_inner());
    if upload.committed {
        return Err(RefusalReply::refused(
            "upload-busy",
            "this window's upload was already committed; a new upload opens a new window (§9.4).",
        ));
    }
    match upload.total {
        None => upload.total = Some(total),
        Some(declared) if declared != total => {
            return Err(RefusalReply::malformed(format!(
                "this upload declared {declared} batch(es) with its first batch, not {total}."
            )));
        }
        Some(_) => {}
    }
    if batch < upload.batches.len() {
        if upload.batches[batch] == *ops {
            return Ok(json!({
                "ok": true,
                "reason": "staged",
                "batch": batch,
                "total": total,
                "ops": upload.op_count(),
            }));
        }
        return Err(RefusalReply::refused(
            "upload-busy",
            "a different batch already holds this index; one upload streams per window (§9.1).",
        ));
    }
    if batch > upload.batches.len() {
        return Err(RefusalReply::refused(
            "upload-busy",
            "upload batches land in order; an earlier batch has not arrived (§9.1).",
        ));
    }
    upload.batches.push(ops.clone());
    Ok(json!({
        "ok": true,
        "reason": "staged",
        "batch": batch,
        "total": total,
        "ops": upload.op_count(),
    }))
}

/// The phone sent every batch: the staging is complete and the panel may
/// take it. A commit before the last batch, or a second one, is refused by
/// name — the panel applies a committed upload exactly once.
pub(crate) fn commit_upload(gate: &Gate) -> Result<JsonValue, RefusalReply> {
    let mut upload = gate.upload.lock().unwrap_or_else(|e| e.into_inner());
    if upload.committed {
        return Err(RefusalReply::refused(
            "replayed",
            "this upload was already committed in this window (§7.2).",
        ));
    }
    let Some(total) = upload.total else {
        return Err(RefusalReply::malformed(
            "no upload batch has arrived in this window, so there is nothing to commit (§9.1).",
        ));
    };
    if upload.batches.len() != total {
        return Err(RefusalReply::malformed(format!(
            "{} of {total} batch(es) were staged; a commit names the whole upload (§9.1).",
            upload.batches.len()
        )));
    }
    upload.committed = true;
    Ok(json!({
        "ok": true,
        "reason": "upload-committed",
        "total": total,
        "ops": upload.op_count(),
    }))
}

/// What the panel decided, sealed back — the one upload reply the phone acts
/// on, so it is sealed and counter-guarded like a snapshot batch, never a
/// plain ack: a forged "uploaded" would tell the phone its records are safe
/// on a desktop that never saw them. Until the panel decides, the state is
/// `pending`, and the phone keeps its records either way (§9.4).
pub(crate) fn upload_status_reply(gate: &Gate, pin: &Pin) -> Result<JsonValue, RefusalReply> {
    let (state, inserted, already_known, message) = {
        let upload = gate.upload.lock().unwrap_or_else(|e| e.into_inner());
        match &upload.outcome {
            Some(UploadOutcome::Applied {
                inserted,
                already_known,
            }) => ("uploaded", Some(*inserted), Some(*already_known), None),
            Some(UploadOutcome::Failed { message }) => {
                ("failed", None, None, Some(message.clone()))
            }
            None => ("pending", None, None, None),
        }
    };
    let mut reply = json!({
        "kind": "upload-status",
        "pairingId": gate.pairing_id,
        "state": state,
    });
    if let Some(inserted) = inserted {
        reply["inserted"] = json!(inserted);
    }
    if let Some(already_known) = already_known {
        reply["alreadyKnown"] = json!(already_known);
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
        message_id: &format!("upload-status:{counter}"),
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
        "reason": "upload-status",
        "envelope": wire,
    }))
}

#[cfg(test)]
pub(super) mod tests {
    use super::super::super::tests::*;
    use super::super::super::*;
    use super::super::snapshot::tests::opened_batch;
    use super::*;
    use serde_json::json;

    // -----------------------------------------------------------------------
    // §9.1 — the upload: staged here, applied by the panel, verdict sealed.
    // -----------------------------------------------------------------------

    /// An upload message from the pinned phone, sealed and framed exactly as
    /// a snapshot message is — admission is the same admission.
    pub(crate) fn seal_upload(counter: u64, message: &JsonValue) -> Vec<u8> {
        let mut body = message.clone();
        let object = body
            .as_object_mut()
            .expect("an upload message is an object");
        object.insert("pairingId".to_string(), json!("pair-1"));
        object.insert("protocolVersion".to_string(), json!(1));
        object.insert("schemaVersion".to_string(), json!(8));
        object.insert("generation".to_string(), json!(1));
        let wire = envelope::seal(SealInput {
            secret: &PHONE_SECRET,
            peer_public: &envelope::public_key(&DESKTOP_SECRET),
            from: PHONE_ID,
            to: DESKTOP_ID,
            message_id: &format!("upload-{counter}"),
            counter,
            message: &body,
            pairing_id: Some("pair-1"),
            nonce: None,
            ephemeral_secret: None,
        })
        .expect("seal the upload message");
        encode_frame(&wire).expect("frame it")
    }

    pub(crate) fn post_upload(port: u16, body: &[u8]) -> (u16, String) {
        let (status, raw) = request(port, "POST /pair/upload", body);
        let text =
            decode_frame(&raw).unwrap_or_else(|_| String::from_utf8_lossy(&raw).into_owned());
        (status, text)
    }

    pub(crate) fn upload_op(uid: &str) -> JsonValue {
        json!({
            "table": "notes",
            "uid": uid,
            "stamp": { "counter": 3, "deviceId": PHONE_ID, "opId": "op-1" },
            "fields": { "text": "a note the phone made offline" },
        })
    }

    #[test]
    fn an_upload_stages_commits_and_reports_the_panels_verdict() {
        let (state, port) = started(false);
        let note_a = "11111111-1111-4111-8111-111111111111";
        let note_b = "22222222-2222-4222-8222-222222222222";

        // Nothing staged: the verdict is pending, sealed like a batch.
        let (status, reply) =
            post_upload(port, &seal_upload(1, &json!({ "kind": "upload-status" })));
        assert_eq!(status, 200, "{reply}");
        let (document, mut desktop) = opened_batch(&reply, 0);
        assert_eq!(document["kind"], json!("upload-status"));
        assert_eq!(document["state"], json!("pending"));

        let (status, reply) = post_upload(
            port,
            &seal_upload(
                2,
                &json!({ "kind": "upload", "batch": 0, "total": 2, "ops": [upload_op(note_a)] }),
            ),
        );
        assert_eq!(status, 200, "{reply}");
        let reply: JsonValue = serde_json::from_str(&reply).expect("reply json");
        assert_eq!(reply["reason"], json!("staged"));
        assert_eq!(reply["ops"], json!(1));

        let (status, _) = post_upload(
            port,
            &seal_upload(
                3,
                &json!({ "kind": "upload", "batch": 1, "total": 2, "ops": [upload_op(note_b)] }),
            ),
        );
        assert_eq!(status, 200);

        // The panel sees receiving, not staged, until the phone commits.
        let info = state.status().expect("status");
        assert_eq!(info.upload_state.as_deref(), Some("receiving"));
        assert_eq!(info.upload_ops, 2);
        assert!(
            state.take_upload().is_none(),
            "uncommitted: nothing to take"
        );

        let (status, reply) =
            post_upload(port, &seal_upload(4, &json!({ "kind": "upload-commit" })));
        assert_eq!(status, 200, "{reply}");
        let reply: JsonValue = serde_json::from_str(&reply).expect("reply json");
        assert_eq!(reply["reason"], json!("upload-committed"));

        let info = state.status().expect("status");
        assert_eq!(info.upload_state.as_deref(), Some("staged"));

        // The panel takes the whole staging exactly once.
        let (pairing_id, ops) = state.take_upload().expect("the staged upload");
        assert_eq!(pairing_id, "pair-1");
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[0]["uid"], json!(note_a));
        assert_eq!(ops[1]["uid"], json!(note_b));
        assert!(state.take_upload().is_none(), "taken once");

        // Still no verdict: the apply has not reported.
        let (status, reply) =
            post_upload(port, &seal_upload(5, &json!({ "kind": "upload-status" })));
        assert_eq!(status, 200, "{reply}");
        let (document, counter) = opened_batch(&reply, desktop);
        desktop = counter;
        assert_eq!(document["state"], json!("pending"));

        state.set_upload_outcome(UploadOutcome::Applied {
            inserted: 1,
            already_known: 1,
        });
        let (status, reply) =
            post_upload(port, &seal_upload(6, &json!({ "kind": "upload-status" })));
        assert_eq!(status, 200, "{reply}");
        let (document, _) = opened_batch(&reply, desktop);
        assert_eq!(document["state"], json!("uploaded"));
        assert_eq!(document["inserted"], json!(1));
        assert_eq!(document["alreadyKnown"], json!(1));

        let info = state.status().expect("status");
        assert_eq!(info.upload_state.as_deref(), Some("applied"));
        assert_eq!(info.upload_inserted, Some(1));
        assert_eq!(info.upload_already_known, Some(1));
        state.stop().expect("stop");
    }

    #[test]
    fn an_upload_refuses_out_of_order_conflicting_and_early_messages() {
        let (state, port) = started(false);
        let note_a = "11111111-1111-4111-8111-111111111111";
        let note_b = "22222222-2222-4222-8222-222222222222";

        // Batch 1 before batch 0: out of order.
        let (status, reply) = post_upload(
            port,
            &seal_upload(
                1,
                &json!({ "kind": "upload", "batch": 1, "total": 2, "ops": [upload_op(note_b)] }),
            ),
        );
        assert_eq!(status, 403, "{reply}");
        assert_eq!(refusal_reason(&reply), "upload-busy");

        // A commit with nothing staged names nothing.
        let (status, reply) =
            post_upload(port, &seal_upload(2, &json!({ "kind": "upload-commit" })));
        assert_eq!(status, 400, "{reply}");

        let (status, _) = post_upload(
            port,
            &seal_upload(
                3,
                &json!({ "kind": "upload", "batch": 0, "total": 2, "ops": [upload_op(note_a)] }),
            ),
        );
        assert_eq!(status, 200);

        // The same batch re-sent (its ack was lost) is staged, not refused.
        let (status, reply) = post_upload(
            port,
            &seal_upload(
                4,
                &json!({ "kind": "upload", "batch": 0, "total": 2, "ops": [upload_op(note_a)] }),
            ),
        );
        assert_eq!(status, 200, "{reply}");

        // A different batch under the same index is a second upload.
        let (status, reply) = post_upload(
            port,
            &seal_upload(
                5,
                &json!({ "kind": "upload", "batch": 0, "total": 2, "ops": [upload_op(note_b)] }),
            ),
        );
        assert_eq!(status, 403, "{reply}");
        assert_eq!(refusal_reason(&reply), "upload-busy");

        // A commit before the last batch is malformed, not early-applied.
        let (status, reply) =
            post_upload(port, &seal_upload(6, &json!({ "kind": "upload-commit" })));
        assert_eq!(status, 400, "{reply}");

        let (status, _) = post_upload(
            port,
            &seal_upload(
                7,
                &json!({ "kind": "upload", "batch": 1, "total": 2, "ops": [upload_op(note_b)] }),
            ),
        );
        assert_eq!(status, 200);
        let (status, _) = post_upload(port, &seal_upload(8, &json!({ "kind": "upload-commit" })));
        assert_eq!(status, 200);

        // A second commit is a replay.
        let (status, reply) =
            post_upload(port, &seal_upload(9, &json!({ "kind": "upload-commit" })));
        assert_eq!(status, 403, "{reply}");
        assert_eq!(refusal_reason(&reply), "replayed");
        state.stop().expect("stop");
    }
}
