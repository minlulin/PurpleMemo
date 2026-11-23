//! The wrapped-key blob format, and the one failure classification that
//! decides whether a phone keeps its data.
//!
//! This module used to live inside `android.rs`, which compiles only on
//! Android — so the purest, most consequential code in the key store had
//! no tests at all: the blob codec's boundary checks, and the rule that
//! an AEAD authentication failure is *proof of loss* while every other
//! unwrap failure is a retryable `Failed`. Extracted here, behind no
//! platform gate, so the suite pins them on every machine (Arena review
//! 2026-11-23, B4). The JNI and Keystore calls stay in `android.rs`;
//! nothing in this file touches the platform.
//!
//! Blob layout: the slot's 5 magic bytes, one backing byte, one IV
//! length byte, the IV, then the ciphertext (the wrapped key plus its
//! GCM tag). The magic differs per slot, so a blob written for one
//! secret cannot be opened as the other.

use super::Slot;

/// Length of the blob magic (`PMKW1` / `PMPK1`); the bytes themselves come from
/// the slot, so a blob written for one secret cannot be opened as the other.
pub(crate) const MAGIC_LEN: usize = 5;
/// magic + backing byte + IV length byte.
pub(crate) const HEADER_LEN: usize = MAGIC_LEN + 2;
pub(crate) const GCM_TAG_LEN: usize = 16;
/// Neither secret this module wraps is any other length.
pub(crate) const KEY_LEN: usize = 32;

pub(crate) const BACKING_UNKNOWN: u8 = 0;
pub(crate) const BACKING_SOFTWARE: u8 = 1;
pub(crate) const BACKING_TEE: u8 = 2;
pub(crate) const BACKING_STRONGBOX: u8 = 3;

/// The Java exception class a GCM tag mismatch surfaces as. It is one of
/// the two proofs of loss in the Android key store's failure policy: the
/// blob was not wrapped by this key (or is corrupt), and no retry will
/// ever open it. Every other exception is a Keystore problem of the
/// moment and stays `Failed` — fail closed, keep the data.
pub(crate) const AEAD_BAD_TAG_CLASS: &str = "javax.crypto.AEADBadTagException";

/// Whether a `doFinal` failure with this pending exception class proves
/// the wrapped key is lost. `None` (no exception, or it could not be
/// read) is never proof.
pub(crate) fn aead_failure_is_loss(exception_class: Option<&str>) -> bool {
    exception_class == Some(AEAD_BAD_TAG_CLASS)
}

pub(crate) fn encode_blob(slot: Slot, backing: u8, iv: &[u8], ciphertext: &[u8]) -> Vec<u8> {
    let mut blob = Vec::with_capacity(HEADER_LEN + iv.len() + ciphertext.len());
    blob.extend_from_slice(slot.magic());
    blob.push(backing);
    blob.push(iv.len() as u8);
    blob.extend_from_slice(iv);
    blob.extend_from_slice(ciphertext);
    blob
}

pub(crate) fn decode_blob(slot: Slot, blob: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    if blob.len() < HEADER_LEN || &blob[..MAGIC_LEN] != slot.magic() {
        return None;
    }
    let backing = blob[MAGIC_LEN];
    let iv_len = blob[MAGIC_LEN + 1] as usize;
    if iv_len == 0 || iv_len > 32 {
        return None;
    }
    let iv_end = HEADER_LEN.checked_add(iv_len)?;
    if blob.len() < iv_end + KEY_LEN + GCM_TAG_LEN {
        return None;
    }
    Some((backing, &blob[HEADER_LEN..iv_end], &blob[iv_end..]))
}

