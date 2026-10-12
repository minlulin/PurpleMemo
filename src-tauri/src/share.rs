//! Read-only LAN snapshot server (§8, P5).
//!
//! The desktop is the single writer: it builds a bounded, display-ready
//! snapshot (see `src/lib/share.ts`) and hands it to [`ShareState::publish`].
//! This module then serves exactly those bytes — the network path never
//! touches the SQLCipher connection, the keyring key or the filesystem, so a
//! reachable listener can never become a database or key-read oracle.
//!
//! Access control: a random pairing code minted at start, required on every
//! request (`?k=`). Sharing is off until the user turns it on and never
//! survives a restart (fail closed — §8 is opt-in). Repeated wrong codes shut
//! the server down instead of allowing an unbounded brute-force.

use std::io::Cursor;
use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value as JsonValue;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

/// Pairing-code length (alphabet below is 32 chars, so each character carries
/// exactly 5 bits — 6 characters ≈ 30 bits).
const CODE_LEN: usize = 6;

/// Unambiguous alphabet: no O/0, I/1/L look-alikes. Length is exactly 32 so
/// `byte % 32` is uniform (256 / 32 = 8).
const CODE_ALPHABET: &[u8; 32] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/// Wrong-code attempts tolerated before the server shuts itself down.
pub const MAX_BAD_CODES: u32 = 10;

/// The page inlined into the binary — the phone never loads a file from disk.
const SHARE_PAGE: &str = include_str!("../share/share.html");

/// The design tokens, inlined so the phone page uses the same values as the
/// app (§6) without shipping a separate stylesheet.
const TOKENS_CSS: &str = include_str!("../../src/styles/tokens.css");

/// Marker in the page template replaced by [`TOKENS_CSS`].
const TOKENS_MARKER: &str = "/*__TOKENS__*/";

/// Largest snapshot accepted from the desktop (the payload is ~10 KB; the
/// cap only stops a runaway caller from ballooning memory).
pub const MAX_SNAPSHOT_BYTES: usize = 512 * 1024;

/// How long the accept loop waits for a request before re-checking shutdown,
/// so `stop` never has to wait long to join the thread.
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// State of the share server as the UI sees it (§8).
///
/// Serialized camelCase: Tauri passes command return values through serde
/// as-is, and `src/data/driver.ts` reads `publishedAt` / `port` — the same
/// IPC contract as [`crate::db::ExecuteOutcome`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareInfo {
    pub running: bool,
    /// The link the phone opens — carries the pairing code.
    pub url: Option<String>,
    /// The pairing code shown in the app (also embedded in `url`).
    pub code: Option<String>,
    /// The bound TCP port (useful for firewall rules).
    pub port: Option<u16>,
    /// `generatedAt` of the last published snapshot.
    pub published_at: Option<String>,
    /// Why sharing stopped, when it stopped on its own (never on a user stop).
    pub note: Option<String>,
}

impl ShareInfo {
    fn stopped(note: Option<String>) -> Self {
        Self {
            running: false,
            url: None,
            code: None,
            port: None,
            published_at: None,
            note,
        }
    }
}

/// The last published payload plus the metadata the server reports back.
#[derive(Debug, Clone)]
pub struct StoredSnapshot {
    pub json: String,
    pub generated_at: String,
}

/// Flags shared with the accept loop.
#[derive(Default)]
struct Shared {
    stop: AtomicBool,
    bad_codes: AtomicU32,
    stopped_for_abuse: AtomicBool,
}

struct Running {
    port: u16,
    code: String,
    url: Option<String>,
    snapshot: Arc<Mutex<Option<StoredSnapshot>>>,
    shared: Arc<Shared>,
    join: Option<JoinHandle<()>>,
}

/// The managed share state: at most one listening server (§8 — single writer,
/// one listener). Cloned into Tauri as managed state, so the mutex is the only
/// shared handle.
#[derive(Default)]
pub struct ShareState {
    inner: Mutex<Option<Running>>,
}

impl ShareState {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Option<Running>>, String> {
        self.inner
            .lock()
            .map_err(|_| "share state mutex poisoned".to_string())
    }

