//! The pairing commands: this device's facts and identity, the pairing
//! window, the phone's snapshot/upload/sync exchanges and the confirmed
//! identity replacement.

use rusqlite::Connection;
use serde::Serialize;
use tauri::{Manager, State};

use super::{lock_conn, refuse_mobile_role, CmdResult};
use crate::db::AppState;
use crate::messages::Refusal;
use crate::pairing_key::{self, PairingHistory, PairingIdentity};
use crate::pairing_listener::{
    PairingListenerInfo, PairingListenerState, PairingOffer, PairingOpenInput, PairingWindow,
    PAIRING_PORT, PROTOCOL_VERSION,
};

/// This device's own pairing facts: what the offer carries (§11.1) and what the
/// other screen compares (§11.2). The public key and fingerprint are public by
/// design; there is no field for a secret.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingLocalInfo {
    pub device_id: String,
    pub generation: u64,
    pub schema_version: u64,
    pub protocol_version: u64,
    pub public_key: String,
    pub fingerprint: String,
}

/// The device id, data line and schema the sync store holds — read from the one
/// database through the same connection lock every other command uses, so the
/// pairing window can never advertise facts the store does not hold.
fn local_sync_facts(state: &AppState) -> CmdResult<(String, u64, u64)> {
    let conn = lock_conn(state)?;
    let (device_id, generation): (String, i64) = conn
        .query_row(
            "SELECT device_id, data_generation FROM sync_state WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| Refusal::new("rust.error.syncState").with("detail", e))?;
    let schema: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| Refusal::new("rust.error.schemaVersion").with("detail", e))?;
    Ok((device_id, generation.max(0) as u64, schema.max(0) as u64))
}

/// Whether this install has ever paired — the one database fact `pairing_key`
/// needs so a missing identity fails closed instead of rotating silently
/// (§11.2, wave 1 N2).
pub(crate) fn pairing_history(conn: &Connection) -> CmdResult<PairingHistory> {
    let paired: bool = conn
        .query_row("SELECT EXISTS (SELECT 1 FROM sync_peers)", [], |row| {
            row.get(0)
        })
        .map_err(|e| Refusal::new("rust.error.pairingHistory").with("detail", e))?;
    Ok(if paired {
        PairingHistory::Paired
    } else {
        PairingHistory::Never
    })
}

