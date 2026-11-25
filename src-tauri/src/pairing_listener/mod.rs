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
//! 4. then the payload: the message kind allowlist (the §2.3 seam — `hello` on
//!    `/pair/hello`, `snapshot-request`/`applied`/`adopted` on `/pair/snapshot`;
//!    table/field allowlists apply to the operation path, which does not exist
//!    yet), the pairing id, protocol version, schema version and the data line.
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
//! **The snapshot pull (§8.4).** `POST /pair/snapshot` serves the initial
//! snapshot: the phone asks for one batch at a time (`snapshot-request`),
//! acknowledges each (`applied`), and closes the whole pull (`adopted`). The
//! desktop reads the snapshot **once**, on the first snapshot-request, holds it
//! for the life of the window, and re-takes it on a new window (§11.4). Nothing
//! it serves is applied here: §8.4's one transaction is the phone's, so an
//! interrupted pull leaves the desktop with nothing to undo. The admission path
//! is the hello's, shared by parameter rather than copied — a revoked peer's
//! snapshot-request is refused before the reader is even called, so not one
//! batch byte leaves the desktop.
//!
//! **Framing (§11.6.1).** Each message is a length-prefixed UTF-8 JSON
//! document: four big-endian bytes of body length, then exactly that many bytes
//! of the envelope wire string. `src/lib/sync/frame.ts` is the phone's half, and
//! both sides are pinned to the same byte vector by a test.

use std::collections::HashSet;
use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};

use crate::envelope::{self, Opened, Refusal, KEY_BYTES};
use crate::lifecycle::Lifecycle;
use crate::pairing_key::PairingIdentity;
use crate::pairing_snapshot::{Snapshot, SnapshotBatch};

mod routes;

use self::routes::common::{active_pin, admit, normalize_code};

/// A sealed message from the pinned peer (§11.6.1).
const HELLO_PATH: &str = "/pair/hello";

/// The §8.4 snapshot pull: sealed `snapshot-request` / `applied` / `adopted`.
const SNAPSHOT_PATH: &str = "/pair/snapshot";

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

/// The message kinds `/pair/hello` speaks (§2.3's server-side seam). An
/// operation of any other kind is refused before it can have an effect.
const ACCEPTED_KINDS: [&str; 1] = ["hello"];

/// The kinds `/pair/snapshot` speaks — its own accepted set, never appended to
/// the hello's: a window that pulled data would be one a hello could not close.
const SNAPSHOT_ACCEPTED_KINDS: [&str; 3] = ["snapshot-request", "applied", "adopted"];

/// The §9.1 upload: sealed `upload` / `upload-commit` / `upload-status`.
const UPLOAD_PATH: &str = "/pair/upload";

/// The kinds `/pair/upload` speaks — again its own set (§2.3): the route that
/// receives records never answers a pull, and the route that serves them never
/// stages an upload.
const UPLOAD_ACCEPTED_KINDS: [&str; 3] = ["upload", "upload-commit", "upload-status"];

/// The §6 ongoing exchange: `sync-push` / `sync-commit` / `sync-pull` /
/// `sync-applied` / `sync-status`. A fourth route with its own kind set, for
/// the same reason each of the others has one (§2.3).
const SYNC_PATH: &str = "/pair/sync";

/// The kinds `/pair/sync` speaks. The push half and the pull half share the
/// route because they are one exchange — but the kind set is still the route's
/// own: a snapshot message posted here is refused by name.
const SYNC_ACCEPTED_KINDS: [&str; 5] = [
    "sync-push",
    "sync-commit",
    "sync-pull",
    "sync-applied",
    "sync-status",
];

/// §8.3's per-batch op bound, shared with the snapshot: one upload batch is
/// one bounded frame, never a data dump.
const MAX_UPLOAD_BATCH_OPS: usize = 200;

/// The plaintext budget of one sync-pull batch — the snapshot's figure, reused
/// rather than re-derived: the same frame math decides it (`envelope::seal`
/// hex-encodes, so the wire body is 2× the plaintext, and 30 KiB lanes ~62 KiB
/// sealed under the 64 KiB cap). One number, both paths (§8.3).
const MAX_SYNC_BATCH_BYTES: usize = crate::pairing_snapshot::MAX_SNAPSHOT_BATCH_BYTES;

/// The largest single op the frame can carry alone, derived from the same
/// arithmetic: half the frame minus the sealed header (~270 bytes), the reply's
/// own wrapper (`kind`, `pairingId`, `batch`, `total`, `ops`) and the AEAD tag.
/// An op over this cannot be delivered at all, so it is refused by name instead
/// of becoming a frame that never encodes (SW-04).
pub const MAX_SYNC_OP_BYTES: usize = MAX_FRAME_BYTES / 2 - 1024;

/// One sync op's plaintext size, as the batch budget counts it: its own JSON
/// plus the comma between ops. A field-level op is small; the figure exists for
/// the one create op carrying a very large row.
fn est_sync_op_bytes(op: &JsonValue) -> usize {
    op.to_string().len() + 1
}