    /// Start sharing, binding every interface so the phone can reach it.
    /// Idempotent while running: a second call returns the live link.
    pub fn start(&self) -> Result<ShareInfo, String> {
        self.start_on("0.0.0.0")
    }

    /// Testable bind: production uses `0.0.0.0`, tests use loopback.
    fn start_on(&self, bind: &str) -> Result<ShareInfo, String> {
        let mut guard = self.lock()?;
        if let Some(r) = guard.as_ref() {
            if !r.server_is_gone() {
                return Ok(r.info(None));
            }
        }
        // A previous server that stopped itself must be reaped before restart.
        if let Some(stale) = guard.take() {
            reap(stale);
        }

        let server = Server::http((bind, 0))
            .map_err(|e| format!("could not start the share server on {bind}: {e}"))?;
        let port = server
            .server_addr()
            .to_ip()
            .map(|a: SocketAddr| a.port())
            .ok_or_else(|| "could not read the share server port".to_string())?;
        let code = generate_code()?;
        let url = lan_ip().map(|ip| format!("http://{ip}:{port}/?k={code}"));
        let snapshot: Arc<Mutex<Option<StoredSnapshot>>> = Arc::new(Mutex::new(None));
        let shared = Arc::new(Shared::default());

        let thread_snapshot = Arc::clone(&snapshot);
        let thread_shared = Arc::clone(&shared);
        let thread_code = code.clone();
        let join = thread::Builder::new()
            .name("purple-memo-share".to_string())
            .spawn(move || serve(server, thread_code, thread_snapshot, thread_shared))
            .map_err(|e| format!("could not start the share thread: {e}"))?;

        let running = Running {
            port,
            code,
            url,
            snapshot,
            shared,
            join: Some(join),
        };
        let info = running.info(None);
        *guard = Some(running);
        Ok(info)
    }

    /// Stop sharing and wait for the listener to close. Idempotent.
    pub fn stop(&self) -> Result<ShareInfo, String> {
        let mut guard = self.lock()?;
        match guard.take() {
            Some(running) => {
                let note = running.abuse_note();
                reap(running);
                Ok(ShareInfo::stopped(note))
            }
            None => Ok(ShareInfo::stopped(None)),
        }
    }

    /// Current state — also reaps a server that shut itself down.
    pub fn status(&self) -> Result<ShareInfo, String> {
        let mut guard = self.lock()?;
        match guard.as_ref() {
            Some(r) if !r.server_is_gone() => Ok(r.info(None)),
            Some(_) => {
                let running = guard.take().expect("checked above");
                let note = running.abuse_note();
                reap(running);
                Ok(ShareInfo::stopped(note))
            }
            None => Ok(ShareInfo::stopped(None)),
        }
    }

    /// Store the snapshot the LAN server will serve. Rejects anything that is
    /// not a snapshot payload, so the served bytes are always app-produced.
    /// A call while sharing is off stores nothing and reports `running: false`.
    pub fn publish(&self, json: &str) -> Result<ShareInfo, String> {
        let snapshot = parse_snapshot(json)?;
        let guard = self.lock()?;
        match guard.as_ref() {
            Some(r) if !r.server_is_gone() => {
                {
                    let mut slot = r
                        .snapshot
                        .lock()
                        .map_err(|_| "share snapshot mutex poisoned".to_string())?;
                    *slot = Some(snapshot);
                    // Dropped before `info` reads the slot back — the mutex is
                    // not reentrant.
                }
                Ok(r.info(None))
            }
            _ => Ok(ShareInfo::stopped(None)),
        }
    }
}

impl Running {
    fn server_is_gone(&self) -> bool {
        self.shared.stopped_for_abuse.load(Ordering::SeqCst)
            || self.join.as_ref().is_some_and(|j| j.is_finished())
    }

    fn abuse_note(&self) -> Option<String> {
        self.shared
            .stopped_for_abuse
            .load(Ordering::SeqCst)
            .then(|| format!("Stopped sharing after {MAX_BAD_CODES} wrong pairing codes."))
    }

