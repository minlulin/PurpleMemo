//! The LAN pairing listener (§11.5, §7.1, §11.6.1) — Phase C Session 5, O.3.
//!
//! One socket, one purpose: while the pairing window is open, admit sealed
//! envelopes from **the pinned peer** and answer them. It is the server half of
//! the envelope `envelope.rs` implements, and it is wired to the same lifecycle
//! barrier the LAN share server consults.
//!
//! **Lifetime (§11.5).** The socket exists only between
//! [`PairingListenerState::start`] and a stop. Nothing binds at launch, and
//! [`PairingListenerState::stop`] joins the accept thread before returning, so
//! "the pairing window is closed" means the port no longer accepts connections
//! — not that a flag was set somewhere. The lock path, app background and
//! factory reset all call it (`stop_for_lock`, `stop_for_reset`).
//!
//! **Admission (§7.1 order, §11.2, §11.3).** Every hello is checked against the
//! pin before it has any effect:
//!
//! 1. a revoked peer is refused **first**, before its key is even looked at;
//! 2. a device with no pin is refused as unpaired — this listener admits a
//!    known peer, it never discovers one (first pairing is the next session's
//!    code-confirmed flow);
//! 3. then the envelope: version, recipient, pinned sender, replay, and the
//!    AEAD tag;
//! 4. then the payload: the message kind allowlist (`hello` only — the §2.3
//!    seam; table/field allowlists apply to the operation path, which does not
//!    exist yet), the pairing id, protocol version, schema version and the data
//!    line.
//!
//! The only effect an accepted hello has is advancing the peer's replay
//! counter and sealing an ack; nothing is written to the database, the
//! filesystem or the key store by this module.
//!
//! **What a changed key looks like.** A re-keyed phone cannot produce a message
//! that opens under the pinned key, so its hello is refused as
//! `unauthenticated` rather than `key-mismatch`. That is deliberate: naming the
//! presented key would require accepting an unpinned message to read it, which
//! §11.2 forbids. The refusal still names its reason and the human re-pairs.
//!
//! **Framing (§11.6.1).** Each message is a length-prefixed UTF-8 JSON
//! document: four big-endian bytes of body length, then exactly that many bytes
//! of the envelope wire string. `src/lib/sync/frame.ts` is the phone's half, and
//! both sides are pinned to the same byte vector by a test.

use std::io::{Cursor, Read};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

use crate::envelope::{self, OpenInput, Refusal, SealInput, KEY_BYTES};
use crate::lifecycle::Lifecycle;
use crate::pairing_key::PairingIdentity;

/// The only endpoint this listener serves.
const HELLO_PATH: &str = "/pair/hello";

/// Four big-endian bytes of body length (§11.6.1).
pub const FRAME_HEADER_BYTES: usize = 4;

/// A pairing message is a handshake, not a data transfer: the cap stops a
/// stranger from making the desktop buffer megabytes.
pub const MAX_FRAME_BYTES: usize = 64 * 1024;

/// The message kinds a pairing window speaks (§2.3's server-side seam). An
/// operation of any other kind is refused before it can have an effect.
const ACCEPTED_KINDS: [&str; 1] = ["hello"];

/// How long the accept loop waits before re-checking shutdown.
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Responses served at once: a client that stops reading owns a worker, never
/// the accept loop, so `stop` cannot wait on it.
const MAX_WORKERS: usize = 2;

/// Frame one UTF-8 JSON document with its four-byte length prefix.
pub fn encode_frame(text: &str) -> Result<Vec<u8>, String> {
    let body = text.as_bytes();
    if body.len() > MAX_FRAME_BYTES {
        return Err(format!(
            "a pairing message is limited to {MAX_FRAME_BYTES} bytes"
        ));
    }
    let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(body);
    Ok(frame)
}

/// Read one framed document. The length must match the body exactly: a
/// truncated frame is refused rather than decoded from whatever is left.
pub fn decode_frame(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() < FRAME_HEADER_BYTES {
        return Err("a frame begins with a four-byte length.".to_string());
    }
    let length = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    if length > MAX_FRAME_BYTES {
        return Err("the frame is larger than the pairing limit.".to_string());
    }
    if bytes.len() - FRAME_HEADER_BYTES != length {
        return Err("the frame's length prefix does not match its body.".to_string());
    }
    String::from_utf8(bytes[FRAME_HEADER_BYTES..].to_vec())
        .map_err(|_| "the frame is not UTF-8.".to_string())
}

