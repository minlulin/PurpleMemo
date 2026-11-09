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
//! 2. a sealed hello from a device with no pin is refused as unpaired;
//! 3. then the envelope: version, recipient, pinned sender, replay, and the
//!    AEAD tag;
//! 4. then the payload: the message kind allowlist (`hello` only — the §2.3
//!    seam; table/field allowlists apply to the operation path, which does not
//!    exist yet), the pairing id, protocol version, schema version and the data
//!    line.
//!
//! **First pairing (§11.1, Phase C Session 6).** A window opened with an
//! *offer* also serves `POST /pair/request`: the phone presents its device id,
//! its long-term public key and the six-digit code from the desktop's screen.
//! That request is not sealed — it cannot be, the desktop does not know the
//! phone's key yet — and it proves nothing about the key it carries. What it
//! proves is possession of the single-use, 120 s, 5-attempt code, and the human
//! confirms the key by comparing the fingerprints on both screens (§11.1,
//! §11.6.1: "the code gates the rendezvous only. It is never the encryption
//! key"). Accepting it **stages** that key as a candidate for this window and
//! answers with an acknowledgement sealed under the ordinary envelope, so the
//! phone can open it with the desktop key it read from the offer. Every later
//! message is a sealed hello checked against the candidate; a wrong, expired,
//! used or locked-out code is a named refusal with zero effect.
//!
//! **Staging is not trust (§11.1, wave 1 N1).** A candidate is pinned only when
//! the person presses Trust on the panel after comparing both fingerprints.
//! Until a sealed hello *from* that candidate has been opened, the key is only
//! something a stranger presented — the ack is sealed **to** it, which proves
//! nothing — so [`PairingListenerInfo::peer_hello_received`] stays false and
//! the panel offers no Trust. This module writes the pin nowhere: the panel's
//! `sync_peers` write is the only one, and it happens on Trust alone.
//!
//! The only effect an accepted hello has is advancing the peer's replay
//! counter, marking the staged candidate's key possession, and sealing an ack;
//! nothing is written to the database, the filesystem or the key store by this
//! module.
//!
//! **What a changed key looks like.** A re-keyed phone cannot produce a message
//! that opens under the pinned key, so its hello is refused as
//! `unauthenticated` rather than `key-mismatch`. That is deliberate: naming the
//! presented key would require accepting an unpinned message to read it, which
//! §11.2 forbids. The refusal still names its reason and the human re-pairs.
//!
//! **The socket is ours (§11.1, N5).** The listener owns its accept loop and
//! speaks the two endpoints itself, so every connection carries a read timeout,
//! a write timeout and an end-to-end budget: a client that opens a connection
//! and then stalls cannot hold a worker, and `stop` joins the workers it
//! spawned. No response ever grants a browser origin — the phone's sealed client
//! invokes HTTP from Rust, not from a WebView `fetch` (§11.6.1).
//!
//! **Framing (§11.6.1).** Each message is a length-prefixed UTF-8 JSON
//! document: four big-endian bytes of body length, then exactly that many bytes
//! of the envelope wire string. `src/lib/sync/frame.ts` is the phone's half, and
//! both sides are pinned to the same byte vector by a test.

use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};

use crate::envelope::{self, OpenInput, Refusal, SealInput, KEY_BYTES};
use crate::lifecycle::Lifecycle;
use crate::pairing_key::PairingIdentity;

/// A sealed message from the pinned peer (§11.6.1).
const HELLO_PATH: &str = "/pair/hello";

/// The code-confirmed rendezvous that pins a peer for the first time (§11.1).
const REQUEST_PATH: &str = "/pair/request";

/// The protocol this build speaks (protocol v1, `docs/ANDROID_SYNC_PROTOCOL.md`).
pub const PROTOCOL_VERSION: u64 = 1;

/// §11.1: five wrong guesses burn the code; the sixth attempt is a lockout.
pub const PAIRING_MAX_ATTEMPTS: u32 = 5;

/// Four big-endian bytes of body length (§11.6.1).
pub const FRAME_HEADER_BYTES: usize = 4;

/// A pairing message is a handshake, not a data transfer: the cap stops a
/// stranger from making the desktop buffer megabytes.
pub const MAX_FRAME_BYTES: usize = 64 * 1024;

/// The message kinds a pairing window speaks (§2.3's server-side seam). An
/// operation of any other kind is refused before it can have an effect.
const ACCEPTED_KINDS: [&str; 1] = ["hello"];

