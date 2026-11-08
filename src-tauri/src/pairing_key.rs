//! The device's long-term pairing identity (§11.2, §10.3) — Phase C Session 5,
//! task O.1.
//!
//! One X25519 keypair per install, minted on first use and kept in the same
//! platform store as the database key (`key_store::Slot::PairingIdentity`): the
//! OS credential store on desktop, an Android-Keystore-wrapped blob on mobile.
//! The public half travels — in the offer and in the pinned peer row — and the
//! secret never leaves the device. It is not in the database, so no backup or
//! export of the data can carry it, and the only type ever printed is
//! [`PairingIdentity`], whose `Debug` shows the fingerprint instead.
//!
//! **Key loss is fail-closed** (the Session 0 rule): a stored value that is not
//! a 32-byte key is an error, never silently replaced, and a device whose key is
//! gone re-pairs with a new keypair instead of reusing an old pin. A fresh
//! install mints here; a factory reset deletes the slot in
//! `db::delete_db_key`, so the next launch mints again (and Session 2's rule
//! mints a new device id with it).
//!
//! The fingerprint is the 24-hex-character grouping both pairing screens show.
//! It is pinned against `keyFingerprint` in `src/lib/sync/pairing.ts` by a test,
//! so the two implementations cannot drift apart.

use std::fmt;

use serde::Serialize;

use crate::envelope::{from_hex, public_key, to_hex, KEY_BYTES};
use crate::key_store::{self, Slot};

/// The device's own X25519 keypair.
///
/// Deliberately neither `Serialize` nor `Clone`: a secret that cannot be
/// serialized cannot reach a backup, an IPC payload or a log by accident, and
/// only one owner at a time can read it.
pub struct PairingIdentity {
    secret: [u8; KEY_BYTES],
    public: [u8; KEY_BYTES],
}

impl PairingIdentity {
    pub fn from_secret(secret: [u8; KEY_BYTES]) -> Self {
        Self {
            secret,
            public: public_key(&secret),
        }
    }

    /// The agreement secret, for sealing and opening. The pairing listener is
    /// the only caller.
    pub fn secret(&self) -> &[u8; KEY_BYTES] {
        &self.secret
    }

    /// The public half: what the offer carries and what the peer pins (§11.2).
    pub fn public_key_hex(&self) -> String {
        to_hex(&self.public)
    }

    /// What both screens show at pairing (§11.1).
    pub fn fingerprint(&self) -> String {
        fingerprint_of(&self.public_key_hex())
    }
}

impl fmt::Debug for PairingIdentity {
    /// Shows the fingerprint, never the secret: every `{:?}` of this type — now
    /// or in a future log line — is safe by construction.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("PairingIdentity")
            .field(&self.fingerprint())
            .finish()
    }
}

/// What the IPC boundary may report about this device's identity: the public
/// key and its fingerprint. There is deliberately no field for the secret, so a
/// serialization of this type cannot carry one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingIdentityInfo {
    pub public_key: String,
    pub fingerprint: String,
}

impl PairingIdentity {
    pub fn info(&self) -> PairingIdentityInfo {
        PairingIdentityInfo {
            public_key: self.public_key_hex(),
            fingerprint: self.fingerprint(),
        }
    }
}