/// The peer's pin (§11.2), as the shell hands it in when the window opens.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedPeer {
    pub device_id: String,
    /// Long-term X25519 public key, lowercase hex.
    pub public_key: String,
    /// The data line recorded for this pairing (§10.2).
    pub generation: u64,
    /// §11.3. A revoked peer is refused before anything else happens.
    #[serde(default)]
    pub revoked: bool,
}

/// Everything the listener needs about this pairing window. Parsed from the
/// command's JSON argument, so the shell passes one value and no key material.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingWindow {
    pub local_device_id: String,
    pub local_generation: u64,
    pub local_protocol_version: u64,
    pub local_schema_version: u64,
    /// §11.4: a hello claiming a different pairing is a re-pair, not a sync.
    #[serde(default)]
    pub pairing_id: Option<String>,
    /// `None` is a refused-as-unpaired window, not a discovery window.
    #[serde(default)]
    pub peer: Option<PinnedPeer>,
    /// The highest counter already accepted from this peer, when a window
    /// re-opens after a previous one.
    #[serde(default)]
    pub last_counter: u64,
}

/// What the UI sees. Serialized camelCase: the IPC contract.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingListenerInfo {
    pub running: bool,
    pub port: Option<u16>,
    /// This device's public key — never its secret.
    pub public_key: Option<String>,
    pub fingerprint: Option<String>,
    pub peer_device_id: Option<String>,
    pub note: Option<String>,
}

impl PairingListenerInfo {
    fn stopped(note: Option<String>) -> Self {
        Self {
            running: false,
            port: None,
            public_key: None,
            fingerprint: None,
            peer_device_id: None,
            note,
        }
    }
}

/// A parsed pin: the hex string is only ever read once, at start.
struct Pin {
    device_id: String,
    public_key: [u8; KEY_BYTES],
    generation: u64,
    revoked: bool,
}

/// What one accepted-or-refused request may consult. Immutable except for the
/// replay counter, so a handler cannot widen its own authority.
struct Gate {
    local_device_id: String,
    local_secret: [u8; KEY_BYTES],
    local_generation: u64,
    local_protocol_version: u64,
    local_schema_version: u64,
    pairing_id: Option<String>,
    pin: Option<Pin>,
    /// The highest counter accepted from the peer. Opening a message and
    /// advancing this is one step under one lock, so two racing copies of the
    /// same envelope cannot both be accepted.
    last_counter: Mutex<u64>,
    /// This device's own counter for acks: per-sender and monotonic.
    send_counter: AtomicU64,
}

#[derive(Default)]
struct Shared {
    stop: AtomicBool,
}

struct Running {
    port: u16,
    public_key: String,
    fingerprint: String,
    peer_device_id: Option<String>,
    shared: Arc<Shared>,
    join: Option<JoinHandle<()>>,
}

impl Running {
    fn finished(&self) -> bool {
        self.join.as_ref().is_some_and(|join| join.is_finished())
    }

    fn info(&self, note: Option<String>) -> PairingListenerInfo {
        PairingListenerInfo {
            running: true,
            port: Some(self.port),
            public_key: Some(self.public_key.clone()),
            fingerprint: Some(self.fingerprint.clone()),
            peer_device_id: self.peer_device_id.clone(),
            note,
        }
    }
}

/// The managed pairing-listener state: at most one window, one socket.
#[derive(Default)]
pub struct PairingListenerState {
    inner: Mutex<Option<Running>>,
    /// The SAME barrier the share server and the DB commands consult (E2). A
    /// private barrier would be two states pretending to be one.
    lifecycle: Arc<Lifecycle>,
}

