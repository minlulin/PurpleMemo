//! The sealed envelope — protocol §11.6.1 (Phase C Session 5, ephemeral
//! rework in Session 5b).
//!
//! The Rust half of one wire format; `src/lib/sync/envelope.ts` is the
//! TypeScript half. Both sides are proved against each other's bytes:
//! `src/lib/sync/__fixtures__/envelope-from-ts.json` is ciphertext produced by
//! the TypeScript implementation and opened here, and
//! `envelope-from-rust.json` is produced here and opened by the TypeScript
//! tests. A one-sided implementation is not a proof.
//!
//! **The construction (§11.6.1, as built).**
//!
//! ```text
//! header    = {"v":1,"from":<id>,"to":<id>,"messageId":<id>,"counter":<n>,
//!              "nonce":<48 hex>,"eph":<64 hex>}
//! dh_eph    = X25519(ephemeral_secret, receiver_long_public)   // fresh per message
//! dh_static = X25519(sender_long_secret, receiver_long_public)
//! salt      = pairing id bytes          (32 zero bytes only when there is none)
//! info      = "purple-memo-envelope-v1" 0x00 from 0x00 to 0x00 pairingId
//! key       = HKDF-SHA256(ikm = dh_eph || dh_static, salt, info, 32)
//! sealed    = XChaCha20-Poly1305(key, nonce, aad = header_bytes).encrypt(json(message))
//! wire      = {"header":<header>,"body":"<hex sealed>"}
//! ```
//!
//! The sender mints a fresh ephemeral keypair per message and its public half
//! travels in the authenticated header, so a forged `eph` fails the AEAD tag
//! instead of being used. The long-term keys stay pinned (§11.2): a peer
//! without the pinned secret still cannot produce an openable envelope, and the
//! ephemeral half adds forward secrecy — the message key depends on a secret
//! the sender destroys after one message.
//!
//! Nothing here logs a key, and no secret is ever serialized: the wire carries
//! public values, a nonce and ciphertext only.

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

/// The envelope format version (§11.6.1 fixes v1). The header gained `eph` in
/// Session 5b; the version stays 1 because the wire shape, `{header, body}` with
/// the header as associated data, did not change.
pub const ENVELOPE_VERSION: u8 = 1;
pub const NONCE_BYTES: usize = 24;
pub const KEY_BYTES: usize = 32;

/// The fixed prefix of the HKDF `info` (§11.6.1). The rest binds the derived key
/// to one peer pair and one pairing.
pub const KDF_INFO_PREFIX: &str = "purple-memo-envelope-v1";

/// The authenticated routing header. Field order is part of the format — the
/// TypeScript side serializes the same fields in this order, and the bytes are
/// the AEAD's associated data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Header {
    pub v: u8,
    pub from: String,
    pub to: String,
    #[serde(rename = "messageId")]
    pub message_id: String,
    pub counter: u64,
    /// 24-byte nonce, lowercase hex.
    pub nonce: String,
    /// The sender's per-message ephemeral X25519 public key, lowercase hex.
    pub eph: String,
}

/// Why an envelope was refused. Each variant is a distinct, quotable reason so
/// a refusal can name itself instead of collapsing into "bad request".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    Malformed,
    WrongVersion(u8),
    WrongRecipient,
    WrongSender,
    Replayed,
    Unauthenticated,
}

impl Refusal {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::WrongVersion(_) => "wrong-version",
            Self::WrongRecipient => "wrong-recipient",
            Self::WrongSender => "wrong-sender",
            Self::Replayed => "replayed",
            Self::Unauthenticated => "unauthenticated",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::Malformed => "that is not a sealed envelope.".to_string(),
            Self::WrongVersion(v) => {
                format!("this build speaks envelope v{ENVELOPE_VERSION}; the peer sent v{v}.")
            }
            Self::WrongRecipient => "that envelope is addressed to another device.".to_string(),
            Self::WrongSender => "that envelope is not from the pinned peer (§11.2).".to_string(),
            Self::Replayed => {
                "that envelope was already accepted; envelopes are single-use (§7.2).".to_string()
            }
            Self::Unauthenticated => "that envelope failed authentication — it was altered, or \
                 it was not sealed under the pinned key."
                .to_string(),
        }
    }
}

/// Opened message: the authenticated header plus the parsed payload.
#[derive(Debug, Clone, PartialEq)]
pub struct Opened {
    pub header: Header,
    pub message: JsonValue,
}