/// How long the accept loop sleeps between non-blocking accepts: the bound on
/// how long a `stop` waits to be seen, and on how long a phone waits to be
/// accepted.
const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// How long a stop may spend proving the socket is gone.
const CLOSE_DEADLINE: Duration = Duration::from_secs(2);

/// The gap between two probes of a port that is closing.
const CLOSE_PROBE_GAP: Duration = Duration::from_millis(5);

/// Responses served at once: a client that stalls owns a worker, never the
/// accept loop. Two is enough for a phone plus a retry.
const MAX_WORKERS: usize = 2;

/// How long one connection may take, end to end, before its worker gives up on
/// it. Every read and write is bounded by this too, so a client that dribbles a
/// byte at a time cannot hold a worker either (§11.1, N5).
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(5);

/// A request head is a request line and a handful of headers. Anything larger is
/// a client that will not be served.
const MAX_HEAD_BYTES: usize = 8 * 1024;

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

/// The single-use code the desktop shows, and when it dies (§11.1).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingOffer {
    /// Six digits, as rendered on the desktop's screen.
    pub code: String,
    /// Unix epoch milliseconds.
    pub expires_at: u64,
}

/// What the shell asks for when it opens a pairing window.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingOpenInput {
    /// §11.4: a hello claiming a different pairing is a re-pair, not a sync.
    #[serde(default)]
    pub pairing_id: Option<String>,
    #[serde(default)]
    pub offer_code: Option<String>,
    #[serde(default)]
    pub offer_expires_at: Option<u64>,
    /// `None` is a window that admits no sealed hello until a code-confirmed
    /// rendezvous pins one.
    #[serde(default)]
    pub peer: Option<PinnedPeer>,
    /// The highest counter already accepted from this peer, when a window
    /// re-opens after a previous one.
    #[serde(default)]
    pub last_counter: Option<u64>,
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
    /// The code that gates a first pairing (§11.1). `None` opens a window for a
    /// pinned peer only.
    #[serde(default)]
    pub offer: Option<PairingOffer>,
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
    /// `host:port` the offer's QR carries (§11.1). Never a loopback name in
    /// production: the phone has to reach it over the LAN.
    pub endpoint: Option<String>,
    /// This device's public key — never its secret.
    pub public_key: Option<String>,
    pub fingerprint: Option<String>,
    /// The pinned peer this window knows about, if any.
    pub peer_device_id: Option<String>,
    /// The peer a code-confirmed rendezvous pinned in this window (§11.2).
    /// Public key material only — this is what the panel stores as a pin.
    pub peer_public_key: Option<String>,
    pub peer_fingerprint: Option<String>,
    /// A sealed hello from the staged candidate has been opened, so it has
    /// proved it holds the key it presented. The panel may not offer Trust
    /// before this is true (§11.1, wave 1 N1).
    pub peer_hello_received: bool,
    pub note: Option<String>,
}

impl PairingListenerInfo {
    fn stopped(note: Option<String>) -> Self {
        Self {
            running: false,
            port: None,
            endpoint: None,
            public_key: None,
            fingerprint: None,
            peer_device_id: None,
            peer_public_key: None,
            peer_fingerprint: None,
            peer_hello_received: false,
            note,
        }
    }
}

/// A parsed pin: the hex string is only ever read once, at start.
#[derive(Clone)]
struct Pin {
    device_id: String,
    public_key: [u8; KEY_BYTES],
    generation: u64,
    revoked: bool,
}

/// The live state of the window's code: attempts, single use, expiry.
struct OfferState {
    code: String,
    expires_at: u64,
    attempts: u32,
    redeemed: bool,
}

/// The peer a code-confirmed rendezvous pinned. `Debug` would print the key,
/// which is public; the secret is never in here.
struct PairedPeer {
    pin: Pin,
    public_key_hex: String,
    fingerprint: String,
    /// Set when a sealed hello from this candidate has been opened: the one
    /// proof that the peer holds the half of the key it presented (§11.1).
    hello_received: bool,
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
    /// §11.1: the code that gates a first pairing. Absent on a window for an
    /// already-pinned peer.
    offer: Option<Mutex<OfferState>>,
    /// The peer this window's code pinned, once the rendezvous succeeded.
    paired: Mutex<Option<PairedPeer>>,
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
    /// Where a stop probes for closure: the bound address, with an unspecified
    /// bind (`0.0.0.0`, production) mapped to loopback.
    probe: SocketAddr,
    endpoint: Option<String>,
    public_key: String,
    fingerprint: String,
    peer_device_id: Option<String>,
    /// The same gate the serve thread holds: `info` reads the live pairing
    /// state from it, so the panel sees an admitted peer without a second
    /// channel.
    gate: Arc<Gate>,
    shared: Arc<Shared>,
    join: Option<JoinHandle<()>>,
}

