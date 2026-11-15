//! Desktop backend: the OS credential store through `keyring`.
//!
//! Deliberately behaviour-preserving: same service/account names, same
//! entry-per-call construction, same mapping of `NoEntry` to "nothing stored",
//! same message wording. The only change from the pre-seam code is that these
//! three operations live behind [`super`] instead of being called directly
//! from `db.rs`.

use super::{KeyStoreError, Slot};

/// The credential-store service every slot lives under. The service name is the
/// app id, so it must match `tauri.conf.json`.
const KEYRING_SERVICE: &str = "com.minlulin.purplememo";

/// Desktop keeps the exported-key restore path: "the database exists but the
/// credential store has no key" is recoverable with the key file the user
/// wrote from Settings, so the boot dialog must offer it.
pub const MISSING_KEY_IS_RECOVERABLE: bool = true;

fn entry(slot: Slot) -> Result<keyring::Entry, KeyStoreError> {
    keyring::Entry::new(KEYRING_SERVICE, slot.account())
        .map_err(|e| KeyStoreError::Unavailable(format!("keyring entry unavailable: {e}")))
}

pub fn read(slot: Slot) -> Result<Option<String>, KeyStoreError> {
    match entry(slot)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(KeyStoreError::Failed(format!(
            "failed to read the {} from the credential store: {e}",
            slot.account()
        ))),
    }
}

pub fn write(slot: Slot, value: &str) -> Result<(), KeyStoreError> {
    entry(slot)?.set_password(value).map_err(|e| {
        KeyStoreError::Failed(format!(
            "failed to store the {} in the credential store: {e}",
            slot.account()
        ))
    })
}

pub fn delete(slot: Slot) -> Result<bool, KeyStoreError> {
    match entry(slot)?.delete_credential() {
        Ok(()) => Ok(true),
        // Nothing stored: already absent, which a reset reports as success.
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(KeyStoreError::Failed(format!(
            "failed to delete the {} from the credential store: {e}",
            slot.account()
        ))),
    }
}
