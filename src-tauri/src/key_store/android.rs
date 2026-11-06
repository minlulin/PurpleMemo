//! Android backend of the key-store seam: the DEK is wrapped by a
//! non-exportable AES-256 key that lives in the **Android Keystore**.
//!
//! Why this shape:
//!
//! * The Keystore key is generated inside the platform (StrongBox or TEE where
//!   the device offers one, software otherwise) and can never be exported. Its
//!   only uses are `PURPOSE_ENCRYPT` and `PURPOSE_DECRYPT`, so a copy of the app
//!   data dir is useless without the device.
//! * The DEK itself is minted by `db::mint_key_hex` (OS CSPRNG) and immediately
//!   wrapped with AES-256-GCM under that Keystore key. Only the wrapped blob is
//!   written to disk (`db-key.wrapped`, app-private, mode 0600), so the DEK is
//!   never stored in the clear.
//! * The blob's header records which backing actually produced the wrapping key,
//!   so the answer to "was this device StrongBox-backed?" survives on disk.
//!
//! Failure policy, per design decision 6:
//!
//! * Keystore unavailable / operation refused → [`KeyStoreError::Failed`] or
//!   [`KeyStoreError::Unavailable`]. The app fails closed with a clear message.
//!   There is no software fallback and no "unprotected key" path anywhere in
//!   this module.
//! * The wrapping key is gone (or cannot unwrap the blob) → the DEK is
//!   unrecoverable → [`KeyStoreError::Lost`], which `boot` turns into the
//!   fail-closed wipe + re-pair path.
//!
//! JNI plumbing note: only **framework** classes (`java.security.KeyStore`,
//! `javax.crypto.Cipher`, `android.security.keystore.*`) are touched, resolved
//! with `FindClass` from an attached native thread. Framework classes come from
//! the boot class loader, so they resolve from any thread without needing the
//! app's own class loader or a Kotlin-side helper.

use std::path::{Path, PathBuf};

use jni::objects::{JByteArray, JObject, JObjectArray, JValue};
use jni::{JNIEnv, JavaVM};

use super::KeyStoreError;

/// The Keystore alias holding the non-exportable wrapping key. Versioned so a
/// future rotation can mint a second alias instead of reusing this one.
const KEK_ALIAS: &str = "purple_memo_db_key_wrap_v1";

/// The wrapped DEK, written next to the database in the app's private data
/// dir. Removed by the reset path along with the Keystore alias.
pub const WRAPPED_KEY_FILE: &str = "db-key.wrapped";

const BLOB_MAGIC: &[u8; 5] = b"PMKW1";
/// magic + backing byte + IV length byte.
const HEADER_LEN: usize = BLOB_MAGIC.len() + 2;
const IV_LEN: usize = 12;
const GCM_TAG_BITS: i32 = 128;
const GCM_TAG_LEN: usize = 16;
const DEK_LEN: usize = 32;
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

pub fn read() -> Result<Option<String>, KeyStoreError> {
    let path = wrapped_key_path()?;
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
    let (_, iv, ciphertext) = decode_blob(&blob).ok_or_else(|| {
        lost(
            &path,
            "the wrapped key file is not a blob this build understands",
        )
    })?;
    let dek = match with_env(|env| unwrap_dek(env, iv, ciphertext)) {
        Ok(dek) => dek,
        // A store that cannot be reached at all is retryable and must never
        // cost the user their data.
        Err(KeyStoreError::Unavailable(message)) => {
            return Err(KeyStoreError::Unavailable(message))
        }
        // Everything else here means the Keystore key is gone or refuses this
        // blob: the DEK can never be recovered.
        Err(other) => return Err(lost(&path, other.message())),
    };
    if dek.len() != DEK_LEN {
        return Err(lost(&path, "the unwrapped key has the wrong length"));
    }
    log(
        ANDROID_LOG_INFO,
        "unwrapped the database key with the Android Keystore",
    );
    Ok(Some(crate::bytes_to_hex(&dek)))
}