/// `sync_state.re_pair_required` as stored.
pub(crate) fn re_pair_required(conn: &Connection) -> CmdResult<bool> {
    let flag: i64 = conn
        .query_row(
            "SELECT re_pair_required FROM sync_state WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|e| Refusal::new("rust.error.rePairFlag").with("detail", e))?;
    Ok(flag == 1)
}

/// Record that this install must re-pair (§11.4, N2). Idempotent, and it moves
/// nothing else: notes, tasks and the database key stay exactly where they are.
pub(crate) fn mark_re_pair_required(conn: &Connection) -> CmdResult<()> {
    conn.execute(
        "UPDATE sync_state SET re_pair_required = 1, \
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 1",
        [],
    )
    .map_err(|e| Refusal::new("rust.error.rePairRecord").with("detail", e))?;
    Ok(())
}

/// This install's pairing identity, minting only on a fresh install (§11.2, N2).
///
/// A missing or unopenable identity over an existing pin is a re-pair, not a
/// crash: the flag is recorded so the recovery path is offered even on a launch
/// that missed boot's check, and the error carries the reason to show.
fn load_pairing_identity(db_state: &AppState) -> CmdResult<PairingIdentity> {
    let history = {
        let conn = lock_conn(db_state)?;
        pairing_history(&conn)?
    };
    pairing_key::load_or_mint(history).map_err(|error| {
        if error.needs_re_pair_flag() {
            if let Ok(conn) = lock_conn(db_state) {
                let _ = mark_re_pair_required(&conn);
            }
        }
        Refusal::new("rust.error.pairingIdentity").with("detail", error.message())
    })
}

/// This device's pairing identity and the data line it would pair on. Reads
/// only — no socket is bound here.
#[tauri::command]
pub fn pairing_local(app: tauri::AppHandle) -> CmdResult<PairingLocalInfo> {
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let (device_id, generation, schema_version) = local_sync_facts(&db_state)?;
    let identity = load_pairing_identity(&db_state)?;
    Ok(PairingLocalInfo {
        device_id,
        generation,
        schema_version,
        protocol_version: PROTOCOL_VERSION,
        public_key: identity.public_key_hex(),
        fingerprint: identity.fingerprint(),
    })
}

/// Open the pairing window (§11.5): one LAN listener, alive only while the
/// panel is on screen. The local identity, device id, generation and schema are
/// read here rather than trusted from the webview.
#[tauri::command]
pub fn pairing_open(
    app: tauri::AppHandle,
    input: PairingOpenInput,
) -> CmdResult<PairingListenerInfo> {
    refuse_mobile_role()?;
    let listener = app
        .try_state::<PairingListenerState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let (device_id, generation, schema_version) = local_sync_facts(&db_state)?;
    let identity = load_pairing_identity(&db_state)?;
    // §7.2 across restarts: the device-local floor row is the authority for
    // how far this pairing id's envelopes have advanced. The webview may seed
    // a window that never saw the floor; it may never lower one. An id this
    // app cannot key a floor by is refused here, at the boundary, instead of
    // failing every envelope later; an unreadable floor row refuses the open
    // outright — "I don't know" must not mean zero for the one record that
    // keeps old envelopes refused.
    let floor_key = crate::pairing_counter::peer_floor_key(&input.pairing_id)
        .ok_or_else(|| Refusal::new("rust.error.pairingIdUnusable"))?;
    let floor = {
        let conn = lock_conn(&db_state)?;
        match crate::pairing_counter::read_floor(&conn, &floor_key) {
            crate::pairing_counter::FloorRead::Value(value) => Some(value),
            crate::pairing_counter::FloorRead::Absent => None,
            crate::pairing_counter::FloorRead::Unreadable => {
                return Err(Refusal::new("rust.error.floorUnreadable"));
            }
        }
    };
    let offer = match (input.offer_code, input.offer_expires_at) {
        (Some(code), Some(expires_at)) => Some(PairingOffer { code, expires_at }),
        (None, None) => None,
        _ => return Err(Refusal::new("rust.error.offerIncomplete")),
    };
    let window = PairingWindow {
        local_device_id: device_id,
        local_generation: generation,
        local_protocol_version: PROTOCOL_VERSION,
        local_schema_version: schema_version,
        pairing_id: input.pairing_id,
        offer,
        peer: input.peer,
        last_counter: floor.unwrap_or(input.last_counter.unwrap_or(0)),
    };
    // §8.4: the snapshot is read in Rust, under the same connection lock every
    // other reader takes, because §8.4 requires one transaction across the whole
    // read and the webview cannot hold one across an IPC round trip.
    let reader = app.clone();
    // These three readers feed the window's `note`, which is a diagnostic
    // channel (it also relays the peer's own words), so they keep a single
    // string: `Refusal::diagnostic` carries the layer's detail.
    let snapshot: crate::pairing_listener::SnapshotSource = std::sync::Arc::new(move || {
        let db_state = reader
            .try_state::<AppState>()
            .ok_or_else(|| Refusal::new("rust.error.stateUnavailable").diagnostic())?;
        let conn = lock_conn(&db_state).map_err(|e| e.diagnostic())?;
        crate::pairing_snapshot::read_snapshot(&conn)
    });
    // §11.5: the window is on the LAN only while pairing is on screen; the
    // panel closes it on expiry, on close, on lock and on app background.
    // §6: this window's own operations, read in Rust for the snapshot's reason
    // — the read is the app's connection, taken under the one lock every other
    // reader takes, and the listener holds it for the window's life.
    let sync_reader = app.clone();
    let sync_source: crate::pairing_listener::SyncSource = std::sync::Arc::new(move |after_seq| {
        let db_state = sync_reader
            .try_state::<AppState>()
            .ok_or_else(|| Refusal::new("rust.error.stateUnavailable").diagnostic())?;
        let conn = lock_conn(&db_state).map_err(|e| e.diagnostic())?;
        let mut statement = conn
            .prepare(
                "SELECT device_id, seq, op_id, entity_table, entity_uid, op, \
                 base_counter, counter, field_stamps, payload FROM sync_outbox \
                 WHERE seq > ? ORDER BY seq",
            )
            .map_err(|error| Refusal::from(error.to_string()).diagnostic())?;
        let rows = statement
            .query_map([after_seq as i64], |row| {
                Ok(serde_json::json!({
                    "device_id": row.get::<_, String>(0)?,
                    "seq": row.get::<_, i64>(1)? as u64,
                    "op_id": row.get::<_, String>(2)?,
                    "entity_table": row.get::<_, String>(3)?,
                    "entity_uid": row.get::<_, String>(4)?,
                    "op": row.get::<_, String>(5)?,
                    "base_counter": row.get::<_, i64>(6)? as u64,
                    "counter": row.get::<_, i64>(7)? as u64,
                    "field_stamps": row.get::<_, String>(8)?,
                    "payload": row.get::<_, String>(9)?,
                }))
            })
            .map_err(|error| Refusal::from(error.to_string()).diagnostic())?;
        let mut ops = Vec::new();
        for row in rows {
            ops.push(row.map_err(|error| Refusal::from(error.to_string()).diagnostic())?);
        }
        Ok(ops)
    });
    listener.set_sync_source(sync_source);
    // F-2: the same window also serves the vault pair at batch level, so a
    // vault set up here reaches the phone even while it holds no items —
    // the §12.3 envelope otherwise rides on rows an empty vault never has.
    let vault_reader = app.clone();
    let vault_meta_source: crate::pairing_listener::VaultMetaSource =
        std::sync::Arc::new(move || {
            let db_state = vault_reader
                .try_state::<AppState>()
                .ok_or_else(|| Refusal::new("rust.error.stateUnavailable").diagnostic())?;
            let conn = lock_conn(&db_state).map_err(|e| e.diagnostic())?;
            let (generation, verifier) = crate::pairing_snapshot::vault_metadata(&conn)?;
            Ok(verifier.map(|v| (if generation >= 1 { generation } else { 1 }, v)))
        });
    listener.set_vault_meta_source(vault_meta_source);
    listener
        .start("0.0.0.0", PAIRING_PORT, window, identity, Some(snapshot))
        .map_err(Refusal::from)
}

/// Close the pairing window. Idempotent, and called by the lock and app-
/// background paths as well as by the panel's own close (§11.5).
#[tauri::command]
pub fn pairing_close(state: State<'_, PairingListenerState>) -> CmdResult<PairingListenerInfo> {
    refuse_mobile_role()?;
    state.stop().map_err(Refusal::from)
}

/// The lock path's close (D2a): raises the lock epoch before stopping, so a
/// `pairing_open` already in flight is superseded instead of binding behind
/// the lock screen. The panel's ordinary close stays `pairing_close` — only
/// a lock (or the close-to-tray handler, which calls `stop_for_lock`
/// directly) may raise the epoch.
#[tauri::command]
pub fn pairing_close_for_lock(
    state: State<'_, PairingListenerState>,
) -> CmdResult<PairingListenerInfo> {
    refuse_mobile_role()?;
    state.stop_for_lock().map_err(Refusal::from)
}

/// Current pairing state — including the peer a code-confirmed rendezvous
/// pinned, which the panel then stores as its pin (§11.2).
#[tauri::command]
pub async fn pairing_status(app: tauri::AppHandle) -> CmdResult<PairingListenerInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        refuse_mobile_role()?;
        app.state::<PairingListenerState>()
            .status()
            .map_err(Refusal::from)
    })
    .await
    .map_err(|e| Refusal::from(e.to_string()))?
}