pub fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

pub fn from_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = Vec::with_capacity(text.len() / 2);
    for index in (0..text.len()).step_by(2) {
        out.push(u8::from_str_radix(&text[index..index + 2], 16).ok()?);
    }
    Some(out)
}

/// The public half of a key. The secret is only ever read from the platform key
/// store (see `pairing_key.rs`) or, for an ephemeral key, from this call.
pub fn public_key(secret: &[u8; KEY_BYTES]) -> [u8; KEY_BYTES] {
    PublicKey::from(&StaticSecret::from(*secret)).to_bytes()
}

/// One X25519 agreement, or `None` for a low-order public key (an all-zero
/// secret every X25519 implementation warns about).
pub fn shared_key(
    secret: &[u8; KEY_BYTES],
    peer_public: &[u8; KEY_BYTES],
) -> Option<[u8; KEY_BYTES]> {
    let shared = StaticSecret::from(*secret).diffie_hellman(&PublicKey::from(*peer_public));
    let bytes = shared.to_bytes();
    if bytes.iter().all(|byte| *byte == 0) {
        return None;
    }
    Some(bytes)
}

/// The pairing id as HKDF salt. A flow with no pairing id salts with 32 zero
/// bytes: that is a defensive default only — `pairing_listener::start` refuses
/// to open a window without a pairing id, so no running pairing window ever
/// seals under this salt (N9).
fn kdf_salt(pairing_id: Option<&str>) -> Vec<u8> {
    match pairing_id {
        Some(id) => id.as_bytes().to_vec(),
        None => vec![0u8; KEY_BYTES],
    }
}

/// The HKDF `info`: a fixed prefix then the sender, receiver and pairing id,
/// each preceded by a NUL byte so the fields cannot be re-split ambiguously.
fn kdf_info(from: &str, to: &str, pairing_id: Option<&str>) -> Vec<u8> {
    let pairing = pairing_id.unwrap_or("");
    let mut info =
        Vec::with_capacity(KDF_INFO_PREFIX.len() + from.len() + to.len() + pairing.len() + 3);
    info.extend_from_slice(KDF_INFO_PREFIX.as_bytes());
    for field in [from, to, pairing] {
        info.push(0);
        info.extend_from_slice(field.as_bytes());
    }
    info
}

/// HKDF-SHA256 over `dh_eph || dh_static` (§11.6.1). A published KDF, used as
/// published: no combination of ours beyond the fixed input order.
fn combine_key(
    dh_eph: &[u8; KEY_BYTES],
    dh_static: &[u8; KEY_BYTES],
    from: &str,
    to: &str,
    pairing_id: Option<&str>,
) -> [u8; KEY_BYTES] {
    let mut ikm = [0u8; KEY_BYTES * 2];
    ikm[..KEY_BYTES].copy_from_slice(dh_eph);
    ikm[KEY_BYTES..].copy_from_slice(dh_static);
    let salt = kdf_salt(pairing_id);
    let hkdf = Hkdf::<Sha256>::new(Some(salt.as_slice()), &ikm);
    let mut key = [0u8; KEY_BYTES];
    hkdf.expand(&kdf_info(from, to, pairing_id), &mut key)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    key
}

/// The sender's message key: its ephemeral and its long-term agreement, both
/// against the receiver's long-term public key.
pub fn seal_key(
    sender_secret: &[u8; KEY_BYTES],
    receiver_public: &[u8; KEY_BYTES],
    ephemeral_secret: &[u8; KEY_BYTES],
    from: &str,
    to: &str,
    pairing_id: Option<&str>,
) -> Option<[u8; KEY_BYTES]> {
    let dh_eph = shared_key(ephemeral_secret, receiver_public)?;
    let dh_static = shared_key(sender_secret, receiver_public)?;
    Some(combine_key(&dh_eph, &dh_static, from, to, pairing_id))
}

/// The receiver's message key: the same two agreements taken from its side.
pub fn open_key(
    receiver_secret: &[u8; KEY_BYTES],
    sender_public: &[u8; KEY_BYTES],
    ephemeral_public: &[u8; KEY_BYTES],
    from: &str,
    to: &str,
    pairing_id: Option<&str>,
) -> Option<[u8; KEY_BYTES]> {
    let dh_eph = shared_key(receiver_secret, ephemeral_public)?;
    let dh_static = shared_key(receiver_secret, sender_public)?;
    Some(combine_key(&dh_eph, &dh_static, from, to, pairing_id))
}