/// The most batches one upload may declare in a window. The frame cap bounds
/// each batch's bytes; this bounds the staged total a window can be made to
/// hold (64 × 200 ops is already far past any phone's offline backlog).
const MAX_UPLOAD_BATCHES: usize = 64;

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
    /// §11.6.1: the pairing id is the HKDF salt, so a window cannot open
    /// without one. Required — a call that omits it fails at the IPC boundary
    /// instead of sealing under the zero salt (N9).
    pub pairing_id: String,
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
    /// §11.6.1: required — it is the HKDF salt, and `start` refuses an empty
    /// one rather than sealing under the all-zero default (N9).
    pub pairing_id: String,
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
    /// §11.1: wrong guesses burned on this window's code. The panel projects
    /// it into its session so a locked-out code never renders as live (N3).
    pub offer_attempts: u32,
    /// §11.1: the single-use code has been redeemed, so it is spent. The panel
    /// hides the QR and the digits the moment this is true (N3).
    pub offer_redeemed: bool,
    /// §9.1: the staged upload's state in this window — `receiving`, `staged`,
    /// `applying`, `applied` or `failed`; `None` until the phone sends a
    /// batch. The panel acts on `staged` (it takes and applies the ops), and
    /// the person sees the rest.
    pub upload_state: Option<String>,
    /// Ops staged so far (or applied, once the state is terminal).
    pub upload_ops: u64,
    /// Of the staged ops, how many the apply inserted as new records.
    pub upload_inserted: Option<u64>,
    /// Of the staged ops, how many this device already held (§7.2 no-ops).
    pub upload_already_known: Option<u64>,
    /// Why the apply failed, in the apply's own words.
    pub upload_note: Option<String>,
    /// §6: the staged push's state in this window — `receiving`, `staged`,
    /// `applying`, `applied` or `failed`; `None` until the phone pushes an op.
    /// The panel acts on `staged` (it takes and applies the ops).
    pub sync_state: Option<String>,
    /// Ops the phone pushed: staged so far, or applied once terminal.
    pub sync_ops: u64,
    /// `sync-applied`: the highest own seq the phone says it applied. The panel
    /// records it with `ackStatements`, which advances `cursor_out` (§6.5).
    pub sync_applied: Option<u64>,
    /// Why the sync apply failed, in the apply's own words.
    pub sync_note: Option<String>,
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
            offer_attempts: 0,
            offer_redeemed: false,
            upload_state: None,
            upload_ops: 0,
            upload_inserted: None,
            upload_already_known: None,
            upload_note: None,
            sync_state: None,
            sync_ops: 0,
            sync_applied: None,
            sync_note: None,
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
    /// Never optional: `start` refuses a window without one (§11.6.1).
    pairing_id: String,
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
    /// This device's own counter for acks and snapshot batches: per-sender and
    /// monotonic, one sequence for every message this window seals.
    send_counter: AtomicU64,
    /// The held §8.4 snapshot: read once per window, then served from memory.
    snapshot: Mutex<SnapshotStream>,
    /// Where the snapshot comes from. `None` is a window that serves the hello
    /// and the rendezvous only — every snapshot-request is then `not-allowed`.
    snapshot_source: Option<SnapshotSource>,
    /// The staged §9.1 upload: batches the phone sent, held until the panel
    /// applies them. Born empty in every window; nothing here outlives it.
    upload: Mutex<UploadState>,
    /// The §6 exchange: the phone's ops staged for the panel, this device's
    /// own ops held for its pull, and the positions each side reported.
    sync: Mutex<SyncState>,
    /// Where the pull's ops come from. `None` is a window that stages a push
    /// but serves none of its own — every `sync-pull` is then `not-allowed`.
    sync_source: Option<SyncSource>,
    /// F-2: where the pull's batch-level vault carriage comes from. `None`
    /// serves no carriage — the shape every window had before F-2.
    vault_meta_source: Option<VaultMetaSource>,
}

/// The one consistent §8.4 read this window holds, and the pull's progress
/// through it. All of it is the window's: a new window re-takes the snapshot
/// (§11.4), so nothing here outlives the port.
#[derive(Default)]
struct SnapshotStream {
    /// The pairing id the held read was taken for. `None` means no read yet.
    pairing_id: Option<String>,
    batches: Vec<SnapshotBatch>,
    /// Batches that left the desktop. Asking for one again re-serves it.
    served: HashSet<usize>,
    /// Batches the phone acknowledged, in arrival order.
    acked: HashSet<usize>,
    adopted: bool,
    /// §8.5: why this window cannot serve at all, when it cannot. Set by the
    /// one refusal that is about the DATA rather than the protocol, so the
    /// panel can show the person the record's name instead of silence.
    note: Option<String>,
}

/// The snapshot reader the shell hands in: `pairing_snapshot::read_snapshot`
/// over the app's own connection, so the one-transaction read happens in Rust
/// (a webview cannot hold a transaction across an IPC round trip).
pub type SnapshotSource = Arc<dyn Fn() -> Result<Snapshot, String> + Send + Sync>;

/// What the panel's apply decided about a staged upload (§9.1). Set exactly
/// once, by the panel, after its one transaction — the phone's verdict is this
/// value and nothing else, so an apply that never ran can never read as one
/// that succeeded.
#[derive(Debug, Clone)]
pub enum UploadOutcome {
    Applied { inserted: u64, already_known: u64 },
    Failed { message: String },
}

/// One window's §9.1 upload: the phone's own records, staged batch by batch
/// and applied by the panel in ONE transaction once the phone commits.
///
/// Nothing here writes to the database — the listener stages wire documents
/// exactly as it serves the snapshot without applying it. The panel takes the
/// staged ops, validates them (§3.4) and applies them; the outcome it reports
/// back is what `upload-status` seals to the phone. A window that closes
/// first loses the staging, and the phone — which keeps its records until the
/// sealed `uploaded` verdict — simply uploads again in the next window (§9.4).
#[derive(Default)]
struct UploadState {
    /// The batch count batch 0 declared. `None` until the first batch lands.
    total: Option<usize>,
    /// Staged batches, in arrival order; the index is the batch number.
    batches: Vec<Vec<JsonValue>>,
    /// The phone sent `upload-commit`: every batch is staged.
    committed: bool,
    /// The panel took the staged ops for its apply. Taken once.
    taken: bool,
    outcome: Option<UploadOutcome>,
}

impl UploadState {
    /// Every staged op, in batch order.
    fn ops(&self) -> Vec<JsonValue> {
        self.batches.iter().flatten().cloned().collect()
    }