impl PairingListenerState {
    /// Production constructor: shares the process's one barrier.
    pub fn with_lifecycle(lifecycle: Arc<Lifecycle>) -> Self {
        Self {
            lifecycle,
            ..Self::default()
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Option<Running>>, String> {
        // Recover from poison: a panic while holding the guard drops it
        // atomically, so refusing every later call would wedge pairing for the
        // rest of the session. Unwind-only path: release builds abort.
        Ok(self.inner.lock().unwrap_or_else(|e| e.into_inner()))
    }

    /// Open the pairing window on `bind`. Idempotent while one is running.
    ///
    /// The identity comes from `pairing_key::load_or_mint` in production; the
    /// parameter exists so the tests can run the real crypto without touching a
    /// real OS keyring.
    pub fn start(
        &self,
        bind: &str,
        window: PairingWindow,
        identity: PairingIdentity,
    ) -> Result<PairingListenerInfo, String> {
        // Fail before binding anything if a reset or import owns the app (E2).
        self.lifecycle.ensure_share_allowed()?;
        let pin = match window.peer.as_ref() {
            Some(peer) => {
                let bytes = envelope::from_hex(&peer.public_key)
                    .filter(|bytes| bytes.len() == KEY_BYTES)
                    .ok_or_else(|| {
                        "the pinned peer's public key is not a 32-byte hex key".to_string()
                    })?;
                let mut public_key = [0u8; KEY_BYTES];
                public_key.copy_from_slice(&bytes);
                Some(Pin {
                    device_id: peer.device_id.clone(),
                    public_key,
                    generation: peer.generation,
                    revoked: peer.revoked,
                })
            }
            None => None,
        };
        let local_secret = *identity.secret();
        let public_key = identity.public_key_hex();
        let fingerprint = identity.fingerprint();
        let peer_device_id = window.peer.as_ref().map(|peer| peer.device_id.clone());

        let mut guard = self.lock()?;
        // Re-check under the server lock: a reset that landed while this start
        // was preparing must not be followed by a bind.
        self.lifecycle.ensure_share_allowed()?;
        if let Some(running) = guard.as_ref() {
            if !running.finished() {
                return Ok(running.info(None));
            }
        }
        if let Some(stale) = guard.take() {
            reap(stale);
        }

        let server = Server::http((bind, 0))
            .map_err(|e| format!("could not start the pairing listener on {bind}: {e}"))?;
        let port = server
            .server_addr()
            .to_ip()
            .map(|address: SocketAddr| address.port())
            .ok_or_else(|| "could not read the pairing listener port".to_string())?;
        let gate = Arc::new(Gate {
            local_device_id: window.local_device_id,
            local_secret,
            local_generation: window.local_generation,
            local_protocol_version: window.local_protocol_version,
            local_schema_version: window.local_schema_version,
            pairing_id: window.pairing_id,
            pin,
            last_counter: Mutex::new(window.last_counter),
            send_counter: AtomicU64::new(0),
        });
        let shared = Arc::new(Shared::default());
        let thread_shared = Arc::clone(&shared);
        let join = thread::Builder::new()
            .name("purple-memo-pairing".to_string())
            .spawn(move || serve(server, gate, thread_shared))
            .map_err(|e| format!("could not start the pairing thread: {e}"))?;

        let running = Running {
            port,
            public_key,
            fingerprint,
            peer_device_id,
            shared,
            join: Some(join),
        };
        let info = running.info(None);
        *guard = Some(running);
        Ok(info)
    }

    /// Close the window and wait for the socket to stop accepting. Idempotent.
    pub fn stop(&self) -> Result<PairingListenerInfo, String> {
        let mut guard = self.lock()?;
        if let Some(running) = guard.take() {
            reap(running);
        }
        Ok(PairingListenerInfo::stopped(None))
    }

    /// The lock path (§11.5): locking the app ends the pairing window.
    ///
    /// Same stop as [`Self::stop`], unlike the LAN share's lock path: no
    /// consent token or pairing code lives in Rust, so there is nothing to
    /// revoke before the socket closes. The shell calls this on lock, on app
    /// background, and when the pairing screen closes.
    pub fn stop_for_lock(&self) -> Result<PairingListenerInfo, String> {
        self.stop()
    }

    /// The reset path: close the window and report whether one was open.
    pub fn stop_for_reset(&self) -> Result<bool, String> {
        let mut guard = self.lock()?;
        let removed = match guard.take() {
            Some(running) => {
                reap(running);
                true
            }
            None => false,
        };
        Ok(removed)
    }

    /// Current state — also reaps a listener that shut itself down.
    pub fn status(&self) -> Result<PairingListenerInfo, String> {
        let mut guard = self.lock()?;
        match guard.as_ref() {
            Some(running) if !running.finished() => Ok(running.info(None)),
            Some(_) => {
                let running = guard.take().expect("checked above");
                reap(running);
                Ok(PairingListenerInfo::stopped(None))
            }
            None => Ok(PairingListenerInfo::stopped(None)),
        }
    }
}

/// Signal the accept loop and wait for it to exit.
fn reap(mut running: Running) {
    running.shared.stop.store(true, Ordering::SeqCst);
    if let Some(join) = running.join.take() {
        let _ = join.join();
    }
}

/// A refusal as the wire sees it: a named reason, a message, and the status
/// code that carries it.
struct RefusalReply {
    code: &'static str,
    message: String,
    status: u16,
}

impl RefusalReply {
    fn refused(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            status: 403,
        }
    }

    fn malformed(message: impl Into<String>) -> Self {
        Self {
            code: "malformed",
            message: message.into(),
            status: 400,
        }
    }

    fn from_envelope(refusal: Refusal) -> Self {
        Self {
            code: refusal.code(),
            message: refusal.message(),
            status: 403,
        }
    }

    fn body(&self) -> JsonValue {
        json!({ "ok": false, "reason": self.code, "message": self.message })
    }
}

/// Every reply is one framed JSON document (§11.6.1), exactly like a request:
/// the phone reads the same four bytes it writes.
fn respond_framed(status: u16, body: JsonValue) -> Response<Cursor<Vec<u8>>> {
    let framed = encode_frame(&body.to_string()).unwrap_or_default();
    let mut response = Response::from_data(framed).with_status_code(StatusCode(status));
    for (name, value) in [
        ("Content-Type", "application/octet-stream"),
        ("Cache-Control", "no-store"),
        ("X-Content-Type-Options", "nosniff"),
        ("Referrer-Policy", "no-referrer"),
    ] {
        if let Ok(header) = Header::from_bytes(name, value) {
            response.add_header(header);
        }
    }
    response
}

fn refused_response(refusal: RefusalReply) -> Response<Cursor<Vec<u8>>> {
    respond_framed(refusal.status, refusal.body())
}

/// The accept loop. It never writes a response itself, so a client that stops
/// reading cannot keep `stop` from returning.
fn serve(server: Server, gate: Arc<Gate>, shared: Arc<Shared>) {
    let mut consecutive_errors = 0u32;
    let mut workers: Vec<JoinHandle<()>> = Vec::new();
    while !shared.stop.load(Ordering::SeqCst) {
        workers.retain(|worker| !worker.is_finished());
        match server.recv_timeout(POLL_INTERVAL) {
            Ok(Some(request)) => {
                consecutive_errors = 0;
                if workers.len() >= MAX_WORKERS {
                    // Every slot is held by a slow reader. Dropping closes the
                    // connection without putting this loop behind that write.
                    drop(request);
                    continue;
                }
                let worker_gate = Arc::clone(&gate);
                if let Ok(join) = thread::Builder::new()
                    .name("purple-memo-pairing-worker".to_string())
                    .spawn(move || handle(request, &worker_gate))
                {
                    workers.push(join);
                }
            }
            Ok(None) => consecutive_errors = 0,
            // A client hanging up mid-handshake is normal; a listener that keeps
            // failing is not.
            Err(_) => {
                consecutive_errors += 1;
                if consecutive_errors >= 100 {
                    return;
                }
            }
        }
    }
}

/// Serve one request. Everything this handler can do is admit a hello.
fn handle(mut request: Request, gate: &Gate) {
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or(&url);
    if path != HELLO_PATH {
        let _ = request.respond(respond_framed(
            404,
            json!({
                "ok": false,
                "reason": "not-found",
                "message": "the pairing listener serves only POST /pair/hello.",
            }),
        ));
        return;
    }
    if request.method() != &Method::Post {
        let _ = request.respond(respond_framed(
            405,
            json!({
                "ok": false,
                "reason": "method",
                "message": "a pairing hello is POSTed.",
            }),
        ));
        return;
    }
    // §11.3 before anything else: a revoked peer's key is not even looked at.
    if gate.pin.as_ref().is_some_and(|pin| pin.revoked) {
        let _ = request.respond(refused_response(RefusalReply::refused(
            "revoked",
            "this device was revoked on the desktop; re-pair it before anything syncs (§11.3).",
        )));
        return;
    }
    let body = match read_body(request.as_reader()) {
        Ok(body) => body,
        Err(()) => {
            let _ = request.respond(refused_response(RefusalReply::malformed(
                "the request body is empty or larger than a pairing message.",
            )));
            return;
        }
    };
    match admit(gate, &body) {
        Ok(reply) => {
            let _ = request.respond(respond_framed(200, reply));
        }
        Err(refusal) => {
            let _ = request.respond(refused_response(refusal));
        }
    }
}

/// Read at most one frame plus one byte, so an oversized body is refused rather
/// than buffered.
fn read_body(reader: impl Read) -> Result<Vec<u8>, ()> {
    let limit = (MAX_FRAME_BYTES + FRAME_HEADER_BYTES + 1) as u64;
    let mut body = Vec::new();
    reader.take(limit).read_to_end(&mut body).map_err(|_| ())?;
    if body.is_empty() || body.len() as u64 >= limit {
        return Err(());
    }
    Ok(body)
}

/// §7.1's order, from the pin to the ack.
fn admit(gate: &Gate, body: &[u8]) -> Result<JsonValue, RefusalReply> {
    let Some(pin) = gate.pin.as_ref() else {
        return Err(RefusalReply::refused(
            "unpaired",
            "this device has never paired; show a pairing code on the desktop first (§11.2).",
        ));
    };
    let text = decode_frame(body).map_err(RefusalReply::malformed)?;
    let mut last_counter = gate.last_counter.lock().unwrap_or_else(|e| e.into_inner());
    let opened = envelope::open(OpenInput {
        secret: &gate.local_secret,
        peer_public: &pin.public_key,
        local_device_id: &gate.local_device_id,
        expected_from: &pin.device_id,
        last_counter: *last_counter,
        raw: &text,
    })
    .map_err(RefusalReply::from_envelope)?;

    // §2.3's server-side seam: a pairing window speaks hellos and nothing else.
    let kind = opened
        .message
        .get("kind")
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    if !ACCEPTED_KINDS.contains(&kind) {
        return Err(RefusalReply::refused(
            "not-allowed",
            format!(
                "a pairing window accepts only {}; {kind:?} is not one of them (§2.3).",
                ACCEPTED_KINDS.join(", ")
            ),
        ));
    }

    let number = |key: &str| opened.message.get(key).and_then(JsonValue::as_u64);
    if let Some(expected) = gate.pairing_id.as_deref() {
        let presented = opened.message.get("pairingId").and_then(JsonValue::as_str);
        if presented != Some(expected) {
            return Err(RefusalReply::refused(
                "pairing-mismatch",
                "this hello belongs to a different pairing; re-pair this phone (§11.4).",
            ));
        }
    }
    let protocol = number("protocolVersion").ok_or_else(|| {
        RefusalReply::malformed("the hello does not say which protocol version it speaks.")
    })?;
    if protocol != gate.local_protocol_version {
        return Err(RefusalReply::refused(
            "protocol-unsupported",
            format!(
                "this build speaks protocol v{}; the peer sent v{protocol}.",
                gate.local_protocol_version
            ),
        ));
    }
    let schema = number("schemaVersion")
        .ok_or_else(|| RefusalReply::malformed("the hello does not say which schema it holds."))?;
    if schema != gate.local_schema_version {
        return Err(RefusalReply::refused(
            "schema-mismatch",
            format!(
                "the peers hold schema v{} and v{schema} — sync only between identical builds (§8.2).",
                gate.local_schema_version
            ),
        ));
    }
    let generation = number("generation").ok_or_else(|| {
        RefusalReply::malformed("the hello does not say which data line it holds.")
    })?;
    if pin.generation != gate.local_generation {
        return Err(RefusalReply::refused(
            "needs-re-pair",
            "the desktop's data line changed since this phone paired; re-pair it (§10.2, §10.5).",
        ));
    }
    if generation != pin.generation {
        return Err(RefusalReply::refused(
            "needs-re-pair",
            "this device's data line changed since it paired; re-pair it (§10.2, §10.5).",
        ));
    }

    // Accepted. The counter advance is the one effect an admitted hello has, and
    // it is what makes a second copy of the same envelope a replay.
    *last_counter = opened.header.counter;
    drop(last_counter);

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
        nonce: None,
    })
    .map_err(|message| RefusalReply {
        code: "internal",
        message,
        status: 500,
    })?;
    Ok(json!({ "ok": true, "reason": "accepted", "envelope": wire }))
}