/// The exact bytes both sides authenticate as associated data.
pub fn header_bytes(header: &Header) -> Result<Vec<u8>, Refusal> {
    serde_json::to_vec(header).map_err(|_| Refusal::Malformed)
}

pub struct SealInput<'a> {
    pub secret: &'a [u8; KEY_BYTES],
    pub peer_public: &'a [u8; KEY_BYTES],
    pub from: &'a str,
    pub to: &'a str,
    pub message_id: &'a str,
    pub counter: u64,
    pub message: &'a JsonValue,
    /// The pairing this message belongs to: the HKDF salt and part of its info.
    /// `None` is the documented zero-salt branch.
    pub pairing_id: Option<&'a str>,
    /// Supplied only by tests and cross-vectors; production uses the OS CSPRNG.
    pub nonce: Option<&'a [u8; NONCE_BYTES]>,
    /// Supplied only by tests and cross-vectors; production mints a fresh
    /// ephemeral keypair for every message.
    pub ephemeral_secret: Option<&'a [u8; KEY_BYTES]>,
}

/// Seal one message into the wire string.
pub fn seal(input: SealInput<'_>) -> Result<String, String> {
    let ephemeral_secret = match input.ephemeral_secret {
        Some(fixed) => *fixed,
        None => {
            // The OS CSPRNG, the same source the database key and the share page use.
            let mut fresh = [0u8; KEY_BYTES];
            getrandom::fill(&mut fresh).map_err(|e| format!("cannot read the OS RNG: {e}"))?;
            fresh
        }
    };
    let key = seal_key(
        input.secret,
        input.peer_public,
        &ephemeral_secret,
        input.from,
        input.to,
        input.pairing_id,
    )
    .ok_or_else(|| "peer public key is not a usable X25519 point".to_string())?;
    let nonce = match input.nonce {
        Some(fixed) => *fixed,
        None => {
            let mut fresh = [0u8; NONCE_BYTES];
            getrandom::fill(&mut fresh).map_err(|e| format!("cannot read the OS RNG: {e}"))?;
            fresh
        }
    };
    let header = Header {
        v: ENVELOPE_VERSION,
        from: input.from.to_string(),
        to: input.to.to_string(),
        message_id: input.message_id.to_string(),
        counter: input.counter,
        nonce: to_hex(&nonce),
        eph: to_hex(&public_key(&ephemeral_secret)),
    };
    let aad = header_bytes(&header).map_err(|_| "cannot encode the header".to_string())?;
    let plaintext =
        serde_json::to_vec(input.message).map_err(|e| format!("cannot encode the message: {e}"))?;
    let cipher = XChaCha20Poly1305::new((&key).into());
    let sealed = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| "sealing failed".to_string())?;
    let header_json = String::from_utf8(aad).map_err(|_| "header is not UTF-8".to_string())?;
    Ok(format!(
        "{{\"header\":{header_json},\"body\":\"{}\"}}",
        to_hex(&sealed)
    ))
}

pub struct OpenInput<'a> {
    pub secret: &'a [u8; KEY_BYTES],
    pub peer_public: &'a [u8; KEY_BYTES],
    pub local_device_id: &'a str,
    pub expected_from: &'a str,
    pub last_counter: u64,
    /// The pairing this message belongs to: the HKDF salt and part of its info.
    pub pairing_id: Option<&'a str>,
    pub raw: &'a str,
}

