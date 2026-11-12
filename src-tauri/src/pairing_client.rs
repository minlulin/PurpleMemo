//! The phone's sealed client — protocol §11.6.1, Session 7 task T1.
//!
//! The listener in `pairing_listener.rs` is the desktop's half of the pairing
//! wire. This is the phone's: it sends the code-confirmed `POST /pair/request`,
//! opens the sealed `"paired"` acknowledgement, and then sends the sealed
//! `hello` that proves it holds the key it presented. Both requests are framed
//! exactly as the desktop reads them (four big-endian length bytes, then UTF-8
//! JSON), and every byte after the request is an ordinary envelope.
//!
//! **Why this lives in Rust.** The long-term key is [`PairingIdentity`], which
//! is deliberately neither `Clone` nor `Serialize` and is read from the platform
//! key store. A webview that could seal a message could also read the secret,
//! so the wire work is behind the IPC boundary and the phone's UI only ever
//! receives public facts back.
//!
//! **What the phone is allowed to dial.** The offer the person scanned is the
//! only source of an address, and it must parse as an IP `host:port` — no
//! scheme, path, userinfo or name. There is one connection per message, no
//! redirect following, and every read and write is bounded by
//! [`CLIENT_TIMEOUT`]; a desktop that stopped listening is an error, never a
//! hang.
//!
//! **Generation (D1, Option A).** The request carries no `generation`: the
//! desktop owns the data line. The sealed ack delivers the authoritative
//! `generation`, and the hello sends that value back, so the phone can never
//! deadlock a pairing by holding an older number.

use std::collections::HashMap;
use std::fmt;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value as JsonValue};

use crate::envelope::{self, OpenInput, SealInput, KEY_BYTES};
use crate::pairing_key::PairingIdentity;

/// How long any one step of a pairing may take: connect, write, read. The
/// desktop's own budget is the same number, so the phone never gives up while
/// the desktop is still answering.
pub const CLIENT_TIMEOUT: Duration = Duration::from_secs(5);

const REQUEST_PATH: &str = "/pair/request";
const HELLO_PATH: &str = "/pair/hello";

/// The pairing frame cap (§11.6.1), the same number `frame.ts` and the listener
/// enforce. Duplicated here because a client module must not depend on the
/// server's private helpers; a test pins the two halves against one vector.
const MAX_FRAME_BYTES: usize = 64 * 1024;

/// An HTTP head plus one frame. Anything larger is not a pairing reply.
const MAX_REPLY_BYTES: usize = MAX_FRAME_BYTES + 8 * 1024;

/// A hello counter that never repeats inside this process. The desktop refuses
/// a counter it has already accepted (§7.2), and it resets its counter whenever
/// it stages a peer, so a monotonic value is accepted across windows too.
static HELLO_COUNTER: AtomicU64 = AtomicU64::new(0);

/// The next hello counter to use.
pub fn next_hello_counter() -> u64 {
    HELLO_COUNTER.fetch_add(1, Ordering::SeqCst) + 1
}

/// Why a pairing step failed.
///
/// `code` is the wire's own `reason` when the desktop refused (`wrong-code`,
/// `expired`, `unpaired`, …), so the UI can show the protocol's words instead
/// of inventing a second wording. The rest are this module's: `endpoint` (the
/// address is not dialable), `unreachable`, `timeout`, `malformed` (the reply is
/// not a frame / not JSON / not the expected message), `sealed` (the local
/// envelope would not build).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingClientError {
    pub code: String,
    pub message: String,
}

impl PairingClientError {
    fn local(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }

    fn refused(refusal: envelope::Refusal) -> Self {
        Self {
            code: refusal.code().to_string(),
            message: refusal.message(),
        }
    }
}

impl fmt::Display for PairingClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// What the phone knows from the desktop's offer (§11.1) — and the only address
/// this module will ever dial.
#[derive(Debug, Clone)]
pub struct PairingTarget<'a> {
    /// The offer's `host:port`, e.g. `192.168.1.5:8788`.
    pub endpoint: &'a str,
    pub pairing_id: &'a str,
    /// The desktop's long-term public key, hex, as the QR carried it (§11.2).
    pub desktop_public_key: &'a str,
    /// The six digits from the desktop's screen.
    pub code: &'a str,
}

/// The phone's own facts. They come from the local database and build, never
/// from the webview's copy of the offer.
#[derive(Debug, Clone)]
pub struct PhoneFacts<'a> {
    pub device_id: &'a str,
    pub protocol_version: u64,
    pub schema_version: u64,
}

/// The desktop's authoritative values, opened from the sealed `"paired"` ack.
/// These are what the phone stores as its pin (§11.2) and as its data line
/// (§10.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingAck {
    pub pairing_id: String,
    pub desktop_device_id: String,
    pub generation: u64,
    pub schema_version: u64,
    pub protocol_version: u64,
}