/// The pairing identity's state, for the re-pair recovery (§11.2, wave 1 N2).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingIdentityStatus {
    /// Whether a keypair is stored and readable right now.
    pub present: bool,
    pub public_key: Option<String>,
    pub fingerprint: Option<String>,
    /// The key is missing over an existing pairing, or can never be opened
    /// again: the confirmed replacement is what repairs it.
    pub needs_re_pair: bool,
    /// The stored identity exists but the platform key store can no longer open
    /// it — the typed `Lost` class, never inferred from a message.
    pub lost: bool,
    /// `sync_state.re_pair_required` as stored.
    pub re_pair_required: bool,
    /// Why the identity is unusable, in the words the panel shows.
    pub note: Option<String>,
}

/// Report the identity without minting anything, so the panel can offer the
/// confirmed re-pair instead of a dead end (N2).
#[tauri::command]
pub async fn pairing_identity_status(app: tauri::AppHandle) -> CmdResult<PairingIdentityStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        let db_state = app
            .try_state::<AppState>()
            .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
        let (history, flagged) = {
            let conn = lock_conn(&db_state)?;
            (pairing_history(&conn)?, re_pair_required(&conn)?)
        };
        match pairing_key::inspect(history) {
            Ok(stored) => Ok(PairingIdentityStatus {
                present: stored.is_some(),
                public_key: stored.as_ref().map(|identity| identity.public_key_hex()),
                fingerprint: stored.as_ref().map(|identity| identity.fingerprint()),
                needs_re_pair: flagged,
                lost: false,
                re_pair_required: flagged,
                note: None,
            }),
            Err(error) => Ok(PairingIdentityStatus {
                present: false,
                public_key: None,
                fingerprint: None,
                needs_re_pair: error.needs_re_pair_flag() || flagged,
                lost: matches!(error, crate::pairing_key::PairingKeyError::Lost(_)),
                re_pair_required: flagged,
                note: Some(error.message().to_string()),
            }),
        }
    })
    .await
    .map_err(|e| Refusal::from(e.to_string()))?
}

/// What the phone needs from the scanned offer to reach the desktop (§11.1).
/// The device id, schema and protocol come from this device in Rust; the
/// webview supplies only what the code itself carried, and no data line (D1).
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingPhoneInput {
    pub endpoint: String,
    pub pairing_id: String,
    pub public_key: String,
    pub code: String,
}

/// The desktop's authoritative facts, opened from its sealed ack (§11.6.1).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhonePairResult {
    pub desktop_device_id: String,
    pub desktop_public_key: String,
    pub desktop_fingerprint: String,
    pub pairing_id: String,
    pub generation: u64,
    pub schema_version: u64,
    pub protocol_version: u64,
}

/// Pair this phone with the desktop whose offer was scanned (§11.1, §11.6.1).
///
/// The whole handshake happens in Rust because the long-term key does: the
/// webview never sees the secret (§11.2). Nothing is written here — the pin is
/// the caller's `sync_peers` write, made only after this returns, i.e. only
/// after the sealed hello proved this phone holds the key it presented (wave 1
/// N1, mirrored on the phone).
#[tauri::command]
pub fn pairing_phone_pair(
    app: tauri::AppHandle,
    input: PairingPhoneInput,
) -> CmdResult<PhonePairResult> {
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let (device_id, _generation, schema_version) = local_sync_facts(&db_state)?;
    let identity = load_pairing_identity(&db_state)?;
    let target = crate::pairing_client::PairingTarget {
        endpoint: &input.endpoint,
        pairing_id: &input.pairing_id,
        desktop_public_key: &input.public_key,
        code: &input.code,
    };
    let facts = crate::pairing_client::PhoneFacts {
        device_id: &device_id,
        protocol_version: PROTOCOL_VERSION,
        schema_version,
    };
    let ack = crate::pairing_client::request_pairing(&target, &facts, &identity)
        .map_err(|error| Refusal::from(error.to_string()))?;
    crate::pairing_client::send_hello(
        &target,
        &facts,
        &identity,
        &ack,
        crate::pairing_client::next_hello_counter(),
    )
    .map_err(|error| Refusal::from(error.to_string()))?;
    Ok(PhonePairResult {
        desktop_device_id: ack.desktop_device_id,
        desktop_fingerprint: pairing_key::fingerprint_of(&input.public_key),
        desktop_public_key: input.public_key,
        pairing_id: ack.pairing_id,
        generation: ack.generation,
        schema_version: ack.schema_version,
        protocol_version: ack.protocol_version,
    })
}

