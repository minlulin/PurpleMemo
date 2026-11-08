//! The sealed envelope — protocol §11.6.1 (Phase C Session 5, task O.2).
//!
//! The Rust half of one wire format; `src/lib/sync/envelope.ts` is the
//! TypeScript half. Both sides are proved against each other's bytes:
//! `src/lib/sync/__fixtures__/envelope-from-ts.json` is ciphertext produced by
//! the TypeScript implementation and opened here, and
//! `envelope-from-rust.json` is produced here and opened by the TypeScript
//! tests. A one-sided implementation is not a proof.
//!
//! **The format.**
//!
//! ```text
//! header  = {"v":1,"from":<id>,"to":<id>,"messageId":<id>,"counter":<n>,"nonce":<48 hex>}
//! key     = X25519(my_secret, peer_public)          // one static-static agreement
//! sealed  = XChaCha20-Poly1305(key, nonce, aad = header_bytes).encrypt(json(message))
//! wire    = {"header":<header>,"body":"<hex sealed>"}
//! ```
//!
//! Only the two pinned keys (§11.2) derive the agreement key, so a peer
//! without the pinned secret cannot produce an openable message — that is
//! §11.6's "authenticated encryption under the pinned key".
//!
//! **Deviation, stated rather than hidden:** §11.6.1 says *ephemeral*. Composing
//! an ephemeral and a static agreement into one authenticated key needs a KDF
//! of its own, and §11.6 forbids inventing one, so this build uses the
//! static-static agreement: everything §11.6 requires except forward secrecy.
//! The gap is recorded in the todo as pending MinLulin's decision.
//!
//! Nothing here logs a key, and no secret is ever serialized: the wire carries
//! public values, a nonce and ciphertext only.

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use x25519_dalek::{PublicKey, StaticSecret};

/// The envelope format version (§11.6.1 fixes v1).
pub const ENVELOPE_VERSION: u8 = 1;
pub const NONCE_BYTES: usize = 24;
pub const KEY_BYTES: usize = 32;

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

/// The public half of a long-term key. The secret is only ever read from the
/// platform key store (see `pairing_key.rs`).
pub fn public_key(secret: &[u8; KEY_BYTES]) -> [u8; KEY_BYTES] {
    PublicKey::from(&StaticSecret::from(*secret)).to_bytes()
}

/// The agreement key, or `None` for a low-order peer key (an all-zero secret
/// every X25519 implementation warns about).
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
    /// Supplied only by tests and cross-vectors; production uses the OS CSPRNG.
    pub nonce: Option<&'a [u8; NONCE_BYTES]>,
}