    fn op_count(&self) -> usize {
        self.batches.iter().map(Vec::len).sum()
    }

    /// The one word `PairingListenerInfo` and the sealed status share.
    fn state_name(&self) -> Option<&'static str> {
        match &self.outcome {
            Some(UploadOutcome::Applied { .. }) => Some("applied"),
            Some(UploadOutcome::Failed { .. }) => Some("failed"),
            None if self.committed && self.taken => Some("applying"),
            None if self.committed => Some("staged"),
            None if !self.batches.is_empty() => Some("receiving"),
            None => None,
        }
    }
}

/// Where this device's own §6 ops come from: `sync_outbox` rows with
/// `seq > afterSeq`, as the wire document each one is (`readOutbox`'s shape).
/// Read in Rust for the snapshot's reason — the store's read is the app's own
/// connection — and read **once** per window, then served from memory.
pub type SyncSource = Arc<dyn Fn(u64) -> Result<Vec<JsonValue>, String> + Send + Sync>;

/// F-2: where a window serving a sync pull reads this device's vault pair —
/// (generation, sealed verifier) when a vault is set up here, `None` when
/// none is. Read once per held pull, like the ops read it rides beside.
pub type VaultMetaSource = Arc<dyn Fn() -> Result<Option<(i64, String)>, String> + Send + Sync>;

/// What the panel's apply decided about a staged push (§7). The phone acts on
/// this and nothing else: `throughSeq` is the highest seq the desktop's engine
/// actually applied, which is what its outbox may record as delivered.
#[derive(Debug, Clone)]
pub enum SyncOutcome {
    Applied { through_seq: u64 },
    Failed { message: String },
}

/// The §6 pull this window holds: the one read of this device's outbox, taken
/// when the first `sync-pull` arrives and kept for the window's life (the
/// snapshot rule — a new window re-reads, §11.4).
#[derive(Default)]
struct SyncPullStream {
    /// The `afterSeq` the held read was taken for. A later request naming a
    /// different one would be a different read, which one window does not do.
    after_seq: Option<u64>,
    batches: Vec<Vec<JsonValue>>,
    /// F-2: the vault pair read with the ops, repeated on every batch's
    /// reply — an item-less vault has no op to carry it, so the reply
    /// itself does. `None` when this device has no vault set up.
    vault_meta: Option<(i64, String)>,
    /// Batches that already left the desktop: asking for one again re-serves
    /// it, because a lost reply must not cost the phone the whole pull.
    served: HashSet<usize>,
}

/// One window's §6 exchange: the phone's ops staged for the panel's apply, the
/// device's own ops held for the phone's pull, and the two positions each side
/// reports. Born empty; nothing here outlives the port.
#[derive(Default)]
struct SyncState {
    /// The push: batches staged in order, then committed, then taken once.
    push_total: Option<usize>,
    push_batches: Vec<Vec<JsonValue>>,
    push_committed: bool,
    push_taken: bool,
    push_outcome: Option<SyncOutcome>,
    /// The pull: the one read, and the progress through it.
    pull: Option<SyncPullStream>,
    /// `sync-applied`: the highest seq the phone says it applied of ours. The
    /// panel reads it to record the acknowledgement (§6.5).
    applied_through: Option<u64>,
}

impl SyncState {
    /// Every staged push op, in batch order.
    fn push_ops(&self) -> Vec<JsonValue> {
        self.push_batches.iter().flatten().cloned().collect()
    }

    fn push_count(&self) -> usize {
        self.push_batches.iter().map(Vec::len).sum()
    }

    /// The one word `PairingListenerInfo` and the sealed status share.
    fn state_name(&self) -> Option<&'static str> {
        match &self.push_outcome {
            Some(SyncOutcome::Applied { .. }) => Some("applied"),
            Some(SyncOutcome::Failed { .. }) => Some("failed"),
            None if self.push_committed && self.push_taken => Some("applying"),
            None if self.push_committed => Some("staged"),
            None if !self.push_batches.is_empty() => Some("receiving"),
            None => None,
        }
    }

    /// The highest seq this push carried — the `throughSeq` an applied verdict
    /// reports and the phone's `sync-applied` answers with.
    fn highest_pushed_seq(&self) -> u64 {
        self.push_ops()
            .iter()
            .filter_map(|op| op.get("seq").and_then(JsonValue::as_u64))
            .max()
            .unwrap_or(0)
    }
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
        // §8.5's refusal outranks a stopped-window note: it is the reason a
        // pull cannot proceed, and the person can only fix it by editing that
        // record. Read before the other locks so the order is one-way.
        let snapshot_note = self
            .gate
            .snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .note
            .clone();
        let paired = self.gate.paired.lock().unwrap_or_else(|e| e.into_inner());
        // The code's live state lives in Rust (`Gate.offer`); the panel cannot
        // compute a lockout or a redemption from its own session (N3).
        let (offer_attempts, offer_redeemed) =
            self.gate.offer.as_ref().map_or((0, false), |offer| {
                let offer = offer.lock().unwrap_or_else(|e| e.into_inner());
                (offer.attempts, offer.redeemed)
            });
        // The upload's live state lives with the gate for the same reason the
        // code's does (N3): the panel cannot stage, take or decide it, so it
        // cannot report it either — it can only read what Rust holds.
        let upload = self.gate.upload.lock().unwrap_or_else(|e| e.into_inner());
        let (upload_inserted, upload_already_known, upload_note) = match &upload.outcome {
            Some(UploadOutcome::Applied {
                inserted,
                already_known,
            }) => (Some(*inserted), Some(*already_known), None),
            Some(UploadOutcome::Failed { message }) => (None, None, Some(message.clone())),
            None => (None, None, None),
        };
        let upload_state = upload.state_name().map(str::to_string);
        let upload_ops = upload.op_count() as u64;
        drop(upload);
        // …and the §6 exchange's, for the same reason.
        let sync = self.gate.sync.lock().unwrap_or_else(|e| e.into_inner());
        let sync_state = sync.state_name().map(str::to_string);
        let sync_ops = sync.push_count() as u64;
        let sync_applied = sync.applied_through;
        let sync_note = match &sync.push_outcome {
            Some(SyncOutcome::Failed { message }) => Some(message.clone()),
            _ => None,
        };
        drop(sync);
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
            offer_attempts,
            offer_redeemed,
            upload_state,
            upload_ops,
            upload_inserted,
            upload_already_known,
            upload_note,
            sync_state,
            sync_ops,
            sync_applied,
            sync_note,
            note: note.or(snapshot_note),
        }
    }
}

