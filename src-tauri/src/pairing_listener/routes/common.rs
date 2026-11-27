//! The admission checks every route shares (§7.1): revoked first, then
//! unpaired, then the envelope, then the payload. They live in one module
//! because a second copy of them is how one route quietly loses one (N5).

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value as JsonValue;

use crate::envelope::{self, OpenInput, Opened, KEY_BYTES};

use super::super::{decode_frame, Gate, Pin, RefusalReply};

/// §11.1: digits only, six of them. Spaces and dashes are typing conveniences,
/// exactly as `normalizeCode` in `src/lib/sync/pairing.ts` treats them.
pub(crate) fn normalize_code(input: &str) -> Option<String> {
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
pub(crate) fn canonical_device_id(input: &str) -> bool {
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
pub(crate) fn usable_public_key(input: &str) -> Option<[u8; KEY_BYTES]> {
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
pub(crate) fn codes_equal(a: &str, b: &str) -> bool {
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

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// The pin in force: the peer this window's code pinned, else the one the
/// window was opened with.
pub(crate) fn active_pin(gate: &Gate) -> Option<Pin> {
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

/// §7.1's order, from the pin to the accepted message.
///
/// The hello and snapshot routes share every check, so they share this
/// function: `accepted` is the one thing that differs, and a second copy of
/// these checks is how one route quietly loses one of them (N5).
pub(crate) fn admit(
    gate: &Gate,
    body: &[u8],
    accepted: &[&str],
) -> Result<(Pin, Opened), RefusalReply> {
    let Some(pin) = active_pin(gate) else {
        return Err(RefusalReply::refused(
            "unpaired",
            "this device has never paired; show a pairing code on the desktop first (§11.2).",
        ));
    };
    // §1.2: a device cannot pair with itself. A pin naming this device is not a
    // pairing, so its hello is refused before any envelope is opened (N9).
    if pin.device_id == gate.local_device_id {
        return Err(RefusalReply::refused(
            "same-device",
            "a device cannot pair with itself.",
        ));
    }
    let text = decode_frame(body).map_err(RefusalReply::malformed)?;
    let mut last_counter = gate.last_counter.lock().unwrap_or_else(|e| e.into_inner());
    let opened = envelope::open(OpenInput {
        secret: &gate.local_secret,
        peer_public: &pin.public_key,
        local_device_id: &gate.local_device_id,
        expected_from: &pin.device_id,
        last_counter: *last_counter,
        // §11.6.1's HKDF salt and info: the key is bound to this pairing.
        pairing_id: Some(gate.pairing_id.as_str()),
        raw: &text,
    })
    .map_err(RefusalReply::from_envelope)?;

    // §2.3's server-side seam: a route speaks only the kinds it serves.
    let kind = opened
        .message
        .get("kind")
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    if !accepted.contains(&kind) {
        return Err(RefusalReply::refused(
            "not-allowed",
            format!(
                "this endpoint accepts only {}; {kind:?} is not one of them (§2.3).",
                accepted.join(", ")
            ),
        ));
    }

    let number = |key: &str| opened.message.get(key).and_then(JsonValue::as_u64);
    // §11.6.1: the check is unconditional — the window's pairing id is required,
    // so a hello that claims none is a mismatch, not a check that is skipped
    // (N9).
    let presented = opened.message.get("pairingId").and_then(JsonValue::as_str);
    if presented != Some(gate.pairing_id.as_str()) {
        return Err(RefusalReply::refused(
            "pairing-mismatch",
            "this hello belongs to a different pairing; re-pair this phone (§11.4).",
        ));
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

    // Accepted. The counter advance is the one effect an admitted message has,
    // and it is what makes a second copy of the same envelope a replay.
    //
    // §7.2 across restarts: raise the device-local floor FIRST, while still
    // under the same lock that derives `last_counter`. Acting on an envelope
    // the floor cannot record would leave the disk below this envelope after
    // a restart, and the next window would honour it again. A floor that
    // cannot be written refuses the admission outright; the window's
    // in-memory counter does not move either.
    let floor = opened.header.counter;
    if let Err(reason) = crate::pairing_listener::raise_counter_floor(&gate.pairing_id, floor) {
        return Err(RefusalReply::refused(
            "replay-floor",
            format!(
                "the envelope was not accepted because the anti-replay record \
                 could not be saved ({reason}); try again once the disk frees up"
            ),
        ));
    }
    *last_counter = floor;
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

    Ok((pin, opened))
}
