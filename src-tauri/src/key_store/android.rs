//! Android backend of the key-store seam: the DEK is wrapped by a
//! non-exportable AES-256 key that lives in the **Android Keystore**.
//!
//! Why this shape:
//!
//! * The Keystore key is generated inside the platform (StrongBox or TEE where
//!   the device offers one, software otherwise) and can never be exported. Its
//!   only uses are `PURPOSE_ENCRYPT` and `PURPOSE_DECRYPT`, so a copy of the app
//!   data dir is useless without the device.
//! * Each secret (the DEK, and since Phase C Session 5 the pairing identity) is
//!   minted by the OS CSPRNG and immediately wrapped with AES-256-GCM under that
//!   Keystore key. Only the wrapped blob is written to disk (app-private, mode
//!   0600; `db-key.wrapped` / `pairing-key.wrapped`, each with its own magic and
//!   its own Keystore alias), so neither secret is ever stored in the clear.
//! * The blob's header records which backing actually produced the wrapping key,
//!   so the answer to "was this device StrongBox-backed?" survives on disk.
//!
//! Failure policy, per design decision 6:
//!
//! * Keystore unavailable / operation refused → [`KeyStoreError::Failed`] or
//!   [`KeyStoreError::Unavailable`]. The app fails closed with a clear message.
//!   There is no software fallback and no "unprotected key" path anywhere in
//!   this module.
//! * [`KeyStoreError::Lost`] is reserved for the failures that PROVE the
//!   secret unrecoverable — the wrapping key's alias is gone, or the blob
//!   fails GCM authentication under the key — plus a blob that is not a blob
//!   at all. `boot` turns `Lost` into the fail-closed wipe + re-pair path, so
//!   nothing else may map to it: a Keystore error of the moment (the daemon
//!   busy, the key temporarily unusable) is `Failed`, fails closed, and the
//!   data survives for the next attempt.
//!
//! JNI plumbing note: only **framework** classes (`java.security.KeyStore`,
//! `javax.crypto.Cipher`, `android.security.keystore.*`) are touched, resolved
//! with `FindClass` from an attached native thread. Framework classes come from
//! the boot class loader, so they resolve from any thread without needing the
//! app's own class loader or a Kotlin-side helper.

use std::path::{Path, PathBuf};

use jni::objects::{JByteArray, JObject, JObjectArray, JString, JValue};
use jni::{JNIEnv, JavaVM};

use super::{KeyStoreError, Slot};

/// Length of the blob magic (`PMKW1` / `PMPK1`); the bytes themselves come from
/// the slot, so a blob written for one secret cannot be opened as the other.
const MAGIC_LEN: usize = 5;
/// magic + backing byte + IV length byte.
const HEADER_LEN: usize = MAGIC_LEN + 2;
const IV_LEN: usize = 12;
const GCM_TAG_BITS: i32 = 128;
const GCM_TAG_LEN: usize = 16;
/// Neither secret this module wraps is any other length.
const KEY_LEN: usize = 32;
/// `KeyProperties.PURPOSE_ENCRYPT` / `PURPOSE_DECRYPT`.
const PURPOSE_ENCRYPT: i32 = 1;
const PURPOSE_DECRYPT: i32 = 2;

const BACKING_UNKNOWN: u8 = 0;
const BACKING_SOFTWARE: u8 = 1;
const BACKING_TEE: u8 = 2;
const BACKING_STRONGBOX: u8 = 3;

/// Android has no exported-key restore path — the DEK exists only inside the
/// Keystore wrap — so "database exists, store holds no key" is key loss, not a
/// recoverable state. `db.rs` reads this to pick the failure class.
pub const MISSING_KEY_IS_RECOVERABLE: bool = false;

// ---------------------------------------------------------------------------
// Public seam
// ---------------------------------------------------------------------------