/// The managed pairing-listener state: at most one window, one socket.
#[derive(Default)]
pub struct PairingListenerState {
    inner: Mutex<Option<Running>>,
    /// The lock epoch (D2a), bumped by [`Self::stop_for_lock`] and
    /// [`Self::stop_for_reset`]. A `start` records it before preparing and
    /// re-checks it under the listener lock, so a window can never bind
    /// `0.0.0.0` a moment after the shell locked. Ordinary `stop` deliberately
    /// does not bump it: closing the panel is not the shell deciding the
    /// session ended, and it must not refuse the next open.
    lock_epoch: AtomicU64,
    /// The SAME barrier the share server and the DB commands consult (E2). A
    /// private barrier would be two states pretending to be one.
    lifecycle: Arc<Lifecycle>,
    /// The §6 pull's reader, installed by `pairing_open` before the window
    /// binds and taken by `start` into the gate. A slot rather than a
    /// `start` parameter so the twenty windows that serve no ops stay as they
    /// are: an absent source is a window that stages a push and serves none.
    sync_source: Mutex<Option<SyncSource>>,
    /// F-2: the vault carriage's reader, installed and taken the same way.
    vault_meta_source: Mutex<Option<VaultMetaSource>>,
}

impl PairingListenerState {
    /// Production constructor: shares the process's one barrier.
    pub fn with_lifecycle(lifecycle: Arc<Lifecycle>) -> Self {
        Self {
            lifecycle,
            ..Self::default()
        }
    }

    /// Install the §6 pull's reader for the window about to open. Called before
    /// `start`, which takes it: a source set while a window is running is
    /// dropped by the next `start` rather than swapped under a live gate, so
    /// the window that serves a pull is fixed for its whole life.
    pub fn set_sync_source(&self, source: SyncSource) {
        if let Ok(mut slot) = self.sync_source.lock() {
            *slot = Some(source);
        }
    }