/// What the phone must name to pull: the pinned desktop, and the address the
/// offer carried. The key, the data line and the pairing id are the PIN's —
/// read in Rust from `sync_peers`, never taken from the caller (§11.2).
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotPullInput {
    pub endpoint: String,
    pub desktop_device_id: String,
}

/// One batch as the phone's UI receives it: still unvalidated, because
/// validation is `store.ts`'s (§8.4 — the payload is the desktop's document,
/// not this side's statement).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotBatchResult {
    /// The pairing the batch belongs to, echoed from the sealed document so the
    /// webview can refuse one that names another (§11.4) — the same check this
    /// side already made, made again where the rows are used.
    pub pairing_id: String,
    pub batch: u64,
    pub total: u64,
    pub ops: Vec<serde_json::Value>,
    pub tombstones: Vec<serde_json::Value>,
}

/// The pinned desktop's facts for one pull.
struct PinnedPull {
    pairing_id: String,
    public_key: String,
    generation: u64,
}

/// Read the pin, refusing an unpinned or revoked desktop before any socket
/// exists. This is what stops the webview from naming a peer that was never
/// proven: it supplies an address, never a key.
fn pinned_pull(db_state: &AppState, device_id: &str) -> CmdResult<PinnedPull> {
    let conn = lock_conn(db_state)?;
    let mut statement = conn
        .prepare(
            "SELECT pairing_id, public_key, generation FROM sync_peers \
             WHERE device_id = ? AND revoked_at IS NULL",
        )
        .map_err(|error| Refusal::from(error.to_string()))?;
    let mut rows = statement
        .query([device_id])
        .map_err(|error| Refusal::from(error.to_string()))?;
    let Some(row) = rows
        .next()
        .map_err(|error| Refusal::from(error.to_string()))?
    else {
        return Err(Refusal::new("rust.error.notPinned"));
    };
    let pairing_id: Option<String> = row
        .get(0)
        .map_err(|error| Refusal::from(error.to_string()))?;
    let public_key: Option<String> = row
        .get(1)
        .map_err(|error| Refusal::from(error.to_string()))?;
    // `sync_peers.generation` is a SQLite INTEGER: i64 in, u64 out.
    let generation: i64 = row
        .get(2)
        .map_err(|error| Refusal::from(error.to_string()))?;
    let generation = u64::try_from(generation).unwrap_or(0);
    let pairing_id = pairing_id
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Refusal::new("rust.error.pinPredatesPairing"))?;
    let public_key = public_key
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "that pin carries no desktop key, so it cannot be pulled from (§11.2).".to_string()
        })?;
    Ok(PinnedPull {
        pairing_id,
        public_key,
        generation,
    })
}

/// Request one batch of the §8.4 snapshot.
///
/// The sealed exchange runs in Rust because the phone's key does (§11.2): the
/// webview receives rows, never ciphertext and never the secret. Nothing is
/// written — what the phone does with a batch is its own one transaction, at
/// the end.
#[tauri::command]
pub fn pairing_snapshot_request(
    app: tauri::AppHandle,
    input: SnapshotPullInput,
    batch: u64,
) -> CmdResult<SnapshotBatchResult> {
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let (device_id, _generation, schema_version) = local_sync_facts(&db_state)?;
    let pin = pinned_pull(&db_state, &input.desktop_device_id)?;
    let identity = load_pairing_identity(&db_state)?;
    let pull = crate::pairing_client::SnapshotPull {
        endpoint: &input.endpoint,
        pairing_id: &pin.pairing_id,
        desktop_public_key: &pin.public_key,
        desktop_device_id: &input.desktop_device_id,
        generation: pin.generation,
    };
    let facts = crate::pairing_client::PhoneFacts {
        device_id: &device_id,
        protocol_version: PROTOCOL_VERSION,
        schema_version,
    };
    let reply = crate::pairing_client::request_snapshot(
        &pull,
        &facts,
        &identity,
        crate::pairing_client::process_counters(),
        batch,
    )
    .map_err(|error| Refusal::from(error.to_string()))?;
    let list = |key: &str| {
        reply
            .get(key)
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default()
    };
    Ok(SnapshotBatchResult {
        pairing_id: pin.pairing_id.clone(),
        batch,
        total: reply
            .get("total")
            .and_then(|value| value.as_u64())
            .unwrap_or(1),
        ops: list("ops"),
        tombstones: list("tombstones"),
    })
}

/// Acknowledge one staged batch. The desktop keeps the bookkeeping; the phone
/// has still applied nothing (§8.4).
#[tauri::command]
pub fn pairing_snapshot_applied(
    app: tauri::AppHandle,
    input: SnapshotPullInput,
    batch: u64,
) -> CmdResult<()> {
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let (device_id, _generation, schema_version) = local_sync_facts(&db_state)?;
    let pin = pinned_pull(&db_state, &input.desktop_device_id)?;
    let identity = load_pairing_identity(&db_state)?;
    let pull = crate::pairing_client::SnapshotPull {
        endpoint: &input.endpoint,
        pairing_id: &pin.pairing_id,
        desktop_public_key: &pin.public_key,
        desktop_device_id: &input.desktop_device_id,
        generation: pin.generation,
    };
    let facts = crate::pairing_client::PhoneFacts {
        device_id: &device_id,
        protocol_version: PROTOCOL_VERSION,
        schema_version,
    };
    crate::pairing_client::acknowledge_batch(
        &pull,
        &facts,
        &identity,
        crate::pairing_client::process_counters(),
        batch,
    )
    .map_err(|error| Refusal::from(error.to_string()))
}