pub fn read(slot: Slot) -> Result<Option<String>, KeyStoreError> {
    let path = wrapped_key_path(slot)?;
    let blob = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(KeyStoreError::Unavailable(format!(
                "could not read {}: {e}",
                path.display()
            )))
        }
    };
    let (_, iv, ciphertext) = decode_blob(slot, &blob).ok_or_else(|| {
        lost(
            slot,
            &path,
            "the wrapped key file is not a blob this build understands",
        )
    })?;
    let key = match with_env(|env| unwrap_dek(env, slot, iv, ciphertext)) {
        Ok(key) => key,
        // The error class is `unwrap_dek`'s call, per the module's failure
        // policy: `Lost` only where loss is proven, everything else passes
        // through unchanged — a store that cannot be reached, or a Keystore
        // error of the moment, is retryable and must never cost the user
        // their data.
        Err(error) => return Err(error),
    };
    if key.len() != KEY_LEN {
        return Err(lost(slot, &path, "the unwrapped key has the wrong length"));
    }
    log(
        ANDROID_LOG_INFO,
        &format!("unwrapped the {} with the Android Keystore", slot.label()),
    );
    Ok(Some(crate::bytes_to_hex(&key)))
}

pub fn write(slot: Slot, value: &str) -> Result<(), KeyStoreError> {
    let secret = decode_key_hex(value).ok_or_else(|| {
        KeyStoreError::Failed(format!(
            "refusing to wrap a malformed {} value",
            slot.label()
        ))
    })?;
    let path = wrapped_key_path(slot)?;
    let (blob, backing) = with_env(|env| wrap_dek(env, slot, &secret))?;
    write_blob(slot, &path, &blob)?;
    log(
        ANDROID_LOG_INFO,
        &format!(
            "wrapped the {} with a {}-backed Keystore key ({})",
            slot.label(),
            backing_name(backing),
            slot.alias()
        ),
    );
    Ok(())
}

/// Which backing produced the Keystore key that wrapped the DEK, read from the
/// wrapped blob's own header. This reports what actually happened on this
/// device, not what the device might support, and touches no key material.
pub fn backing(slot: Slot) -> Result<&'static str, KeyStoreError> {
    let path = wrapped_key_path(slot)?;
    let blob = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(KeyStoreError::Unavailable(format!(
                "no wrapped {} exists yet",
                slot.label()
            )))
        }
        Err(e) => {
            return Err(KeyStoreError::Unavailable(format!(
                "could not read {}: {e}",
                path.display()
            )))
        }
    };
    let (backing, _, _) = decode_blob(slot, &blob).ok_or_else(|| {
        KeyStoreError::Failed(
            "the wrapped key file is not a blob this build understands".to_string(),
        )
    })?;
    Ok(backing_name(backing))
}

pub fn delete(slot: Slot) -> Result<bool, KeyStoreError> {
    let path = wrapped_key_path(slot)?;
    let mut removed = false;
    match std::fs::remove_file(&path) {
        Ok(()) => removed = true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(KeyStoreError::Failed(format!(
                "could not remove {}: {e}",
                path.display()
            )))
        }
    }
    let alias_removed = with_env(|env| {
        let store = open_key_store(env)?;
        delete_alias(env, &store, slot.alias())
    })?;
    if removed || alias_removed {
        log(
            ANDROID_LOG_INFO,
            &format!(
                "removed the {} ({}): wrapped blob removed={removed}, \
                 Keystore entry removed={alias_removed}",
                slot.label(),
                slot.alias()
            ),
        );
    }
    Ok(removed || alias_removed)
}

fn lost(slot: Slot, path: &Path, reason: &str) -> KeyStoreError {
    KeyStoreError::Lost(format!(
        "the wrapped {} at {} could not be unwrapped ({reason}); the Android Keystore \
         key that protected it is gone, {}",
        slot.label(),
        path.display(),
        slot.loss_consequence()
    ))
}

// ---------------------------------------------------------------------------
// File IO — the wrapped blob
// ---------------------------------------------------------------------------

fn wrapped_key_path(slot: Slot) -> Result<PathBuf, KeyStoreError> {
    let dir = crate::dirs_next_to_db().ok_or_else(|| {
        KeyStoreError::Unavailable(format!(
            "the app data directory is not known yet, so the wrapped {} cannot be found",
            slot.label()
        ))
    })?;
    Ok(dir.join(slot.file()))
}