    fn info(&self, note: Option<String>) -> ShareInfo {
        let published_at = self
            .snapshot
            .lock()
            .ok()
            .and_then(|s| s.as_ref().map(|s| s.generated_at.clone()));
        ShareInfo {
            running: true,
            url: self.url.clone(),
            code: Some(self.code.clone()),
            port: Some(self.port),
            published_at,
            note,
        }
    }
}

/// Signal the accept loop and wait for it to exit.
fn reap(mut running: Running) {
    running.shared.stop.store(true, Ordering::SeqCst);
    if let Some(join) = running.join.take() {
        let _ = join.join();
    }
}

/// A fresh pairing code from the OS random source.
pub fn generate_code() -> Result<String, String> {
    let mut buf = [0u8; CODE_LEN];
    getrandom::fill(&mut buf).map_err(|e| format!("OS random source unavailable: {e}"))?;
    Ok(buf
        .iter()
        .map(|b| CODE_ALPHABET[usize::from(*b % 32)] as char)
        .collect())
}

/// Best-effort local network address for the printed link. Binding a UDP
/// socket and "connecting" it sends nothing — it only asks the OS which
/// source address the default route would use.
fn lan_ip() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    // RFC 5737 TEST-NET-1: routable-looking, never a real destination.
    socket.connect("192.0.2.1:80").ok()?;
    socket.local_addr().ok().map(|a| a.ip().to_string())
}

/// Constant-time comparison over equal-length inputs; the length itself is
/// fixed and public, so an early length check leaks nothing.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Value of `name` in a raw query string (`a=1&k=CODE`).
fn query_param<'a>(query: &'a str, name: &str) -> Option<&'a str> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name).then_some(value)
    })
}

/// Validate an incoming publish: the served payload must be a snapshot object
/// with a numeric `version` and a string `generatedAt`.
fn parse_snapshot(json: &str) -> Result<StoredSnapshot, String> {
    if json.len() > MAX_SNAPSHOT_BYTES {
        return Err(format!(
            "snapshot is larger than the {MAX_SNAPSHOT_BYTES} byte limit"
        ));
    }
    let parsed: JsonValue =
        serde_json::from_str(json).map_err(|e| format!("snapshot is not valid JSON: {e}"))?;
    let object = parsed
        .as_object()
        .ok_or_else(|| "snapshot must be a JSON object".to_string())?;
    // The shape check is the contract: only payloads this app produced are
    // ever served, so the listener cannot be coaxed into serving anything else.
    let version = object
        .get("version")
        .and_then(JsonValue::as_i64)
        .ok_or_else(|| "snapshot is missing its numeric version".to_string())?;
    if version <= 0 {
        return Err("snapshot version must be positive".to_string());
    }
    let generated_at = object
        .get("generatedAt")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| "snapshot is missing its generatedAt string".to_string())?;
    Ok(StoredSnapshot {
        json: json.to_string(),
        generated_at: generated_at.to_string(),
    })
}

/// The phone page with the design tokens inlined and the Tailwind import
/// (meaningless outside the app build) removed.
fn render_page() -> String {
    SHARE_PAGE.replace(
        TOKENS_MARKER,
        &TOKENS_CSS.replace("@import \"tailwindcss\";", ""),
    )
}

fn add_header(response: &mut Response<Cursor<Vec<u8>>>, name: &str, value: &str) {
    if let Ok(header) = Header::from_bytes(name, value) {
        response.add_header(header);
    }
}

fn plain(status: u16, body: &str) -> Response<Cursor<Vec<u8>>> {
    let mut response = Response::from_string(body.to_string()).with_status_code(StatusCode(status));
    add_header(&mut response, "Content-Type", "text/plain; charset=utf-8");
    add_header(&mut response, "Cache-Control", "no-store");
    add_header(&mut response, "X-Content-Type-Options", "nosniff");
    add_header(&mut response, "Referrer-Policy", "no-referrer");
    response
}