/// Acknowledge the whole snapshot, with the counts the §9.3 summary shows.
///
/// This is the only message that closes a pull, and the desktop refuses it
/// unless every batch was acknowledged: the phone must not be able to call a
/// partly-received snapshot adopted (§8.4).
#[tauri::command]
pub fn pairing_snapshot_adopted(
    app: tauri::AppHandle,
    input: SnapshotPullInput,
    rows: u64,
    tombstones: u64,
) -> CmdResult<()> {
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let (device_id, _generation, schema_version) = local_sync_facts(&db_state)?;
    let pin = pinned_pull(&db_state, &input.desktop_device_id)?;
    let identity = load_pairing_identity(&db_state)?;
    let pull = crate::pairing_client::SnapshotPull {
        endpoint: &input.endpoint,
        pairing_id: &pin.pairing_id,
        desktop_public_key: &pin.public_key,
        desktop_device_id: &input.desktop_device_id,
        generation: pin.generation,
    };
    let facts = crate::pairing_client::PhoneFacts {
        device_id: &device_id,
        protocol_version: PROTOCOL_VERSION,
        schema_version,
    };
    crate::pairing_client::acknowledge_snapshot(
        &pull,
        &facts,
        &identity,
        crate::pairing_client::process_counters(),
        rows,
        tombstones,
    )
    .map_err(|error| Refusal::from(error.to_string()))
}

/// Send one batch of this phone's own records to the pinned desktop (§9.1).
///
/// The sealed exchange runs in Rust for the same reason the pull's does
/// (§11.2): the webview hands over rows, never ciphertext and never the
/// secret. The desktop only stages the batch — its panel applies the whole
/// upload in one transaction after the commit.
#[tauri::command]
pub fn pairing_upload_batch(
    app: tauri::AppHandle,
    input: SnapshotPullInput,
    batch: u64,
    total: u64,
    ops: Vec<serde_json::Value>,
) -> CmdResult<()> {
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let (device_id, _generation, schema_version) = local_sync_facts(&db_state)?;
    let pin = pinned_pull(&db_state, &input.desktop_device_id)?;
    let identity = load_pairing_identity(&db_state)?;
    let pull = crate::pairing_client::SnapshotPull {
        endpoint: &input.endpoint,
        pairing_id: &pin.pairing_id,
        desktop_public_key: &pin.public_key,
        desktop_device_id: &input.desktop_device_id,
        generation: pin.generation,
    };
    let facts = crate::pairing_client::PhoneFacts {
        device_id: &device_id,
        protocol_version: PROTOCOL_VERSION,
        schema_version,
    };
    crate::pairing_client::send_upload_batch(
        &pull,
        &facts,
        &identity,
        crate::pairing_client::process_counters(),
        batch,
        total,
        &ops,
    )
    .map_err(|error| Refusal::from(error.to_string()))
}

/// Tell the pinned desktop every upload batch was sent (§9.1). It refuses
/// unless all of them are staged, so a resolved commit means the desktop
/// holds the whole upload — staged for its panel's one applying transaction.
#[tauri::command]
pub fn pairing_upload_commit(app: tauri::AppHandle, input: SnapshotPullInput) -> CmdResult<()> {
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let (device_id, _generation, schema_version) = local_sync_facts(&db_state)?;
    let pin = pinned_pull(&db_state, &input.desktop_device_id)?;
    let identity = load_pairing_identity(&db_state)?;
    let pull = crate::pairing_client::SnapshotPull {
        endpoint: &input.endpoint,
        pairing_id: &pin.pairing_id,
        desktop_public_key: &pin.public_key,
        desktop_device_id: &input.desktop_device_id,
        generation: pin.generation,
    };
    let facts = crate::pairing_client::PhoneFacts {
        device_id: &device_id,
        protocol_version: PROTOCOL_VERSION,
        schema_version,
    };
    crate::pairing_client::send_upload_commit(
        &pull,
        &facts,
        &identity,
        crate::pairing_client::process_counters(),
    )
    .map_err(|error| Refusal::from(error.to_string()))
}

/// The desktop's verdict on this phone's upload (§9.1), as the sealed reply
/// reported it: `pending` until its panel's apply decides, then `uploaded`
/// with the counts, or `failed` with the apply's reason.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadStatusResult {
    pub state: String,
    pub inserted: u64,
    pub already_known: u64,
    pub message: Option<String>,
}

#[tauri::command]
pub async fn pairing_upload_status(
    app: tauri::AppHandle,
    input: SnapshotPullInput,
) -> CmdResult<UploadStatusResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let db_state = app
            .try_state::<AppState>()
            .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
        let (device_id, _generation, schema_version) = local_sync_facts(&db_state)?;
        let pin = pinned_pull(&db_state, &input.desktop_device_id)?;
        let identity = load_pairing_identity(&db_state)?;
        let pull = crate::pairing_client::SnapshotPull {
            endpoint: &input.endpoint,
            pairing_id: &pin.pairing_id,
            desktop_public_key: &pin.public_key,
            desktop_device_id: &input.desktop_device_id,
            generation: pin.generation,
        };
        let facts = crate::pairing_client::PhoneFacts {
            device_id: &device_id,
            protocol_version: PROTOCOL_VERSION,
            schema_version,
        };
        let reply = crate::pairing_client::poll_upload_status(
            &pull,
            &facts,
            &identity,
            crate::pairing_client::process_counters(),
        )
        .map_err(|error| Refusal::from(error.to_string()))?;
        let number = |key: &str| reply.get(key).and_then(|value| value.as_u64()).unwrap_or(0);
        Ok(UploadStatusResult {
            state: reply
                .get("state")
                .and_then(|value| value.as_str())
                .unwrap_or("pending")
                .to_string(),
            inserted: number("inserted"),
            already_known: number("alreadyKnown"),
            message: reply
                .get("message")
                .and_then(|value| value.as_str())
                .map(str::to_string),
        })
    })
    .await
    .map_err(|e| Refusal::from(e.to_string()))?
}

