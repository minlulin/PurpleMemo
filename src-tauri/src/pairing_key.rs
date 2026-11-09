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
//! gone re-pairs with a new keypair instead of reusing an old pin. Only a fresh
//! install mints, which is why [`load_or_mint`] is told the install's pairing
//! history: with peers already pinned, an empty slot is key loss, so it fails
//! closed, records `sync_state.re_pair_required` and waits for the person to
//! confirm a replacement ([`replace_after_confirmation`]) — a silent rotation
//! would leave every peer's pin naming a key this device no longer holds (§11.2,
//! §11.4). A factory reset deletes the slot in `db::delete_db_key`, so the next
//! launch mints again (and Session 2's rule mints a new device id with it).
//!
//! The fingerprint is the 24-hex-character grouping both pairing screens show.
//! It is pinned against `keyFingerprint` in `src/lib/sync/pairing.ts` by a test,
//! so the two implementations cannot drift apart.

use std::fmt;

use serde::Serialize;

use crate::envelope::{from_hex, public_key, to_hex, KEY_BYTES};
use crate::key_store::{self, KeyStoreError, Slot};

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

/// Whether this install has ever paired — the fact that decides whether an
/// empty slot may be minted (§11.2, wave 1 N2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairingHistory {
    /// No `sync_peers` rows: a fresh install, so the first identity is minted.
    Never,
    /// At least one pin exists (or existed). An empty slot is key loss, never a
    /// fresh start.
    Paired,
}

/// Why the pairing identity could not be loaded. Typed, because the recovery
/// differs per class and the UI must not parse a message to find it (N2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairingKeyError {
    /// The store is reachable and holds no identity while a pin exists. Fail
    /// closed: `sync_state.re_pair_required` is recorded, and a replacement is
    /// minted only on the person's explicit confirmation.
    MissingWithPeers(String),
    /// The stored identity is there but can never be opened again (Android
    /// Keystore loss). `pairing_identity_replace` is the documented recovery.
    Lost(String),
    /// The store is unreachable, or the stored value is not a key. Never a
    /// reason to mint.
    Other(String),
}

impl PairingKeyError {
    /// The reason, in the words the panel shows.
    pub fn message(&self) -> &str {
        match self {
            Self::MissingWithPeers(message) | Self::Lost(message) | Self::Other(message) => message,
        }
    }

    /// True when confirming a fresh identity is what repairs this class — and so
    /// also when `re_pair_required` must be recorded.
    pub fn needs_re_pair_flag(&self) -> bool {
        matches!(self, Self::MissingWithPeers(_) | Self::Lost(_))
    }
}

impl fmt::Display for PairingKeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl From<KeyStoreError> for PairingKeyError {
    fn from(error: KeyStoreError) -> Self {
        match error {
            // The class is preserved, not flattened: `Lost` is what the
            // dedicated recovery answers, and it must stay recognisable.
            KeyStoreError::Lost(message) => Self::Lost(message),
            KeyStoreError::Unavailable(message) | KeyStoreError::Failed(message) => {
                Self::Other(message)
            }
        }
    }
}

/// What loading is about to do. Pure, so the fail-closed policy is testable
/// without an OS key store.
#[derive(Debug)]
pub enum IdentityPlan {
    /// A stored key that parsed: use it.
    Stored(PairingIdentity),
    /// A fresh install: mint the first identity.
    Mint,
}

/// The policy, in one place (§11.2, N2):
///
/// * a stored, parseable key is used;
/// * an empty slot is a mint **only when this install has never paired**;
/// * an empty slot over an existing pin fails closed — a replacement needs the
///   person's confirmation, never a silent rotation of this device's identity;
/// * an unopenable slot keeps its typed `Lost` class, so the dedicated recovery
///   is reachable;
/// * a malformed value or an unreachable store never mints.
pub fn plan(
    stored: Result<Option<String>, KeyStoreError>,
    history: PairingHistory,
) -> Result<IdentityPlan, PairingKeyError> {
    match stored {
        Ok(Some(value)) => parse_secret(&value)
            .map(|secret| IdentityPlan::Stored(PairingIdentity::from_secret(secret)))
            .map_err(PairingKeyError::Other),
        Ok(None) => match history {
            PairingHistory::Never => Ok(IdentityPlan::Mint),
            PairingHistory::Paired => {
                Err(PairingKeyError::MissingWithPeers(missing_identity_message()))
            }
        },
        Err(error) => Err(error.into()),
    }
}

fn missing_identity_message() -> String {
    "this device's pairing key is missing from the platform key store, but it has paired before. \
     Purple Memo will not mint a replacement identity over an existing pin — confirm re-pairing to \
     mint a fresh key, then pair the phone again"
        .to_string()
}

/// Load this install's keypair, minting it only on a fresh install.
pub fn load_or_mint(history: PairingHistory) -> Result<PairingIdentity, PairingKeyError> {
    match plan(key_store::read(Slot::PairingIdentity), history)? {
        IdentityPlan::Stored(identity) => Ok(identity),
        IdentityPlan::Mint => mint(),
    }
}