impl Running {
    fn finished(&self) -> bool {
        self.join.as_ref().is_some_and(|join| join.is_finished())
    }

    fn info(&self, note: Option<String>) -> PairingListenerInfo {
        let paired = self.gate.paired.lock().unwrap_or_else(|e| e.into_inner());
        PairingListenerInfo {
            running: true,
            port: Some(self.port),
            endpoint: self.endpoint.clone(),
            public_key: Some(self.public_key.clone()),
            fingerprint: Some(self.fingerprint.clone()),
            peer_device_id: paired
                .as_ref()
                .map(|peer| peer.pin.device_id.clone())
                .or_else(|| self.peer_device_id.clone()),
            peer_public_key: paired.as_ref().map(|peer| peer.public_key_hex.clone()),
            peer_fingerprint: paired.as_ref().map(|peer| peer.fingerprint.clone()),
            peer_hello_received: paired.as_ref().is_some_and(|peer| peer.hello_received),
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
            reap(stale)?;
        }

        // §11.1: the code must be six digits before a window can offer it; a
        // malformed code would gate nothing at all.
        let offer = match window.offer.as_ref() {
            Some(offer) => Some(Mutex::new(OfferState {
                code: normalize_code(&offer.code)
                    .ok_or_else(|| "the pairing code must be six digits".to_string())?,
                expires_at: offer.expires_at,
                attempts: 0,
                redeemed: false,
            })),
            None => None,
        };

        let listener = TcpListener::bind((bind, 0))
            .map_err(|e| format!("could not start the pairing listener on {bind}: {e}"))?;
        let bound = listener
            .local_addr()
            .map_err(|_| "could not read the pairing listener port".to_string())?;
        let port = bound.port();
        // What the offer's QR carries (§11.1): a loopback bind is for tests and
        // reports itself; production binds every interface and reports the LAN
        // address the phone can actually reach.
        let endpoint = if bound.ip().is_unspecified() {
            crate::share::lan_ip().map(|ip| format!("{ip}:{port}"))
        } else {
            Some(format!("{}:{port}", bound.ip()))
        };
        let gate = Arc::new(Gate {
            local_device_id: window.local_device_id,
            local_secret,
            local_generation: window.local_generation,
            local_protocol_version: window.local_protocol_version,
            local_schema_version: window.local_schema_version,
            pairing_id: window.pairing_id,
            pin,
            offer,
            paired: Mutex::new(None),
            last_counter: Mutex::new(window.last_counter),
            send_counter: AtomicU64::new(0),
        });
        let shared = Arc::new(Shared::default());
        let thread_shared = Arc::clone(&shared);
        let thread_gate = Arc::clone(&gate);
        let join = thread::Builder::new()
            .name("purple-memo-pairing".to_string())
            .spawn(move || serve(listener, thread_gate, thread_shared))
            .map_err(|e| format!("could not start the pairing thread: {e}"))?;

        let running = Running {
            port,
            probe: probe_address(bound),
            endpoint,
            public_key,
            fingerprint,
            peer_device_id,
            gate,
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
            reap(running)?;
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
                reap(running)?;
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
                reap(running)?;
                Ok(PairingListenerInfo::stopped(None))
            }
            None => Ok(PairingListenerInfo::stopped(None)),
        }
    }
}

/// Signal the accept loop, join it, and then wait for the port itself to close.
///
/// The join alone proves nothing: in tiny_http the `Server` does not own the
/// socket — the crate's own thread does — and `Drop` only asks that thread to
/// stop (its comment allows "a few hundreds ms"). So a joined serve thread can
/// still be followed by a port that accepts connections. §11.5's guarantee is
/// about the socket, not the thread, so the close is not reported until a
/// connect is actually refused; if that never happens the error names the port
/// instead of claiming a window that is still open.
fn reap(mut running: Running) -> Result<(), String> {
    running.shared.stop.store(true, Ordering::SeqCst);
    if let Some(join) = running.join.take() {
        let _ = join.join();
    }
    wait_until_refused(running.probe)
}