/// The on-screen fingerprint of a public key — identical to `keyFingerprint` in
/// `src/lib/sync/pairing.ts`: hex only, uppercase, the first six groups of four.
pub fn fingerprint_of(public_key_hex: &str) -> String {
    let hex: String = public_key_hex
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    hex.as_bytes()
        .chunks(4)
        .take(6)
        .map(|group| String::from_utf8_lossy(group).into_owned())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Load this install's keypair, minting it on first use.
///
/// A stored value that cannot be parsed is an error — never a silent re-mint.
/// Re-minting over an unreadable slot would look like a new pairing to the peer
/// while the desktop still held the old pin, so the honest outcome is the
/// documented fail-closed one.
pub fn load_or_mint() -> Result<PairingIdentity, String> {
    match key_store::read(Slot::PairingIdentity) {
        Ok(Some(stored)) => Ok(PairingIdentity::from_secret(parse_secret(&stored)?)),
        Ok(None) => mint(),
        Err(e) => Err(e.to_string()),
    }
}

fn mint() -> Result<PairingIdentity, String> {
    let mut secret = [0u8; KEY_BYTES];
    getrandom::fill(&mut secret).map_err(|e| format!("OS random source unavailable: {e}"))?;
    key_store::write(Slot::PairingIdentity, &to_hex(&secret)).map_err(|e| e.to_string())?;
    Ok(PairingIdentity::from_secret(secret))
}

/// Parse a stored secret. Pure, so the shape rule is testable without a key
/// store; the refusal never echoes the value it refused.
pub fn parse_secret(stored: &str) -> Result<[u8; KEY_BYTES], String> {
    let bytes = from_hex(stored).ok_or_else(unusable)?;
    if bytes.len() != KEY_BYTES {
        return Err(unusable());
    }
    let mut secret = [0u8; KEY_BYTES];
    secret.copy_from_slice(&bytes);
    Ok(secret)
}

fn unusable() -> String {
    "the stored pairing key is not a 32-byte hex key; pairing fails closed rather than \
     reusing it — re-pair this device with a fresh key"
        .to_string()
}

// ---------------------------------------------------------------------------
// Tests — run with `cargo test`
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// The public half of the fixed `0x11…` desktop vector the envelope
    /// fixtures use (`src/lib/sync/__fixtures__/envelope-from-rust.json` records
    /// it as the phone's `peer_public`).
    const RUST_VECTOR_PUBLIC: &str =
        "7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13";

    /// The same grouping the TypeScript side shows. If either implementation
    /// changes its formatting, the two screens would disagree about the key a
    /// person is confirming — which is the one thing the fingerprint exists to
    /// prevent.
    #[test]
    fn the_fingerprint_matches_the_typescript_implementation() {
        assert_eq!(
            fingerprint_of(RUST_VECTOR_PUBLIC),
            "7B4E 909B BE7F FE44 C465 A220"
        );
        assert_eq!(
            fingerprint_of(&RUST_VECTOR_PUBLIC.to_uppercase()),
            "7B4E 909B BE7F FE44 C465 A220",
            "case must not change what the human reads"
        );
        assert_eq!(
            fingerprint_of("7b-4e:90"),
            "7B4E 90",
            "separators are ignored, exactly like the TypeScript side"
        );
    }

    #[test]
    fn the_public_half_is_the_key_the_envelope_seals_to() {
        let identity = PairingIdentity::from_secret([0x11u8; KEY_BYTES]);
        assert_eq!(identity.public_key_hex(), RUST_VECTOR_PUBLIC);
        assert_eq!(
            to_hex(&public_key(&[0x11u8; KEY_BYTES])),
            RUST_VECTOR_PUBLIC
        );
    }

    /// The secret never appears in anything this type can be printed as.
    #[test]
    fn printing_the_identity_shows_the_fingerprint_and_never_the_secret() {
        let identity = PairingIdentity::from_secret([0x11u8; KEY_BYTES]);
        let printed = format!("{identity:?}");
        assert!(printed.contains("7B4E 909B"), "{printed}");
        let secret_hex = "11".repeat(KEY_BYTES);
        assert!(
            !printed.to_lowercase().contains(&secret_hex),
            "the secret must never be printable: {printed}"
        );
    }

    #[test]
    fn a_stored_key_that_is_not_a_key_fails_closed() {
        assert!(parse_secret("").is_err(), "empty is not a key");
        assert!(parse_secret("zz").is_err(), "not hex");
        assert!(
            parse_secret(&"11".repeat(31)).is_err(),
            "31 bytes is not a key"
        );
        assert!(
            parse_secret(&"11".repeat(33)).is_err(),
            "33 bytes is not a key"
        );
        assert_eq!(
            parse_secret(&"11".repeat(32)).expect("32 bytes"),
            [0x11u8; KEY_BYTES]
        );

        // The refusal says what to do, and does not echo what it refused.
        let message = parse_secret(&"ab".repeat(31)).expect_err("wrong length");
        assert!(message.contains("re-pair"), "{message}");
        assert!(!message.contains("ab"), "{message}");
    }

    /// The pairing secret and the database key never share storage: a slot
    /// mix-up would let one secret stand in for the other.
    #[test]
    fn the_pairing_slot_is_not_the_database_slot() {
        assert_ne!(Slot::PairingIdentity, Slot::Database);
        #[cfg(desktop)]
        assert_ne!(
            Slot::PairingIdentity.account(),
            Slot::Database.account(),
            "desktop keeps one credential-store entry per secret"
        );
        #[cfg(target_os = "android")]
        {
            assert_ne!(Slot::PairingIdentity.alias(), Slot::Database.alias());
            assert_ne!(Slot::PairingIdentity.file(), Slot::Database.file());
            assert_ne!(
                Slot::PairingIdentity.magic(),
                Slot::Database.magic(),
                "a blob must be refused, not merely fail, when opened as the wrong slot"
            );
        }
    }
}
