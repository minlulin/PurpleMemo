//! Opening an external link in the phone's browser, dialer or mail client.
//!
//! Desktop hands URLs to `plugin-opener`; that plugin is deliberately absent on
//! Android (`docs/ANDROID_IPC_SURFACE.md` finding #3), so the phone needs its own
//! path. The intent is started from the application context, which is why
//! `FLAG_ACTIVITY_NEW_TASK` is required — a Context that is not an Activity may
//! not start one without it.
//!
//! The URL is validated here as well as in the webview (`lib/externalLinks.ts`):
//! note text and imported backups can contain any scheme, and the boundary that
//! reaches another app is worth checking twice. Both layers allow exactly
//! `http`, `https`, `mailto` and `tel`, the same set `routeLink` calls external;
//! the tests below and in `externalLinks.test.ts` pin the shared matrix.

use crate::messages::Refusal;

/// Longest URL this app will hand over. Well past any real link, short enough
/// that a pathological row cannot be turned into a megabyte-long intent.
const MAX_URL_LEN: usize = 2_048;

/// Android's action for an `http(s):` link: open it in the browser.
const ACTION_VIEW: &str = "android.intent.action.VIEW";
/// Android's action for a `tel:` link: open the dialer, never place the call.
const ACTION_DIAL: &str = "android.intent.action.DIAL";
/// Android's action for a `mailto:` link: hand it to a mail client.
const ACTION_SENDTO: &str = "android.intent.action.SENDTO";

/// Open `url` with whatever app the system has registered for its scheme.
///
/// Fails loudly instead of doing nothing: the UI turns the error into a toast,
/// which is honest about a tap that could not be served.
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), Refusal> {
    let url = validate(&url)?;
    open_external(url)
}

/// Accept only an absolute, unpadded URL in one of the four schemes the app
/// offers: `http`, `https`, `mailto`, `tel`. Everything else — `javascript:`,
/// `intent:`, `file:`, `content:` — and any embedded control character is
/// refused. A scheme with no target (`tel:`, `mailto:`) is refused too.
fn validate(url: &str) -> Result<&str, Refusal> {
    if url.is_empty() || url.len() > MAX_URL_LEN {
        return Err(Refusal::new("rust.error.linkEmpty"));
    }
    if url.trim() != url || url.chars().any(char::is_control) {
        return Err(Refusal::new("rust.error.linkPadded"));
    }
    let lower = url.to_ascii_lowercase();
    let scheme = ["http://", "https://", "mailto:", "tel:"]
        .into_iter()
        .find(|scheme| lower.starts_with(scheme))
        .ok_or_else(|| Refusal::new("rust.error.linkScheme"))?;
    if url.len() == scheme.len() {
        return Err(Refusal::new("rust.error.linkEmpty"));
    }
    Ok(url)
}

/// The intent action a validated URL calls for.
fn intent_action(url: &str) -> &'static str {
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("tel:") {
        ACTION_DIAL
    } else if lower.starts_with("mailto:") {
        ACTION_SENDTO
    } else {
        ACTION_VIEW
    }
}

#[cfg(target_os = "android")]
fn open_external(url: &str) -> Result<(), Refusal> {
    let context = std::panic::catch_unwind(ndk_context::android_context)
        .map_err(|_| Refusal::new("rust.error.browserStart"))?;
    // SAFETY: the runtime owns this VM pointer for the whole process lifetime.
    let vm = unsafe { JavaVM::from_raw(context.vm().cast()) }
        .map_err(|e| format!("could not reach the Android runtime: {e}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("could not attach to the Android runtime: {e}"))?;
    let result = start_intent(
        &mut env,
        context.context() as jni::sys::jobject,
        intent_action(url),
        url,
    );
    // A refused start (no app can handle the link, say) throws in Java, and the
    // JNI error return alone leaves that exception pending on this thread,
    // where it would surface later as a crash in unrelated code. Clear it
    // here — and let a pending exception turn an apparent success into the
    // failure it actually was.
    if matches!(env.exception_check(), Ok(true)) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
        if result.is_ok() {
            return Err(Refusal::new("rust.error.browserStart"));
        }
    }
    result
}

/// Build `Intent(action, Uri.parse(url))` and start it.
#[cfg(target_os = "android")]
fn start_intent(
    env: &mut JNIEnv,
    context: jni::sys::jobject,
    action: &str,
    url: &str,
) -> Result<(), Refusal> {
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
    let action = env.new_string(action).map_err(jni_text)?;
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
    format!("the system app could not be started: {error}")
}

#[cfg(not(target_os = "android"))]
fn open_external(_url: &str) -> Result<(), Refusal> {
    // Unreachable from the desktop UI, which opens links with the opener
    // plugin; the phone's path is the only caller of this command.
    Err(Refusal::new("rust.error.browserStart"))
}

#[cfg(target_os = "android")]
use jni::objects::{JObject, JValue};
#[cfg(target_os = "android")]
use jni::{JNIEnv, JavaVM};

#[cfg(test)]
mod tests {
    use super::{intent_action, validate, ACTION_DIAL, ACTION_SENDTO, ACTION_VIEW};

    #[test]
    fn the_four_offered_schemes_are_accepted() {
        for url in [
            "https://example.com/a?b=1#c",
            "http://192.168.1.10:1420",
            "HTTPS://EXAMPLE.COM",
            "mailto:someone@example.com",
            "MAILTO:someone@example.com?subject=Hi",
            "tel:+15550100",
        ] {
            assert!(validate(url).is_ok(), "{url} must open");
        }
    }

    #[test]
    fn each_scheme_maps_to_its_intent_action() {
        // The matrix the webview tests pin too: browser for http(s), dialer for
        // tel, a mail client for mailto.
        assert_eq!(intent_action("https://example.com"), ACTION_VIEW);
        assert_eq!(intent_action("HTTP://example.com"), ACTION_VIEW);
        assert_eq!(intent_action("mailto:someone@example.com"), ACTION_SENDTO);
        assert_eq!(intent_action("TEL:+15550100"), ACTION_DIAL);
    }

    #[test]
    fn other_schemes_are_refused() {
        for url in [
            "javascript:alert(1)",
            "intent://scan/#Intent;scheme=zxing;end",
            "file:///data/data/com.minlulin.purplememo/databases/app.db",
            "content://com.android.contacts/contacts",
            "data:text/html,<script>alert(1)</script>",
            "example.com",
        ] {
            assert!(validate(url).is_err(), "{url} must not open");
        }
    }

    #[test]
    fn schemes_without_a_target_are_refused() {
        for url in ["tel:", "mailto:", "TEL:", "MAILTO:"] {
            assert!(validate(url).is_err(), "{url} must not open");
        }
    }

    #[test]
    fn padded_control_and_over_long_values_are_refused() {
        assert!(validate("").is_err());
        assert!(validate(" https://example.com").is_err());
        assert!(validate("https://example.com\n").is_err());
        assert!(validate("tel:+15550100\n").is_err());
        let long = format!("https://example.com/{}", "a".repeat(4_096));
        assert!(validate(&long).is_err());
    }
}