/// Probe `probe` until a connect is refused, bounded by [`CLOSE_DEADLINE`].
///
/// "Refused" is a failed connect, which on Windows may be a dropped SYN rather
/// than an RST: a closed loopback port can take seconds to say so, hence the
/// short per-probe timeout. An open listener answers in well under a
/// millisecond, so a probe that cannot connect is the closed window.
fn wait_until_refused(probe: SocketAddr) -> Result<(), String> {
    let deadline = std::time::Instant::now() + CLOSE_DEADLINE;
    loop {
        if std::net::TcpStream::connect_timeout(&probe, CLOSE_PROBE_GAP * 4).is_err() {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "the pairing listener on port {} is still accepting connections; the window is not closed",
                probe.port()
            ));
        }
        thread::sleep(CLOSE_PROBE_GAP);
    }
}

/// The address a stop probes: the bound one, with an unspecified bind mapped to
/// loopback (production binds `0.0.0.0`, which is not itself connectable).
fn probe_address(bound: SocketAddr) -> SocketAddr {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
    if !bound.ip().is_unspecified() {
        return bound;
    }
    let loopback = match bound.ip() {
        IpAddr::V4(_) => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(_) => IpAddr::V6(Ipv6Addr::LOCALHOST),
    };
    SocketAddr::new(loopback, bound.port())
}

/// A refusal as the wire sees it: a named reason, a message, and the status
/// code that carries it.
struct RefusalReply {
    code: &'static str,
    message: String,
    status: u16,
    /// §11.1: how many guesses the code has left, on a code refusal.
    attempts_left: Option<u32>,
}

impl RefusalReply {
    fn refused(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            status: 403,
            attempts_left: None,
        }
    }

    fn malformed(message: impl Into<String>) -> Self {
        Self {
            code: "malformed",
            message: message.into(),
            status: 400,
            attempts_left: None,
        }
    }

    fn code_refused(code: &'static str, message: impl Into<String>, attempts_left: u32) -> Self {
        Self {
            code,
            message: message.into(),
            status: 403,
            attempts_left: Some(attempts_left),
        }
    }

    fn from_envelope(refusal: Refusal) -> Self {
        Self {
            code: refusal.code(),
            message: refusal.message(),
            status: 403,
            attempts_left: None,
        }
    }

    fn body(&self) -> JsonValue {
        let mut body = json!({ "ok": false, "reason": self.code, "message": self.message });
        if let (Some(left), Some(object)) = (self.attempts_left, body.as_object_mut()) {
            object.insert("attemptsLeft".to_string(), json!(left));
        }
        body
    }
}

/// The reason phrase for every status this listener can answer with.
fn status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Internal Server Error",
    }
}

/// Write one response; the caller's stream is dropped afterwards, which closes
/// the connection.
///
/// No `Access-Control-Allow-Origin` is ever sent (§11.1, N5): the phone's sealed
/// client invokes HTTP from Rust, not from a WebView `fetch`, so no browser is
/// meant to read this port and a wildcard grant would only widen it.
fn write_response(stream: &mut TcpStream, status: u16, body: &[u8]) -> std::io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/octet-stream\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n",
        status_text(status)
    );
    // A 204 has no body and must not carry a length (RFC 9110 §6.4.1).
    if status != 204 {
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    head.push_str("\r\n");
    let mut wire = head.into_bytes();
    wire.extend_from_slice(body);
    stream.write_all(&wire)
}