/// Send the code-confirmed rendezvous, open the sealed ack, and return the
/// desktop's facts. This proves the desktop holds the key the offer named; it
/// proves nothing yet about the phone's own key possession — that is
/// [`send_hello`].
pub fn request_pairing(
    target: &PairingTarget<'_>,
    facts: &PhoneFacts<'_>,
    identity: &PairingIdentity,
) -> Result<PairingAck, PairingClientError> {
    let body = frame(&request_body(target, facts, identity).to_string())?;
    let reply = post(target.endpoint, REQUEST_PATH, &body)?;
    let wire = reply
        .get("envelope")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| {
            PairingClientError::local(
                "malformed",
                "the desktop's reply carries no sealed acknowledgement.",
            )
        })?;

    // The ack is the first message from a device whose id the phone does not
    // know yet. Its `from` is read from the header only to name the expected
    // sender — the header is the AEAD's associated data, so an altered sender
    // fails the tag rather than being believed.
    let sender = claimed_sender(wire)?;
    let desktop_key = desktop_key(target.desktop_public_key)?;
    let opened = envelope::open(OpenInput {
        secret: identity.secret(),
        peer_public: &desktop_key,
        local_device_id: facts.device_id,
        expected_from: &sender,
        last_counter: 0,
        pairing_id: Some(target.pairing_id),
        raw: wire,
    })
    .map_err(PairingClientError::refused)?;

    if opened.message.get("kind").and_then(JsonValue::as_str) != Some("paired") {
        return Err(PairingClientError::local(
            "malformed",
            "the desktop's acknowledgement is not a pairing acknowledgement.",
        ));
    }
    let pairing_id = string_field(&opened.message, "pairingId")?;
    if pairing_id != target.pairing_id {
        return Err(PairingClientError::local(
            "pairing-mismatch",
            "the acknowledgement belongs to a different pairing.",
        ));
    }
    let desktop_device_id = string_field(&opened.message, "deviceId")?;
    if desktop_device_id != opened.header.from {
        return Err(PairingClientError::local(
            "malformed",
            "the acknowledgement's sender and device id disagree.",
        ));
    }
    Ok(PairingAck {
        pairing_id,
        desktop_device_id,
        generation: number_field(&opened.message, "generation")?,
        schema_version: number_field(&opened.message, "schemaVersion")?,
        protocol_version: number_field(&opened.message, "protocolVersion")?,
    })
}