/// Open one message. Refusals are values, and every check happens before the
/// message is returned, so a caller can never act on a half-checked envelope.
pub fn open(input: OpenInput<'_>) -> Result<Opened, Refusal> {
    let parsed: JsonValue = serde_json::from_str(input.raw).map_err(|_| Refusal::Malformed)?;
    let body_hex = parsed
        .get("body")
        .and_then(JsonValue::as_str)
        .ok_or(Refusal::Malformed)?;
    let body = from_hex(body_hex).ok_or(Refusal::Malformed)?;
    let header: Header =
        serde_json::from_value(parsed.get("header").cloned().ok_or(Refusal::Malformed)?)
            .map_err(|_| Refusal::Malformed)?;
    let nonce = from_hex(&header.nonce).ok_or(Refusal::Malformed)?;
    if nonce.len() != NONCE_BYTES {
        return Err(Refusal::Malformed);
    }
    let ephemeral = from_hex(&header.eph).ok_or(Refusal::Malformed)?;
    if ephemeral.len() != KEY_BYTES {
        return Err(Refusal::Malformed);
    }
    let mut ephemeral_public = [0u8; KEY_BYTES];
    ephemeral_public.copy_from_slice(&ephemeral);
    if header.v != ENVELOPE_VERSION {
        return Err(Refusal::WrongVersion(header.v));
    }
    if header.to != input.local_device_id {
        return Err(Refusal::WrongRecipient);
    }
    if header.from != input.expected_from {
        return Err(Refusal::WrongSender);
    }
    if header.counter <= input.last_counter {
        return Err(Refusal::Replayed);
    }
    // A low-order point cannot take part in a sealed envelope, so it is
    // malformed rather than an authentication failure — there is no key to
    // authenticate with.
    let key = open_key(
        input.secret,
        input.peer_public,
        &ephemeral_public,
        &header.from,
        &header.to,
        input.pairing_id,
    )
    .ok_or(Refusal::Malformed)?;
    let aad = header_bytes(&header)?;
    let cipher = XChaCha20Poly1305::new((&key).into());
    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &body,
                aad: &aad,
            },
        )
        .map_err(|_| Refusal::Unauthenticated)?;
    let message = serde_json::from_slice(&plaintext).map_err(|_| Refusal::Malformed)?;
    Ok(Opened { header, message })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const DESKTOP: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const PHONE: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const PAIRING: &str = "pair-1";
    /// The fixed ephemeral secret the cross-vectors use, so both languages can
    /// reproduce the same ciphertext.
    const EPHEMERAL: [u8; KEY_BYTES] = [0x66u8; KEY_BYTES];

    fn keys() -> ([u8; KEY_BYTES], [u8; KEY_BYTES]) {
        let desktop = [0x11u8; KEY_BYTES];
        let phone = [0x22u8; KEY_BYTES];
        (desktop, phone)
    }

    fn sealed_between() -> (String, [u8; KEY_BYTES], [u8; KEY_BYTES]) {
        let (desktop_secret, phone_secret) = keys();
        let phone_public = public_key(&phone_secret);
        let wire = seal(SealInput {
            secret: &desktop_secret,
            peer_public: &phone_public,
            from: DESKTOP,
            to: PHONE,
            message_id: "msg-1",
            counter: 1,
            message: &json!({ "hello": "from rust", "n": 1 }),
            pairing_id: Some(PAIRING),
            nonce: Some(&[0x33u8; NONCE_BYTES]),
            ephemeral_secret: Some(&EPHEMERAL),
        })
        .expect("seal");
        (wire, desktop_secret, phone_secret)
    }

    fn open_wire(
        raw: &str,
        phone_secret: &[u8; KEY_BYTES],
        desktop_public: &[u8; KEY_BYTES],
    ) -> Result<Opened, Refusal> {
        open(OpenInput {
            secret: phone_secret,
            peer_public: desktop_public,
            local_device_id: PHONE,
            expected_from: DESKTOP,
            last_counter: 0,
            pairing_id: Some(PAIRING),
            raw,
        })
    }

    #[test]
    fn a_sealed_message_opens_on_the_other_side() {
        let (wire, desktop_secret, phone_secret) = sealed_between();
        let opened = open_wire(&wire, &phone_secret, &public_key(&desktop_secret)).expect("open");
        assert_eq!(opened.message, json!({ "hello": "from rust", "n": 1 }));
        assert_eq!(opened.header.from, DESKTOP);
        assert_eq!(opened.header.counter, 1);
        assert_eq!(
            opened.header.eph,
            to_hex(&public_key(&EPHEMERAL)),
            "the header carries the ephemeral public key the sender used"
        );
    }

    #[test]
    fn both_sides_derive_the_same_message_key() {
        // The sender's two agreements and the receiver's two agreements must
        // land on one 32-byte key — asserted, not assumed.
        let (desktop_secret, phone_secret) = keys();
        let phone_public = public_key(&phone_secret);
        let desktop_public = public_key(&desktop_secret);
        assert_eq!(
            seal_key(
                &desktop_secret,
                &phone_public,
                &EPHEMERAL,
                DESKTOP,
                PHONE,
                Some(PAIRING)
            ),
            open_key(
                &phone_secret,
                &desktop_public,
                &public_key(&EPHEMERAL),
                DESKTOP,
                PHONE,
                Some(PAIRING)
            ),
        );
    }

    /// The ephemeral half is what makes the key fresh: the same message, the
    /// same nonce and the same long-term keys still produce a different
    /// ciphertext once the ephemeral key changes, and both copies open.
    #[test]
    fn a_fresh_ephemeral_key_means_a_fresh_message_key() {
        let (desktop_secret, phone_secret) = keys();
        let phone_public = public_key(&phone_secret);
        let desktop_public = public_key(&desktop_secret);
        let message = json!({ "same": "message" });
        let seal_once = || {
            seal(SealInput {
                secret: &desktop_secret,
                peer_public: &phone_public,
                from: DESKTOP,
                to: PHONE,
                message_id: "msg-1",
                counter: 1,
                message: &message,
                pairing_id: Some(PAIRING),
                nonce: Some(&[0x33u8; NONCE_BYTES]),
                ephemeral_secret: None,
            })
            .expect("seal")
        };
        let first = seal_once();
        let second = seal_once();
        assert_ne!(first, second, "a reused key would repeat the ciphertext");
        for wire in [first, second] {
            assert_eq!(
                open_wire(&wire, &phone_secret, &desktop_public)
                    .expect("open")
                    .message,
                message
            );
        }
    }

    #[test]
    fn every_altered_part_of_an_envelope_is_refused() {
        let (wire, desktop_secret, phone_secret) = sealed_between();
        let desktop_public = public_key(&desktop_secret);
        let open_raw = |raw: &str| open_wire(raw, &phone_secret, &desktop_public);
        let parsed: JsonValue = serde_json::from_str(&wire).expect("json");
        let flip_last = |hex: &str| {
            let mut out = hex.to_string();
            let last = out.pop().expect("hex is not empty");
            out.push(if last == '0' { '1' } else { '0' });
            out
        };

        // Ciphertext.
        let mut tampered = parsed.clone();
        tampered["body"] = JsonValue::String(flip_last(parsed["body"].as_str().expect("body")));
        assert_eq!(
            open_raw(&tampered.to_string()),
            Err(Refusal::Unauthenticated)
        );

        // Header: the counter is inside the associated data.
        let mut counter_tamper = parsed.clone();
        counter_tamper["header"]["counter"] = json!(2);
        assert_eq!(
            open_raw(&counter_tamper.to_string()),
            Err(Refusal::Unauthenticated)
        );

        // Header: the nonce is both the AAD and the cipher's IV.
        let mut nonce_tamper = parsed.clone();
        nonce_tamper["header"]["nonce"] = JsonValue::String(flip_last(
            parsed["header"]["nonce"].as_str().expect("nonce"),
        ));
        assert!(open_raw(&nonce_tamper.to_string()).is_err());

        // Header: the ephemeral key is authenticated, and it feeds the HKDF —
        // so a forged one changes the key and fails the tag.
        let mut eph_tamper = parsed.clone();
        eph_tamper["header"]["eph"] =
            JsonValue::String(flip_last(parsed["header"]["eph"].as_str().expect("eph")));
        assert_eq!(
            open_raw(&eph_tamper.to_string()),
            Err(Refusal::Unauthenticated),
            "a forged ephemeral key must be refused, not used"
        );

        // A stranger's keypair addressing the same phone.
        let stranger = [0x44u8; KEY_BYTES];
        let forged = seal(SealInput {
            secret: &stranger,
            peer_public: &public_key(&phone_secret),
            from: DESKTOP,
            to: PHONE,
            message_id: "msg-9",
            counter: 1,
            message: &json!({ "forged": true }),
            pairing_id: Some(PAIRING),
            nonce: Some(&[0x55u8; NONCE_BYTES]),
            ephemeral_secret: Some(&EPHEMERAL),
        })
        .expect("seal");
        assert_eq!(open_raw(&forged), Err(Refusal::Unauthenticated));

        // Garbage, never a panic.
        assert_eq!(open_raw("not json"), Err(Refusal::Malformed));
        assert_eq!(
            open_raw("{\"header\":{},\"body\":\"\"}"),
            Err(Refusal::Malformed)
        );

        // An ephemeral key that is not a 32-byte hex key is malformed.
        let mut short_eph = parsed.clone();
        short_eph["header"]["eph"] = json!("0011");
        assert_eq!(open_raw(&short_eph.to_string()), Err(Refusal::Malformed));
    }

    #[test]
    fn a_replayed_foreign_or_misaddressed_envelope_is_refused() {
        let (wire, desktop_secret, phone_secret) = sealed_between();
        let desktop_public = public_key(&desktop_secret);

        let replayed = open(OpenInput {
            secret: &phone_secret,
            peer_public: &desktop_public,
            local_device_id: PHONE,
            expected_from: DESKTOP,
            last_counter: 1,
            pairing_id: Some(PAIRING),
            raw: &wire,
        });
        assert_eq!(replayed, Err(Refusal::Replayed));

        let foreign = open(OpenInput {
            secret: &phone_secret,
            peer_public: &desktop_public,
            local_device_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            expected_from: DESKTOP,
            last_counter: 0,
            pairing_id: Some(PAIRING),
            raw: &wire,
        });
        assert_eq!(foreign, Err(Refusal::WrongRecipient));

        let wrong_sender = open(OpenInput {
            secret: &phone_secret,
            peer_public: &desktop_public,
            local_device_id: PHONE,
            expected_from: PHONE,
            last_counter: 0,
            pairing_id: Some(PAIRING),
            raw: &wire,
        });
        assert_eq!(wrong_sender, Err(Refusal::WrongSender));
    }

    /// The pairing id is part of the derived key, so an envelope sealed for one
    /// pairing cannot be opened as another — the salt and the info differ.
    #[test]
    fn the_pairing_id_is_part_of_the_key() {
        let (wire, desktop_secret, phone_secret) = sealed_between();
        let other = open(OpenInput {
            secret: &phone_secret,
            peer_public: &public_key(&desktop_secret),
            local_device_id: PHONE,
            expected_from: DESKTOP,
            last_counter: 0,
            pairing_id: Some("pair-2"),
            raw: &wire,
        });
        assert_eq!(other, Err(Refusal::Unauthenticated));
    }

    /// Cross-language proof, this direction: ciphertext written by the
    /// TypeScript implementation (`src/lib/sync/envelope.ts`) opens here.
    #[test]
    fn an_envelope_written_by_the_typescript_side_opens_here() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/lib/sync/__fixtures__/envelope-from-ts.json"
        );
        let raw = std::fs::read_to_string(path).expect("the TypeScript vector exists");
        let fixture: JsonValue = serde_json::from_str(&raw).expect("vector json");
        let secret = from_hex(fixture["secret"].as_str().expect("secret")).expect("secret hex");
        let peer = from_hex(fixture["peer_public"].as_str().expect("peer")).expect("peer hex");
        let mut secret_bytes = [0u8; KEY_BYTES];
        secret_bytes.copy_from_slice(&secret);
        let mut peer_bytes = [0u8; KEY_BYTES];
        peer_bytes.copy_from_slice(&peer);
        let opened = open(OpenInput {
            secret: &secret_bytes,
            peer_public: &peer_bytes,
            local_device_id: PHONE,
            expected_from: DESKTOP,
            last_counter: 0,
            pairing_id: Some(fixture["pairingId"].as_str().expect("pairing id")),
            raw: fixture["wire"].as_str().expect("wire"),
        })
        .expect("the Rust side must open what TypeScript sealed");
        assert_eq!(opened.message["from"], json!("typescript"));
    }

    /// Cross-language proof, the other direction: this test writes the vector
    /// the TypeScript suite opens.
    ///
    /// It is not behind an environment flag and does not skip. The inputs are
    /// fixed (two constant secrets, a constant nonce and a constant ephemeral
    /// secret), so the file it writes is byte-for-byte the same on every run;
    /// writing it every time is what keeps the committed vector from drifting
    /// away from this implementation, and an assertion that quietly returns
    /// early proves nothing.
    #[test]
    fn write_the_vector_the_typescript_side_opens() {
        let (wire, desktop_secret, phone_secret) = sealed_between();
        let fixture = json!({
            "secret": to_hex(&phone_secret),
            "peer_public": to_hex(&public_key(&desktop_secret)),
            "pairingId": PAIRING,
            "wire": wire,
        });
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/lib/sync/__fixtures__/envelope-from-rust.json"
        );
        // A trailing newline because the repository formatter (biome) wants one:
        // this test rewrites the committed vector on every run, and a file that
        // flip-flopped between formatted and not would fail whichever run came
        // second.
        std::fs::write(
            path,
            format!(
                "{}\n",
                serde_json::to_string_pretty(&fixture).expect("encode")
            ),
        )
        .expect("write the Rust vector");
    }
}
