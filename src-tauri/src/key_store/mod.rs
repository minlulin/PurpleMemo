//! Platform key-store seam: load-or-mint the SQLCipher database key.
//!
//! The database key (the DEK) is never stored in the clear and never leaves
//! the process: it is kept in whatever key store the platform provides, and
//! this module is the only place that talks to one.
//!
//! * **Desktop** ([`desktop`]) — the OS credential store through `keyring`,
//!   exactly the flow that shipped (one entry, mint-once, delete-last on
//!   reset).
//! * **Android** ([`android`]) — the DEK is wrapped by a non-exportable
//!   AES-256 key that lives in the Android Keystore (StrongBox or TEE where
//!   the device offers one, software otherwise); only the wrapped blob is on
//!   disk. The `keyring` crate has no Android backend and is not linked into
//!   that build.
//!
//! `db.rs` owns the policy on top of this seam (mint only when no database
//! exists, never mint over existing data); the platform modules own only
//! "read what is there", "write it", "delete it".

#[cfg(target_os = "android")]
mod android;
#[cfg(desktop)]
mod desktop;

#[cfg(target_os = "android")]
use android as platform;
#[cfg(desktop)]
use desktop as platform;

#[cfg(target_os = "android")]
pub use android::MISSING_KEY_IS_RECOVERABLE;
#[cfg(desktop)]
pub use desktop::MISSING_KEY_IS_RECOVERABLE;

/// Which long-lived secret is being read or written.
///
/// The seam started with one slot (the database key) and now holds two. They are
/// kept apart deliberately: the pairing identity (§11.2) authenticates the sync
/// wire and the DEK encrypts the database, and neither may ever stand in for the
/// other. On desktop that means one credential-store entry per account name; on
/// Android one wrapped blob and one non-exportable Keystore alias per slot, so a
/// blob can never be unwrapped as the wrong secret (the magic bytes differ too).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slot {
    /// The SQLCipher database key (the DEK).
    Database,
    /// The device's long-term X25519 pairing secret (§11.2, §10.3).
    PairingIdentity,
}

impl Slot {
    /// Credential-store account (desktop): one entry per slot, same service.
    #[cfg(desktop)]
    pub fn account(self) -> &'static str {
        match self {
            Self::Database => "db-encryption-key",
            Self::PairingIdentity => "pairing-identity-key",
        }
    }

    /// Keystore alias of the non-exportable wrapping key (Android). Versioned so
    /// a future rotation can mint a second alias instead of reusing one.
    #[cfg(target_os = "android")]
    pub fn alias(self) -> &'static str {
        match self {
            Self::Database => "purple_memo_db_key_wrap_v1",
            Self::PairingIdentity => "purple_memo_pairing_key_wrap_v1",
        }
    }

    /// The wrapped blob's file name (Android), inside the app data dir.
    #[cfg(target_os = "android")]
    pub fn file(self) -> &'static str {
        match self {
            Self::Database => "db-key.wrapped",
            Self::PairingIdentity => "pairing-key.wrapped",
        }
    }

    /// Blob magic (Android). Distinct per slot, so a blob written for one secret
    /// is refused — not merely fail to authenticate — when opened as the other.
    #[cfg(target_os = "android")]
    pub fn magic(self) -> &'static [u8; 5] {
        match self {
            Self::Database => b"PMKW1",
            Self::PairingIdentity => b"PMPK1",
        }
    }

    /// What the user reads in an error about this slot.
    #[cfg(target_os = "android")]
    pub fn label(self) -> &'static str {
        match self {
            Self::Database => "database key",
            Self::PairingIdentity => "pairing key",
        }
    }

    /// What losing this secret means, for the `Lost` message: the documented
    /// fail-closed outcome differs per slot (restore/re-pair from the desktop vs.
    /// a copy of the data that can no longer be opened at all).
    #[cfg(target_os = "android")]
    pub fn loss_consequence(self) -> &'static str {
        match self {
            Self::Database => "so this copy of the data cannot be opened",
            Self::PairingIdentity => {
                "so pairing fails closed until this device pairs again with a fresh key"
            }
        }
    }
}

/// Why a key-store operation failed.
///
/// The classes are what the boot paths act on, so they are separated by type
/// and never by message text:
///
/// * [`Self::Unavailable`] — the store cannot be reached in this session
///   (locked credential store, no provider, JVM not attached). Retryable, and
///   never a reason to touch data.
/// * [`Self::Failed`] — the store was reachable and the operation failed.
/// * [`Self::Lost`] — the wrapped key material is on disk but can no longer
///   be unwrapped: the platform key that protects it is gone. No retry and no
///   other key can recover it, which on mobile is the documented
///   fail-closed ⇒ wipe ⇒ re-pair path.
///
/// The desktop backend never produces [`Self::Lost`] — a credential store
/// that answers "no entry" leaves the database recoverable with an exported
/// key file — so the variant is only constructed on Android.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyStoreError {
    Unavailable(String),
    Failed(String),
    #[allow(dead_code)]
    Lost(String),
}

impl KeyStoreError {
    /// The user-facing reason, without the class label.
    pub fn message(&self) -> &str {
        match self {
            Self::Unavailable(message) | Self::Failed(message) | Self::Lost(message) => message,
        }
    }
}

impl std::fmt::Display for KeyStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

/// Read the stored DB key (lowercase hex).
///
/// `Ok(None)` means the store was reachable and holds no key — the only
/// condition under which the caller may mint a new one.
pub fn read(slot: Slot) -> Result<Option<String>, KeyStoreError> {
    platform::read(slot)
}

/// Store `value` in `slot`, replacing whatever it held.
pub fn write(slot: Slot, value: &str) -> Result<(), KeyStoreError> {
    platform::write(slot, value)
}

/// Remove `slot`. `Ok(false)` means it was already empty (which a reset reports
/// as success).
pub fn delete(slot: Slot) -> Result<bool, KeyStoreError> {
    platform::delete(slot)
}

/// Which backing actually protects the database key, as the platform recorded
/// it.
///
/// Android only: the desktop credential store has no hardware backing to
/// report, and its diagnostics screen is not this one.
#[cfg(target_os = "android")]
pub fn backing(slot: Slot) -> Result<&'static str, KeyStoreError> {
    platform::backing(slot)
}