/// Send the sealed hello that proves this phone holds the key it presented, and
/// open the desktop's sealed acknowledgement. Only after this does the desktop
/// report key possession — and only after that may the person's pin be written
/// (wave 1 N1). The hello's `generation` is the ack's, never the phone's own
/// remembered value (Option A).
pub fn send_hello(
    target: &PairingTarget<'_>,
    facts: &PhoneFacts<'_>,
    identity: &PairingIdentity,
    ack: &PairingAck,
    counter: u64,
) -> Result<(), PairingClientError> {
    let message = json!({
        "kind": "hello",
        "deviceId": facts.device_id,
        "pairingId": ack.pairing_id,
        "protocolVersion": facts.protocol_version,
        "schemaVersion": facts.schema_version,
        "generation": ack.generation,
    });
    let desktop_key = desktop_key(target.desktop_public_key)?;
    let wire = envelope::seal(SealInput {
        secret: identity.secret(),
        peer_public: &desktop_key,
        from: facts.device_id,
        to: &ack.desktop_device_id,
        message_id: &format!("hello:{counter}"),
        counter,
        message: &message,
        pairing_id: Some(ack.pairing_id.as_str()),
        nonce: None,
        ephemeral_secret: None,
    })
    .map_err(|message| PairingClientError::local("sealed", message))?;

    let reply = post(target.endpoint, HELLO_PATH, &frame(&wire)?)?;
    let reply_wire = reply
        .get("envelope")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| {
            PairingClientError::local("malformed", "the desktop's hello reply is not sealed.")
        })?;
    let opened = envelope::open(OpenInput {
        secret: identity.secret(),
        peer_public: &desktop_key,
        local_device_id: facts.device_id,
        expected_from: &ack.desktop_device_id,
        last_counter: 0,
        pairing_id: Some(ack.pairing_id.as_str()),
        raw: reply_wire,
    })
    .map_err(PairingClientError::refused)?;
    if opened.message.get("kind").and_then(JsonValue::as_str) != Some("ack") {
        return Err(PairingClientError::local(
            "malformed",
            "the desktop's hello reply is not an acknowledgement.",
        ));
    }
    let accepted = opened
        .message
        .get("accepted")
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    if accepted.is_empty() {
        return Err(PairingClientError::local(
            "malformed",
            "the desktop's acknowledgement names no message.",
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The §8.4 pull: request a batch, acknowledge it, acknowledge the whole.
// ---------------------------------------------------------------------------

/// §8.4's endpoint, beside the rendezvous and the hello.
const SNAPSHOT_PATH: &str = "/pair/snapshot";

/// The desktop as this phone pinned it (§11.2), plus the build and data line
/// both sides agreed on at the hello (Option A, D1).
#[derive(Debug, Clone)]
pub struct SnapshotPull<'a> {
    pub endpoint: &'a str,
    pub pairing_id: &'a str,
    pub desktop_public_key: &'a str,
    pub desktop_device_id: &'a str,
    /// The generation the ack delivered. Admission compares it to its own; the
    /// phone never chooses it, it only echoes what it was given.
    pub generation: u64,
}

/// The highest desktop counter this build has accepted, per pairing.
///
/// §7.2 needs the highest counter *already accepted*, and that has to live on
/// this side of the IPC boundary: a webview allowed to pass `last_counter`
/// could pass 0 and accept a replay. So the number is kept here, in Rust, and
/// every sealed reply the phone opens advances it.
#[derive(Default)]
pub struct ReplyCounter {
    inner: Mutex<HashMap<String, u64>>,
}

impl ReplyCounter {
    /// The highest counter accepted from `pairing_id`, or 0 for a fresh pull.
    pub fn last(&self, pairing_id: &str) -> u64 {
        *self
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(pairing_id)
            .unwrap_or(&0)
    }

    /// Record `counter`. False means it did not advance, so it is a replay.
    fn accept(&self, pairing_id: &str, counter: u64) -> bool {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let seen = inner.entry(pairing_id.to_string()).or_insert(0);
        if counter <= *seen {
            return false;
        }
        *seen = counter;
        true
    }

    /// A pull begins at batch 0 and a window's `send_counter` begins again at 1
    /// (§11.4), so the counters a previous window left behind are retired.
    fn restart(&self, pairing_id: &str) {
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(pairing_id);
    }
}

/// The one process-wide set of counters. The pull commands are per-call, so the
/// replay state outlives them here rather than in the webview.
pub fn process_counters() -> &'static ReplyCounter {
    static COUNTERS: OnceLock<ReplyCounter> = OnceLock::new();
    COUNTERS.get_or_init(ReplyCounter::default)
}

/// Ask for one batch (§8.4). Batch 0 starts a pull: it retires the pairing's
/// counters and takes whatever snapshot the desktop holds now, because an
/// interrupted pull is re-taken from the start, never resumed from the middle.
pub fn request_snapshot(
    pull: &SnapshotPull<'_>,
    facts: &PhoneFacts<'_>,
    identity: &PairingIdentity,
    counters: &ReplyCounter,
    batch: u64,
) -> Result<JsonValue, PairingClientError> {
    if batch == 0 {
        counters.restart(pull.pairing_id);
    }
    let reply = exchange(
        pull,
        facts,
        identity,
        counters,
        &json!({
            "kind": "snapshot-request",
            "batch": batch,
            "pairingId": pull.pairing_id,
            "protocolVersion": facts.protocol_version,
            "schemaVersion": facts.schema_version,
            "generation": pull.generation,
        }),
    )?;
    if reply.get("kind").and_then(JsonValue::as_str) != Some("snapshot") {
        return Err(PairingClientError::local(
            "malformed",
            "the desktop's reply is not a snapshot batch.",
        ));
    }
    // The batch the phone asked for. A reply that names a different index would
    // be staged under the wrong one, so it is refused rather than renumbered.
    if reply.get("batch").and_then(JsonValue::as_u64) != Some(batch) {
        return Err(PairingClientError::local(
            "malformed",
            "the desktop answered with a different batch than the one requested.",
        ));
    }
    if reply.get("pairingId").and_then(JsonValue::as_str) != Some(pull.pairing_id) {
        return Err(PairingClientError::local(
            "pairing-mismatch",
            "that batch belongs to a different pairing.",
        ));
    }
    if reply.get("total").and_then(JsonValue::as_u64).unwrap_or(0) == 0 {
        return Err(PairingClientError::local(
            "malformed",
            "the desktop's snapshot names no batches.",
        ));
    }
    Ok(reply)
}

/// Tell the desktop one batch was staged. Nothing is applied on this side, so
/// this is bookkeeping — it is what lets the desktop refuse a duplicate
/// acknowledgement and an adoption that skipped a batch.
pub fn acknowledge_batch(
    pull: &SnapshotPull<'_>,
    facts: &PhoneFacts<'_>,
    identity: &PairingIdentity,
    counters: &ReplyCounter,
    batch: u64,
) -> Result<(), PairingClientError> {
    exchange(
        pull,
        facts,
        identity,
        counters,
        &json!({
            "kind": "applied",
            "batch": batch,
            "pairingId": pull.pairing_id,
            "protocolVersion": facts.protocol_version,
            "schemaVersion": facts.schema_version,
            "generation": pull.generation,
        }),
    )?;
    Ok(())
}

/// Tell the desktop the whole snapshot was applied, with the counts the §9.3
/// summary shows. The desktop refuses this unless every batch was acknowledged
/// first: "applied the last one" is not "applied all of them" (§8.4).
pub fn acknowledge_snapshot(
    pull: &SnapshotPull<'_>,
    facts: &PhoneFacts<'_>,
    identity: &PairingIdentity,
    counters: &ReplyCounter,
    rows: u64,
    tombstones: u64,
) -> Result<(), PairingClientError> {
    exchange(
        pull,
        facts,
        identity,
        counters,
        &json!({
            "kind": "adopted",
            "pairingId": pull.pairing_id,
            "protocolVersion": facts.protocol_version,
            "schemaVersion": facts.schema_version,
            "generation": pull.generation,
            "counts": { "rows": rows, "tombstones": tombstones },
        }),
    )?;
    Ok(())
}

/// §9.1's route, beside the snapshot's.
const UPLOAD_PATH: &str = "/pair/upload";

/// Send one batch of this phone's own records (§9.1). Batch 0 begins an
/// upload: it retires the pairing's reply counters, exactly as a pull does —
/// a window's `send_counter` begins again at 1, so the counters a previous
/// window left behind would refuse this window's first sealed verdict. The
/// retirement is safe for the same reason the pull's is: every reply this
/// transfer acts on is checked by kind or reason before it is believed, so a
/// replayed pull reply cannot pass as an upload verdict.
pub fn send_upload_batch(
    pull: &SnapshotPull<'_>,
    facts: &PhoneFacts<'_>,
    identity: &PairingIdentity,
    counters: &ReplyCounter,
    batch: u64,
    total: u64,
    ops: &[JsonValue],
) -> Result<(), PairingClientError> {
    if batch == 0 {
        counters.restart(pull.pairing_id);
    }
    let reply = exchange_on(
        pull,
        facts,
        identity,
        counters,
        UPLOAD_PATH,
        "upload",
        &json!({
            "kind": "upload",
            "batch": batch,
            "total": total,
            "ops": ops,
            "pairingId": pull.pairing_id,
            "protocolVersion": facts.protocol_version,
            "schemaVersion": facts.schema_version,
            "generation": pull.generation,
        }),
    )?;
    if reply.get("reason").and_then(JsonValue::as_str) != Some("staged") {
        return Err(PairingClientError::local(
            "malformed",
            "the desktop's reply does not stage the batch.",
        ));
    }
    if reply.get("batch").and_then(JsonValue::as_u64) != Some(batch) {
        return Err(PairingClientError::local(
            "malformed",
            "the desktop staged a different batch than the one sent.",
        ));
    }
    Ok(())
}

/// Tell the desktop every batch was sent (§9.1). The desktop refuses this
/// unless all of them are staged, so a resolved commit means the whole
/// upload is on the desktop — staged, not yet applied.
pub fn send_upload_commit(
    pull: &SnapshotPull<'_>,
    facts: &PhoneFacts<'_>,
    identity: &PairingIdentity,
    counters: &ReplyCounter,
) -> Result<(), PairingClientError> {
    let reply = exchange_on(
        pull,
        facts,
        identity,
        counters,
        UPLOAD_PATH,
        "upload",
        &json!({
            "kind": "upload-commit",
            "pairingId": pull.pairing_id,
            "protocolVersion": facts.protocol_version,
            "schemaVersion": facts.schema_version,
            "generation": pull.generation,
        }),
    )?;
    if reply.get("reason").and_then(JsonValue::as_str) != Some("upload-committed") {
        return Err(PairingClientError::local(
            "malformed",
            "the desktop's reply does not commit the upload.",
        ));
    }
    Ok(())
}

/// Ask what the desktop's apply decided (§9.1). The reply is sealed — the one
/// upload answer this phone acts on — so its kind and pairing are checked the
/// way a snapshot batch's are, and the process-wide counter guards its replay.
pub fn poll_upload_status(
    pull: &SnapshotPull<'_>,
    facts: &PhoneFacts<'_>,
    identity: &PairingIdentity,
    counters: &ReplyCounter,
) -> Result<JsonValue, PairingClientError> {
    let reply = exchange_on(
        pull,
        facts,
        identity,
        counters,
        UPLOAD_PATH,
        "upload",
        &json!({
            "kind": "upload-status",
            "pairingId": pull.pairing_id,
            "protocolVersion": facts.protocol_version,
            "schemaVersion": facts.schema_version,
            "generation": pull.generation,
        }),
    )?;
    if reply.get("kind").and_then(JsonValue::as_str) != Some("upload-status") {
        return Err(PairingClientError::local(
            "malformed",
            "the desktop's reply is not an upload verdict.",
        ));
    }
    if reply.get("pairingId").and_then(JsonValue::as_str) != Some(pull.pairing_id) {
        return Err(PairingClientError::local(
            "pairing-mismatch",
            "that verdict belongs to a different pairing.",
        ));
    }
    Ok(reply)
}

/// Seal one message, post it, and open whatever the desktop sealed back.
///
/// A `snapshot-request` is answered with a sealed batch; `applied` and `adopted`
/// are answered with an ordinary accepted reply, which carries no counter to
/// guard because nothing in it is acted on — a forged `ok` only makes the phone
/// send the next message, which the desktop then refuses on its own terms.
///
/// `path` and `label` are the route's own: the §9.1 upload rides the same
/// exchange on its own route, and its `upload-status` reply IS acted on — it is
/// sealed, and `poll_upload_status` checks its kind before believing it.
fn exchange(
    pull: &SnapshotPull<'_>,
    facts: &PhoneFacts<'_>,
    identity: &PairingIdentity,
    counters: &ReplyCounter,
    message: &JsonValue,
) -> Result<JsonValue, PairingClientError> {
    exchange_on(
        pull,
        facts,
        identity,
        counters,
        SNAPSHOT_PATH,
        "snapshot",
        message,
    )
}

fn exchange_on(
    pull: &SnapshotPull<'_>,
    facts: &PhoneFacts<'_>,
    identity: &PairingIdentity,
    counters: &ReplyCounter,
    path: &str,
    label: &str,
    message: &JsonValue,
) -> Result<JsonValue, PairingClientError> {
    let counter = next_hello_counter();
    let desktop_key = desktop_key(pull.desktop_public_key)?;
    let wire = envelope::seal(SealInput {
        secret: identity.secret(),
        peer_public: &desktop_key,
        from: facts.device_id,
        to: pull.desktop_device_id,
        message_id: &format!("{label}:{counter}"),
        counter,
        message,
        pairing_id: Some(pull.pairing_id),
        nonce: None,
        ephemeral_secret: None,
    })
    .map_err(|message| PairingClientError::local("sealed", message))?;

    let reply = post(pull.endpoint, path, &frame(&wire)?)?;
    // `applied` and `adopted` are answered with an ordinary accepted reply, not
    // a sealed one: nothing in it is acted on, so there is no counter to guard.
    let Some(reply_wire) = reply.get("envelope").and_then(JsonValue::as_str) else {
        return Ok(reply);
    };
    let opened = envelope::open(OpenInput {
        secret: identity.secret(),
        peer_public: &desktop_key,
        local_device_id: facts.device_id,
        expected_from: pull.desktop_device_id,
        last_counter: counters.last(pull.pairing_id),
        pairing_id: Some(pull.pairing_id),
        raw: reply_wire,
    })
    .map_err(PairingClientError::refused)?;
    if !counters.accept(pull.pairing_id, opened.header.counter) {
        return Err(PairingClientError::local(
            "replayed",
            "the desktop re-used an envelope counter in this pull (§7.2).",
        ));
    }
    Ok(opened.message)
}

/// The request body the desktop's `POST /pair/request` accepts (§11.6.1). No
/// `generation` (Option A, D1); the desktop ignores one if an older client
/// sends it, so this is a narrowing, not a wire break.
fn request_body(
    target: &PairingTarget<'_>,
    facts: &PhoneFacts<'_>,
    identity: &PairingIdentity,
) -> JsonValue {
    json!({
        "deviceId": facts.device_id,
        "publicKey": identity.public_key_hex(),
        "pairingId": target.pairing_id,
        "code": target.code,
        "protocolVersion": facts.protocol_version,
        "schemaVersion": facts.schema_version,
    })
}

/// One request, one reply. The desktop's server requires `Content-Length`,
/// refuses chunked bodies and always closes the connection, so this client
/// sends exactly that shape and reads to EOF.
fn post(endpoint: &str, path: &str, body: &[u8]) -> Result<JsonValue, PairingClientError> {
    let address = endpoint_address(endpoint)?;
    let mut stream = TcpStream::connect_timeout(&address, CLIENT_TIMEOUT).map_err(|error| {
        if error.kind() == std::io::ErrorKind::TimedOut {
            PairingClientError::local(
                "timeout",
                format!("the desktop at {endpoint} did not answer in time."),
            )
        } else {
            PairingClientError::local(
                "unreachable",
                format!("could not reach the desktop at {endpoint}: {error}"),
            )
        }
    })?;
    stream
        .set_read_timeout(Some(CLIENT_TIMEOUT))
        .map_err(|error| PairingClientError::local("unreachable", error.to_string()))?;
    stream
        .set_write_timeout(Some(CLIENT_TIMEOUT))
        .map_err(|error| PairingClientError::local("unreachable", error.to_string()))?;

    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/octet-stream\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n",
        endpoint,
        body.len()
    );
    stream
        .write_all(head.as_bytes())
        .and_then(|()| stream.write_all(body))
        .and_then(|()| stream.flush())
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::TimedOut {
                PairingClientError::local("timeout", "the desktop stopped reading the request.")
            } else {
                PairingClientError::local(
                    "unreachable",
                    format!("the pairing request could not be sent: {error}"),
                )
            }
        })?;

    let mut raw = Vec::new();
    (&mut stream)
        .take(MAX_REPLY_BYTES as u64 + 1)
        .read_to_end(&mut raw)
        .map_err(|error| {
            if matches!(
                error.kind(),
                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
            ) {
                PairingClientError::local(
                    "timeout",
                    "the desktop did not finish its reply in time.",
                )
            } else {
                PairingClientError::local(
                    "malformed",
                    format!("the desktop's reply could not be read: {error}"),
                )
            }
        })?;
    if raw.len() > MAX_REPLY_BYTES {
        return Err(PairingClientError::local(
            "malformed",
            "the desktop's reply is larger than a pairing reply may be.",
        ));
    }

    let (status, payload) = split_response(&raw)?;
    let text = decode_frame(payload)?;
    let reply: JsonValue = serde_json::from_str(&text)
        .map_err(|_| PairingClientError::local("malformed", "the desktop's reply is not JSON."))?;
    let ok = reply.get("ok").and_then(JsonValue::as_bool);
    if ok == Some(false) {
        let reason = reply
            .get("reason")
            .and_then(JsonValue::as_str)
            .unwrap_or("refused");
        let message = reply
            .get("message")
            .and_then(JsonValue::as_str)
            .unwrap_or("the desktop refused this pairing.");
        return Err(PairingClientError {
            code: reason.to_string(),
            message: message.to_string(),
        });
    }
    if ok != Some(true) {
        return Err(PairingClientError::local(
            "malformed",
            "the desktop's reply does not say whether it was accepted.",
        ));
    }
    if status != 200 {
        return Err(PairingClientError::local(
            "unexpected",
            format!("the desktop answered HTTP {status}."),
        ));
    }
    Ok(reply)
}

