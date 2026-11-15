//! Android platform surfaces for Session 5: **native reminder delivery** and
//! the **sensitive clipboard** copy.
//!
//! Reminders cannot be delivered by the in-app poll once Android backgrounds
//! the process, so scheduling goes through the app's own Kotlin bridge
//! (`gen/android/.../Reminders.kt`), which arms `AlarmManager` alarms: exact
//! when the exact-alarm permission is held, inexact (`setAndAllowWhileIdle`)
//! when it is not, and a `BroadcastReceiver` that posts the notification while
//! Purple Memo is closed. Alarms do not survive a reboot, so the bridge keeps
//! the armed set in device-local preferences and re-arms it from a
//! `BOOT_COMPLETED` receiver.
//!
//! Everything here is **app code calling the Android framework** — there is no
//! simulated scheduler and no fake clipboard on this path. On desktop the same
//! commands exist but refuse with [`DESKTOP_REFUSAL`], because the desktop
//! reminder poll and `navigator.clipboard` are unchanged.

use serde::{Deserialize, Serialize};

/// Returned by every command here when the app is running on a desktop. The
/// frontend only calls these on Android; a refusal is the honest answer if it
/// ever does not.
pub const DESKTOP_REFUSAL: &str =
    "reminder scheduling and the sensitive clipboard are Android-only surfaces";

/// One pending reminder, as the app shell sends it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReminderSyncRow {
    pub id: i64,
    pub title: String,
    pub body: String,
    /// Local `yyyy-MM-ddTHH:mm`, the same shape the database stores.
    pub due: String,
}

/// What the phone did with the rows, and which alarms fired since last sync.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReminderSyncReport {
    /// True when exact alarms are permitted, false when the inexact fallback is
    /// in use. The UI discloses this.
    pub exact: bool,
    /// Ids whose alarm fired since the previous sync — device-local delivery
    /// state. The app settles those rows without notifying a second time.
    pub delivered: Vec<i64>,
    pub scheduled: i64,
    pub inexact: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Reconcile the phone's armed alarms with the app's pending reminders.
#[tauri::command]
pub fn reminder_sync(rows: Vec<ReminderSyncRow>) -> Result<ReminderSyncReport, String> {
    #[cfg(target_os = "android")]
    {
        let payload = serde_json::to_string(&rows).map_err(|e| e.to_string())?;
        let raw = android::call_string(android::BRIDGE, "sync", &payload)?;
        let report: ReminderSyncReport =
            serde_json::from_str(&raw).map_err(|e| format!("unreadable reminder report: {e}"))?;
        Ok(report)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = rows;
        Err(DESKTOP_REFUSAL.to_string())
    }
}

/// After a factory reset, forget the phone's armed reminders and delivery
/// records too: they live OUTSIDE the database the reset engine wipes
/// (AlarmManager registrations and the bridge's SharedPreferences), so
/// without this an old reminder still fires for a record that no longer
/// exists — and, reminder row ids restarting at 1, a stale delivered id
/// could settle a new reminder that never fired. Best-effort by design: the
/// reset has already happened, so a bridge failure must never turn a
/// completed reset into a failed one. Not a command; called from the two
/// reset paths. A no-op off Android, where this state does not exist.
pub fn clear_reminder_state_after_reset() {
    #[cfg(target_os = "android")]
    {
        let _ = android::call_void(android::BRIDGE, "clearAll");
    }
}

/// `"exact"`, `"inexact"`, or `"unknown"` — what the reminder UI must say.
#[tauri::command]
pub fn reminder_exact_state() -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        android::call_no_arg_string(android::BRIDGE, "exactState")
    }
    #[cfg(not(target_os = "android"))]
    {
        Err(DESKTOP_REFUSAL.to_string())
    }
}

/// Open the OS screen that grants exact alarms. Never pretends to grant it.
#[tauri::command]
pub fn reminder_open_exact_alarm_settings() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        android::call_void(android::BRIDGE, "openExactAlarmSettings")
    }
    #[cfg(not(target_os = "android"))]
    {
        Err(DESKTOP_REFUSAL.to_string())
    }
}

/// Copy `text` as a **sensitive** clip and clear it after the bridge's
/// best-effort delay (30 s). Returns the delay used, so the UI can disclose it.
#[tauri::command]
pub fn clipboard_copy_sensitive(text: String) -> Result<u64, String> {
    #[cfg(target_os = "android")]
    {
        let delay = android::call_long(android::CLIPBOARD, "copy", &text)?;
        Ok(delay.max(0) as u64)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = text;
        Err(DESKTOP_REFUSAL.to_string())
    }
}

