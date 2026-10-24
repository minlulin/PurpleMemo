//! Webview navigation guard.
//!
//! The app renders user-authored markdown, and `react-markdown` turns
//! `[x](https://…)` into a real anchor — in a note the user wrote, or in a note
//! that arrived inside someone else's imported backup. Nothing stopped a click
//! from replacing the app UI with a remote page inside the app window, with no
//! browser chrome and no way back except restarting. No IPC exposure resulted
//! (Tauri injects its per-run invoke key only into initialized local frames),
//! so this is robustness and UX, not a key-read hole — but the app has no
//! business navigating anywhere except its own origin.
//!
//! Two halves, both needed:
//!
//! * **This guard** cancels every navigation away from the app's own origin. It
//!   is a *plugin* hook rather than `WebviewWindowBuilder::on_navigation`
//!   because that builder API is creation-time only and the main window is
//!   declared in `tauri.conf.json`; the plugin hook runs for config-defined
//!   windows and is consulted for every webview.
//! * `src/components/MarkdownLink.tsx` routes external links to the system
//!   browser through the opener plugin, so a link that cannot navigate in-app
//!   still does the obvious thing when clicked.
//!
//! The predicate is pure and unit-tested; only the hook that wraps it is not.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, Url, Webview};

/// Scheme of the origin Tauri serves the bundled frontend from on Linux/macOS.
const APP_SCHEME: &str = "tauri";
/// Host of the app's own origin on Linux/macOS (`tauri://localhost`).
const APP_HOST: &str = "localhost";
/// Host of the app's own origin on Windows (`http://tauri.localhost`, or
/// `https://tauri.localhost` when the HTTPS scheme is enabled).
const APP_HOST_WINDOWS: &str = "tauri.localhost";

/// Same origin: scheme, host and (defaulted) port all match.
fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// Is this the origin the app itself is served from?
///
/// Scheme, host **and port** must match (review P3-2): the asset origin is
/// served on the scheme's default port, so `http://tauri.localhost:<any other
/// port>` — a note from an imported backup could carry one — is some other
/// local process's page and must not replace the app UI.
fn is_app_origin(url: &Url) -> bool {
    let host_matches = matches!(
        (url.scheme(), url.host_str()),
        (APP_SCHEME, Some(APP_HOST)) | ("http" | "https", Some(APP_HOST_WINDOWS))
    );
    if !host_matches {
        return false;
    }
    let default_port = match url.scheme() {
        "http" => Some(80),
        "https" => Some(443),
        // A non-special scheme has no default port: only an absent port counts.
        _ => None,
    };
    url.port_or_known_default() == default_port
}

/// May `target` replace the app UI?
///
/// Allowed: the bundled app origin, and — **only in a dev build** — the origin
/// of the `devUrl` the frontend is actually served from while `tauri dev` runs.
/// The dev exception is keyed on the build (`tauri::is_dev`), not on the config
/// value alone: a `devUrl` that ships inside a release config must never become
/// a route to a local server someone else can start on the machine.
///
/// Everything else is false, including `about:blank`, `javascript:`, `data:`,
/// `file:` and any remote host that merely resembles the app's.
pub fn navigation_allowed(target: &Url, dev_url: Option<&Url>, dev_build: bool) -> bool {
    if is_app_origin(target) {
        return true;
    }
    if dev_build {
        if let Some(dev_url) = dev_url {
            if same_origin(target, dev_url) {
                return true;
            }
        }
    }
    false
}

/// The plugin: one navigation hook, applied to every webview in the app.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("navigation-guard")
        .on_navigation(|webview: &Webview<R>, url: &Url| {
            let config = webview.config();
            let allowed = navigation_allowed(url, config.build.dev_url.as_ref(), tauri::is_dev());
            if !allowed {
                // A blocked navigation is either a bug or a hostile link; both
                // deserve a line in the log the app already writes to stderr.
                eprintln!("purple-memo: blocked navigation to {url}");
            }
            allowed
        })
        .build()
}

// ---------------------------------------------------------------------------
// Tests — run with `cargo test`
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).expect("test url")
    }

    #[test]
    fn the_apps_own_origins_are_allowed() {
        let dev = url("http://localhost:1420");
        for target in [
            "tauri://localhost",
            "tauri://localhost/index.html",
            "tauri://localhost/index.html#/notes?q=1",
            "http://tauri.localhost",
            "https://tauri.localhost/assets/index.js",
        ] {
            assert!(
                navigation_allowed(&url(target), Some(&dev), false),
                "{target} is the app's own origin"
            );
        }
    }

    #[test]
    fn the_configured_dev_origin_is_allowed_in_dev_builds_only() {
        let dev = url("http://localhost:1420");
        let target = url("http://localhost:1420/src/main.tsx");
        assert!(
            navigation_allowed(&target, Some(&dev), true),
            "tauri dev loads the frontend from the Vite dev server"
        );
        assert!(
            !navigation_allowed(&target, Some(&dev), false),
            "a devUrl must not survive into a release build"
        );
        // A different port on the same host is a different origin.
        assert!(!navigation_allowed(
            &url("http://localhost:9999/"),
            Some(&dev),
            true
        ));
        // No devUrl configured: nothing to allow.
        assert!(!navigation_allowed(&target, None, true));
    }

    #[test]
    fn remote_and_dangerous_schemes_are_blocked() {
        let dev = url("http://localhost:1420");
        for target in [
            "https://example.com",
            "https://example.com/index.html",
            "http://tauri.localhost.evil.example",
            "https://evil.example/tauri.localhost",
            "tauri://evil.example",
            "tauri://localhost.evil.example",
            "ftp://localhost/file",
            "file:///etc/passwd",
            "about:blank",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
        ] {
            assert!(
                !navigation_allowed(&url(target), Some(&dev), true),
                "{target} must not replace the app UI"
            );
        }
    }

    #[test]
    fn the_windows_origin_needs_the_exact_host() {
        // `tauri.localhost` is only the app origin when it is the whole host.
        assert!(!is_app_origin(&url("http://tauri.localhost.evil.example")));
        assert!(!is_app_origin(&url("http://nottauri.localhost")));
        assert!(is_app_origin(&url("https://tauri.localhost")));
    }

    #[test]
    fn a_non_default_port_is_not_the_app_origin() {
        // The asset origin is scheme + host + default port (review P3-2): the
        // same host on another port is a different origin — another local
        // process's page.
        assert!(is_app_origin(&url("tauri://localhost")));
        assert!(is_app_origin(&url("http://tauri.localhost")));
        assert!(is_app_origin(&url("http://tauri.localhost:80")));
        assert!(is_app_origin(&url("https://tauri.localhost")));
        assert!(!is_app_origin(&url("http://tauri.localhost:8080")));
        assert!(!is_app_origin(&url("https://tauri.localhost:8443")));
        assert!(!is_app_origin(&url("tauri://localhost:9000")));
    }
}