fn page(body: String) -> Response<Cursor<Vec<u8>>> {
    let mut response = Response::from_string(body).with_status_code(StatusCode(200));
    add_header(&mut response, "Content-Type", "text/html; charset=utf-8");
    add_header(&mut response, "Cache-Control", "no-store");
    add_header(&mut response, "X-Content-Type-Options", "nosniff");
    add_header(&mut response, "Referrer-Policy", "no-referrer");
    add_header(
        &mut response,
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; \
         connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    response
}

fn json(body: String) -> Response<Cursor<Vec<u8>>> {
    let mut response = Response::from_string(body).with_status_code(StatusCode(200));
    add_header(
        &mut response,
        "Content-Type",
        "application/json; charset=utf-8",
    );
    add_header(&mut response, "Cache-Control", "no-store");
    add_header(&mut response, "X-Content-Type-Options", "nosniff");
    response
}

/// The accept loop: poll, serve one request, stop on shutdown or abuse.
fn serve(
    server: Server,
    code: String,
    snapshot: Arc<Mutex<Option<StoredSnapshot>>>,
    shared: Arc<Shared>,
) {
    let mut consecutive_errors = 0u32;
    while !shared.stop.load(Ordering::SeqCst) {
        match server.recv_timeout(POLL_INTERVAL) {
            Ok(Some(request)) => {
                consecutive_errors = 0;
                if !handle(request, &code, &snapshot, &shared) {
                    return;
                }
            }
            Ok(None) => consecutive_errors = 0,
            // Transient accept errors (a client hanging up mid-handshake) must
            // not kill sharing, but a listener that keeps failing must not
            // spin forever either.
            Err(_) => {
                consecutive_errors += 1;
                if consecutive_errors >= 100 {
                    return;
                }
            }
        }
    }
}

/// A `Host` header is acceptable only when its host part is a bare IP
/// literal or `localhost` — i.e. exactly the address this listener is
/// reached at. This is the standard cheap defence against DNS rebinding: a
/// public name that resolves to a LAN address must not be treated as
/// same-origin by a browser, and a request naming some other host is not one
/// we ever issued a link for.
fn host_is_allowed(host: &str) -> bool {
    // Strip the port; brackets cover IPv6 literals like [::1]:8080.
    let name = match host.rsplit_once(':') {
        Some((before, port)) if port.chars().all(|c| c.is_ascii_digit()) => before,
        _ => host,
    };
    let name = name.trim_start_matches('[').trim_end_matches(']');
    name.eq_ignore_ascii_case("localhost") || name.parse::<std::net::IpAddr>().is_ok()
}

/// Serve one request. Returns false when the loop must end.
fn handle(
    request: Request,
    code: &str,
    snapshot: &Mutex<Option<StoredSnapshot>>,
    shared: &Shared,
) -> bool {
    if request.method() != &Method::Get {
        let _ = request.respond(plain(405, "only GET is served here\n"));
        return true;
    }
    match request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Host") && host_is_allowed(h.value.as_str()))
    {
        Some(_) => {}
        // Reject BEFORE the pairing-code check so a rebound host cannot even
        // burn one of the ten attempts.
        None => {
            let _ = request.respond(plain(421, "unexpected host\n"));
            return true;
        }
    }
    let url = request.url().to_string();
    let (path, query) = match url.split_once('?') {
        Some((path, query)) => (path, query),
        None => (url.as_str(), ""),
    };
    let presented = query_param(query, "k");
    if !presented.is_some_and(|k| constant_time_eq(k, code)) {
        let _ = request.respond(plain(
            403,
            "wrong or missing pairing code — open the link shown in Purple Memo\n",
        ));
        let attempts = shared.bad_codes.fetch_add(1, Ordering::SeqCst) + 1;
        if attempts >= MAX_BAD_CODES {
            shared.stopped_for_abuse.store(true, Ordering::SeqCst);
            shared.stop.store(true, Ordering::SeqCst);
            return false;
        }
        return true;
    }

    match path {
        "/" | "/index.html" => {
            let _ = request.respond(page(render_page()));
        }
        "/api/snapshot" => {
            let stored = snapshot.lock().ok().and_then(|s| s.clone());
            match stored {
                Some(stored) => {
                    let _ = request.respond(json(stored.json));
                }
                None => {
                    let _ = request.respond(plain(
                        503,
                        "no snapshot published yet — the desktop is still starting\n",
                    ));
                }
            }
        }
        _ => {
            let _ = request.respond(plain(404, "not found\n"));
        }
    }
    true
}

// ---------------------------------------------------------------------------
// Tests — run with `cargo test`
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream as StdTcpStream;

    /// Minimal raw HTTP/1.1 GET — enough to exercise the listener.
    fn get(port: u16, path: &str) -> (u16, String) {
        let mut stream = StdTcpStream::connect(("127.0.0.1", port)).expect("connect to share");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("timeout");
        write!(
            stream,
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
        )
        .expect("write request");
        let mut raw = String::new();
        stream.read_to_string(&mut raw).expect("read response");
        let status = raw
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(0);
        let body = raw
            .split_once("\r\n\r\n")
            .map(|(_, body)| body.to_string())
            .unwrap_or_default();
        (status, body)
    }

    fn payload(generated_at: &str) -> String {
        format!("{{\"version\":1,\"generatedAt\":\"{generated_at}\",\"today\":\"2026-10-12\"}}")
    }

    /// A listener on loopback with a known code; always stopped by the test.
    fn started() -> (ShareState, u16, String) {
        let state = ShareState::new();
        let info = state.start_on("127.0.0.1").expect("start share");
        let port = info.port.expect("port");
        let code = info.code.expect("code");
        (state, port, code)
    }

    #[test]
    fn generated_codes_are_six_alphabet_chars_and_random() {
        let a = generate_code().expect("code");
        let b = generate_code().expect("code");
        assert_eq!(a.len(), CODE_LEN);
        assert!(a.bytes().all(|c| CODE_ALPHABET.contains(&c)), "{a}");
        assert_ne!(a, b, "two codes must not collide");
    }

    #[test]
    fn constant_time_comparison_matches_only_equal_codes() {
        assert!(constant_time_eq("ABC234", "ABC234"));
        assert!(!constant_time_eq("ABC234", "ABC235"));
        assert!(!constant_time_eq("ABC234", "ABC23"));
        assert!(!constant_time_eq("", "ABC234"));
    }

    #[test]
    fn query_param_reads_k_and_ignores_the_rest() {
        assert_eq!(query_param("k=ABC123", "k"), Some("ABC123"));
        assert_eq!(query_param("a=1&k=ABC123&b=2", "k"), Some("ABC123"));
        assert_eq!(query_param("a=1", "k"), None);
        assert_eq!(query_param("", "k"), None);
    }

    #[test]
    fn page_inlines_tokens_and_drops_the_module_import() {
        let html = render_page();
        assert!(html.contains("--color-accent"), "tokens must be inlined");
        assert!(
            html.contains("--space-4"),
            "design values come from tokens.css"
        );
        assert!(
            !html.contains("@import"),
            "a bare module import cannot resolve"
        );
        assert!(
            !html.contains(TOKENS_MARKER),
            "the marker must be replaced, not shipped"
        );
        assert!(
            html.contains("read-only"),
            "the phone page is the share view"
        );
    }

    #[test]
    fn sharing_is_off_until_started_and_stop_is_idempotent() {
        let state = ShareState::new();
        assert!(!state.status().expect("status").running);
        assert!(!state.stop().expect("stop").running);
    }

    #[test]
    fn start_is_idempotent_while_running() {
        let (state, port, code) = started();
        let again = state.start().expect("second start");
        assert_eq!(again.port, Some(port), "the live listener is reused");
        assert_eq!(again.code, Some(code));
        assert!(!state.stop().expect("stop").running);
    }

    #[test]
    fn host_header_guard_accepts_ips_and_localhost_only() {
        for ok in [
            "127.0.0.1",
            "127.0.0.1:8765",
            "10.0.0.4:8765",
            "localhost:8765",
            "LOCALHOST",
            "[::1]:8765",
        ] {
            assert!(host_is_allowed(ok), "{ok} should be allowed");
        }
        for bad in [
            "evil.example.com",
            "evil.example.com:8765",
            "purple-memo.attacker.test",
            "",
        ] {
            assert!(!host_is_allowed(bad), "{bad} must be rejected");
        }
    }

    #[test]
    fn requests_need_the_pairing_code() {
        let (state, port, code) = started();
        assert_eq!(get(port, "/").0, 403, "no code -> rejected");
        assert_eq!(get(port, "/?k=WRONG1").0, 403, "wrong code -> rejected");
        assert_eq!(
            get(port, &format!("/?k={code}")).0,
            200,
            "right code -> page"
        );
        assert_eq!(
            get(port, "/api/snapshot").0,
            403,
            "the JSON endpoint needs the code too"
        );
        state.stop().expect("stop");
    }

    #[test]
    fn snapshot_is_served_only_with_the_code_and_only_once_published() {
        let (state, port, code) = started();
        let (status, _) = get(port, &format!("/api/snapshot?k={code}"));
        assert_eq!(status, 503, "nothing published yet");

        let info = state
            .publish(&payload("2026-10-12T09:30"))
            .expect("publish");
        assert_eq!(info.published_at.as_deref(), Some("2026-10-12T09:30"));

        let (status, body) = get(port, &format!("/api/snapshot?k={code}"));
        assert_eq!(status, 200);
        assert!(
            body.contains("\"generatedAt\":\"2026-10-12T09:30\""),
            "{body}"
        );
        assert_eq!(get(port, "/api/snapshot?k=WRONG1").0, 403);
        state.stop().expect("stop");
    }

    #[test]
    fn only_get_is_served_and_unknown_paths_are_404() {
        let (state, port, code) = started();
        assert_eq!(get(port, &format!("/nope?k={code}")).0, 404);
        assert_eq!(get(port, &format!("/favicon.ico?k={code}")).0, 404);
        state.stop().expect("stop");
    }

    #[test]
    fn repeated_wrong_codes_shut_the_server_down() {
        let (state, port, _code) = started();
        for _ in 0..MAX_BAD_CODES {
            let (status, _) = get(port, "/?k=WRONG1");
            assert_eq!(status, 403);
        }
        let info = state.status().expect("status");
        assert!(!info.running, "the server must stop itself");
        let note = info.note.unwrap_or_default();
        assert!(
            note.contains("wrong pairing codes"),
            "the user must be told why: {note:?}"
        );
    }

    #[test]
    fn publish_rejects_a_payload_that_is_not_a_snapshot() {
        let (state, _port, _code) = started();
        assert!(state.publish("{").is_err(), "invalid JSON");
        assert!(state.publish("[]").is_err(), "not an object");
        assert!(state.publish("{\"version\":1}").is_err(), "no generatedAt");
        assert!(
            state.publish("{\"generatedAt\":\"x\"}").is_err(),
            "no version"
        );
        let huge = format!(
            "{{\"version\":1,\"generatedAt\":\"x\",\"pad\":\"{}\"}}",
            "a".repeat(MAX_SNAPSHOT_BYTES)
        );
        assert!(state.publish(&huge).is_err(), "oversized payloads rejected");
        state.stop().expect("stop");
    }

    #[test]
    fn publish_with_sharing_off_stores_nothing() {
        let state = ShareState::new();
        let info = state
            .publish(&payload("2026-10-12T09:30"))
            .expect("publish");
        assert!(!info.running);
        assert!(info.published_at.is_none());
    }

    #[test]
    fn share_info_serializes_camel_case_for_the_js_driver() {
        let info = ShareInfo {
            running: true,
            url: Some("http://10.0.0.4:8765/?k=ABC234".to_string()),
            code: Some("ABC234".to_string()),
            port: Some(8765),
            published_at: Some("2026-10-12T09:30".to_string()),
            note: None,
        };
        let v = serde_json::to_value(&info).expect("serialize");
        assert_eq!(
            v.get("publishedAt"),
            Some(&JsonValue::from("2026-10-12T09:30"))
        );
        assert_eq!(v.get("port"), Some(&JsonValue::from(8765)));
        assert!(
            v.get("published_at").is_none(),
            "snake_case keys must not cross the IPC boundary: {v}"
        );
    }
}