/// `"software"`, `"TEE"`, `"StrongBox"` or `"unknown"` — the backing that
/// actually wrapped the database key, read from the wrapped blob's header.
/// Diagnostics only; no key material is returned.
#[tauri::command]
pub fn keystore_backing() -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        crate::key_store::backing(crate::key_store::Slot::Database)
            .map(str::to_string)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        Err(DESKTOP_REFUSAL.to_string())
    }
}

/// Debug-only probe: read the current clipboard so a device test can prove the
/// value is gone after the timer. Release builds refuse.
#[tauri::command]
pub fn clipboard_probe_read() -> Result<String, String> {
    #[cfg(all(target_os = "android", debug_assertions))]
    {
        android::call_no_arg_string(android::CLIPBOARD, "read")
    }
    #[cfg(not(all(target_os = "android", debug_assertions)))]
    {
        Err("the clipboard probe exists only in debug Android builds".to_string())
    }
}

#[cfg(target_os = "android")]
mod android {
    use jni::objects::{JClass, JString, JValue};
    use jni::{JNIEnv, JavaVM};

    /// The app's own bridge classes. Resolved through the *app's* class loader —
    /// `FindClass` from a native thread uses the system loader, which cannot see
    /// app classes.
    pub const BRIDGE: &str = "com.minlulin.purplememo.ReminderBridge";
    pub const CLIPBOARD: &str = "com.minlulin.purplememo.SensitiveClipboard";

    /// Run `f` on a thread attached to the app's JVM.
    fn with_env<T>(f: impl FnOnce(&mut JNIEnv) -> Result<T, String>) -> Result<T, String> {
        let context = ndk_context::android_context();
        let vm = unsafe { JavaVM::from_raw(context.vm().cast()) }
            .map_err(|e| format!("the Android JVM is not reachable: {e}"))?;
        let mut guard = vm
            .attach_current_thread()
            .map_err(|e| format!("could not attach to the Android JVM: {e}"))?;
        let env: &mut JNIEnv = &mut guard;
        f(env)
    }

    /// Resolve one of the app's classes through its own class loader.
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

    /// Call a static `(String) -> String` bridge method.
    pub fn call_string(class: &str, method: &str, argument: &str) -> Result<String, String> {
        with_env(|env| {
            let target = app_class(env, class)?;
            let jarg = env
                .new_string(argument)
                .map_err(|e| format!("could not pass the payload to {method}: {e}"))?;
            let value = env
                .call_static_method(
                    &target,
                    method,
                    "(Ljava/lang/String;)Ljava/lang/String;",
                    &[JValue::Object(&jarg.into())],
                )
                .map_err(|e| throwable_message(env, e))?;
            let object = value
                .l()
                .map_err(|e| format!("{method} did not return a string: {e}"))?;
            let text: String = env
                .get_string(&JString::from(object))
                .map_err(|e| format!("could not read the {method} result: {e}"))?
                .into();
            Ok(text)
        })
    }

    /// Call a static `(String) -> long` bridge method.
    pub fn call_long(class: &str, method: &str, argument: &str) -> Result<i64, String> {
        with_env(|env| {
            let target = app_class(env, class)?;
            let jarg = env
                .new_string(argument)
                .map_err(|e| format!("could not pass the value to {method}: {e}"))?;
            let value = env
                .call_static_method(
                    &target,
                    method,
                    "(Ljava/lang/String;)J",
                    &[JValue::Object(&jarg.into())],
                )
                .map_err(|e| throwable_message(env, e))?;
            value
                .j()
                .map_err(|e| format!("{method} did not return a long: {e}"))
        })
    }

    /// Call a static `() -> String` bridge method.
    pub fn call_no_arg_string(class: &str, method: &str) -> Result<String, String> {
        with_env(|env| {
            let target = app_class(env, class)?;
            let value = env
                .call_static_method(&target, method, "()Ljava/lang/String;", &[])
                .map_err(|e| throwable_message(env, e))?;
            let object = value
                .l()
                .map_err(|e| format!("{method} did not return a string: {e}"))?;
            let text: String = env
                .get_string(&JString::from(object))
                .map_err(|e| format!("could not read the {method} result: {e}"))?
                .into();
            Ok(text)
        })
    }

    /// Call a static `() -> void` bridge method.
    pub fn call_void(class: &str, method: &str) -> Result<(), String> {
        with_env(|env| {
            let target = app_class(env, class)?;
            env.call_static_method(&target, method, "()V", &[])
                .map_err(|e| throwable_message(env, e))?;
            Ok(())
        })
    }
}
