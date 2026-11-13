//! Opening an external link in the phone's browser.
//!
//! Desktop hands URLs to `plugin-opener`; that plugin is deliberately absent on
//! Android (`docs/ANDROID_IPC_SURFACE.md` finding #3), so the phone needs its own
//! path. It is a `VIEW` intent started from the application context, which is why
//! `FLAG_ACTIVITY_NEW_TASK` is required — a Context that is not an Activity may
//! not start one without it.
//!
//! The URL is validated here as well as in the webview (`lib/externalLinks.ts`):
//! note text and imported backups can contain any scheme, and the boundary that
//! reaches another app is worth checking twice.

/// Longest URL this app will hand over. Well past any real link, short enough
/// that a pathological row cannot be turned into a megabyte-long intent.
const MAX_URL_LEN: usize = 2_048;

/// Open `url` with whatever app the system has registered for HTTP(S).
///
/// Fails loudly instead of doing nothing: the UI turns the error into a toast,
/// which is honest about a tap that could not be served.
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let url = validate(&url)?;
    open_in_browser(url)
}

/// Accept only an absolute, unpadded http(s) URL: no `javascript:`, `intent:`,
/// `file:`, `content:` and no embedded control characters.
fn validate(url: &str) -> Result<&str, String> {
    if url.is_empty() || url.len() > MAX_URL_LEN {
        return Err("refusing to open an empty or over-long link".to_string());
    }
    if url.trim() != url || url.chars().any(char::is_control) {
        return Err("refusing to open a padded or control-character link".to_string());
    }
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("only http and https links open outside the app".to_string());
    }
    Ok(url)
}

#[cfg(target_os = "android")]
fn open_in_browser(url: &str) -> Result<(), String> {
    let context = std::panic::catch_unwind(ndk_context::android_context)
        .map_err(|_| "the Android context is not available".to_string())?;
    // SAFETY: the runtime owns this VM pointer for the whole process lifetime.
    let vm = unsafe { JavaVM::from_raw(context.vm().cast()) }
        .map_err(|e| format!("could not reach the Android runtime: {e}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("could not attach to the Android runtime: {e}"))?;
    let result = start_view_intent(&mut env, context.context() as jni::sys::jobject, url);
    // A refused start (no browser installed, say) throws in Java, and the
    // JNI error return alone leaves that exception pending on this thread,
    // where it would surface later as a crash in unrelated code. Clear it
    // here — and let a pending exception turn an apparent success into the
    // failure it actually was.
    if matches!(env.exception_check(), Ok(true)) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
        if result.is_ok() {
            return Err("the system browser could not be started".to_string());
        }
    }
    result
}

/// Build `Intent(ACTION_VIEW, Uri.parse(url))` and start it.
#[cfg(target_os = "android")]
fn start_view_intent(
    env: &mut JNIEnv,
    context: jni::sys::jobject,
    url: &str,
) -> Result<(), String> {
    let intent_class = env.find_class("android/content/Intent").map_err(jni_text)?;
    let uri_class = env.find_class("android/net/Uri").map_err(jni_text)?;
    let url_text = env.new_string(url).map_err(jni_text)?;
    let parsed = env
        .call_static_method(
            &uri_class,
            "parse",
            "(Ljava/lang/String;)Landroid/net/Uri;",
            &[JValue::Object(&url_text)],
        )
        .map_err(jni_text)?;
    let uri = parsed.l().map_err(jni_text)?;
    let action = env
        .new_string("android.intent.action.VIEW")
        .map_err(jni_text)?;
    let intent = env
        .new_object(
            &intent_class,
            "(Ljava/lang/String;Landroid/net/Uri;)V",
            &[JValue::Object(&action), JValue::Object(&uri)],
        )
        .map_err(jni_text)?;
    let flag = env
        .get_static_field(&intent_class, "FLAG_ACTIVITY_NEW_TASK", "I")
        .map_err(jni_text)?
        .i()
        .map_err(jni_text)?;
    env.call_method(
        &intent,
        "addFlags",
        "(I)Landroid/content/Intent;",
        &[JValue::Int(flag)],
    )
    .map_err(jni_text)?;
    // SAFETY: `context` is the application Context reference the Android runtime
    // handed to this process; it outlives this call.
    let context = unsafe { JObject::from_raw(context) };
    env.call_method(
        &context,
        "startActivity",
        "(Landroid/content/Intent;)V",
        &[JValue::Object(&intent)],
    )
    .map_err(jni_text)?;
    Ok(())
}

#[cfg(target_os = "android")]
fn jni_text(error: jni::errors::Error) -> String {
    format!("the system browser could not be started: {error}")
}

#[cfg(not(target_os = "android"))]
fn open_in_browser(_url: &str) -> Result<(), String> {
    Err(
        "opening links outside the app is the Android path; the desktop build opens them with \
         the opener plugin"
            .to_string(),
    )
}

#[cfg(target_os = "android")]
use jni::objects::{JObject, JValue};
#[cfg(target_os = "android")]
use jni::{JNIEnv, JavaVM};

#[cfg(test)]
mod tests {
    use super::validate;

    #[test]
    fn http_and_https_links_are_accepted() {
        assert!(validate("https://example.com/a?b=1#c").is_ok());
        assert!(validate("http://192.168.1.10:1420").is_ok());
        assert!(validate("HTTPS://EXAMPLE.COM").is_ok());
    }

    #[test]
    fn other_schemes_are_refused() {
        for url in [
            "javascript:alert(1)",
            "intent://scan/#Intent;scheme=zxing;end",
            "file:///data/data/com.minlulin.purplememo/databases/app.db",
            "content://com.android.contacts/contacts",
            "mailto:someone@example.com",
            "example.com",
        ] {
            assert!(validate(url).is_err(), "{url} must not open");
        }
    }

    #[test]
    fn padded_control_and_over_long_values_are_refused() {
        assert!(validate("").is_err());
        assert!(validate(" https://example.com").is_err());
        assert!(validate("https://example.com\n").is_err());
        let long = format!("https://example.com/{}", "a".repeat(4_096));
        assert!(validate(&long).is_err());
    }
}