/// Write the blob with owner-only permissions, temp+rename so a failure can
/// never leave half a key file behind.
fn write_blob(slot: Slot, path: &Path, blob: &[u8]) -> Result<(), KeyStoreError> {
    use std::io::Write;
    let parent = path.parent().ok_or_else(|| {
        KeyStoreError::Failed(format!("{} has no directory to write into", path.display()))
    })?;
    let tmp = parent.join(format!("{}.tmp", slot.file()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Owner-only even though the app data dir is already private: the blob
        // is the only copy of the wrapped DEK.
        options.mode(0o600);
    }
    let mut file = options
        .open(&tmp)
        .map_err(|e| KeyStoreError::Failed(format!("could not create {}: {e}", tmp.display())))?;
    if let Err(e) = file.write_all(blob).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(&tmp);
        return Err(KeyStoreError::Failed(format!(
            "could not write {}: {e}",
            tmp.display()
        )));
    }
    drop(file);
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        KeyStoreError::Failed(format!("could not write {}: {e}", path.display()))
    })
}

fn encode_blob(slot: Slot, backing: u8, iv: &[u8], ciphertext: &[u8]) -> Vec<u8> {
    let mut blob = Vec::with_capacity(HEADER_LEN + iv.len() + ciphertext.len());
    blob.extend_from_slice(slot.magic());
    blob.push(backing);
    blob.push(iv.len() as u8);
    blob.extend_from_slice(iv);
    blob.extend_from_slice(ciphertext);
    blob
}