/// What the store says, without minting — what boot checks (N2).
///
/// `Ok(None)` is a fresh install; `MissingWithPeers` and `Lost` are the classes
/// that need the confirmed re-pair.
pub fn inspect(history: PairingHistory) -> Result<Option<PairingIdentity>, PairingKeyError> {
    match plan(key_store::read(Slot::PairingIdentity), history)? {
        IdentityPlan::Stored(identity) => Ok(Some(identity)),
        IdentityPlan::Mint => Ok(None),
    }
}

fn mint() -> Result<PairingIdentity, PairingKeyError> {
    let mut secret = [0u8; KEY_BYTES];
    getrandom::fill(&mut secret)
        .map_err(|e| PairingKeyError::Other(format!("OS random source unavailable: {e}")))?;
    key_store::write(Slot::PairingIdentity, &to_hex(&secret)).map_err(PairingKeyError::from)?;
    Ok(PairingIdentity::from_secret(secret))
}

/// Mint a replacement identity after the person confirms re-pairing (§11.4, N2).
///
/// Only `Slot::PairingIdentity` is touched: the database slot and every note,
/// task and photo stay exactly where they are, so this is re-pairing, not a
/// factory reset. Deleting first is what recovers an Android slot whose wrapped
/// blob can never be unwrapped again.
pub fn replace_after_confirmation() -> Result<PairingIdentity, PairingKeyError> {
    key_store::delete(Slot::PairingIdentity).map_err(PairingKeyError::from)?;
    mint()
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

    fn stored(value: Option<&str>) -> Result<Option<String>, KeyStoreError> {
        Ok(value.map(str::to_string))
    }

    /// §11.2 (N2): an empty slot over an existing pin is key loss. Minting here
    /// would rotate this device's identity behind the person's back and leave
    /// every peer's pin naming a key that no longer exists.
    #[test]
    fn a_missing_identity_over_an_existing_pairing_fails_closed() {
        let refused = plan(stored(None), PairingHistory::Paired)
            .expect_err("a paired install must never mint silently");
        assert!(matches!(refused, PairingKeyError::MissingWithPeers(_)));
        assert!(refused.needs_re_pair_flag(), "this is a re-pair");
        assert!(
            refused.message().contains("re-pair") && refused.message().contains("confirm"),
            "the message must name the recovery: {refused}"
        );
    }

    #[test]
    fn a_fresh_install_mints_its_first_identity() {
        match plan(stored(None), PairingHistory::Never).expect("a fresh install mints") {
            IdentityPlan::Mint => {}
            IdentityPlan::Stored(_) => panic!("an empty fresh install has nothing to load"),
        }
    }

    /// The `Lost` class says the slot exists but can never be opened, which is
    /// exactly what `pairing_identity_replace` answers; flattening it to a bare
    /// string would hide that from the UI (§11.2, N2).
    #[test]
    fn a_lost_slot_keeps_its_typed_class() {
        let lost = plan(
            Err(KeyStoreError::Lost("keystore key gone".to_string())),
            PairingHistory::Paired,
        )
        .expect_err("a lost identity is an error");
        assert!(matches!(lost, PairingKeyError::Lost(_)));
        assert!(lost.needs_re_pair_flag());
        assert_eq!(lost.message(), "keystore key gone");
    }

    #[test]
    fn a_stored_key_is_used_and_a_malformed_one_never_mints() {
        let good = "11".repeat(KEY_BYTES);
        match plan(stored(Some(&good)), PairingHistory::Paired).expect("stored key") {
            IdentityPlan::Stored(identity) => {
                assert_eq!(identity.public_key_hex(), RUST_VECTOR_PUBLIC)
            }
            IdentityPlan::Mint => panic!("a stored key must never be replaced"),
        }
        let malformed = plan(stored(Some("not-a-key")), PairingHistory::Never)
            .expect_err("a malformed stored key is never a fresh start");
        assert!(matches!(malformed, PairingKeyError::Other(_)));
        assert!(!malformed.needs_re_pair_flag());
    }

    /// A store that is merely unreachable is retryable: it must neither mint nor
    /// tell the person to re-pair.
    #[test]
    fn an_unreachable_store_never_mints_and_never_asks_for_a_re_pair() {
        for error in [
            KeyStoreError::Unavailable("locked".to_string()),
            KeyStoreError::Failed("refused".to_string()),
        ] {
            let refused = plan(Err(error), PairingHistory::Never)
                .expect_err("a store failure is never a fresh install");
            assert!(matches!(refused, PairingKeyError::Other(_)));
            assert!(!refused.needs_re_pair_flag(), "retryable, not a re-pair");
        }
    }

    /// §10.3: a factory reset removes the pairing identity too, so a reset cannot
    /// leave the old secret behind to resume a pairing the person erased.
    #[test]
    fn a_factory_reset_still_deletes_the_pairing_slot() {
        let db = include_str!("db.rs");
        let start = db.find("pub fn delete_db_key").expect("delete_db_key");
        let body = &db[start..];
        let end = body.find("\n}\n").unwrap_or(body.len());
        let body = &body[..end];
        assert!(
            body.contains("Slot::PairingIdentity"),
            "the reset must delete the pairing identity: {body}"
        );
        assert!(
            body.contains("Slot::Database"),
            "and the database key: {body}"
        );
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
