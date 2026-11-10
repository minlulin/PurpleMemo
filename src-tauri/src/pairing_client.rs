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

use std::fmt;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
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
    let reply = post(target, REQUEST_PATH, &body)?;
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
    let desktop_key = desktop_key(target)?;
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
    let desktop_key = desktop_key(target)?;
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

    let reply = post(target, HELLO_PATH, &frame(&wire)?)?;
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
fn post(
    target: &PairingTarget<'_>,
    path: &str,
    body: &[u8],
) -> Result<JsonValue, PairingClientError> {
    let address = endpoint_address(target.endpoint)?;
    let mut stream = TcpStream::connect_timeout(&address, CLIENT_TIMEOUT).map_err(|error| {
        if error.kind() == std::io::ErrorKind::TimedOut {
            PairingClientError::local(
                "timeout",
                format!("the desktop at {} did not answer in time.", target.endpoint),
            )
        } else {
            PairingClientError::local(
                "unreachable",
                format!(
                    "could not reach the desktop at {}: {error}",
                    target.endpoint
                ),
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
        target.endpoint,
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

fn desktop_key(target: &PairingTarget<'_>) -> Result<[u8; KEY_BYTES], PairingClientError> {
    let bytes = envelope::from_hex(target.desktop_public_key)
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
    use crate::pairing_listener::{PairingListenerState, PairingOffer, PairingWindow};
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

        send_hello(&target, &facts(), &identity, &ack, 1)
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
        send_hello(&target, &facts(), &identity, &ack, 1)
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
}
