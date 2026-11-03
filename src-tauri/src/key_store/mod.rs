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
pub fn read() -> Result<Option<String>, KeyStoreError> {
    platform::read()
}

/// Store the DB key, replacing whatever the store held.
pub fn write(key: &str) -> Result<(), KeyStoreError> {
    platform::write(key)
}

/// Remove the DB key. `Ok(false)` means there was none (already absent, which
/// a reset reports as success).
pub fn delete() -> Result<bool, KeyStoreError> {
    platform::delete()
}