pub(crate) fn decode_key_hex(key: &str) -> Option<[u8; KEY_LEN]> {
    if key.len() != KEY_LEN * 2 || !key.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let mut secret = [0u8; KEY_LEN];
    for (index, byte) in secret.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&key[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(secret)
}

pub(crate) fn backing_name(backing: u8) -> &'static str {
    match backing {
        BACKING_STRONGBOX => "StrongBox",
        BACKING_TEE => "TEE",
        BACKING_SOFTWARE => "software",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A wrapped 32-byte key: 32 bytes of ciphertext + the 16-byte tag.
    fn ciphertext() -> Vec<u8> {
        (0..KEY_LEN + GCM_TAG_LEN).map(|i| i as u8).collect()
    }

    fn iv() -> [u8; 12] {
        [7u8; 12]
    }

    #[test]
    fn a_blob_round_trips_for_both_slots() {
        for slot in [Slot::Database, Slot::PairingIdentity] {
            let blob = encode_blob(slot, BACKING_TEE, &iv(), &ciphertext());
            let (backing, got_iv, got_ciphertext) =
                decode_blob(slot, &blob).expect("a blob this build wrote must decode");
            assert_eq!(backing, BACKING_TEE);
            assert_eq!(got_iv, iv());
            assert_eq!(got_ciphertext, ciphertext().as_slice());
        }
    }

    #[test]
    fn a_blob_written_for_one_slot_never_decodes_as_the_other() {
        let blob = encode_blob(Slot::Database, BACKING_TEE, &iv(), &ciphertext());
        assert_eq!(decode_blob(Slot::PairingIdentity, &blob), None);
        let blob = encode_blob(Slot::PairingIdentity, BACKING_TEE, &iv(), &ciphertext());
        assert_eq!(decode_blob(Slot::Database, &blob), None);
    }

    #[test]
    fn decode_refuses_a_short_header_and_a_foreign_magic() {
        assert_eq!(decode_blob(Slot::Database, &[]), None);
        assert_eq!(decode_blob(Slot::Database, b"PMKW"), None);
        let mut blob = encode_blob(Slot::Database, BACKING_TEE, &iv(), &ciphertext());
        blob[0] = b'X';
        assert_eq!(decode_blob(Slot::Database, &blob), None);
    }

    #[test]
    fn decode_refuses_an_iv_length_of_zero_or_past_the_cap() {
        // iv_len = 0: a header that claims no IV at all.
        let mut blob = vec![0u8; HEADER_LEN + KEY_LEN + GCM_TAG_LEN];
        blob[..MAGIC_LEN].copy_from_slice(Slot::Database.magic());
        blob[MAGIC_LEN] = BACKING_TEE;
        blob[MAGIC_LEN + 1] = 0;
        assert_eq!(decode_blob(Slot::Database, &blob), None);
        // iv_len = 33: one past the accepted maximum.
        blob[MAGIC_LEN + 1] = 33;
        assert_eq!(decode_blob(Slot::Database, &blob), None);
    }

    #[test]
    fn decode_refuses_a_truncated_ciphertext() {
        let blob = encode_blob(Slot::Database, BACKING_TEE, &iv(), &ciphertext());
        let cut = &blob[..blob.len() - 1];
        assert_eq!(decode_blob(Slot::Database, cut), None);
        // Header + IV only, no ciphertext at all.
        let cut = &blob[..HEADER_LEN + iv().len()];
        assert_eq!(decode_blob(Slot::Database, cut), None);
    }

    #[test]
    fn backing_names_cover_every_backing_and_the_unknown_rest() {
        assert_eq!(backing_name(BACKING_STRONGBOX), "StrongBox");
        assert_eq!(backing_name(BACKING_TEE), "TEE");
        assert_eq!(backing_name(BACKING_SOFTWARE), "software");
        assert_eq!(backing_name(BACKING_UNKNOWN), "unknown");
        assert_eq!(backing_name(99), "unknown");
    }

    #[test]
    fn key_hex_decodes_exactly_32_bytes_and_refuses_the_rest() {
        let hex: String = (0..KEY_LEN).map(|i| format!("{i:02x}")).collect();
        let key = decode_key_hex(&hex).expect("64 hex chars decode");
        assert_eq!(key[0], 0);
        assert_eq!(key[KEY_LEN - 1], (KEY_LEN - 1) as u8);
        // Uppercase is hex too.
        assert!(decode_key_hex(&hex.to_uppercase()).is_some());
        // Too short, too long, and not hex at all.
        assert_eq!(decode_key_hex(&hex[..62]), None);
        assert_eq!(decode_key_hex(&format!("{hex}00")), None);
        assert_eq!(decode_key_hex(&"z".repeat(64)), None);
        assert_eq!(decode_key_hex(""), None);
    }

    #[test]
    fn only_the_aead_bad_tag_class_proves_loss() {
        // The class name itself is pinned: a typo here would quietly turn
        // proven loss into a retryable failure, or the reverse.
        assert_eq!(AEAD_BAD_TAG_CLASS, "javax.crypto.AEADBadTagException");
        assert!(aead_failure_is_loss(Some(AEAD_BAD_TAG_CLASS)));
        assert!(!aead_failure_is_loss(Some(
            "java.security.KeyStoreException"
        )));
        assert!(!aead_failure_is_loss(Some(
            "javax.crypto.IllegalBlockSizeException"
        )));
        assert!(!aead_failure_is_loss(None));
        assert!(!aead_failure_is_loss(Some("")));
    }
}
