//! Desktop backend: the OS credential store through `keyring`.
//!
//! Deliberately behaviour-preserving: same service/account names, same
//! entry-per-call construction, same mapping of `NoEntry` to "nothing stored",
//! same message wording. The only change from the pre-seam code is that these
//! three operations live behind [`super`] instead of being called directly
//! from `db.rs`.

use super::KeyStoreError;

/// The credential-store coordinates of the single DB-key slot. The service
/// name is the app id, so it must match `tauri.conf.json`.
const KEYRING_SERVICE: &str = "com.minlulin.purplememo";
const KEYRING_ACCOUNT: &str = "db-encryption-key";

/// Desktop keeps the exported-key restore path: "the database exists but the
/// credential store has no key" is recoverable with the key file the user
/// wrote from Settings, so the boot dialog must offer it.
pub const MISSING_KEY_IS_RECOVERABLE: bool = true;

fn entry() -> Result<keyring::Entry, KeyStoreError> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| KeyStoreError::Unavailable(format!("keyring entry unavailable: {e}")))
}

pub fn read() -> Result<Option<String>, KeyStoreError> {
    match entry()?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(KeyStoreError::Failed(format!(
            "failed to read DB key from credential store: {e}"
        ))),
    }
}

pub fn write(key: &str) -> Result<(), KeyStoreError> {
    entry()?.set_password(key).map_err(|e| {
        KeyStoreError::Failed(format!("failed to store DB key in credential store: {e}"))
    })
}

pub fn delete() -> Result<bool, KeyStoreError> {
    match entry()?.delete_credential() {
        Ok(()) => Ok(true),
        // No key stored: already absent, which a reset reports as success.
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(KeyStoreError::Failed(format!(
            "failed to delete the DB key from the credential store: {e}"
        ))),
    }
}