/// The staged upload the desktop panel applies (§9.1): the pairing it belongs
/// to and every op the phone committed, as wire documents. `None` until a
/// phone commits a complete upload in this window.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadTakeResult {
    pub pairing_id: String,
    pub ops: Vec<serde_json::Value>,
}

/// Take the staged §9.1 upload for the panel's apply. Taking is once: a
/// second call returns `None`, so the same staging can never be applied
/// twice by two ticks racing (§7.2). Nothing is written here — the apply is
/// the caller's one `sync_peers`-style transaction over the app database.
#[tauri::command]
pub fn pairing_upload_take(
    state: State<'_, PairingListenerState>,
) -> CmdResult<Option<UploadTakeResult>> {
    Ok(state
        .take_upload()
        .map(|(pairing_id, ops)| UploadTakeResult { pairing_id, ops }))
}

/// What the panel's apply decided (§9.1): either the counts of a committed
/// transaction, or the failure's reason. Exactly one of the two shapes —
/// `inserted`/`alreadyKnown` together, or `error` alone.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadOutcomeInput {
    pub inserted: Option<u64>,
    pub already_known: Option<u64>,
    pub error: Option<String>,
}

/// Report the panel's apply outcome, so the listener can seal the verdict to
/// the phone. The first outcome stands; reporting twice changes nothing.
#[tauri::command]
pub fn pairing_upload_outcome(
    state: State<'_, PairingListenerState>,
    input: UploadOutcomeInput,
) -> CmdResult<()> {
    let outcome = match (input.inserted, input.already_known, input.error) {
        (Some(inserted), Some(already_known), None) => {
            crate::pairing_listener::UploadOutcome::Applied {
                inserted,
                already_known,
            }
        }
        (None, None, Some(message)) => crate::pairing_listener::UploadOutcome::Failed { message },
        _ => return Err(Refusal::new("rust.error.uploadOutcome")),
    };
    state.set_upload_outcome(outcome);
    Ok(())
}

/// The phone's facts for one §6 exchange, read once: its own id and schema from
/// the database, and the pin's key, pairing id and data line — never from the
/// webview, which supplies an address only.
struct SyncPhoneFacts {
    device_id: String,
    pairing_id: String,
    desktop_public_key: String,
    generation: u64,
    schema_version: u64,
}

fn sync_phone_facts(
    app: &tauri::AppHandle,
    input: &SnapshotPullInput,
) -> CmdResult<SyncPhoneFacts> {
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let (device_id, _generation, schema_version) = local_sync_facts(&db_state)?;
    let pin = pinned_pull(&db_state, &input.desktop_device_id)?;
    Ok(SyncPhoneFacts {
        device_id,
        pairing_id: pin.pairing_id,
        desktop_public_key: pin.public_key,
        generation: pin.generation,
        schema_version,
    })
}

/// Send one batch of this phone's operations to the pinned desktop (§6.2). The
/// sealed exchange runs in Rust because the phone's key does (§11.2).
#[tauri::command]
pub fn pairing_sync_push(
    app: tauri::AppHandle,
    input: SnapshotPullInput,
    batch: u64,
    total: u64,
    ops: Vec<serde_json::Value>,
) -> CmdResult<()> {
    let facts = sync_phone_facts(&app, &input)?;
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let identity = load_pairing_identity(&db_state)?;
    let pull = crate::pairing_client::SnapshotPull {
        endpoint: &input.endpoint,
        pairing_id: &facts.pairing_id,
        desktop_public_key: &facts.desktop_public_key,
        desktop_device_id: &input.desktop_device_id,
        generation: facts.generation,
    };
    let phone = crate::pairing_client::PhoneFacts {
        device_id: &facts.device_id,
        protocol_version: PROTOCOL_VERSION,
        schema_version: facts.schema_version,
    };
    crate::pairing_client::send_sync_push(
        &pull,
        &phone,
        &identity,
        crate::pairing_client::process_counters(),
        batch,
        total,
        &ops,
    )
    .map_err(|error| Refusal::from(error.to_string()))
}

/// Tell the pinned desktop every pushed batch was sent (§6.2).
#[tauri::command]
pub fn pairing_sync_commit(app: tauri::AppHandle, input: SnapshotPullInput) -> CmdResult<()> {
    let facts = sync_phone_facts(&app, &input)?;
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let identity = load_pairing_identity(&db_state)?;
    let pull = crate::pairing_client::SnapshotPull {
        endpoint: &input.endpoint,
        pairing_id: &facts.pairing_id,
        desktop_public_key: &facts.desktop_public_key,
        desktop_device_id: &input.desktop_device_id,
        generation: facts.generation,
    };
    let phone = crate::pairing_client::PhoneFacts {
        device_id: &facts.device_id,
        protocol_version: PROTOCOL_VERSION,
        schema_version: facts.schema_version,
    };
    crate::pairing_client::send_sync_commit(
        &pull,
        &phone,
        &identity,
        crate::pairing_client::process_counters(),
    )
    .map_err(|error| Refusal::from(error.to_string()))
}

