//! Android biometric unlock: the phone's fingerprint/face prompt, as the extra
//! unlock path beside the PIN.
//!
//! `BiometricPrompt` is interactive and asynchronous — it attaches a fragment to
//! the live Activity and answers through a callback — so this cannot be the
//! synchronous request/response JNI call the reminder bridge's commands are. The
//! Kotlin side (`BiometricBridge.kt`) posts the prompt on the main thread and
//! blocks the calling thread until the callback fires; these two commands are
//! the seam that reaches it, and they never throw across JNI: every outcome is a
//! result *string*.
//!
//! Nothing here unlocks anything by itself. The database key is unwrapped at
//! boot, before any lock screen exists, so a `success` is the same evidence a
//! correct PIN is — the PIN stays the root unlock and the permanent fallback,
//! and the Keystore wrapping is unchanged.
//!
//! Off Android both commands answer `"unavailable"`, which is a status the UI
//! can render. That deliberately differs from
//! [`crate::reminders::DESKTOP_REFUSAL`]: a desktop has no biometric surface to
//! refuse, and the lock screen must keep offering the PIN unchanged.

/// The only answer a build without the bridge can give.
const UNAVAILABLE: &str = "unavailable";

/// `"available"`, `"none-enrolled"`, `"no-hardware"` or `"unavailable"` —
/// whether a strong-biometric prompt could be shown right now.
#[tauri::command]
pub fn biometric_status() -> Result<String, String> {
    call("status")
}

/// Show the prompt and report what it did: `"success"`, `"cancelled"`,
/// `"failed"`, `"lockout"` or `"unavailable"`.
///
/// `title` and `negative_button` are the prompt's own words, supplied by the
/// renderer from the app's catalogue: the bridge cannot read the encrypted
/// settings row that holds the language choice, so `res/values` (which follows
/// the phone's *system* locale) would be the wrong source. The bridge falls back
/// to its own defaults when either string is blank.
///
/// Asynchronous and on a blocking thread on purpose: the prompt waits for a
/// human, and the one thread that must never wait is the main thread — that is
/// the ANR this avoids. The Kotlin side already waits off the UI thread; running
/// the call through `spawn_blocking` also keeps a multi-minute wait out of the
/// async runtime's worker pool.
#[tauri::command]
pub async fn biometric_authenticate(
    title: String,
    negative_button: String,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            android::call_two_strings(android::BRIDGE, "authenticate", &title, &negative_button)
        })
        .await
        .map_err(|e| format!("the biometric prompt could not be awaited: {e}"))?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (title, negative_button);
        Ok(UNAVAILABLE.to_string())
    }
}

/// One bridge method name, on the platform that has a bridge.
fn call(method: &str) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        android::call_no_arg_string(android::BRIDGE, method)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = method;
        Ok(UNAVAILABLE.to_string())
    }
}

/// The JNI plumbing for one bridge class.
///
/// A local copy of [`crate::reminders::android`]'s call pattern (that module is
/// private): the same `with_env` / `app_class` / `call_no_arg_string` shapes and
/// the same error wording, kept here rather than moved so the reminder path does
/// not change to serve this one. Both biometric methods take and return plain
/// strings: `status()` takes none, `authenticate()` takes the prompt's title and
/// escape-hatch label.
#[cfg(target_os = "android")]
mod android {
    use jni::objects::{JClass, JObject, JString, JValue, JValueOwned};
    use jni::{JNIEnv, JavaVM};

    /// The app's own bridge class, resolved through the *app's* class loader —
    /// `FindClass` from a native thread uses the system loader, which cannot see
    /// app classes.
    pub const BRIDGE: &str = "com.minlulin.purplememo.BiometricBridge";