/// Read one request: a bounded head, then exactly the body its `Content-Length`
/// promises. Bounded in bytes *and* in time, so neither a huge head nor a slow
/// drip holds the worker past [`CONNECTION_TIMEOUT`].
fn read_request(stream: &mut TcpStream) -> Result<(String, String, Vec<u8>), RefusalReply> {
    let deadline = Instant::now() + CONNECTION_TIMEOUT;
    let too_slow = || RefusalReply::malformed("the request did not arrive in time.");
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= MAX_HEAD_BYTES {
            return Err(RefusalReply::malformed("the request head is too large."));
        }
        if Instant::now() >= deadline {
            return Err(too_slow());
        }
        match stream.read(&mut byte) {
            Ok(0) => return Err(RefusalReply::malformed("the request head ended early.")),
            Ok(_) => head.push(byte[0]),
            Err(_) => return Err(too_slow()),
        }
    }
    let text = String::from_utf8(head)
        .map_err(|_| RefusalReply::malformed("the request head is not UTF-8."))?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split(' ');
    let (Some(method), Some(target)) = (parts.next(), parts.next()) else {
        return Err(RefusalReply::malformed(
            "the request line is not METHOD TARGET HTTP/x.y.",
        ));
    };
    if !parts
        .next()
        .is_some_and(|version| version.starts_with("HTTP/1."))
    {
        return Err(RefusalReply::malformed("a pairing message is HTTP/1.x."));
    }

    let mut content_length: Option<usize> = None;
    for line in lines {
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(RefusalReply::malformed("a header has no colon."));
        };
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => {
                let length = value
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| RefusalReply::malformed("Content-Length is a number."))?;
                if content_length.replace(length).is_some() {
                    return Err(RefusalReply::malformed("Content-Length is sent once."));
                }
            }
            // A chunked body is not a pairing message: the frame carries its own
            // length and the HTTP body is exactly that (§11.6.1).
            "transfer-encoding" => {
                return Err(RefusalReply::malformed(
                    "a pairing message is not chunked; send one framed body.",
                ))
            }
            _ => {}
        }
    }

    let body_limit = MAX_FRAME_BYTES + FRAME_HEADER_BYTES + 1;
    let length = content_length.unwrap_or(0);
    if length > body_limit {
        return Err(RefusalReply::malformed(
            "the request body is larger than a pairing message.",
        ));
    }
    let mut body = Vec::with_capacity(length);
    let mut chunk = [0u8; 8192];
    while body.len() < length {
        if Instant::now() >= deadline {
            return Err(too_slow());
        }
        let want = (length - body.len()).min(chunk.len());
        match stream.read(&mut chunk[..want]) {
            Ok(0) => return Err(RefusalReply::malformed("the request body ended early.")),
            Ok(read) => body.extend_from_slice(&chunk[..read]),
            Err(_) => return Err(too_slow()),
        }
    }
    Ok((
        method.to_string(),
        target.split('?').next().unwrap_or(target).to_string(),
        body,
    ))
}

/// One answered connection: a status and, unless it is a bodiless 204, the
/// framed JSON document the phone reads (§11.6.1).
fn answer(stream: &mut TcpStream, gate: &Gate) -> (u16, Option<JsonValue>) {
    let (method, path, body) = match read_request(stream) {
        Ok(request) => request,
        Err(refusal) => return (refusal.status, Some(refusal.body())),
    };
    let hello = path == HELLO_PATH;
    if !hello && path != REQUEST_PATH {
        return (
            404,
            Some(json!({
                "ok": false,
                "reason": "not-found",
                "message": "the pairing listener serves POST /pair/hello and POST /pair/request.",
            })),
        );
    }
    // Answered, never granted: the 204 carries no CORS headers (N5).
    if method == "OPTIONS" {
        return (204, None);
    }
    if method != "POST" {
        return (
            405,
            Some(json!({
                "ok": false,
                "reason": "method",
                "message": "a pairing message is POSTed.",
            })),
        );
    }
    // §11.3 before anything else: a revoked peer's key is not even looked at.
    // This gates sealed messages only — the rendezvous below *replaces* the
    // pin, and a revocation must never be a lockout from re-pairing.
    if hello && active_pin(gate).is_some_and(|pin| pin.revoked) {
        let refusal = RefusalReply::refused(
            "revoked",
            "this device was revoked on the desktop; re-pair it before anything syncs (§11.3).",
        );
        return (refusal.status, Some(refusal.body()));
    }
    let outcome = if hello {
        admit(gate, &body)
    } else {
        rendezvous(gate, &body)
    };
    match outcome {
        Ok(reply) => (200, Some(reply)),
        Err(refusal) => (refusal.status, Some(refusal.body())),
    }
}