/// One batch of the pinned desktop's own operations after `afterSeq` (§6.3).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBatchResult {
    pub pairing_id: String,
    pub batch: u64,
    pub total: u64,
    pub ops: Vec<serde_json::Value>,
}

#[tauri::command]
pub fn pairing_sync_pull(
    app: tauri::AppHandle,
    input: SnapshotPullInput,
    batch: u64,
    after_seq: u64,
) -> CmdResult<SyncBatchResult> {
    let facts = sync_phone_facts(&app, &input)?;
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let identity = load_pairing_identity(&db_state)?;
    let pull = crate::pairing_client::SnapshotPull {
        endpoint: &input.endpoint,
        pairing_id: &facts.pairing_id,
        desktop_public_key: &facts.desktop_public_key,
        desktop_device_id: &input.desktop_device_id,
        generation: facts.generation,
    };
    let phone = crate::pairing_client::PhoneFacts {
        device_id: &facts.device_id,
        protocol_version: PROTOCOL_VERSION,
        schema_version: facts.schema_version,
    };
    let reply = crate::pairing_client::pull_sync_ops(
        &pull,
        &phone,
        &identity,
        crate::pairing_client::process_counters(),
        batch,
        after_seq,
    )
    .map_err(|error| Refusal::from(error.to_string()))?;
    Ok(SyncBatchResult {
        pairing_id: facts.pairing_id,
        batch,
        total: reply
            .get("total")
            .and_then(|value| value.as_u64())
            .unwrap_or(1),
        ops: reply
            .get("ops")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default(),
    })
}

/// Report that this phone applied the desktop's operations through `throughSeq`
/// (§6.5).
#[tauri::command]
pub fn pairing_sync_applied(
    app: tauri::AppHandle,
    input: SnapshotPullInput,
    through_seq: u64,
) -> CmdResult<()> {
    let facts = sync_phone_facts(&app, &input)?;
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let identity = load_pairing_identity(&db_state)?;
    let pull = crate::pairing_client::SnapshotPull {
        endpoint: &input.endpoint,
        pairing_id: &facts.pairing_id,
        desktop_public_key: &facts.desktop_public_key,
        desktop_device_id: &input.desktop_device_id,
        generation: facts.generation,
    };
    let phone = crate::pairing_client::PhoneFacts {
        device_id: &facts.device_id,
        protocol_version: PROTOCOL_VERSION,
        schema_version: facts.schema_version,
    };
    crate::pairing_client::send_sync_applied(
        &pull,
        &phone,
        &identity,
        crate::pairing_client::process_counters(),
        through_seq,
    )
    .map_err(|error| Refusal::from(error.to_string()))
}

/// The desktop's verdict on this phone's push, as its sealed reply reported it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusResult {
    pub state: String,
    pub through_seq: u64,
    pub message: Option<String>,
}

#[tauri::command]
pub async fn pairing_sync_status(
    app: tauri::AppHandle,
    input: SnapshotPullInput,
) -> CmdResult<SyncStatusResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let facts = sync_phone_facts(&app, &input)?;
        let db_state = app
            .try_state::<AppState>()
            .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
        let identity = load_pairing_identity(&db_state)?;
        let pull = crate::pairing_client::SnapshotPull {
            endpoint: &input.endpoint,
            pairing_id: &facts.pairing_id,
            desktop_public_key: &facts.desktop_public_key,
            desktop_device_id: &input.desktop_device_id,
            generation: facts.generation,
        };
        let phone = crate::pairing_client::PhoneFacts {
            device_id: &facts.device_id,
            protocol_version: PROTOCOL_VERSION,
            schema_version: facts.schema_version,
        };
        let reply = crate::pairing_client::poll_sync_status(
            &pull,
            &phone,
            &identity,
            crate::pairing_client::process_counters(),
        )
        .map_err(|error| Refusal::from(error.to_string()))?;
        Ok(SyncStatusResult {
            state: reply
                .get("state")
                .and_then(|value| value.as_str())
                .unwrap_or("pending")
                .to_string(),
            through_seq: reply
                .get("throughSeq")
                .and_then(|value| value.as_u64())
                .unwrap_or(0),
            message: reply
                .get("message")
                .and_then(|value| value.as_str())
                .map(str::to_string),
        })
    })
    .await
    .map_err(|e| Refusal::from(e.to_string()))?
}

/// The staged §6 push the desktop panel applies: the operations as wire
/// documents. `None` until a phone commits a complete push in this window.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTakeResult {
    pub ops: Vec<serde_json::Value>,
}

#[tauri::command]
pub fn pairing_sync_take(
    state: State<'_, PairingListenerState>,
) -> CmdResult<Option<SyncTakeResult>> {
    refuse_mobile_role()?;
    Ok(state.take_sync_push().map(|ops| SyncTakeResult { ops }))
}

/// What the panel's engine decided about a staged push: the highest seq it
/// applied, or the refusal's own words. Exactly one of the two.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcomeInput {
    pub applied_through: Option<u64>,
    pub error: Option<String>,
}