    /// Run `f` on a thread attached to the app's JVM.
    fn with_env<T>(f: impl FnOnce(&mut JNIEnv) -> Result<T, String>) -> Result<T, String> {
        let context = ndk_context::android_context();
        // SAFETY: `vm()` is the process's single JavaVM, created by the Android
        // runtime and valid until the process exits. `from_raw` only wraps the
        // pointer — the `JavaVM` never owns or frees it — so it may be rebuilt
        // from the same pointer on every call, and the thread's attachment is
        // released by the guard below.
        let vm = unsafe { JavaVM::from_raw(context.vm().cast()) }
            .map_err(|e| format!("the Android JVM is not reachable: {e}"))?;
        let mut guard = vm
            .attach_current_thread()
            .map_err(|e| format!("could not attach to the Android JVM: {e}"))?;
        let env: &mut JNIEnv = &mut guard;
        f(env)
    }

    /// Resolve the app's bridge class through its own class loader.
    fn app_class<'a>(env: &mut JNIEnv<'a>, name: &str) -> Result<JClass<'a>, String> {
        let thread = env
            .find_class("android/app/ActivityThread")
            .map_err(|e| format!("android.app.ActivityThread is not reachable: {e}"))?;
        let application = env
            .call_static_method(
                thread,
                "currentApplication",
                "()Landroid/app/Application;",
                &[],
            )
            .and_then(|v| v.l())
            .map_err(|e| format!("could not reach the application object: {e}"))?;
        if application.is_null() {
            return Err("the application object is not available yet".to_string());
        }
        let loader = env
            .call_method(
                &application,
                "getClassLoader",
                "()Ljava/lang/ClassLoader;",
                &[],
            )
            .and_then(|v| v.l())
            .map_err(|e| format!("could not reach the app class loader: {e}"))?;
        let jname = env
            .new_string(name)
            .map_err(|e| format!("could not allocate the class name: {e}"))?;
        let loaded = env
            .call_method(
                &loader,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[JValue::Object(&jname.into())],
            )
            .and_then(|v| v.l())
            .map_err(|e| format!("{name} is not on the app's class path: {e}"))?;
        Ok(JClass::from(loaded))
    }

    /// Keep the JNI failure visible: the Java exception text is what turns a
    /// generic "method not found" into a fixable bug.
    fn throwable_message(env: &mut JNIEnv, caught: jni::errors::Error) -> String {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
        format!("{caught}")
    }

    /// Read a Java `String` out of a call's return value.
    fn string_result<'local>(
        env: &mut JNIEnv<'local>,
        value: JValueOwned<'local>,
        method: &str,
    ) -> Result<String, String> {
        let object = value
            .l()
            .map_err(|e| format!("{method} did not return a string: {e}"))?;
        let text: String = env
            .get_string(&JString::from(object))
            .map_err(|e| format!("could not read the {method} result: {e}"))?
            .into();
        Ok(text)
    }

    /// Call a static `() -> String` bridge method.
    pub fn call_no_arg_string(class: &str, method: &str) -> Result<String, String> {
        with_env(|env| {
            let target = app_class(env, class)?;
            let value = env
                .call_static_method(&target, method, "()Ljava/lang/String;", &[])
                .map_err(|e| throwable_message(env, e))?;
            string_result(env, value, method)
        })
    }

    /// Call a static `(String, String) -> String` bridge method.
    pub fn call_two_strings(
        class: &str,
        method: &str,
        first: &str,
        second: &str,
    ) -> Result<String, String> {
        with_env(|env| {
            let target = app_class(env, class)?;
            let a = env
                .new_string(first)
                .map_err(|e| format!("could not allocate the prompt title: {e}"))?;
            let b = env
                .new_string(second)
                .map_err(|e| format!("could not allocate the prompt button text: {e}"))?;
            let a: JObject = a.into();
            let b: JObject = b.into();
            let value = env
                .call_static_method(
                    &target,
                    method,
                    "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                    &[JValue::Object(&a), JValue::Object(&b)],
                )
                .map_err(|e| throwable_message(env, e))?;
            string_result(env, value, method)
        })
    }
}