/// The accept loop. It never writes a response itself, so a client that stalls
/// cannot keep `stop` from returning; and it joins every worker it spawned, so
/// no thread holding `Arc<Gate>` — and with it the local secret — outlives the
/// window (§11.1, N5).
fn serve(listener: TcpListener, gate: Arc<Gate>, shared: Arc<Shared>) {
    // Non-blocking accept so the shutdown flag is read without a second socket.
    if listener.set_nonblocking(true).is_err() {
        return;
    }
    let mut consecutive_errors = 0u32;
    let mut workers: Vec<JoinHandle<()>> = Vec::new();
    while !shared.stop.load(Ordering::SeqCst) {
        workers.retain(|worker| !worker.is_finished());
        match listener.accept() {
            Ok((stream, _)) => {
                consecutive_errors = 0;
                if workers.len() >= MAX_WORKERS {
                    // Every slot is busy. Dropping closes the connection without
                    // putting this loop behind a worker that is still reading.
                    drop(stream);
                    continue;
                }
                let worker_gate = Arc::clone(&gate);
                if let Ok(join) = thread::Builder::new()
                    .name("purple-memo-pairing-worker".to_string())
                    .spawn(move || handle(stream, &worker_gate))
                {
                    workers.push(join);
                }
            }
            Err(ref error) if error.kind() == ErrorKind::WouldBlock => {
                consecutive_errors = 0;
                thread::sleep(POLL_INTERVAL);
            }
            // A client hanging up mid-handshake is normal; a listener that keeps
            // failing is not.
            Err(ref error)
                if matches!(
                    error.kind(),
                    ErrorKind::ConnectionAborted
                        | ErrorKind::ConnectionReset
                        | ErrorKind::Interrupted
                ) => {}
            Err(_) => {
                consecutive_errors += 1;
                if consecutive_errors >= 100 {
                    break;
                }
            }
        }
    }
    // Close the port first, then wait for the workers: a stop that returned with
    // `Gate`-holding threads alive would leave the local secret reachable after
    // the window is gone.
    drop(listener);
    for worker in workers {
        let _ = worker.join();
    }
}

/// Serve one connection: install the deadlines, answer, close.
fn handle(mut stream: TcpStream, gate: &Gate) {
    let _ = stream.set_read_timeout(Some(CONNECTION_TIMEOUT));
    let _ = stream.set_write_timeout(Some(CONNECTION_TIMEOUT));
    let (status, body) = answer(&mut stream, gate);
    let framed = match body {
        Some(body) => encode_frame(&body.to_string()).unwrap_or_default(),
        None => Vec::new(),
    };
    let _ = write_response(&mut stream, status, &framed);
}

/// §11.1: digits only, six of them. Spaces and dashes are typing conveniences,
/// exactly as `normalizeCode` in `src/lib/sync/pairing.ts` treats them.
fn normalize_code(input: &str) -> Option<String> {
    let digits: String = input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect();
    (digits.len() == 6 && digits.chars().all(|c| c.is_ascii_digit())).then_some(digits)
}

/// §1.2: a device id is a canonical lowercase UUID v4 — 36 characters, version
/// nibble `4`, RFC 4122 variant. Anything else is refused, never coerced: the
/// id is part of the envelope's HKDF `info`, which separates its fields with
/// NULs, so an arbitrary string would break that separation (N5).
fn canonical_device_id(input: &str) -> bool {
    let bytes = input.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => *byte == b'-',
        14 => *byte == b'4',
        19 => matches!(*byte, b'8' | b'9' | b'a' | b'b'),
        _ => byte.is_ascii_digit() || matches!(*byte, b'a'..=b'f'),
    })
}

/// §11.6.1: a long-term key is 32 bytes of lowercase hex, and it must be a point
/// X25519 can agree on — a low-order point yields an all-zero shared secret
/// (N5). `None` is a refusal, never a coercion.
fn usable_public_key(input: &str) -> Option<[u8; KEY_BYTES]> {
    let bytes = input.as_bytes();
    if bytes.len() != KEY_BYTES * 2
        || !bytes
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(*byte, b'a'..=b'f'))
    {
        return None;
    }
    let parsed = envelope::from_hex(input)?;
    let mut key = [0u8; KEY_BYTES];
    key.copy_from_slice(&parsed);
    // A fixed public probe only asks X25519 whether the point is usable; nothing
    // is sealed, sent or stored.
    envelope::shared_key(&[0x5au8; KEY_BYTES], &key)?;
    Some(key)
}

/// Constant-time compare: the length is fixed and public, so an early length
/// check leaks nothing, and the bytes are never short-circuited.
fn codes_equal(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// The pin in force: the peer this window's code pinned, else the one the
/// window was opened with.
fn active_pin(gate: &Gate) -> Option<Pin> {
    if let Some(paired) = gate
        .paired
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        return Some(paired.pin.clone());
    }
    gate.pin.clone()
}

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
    generation: u64,
}