pub fn write(key: &str) -> Result<(), KeyStoreError> {
    let dek = decode_key_hex(key).ok_or_else(|| {
        KeyStoreError::Failed("refusing to wrap a malformed DB encryption key".to_string())
    })?;
    let path = wrapped_key_path()?;
    let (blob, backing) = with_env(|env| wrap_dek(env, &dek))?;
    write_blob(&path, &blob)?;
    log(
        ANDROID_LOG_INFO,
        &format!(
            "wrapped the database key with a {}-backed Keystore key ({KEK_ALIAS})",
            backing_name(backing)
        ),
    );
    Ok(())
}

/// Which backing produced the Keystore key that wrapped the DEK, read from the
/// wrapped blob's own header. This reports what actually happened on this
/// device, not what the device might support, and touches no key material.
pub fn backing() -> Result<&'static str, KeyStoreError> {
    let path = wrapped_key_path()?;
    let blob = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(KeyStoreError::Unavailable(
                "no wrapped database key exists yet".to_string(),
            ))
        }
        Err(e) => {
            return Err(KeyStoreError::Unavailable(format!(
                "could not read {}: {e}",
                path.display()
            )))
        }
    };
    let (backing, _, _) = decode_blob(&blob).ok_or_else(|| {
        KeyStoreError::Failed(
            "the wrapped key file is not a blob this build understands".to_string(),
        )
    })?;
    Ok(backing_name(backing))
}

pub fn delete() -> Result<bool, KeyStoreError> {
    let path = wrapped_key_path()?;
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
        delete_alias(env, &store, KEK_ALIAS)
    })?;
    if removed || alias_removed {
        log(
            ANDROID_LOG_INFO,
            &format!(
                "removed the database key ({KEK_ALIAS}): wrapped blob removed={removed}, \
                 Keystore entry removed={alias_removed}"
            ),
        );
    }
    Ok(removed || alias_removed)
}

fn lost(path: &Path, reason: &str) -> KeyStoreError {
    KeyStoreError::Lost(format!(
        "the wrapped database key at {} could not be unwrapped ({reason}); the Android Keystore \
         key that protected it is gone, so this copy of the data cannot be opened",
        path.display()
    ))
}

// ---------------------------------------------------------------------------
// File IO — the wrapped blob
// ---------------------------------------------------------------------------

fn wrapped_key_path() -> Result<PathBuf, KeyStoreError> {
    let dir = crate::dirs_next_to_db().ok_or_else(|| {
        KeyStoreError::Unavailable(
            "the app data directory is not known yet, so the wrapped database key cannot be found"
                .to_string(),
        )
    })?;
    Ok(dir.join(WRAPPED_KEY_FILE))
}

/// Write the blob with owner-only permissions, temp+rename so a failure can
/// never leave half a key file behind.
fn write_blob(path: &Path, blob: &[u8]) -> Result<(), KeyStoreError> {
    use std::io::Write;
    let parent = path.parent().ok_or_else(|| {
        KeyStoreError::Failed(format!("{} has no directory to write into", path.display()))
    })?;
    let tmp = parent.join(format!("{WRAPPED_KEY_FILE}.tmp"));
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

fn encode_blob(backing: u8, iv: &[u8], ciphertext: &[u8]) -> Vec<u8> {
    let mut blob = Vec::with_capacity(HEADER_LEN + iv.len() + ciphertext.len());
    blob.extend_from_slice(BLOB_MAGIC);
    blob.push(backing);
    blob.push(iv.len() as u8);
    blob.extend_from_slice(iv);
    blob.extend_from_slice(ciphertext);
    blob
}

fn decode_blob(blob: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    if blob.len() < HEADER_LEN || &blob[..BLOB_MAGIC.len()] != BLOB_MAGIC {
        return None;
    }
    let backing = blob[BLOB_MAGIC.len()];
    let iv_len = blob[BLOB_MAGIC.len() + 1] as usize;
    if iv_len == 0 || iv_len > 32 {
        return None;
    }
    let iv_end = HEADER_LEN.checked_add(iv_len)?;
    if blob.len() < iv_end + DEK_LEN + GCM_TAG_LEN {
        return None;
    }
    Some((backing, &blob[HEADER_LEN..iv_end], &blob[iv_end..]))
}

fn decode_key_hex(key: &str) -> Option<[u8; DEK_LEN]> {
    if key.len() != DEK_LEN * 2 || !key.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let mut dek = [0u8; DEK_LEN];
    for (index, byte) in dek.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&key[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(dek)
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
) -> Result<JObject<'local>, KeyStoreError> {
    const WHAT: &str = "to use the database wrapping key";
    let alias = checked!(env, WHAT, env.new_string(KEK_ALIAS));
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
        return Err(KeyStoreError::Failed(
            "the Android Keystore no longer holds the database wrapping key".to_string(),
        ));
    }
    Ok(key)
}