fn decode_blob(slot: Slot, blob: &[u8]) -> Option<(u8, &[u8], &[u8])> {
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

fn decode_key_hex(key: &str) -> Option<[u8; KEY_LEN]> {
    if key.len() != KEY_LEN * 2 || !key.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let mut secret = [0u8; KEY_LEN];
    for (index, byte) in secret.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&key[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(secret)
}

fn backing_name(backing: u8) -> &'static str {
    match backing {
        BACKING_STRONGBOX => "StrongBox",
        BACKING_TEE => "TEE",
        BACKING_SOFTWARE => "software",
        _ => "unknown",
    }
}

// ---------------------------------------------------------------------------
// Logcat — the only durable place a Rust-side message can be read on device
// (`adb logcat -s PurpleMemo`)
// ---------------------------------------------------------------------------

const ANDROID_LOG_INFO: i32 = 4;
const ANDROID_LOG_ERROR: i32 = 6;

#[link(name = "log")]
extern "C" {
    fn __android_log_write(
        priority: i32,
        tag: *const std::os::raw::c_char,
        text: *const std::os::raw::c_char,
    ) -> i32;
}

fn log(priority: i32, message: &str) {
    let Ok(tag) = std::ffi::CString::new("PurpleMemo") else {
        return;
    };
    let Ok(text) = std::ffi::CString::new(message.replace('\0', " ")) else {
        return;
    };
    // SAFETY: both pointers are NUL-terminated buffers owned by the two
    // CStrings above, which outlive this call; liblog copies what it is given.
    unsafe { __android_log_write(priority, tag.as_ptr(), text.as_ptr()) };
}

// ---------------------------------------------------------------------------
// JNI plumbing
// ---------------------------------------------------------------------------

/// `checked!(env, "what", call)` — the call's value, or a fail-closed error
/// naming what was being attempted. Any pending Java exception is cleared on
/// the way out, so nothing leaks back into the runtime.
macro_rules! checked {
    ($env:ident, $what:expr, $call:expr) => {
        match $call {
            Ok(value) => value,
            Err(_) => return Err(jni_failure($env, $what)),
        }
    };
}

fn jni_failure(env: &mut JNIEnv<'_>, what: &str) -> KeyStoreError {
    if matches!(env.exception_check(), Ok(true)) {
        // ART prints the exception class, message and stack to logcat
        // (`adb logcat -s System.err`), which is the only place a Java
        // exception raised for a native thread can be read on device.
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
    let message = format!(
        "Android Keystore refused {what}; Purple Memo will not fall back to an unprotected key"
    );
    log(ANDROID_LOG_ERROR, &message);
    KeyStoreError::Failed(message)
}

/// The class name of the Java exception pending on `env`, or `None` when
/// there is none (or it cannot be read). The exception is ALWAYS cleared —
/// callers classify it and then continue in their own words, and a leftover
/// exception must never leak into the runtime (the rule `jni_failure` keeps).
fn pending_exception_class(env: &mut JNIEnv<'_>) -> Option<String> {
    if !matches!(env.exception_check(), Ok(true)) {
        return None;
    }
    let throwable = env.exception_occurred().ok()?;
    let _ = env.exception_clear();
    let class = env.get_object_class(&throwable).ok()?;
    let name = env
        .call_method(&class, "getName", "()Ljava/lang/String;", &[])
        .ok()?
        .l()
        .ok()?;
    let text: String = env.get_string(&JString::from(name)).ok()?.into();
    Some(text)
}

fn with_env<T>(
    operation: impl FnOnce(&mut JNIEnv<'_>) -> Result<T, KeyStoreError>,
) -> Result<T, KeyStoreError> {
    let context = std::panic::catch_unwind(ndk_context::android_context).map_err(|_| {
        KeyStoreError::Unavailable(
            "the Android runtime context is not available on this thread".to_string(),
        )
    })?;
    // SAFETY: this is the JavaVM* the Android runtime created for the process.
    // ndk-context only lends it out; it is never owned or freed here.
    let vm = unsafe { JavaVM::from_raw(context.vm().cast()) }.map_err(|e| {
        KeyStoreError::Unavailable(format!("could not reach the Android runtime: {e}"))
    })?;
    let mut env = vm.attach_current_thread().map_err(|e| {
        KeyStoreError::Unavailable(format!("could not attach to the Android runtime: {e}"))
    })?;
    let result = operation(&mut env);
    // Every failure is already reported in our own words, so a leftover Java
    // exception must never surface as a crash later in the frame.
    if matches!(env.exception_check(), Ok(true)) {
        let _ = env.exception_clear();
    }
    result
}

fn open_key_store<'local>(env: &mut JNIEnv<'local>) -> Result<JObject<'local>, KeyStoreError> {
    const WHAT: &str = "to open the Android Keystore";
    let provider = checked!(env, WHAT, env.new_string("AndroidKeyStore"));
    let class = checked!(env, WHAT, env.find_class("java/security/KeyStore"));
    let store = checked!(
        env,
        WHAT,
        env.call_static_method(
            &class,
            "getInstance",
            "(Ljava/lang/String;)Ljava/security/KeyStore;",
            &[JValue::Object(&provider)],
        )
    );
    let store = checked!(env, WHAT, store.l());
    checked!(
        env,
        WHAT,
        env.call_method(
            &store,
            "load",
            "(Ljava/security/KeyStore$LoadStoreParameter;)V",
            &[JValue::Object(&JObject::null())],
        )
    );
    Ok(store)
}

fn sdk_int(env: &mut JNIEnv<'_>) -> Result<i32, KeyStoreError> {
    const WHAT: &str = "to read the Android API level";
    let class = checked!(env, WHAT, env.find_class("android/os/Build$VERSION"));
    let value = checked!(env, WHAT, env.get_static_field(&class, "SDK_INT", "I"));
    Ok(checked!(env, WHAT, value.i()))
}

fn has_alias(
    env: &mut JNIEnv<'_>,
    store: &JObject<'_>,
    alias: &str,
) -> Result<bool, KeyStoreError> {
    const WHAT: &str = "to look up the database wrapping key";
    let alias = checked!(env, WHAT, env.new_string(alias));
    let present = checked!(
        env,
        WHAT,
        env.call_method(
            store,
            "containsAlias",
            "(Ljava/lang/String;)Z",
            &[JValue::Object(&alias)],
        )
    );
    Ok(checked!(env, WHAT, present.z()))
}

fn delete_alias(
    env: &mut JNIEnv<'_>,
    store: &JObject<'_>,
    alias: &str,
) -> Result<bool, KeyStoreError> {
    const WHAT: &str = "to remove the database wrapping key";
    if !has_alias(env, store, alias)? {
        return Ok(false);
    }
    let alias = checked!(env, WHAT, env.new_string(alias));
    checked!(
        env,
        WHAT,
        env.call_method(
            store,
            "deleteEntry",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&alias)],
        )
    );
    Ok(true)
}

fn string_array<'local>(
    env: &mut JNIEnv<'local>,
    values: &[&str],
) -> Result<JObjectArray<'local>, KeyStoreError> {
    const WHAT: &str = "to build the Keystore key spec";
    let array = checked!(
        env,
        WHAT,
        env.new_object_array(values.len() as i32, "java/lang/String", &JObject::null(),)
    );
    for (index, value) in values.iter().enumerate() {
        let element = checked!(env, WHAT, env.new_string(*value));
        checked!(
            env,
            WHAT,
            env.set_object_array_element(&array, index as i32, &element)
        );
    }
    Ok(array)
}