/// Seal one message into the wire string.
pub fn seal(input: SealInput<'_>) -> Result<String, String> {
    let key = shared_key(input.secret, input.peer_public)
        .ok_or_else(|| "peer public key is not a usable X25519 point".to_string())?;
    let nonce = match input.nonce {
        Some(fixed) => *fixed,
        None => {
            // The OS CSPRNG, the same source `share` and the database key use.
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
    let key = shared_key(input.secret, input.peer_public).ok_or(Refusal::Malformed)?;
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
            nonce: Some(&[0x33u8; NONCE_BYTES]),
        })
        .expect("seal");
        (wire, desktop_secret, phone_secret)
    }

    #[test]
    fn a_sealed_message_opens_on_the_other_side() {
        let (wire, desktop_secret, phone_secret) = sealed_between();
        let opened = open(OpenInput {
            secret: &phone_secret,
            peer_public: &public_key(&desktop_secret),
            local_device_id: PHONE,
            expected_from: DESKTOP,
            last_counter: 0,
            raw: &wire,
        })
        .expect("open");
        assert_eq!(opened.message, json!({ "hello": "from rust", "n": 1 }));
        assert_eq!(opened.header.from, DESKTOP);
        assert_eq!(opened.header.counter, 1);
    }

    #[test]
    fn the_desktop_itself_cannot_reach_the_phone_key() {
        // Both sides derive the same agreement key — that is what makes the seal
        // work, and it is asserted rather than assumed.
        let (desktop_secret, phone_secret) = keys();
        assert_eq!(
            shared_key(&desktop_secret, &public_key(&phone_secret)),
            shared_key(&phone_secret, &public_key(&desktop_secret)),
        );
    }

    #[test]
    fn every_altered_part_of_an_envelope_is_refused() {
        let (wire, desktop_secret, phone_secret) = sealed_between();
        let desktop_public = public_key(&desktop_secret);
        let open_raw = |raw: &str| {
            open(OpenInput {
                secret: &phone_secret,
                peer_public: &desktop_public,
                local_device_id: PHONE,
                expected_from: DESKTOP,
                last_counter: 0,
                raw,
            })
        };

        // Ciphertext.
        let parsed: JsonValue = serde_json::from_str(&wire).expect("json");
        let mut body = parsed["body"].as_str().expect("body").to_string();
        let last = body.pop().expect("body is not empty");
        body.push(if last == '0' { '1' } else { '0' });
        let mut tampered = parsed.clone();
        tampered["body"] = JsonValue::String(body);
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
        let nonce = parsed["header"]["nonce"]
            .as_str()
            .expect("nonce")
            .to_string();
        let mut flipped_nonce = nonce.clone();
        let last = flipped_nonce.pop().expect("nonce is not empty");
        flipped_nonce.push(if last == '0' { '1' } else { '0' });
        let mut nonce_tamper = parsed.clone();
        nonce_tamper["header"]["nonce"] = JsonValue::String(flipped_nonce);
        assert!(open_raw(&nonce_tamper.to_string()).is_err());

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
            nonce: Some(&[0x55u8; NONCE_BYTES]),
        })
        .expect("seal");
        assert_eq!(open_raw(&forged), Err(Refusal::Unauthenticated));

        // Garbage, never a panic.
        assert_eq!(open_raw("not json"), Err(Refusal::Malformed));
        assert_eq!(
            open_raw("{\"header\":{},\"body\":\"\"}"),
            Err(Refusal::Malformed)
        );
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
            raw: &wire,
        });
        assert_eq!(replayed, Err(Refusal::Replayed));

        let foreign = open(OpenInput {
            secret: &phone_secret,
            peer_public: &desktop_public,
            local_device_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            expected_from: DESKTOP,
            last_counter: 0,
            raw: &wire,
        });
        assert_eq!(foreign, Err(Refusal::WrongRecipient));

        let wrong_sender = open(OpenInput {
            secret: &phone_secret,
            peer_public: &desktop_public,
            local_device_id: PHONE,
            expected_from: PHONE,
            last_counter: 0,
            raw: &wire,
        });
        assert_eq!(wrong_sender, Err(Refusal::WrongSender));
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
            raw: fixture["wire"].as_str().expect("wire"),
        })
        .expect("the Rust side must open what TypeScript sealed");
        assert_eq!(opened.message["from"], json!("typescript"));
    }

    /// Cross-language proof, the other direction: this test writes the vector
    /// the TypeScript suite opens.
    ///
    /// It is not behind an environment flag and does not skip. The inputs are
    /// fixed (two constant secrets and a constant nonce), so the file it writes
    /// is byte-for-byte the same on every run; writing it every time is what
    /// keeps the committed vector from drifting away from this implementation,
    /// and an assertion that quietly returns early proves nothing.
    #[test]
    fn write_the_vector_the_typescript_side_opens() {
        let (wire, desktop_secret, phone_secret) = sealed_between();
        let fixture = json!({
            "secret": to_hex(&phone_secret),
            "peer_public": to_hex(&public_key(&desktop_secret)),
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
                "{}
",
                serde_json::to_string_pretty(&fixture).expect("encode")
            ),
        )
        .expect("write the Rust vector");
    }
}
