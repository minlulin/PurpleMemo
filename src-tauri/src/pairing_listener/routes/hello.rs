//! The §11.1 rendezvous: a plaintext code-confirmed first pairing, and the
//! sealed acknowledgement that follows it.

use std::sync::atomic::Ordering;

use serde::Deserialize;
use serde_json::{json, Value as JsonValue};

use crate::envelope::{self, SealInput};

use super::super::{
    decode_frame, Gate, Opened, PairedPeer, Pin, RefusalReply, PAIRING_MAX_ATTEMPTS,
};
use super::common::{canonical_device_id, codes_equal, normalize_code, now_ms, usable_public_key};

/// The code-confirmed first pairing (§11.1). The request is plaintext and
/// proves only possession of the code: it is not sealed, because the desktop
/// does not know the phone's key yet, and it never becomes a key. Accepting it
/// pins that key for this window and answers under the ordinary envelope, so
/// every message after it is authenticated by the pin (§11.2).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest {
    device_id: String,
    public_key: String,
    #[serde(default)]
    pairing_id: Option<String>,
    code: String,
    protocol_version: u64,
    schema_version: u64,
    // §11.6.1 (D1, Option A): there is deliberately no `generation` here. The
    // desktop owns the data line, and refusing a phone's stale copy would
    // deadlock it after a restore — it would never pair again. Serde ignores
    // unknown fields, so a sender that still includes one parses fine and is
    // ignored.
}

pub(crate) fn rendezvous(gate: &Gate, body: &[u8]) -> Result<JsonValue, RefusalReply> {
    let Some(offer) = gate.offer.as_ref() else {
        return Err(RefusalReply::refused(
            "unpaired",
            "this pairing window has no code; show a code on the desktop first (§11.1).",
        ));
    };
    let text = decode_frame(body).map_err(RefusalReply::malformed)?;
    let request: PairRequest = serde_json::from_str(&text).map_err(|_| {
        RefusalReply::malformed(
            "a pair request is a JSON object with deviceId, publicKey, pairingId and code.",
        )
    })?;
    // §11.1 (N5): validate the metadata BEFORE the code is looked at, so a
    // malformed request costs no attempt and cannot learn whether a guessed code
    // was right. A probe with the right code and a bogus pairing id is a pairing
    // mismatch with the attempt count untouched.
    let Some(presented_pairing) = request.pairing_id.as_deref() else {
        return Err(RefusalReply::refused(
            "pairing-mismatch",
            "this request carries no pairing id; show a new code on the desktop (§11.1).",
        ));
    };
    if presented_pairing != gate.pairing_id.as_str() {
        return Err(RefusalReply::refused(
            "pairing-mismatch",
            "this request belongs to a different pairing; show a new code (§11.4).",
        ));
    }
    if !canonical_device_id(&request.device_id) {
        return Err(RefusalReply::malformed(
            "deviceId is a canonical lowercase UUID v4 (§1.2).",
        ));
    }
    let Some(key) = usable_public_key(&request.public_key) else {
        return Err(RefusalReply::malformed(
            "publicKey is 64 lowercase hex characters naming a usable X25519 point.",
        ));
    };
    if request.protocol_version != gate.local_protocol_version {
        return Err(RefusalReply::refused(
            "protocol-unsupported",
            format!(
                "this build speaks protocol v{}; the peer sent v{}.",
                gate.local_protocol_version, request.protocol_version
            ),
        ));
    }
    if request.schema_version != gate.local_schema_version {
        return Err(RefusalReply::refused(
            "schema-mismatch",
            format!(
                "the peers hold schema v{} and v{} — sync only between identical builds (§8.2).",
                gate.local_schema_version, request.schema_version
            ),
        ));
    }

    let mut state = offer.lock().unwrap_or_else(|e| e.into_inner());
    if state.redeemed {
        return Err(RefusalReply::refused(
            "used",
            "this pairing code was already used once (§11.1).",
        ));
    }
    if now_ms() >= state.expires_at {
        return Err(RefusalReply::refused(
            "expired",
            "this pairing code expired — show a new one on the desktop (§11.1).",
        ));
    }
    if state.attempts >= PAIRING_MAX_ATTEMPTS {
        return Err(RefusalReply::refused(
            "locked",
            "too many wrong codes — the desktop must show a new one (§11.1).",
        ));
    }
    let Some(presented) = normalize_code(&request.code) else {
        // A malformed code costs no attempt, exactly like `redeemCode`.
        return Err(RefusalReply::malformed("the pairing code is six digits."));
    };
    if !codes_equal(&presented, &state.code) {
        state.attempts += 1;
        let left = PAIRING_MAX_ATTEMPTS.saturating_sub(state.attempts);
        return Err(RefusalReply::code_refused(
            "wrong-code",
            if left == 0 {
                "too many wrong codes — the desktop must show a new one (§11.1).".to_string()
            } else {
                format!("that code does not match ({left} attempt(s) left).")
            },
            left,
        ));
    }
    if request.device_id == gate.local_device_id {
        return Err(RefusalReply::refused(
            "same-device",
            "a device cannot pair with itself.",
        ));
    }
    // §11.6.1 (D1, Option A): the pin names the data line the pairing was
    // actually made on — the desktop's. A phone that still believes in an older
    // line is told the current one by the sealed ack below; it is never refused
    // for echoing a stale number.
    let pin = Pin {
        device_id: request.device_id.clone(),
        public_key: key,
        generation: gate.local_generation,
        revoked: false,
    };
    let ack = json!({
        "kind": "paired",
        "pairingId": gate.pairing_id.as_str(),
        "deviceId": gate.local_device_id,
        "generation": gate.local_generation,
        "schemaVersion": gate.local_schema_version,
        "protocolVersion": gate.local_protocol_version,
    });
    let counter = gate.send_counter.fetch_add(1, Ordering::SeqCst) + 1;
    let wire = envelope::seal(SealInput {
        secret: &gate.local_secret,
        peer_public: &key,
        from: &gate.local_device_id,
        to: &request.device_id,
        message_id: &format!("paired:{counter}"),
        counter,
        message: &ack,
        pairing_id: Some(gate.pairing_id.as_str()),
        nonce: None,
        ephemeral_secret: None,
    })
    .map_err(|_| RefusalReply::malformed("the phone's public key is not a usable X25519 point."))?;
    // Single use, set before the reply leaves so two racing requests cannot both
    // win the same code.
    state.redeemed = true;
    drop(state);
    let public_key_hex = envelope::to_hex(&key);
    let fingerprint = crate::pairing_key::fingerprint_of(&public_key_hex);
    // The candidate replaces any earlier candidate for this window — including
    // a phone re-presenting its `deviceId` with a new key. Nothing is stored:
    // Trust (the person's decision) is what writes a pin, and this window's
    // key possession is still unproven until a sealed hello arrives.
    *gate.paired.lock().unwrap_or_else(|e| e.into_inner()) = Some(PairedPeer {
        pin,
        public_key_hex,
        fingerprint,
        hello_received: false,
    });
    // A window re-opened after a previous one carries that window's counter; the
    // newly staged peer has sent nothing, so its first hello is counter 1 and
    // must not be refused as a replay (N5).
    *gate.last_counter.lock().unwrap_or_else(|e| e.into_inner()) = 0;
    Ok(json!({ "ok": true, "reason": "paired", "envelope": wire }))
}