fn cipher<'local>(env: &mut JNIEnv<'local>) -> Result<JObject<'local>, KeyStoreError> {
    const WHAT: &str = "to open an AES-GCM cipher";
    let transformation = checked!(env, WHAT, env.new_string("AES/GCM/NoPadding"));
    let class = checked!(env, WHAT, env.find_class("javax/crypto/Cipher"));
    let cipher = checked!(
        env,
        WHAT,
        env.call_static_method(
            &class,
            "getInstance",
            "(Ljava/lang/String;)Ljavax/crypto/Cipher;",
            &[JValue::Object(&transformation)],
        )
    );
    Ok(checked!(env, WHAT, cipher.l()))
}

fn gcm_spec<'local>(
    env: &mut JNIEnv<'local>,
    iv: &JByteArray<'_>,
) -> Result<JObject<'local>, KeyStoreError> {
    const WHAT: &str = "to build the AES-GCM parameters";
    let class = checked!(
        env,
        WHAT,
        env.find_class("javax/crypto/spec/GCMParameterSpec")
    );
    Ok(checked!(
        env,
        WHAT,
        env.new_object(
            &class,
            "(I[B)V",
            &[JValue::Int(GCM_TAG_BITS), JValue::Object(iv)]
        )
    ))
}

fn secret_key<'local>(
    env: &mut JNIEnv<'local>,
    store: &JObject<'_>,
    slot: Slot,
) -> Result<JObject<'local>, KeyStoreError> {
    const WHAT: &str = "to use the wrapping key";
    let alias = checked!(env, WHAT, env.new_string(slot.alias()));
    let key = checked!(
        env,
        WHAT,
        env.call_method(
            store,
            "getKey",
            "(Ljava/lang/String;[C)Ljava/security/Key;",
            &[JValue::Object(&alias), JValue::Object(&JObject::null())],
        )
    );
    let key = checked!(env, WHAT, key.l());
    if key.is_null() {
        return Err(KeyStoreError::Failed(format!(
            "the Android Keystore no longer holds the {} wrapping key",
            slot.label()
        )));
    }
    Ok(key)
}

/// Create the Keystore wrapping key if it is not there yet, and report which
/// backing it actually got.
fn ensure_kek(env: &mut JNIEnv<'_>, store: &JObject<'_>, slot: Slot) -> Result<u8, KeyStoreError> {
    if has_alias(env, store, slot.alias())? {
        return Ok(read_backing(env, store, slot));
    }
    let sdk = sdk_int(env)?;
    // StrongBox first (API 28+). A device without it refuses the spec, which
    // is a normal fallback to the TEE/software path — not a failure.
    let strongbox = sdk >= 28 && generate_kek(env, slot, true).is_ok();
    if !strongbox {
        generate_kek(env, slot, false).map_err(|_| {
            KeyStoreError::Failed(format!(
                "Android Keystore would not create the {} wrapping key; Purple Memo will \
                 not fall back to an unprotected key",
                slot.label()
            ))
        })?;
    }
    let backing = read_backing(env, store, slot);
    log(
        ANDROID_LOG_INFO,
        &format!(
            "created the Keystore wrapping key {}: strongbox_requested={strongbox}, \
             backing={}",
            slot.alias(),
            backing_name(backing)
        ),
    );
    Ok(backing)
}