/// Create the Keystore wrapping key if it is not there yet, and report which
/// backing it actually got.
fn ensure_kek(env: &mut JNIEnv<'_>, store: &JObject<'_>) -> Result<u8, KeyStoreError> {
    if has_alias(env, store, KEK_ALIAS)? {
        return Ok(read_backing(env, store));
    }
    let sdk = sdk_int(env)?;
    // StrongBox first (API 28+). A device without it refuses the spec, which
    // is a normal fallback to the TEE/software path — not a failure.
    let strongbox = sdk >= 28 && generate_kek(env, true).is_ok();
    if !strongbox {
        generate_kek(env, false).map_err(|_| {
            KeyStoreError::Failed(
                "Android Keystore would not create the database wrapping key; Purple Memo will \
                 not fall back to an unprotected key"
                    .to_string(),
            )
        })?;
    }
    let backing = read_backing(env, store);
    log(
        ANDROID_LOG_INFO,
        &format!(
            "created the Keystore wrapping key {KEK_ALIAS}: strongbox_requested={strongbox}, \
             backing={}",
            backing_name(backing)
        ),
    );
    Ok(backing)
}

fn generate_kek(env: &mut JNIEnv<'_>, strongbox: bool) -> Result<(), KeyStoreError> {
    const WHAT: &str = "to create the database wrapping key";
    let alias = checked!(env, WHAT, env.new_string(KEK_ALIAS));
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
fn read_backing(env: &mut JNIEnv<'_>, store: &JObject<'_>) -> u8 {
    read_backing_inner(env, store).unwrap_or_else(|_| {
        if matches!(env.exception_check(), Ok(true)) {
            let _ = env.exception_clear();
        }
        BACKING_UNKNOWN
    })
}

fn read_backing_inner(env: &mut JNIEnv<'_>, store: &JObject<'_>) -> Result<u8, KeyStoreError> {
    const WHAT: &str = "to inspect the database wrapping key";
    let key = secret_key(env, store)?;
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

fn wrap_dek(env: &mut JNIEnv<'_>, dek: &[u8]) -> Result<(Vec<u8>, u8), KeyStoreError> {
    const WHAT: &str = "to wrap the database key";
    let store = open_key_store(env)?;
    let backing = ensure_kek(env, &store)?;
    let key = secret_key(env, &store)?;
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

    let plaintext = checked!(env, WHAT, env.byte_array_from_slice(dek));
    let out = checked!(
        env,
        WHAT,
        env.new_byte_array((dek.len() + GCM_TAG_LEN) as i32)
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
                JValue::Int(dek.len() as i32),
                JValue::Object(&out),
                JValue::Int(0),
            ],
        )
    );
    let written = checked!(env, WHAT, written.i());
    let ciphertext = read_bytes(env, &out, written)?;
    Ok((encode_blob(backing, &iv, &ciphertext), backing))
}

fn unwrap_dek(
    env: &mut JNIEnv<'_>,
    iv: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, KeyStoreError> {
    const WHAT: &str = "to unwrap the database key";
    let store = open_key_store(env)?;
    // Checked explicitly: a missing alias must read as "the key is gone", not
    // as a generic cipher failure.
    if !has_alias(env, &store, KEK_ALIAS)? {
        return Err(KeyStoreError::Failed(format!(
            "the Keystore key {KEK_ALIAS} that wrapped the database key is gone"
        )));
    }
    let key = secret_key(env, &store)?;
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
    let out = checked!(env, WHAT, env.new_byte_array(DEK_LEN as i32));
    let written = checked!(
        env,
        WHAT,
        env.call_method(
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
        )
    );
    let written = checked!(env, WHAT, written.i());
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
    if !(0..=DEK_LEN as i32 + GCM_TAG_LEN as i32).contains(&length) {
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