    /// Install the F-2 vault carriage's reader for the window about to
    /// open, under the same take-at-`start` discipline as the sync source.
    pub fn set_vault_meta_source(&self, source: VaultMetaSource) {
        if let Ok(mut slot) = self.vault_meta_source.lock() {
            *slot = Some(source);
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
        snapshot: Option<SnapshotSource>,
    ) -> Result<PairingListenerInfo, String> {
        self.start_with_epoch(
            bind,
            window,
            identity,
            snapshot,
            self.lock_epoch.load(Ordering::SeqCst),
        )
    }

    /// Open the window, refusing if a lock or reset landed after `epoch` was
    /// read (D2a).
    ///
    /// The preparation between reading the epoch and taking the listener lock
    /// is where a lock can land. Both paths raise their barrier *before* they
    /// stop anything, so every interleaving ends one of two ways: this check
    /// passed first (and the lock's stop then reaps the window this call
    /// binds), or the barrier was first (and this refuses, binding nothing).
    fn start_with_epoch(
        &self,
        bind: &str,
        window: PairingWindow,
        identity: PairingIdentity,
        snapshot: Option<SnapshotSource>,
        epoch: u64,
    ) -> Result<PairingListenerInfo, String> {
        // Fail before binding anything if a reset or import owns the app (E2).
        self.lifecycle
            .ensure_listener_allowed()
            .map_err(|blocked| crate::messages::Refusal::from(blocked).diagnostic())?;
        // §11.6.1: a window is bound to its pairing id, which is the HKDF salt.
        // An empty one would seal under the all-zero default while claiming to
        // be bound, so it is refused here rather than trusted (N9).
        if window.pairing_id.trim().is_empty() {
            return Err("a pairing window needs a pairing id (§11.6.1)".to_string());
        }
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
        // The §6 reader belongs to the window, so it is taken here rather than
        // read live: a source installed for a later window must not be picked
        // up by this one, and one this window consumed is gone.
        let sync_source = self
            .sync_source
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        let vault_meta_source = self
            .vault_meta_source
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        let local_secret = *identity.secret();
        let public_key = identity.public_key_hex();
        let fingerprint = identity.fingerprint();
        let peer_device_id = window.peer.as_ref().map(|peer| peer.device_id.clone());

        let mut guard = self.lock()?;
        // Re-check under the server lock: a reset that landed while this start
        // was preparing must not be followed by a bind.
        self.lifecycle
            .ensure_listener_allowed()
            .map_err(|blocked| crate::messages::Refusal::from(blocked).diagnostic())?;
        // …and neither must a lock (D2a): the barrier was raised before the
        // lock's stop, so a start carrying a superseded epoch binds nothing
        // behind the lock screen.
        if self.lock_epoch.load(Ordering::SeqCst) != epoch {
            return Err(
                "pairing ended when the app locked before this window opened: unlock and show a fresh code"
                    .to_string(),
            );
        }
        // N4: a new window REPLACES the running one. Returning the old window's
        // info handed the panel a freshly minted code the live listener did not
        // gate on — a QR that always failed on the phone. Reopening the panel
        // now always yields a code the listener accepts.
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
            lan_ip().map(|ip| format!("{ip}:{port}"))
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
            snapshot: Mutex::new(SnapshotStream::default()),
            snapshot_source: snapshot,
            upload: Mutex::new(UploadState::default()),
            sync: Mutex::new(SyncState::default()),
            sync_source,
            vault_meta_source,
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
    /// The lock epoch is raised BEFORE the socket is reaped (D2a), so a
    /// `start` preparing right now is
    /// superseded instead of binding `0.0.0.0` a moment after the shell locked.
    /// The window's code does live in Rust now (`Gate.offer`); closing the
    /// socket is what makes it unreachable — there is no separate token to
    /// revoke before the close, only a start to supersede.
    pub fn stop_for_lock(&self) -> Result<PairingListenerInfo, String> {
        self.lock_epoch.fetch_add(1, Ordering::SeqCst);
        self.stop()
    }

    /// The reset path: close the window and report whether one was open.
    pub fn stop_for_reset(&self) -> Result<bool, String> {
        // Same barrier as the lock: a start in flight must not bind after a
        // factory reset has taken the data.
        self.lock_epoch.fetch_add(1, Ordering::SeqCst);
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

    /// Take the staged §9.1 upload for the panel's apply. `None` unless a
    /// phone committed a complete upload in this window and nobody has taken
    /// it yet — taking is once, so a second apply of the same staging can
    /// never start, whatever the panel does.
    ///
    /// The ops are the wire documents as staged; validating them is the
    /// apply's §3.4 step, not this hand-off's.
    pub fn take_upload(&self) -> Option<(String, Vec<JsonValue>)> {
        let guard = self.lock().ok()?;
        let running = guard.as_ref()?;
        if running.finished() {
            return None;
        }
        let mut upload = running
            .gate
            .upload
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if !upload.committed || upload.taken || upload.outcome.is_some() {
            return None;
        }
        upload.taken = true;
        Some((running.gate.pairing_id.clone(), upload.ops()))
    }

    /// Record what the panel's apply did, so `upload-status` can seal the
    /// verdict to the phone. Ignored unless the upload was taken and no
    /// outcome stands yet: the first verdict is the only one (§7.2).
    /// Take the staged §6 push for the panel's apply — the upload's rule:
    /// `None` unless the phone committed a complete push and nobody took it,
    /// and taking is once, so one staging can never be applied twice.
    pub fn take_sync_push(&self) -> Option<Vec<JsonValue>> {
        let guard = self.lock().ok()?;
        let running = guard.as_ref()?;
        if running.finished() {
            return None;
        }
        let mut sync = running.gate.sync.lock().unwrap_or_else(|e| e.into_inner());
        if !sync.push_committed || sync.push_taken || sync.push_outcome.is_some() {
            return None;
        }
        sync.push_taken = true;
        Some(sync.push_ops())
    }

    /// Record what the panel's apply did, so `sync-status` can seal the verdict.
    /// The first verdict stands (§7.2).
    pub fn set_sync_outcome(&self, outcome: SyncOutcome) {
        let Ok(guard) = self.lock() else { return };
        let Some(running) = guard.as_ref() else {
            return;
        };
        let mut sync = running.gate.sync.lock().unwrap_or_else(|e| e.into_inner());
        if sync.push_taken && sync.push_outcome.is_none() {
            sync.push_outcome = Some(outcome);
        }
    }

    pub fn set_upload_outcome(&self, outcome: UploadOutcome) {
        let Ok(guard) = self.lock() else { return };
        let Some(running) = guard.as_ref() else {
            return;
        };
        let mut upload = running
            .gate
            .upload
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if upload.taken && upload.outcome.is_none() {
            upload.outcome = Some(outcome);
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
    let snapshot = path == SNAPSHOT_PATH;
    let upload = path == UPLOAD_PATH;
    let sync = path == SYNC_PATH;
    if !hello && !snapshot && !upload && !sync && path != REQUEST_PATH {
        return (
            404,
            Some(json!({
                "ok": false,
                "reason": "not-found",
                "message": "the pairing listener serves POST /pair/hello, POST /pair/request, POST /pair/snapshot, POST /pair/upload and POST /pair/sync.",
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
    // pin, and a revocation must never be a lockout from re-pairing. On the
    // snapshot route it also means the reader is never called, so not one batch
    // byte leaves the desktop.
    if (hello || snapshot || upload || sync) && active_pin(gate).is_some_and(|pin| pin.revoked) {
        let refusal = RefusalReply::refused(
            "revoked",
            "this device was revoked on the desktop; re-pair it before anything syncs (§11.3).",
        );
        return (refusal.status, Some(refusal.body()));
    }
    let outcome = if hello {
        admit(gate, &body, &ACCEPTED_KINDS)
            .and_then(|(pin, opened)| routes::hello::acknowledged(gate, &pin, opened))
    } else if snapshot {
        admit(gate, &body, &SNAPSHOT_ACCEPTED_KINDS)
            .and_then(|(pin, opened)| routes::snapshot::snapshot_answer(gate, &pin, &opened))
    } else if upload {
        admit(gate, &body, &UPLOAD_ACCEPTED_KINDS)
            .and_then(|(pin, opened)| routes::upload::upload_answer(gate, &pin, &opened))
    } else if sync {
        admit(gate, &body, &SYNC_ACCEPTED_KINDS)
            .and_then(|(pin, opened)| routes::sync::sync_answer(gate, &pin, &opened))
    } else {
        routes::hello::rendezvous(gate, &body)
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
    // `accept` hands over a socket that inherits the listener's non-blocking
    // mode, and a read timeout is ignored on one: the first read would answer
    // `WouldBlock` microseconds after the connection arrived, before a phone's
    // request was on the wire, and be refused as "did not arrive in time" (N5).
    // Clearing it here is what makes CONNECTION_TIMEOUT mean what it says.
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(CONNECTION_TIMEOUT));
    let _ = stream.set_write_timeout(Some(CONNECTION_TIMEOUT));
    let (status, body) = answer(&mut stream, gate);
    // A body that cannot be framed is a REFUSAL, never an empty 2xx: the old
    // `unwrap_or_default()` answered 200 with no bytes, which a phone reads as a
    // malformed batch after its own push has already committed — the two-way
    // wedge SW-04 describes. Named, and still framed, so the client can report
    // the reason instead of guessing (§7.7).
    let (status, framed) = match body {
        Some(body) => match encode_frame(&body.to_string()) {
            Ok(frame) => (status, frame),
            Err(message) => {
                let refusal = RefusalReply {
                    code: "frame-too-large",
                    message,
                    status: 500,
                    attempts_left: None,
                };
                let framed = encode_frame(&refusal.body().to_string())
                    .expect("a refusal body is far under the frame cap");
                (refusal.status, framed)
            }
        },
        None => (status, Vec::new()),
    };
    let _ = write_response(&mut stream, status, &framed);
}

// ---------------------------------------------------------------------------
// Tests — run with `cargo test`. Real crypto, real loopback socket, no stubs.
// ---------------------------------------------------------------------------

/// The LAN address a phone on the same network can reach (also the address the
/// pairing offer puts in its QR, §11.1).
///
/// The default route answers on any normal network; an isolated LAN — a phone
/// hotspot or an offline router — has no default route at all, and returning
/// `None` there produced QRs with an empty endpoint that every phone refused
/// (N7). So the routes are asked first and the interfaces second.
fn lan_ip() -> Option<String> {
    default_route_ip().or_else(|| pick_lan_ip(interface_ips()))
}

/// The source address the default route would use, when there is one. Binding
/// a UDP socket and "connecting" it sends nothing — it only asks the OS.
fn default_route_ip() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    // RFC 5737 TEST-NET: routable-looking, never a real destination.
    socket.connect("192.0.2.1:80").ok()?;
    socket.local_addr().ok().map(|a| a.ip().to_string())
}

/// The best LAN address among the interfaces the OS reports.
///
/// A private IPv4 address wins (that is what a home network hands out), then
/// any other routable-looking IPv4. Loopback, `169.254/16` link-local and
/// unspecified addresses are never offered: none of them can be dialled from a
/// phone. IPv6 is skipped on purpose — a link-local address needs a scope id a
/// `host:port` QR cannot carry, and the phone's transport dials v4 today.
fn pick_lan_ip(candidates: Vec<std::net::IpAddr>) -> Option<String> {
    use std::net::IpAddr;
    let rank = |ip: &IpAddr| -> Option<u8> {
        match ip {
            IpAddr::V4(v4) if v4.is_loopback() || v4.is_unspecified() => None,
            IpAddr::V4(v4) if v4.is_link_local() => None,
            IpAddr::V4(v4) if v4.is_private() => Some(0),
            IpAddr::V4(_) => Some(1),
            IpAddr::V6(_) => None,
        }
    };
    let mut best: Option<(u8, IpAddr)> = None;
    for ip in candidates {
        let Some(score) = rank(&ip) else { continue };
        let better = match best {
            None => true,
            Some((current, _)) => score < current,
        };
        if better {
            best = Some((score, ip));
        }
    }
    best.map(|(_, ip)| ip.to_string())
}

/// Every IPv4 address the OS reports for its interfaces (no crate needed; the
/// platform call is target-gated here).
#[cfg(unix)]
fn interface_ips() -> Vec<std::net::IpAddr> {
    use std::net::{IpAddr, Ipv4Addr};
    let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: `getifaddrs` fills a NULL-terminated list owned by us; every node
    // is read only while non-NULL, the v4 address is read from the sockaddr the
    // family check just identified, and the list is freed exactly once below.
    unsafe {
        if libc::getifaddrs(&mut head) != 0 {
            return Vec::new();
        }
        let mut found = Vec::new();
        let mut cursor = head;
        while let Some(entry) = cursor.as_ref() {
            if !entry.ifa_addr.is_null() && (*entry.ifa_addr).sa_family as i32 == libc::AF_INET {
                let addr = &*(entry.ifa_addr as *const libc::sockaddr_in);
                // `s_addr` is network byte order; its in-memory bytes are the
                // four octets in order.
                found.push(IpAddr::V4(Ipv4Addr::from(
                    addr.sin_addr.s_addr.to_ne_bytes(),
                )));
            }
            cursor = entry.ifa_next;
        }
        libc::freeifaddrs(head);
        found
    }
}

/// Windows: `GetAdaptersAddresses`, the same call every LAN-address crate
/// makes. `windows-sys` is already in the lock file (Tauri's own tree), so this
/// declares an existing pin rather than adding a crate to download.
#[cfg(windows)]
fn interface_ips() -> Vec<std::net::IpAddr> {
    use std::net::{IpAddr, Ipv4Addr};
    use std::ptr;
    use windows_sys::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, ERROR_SUCCESS};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
        GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_UNSPEC, SOCKADDR_IN};

    // `usize` keeps the buffer aligned for the adapter structs it is read as.
    let mut words: Vec<usize> = vec![0; 15 * 1024 / std::mem::size_of::<usize>()];
    let mut size = (words.len() * std::mem::size_of::<usize>()) as u32;
    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    // SAFETY: the buffer is aligned and sized by `size`, which the call updates
    // on overflow; it is reallocated once and the call repeated.
    let mut result = unsafe {
        GetAdaptersAddresses(
            AF_UNSPEC as u32,
            flags,
            ptr::null(),
            words.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>(),
            &mut size,
        )
    };
    if result == ERROR_BUFFER_OVERFLOW {
        words = vec![0; (size as usize).div_ceil(std::mem::size_of::<usize>())];
        size = (words.len() * std::mem::size_of::<usize>()) as u32;
        // SAFETY: same contract as the first call, with the size the OS asked
        // for.
        result = unsafe {
            GetAdaptersAddresses(
                AF_UNSPEC as u32,
                flags,
                ptr::null(),
                words.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>(),
                &mut size,
            )
        };
    }
    if result != ERROR_SUCCESS {
        return Vec::new();
    }
    let mut found = Vec::new();
    let mut adapter = words.as_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
    // SAFETY: the adapter list was filled by the successful call above and is
    // NULL-terminated; each unicast entry is likewise walked only while non-NULL
    // and read as a `SOCKADDR_IN` only after its family says it is one.
    unsafe {
        while let Some(current) = adapter.as_ref() {
            let mut unicast = current.FirstUnicastAddress;
            while let Some(entry) = unicast.as_ref() {
                let socket = entry.Address;
                if !socket.lpSockaddr.is_null() && (*socket.lpSockaddr).sa_family == AF_INET {
                    let addr = &*(socket.lpSockaddr as *const SOCKADDR_IN);
                    found.push(IpAddr::V4(Ipv4Addr::from(
                        addr.sin_addr.S_un.S_addr.to_ne_bytes(),
                    )));
                }
                unicast = entry.Next;
            }
            adapter = current.Next;
        }
    }
    found
}

#[cfg(not(any(unix, windows)))]
fn interface_ips() -> Vec<std::net::IpAddr> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use self::routes::common::now_ms;
    use super::*;
    use crate::envelope::SealInput;
    use std::io::Write;
    use std::net::TcpStream as StdTcpStream;

    pub(super) const DESKTOP_SECRET: [u8; KEY_BYTES] = [0x11u8; KEY_BYTES];
    pub(super) const PHONE_SECRET: [u8; KEY_BYTES] = [0x22u8; KEY_BYTES];
    /// A key that is not the phone's: what a sibling device — or an attacker
    /// who saw the code — would present.
    pub(super) const OTHER_SECRET: [u8; KEY_BYTES] = [0x55u8; KEY_BYTES];
    pub(super) const DESKTOP_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    pub(super) const PHONE_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    pub(super) fn desktop_identity() -> PairingIdentity {
        PairingIdentity::from_secret(DESKTOP_SECRET)
    }

    pub(super) fn phone_public_hex() -> String {
        envelope::to_hex(&envelope::public_key(&PHONE_SECRET))
    }

    pub(super) fn other_public_hex() -> String {
        envelope::to_hex(&envelope::public_key(&OTHER_SECRET))
    }

    pub(super) fn window(revoked: bool) -> PairingWindow {
        PairingWindow {
            local_device_id: DESKTOP_ID.to_string(),
            local_generation: 1,
            local_protocol_version: 1,
            local_schema_version: 8,
            pairing_id: "pair-1".to_string(),
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

    pub(super) fn started(revoked: bool) -> (PairingListenerState, u16) {
        let state = PairingListenerState::default();
        let info = state
            .start("127.0.0.1", window(revoked), desktop_identity(), None)
            .expect("start the pairing listener");
        (state, info.port.expect("a bound port"))
    }

    /// The hello's body, before it is sealed.
    pub(super) fn hello_body() -> JsonValue {
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
    pub(super) fn seal_hello(
        secret: &[u8; KEY_BYTES],
        counter: u64,
        message: &JsonValue,
    ) -> String {
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
    pub(super) fn hello_wire(
        counter: u64,
        patch: impl FnOnce(&mut serde_json::Map<String, JsonValue>),
    ) -> String {
        let mut message = hello_body();
        patch(message.as_object_mut().expect("the hello is an object"));
        seal_hello(&PHONE_SECRET, counter, &message)
    }

    pub(super) fn hello_frame(counter: u64) -> Vec<u8> {
        encode_frame(&hello_wire(counter, |_| {})).expect("frame the hello")
    }

    /// A hello sealed by a key that is not the pinned one.
    pub(super) fn hello_frame_from(secret: &[u8; KEY_BYTES], counter: u64) -> Vec<u8> {
        encode_frame(&seal_hello(secret, counter, &hello_body())).expect("frame the hello")
    }

    /// A POST with the framed reply decoded — the shape the phone sees.
    pub(super) fn post(port: u16, body: &[u8]) -> (u16, String) {
        let (status, raw) = request(port, "POST /pair/hello", body);
        let text =
            decode_frame(&raw).unwrap_or_else(|_| String::from_utf8_lossy(&raw).into_owned());
        (status, text)
    }

    /// A POST to the rendezvous endpoint, decoded like `post`.
    pub(super) fn post_request(port: u16, body: &[u8]) -> (u16, String) {
        let (status, raw) = request(port, "POST /pair/request", body);
        let text =
            decode_frame(&raw).unwrap_or_else(|_| String::from_utf8_lossy(&raw).into_owned());
        (status, text)
    }

    /// The whole response, head included — for tests about headers.
    pub(super) fn raw_response(port: u16, request_line: &str, body: &[u8]) -> Vec<u8> {
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
    pub(super) fn request(port: u16, request_line: &str, body: &[u8]) -> (u16, Vec<u8>) {
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

    pub(super) fn refusal_reason(body: &str) -> String {
        let parsed: JsonValue = serde_json::from_str(body).expect("refusal json");
        parsed["reason"].as_str().unwrap_or_default().to_string()
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
            .start("127.0.0.1", window(false), desktop_identity(), None)
            .expect("reopen");
        assert!(reopened.port.is_some());
        assert_eq!(reopened.port, locked.status().expect("status").port);
        locked.stop().expect("stop");
    }

    #[test]
    fn one_window_one_socket() {
        let state = PairingListenerState::default();
        let first = state
            .start("127.0.0.1", window(false), desktop_identity(), None)
            .expect("start");
        let second = state
            .start("127.0.0.1", window(false), desktop_identity(), None)
            .expect("start again");
        // One window, one socket — and the window that is up is the NEW one
        // (N4): the old port is reaped before the replacement binds, so there
        // is never a second pairing door, and the panel's freshly minted code
        // is the one the live listener checks.
        assert_ne!(first.port, second.port, "the running window is replaced");
        let old = first.port.expect("a bound port");
        assert!(
            StdTcpStream::connect(("127.0.0.1", old)).is_err(),
            "the replaced window's socket is closed"
        );
        assert_eq!(second.port, state.status().expect("status").port);
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
            .start("127.0.0.1", window(false), desktop_identity(), None)
            .expect_err("no listener may come up after the barrier");
        // The refusal is a message key (D7). `start` still answers with one
        // string — the panel's note channel — so the key is what it carries,
        // and the catalogue says what to do with it.
        assert_eq!(error, "rust.error.resetInProgress");
        assert!(!state.status().expect("status").running);
    }

    // -- the code-confirmed first pairing (§11.1) --------------------------

    /// A window offering the fixed test code, with no pin yet: this is what the
    /// desktop's QR panel opens for a phone that has never paired.
    pub(super) fn offer_window(revoked: bool) -> PairingWindow {
        let mut window = window(revoked);
        window.peer = None;
        window.offer = Some(PairingOffer {
            code: "123456".to_string(),
            expires_at: now_ms() + 60_000,
        });
        window
    }

    pub(super) fn started_with_offer(revoked: bool) -> (PairingListenerState, u16) {
        let state = PairingListenerState::default();
        let info = state
            .start("127.0.0.1", offer_window(revoked), desktop_identity(), None)
            .expect("start the pairing window");
        (state, info.port.expect("a bound port"))
    }

    /// N3: the panel learns the code's live state from the listener — the
    /// attempts it has burned and the redemption it performed — instead of
    /// guessing from a session Rust never updates.
    #[test]
    pub(super) fn the_info_reports_the_code_the_listener_actually_gates_on() {
        let (state, port) = started_with_offer(false);
        let before = state.status().expect("status");
        assert_eq!(before.offer_attempts, 0);
        assert!(!before.offer_redeemed);

        let (status, _) = post_request(
            port,
            &request_body(|message| {
                message.insert("code".to_string(), json!("000000"));
            }),
        );
        assert_eq!(status, 403);
        let after = state.status().expect("status");
        assert_eq!(after.offer_attempts, 1, "a wrong guess is reported");
        assert!(!after.offer_redeemed, "a refused guess spends nothing");

        let (status, _) = post_request(port, &request_body(|_| {}));
        assert_eq!(status, 200);
        let redeemed = state.status().expect("status");
        assert!(redeemed.offer_redeemed, "the single-use code is spent");
    }

    /// N4 (D2a): a lock that lands while a start is preparing supersedes it;
    /// nothing binds behind the lock screen.
    #[test]
    pub(super) fn a_lock_during_start_refuses_to_bind() {
        let state = PairingListenerState::default();
        let armed = state.lock_epoch.load(Ordering::SeqCst);
        state.stop_for_lock().expect("lock stop");
        let refused = state.start_with_epoch(
            "127.0.0.1",
            offer_window(false),
            desktop_identity(),
            None,
            armed,
        );
        assert!(refused.is_err(), "the superseded start must refuse");
        assert!(
            refused.unwrap_err().contains("locked"),
            "the refusal says why"
        );
        assert!(!state.status().expect("status").running);
    }

    /// N4: a second open replaces the running window — the code the panel now
    /// shows is the code the listener checks.
    #[test]
    pub(super) fn a_new_window_replaces_the_running_one() {
        let (state, first) = started_with_offer(false);
        let mut window = offer_window(false);
        window.offer = Some(PairingOffer {
            code: "654321".to_string(),
            expires_at: now_ms() + 60_000,
        });
        let second = state
            .start("127.0.0.1", window, desktop_identity(), None)
            .expect("replace the window");
        let port = second.port.expect("a bound port");
        assert_ne!(port, first, "the old window was reaped, not reused");
        assert!(
            StdTcpStream::connect(("127.0.0.1", first)).is_err(),
            "the replaced window's port refuses a connect"
        );

        // The code from the FIRST window is not what the live gate accepts.
        let (status, _) = post_request(port, &request_body(|_| {}));
        assert_eq!(status, 403, "the stale code is wrong on this window");
        let (status, _) = post_request(
            port,
            &request_body(|message| {
                message.insert("code".to_string(), json!("654321"));
            }),
        );
        assert_eq!(status, 200, "the new code is the one the listener checks");
    }

    /// A window opened with the stored pin *and* a code: what a re-pair of an
    /// existing phone looks like.
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
    fn no_response_grants_a_browser_origin() {
        let (state, port) = started(false);
        for line in ["POST /pair/hello", "OPTIONS /pair/hello"] {
            let head = String::from_utf8_lossy(&raw_response(port, line, &[])).to_lowercase();
            assert!(!head.contains("access-control"), "{line}: {head}");
        }
        state.stop().expect("stop");
    }

    // ------------------------------------------------------------------
    // §8.4 — the snapshot pull, over the real socket and a real database.
    // ------------------------------------------------------------------

    /// What the phone sends for a first pairing: plaintext, carrying its public
    /// key and the code from the desktop's screen.
    pub(super) fn request_body(
        patch: impl FnOnce(&mut serde_json::Map<String, JsonValue>),
    ) -> Vec<u8> {
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
}