fn generate_kek(env: &mut JNIEnv<'_>, slot: Slot, strongbox: bool) -> Result<(), KeyStoreError> {
    const WHAT: &str = "to create the wrapping key";
    let alias = checked!(env, WHAT, env.new_string(slot.alias()));
    let algorithm = checked!(env, WHAT, env.new_string("AES"));
    let provider = checked!(env, WHAT, env.new_string("AndroidKeyStore"));
    let generator_class = checked!(env, WHAT, env.find_class("javax/crypto/KeyGenerator"));
    let generator = checked!(
        env,
        WHAT,
        env.call_static_method(
            &generator_class,
            "getInstance",
            "(Ljava/lang/String;Ljava/lang/String;)Ljavax/crypto/KeyGenerator;",
            &[JValue::Object(&algorithm), JValue::Object(&provider)],
        )
    );
    let generator = checked!(env, WHAT, generator.l());

    let builder_class = checked!(
        env,
        WHAT,
        env.find_class("android/security/keystore/KeyGenParameterSpec$Builder")
    );
    let mut builder = checked!(
        env,
        WHAT,
        env.new_object(
            &builder_class,
            "(Ljava/lang/String;I)V",
            &[
                JValue::Object(&alias),
                JValue::Int(PURPOSE_ENCRYPT | PURPOSE_DECRYPT),
            ],
        )
    );

    let block_modes = string_array(env, &["GCM"])?;
    let value = checked!(
        env,
        WHAT,
        env.call_method(
            &builder,
            "setBlockModes",
            "([Ljava/lang/String;)Landroid/security/keystore/KeyGenParameterSpec$Builder;",
            &[JValue::Object(&block_modes)],
        )
    );
    builder = checked!(env, WHAT, value.l());

    let paddings = string_array(env, &["NoPadding"])?;
    let value = checked!(
        env,
        WHAT,
        env.call_method(
            &builder,
            "setEncryptionPaddings",
            "([Ljava/lang/String;)Landroid/security/keystore/KeyGenParameterSpec$Builder;",
            &[JValue::Object(&paddings)],
        )
    );
    builder = checked!(env, WHAT, value.l());

    // Authentication is the app PIN in mobile-local settings (decision 6), not
    // a Keystore user-authentication requirement: the DEK has to be available
    // before the PIN screen can be drawn over the database.
    let value = checked!(
        env,
        WHAT,
        env.call_method(
            &builder,
            "setUserAuthenticationRequired",
            "(Z)Landroid/security/keystore/KeyGenParameterSpec$Builder;",
            &[JValue::Bool(0)],
        )
    );
    builder = checked!(env, WHAT, value.l());

    let value = checked!(
        env,
        WHAT,
        env.call_method(
            &builder,
            "setKeySize",
            "(I)Landroid/security/keystore/KeyGenParameterSpec$Builder;",
            &[JValue::Int(256)],
        )
    );
    builder = checked!(env, WHAT, value.l());

    if strongbox {
        let value = checked!(
            env,
            WHAT,
            env.call_method(
                &builder,
                "setIsStrongBoxBacked",
                "(Z)Landroid/security/keystore/KeyGenParameterSpec$Builder;",
                &[JValue::Bool(1)],
            )
        );
        builder = checked!(env, WHAT, value.l());
    }

    let spec = checked!(
        env,
        WHAT,
        env.call_method(
            &builder,
            "build",
            "()Landroid/security/keystore/KeyGenParameterSpec;",
            &[],
        )
    );
    let spec = checked!(env, WHAT, spec.l());
    checked!(
        env,
        WHAT,
        env.call_method(
            &generator,
            "init",
            "(Ljava/security/spec/AlgorithmParameterSpec;)V",
            &[JValue::Object(&spec)],
        )
    );
    checked!(
        env,
        WHAT,
        env.call_method(&generator, "generateKey", "()Ljavax/crypto/SecretKey;", &[])
    );
    Ok(())
}

/// Which backing the existing wrapping key uses, best effort: a diagnostic
/// that fails must never fail the key operation itself.
fn read_backing(env: &mut JNIEnv<'_>, store: &JObject<'_>, slot: Slot) -> u8 {
    read_backing_inner(env, store, slot).unwrap_or_else(|_| {
        if matches!(env.exception_check(), Ok(true)) {
            let _ = env.exception_clear();
        }
        BACKING_UNKNOWN
    })
}