/// The offer's address, and nothing else. Parsed as an IP socket address so a
/// scheme, path, userinfo or hostname is refused before any socket exists.
fn endpoint_address(endpoint: &str) -> Result<SocketAddr, PairingClientError> {
    endpoint.parse::<SocketAddr>().map_err(|_| {
        PairingClientError::local(
            "endpoint",
            "the pairing code's address is not an IP host:port this app can dial.",
        )
    })
}

fn desktop_key(hex: &str) -> Result<[u8; KEY_BYTES], PairingClientError> {
    let bytes = envelope::from_hex(hex)
        .filter(|bytes| bytes.len() == KEY_BYTES)
        .ok_or_else(|| {
            PairingClientError::local(
                "malformed",
                "the pairing code does not carry a 32-byte desktop key.",
            )
        })?;
    let mut key = [0u8; KEY_BYTES];
    key.copy_from_slice(&bytes);
    Ok(key)
}

/// The sender a wire string claims. Used only as the expected sender of the
/// first message, where the AEAD tag is the real proof: a changed `from` fails
/// the tag, and a message sealed by anyone without the offered peer's key never
/// opens at all.
fn claimed_sender(wire: &str) -> Result<String, PairingClientError> {
    let value: JsonValue = serde_json::from_str(wire).map_err(|_| {
        PairingClientError::local(
            "malformed",
            "the desktop's acknowledgement is not an envelope.",
        )
    })?;
    value
        .get("header")
        .and_then(|header| header.get("from"))
        .and_then(JsonValue::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            PairingClientError::local("malformed", "the acknowledgement names no sender.")
        })
}