// ---------------------------------------------------------------------------
// Tests — run with `cargo test`. Real crypto, real loopback socket, no stubs.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpStream as StdTcpStream;

    const DESKTOP_SECRET: [u8; KEY_BYTES] = [0x11u8; KEY_BYTES];
    const PHONE_SECRET: [u8; KEY_BYTES] = [0x22u8; KEY_BYTES];
    const DESKTOP_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const PHONE_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    fn desktop_identity() -> PairingIdentity {
        PairingIdentity::from_secret(DESKTOP_SECRET)
    }

    fn phone_public_hex() -> String {
        envelope::to_hex(&envelope::public_key(&PHONE_SECRET))
    }

    fn window(revoked: bool) -> PairingWindow {
        PairingWindow {
            local_device_id: DESKTOP_ID.to_string(),
            local_generation: 1,
            local_protocol_version: 1,
            local_schema_version: 8,
            pairing_id: Some("pair-1".to_string()),
            peer: Some(PinnedPeer {
                device_id: PHONE_ID.to_string(),
                public_key: phone_public_hex(),
                generation: 1,
                revoked,
            }),
            last_counter: 0,
        }
    }

    fn started(revoked: bool) -> (PairingListenerState, u16) {
        let state = PairingListenerState::default();
        let info = state
            .start("127.0.0.1", window(revoked), desktop_identity())
            .expect("start the pairing listener");
        (state, info.port.expect("a bound port"))
    }

    /// A real sealed hello from the phone, sealed to the desktop's public key.
    fn hello_wire(
        counter: u64,
        patch: impl FnOnce(&mut serde_json::Map<String, JsonValue>),
    ) -> String {
        let mut message = json!({
            "kind": "hello",
            "protocolVersion": 1,
            "schemaVersion": 8,
            "generation": 1,
            "pairingId": "pair-1",
            "deviceId": PHONE_ID,
        });
        patch(message.as_object_mut().expect("the hello is an object"));
        envelope::seal(SealInput {
            secret: &PHONE_SECRET,
            peer_public: &envelope::public_key(&DESKTOP_SECRET),
            from: PHONE_ID,
            to: DESKTOP_ID,
            message_id: &format!("hello-{counter}"),
            counter,
            message: &message,
            nonce: None,
        })
        .expect("seal the hello")
    }

    fn hello_frame(counter: u64) -> Vec<u8> {
        encode_frame(&hello_wire(counter, |_| {})).expect("frame the hello")
    }

    /// A POST with the framed reply decoded — the shape the phone sees.
    fn post(port: u16, body: &[u8]) -> (u16, String) {
        let (status, raw) = request(port, "POST /pair/hello", body);
        let text =
            decode_frame(&raw).unwrap_or_else(|_| String::from_utf8_lossy(&raw).into_owned());
        (status, text)
    }

    /// Minimal raw HTTP/1.1 request — enough to exercise the listener.
    ///
    /// The body is read as **bytes**: a framed reply begins with a length
    /// prefix, which is not UTF-8, so a string read would garble it.
    fn request(port: u16, request_line: &str, body: &[u8]) -> (u16, Vec<u8>) {
        let mut stream = StdTcpStream::connect(("127.0.0.1", port)).expect("connect");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("timeout");
        write!(
            stream,
            "{request_line} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: \
             application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .expect("write head");
        stream.write_all(body).expect("write body");
        stream.flush().ok();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).expect("read response");
        let split = raw
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map_or(raw.len(), |index| index + 4);
        let status = String::from_utf8_lossy(&raw[..split])
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(0);
        (status, raw[split..].to_vec())
    }

    fn refusal_reason(body: &str) -> String {
        let parsed: JsonValue = serde_json::from_str(body).expect("refusal json");
        parsed["reason"].as_str().unwrap_or_default().to_string()
    }

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
            .start("127.0.0.1", unpinned, desktop_identity())
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
            .start("127.0.0.1", rekeyed, desktop_identity())
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

    #[test]
    fn only_the_hello_endpoint_speaks_and_only_by_post() {
        let (state, port) = started(false);

        let (status, raw) = request(port, "GET /", b"");
        assert_eq!(status, 404, "no other path is served");
        let text = decode_frame(&raw).expect("even a 404 is one framed document");
        let reply: JsonValue = serde_json::from_str(&text).expect("reply json");
        assert_eq!(reply["reason"], json!("not-found"));

        let (status, raw) = request(port, "GET /pair/hello", b"");
        assert_eq!(status, 405, "a hello is POSTed");
        let text = decode_frame(&raw).expect("even a 405 is one framed document");
        let reply: JsonValue = serde_json::from_str(&text).expect("reply json");
        assert_eq!(reply["reason"], json!("method"));
        state.stop().expect("stop");
    }

    #[test]
    fn nothing_listens_until_the_window_opens_and_nothing_listens_after_it_closes() {
        let idle = PairingListenerState::default();
        let info = idle.status().expect("status");
        assert!(!info.running);
        assert!(info.port.is_none(), "no port before the window opens");

        let (state, port) = started(false);
        assert_eq!(post(port, &hello_frame(1)).0, 200);

        state.stop().expect("stop");
        assert!(!state.status().expect("status").running);
        assert!(
            StdTcpStream::connect(("127.0.0.1", port)).is_err(),
            "a closed pairing window must not accept connections"
        );
    }

    #[test]
    fn a_reset_lock_or_second_stop_closes_the_socket() {
        let (state, port) = started(false);
        assert!(state.stop_for_reset().expect("reset stop"));
        assert!(
            StdTcpStream::connect(("127.0.0.1", port)).is_err(),
            "the reset path must close the socket"
        );
        assert!(
            !state.stop_for_reset().expect("idempotent"),
            "a second reset stop finds nothing"
        );

        let (locked, port) = started(false);
        assert!(!locked.stop_for_lock().expect("lock stop").running);
        assert!(
            StdTcpStream::connect(("127.0.0.1", port)).is_err(),
            "the lock path must close the socket"
        );

        // Opening again after a stop is a fresh window, not a reused socket.
        let reopened = locked
            .start("127.0.0.1", window(false), desktop_identity())
            .expect("reopen");
        assert!(reopened.port.is_some());
        assert_eq!(reopened.port, locked.status().expect("status").port);
        locked.stop().expect("stop");
    }

    #[test]
    fn one_window_one_socket() {
        let state = PairingListenerState::default();
        let first = state
            .start("127.0.0.1", window(false), desktop_identity())
            .expect("start");
        let second = state
            .start("127.0.0.1", window(false), desktop_identity())
            .expect("start again");
        assert_eq!(first.port, second.port, "a live window is reused");
        state.stop().expect("stop");
    }

    /// The reported state carries the public key and the fingerprint a human
    /// confirms — never either secret.
    #[test]
    fn the_reported_state_never_carries_a_secret() {
        let (state, _port) = started(false);
        let printed = serde_json::to_string(&state.status().expect("status")).expect("json");
        assert!(printed.contains("7B4E 909B"), "{printed}");
        assert!(
            !printed.to_lowercase().contains(&"11".repeat(KEY_BYTES)),
            "the desktop secret must never be reported: {printed}"
        );
        assert!(
            !printed.to_lowercase().contains(&"22".repeat(KEY_BYTES)),
            "nor the peer's: {printed}"
        );
        state.stop().expect("stop");
    }

    /// The framing both sides speak. `src/lib/sync/frame.test.ts` pins the same
    /// `00000011` prefix for the same plaintext.
    #[test]
    fn a_frame_is_four_big_endian_length_bytes_then_utf8_json() {
        let text = "{\"hello\":\"world\"}";
        let frame = encode_frame(text).expect("frame");
        assert_eq!(
            envelope::to_hex(&frame),
            format!("00000011{}", envelope::to_hex(text.as_bytes()))
        );
        assert_eq!(decode_frame(&frame).expect("decode"), text);

        assert!(
            decode_frame(&frame[..3]).is_err(),
            "three bytes is not a frame"
        );
        assert!(
            decode_frame(&frame[..frame.len() - 1]).is_err(),
            "a truncated body is refused, not guessed"
        );
        let mut longer = frame.clone();
        longer.push(b' ');
        assert!(
            decode_frame(&longer).is_err(),
            "a length that does not match the body is refused"
        );
        assert!(
            decode_frame(&[0xff, 0xff, 0xff, 0xff]).is_err(),
            "an absurd length is refused before anything is allocated"
        );
        assert!(
            decode_frame(b"\x00\x00\x00\x01\xff").is_err(),
            "the body must be UTF-8"
        );
    }

    #[test]
    fn an_import_or_reset_barrier_refuses_to_open_a_window() {
        let state = PairingListenerState::default();
        state.lifecycle.raise_reset();
        let error = state
            .start("127.0.0.1", window(false), desktop_identity())
            .expect_err("no listener may come up after the barrier");
        assert!(error.contains("restart"), "must say what to do: {error}");
        assert!(!state.status().expect("status").running);
    }
}