fn read_backing_inner(
    env: &mut JNIEnv<'_>,
    store: &JObject<'_>,
    slot: Slot,
) -> Result<u8, KeyStoreError> {
    const WHAT: &str = "to inspect the wrapping key";
    let key = secret_key(env, store, slot)?;
    let algorithm = checked!(
        env,
        WHAT,
        env.call_method(&key, "getAlgorithm", "()Ljava/lang/String;", &[])
    );
    let algorithm = checked!(env, WHAT, algorithm.l());
    let provider = checked!(env, WHAT, env.new_string("AndroidKeyStore"));
    // `SecretKeyFactory` carries the `AndroidKeyStore` AES key spec; the plain
    // `KeyFactory` provider answers `NoSuchAlgorithmException: no such
    // algorithm: AES for provider AndroidKeyStore`.
    let factory_class = checked!(env, WHAT, env.find_class("javax/crypto/SecretKeyFactory"));
    let factory = checked!(
        env,
        WHAT,
        env.call_static_method(
            &factory_class,
            "getInstance",
            "(Ljava/lang/String;Ljava/lang/String;)Ljavax/crypto/SecretKeyFactory;",
            &[JValue::Object(&algorithm), JValue::Object(&provider)],
        )
    );
    let factory = checked!(env, WHAT, factory.l());
    let info_class = checked!(
        env,
        WHAT,
        env.find_class("android/security/keystore/KeyInfo")
    );
    let spec = checked!(
        env,
        WHAT,
        env.call_method(
            &factory,
            "getKeySpec",
            // `SecretKeyFactory.getKeySpec` is declared against `SecretKey`, not
            // `Key`; the `Key` descriptor throws NoSuchMethodError at call time.
            "(Ljavax/crypto/SecretKey;Ljava/lang/Class;)Ljava/security/spec/KeySpec;",
            &[JValue::Object(&key), JValue::Object(&info_class)],
        )
    );
    let spec = checked!(env, WHAT, spec.l());
    // `getSecurityLevel` is API 31+; below that the boolean hardware check is
    // the best answer available.
    let level: i32 = if sdk_int(env)? >= 31 {
        let level = checked!(
            env,
            WHAT,
            env.call_method(&spec, "getSecurityLevel", "()I", &[])
        );
        checked!(env, WHAT, level.i())
    } else {
        let hardware = checked!(
            env,
            WHAT,
            env.call_method(&spec, "isInsideSecureHardware", "()Z", &[])
        );
        if checked!(env, WHAT, hardware.z()) {
            2
        } else {
            1
        }
    };
    Ok(match level {
        3 => BACKING_STRONGBOX,
        2 => BACKING_TEE,
        _ => BACKING_SOFTWARE,
    })
}

fn wrap_dek(
    env: &mut JNIEnv<'_>,
    slot: Slot,
    secret: &[u8],
) -> Result<(Vec<u8>, u8), KeyStoreError> {
    const WHAT: &str = "to wrap the key";
    let store = open_key_store(env)?;
    let backing = ensure_kek(env, &store, slot)?;
    let key = secret_key(env, &store, slot)?;
    let cipher = cipher(env)?;

    // The Keystore generates the IV, not us: a Keystore key refuses a
    // caller-supplied GCM IV at `init` (on the Redmi:
    // `InvalidAlgorithmParameterException: Caller-provided IV not permitted`),
    // so `getIV` is the only way to learn it. Randomized encryption stays
    // required, which is what keeps the provider's IV unique per operation.
    checked!(
        env,
        WHAT,
        env.call_method(
            &cipher,
            "init",
            "(ILjava/security/Key;)V",
            &[JValue::Int(PURPOSE_ENCRYPT), JValue::Object(&key)],
        )
    );
    let iv = keystore_iv(env, &cipher)?;

    let plaintext = checked!(env, WHAT, env.byte_array_from_slice(secret));
    let out = checked!(
        env,
        WHAT,
        env.new_byte_array((secret.len() + GCM_TAG_LEN) as i32)
    );
    let written = checked!(
        env,
        WHAT,
        env.call_method(
            &cipher,
            "doFinal",
            "([BII[BI)I",
            &[
                JValue::Object(&plaintext),
                JValue::Int(0),
                JValue::Int(secret.len() as i32),
                JValue::Object(&out),
                JValue::Int(0),
            ],
        )
    );
    let written = checked!(env, WHAT, written.i());
    let ciphertext = read_bytes(env, &out, written)?;
    Ok((encode_blob(slot, backing, &iv, &ciphertext), backing))
}