fn string_field(message: &JsonValue, key: &str) -> Result<String, PairingClientError> {
    message
        .get(key)
        .and_then(JsonValue::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            PairingClientError::local("malformed", format!("the acknowledgement has no {key}."))
        })
}

fn number_field(message: &JsonValue, key: &str) -> Result<u64, PairingClientError> {
    message.get(key).and_then(JsonValue::as_u64).ok_or_else(|| {
        PairingClientError::local("malformed", format!("the acknowledgement has no {key}."))
    })
}

fn split_response(raw: &[u8]) -> Result<(u16, &[u8]), PairingClientError> {
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| {
            PairingClientError::local("malformed", "the desktop's reply has no HTTP head.")
        })?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| {
            PairingClientError::local("malformed", "the desktop's reply has no HTTP status.")
        })?;
    Ok((status, &raw[split + 4..]))
}

/// The four-byte big-endian length prefix both halves speak (§11.6.1).
fn frame(text: &str) -> Result<Vec<u8>, PairingClientError> {
    let body = text.as_bytes();
    if body.len() > MAX_FRAME_BYTES {
        return Err(PairingClientError::local(
            "malformed",
            format!("a pairing message is limited to {MAX_FRAME_BYTES} bytes."),
        ));
    }
    let mut framed = Vec::with_capacity(4 + body.len());
    framed.extend_from_slice(&(body.len() as u32).to_be_bytes());
    framed.extend_from_slice(body);
    Ok(framed)
}

fn decode_frame(body: &[u8]) -> Result<String, PairingClientError> {
    if body.len() < 4 {
        return Err(PairingClientError::local(
            "malformed",
            "the desktop's reply is not a framed message.",
        ));
    }
    let length = u32::from_be_bytes([body[0], body[1], body[2], body[3]]) as usize;
    if length > MAX_FRAME_BYTES || body.len() - 4 != length {
        return Err(PairingClientError::local(
            "malformed",
            "the desktop's reply is not one framed message.",
        ));
    }
    String::from_utf8(body[4..].to_vec())
        .map_err(|_| PairingClientError::local("malformed", "the desktop's reply is not UTF-8."))
}