#[tauri::command]
pub fn pairing_sync_outcome(
    state: State<'_, PairingListenerState>,
    input: SyncOutcomeInput,
) -> CmdResult<()> {
    refuse_mobile_role()?;
    let outcome = match (input.applied_through, input.error) {
        (Some(through_seq), None) => crate::pairing_listener::SyncOutcome::Applied { through_seq },
        (None, Some(message)) => crate::pairing_listener::SyncOutcome::Failed { message },
        _ => return Err(Refusal::new("rust.error.syncOutcome")),
    };
    state.set_sync_outcome(outcome);
    Ok(())
}

/// Mint a fresh pairing identity after an explicit confirmation (§11.4, N2).
///
/// Deletes only `Slot::PairingIdentity`: local notes, tasks and the database key
/// are untouched, so this is re-pairing, not a factory reset. The flag is set
/// because every peer's pin names the old key, so each peer pairs again.
#[tauri::command]
pub fn pairing_identity_replace(
    app: tauri::AppHandle,
    confirm: bool,
) -> CmdResult<PairingIdentityStatus> {
    if !confirm {
        return Err(Refusal::new("rust.error.rePairConfirm"));
    }
    let db_state = app
        .try_state::<AppState>()
        .ok_or_else(|| Refusal::new("rust.error.stateUnavailable"))?;
    let identity = pairing_key::replace_after_confirmation().map_err(|error| {
        Refusal::new("rust.error.pairingIdentity").with("detail", error.message())
    })?;
    {
        let conn = lock_conn(&db_state)?;
        mark_re_pair_required(&conn)?;
    }
    Ok(PairingIdentityStatus {
        present: true,
        public_key: Some(identity.public_key_hex()),
        fingerprint: Some(identity.fingerprint()),
        needs_re_pair: true,
        lost: false,
        re_pair_required: true,
        note: None,
    })
}

#[cfg(test)]
mod tests {
    use super::{mark_re_pair_required, pairing_history, re_pair_required};
    use crate::commands::lock_conn;
    use crate::commands::tests::{
        assert_async_one, assert_async_two, assert_dispatches_off_the_main_thread,
    };

    /// B3 part 2: the pairing status reads. Same two halves as the DB pin, so
    /// no edit can quietly move one of them back onto the main thread.
    #[test]
    fn the_pairing_status_commands_run_off_the_main_thread() {
        assert_async_one::<tauri::AppHandle, _>(super::pairing_status);
        assert_async_one::<tauri::AppHandle, _>(super::pairing_identity_status);
        assert_async_two::<tauri::AppHandle, super::SnapshotPullInput, _>(
            super::pairing_upload_status,
        );
        assert_async_two::<tauri::AppHandle, super::SnapshotPullInput, _>(
            super::pairing_sync_status,
        );

        for name in [
            "pairing_status",
            "pairing_identity_status",
            "pairing_upload_status",
            "pairing_sync_status",
        ] {
            assert_dispatches_off_the_main_thread(name);
        }
    }

    /// A database just far enough along to answer the pairing-history question:
    /// `sync_state` with its flag, and `sync_peers` with `pins` devices pinned.
    fn pairing_db(pins: usize) -> crate::db::AppState {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(
            "CREATE TABLE sync_state (
                 id INTEGER PRIMARY KEY CHECK (id = 1),
                 re_pair_required INTEGER NOT NULL DEFAULT 0,
                 updated_at TEXT NOT NULL
             );
             INSERT INTO sync_state (id, re_pair_required, updated_at)
                 VALUES (1, 0, '2026-01-01T00:00:00Z');
             CREATE TABLE sync_peers (device_id TEXT PRIMARY KEY);",
        )
        .expect("schema");
        for index in 0..pins {
            conn.execute(
                "INSERT INTO sync_peers (device_id) VALUES (?1)",
                [format!("peers-{index}")],
            )
            .expect("pin");
        }
        crate::db::AppState {
            conn: std::sync::Mutex::new(Some(conn)),
            txn_open: std::sync::atomic::AtomicBool::new(false),
            reset_terminal: std::sync::atomic::AtomicBool::new(false),
            data_dir: std::path::PathBuf::from("unused"),
        }
    }

    /// §11.2 (N2): the fail-closed decision needs one database fact — has this
    /// install ever paired — and a pin is what says so.
    #[test]
    fn the_pairing_history_is_whether_a_pin_exists() {
        let fresh = pairing_db(0);
        let conn = lock_conn(&fresh).expect("conn");
        assert_eq!(
            pairing_history(&conn).expect("history"),
            crate::pairing_key::PairingHistory::Never
        );
        drop(conn);

        let paired = pairing_db(1);
        let conn = lock_conn(&paired).expect("conn");
        assert_eq!(
            pairing_history(&conn).expect("history"),
            crate::pairing_key::PairingHistory::Paired,
            "one pin is enough to make a missing key key loss"
        );
    }

    /// The flag is what the panel reads to offer the confirmed re-pair, and
    /// recording it must move nothing else (notes and tasks stay readable).
    #[test]
    fn recording_a_required_re_pair_moves_only_the_flag() {
        let state = pairing_db(1);
        let conn = lock_conn(&state).expect("conn");
        assert!(!re_pair_required(&conn).expect("flag"));
        mark_re_pair_required(&conn).expect("mark");
        assert!(re_pair_required(&conn).expect("flag"));
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_state", [], |row| row.get(0))
            .expect("state rows");
        let peers: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_peers", [], |row| row.get(0))
            .expect("peer rows");
        assert_eq!((rows, peers), (1, 1), "only the flag may change");
    }
}