fn unwrap_dek(
    env: &mut JNIEnv<'_>,
    slot: Slot,
    iv: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, KeyStoreError> {
    const WHAT: &str = "to unwrap the key";
    let store = open_key_store(env)?;
    // Checked explicitly: a missing alias is one of the two proofs of loss
    // (see the module's failure policy), so it reads as `Lost` directly, not
    // as a generic cipher failure.
    if !has_alias(env, &store, slot.alias())? {
        return Err(KeyStoreError::Lost(format!(
            "the Keystore key {} that wrapped the {} is gone; {}",
            slot.alias(),
            slot.label(),
            slot.loss_consequence()
        )));
    }
    let key = secret_key(env, &store, slot)?;
    let cipher = cipher(env)?;

    let iv_array = checked!(env, WHAT, env.byte_array_from_slice(iv));
    let spec = gcm_spec(env, &iv_array)?;
    checked!(
        env,
        WHAT,
        env.call_method(
            &cipher,
            "init",
            "(ILjava/security/Key;Ljava/security/spec/AlgorithmParameterSpec;)V",
            &[
                JValue::Int(PURPOSE_DECRYPT),
                JValue::Object(&key),
                JValue::Object(&spec),
            ],
        )
    );

    let input = checked!(env, WHAT, env.byte_array_from_slice(ciphertext));
    let out = checked!(env, WHAT, env.new_byte_array(KEY_LEN as i32));
    // doFinal is where the second proof of loss lives, so it is not a plain
    // `checked!`: an AEAD authentication failure means this blob was not
    // wrapped by this key (or is corrupt) and no retry will ever open it —
    // that is `Lost`. Any other failure here is a Keystore/provider problem
    // of the moment and stays `Failed`: fail closed, keep the data.
    let written = match env.call_method(
        &cipher,
        "doFinal",
        "([BII[BI)I",
        &[
            JValue::Object(&input),
            JValue::Int(0),
            JValue::Int(ciphertext.len() as i32),
            JValue::Object(&out),
            JValue::Int(0),
        ],
    ) {
        Ok(value) => checked!(env, WHAT, value.i()),
        Err(_) => {
            if pending_exception_class(env).as_deref() == Some("javax.crypto.AEADBadTagException") {
                return Err(KeyStoreError::Lost(format!(
                    "the Keystore key {} refuses the wrapped {} (its \
                     authentication tag does not verify); {}",
                    slot.alias(),
                    slot.label(),
                    slot.loss_consequence()
                )));
            }
            return Err(jni_failure(env, WHAT));
        }
    };
    read_bytes(env, &out, written)
}

/// Read the IV the Keystore generated for an encryption operation. The
/// provider hands it out as a fresh Java array, so it is copied through a
/// Rust-owned buffer the same way every other result is read.
fn keystore_iv(env: &mut JNIEnv<'_>, cipher: &JObject<'_>) -> Result<Vec<u8>, KeyStoreError> {
    const WHAT: &str = "to read the IV the Android Keystore generated";
    let generated = checked!(env, WHAT, env.call_method(cipher, "getIV", "()[B", &[]));
    let generated = checked!(env, WHAT, generated.l());
    let buffer = checked!(env, WHAT, env.new_byte_array(IV_LEN as i32));
    checked!(
        env,
        WHAT,
        env.call_static_method(
            "java/lang/System",
            "arraycopy",
            "(Ljava/lang/Object;ILjava/lang/Object;II)V",
            &[
                JValue::Object(&generated),
                JValue::Int(0),
                JValue::Object(&buffer),
                JValue::Int(0),
                JValue::Int(IV_LEN as i32),
            ],
        )
    );
    let iv = read_bytes(env, &buffer, IV_LEN as i32)?;
    if iv.len() != IV_LEN {
        return Err(KeyStoreError::Failed(
            "the Android Keystore returned an IV of the wrong size".to_string(),
        ));
    }
    Ok(iv)
}

fn read_bytes(
    env: &mut JNIEnv<'_>,
    array: &JByteArray<'_>,
    length: i32,
) -> Result<Vec<u8>, KeyStoreError> {
    if !(0..=KEY_LEN as i32 + GCM_TAG_LEN as i32).contains(&length) {
        return Err(KeyStoreError::Failed(format!(
            "the Keystore returned an unexpected {length}-byte result"
        )));
    }
    let mut buffer = vec![0i8; length as usize];
    let filled = match env.get_byte_array_region(array, 0, &mut buffer) {
        Ok(()) => buffer,
        Err(_) => {
            return Err(jni_failure(
                env,
                "to read the result of the Android Keystore operation",
            ))
        }
    };
    Ok(filled.into_iter().map(|byte| byte as u8).collect())
}