fn rendezvous(gate: &Gate, body: &[u8]) -> Result<JsonValue, RefusalReply> {
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
    if Some(presented_pairing) != gate.pairing_id.as_deref() {
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
    if request.generation != gate.local_generation {
        return Err(RefusalReply::refused(
            "needs-re-pair",
            "this device's data line changed since it paired; re-pair it (§10.2, §10.5).",
        ));
    }
    let pin = Pin {
        device_id: request.device_id.clone(),
        public_key: key,
        generation: request.generation,
        revoked: false,
    };
    let ack = json!({
        "kind": "paired",
        "pairingId": gate.pairing_id,
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
        pairing_id: gate.pairing_id.as_deref(),
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

/// §7.1's order, from the pin to the ack.
fn admit(gate: &Gate, body: &[u8]) -> Result<JsonValue, RefusalReply> {
    let Some(pin) = active_pin(gate) else {
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
        // §11.6.1's HKDF salt and info: the key is bound to this pairing.
        pairing_id: gate.pairing_id.as_deref(),
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

    // §11.1 (wave 1, N1): opening a hello under the staged candidate's key is
    // the proof of possession the panel waits for before offering Trust. It is
    // proof, not trust — the pin is still the person's decision — so nothing
    // else changes here.
    if let Some(paired) = gate
        .paired
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_mut()
    {
        if paired.pin.device_id == pin.device_id && paired.pin.public_key == pin.public_key {
            paired.hello_received = true;
        }
    }

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
        pairing_id: gate.pairing_id.as_deref(),
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
    /// A key that is not the phone's: what a sibling device — or an attacker
    /// who saw the code — would present.
    const OTHER_SECRET: [u8; KEY_BYTES] = [0x55u8; KEY_BYTES];
    const DESKTOP_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const PHONE_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    fn desktop_identity() -> PairingIdentity {
        PairingIdentity::from_secret(DESKTOP_SECRET)
    }

    fn phone_public_hex() -> String {
        envelope::to_hex(&envelope::public_key(&PHONE_SECRET))
    }

    fn other_public_hex() -> String {
        envelope::to_hex(&envelope::public_key(&OTHER_SECRET))
    }

    fn window(revoked: bool) -> PairingWindow {
        PairingWindow {
            local_device_id: DESKTOP_ID.to_string(),
            local_generation: 1,
            local_protocol_version: 1,
            local_schema_version: 8,
            pairing_id: Some("pair-1".to_string()),
            offer: None,
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

    /// The hello's body, before it is sealed.
    fn hello_body() -> JsonValue {
        json!({
            "kind": "hello",
            "protocolVersion": 1,
            "schemaVersion": 8,
            "generation": 1,
            "pairingId": "pair-1",
            "deviceId": PHONE_ID,
        })
    }

    /// Seal a hello to the desktop's public key with whichever secret the test
    /// says holds the presented key.
    fn seal_hello(secret: &[u8; KEY_BYTES], counter: u64, message: &JsonValue) -> String {
        envelope::seal(SealInput {
            secret,
            peer_public: &envelope::public_key(&DESKTOP_SECRET),
            from: PHONE_ID,
            to: DESKTOP_ID,
            message_id: &format!("hello-{counter}"),
            counter,
            message,
            pairing_id: Some("pair-1"),
            nonce: None,
            ephemeral_secret: None,
        })
        .expect("seal the hello")
    }

    /// A real sealed hello from the phone, sealed to the desktop's public key.
    fn hello_wire(
        counter: u64,
        patch: impl FnOnce(&mut serde_json::Map<String, JsonValue>),
    ) -> String {
        let mut message = hello_body();
        patch(message.as_object_mut().expect("the hello is an object"));
        seal_hello(&PHONE_SECRET, counter, &message)
    }

    fn hello_frame(counter: u64) -> Vec<u8> {
        encode_frame(&hello_wire(counter, |_| {})).expect("frame the hello")
    }

    /// A hello sealed by a key that is not the pinned one.
    fn hello_frame_from(secret: &[u8; KEY_BYTES], counter: u64) -> Vec<u8> {
        encode_frame(&seal_hello(secret, counter, &hello_body())).expect("frame the hello")
    }

    /// A POST with the framed reply decoded — the shape the phone sees.
    fn post(port: u16, body: &[u8]) -> (u16, String) {
        let (status, raw) = request(port, "POST /pair/hello", body);
        let text =
            decode_frame(&raw).unwrap_or_else(|_| String::from_utf8_lossy(&raw).into_owned());
        (status, text)
    }

    /// A POST to the rendezvous endpoint, decoded like `post`.
    fn post_request(port: u16, body: &[u8]) -> (u16, String) {
        let (status, raw) = request(port, "POST /pair/request", body);
        let text =
            decode_frame(&raw).unwrap_or_else(|_| String::from_utf8_lossy(&raw).into_owned());
        (status, text)
    }

    /// The whole response, head included — for tests about headers.
    fn raw_response(port: u16, request_line: &str, body: &[u8]) -> Vec<u8> {
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
        raw
    }

    /// Minimal raw HTTP/1.1 request — enough to exercise the listener.
    ///
    /// The body is read as **bytes**: a framed reply begins with a length
    /// prefix, which is not UTF-8, so a string read would garble it.
    fn request(port: u16, request_line: &str, body: &[u8]) -> (u16, Vec<u8>) {
        let raw = raw_response(port, request_line, body);
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

    // -- the code-confirmed first pairing (§11.1) --------------------------

    /// A window offering the fixed test code, with no pin yet: this is what the
    /// desktop's QR panel opens for a phone that has never paired.
    fn offer_window(revoked: bool) -> PairingWindow {
        let mut window = window(revoked);
        window.peer = None;
        window.offer = Some(PairingOffer {
            code: "123456".to_string(),
            expires_at: now_ms() + 60_000,
        });
        window
    }

    fn started_with_offer(revoked: bool) -> (PairingListenerState, u16) {
        let state = PairingListenerState::default();
        let info = state
            .start("127.0.0.1", offer_window(revoked), desktop_identity())
            .expect("start the pairing window");
        (state, info.port.expect("a bound port"))
    }

    /// A window opened with the stored pin *and* a code: what a re-pair of an
    /// existing phone looks like.
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
            .start("127.0.0.1", window, desktop_identity())
            .expect("start the pairing window");
        (state, info.port.expect("a bound port"))
    }

    /// What the phone sends for a first pairing: plaintext, carrying its public
    /// key and the code from the desktop's screen.
    fn request_body(patch: impl FnOnce(&mut serde_json::Map<String, JsonValue>)) -> Vec<u8> {
        let mut message = json!({
            "kind": "pair-request",
            "deviceId": PHONE_ID,
            "publicKey": phone_public_hex(),
            "pairingId": "pair-1",
            "code": "123456",
            "protocolVersion": 1,
            "schemaVersion": 8,
            "generation": 1,
        });
        patch(message.as_object_mut().expect("the request is an object"));
        encode_frame(&message.to_string()).expect("frame the request")
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
            .start("127.0.0.1", stale, desktop_identity())
            .expect("start");
        let (status, body) = post_request(info.port.expect("port"), &request_body(|_| {}));
        assert_eq!(status, 403, "{body}");
        assert_eq!(refusal_reason(&body), "expired");
        expired.stop().expect("stop");
    }

    #[test]
    fn a_window_without_a_code_admits_no_first_pairing() {
        let state = PairingListenerState::default();
        let mut pinless = window(false);
        pinless.peer = None;
        let info = state
            .start("127.0.0.1", pinless, desktop_identity())
            .expect("start");
        let (status, body) = post(info.port.expect("port"), &request_body(|_| {}));
        assert_eq!(status, 403, "{body}");
        assert_eq!(refusal_reason(&body), "unpaired");
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
            .start("127.0.0.1", repin, desktop_identity())
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
    fn two_stalled_connections_do_not_keep_the_phone_out() {
        let (state, port) = started(false);
        // Two clients announce a body and never send it: both worker slots are
        // held until the connection's own deadline expires.
        let mut stalled = Vec::new();
        for _ in 0..MAX_WORKERS {
            let mut stream = StdTcpStream::connect(("127.0.0.1", port)).expect("connect");
            write!(
                stream,
                "POST /pair/hello HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\n"
            )
            .expect("write head");
            stalled.push(stream);
        }
        thread::sleep(CONNECTION_TIMEOUT + Duration::from_millis(500));

        // The deadline freed the workers, so the real phone is served.
        let (status, body) = post(port, &hello_frame(1));
        assert_eq!(status, 200, "{body}");
        drop(stalled);
        state.stop().expect("stop");
    }

    #[test]
    fn a_window_opened_on_an_old_counter_accepts_the_staged_peer_first_hello() {
        let state = PairingListenerState::default();
        let mut window = offer_window(false);
        // A previous window admitted counters up to 7 from some peer.
        window.last_counter = 7;
        let info = state
            .start("127.0.0.1", window, desktop_identity())
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

    #[test]
    fn no_response_grants_a_browser_origin() {
        let (state, port) = started(false);
        for line in ["POST /pair/hello", "OPTIONS /pair/hello"] {
            let head = String::from_utf8_lossy(&raw_response(port, line, &[])).to_lowercase();
            assert!(!head.contains("access-control"), "{line}: {head}");
        }
        state.stop().expect("stop");
    }
}