/// only reply.
pub(crate) fn acknowledged(
    gate: &Gate,
    pin: &Pin,
    opened: Opened,
) -> Result<JsonValue, RefusalReply> {
    let counter = gate.send_counter.fetch_add(1, Ordering::SeqCst) + 1;
    let ack = json!({
        "kind": "ack",
        "accepted": opened.header.message_id,
        "generation": gate.local_generation,
        "schemaVersion": gate.local_schema_version,
    });
    let wire = envelope::seal(SealInput {
        secret: &gate.local_secret,
        peer_public: &pin.public_key,
        from: &gate.local_device_id,
        to: &pin.device_id,
        message_id: &format!("ack:{}", opened.header.message_id),
        counter,
        message: &ack,
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
    Ok(json!({ "ok": true, "reason": "accepted", "envelope": wire }))
}

#[cfg(test)]
pub(super) mod tests {
    use super::super::super::tests::*;
    use super::super::super::*;
    use super::*;
    use crate::envelope::OpenInput;
    use serde_json::json;
    use std::net::TcpStream as StdTcpStream;

    #[test]
    fn a_sealed_hello_from_the_pinned_peer_is_accepted_and_answered() {
        let (state, port) = started(false);
        let (status, body) = post(port, &hello_frame(1));
        assert_eq!(status, 200, "{body}");

        let reply: JsonValue = serde_json::from_str(&body).expect("reply json");
        assert_eq!(reply["ok"], json!(true));
        let wire = reply["envelope"].as_str().expect("a sealed ack");
        let opened = envelope::open(OpenInput {
            secret: &PHONE_SECRET,
            peer_public: &envelope::public_key(&DESKTOP_SECRET),
            local_device_id: PHONE_ID,
            expected_from: DESKTOP_ID,
            last_counter: 0,
            pairing_id: Some("pair-1"),
            raw: wire,
        })
        .expect("the phone must open the ack the desktop sealed");
        assert_eq!(opened.message["kind"], json!("ack"));
        assert_eq!(opened.message["accepted"], json!("hello-1"));
        assert_eq!(opened.header.from, DESKTOP_ID);
        assert_eq!(opened.header.to, PHONE_ID);
        assert!(!state.stop().expect("stop").running);
    }

    #[test]
    fn every_reply_is_one_framed_document_like_the_request() {
        let (state, port) = started(false);
        let (status, raw) = request(port, "POST /pair/hello", &hello_frame(1));
        assert_eq!(status, 200);
        let text = decode_frame(&raw).expect("the reply is one framed document");
        let reply: JsonValue = serde_json::from_str(&text).expect("reply json");
        assert_eq!(reply["ok"], json!(true));

        // A refusal is framed the same way: one reader handles both.
        let (status, raw) = request(port, "POST /pair/hello", &hello_frame(1));
        assert_eq!(status, 403);
        let text = decode_frame(&raw).expect("refusals are framed too");
        let reply: JsonValue = serde_json::from_str(&text).expect("refusal json");
        assert_eq!(reply["reason"], json!("replayed"));
        state.stop().expect("stop");
    }

    #[test]
    fn a_replayed_hello_is_refused_over_the_socket() {
        let (state, port) = started(false);
        let frame = hello_frame(1);
        assert_eq!(post(port, &frame).0, 200, "the first copy is accepted");
        let (status, body) = post(port, &frame);
        assert_eq!(status, 403, "{body}");
        assert_eq!(refusal_reason(&body), "replayed");
        state.stop().expect("stop");
    }

    #[test]
    fn a_tampered_envelope_is_refused_over_the_socket() {
        let (state, port) = started(false);
        let wire = hello_wire(1, |_| {});
        let mut parsed: JsonValue = serde_json::from_str(&wire).expect("wire json");
        let mut body = parsed["body"].as_str().expect("body").to_string();
        let last = body.pop().expect("body is not empty");
        body.push(if last == '0' { '1' } else { '0' });
        parsed["body"] = JsonValue::String(body);
        let frame = encode_frame(&parsed.to_string()).expect("frame");

        let (status, reply) = post(port, &frame);
        assert_eq!(status, 403, "{reply}");
        assert_eq!(refusal_reason(&reply), "unauthenticated");
        // Nothing was admitted, so the real hello is still fresh.
        assert_eq!(post(port, &hello_frame(1)).0, 200);
        state.stop().expect("stop");
    }

    #[test]
    fn a_revoked_peer_is_refused_before_anything_else() {
        let (state, port) = started(true);
        // Even a perfectly sealed hello, and the refusal names revocation —
        // not the envelope, not the key.
        let (status, body) = post(port, &hello_frame(1));
        assert_eq!(status, 403, "{body}");
        assert_eq!(refusal_reason(&body), "revoked");
        state.stop().expect("stop");
    }

    #[test]
    fn an_unpaired_peer_is_refused_and_the_listener_still_serves_no_data() {
        let state = PairingListenerState::default();
        let mut unpinned = window(false);
        unpinned.peer = None;
        let info = state
            .start("127.0.0.1", unpinned, desktop_identity(), None)
            .expect("a pinless window still opens");
        let port = info.port.expect("port");
        let (status, body) = post(port, &hello_frame(1));
        assert_eq!(status, 403, "{body}");
        assert_eq!(refusal_reason(&body), "unpaired");
        state.stop().expect("stop");
    }

    #[test]
    fn a_re_keyed_peer_is_refused_over_the_socket() {
        let state = PairingListenerState::default();
        let mut rekeyed = window(false);
        // The pin still holds the OLD key: the phone's new key cannot open.
        rekeyed.peer.as_mut().expect("peer").public_key =
            envelope::to_hex(&envelope::public_key(&[0x44u8; KEY_BYTES]));
        let info = state
            .start("127.0.0.1", rekeyed, desktop_identity(), None)
            .expect("start");
        let (status, body) = post(info.port.expect("port"), &hello_frame(1));
        assert_eq!(status, 403, "{body}");
        assert_eq!(refusal_reason(&body), "unauthenticated");
        state.stop().expect("stop");
    }

    #[test]
    fn a_payload_outside_the_kind_allowlist_is_refused() {
        let (state, port) = started(false);
        let frame = encode_frame(&hello_wire(1, |message| {
            message.insert("kind".to_string(), json!("sync-op"));
        }))
        .expect("frame");
        let (status, body) = post(port, &frame);
        assert_eq!(status, 403, "{body}");
        assert_eq!(refusal_reason(&body), "not-allowed");
        state.stop().expect("stop");
    }

    #[test]
    fn a_hello_from_another_pairing_or_build_line_is_refused() {
        let (state, port) = started(false);

        let pairing = encode_frame(&hello_wire(1, |message| {
            message.insert("pairingId".to_string(), json!("pair-2"));
        }))
        .expect("frame");
        let (status, body) = post(port, &pairing);
        assert_eq!(status, 403, "{body}");
        assert_eq!(refusal_reason(&body), "pairing-mismatch");

        let protocol = encode_frame(&hello_wire(2, |message| {
            message.insert("protocolVersion".to_string(), json!(2));
        }))
        .expect("frame");
        let (status, body) = post(port, &protocol);
        assert_eq!(status, 403, "{body}");
        assert_eq!(refusal_reason(&body), "protocol-unsupported");

        let schema = encode_frame(&hello_wire(3, |message| {
            message.insert("schemaVersion".to_string(), json!(7));
        }))
        .expect("frame");
        let (status, body) = post(port, &schema);
        assert_eq!(status, 403, "{body}");
        assert_eq!(refusal_reason(&body), "schema-mismatch");

        let generation = encode_frame(&hello_wire(4, |message| {
            message.insert("generation".to_string(), json!(9));
        }))
        .expect("frame");
        let (status, body) = post(port, &generation);
        assert_eq!(status, 403, "{body}");
        assert_eq!(refusal_reason(&body), "needs-re-pair");

        state.stop().expect("stop");
    }

    fn started_with_pinned_offer() -> (PairingListenerState, u16) {
        let state = PairingListenerState::default();
        let mut window = offer_window(false);
        window.peer = Some(PinnedPeer {
            device_id: PHONE_ID.to_string(),
            public_key: phone_public_hex(),
            generation: 1,
            revoked: false,
        });
        let info = state
            .start("127.0.0.1", window, desktop_identity(), None)
            .expect("start the pairing window");
        (state, info.port.expect("a bound port"))
    }

    /// A window with an offer whose desktop data line is `generation`.
    fn started_at_generation(generation: u64) -> (PairingListenerState, u16) {
        let state = PairingListenerState::default();
        let mut window = window(false);
        window.local_generation = generation;
        window.peer = None;
        window.offer = Some(PairingOffer {
            code: "123456".to_string(),
            expires_at: now_ms() + 60_000,
        });
        let info = state
            .start("127.0.0.1", window, desktop_identity(), None)
            .expect("start the pairing listener");
        (state, info.port.expect("a bound port"))
    }

    /// §11.6.1 (D1, Option A): the request carries no generation. A phone that
    /// omits it pairs — the desktop owns the data line.
    #[test]
    fn a_request_without_a_generation_pairs() {
        let (state, port) = started_with_offer(false);
        let (status, body) = post_request(
            port,
            &request_body(|message| {
                message.remove("generation");
            }),
        );
        assert_eq!(status, 200, "{body}");
        assert_eq!(
            state.status().expect("status").peer_device_id.as_deref(),
            Some(PHONE_ID)
        );
        state.stop().expect("stop");
    }

    /// The deadlock this decision removes: a phone whose stored generation
    /// predates a desktop restore must still pair. The value it sends is
    /// ignored, the ack carries the desktop's line, and the pin records that
    /// line — so the sealed hello carrying the ack's number is admitted.
    #[test]
    fn a_stale_request_generation_is_ignored_and_the_pin_takes_the_desktops() {
        let (state, port) = started_at_generation(2);
        let (status, body) = post_request(port, &request_body(|_| {}));
        assert_eq!(
            status, 200,
            "a phone that still believes in generation 1 must pair: {body}"
        );
        let reply: JsonValue = serde_json::from_str(&body).expect("reply json");
        let opened = envelope::open(OpenInput {
            secret: &PHONE_SECRET,
            peer_public: &envelope::public_key(&DESKTOP_SECRET),
            local_device_id: PHONE_ID,
            expected_from: DESKTOP_ID,
            last_counter: 0,
            pairing_id: Some("pair-1"),
            raw: reply["envelope"].as_str().expect("a sealed ack"),
        })
        .expect("the phone must open the ack the desktop sealed");
        assert_eq!(
            opened.message["generation"],
            json!(2),
            "the ack names the desktop's line, not the phone's stale one"
        );

        // The staged pin took generation 2, so this hello is admitted; had it
        // kept the phone's 1, `admit` would refuse `needs-re-pair` here.
        let hello = encode_frame(&hello_wire(1, |message| {
            message.insert("generation".to_string(), json!(2));
        }))
        .expect("frame the hello");
        let (status, body) = post(port, &hello);
        assert_eq!(status, 200, "{body}");
        let reported = state.status().expect("status");
        assert_eq!(reported.peer_device_id.as_deref(), Some(PHONE_ID));
        assert!(
            reported.peer_hello_received,
            "the desktop's own line is what the pin records"
        );
        state.stop().expect("stop");
    }

    #[test]
    fn the_desktop_code_stages_the_phone_and_its_next_hello_proves_possession() {
        let (state, port) = started_with_offer(false);
        let (status, body) = post_request(port, &request_body(|_| {}));
        assert_eq!(status, 200, "{body}");

        // The ack is a real sealed envelope, openable only by the phone's
        // secret and the desktop key the offer carried.
        let reply: JsonValue = serde_json::from_str(&body).expect("reply json");
        let wire = reply["envelope"].as_str().expect("a sealed ack");
        let opened = envelope::open(OpenInput {
            secret: &PHONE_SECRET,
            peer_public: &envelope::public_key(&DESKTOP_SECRET),
            local_device_id: PHONE_ID,
            expected_from: DESKTOP_ID,
            last_counter: 0,
            pairing_id: Some("pair-1"),
            raw: wire,
        })
        .expect("the phone must open the ack the desktop sealed");
        assert_eq!(opened.message["kind"], json!("paired"));
        assert_eq!(opened.message["deviceId"], json!(DESKTOP_ID));

        // §11.1 (wave 1, N1): the rendezvous only STAGES a candidate. No pin
        // exists yet — the person has not confirmed — and no Trust is offered
        // until the phone proves it holds the key it presented.
        let staged = state.status().expect("status");
        assert_eq!(staged.peer_device_id.as_deref(), Some(PHONE_ID));
        assert!(
            !staged.peer_hello_received,
            "the ack is sealed TO the key; nothing sealed BY it has arrived yet"
        );

        // §11.2: the sealed hello is that proof, and only then may the panel
        // persist the pin — after the human compares the fingerprints.
        let (status, body) = post(port, &hello_frame(1));
        assert_eq!(status, 200, "{body}");
        let reported = state.status().expect("status");
        assert_eq!(reported.peer_device_id.as_deref(), Some(PHONE_ID));
        assert!(
            reported.peer_hello_received,
            "an opened hello proves possession of the presented key"
        );
        assert_eq!(
            reported.peer_public_key.as_deref(),
            Some(phone_public_hex().as_str())
        );
        assert!(reported.peer_fingerprint.is_some());
        assert!(reported
            .endpoint
            .as_deref()
            .is_some_and(|endpoint| endpoint.starts_with("127.0.0.1:")));
        state.stop().expect("stop");
    }

    #[test]
    fn a_wrong_code_costs_an_attempt_and_five_lock_the_code() {
        let (state, port) = started_with_offer(false);
        for expected_left in (0..PAIRING_MAX_ATTEMPTS).rev() {
            let (status, body) = post_request(
                port,
                &request_body(|message| {
                    message.insert("code".to_string(), json!("000000"));
                }),
            );
            assert_eq!(status, 403, "{body}");
            assert_eq!(refusal_reason(&body), "wrong-code");
            let parsed: JsonValue = serde_json::from_str(&body).expect("refusal json");
            assert_eq!(parsed["attemptsLeft"], json!(expected_left), "{body}");
        }
        // Burnt: the right code is a lockout, not a retry.
        let (status, body) = post_request(port, &request_body(|_| {}));
        assert_eq!(status, 403, "{body}");
        assert_eq!(refusal_reason(&body), "locked");
        state.stop().expect("stop");
    }

    #[test]
    fn a_malformed_code_costs_no_attempt() {
        let (state, port) = started_with_offer(false);
        let (status, body) = post_request(
            port,
            &request_body(|message| {
                message.insert("code".to_string(), json!("12ab"));
            }),
        );
        assert_eq!(status, 400, "{body}");
        assert_eq!(refusal_reason(&body), "malformed");
        // The right code still works: nothing was spent on the typo.
        assert_eq!(post_request(port, &request_body(|_| {})).0, 200);
        state.stop().expect("stop");
    }

    #[test]
    fn the_code_is_single_use_and_expires() {
        let (state, port) = started_with_offer(false);
        assert_eq!(post_request(port, &request_body(|_| {})).0, 200);
        let (status, body) = post_request(port, &request_body(|_| {}));
        assert_eq!(status, 403, "{body}");
        assert_eq!(refusal_reason(&body), "used");
        state.stop().expect("stop");

        let expired = PairingListenerState::default();
        let mut stale = offer_window(false);
        stale.offer = Some(PairingOffer {
            code: "123456".to_string(),
            expires_at: now_ms().saturating_sub(1),
        });
        let info = expired
            .start("127.0.0.1", stale, desktop_identity(), None)
            .expect("start");
        let (status, body) = post_request(info.port.expect("port"), &request_body(|_| {}));
        assert_eq!(status, 403, "{body}");
        assert_eq!(refusal_reason(&body), "expired");
        expired.stop().expect("stop");
    }

    #[test]
    fn a_window_without_a_code_admits_no_first_pairing() {
        // A first pairing is what the code gates, so the test must knock on the
        // rendezvous: `/pair/hello` would only prove that `admit` also refuses
        // an unpinned window (N12).
        let state = PairingListenerState::default();
        let mut pinless = window(false);
        pinless.peer = None;
        let info = state
            .start("127.0.0.1", pinless, desktop_identity(), None)
            .expect("start");
        let (status, body) = post_request(info.port.expect("port"), &request_body(|_| {}));
        assert_eq!(status, 403, "{body}");
        assert_eq!(refusal_reason(&body), "unpaired");
        state.stop().expect("stop");

        // With a pinned peer AND no offer, only the rendezvous' own
        // `offer.is_none()` guard can produce the refusal — `admit` would have
        // accepted a hello from this pin.
        let pinned = PairingListenerState::default();
        let info = pinned
            .start("127.0.0.1", window(false), desktop_identity(), None)
            .expect("start");
        let port = info.port.expect("port");
        let (status, body) = post_request(port, &request_body(|_| {}));
        assert_eq!(status, 403, "{body}");
        assert_eq!(refusal_reason(&body), "unpaired");
        // The window is otherwise alive: its pin still admits its own hello.
        assert_eq!(post(port, &hello_frame(1)).0, 200);
        pinned.stop().expect("stop");
    }

    #[test]
    fn a_window_without_a_pairing_id_refuses_to_open() {
        let state = PairingListenerState::default();
        let mut idless = window(false);
        idless.pairing_id = String::new();
        let error = state
            .start("127.0.0.1", idless, desktop_identity(), None)
            .expect_err("no window may seal under the zero salt (§11.6.1)");
        assert!(error.contains("pairing id"), "{error}");
        assert!(!state.status().expect("status").running);
    }

    #[test]
    fn a_hello_from_this_device_is_refused_as_same_device() {
        let state = PairingListenerState::default();
        let mut selfish = window(false);
        let peer = selfish.peer.as_mut().expect("a peer");
        peer.device_id = DESKTOP_ID.to_string();
        peer.public_key = envelope::to_hex(&envelope::public_key(&DESKTOP_SECRET));
        let info = state
            .start("127.0.0.1", selfish, desktop_identity(), None)
            .expect("start");
        // The pin names this device, so no envelope is even opened (§1.2, N9).
        let (status, body) = post(info.port.expect("port"), &hello_frame(1));
        assert_eq!(status, 403, "{body}");
        assert_eq!(refusal_reason(&body), "same-device");
        state.stop().expect("stop");
    }

    #[test]
    fn a_revoked_pin_is_refused_before_its_key_is_looked_at_but_never_blocks_re_pairing() {
        // §11.3: a revoked peer's key is not even looked at — its sealed hello
        // is refused before any envelope is opened.
        let (revoked, revoked_port) = started(true);
        let (status, body) = post(revoked_port, &hello_frame(1));
        assert_eq!(status, 403, "{body}");
        assert_eq!(refusal_reason(&body), "revoked");
        revoked.stop().expect("stop");

        // The same revoked pin cannot lock the desktop out of re-pairing: the
        // code replaces it, and the hello it pinned is admitted afterwards.
        let state = PairingListenerState::default();
        let mut repin = offer_window(false);
        repin.peer = Some(PinnedPeer {
            device_id: PHONE_ID.to_string(),
            public_key: phone_public_hex(),
            generation: 1,
            revoked: true,
        });
        let info = state
            .start("127.0.0.1", repin, desktop_identity(), None)
            .expect("start");
        let port = info.port.expect("a bound port");
        let (status, body) = post_request(port, &request_body(|_| {}));
        assert_eq!(status, 200, "{body}");
        let (status, body) = post(port, &hello_frame(1));
        assert_eq!(status, 200, "{body}");
        assert_eq!(
            state.status().expect("status").peer_device_id.as_deref(),
            Some(PHONE_ID)
        );
        state.stop().expect("stop");
    }

    #[test]
    fn a_request_from_another_build_line_is_refused() {
        let (state, port) = started_with_offer(false);
        let schema = post_request(
            port,
            &request_body(|message| {
                message.insert("schemaVersion".to_string(), json!(7));
            }),
        );
        assert_eq!(schema.0, 403, "{}", schema.1);
        assert_eq!(refusal_reason(&schema.1), "schema-mismatch");

        // Refusals before the pin leave the code unspent.
        assert_eq!(post_request(port, &request_body(|_| {})).0, 200);
        state.stop().expect("stop");
    }

    // -- staging is not trust: the human confirms (wave 1, N1) ---------------

    #[test]
    fn a_rendezvous_stages_a_candidate_and_writes_nothing() {
        let (state, port) = started_with_offer(false);
        let before = state.status().expect("status");
        assert!(
            before.peer_device_id.is_none(),
            "the window has no candidate before anyone knocks"
        );

        let (status, body) = post_request(port, &request_body(|_| {}));
        assert_eq!(status, 200, "{body}");

        // The listener holds no database, so the only effect is gate state: a
        // candidate reported to the panel, and no proof of possession yet.
        let staged = state.status().expect("status");
        assert_eq!(staged.peer_device_id.as_deref(), Some(PHONE_ID));
        assert_eq!(
            staged.peer_public_key.as_deref(),
            Some(phone_public_hex().as_str())
        );
        assert!(
            !staged.peer_hello_received,
            "staging is not possession: no sealed hello has been opened"
        );
        state.stop().expect("stop");
    }

    #[test]
    fn only_a_sealed_hello_from_the_staged_peer_proves_possession() {
        let (state, port) = started_with_offer(false);
        assert_eq!(post_request(port, &request_body(|_| {})).0, 200);

        // A hello sealed by another key cannot open under the staged key, so it
        // is not the proof the panel waits for.
        let (status, body) = post(port, &hello_frame_from(&OTHER_SECRET, 1));
        assert_eq!(status, 403, "{body}");
        assert_eq!(refusal_reason(&body), "unauthenticated");
        assert!(!state.status().expect("status").peer_hello_received);

        // The staged key's own hello is.
        let (status, body) = post(port, &hello_frame(1));
        assert_eq!(status, 200, "{body}");
        assert!(state.status().expect("status").peer_hello_received);
        state.stop().expect("stop");
    }

    #[test]
    fn a_rendezvous_replaces_the_staged_candidate_and_never_a_stored_pin() {
        let (first, first_port) = started_with_pinned_offer();
        assert_eq!(
            post_request(
                first_port,
                &request_body(|message| {
                    message.insert("publicKey".to_string(), json!(other_public_hex()));
                })
            )
            .0,
            200
        );

        // The candidate for this window is the presented key, not the pin the
        // window was opened with: the old key cannot produce an admitted hello.
        let staged = first.status().expect("status");
        assert_eq!(
            staged.peer_public_key.as_deref(),
            Some(other_public_hex().as_str())
        );
        assert!(!staged.peer_hello_received);
        let (status, body) = post(first_port, &hello_frame_from(&PHONE_SECRET, 1));
        assert_eq!(status, 403, "{body}");
        assert_eq!(refusal_reason(&body), "unauthenticated");
        assert_eq!(post(first_port, &hello_frame_from(&OTHER_SECRET, 1)).0, 200);
        first.stop().expect("stop");

        // Nothing was written: a fresh window opened with the same stored pin
        // stages no candidate, and that pin still admits its own key alone.
        let (second, second_port) = started_with_pinned_offer();
        let reported = second.status().expect("status");
        assert!(
            reported.peer_public_key.is_none(),
            "no staging survives a window"
        );
        assert_eq!(reported.peer_device_id.as_deref(), Some(PHONE_ID));
        assert!(!reported.peer_hello_received);
        assert_eq!(post(second_port, &hello_frame(1)).0, 200);
        second.stop().expect("stop");
    }

    #[test]
    fn after_reject_the_staged_peer_is_refused() {
        let (state, port) = started_with_offer(false);
        assert_eq!(post_request(port, &request_body(|_| {})).0, 200);
        assert_eq!(post(port, &hello_frame(1)).0, 200);

        // Reject is the window closing: the pin is never written, so nothing
        // about this peer survives it — not even the staged candidate.
        state.stop().expect("stop");
        assert!(
            StdTcpStream::connect(("127.0.0.1", port)).is_err(),
            "a rejected window admits nothing"
        );
        let reported = state.status().expect("status");
        assert!(!reported.running);
        assert!(reported.peer_public_key.is_none());
        assert!(!reported.peer_hello_received);
    }

    // -- the socket is ours: bounded reads, validation first (wave 1, N5) ----

    #[test]
    fn a_window_opened_on_an_old_counter_accepts_the_staged_peer_first_hello() {
        let state = PairingListenerState::default();
        let mut window = offer_window(false);
        // A previous window admitted counters up to 7 from some peer.
        window.last_counter = 7;
        let info = state
            .start("127.0.0.1", window, desktop_identity(), None)
            .expect("start");
        let port = info.port.expect("a bound port");
        assert_eq!(post_request(port, &request_body(|_| {})).0, 200);
        // The staged peer has sent nothing, so counter 1 is not a replay.
        let (status, body) = post(port, &hello_frame(1));
        assert_eq!(status, 200, "{body}");
        state.stop().expect("stop");
    }

    #[test]
    fn blind_requests_without_the_pairing_id_burn_no_attempt_and_reveal_nothing() {
        let (state, port) = started_with_offer(false);
        for _ in 0..PAIRING_MAX_ATTEMPTS {
            let (status, body) = post_request(
                port,
                &request_body(|message| {
                    message.insert("pairingId".to_string(), json!("pair-9"));
                }),
            );
            assert_eq!(status, 403, "{body}");
            assert_eq!(refusal_reason(&body), "pairing-mismatch", "{body}");
            assert!(
                !body.contains("attemptsLeft"),
                "a mismatch spends no attempt: {body}"
            );
        }
        // Five blind probes did not lock the code, and the right request pairs.
        assert_eq!(post_request(port, &request_body(|_| {})).0, 200);
        state.stop().expect("stop");
    }

    #[test]
    fn a_mismatch_costs_nothing_and_a_wrong_code_costs_one() {
        let (state, port) = started_with_offer(false);
        // Right code, bogus pairing id: a mismatch with the count untouched.
        let (status, body) = post_request(
            port,
            &request_body(|message| {
                message.insert("pairingId".to_string(), json!("pair-9"));
            }),
        );
        assert_eq!(status, 403, "{body}");
        assert_eq!(refusal_reason(&body), "pairing-mismatch");

        // A wrong code under the right pairing id is the only thing that costs.
        let (status, body) = post_request(
            port,
            &request_body(|message| {
                message.insert("code".to_string(), json!("000000"));
            }),
        );
        assert_eq!(status, 403, "{body}");
        assert_eq!(refusal_reason(&body), "wrong-code");
        let reply: JsonValue = serde_json::from_str(&body).expect("refusal json");
        assert_eq!(
            reply["attemptsLeft"],
            json!(PAIRING_MAX_ATTEMPTS - 1),
            "only the wrong code spent an attempt: {body}"
        );
        state.stop().expect("stop");
    }

    #[test]
    fn a_malformed_peer_identity_is_refused_before_the_code() {
        let (state, port) = started_with_offer(false);
        let oversized = "B".repeat(60_000);
        let short_key = phone_public_hex()[..62].to_string();
        let upper_key = phone_public_hex().to_uppercase();
        let low_order = "00".repeat(KEY_BYTES);
        let cases: Vec<Vec<u8>> = vec![
            request_body(|message| {
                message.insert("deviceId".to_string(), json!(""));
            }),
            request_body(|message| {
                message.insert(
                    "deviceId".to_string(),
                    json!("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb\u{0}"),
                );
            }),
            request_body(|message| {
                message.insert("deviceId".to_string(), json!(oversized));
            }),
            request_body(|message| {
                message.insert("deviceId".to_string(), json!(PHONE_ID.to_uppercase()));
            }),
            request_body(|message| {
                message.insert("deviceId".to_string(), json!("not-a-uuid"));
            }),
            request_body(|message| {
                message.insert("publicKey".to_string(), json!("not-hex"));
            }),
            request_body(|message| {
                message.insert("publicKey".to_string(), json!(short_key));
            }),
            request_body(|message| {
                message.insert("publicKey".to_string(), json!(upper_key));
            }),
            request_body(|message| {
                message.insert("publicKey".to_string(), json!(low_order));
            }),
        ];
        for body in cases {
            let (status, reply) = post_request(port, &body);
            assert_eq!(status, 400, "{reply}");
            assert_eq!(refusal_reason(&reply), "malformed", "{reply}");
            assert!(!reply.contains("attemptsLeft"), "{reply}");
        }
        // Nothing was spent: a well-formed request still pairs.
        assert_eq!(post_request(port, &request_body(|_| {})).0, 200);
        state.stop().expect("stop");
    }
}