// ---------------------------------------------------------------------------
// Tests — a real listener window on loopback, real crypto, no stubs.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pairing_listener::{
        PairingListenerState, PairingOffer, PairingWindow, SnapshotSource,
    };
    use crate::pairing_snapshot::{Snapshot, SnapshotRow, Stamp};
    use std::net::TcpListener;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    const DESKTOP_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const PHONE_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const PAIRING_ID: &str = "pair-1";
    const CODE: &str = "123456";
    const DESKTOP_SECRET: [u8; KEY_BYTES] = [0x11u8; KEY_BYTES];
    const PHONE_SECRET: [u8; KEY_BYTES] = [0x22u8; KEY_BYTES];

    fn phone_identity() -> PairingIdentity {
        PairingIdentity::from_secret(PHONE_SECRET)
    }

    /// The desktop's offered key, computed once and shared so every target can
    /// borrow it for as long as the call needs.
    fn desktop_public_hex() -> &'static str {
        static KEY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        KEY.get_or_init(|| envelope::to_hex(&envelope::public_key(&DESKTOP_SECRET)))
    }

    fn facts() -> PhoneFacts<'static> {
        PhoneFacts {
            device_id: PHONE_ID,
            protocol_version: 1,
            schema_version: 8,
        }
    }

    fn expires_at() -> u64 {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the clock is after 1970")
            .as_millis() as u64;
        now + 60_000
    }

    fn started(generation: u64, offer: bool) -> (PairingListenerState, u16) {
        let state = PairingListenerState::default();
        let window = PairingWindow {
            local_device_id: DESKTOP_ID.to_string(),
            local_generation: generation,
            local_protocol_version: 1,
            local_schema_version: 8,
            pairing_id: PAIRING_ID.to_string(),
            offer: offer.then(|| PairingOffer {
                code: CODE.to_string(),
                expires_at: expires_at(),
            }),
            peer: None,
            last_counter: 0,
        };
        let info = state
            .start(
                "127.0.0.1",
                window,
                PairingIdentity::from_secret(DESKTOP_SECRET),
                None,
            )
            .expect("start the pairing listener");
        (state, info.port.expect("a bound port"))
    }

    fn target<'a>(endpoint: &'a str, code: &'a str) -> PairingTarget<'a> {
        PairingTarget {
            endpoint,
            pairing_id: PAIRING_ID,
            desktop_public_key: desktop_public_hex(),
            code,
        }
    }

    #[test]
    fn a_framed_request_and_a_sealed_hello_prove_the_pairing() {
        let (state, port) = started(1, true);
        let endpoint = format!("127.0.0.1:{port}");
        let target = target(&endpoint, CODE);
        let identity = phone_identity();

        let ack = request_pairing(&target, &facts(), &identity)
            .expect("the desktop's code must be accepted");
        assert_eq!(ack.pairing_id, PAIRING_ID);
        assert_eq!(ack.desktop_device_id, DESKTOP_ID);
        assert_eq!(ack.generation, 1);
        assert_eq!(ack.schema_version, 8);
        assert_eq!(ack.protocol_version, 1);

        // The ack only staged the phone; nothing has proved key possession yet.
        let staged = state.status().expect("status");
        assert_eq!(staged.peer_device_id.as_deref(), Some(PHONE_ID));
        assert!(!staged.peer_hello_received);

        // The counter comes from the process-wide allocator, as production does
        // (`commands.rs`), so a later `exchange` in this process cannot reuse it.
        send_hello(&target, &facts(), &identity, &ack, next_hello_counter())
            .expect("the sealed hello must be accepted");
        let reported = state.status().expect("status");
        assert!(
            reported.peer_hello_received,
            "the desktop opened our hello, so the key we presented is ours"
        );
        assert_eq!(
            reported.peer_public_key.as_deref(),
            Some(envelope::to_hex(&envelope::public_key(&PHONE_SECRET)).as_str())
        );
        state.stop().expect("stop");
    }

    /// D1 Option A: the phone never sends a generation; the desktop owns the
    /// number and the ack delivers it.
    #[test]
    fn the_request_carries_no_generation() {
        let body = request_body(&target("127.0.0.1:1", CODE), &facts(), &phone_identity());
        let object = body.as_object().expect("the request is an object");
        assert!(
            !object.contains_key("generation"),
            "the request must not echo a data line (D1)"
        );
        assert_eq!(object["deviceId"], json!(PHONE_ID));
        assert_eq!(object["pairingId"], json!(PAIRING_ID));
        assert_eq!(object["code"], json!(CODE));
    }

    /// The hello's generation comes from the ack, not from anything the phone
    /// remembered — so a window on a restored line still pairs.
    #[test]
    fn the_hello_uses_the_generation_the_ack_delivered() {
        let (state, port) = started(3, true);
        let endpoint = format!("127.0.0.1:{port}");
        let target = target(&endpoint, CODE);
        let identity = phone_identity();

        let ack = request_pairing(&target, &facts(), &identity).expect("the code is accepted");
        assert_eq!(ack.generation, 3);
        send_hello(&target, &facts(), &identity, &ack, next_hello_counter())
            .expect("a hello carrying the desktop's own line is admitted");
        assert!(state.status().expect("status").peer_hello_received);
        state.stop().expect("stop");
    }

    #[test]
    fn a_wrong_code_is_refused_in_the_wires_own_words() {
        let (state, port) = started(1, true);
        let endpoint = format!("127.0.0.1:{port}");
        let target = target(&endpoint, "000000");
        let error = request_pairing(&target, &facts(), &phone_identity())
            .expect_err("the wrong code cannot pair");
        assert_eq!(error.code, "wrong-code");
        assert!(error.message.contains("attempt"), "{}", error.message);
        assert!(
            state.status().expect("status").peer_device_id.is_none(),
            "a wrong code stages nothing"
        );
        state.stop().expect("stop");
    }

    #[test]
    fn a_window_without_a_code_is_unpaired() {
        let (state, port) = started(1, false);
        let endpoint = format!("127.0.0.1:{port}");
        let error = request_pairing(&target(&endpoint, CODE), &facts(), &phone_identity())
            .expect_err("a window with no code cannot pair");
        assert_eq!(error.code, "unpaired");
        state.stop().expect("stop");
    }

    #[test]
    fn an_endpoint_that_is_not_host_port_is_refused_before_dialing() {
        for endpoint in ["http://127.0.0.1:8788/", "127.0.0.1", "desktop.local:8788"] {
            let error = request_pairing(&target(endpoint, CODE), &facts(), &phone_identity())
                .expect_err("only an IP host:port may be dialled");
            assert_eq!(error.code, "endpoint", "{endpoint}");
        }
    }

    #[test]
    fn a_reply_that_is_not_a_frame_is_refused() {
        let server = TcpListener::bind("127.0.0.1:0").expect("bind a fake desktop");
        let port = server.local_addr().expect("addr").port();
        let handle = thread::spawn(move || {
            let (mut stream, _) = server.accept().expect("accept");
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc");
        });
        let endpoint = format!("127.0.0.1:{port}");
        let error = request_pairing(&target(&endpoint, CODE), &facts(), &phone_identity())
            .expect_err("an unframed reply is not an answer");
        assert_eq!(error.code, "malformed");
        handle.join().expect("the fake desktop finishes");
    }

    #[test]
    fn a_stopped_window_is_unreachable_not_a_hang() {
        let (state, port) = started(1, true);
        state.stop().expect("stop");
        let endpoint = format!("127.0.0.1:{port}");
        let error = request_pairing(&target(&endpoint, CODE), &facts(), &phone_identity())
            .expect_err("nothing is listening any more");
        assert_eq!(error.code, "unreachable");
    }

    /// The same vector `src/lib/sync/frame.test.ts` asserts: four big-endian
    /// length bytes, then the UTF-8 body. A change to either half fails here.
    #[test]
    fn the_frame_is_the_length_prefix_the_typescript_half_uses() {
        let text = "{\"hello\":\"world\"}";
        let framed = frame(text).expect("frame it");
        assert_eq!(&framed[..4], &[0x00, 0x00, 0x00, 0x11]);
        assert_eq!(framed.len(), 4 + 17);
        assert_eq!(decode_frame(&framed).expect("decode it"), text);
        assert!(decode_frame(&framed[..framed.len() - 1]).is_err());
        assert!(decode_frame(b"\x00\x00\x00\x01\xff").is_err());
    }

    // -----------------------------------------------------------------------
    // The §8.4 pull, over a real window and real crypto.
    // -----------------------------------------------------------------------

    /// A desktop window that can serve a snapshot: a live code to pair with,
    /// and a source that reads `rows` notes.
    fn serving(rows: usize) -> (PairingListenerState, u16) {
        let state = PairingListenerState::default();
        let window = PairingWindow {
            local_device_id: DESKTOP_ID.to_string(),
            local_generation: 1,
            local_protocol_version: 1,
            local_schema_version: 8,
            pairing_id: PAIRING_ID.to_string(),
            offer: Some(PairingOffer {
                code: CODE.to_string(),
                expires_at: expires_at(),
            }),
            peer: None,
            last_counter: 0,
        };
        let source: SnapshotSource = std::sync::Arc::new(move || Ok(snapshot_of(rows)));
        let info = state
            .start(
                "127.0.0.1",
                window,
                PairingIdentity::from_secret(DESKTOP_SECRET),
                Some(source),
            )
            .expect("start the pairing listener");
        (state, info.port.expect("a bound port"))
    }

    fn snapshot_of(rows: usize) -> Snapshot {
        Snapshot {
            rows: (0..rows)
                .map(|index| SnapshotRow {
                    table: "notes".to_string(),
                    uid: format!("11111111-1111-4111-8111-{index:012}"),
                    stamp: Stamp {
                        counter: 1,
                        device_id: DESKTOP_ID.to_string(),
                        op_id: format!("op-{index}"),
                    },
                    fields: serde_json::Map::from_iter([(
                        "title".to_string(),
                        json!(format!("pull note {index}")),
                    )]),
                })
                .collect(),
            tombstones: Vec::new(),
        }
    }

    fn pulling<'a>(endpoint: &'a str) -> SnapshotPull<'a> {
        SnapshotPull {
            endpoint,
            pairing_id: PAIRING_ID,
            desktop_public_key: desktop_public_hex(),
            desktop_device_id: DESKTOP_ID,
            generation: 1,
        }
    }

    /// Pair and prove possession, exactly as the app does before a pull: the
    /// snapshot route admits only a peer that already opened a hello.
    fn paired(endpoint: &str) -> PairingIdentity {
        let target = target(endpoint, CODE);
        let identity = phone_identity();
        let ack = request_pairing(&target, &facts(), &identity).expect("the code is accepted");
        // `next_hello_counter()`, not a literal: `exchange` takes its counter
        // from the same allocator, and a hardcoded 1 here made a snapshot-pull
        // request carry 1 as well whenever this helper ran first in the
        // process — which the desktop rightly refused as a replay (§7.2).
        send_hello(&target, &facts(), &identity, &ack, next_hello_counter())
            .expect("the hello is accepted");
        identity
    }

    #[test]
    fn a_pull_walks_every_batch_and_adopts_the_whole_snapshot() {
        let (state, port) = serving(3);
        let endpoint = format!("127.0.0.1:{port}");
        let identity = paired(&endpoint);
        let pull = pulling(&endpoint);
        let counters = ReplyCounter::default();

        let mut rows = 0u64;
        let mut batch = 0u64;
        let mut total = 1u64;
        while batch < total {
            let reply = request_snapshot(&pull, &facts(), &identity, &counters, batch)
                .expect("every batch the phone asks for is served");
            rows += reply["ops"].as_array().expect("ops").len() as u64;
            total = reply["total"].as_u64().expect("a total");
            acknowledge_batch(&pull, &facts(), &identity, &counters, batch).expect("applied");
            batch += 1;
        }
        assert_eq!(rows, 3, "every row arrived exactly once");
        assert_eq!(total, 1, "three small rows are one batch");
        assert!(
            counters.last(PAIRING_ID) > 0,
            "every sealed reply advanced the replay guard"
        );
        acknowledge_snapshot(&pull, &facts(), &identity, &counters, rows, 0)
            .expect("the whole snapshot was adopted");
        state.stop().expect("stop");
    }

    /// §8.4 is one stream in order: a batch that was never served cannot be
    /// acknowledged, so a second, jumping pull cannot close the first one.
    #[test]
    fn a_batch_that_was_never_served_cannot_be_acknowledged() {
        let (state, port) = serving(250);
        let endpoint = format!("127.0.0.1:{port}");
        let identity = paired(&endpoint);
        let pull = pulling(&endpoint);
        let counters = ReplyCounter::default();

        let reply = request_snapshot(&pull, &facts(), &identity, &counters, 0).expect("batch 0");
        assert!(reply["total"].as_u64().unwrap_or(0) > 1);
        let error = acknowledge_batch(&pull, &facts(), &identity, &counters, 1)
            .expect_err("batch 1 was never served");
        assert_eq!(error.code, "malformed");
        assert!(error.message.contains("never served"), "{}", error.message);
        state.stop().expect("stop");
    }

    #[test]
    fn an_adoption_that_skipped_a_batch_is_refused() {
        let (state, port) = serving(250);
        let endpoint = format!("127.0.0.1:{port}");
        let identity = paired(&endpoint);
        let pull = pulling(&endpoint);
        let counters = ReplyCounter::default();

        let reply = request_snapshot(&pull, &facts(), &identity, &counters, 0).expect("batch 0");
        let total = reply["total"].as_u64().expect("a total");
        assert!(total > 1, "250 rows are more than one batch (§8.3)");
        acknowledge_batch(&pull, &facts(), &identity, &counters, 0).expect("applied");
        let error = acknowledge_snapshot(&pull, &facts(), &identity, &counters, 250, 0)
            .expect_err("the whole is not the last batch");
        assert_eq!(error.code, "malformed");
        assert!(error.message.contains("acknowledged"), "{}", error.message);
        state.stop().expect("stop");
    }

    #[test]
    fn a_closed_window_refuses_the_pull_instead_of_hanging() {
        let (state, port) = serving(3);
        state.stop().expect("stop");
        let endpoint = format!("127.0.0.1:{port}");
        let error = request_snapshot(
            &pulling(&endpoint),
            &facts(),
            &phone_identity(),
            &ReplyCounter::default(),
            0,
        )
        .expect_err("nothing is listening any more");
        assert_eq!(error.code, "unreachable");
    }

    /// §7.2 on the phone's side: a counter that does not advance is a replay,
    /// and a new pull is allowed to start again from the window's first value.
    #[test]
    fn a_counter_that_does_not_advance_is_a_replay() {
        let counters = ReplyCounter::default();
        assert_eq!(counters.last(PAIRING_ID), 0);
        assert!(counters.accept(PAIRING_ID, 4));
        assert!(!counters.accept(PAIRING_ID, 4), "the same counter twice");
        assert!(!counters.accept(PAIRING_ID, 3), "an older counter");
        assert!(counters.accept(PAIRING_ID, 5));
        assert_eq!(counters.last(PAIRING_ID), 5);
        counters.restart(PAIRING_ID);
        assert_eq!(
            counters.last(PAIRING_ID),
            0,
            "a new window restarts its counter"
        );
        assert!(counters.accept(PAIRING_ID, 1));
    }

    // -----------------------------------------------------------------------
    // The §9.1 upload, over a real window and real crypto.
    // -----------------------------------------------------------------------

    fn upload_op(uid: &str) -> JsonValue {
        json!({
            "table": "notes",
            "uid": uid,
            "stamp": { "counter": 3, "deviceId": PHONE_ID, "opId": "op-1" },
            "fields": { "text": "a note the phone made offline" },
        })
    }

    #[test]
    fn an_upload_walks_its_batches_and_reads_the_verdict() {
        let (state, port) = serving(0);
        let endpoint = format!("127.0.0.1:{port}");
        let identity = paired(&endpoint);
        let pull = pulling(&endpoint);
        let counters = ReplyCounter::default();
        let ops = [
            upload_op("11111111-1111-4111-8111-111111111111"),
            upload_op("22222222-2222-4222-8222-222222222222"),
        ];

        send_upload_batch(&pull, &facts(), &identity, &counters, 0, 2, &ops[..1])
            .expect("batch 0 stages");
        send_upload_batch(&pull, &facts(), &identity, &counters, 1, 2, &ops[1..])
            .expect("batch 1 stages");
        send_upload_commit(&pull, &facts(), &identity, &counters).expect("the commit lands");

        // The verdict is pending until the panel's apply reports.
        let verdict =
            poll_upload_status(&pull, &facts(), &identity, &counters).expect("a sealed verdict");
        assert_eq!(verdict["state"], json!("pending"));

        let (pairing_id, staged) = state.take_upload().expect("the panel takes it");
        assert_eq!(pairing_id, PAIRING_ID);
        assert_eq!(staged.len(), 2);
        state.set_upload_outcome(crate::pairing_listener::UploadOutcome::Applied {
            inserted: 2,
            already_known: 0,
        });

        let verdict =
            poll_upload_status(&pull, &facts(), &identity, &counters).expect("a sealed verdict");
        assert_eq!(verdict["state"], json!("uploaded"));
        assert_eq!(verdict["inserted"], json!(2));
        assert_eq!(verdict["alreadyKnown"], json!(0));
        state.stop().expect("stop");
    }

    #[test]
    fn an_upload_before_pairing_is_refused_in_the_desktops_words() {
        let (state, port) = started(1, true);
        let endpoint = format!("127.0.0.1:{port}");
        let pull = pulling(&endpoint);
        let counters = ReplyCounter::default();
        let error = send_upload_batch(
            &pull,
            &facts(),
            &phone_identity(),
            &counters,
            0,
            1,
            &[upload_op("11111111-1111-4111-8111-111111111111")],
        )
        .expect_err("no pin, no upload");
        assert_eq!(error.code, "unpaired");
        state.stop().expect("stop");
    }
}
