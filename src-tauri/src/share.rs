//! Read-only LAN snapshot server (P5).
//!
//! The desktop is the single writer: it builds a bounded, display-ready
//! snapshot (see `src/lib/share.ts`) and hands it to [`ShareState::publish`].
//! This module then serves exactly those bytes — the network path never
//! touches the SQLCipher connection, the keyring key or the filesystem, so a
//! reachable listener can never become a database or key-read oracle.
//!
//! A random 256-bit AES-GCM key is carried in the URL fragment, which browsers
//! never send in HTTP requests. The server publishes only authenticated
//! ciphertext; sharing is off until the user turns it on and never survives a
//! restart (fail closed —  is opt-in). HTTP still cannot authenticate the
//! server, so active network attackers can replace the page and capture its
//! fragment key.

use std::io::Cursor;
use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value as JsonValue;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

/// The page inlined into the binary — the phone never loads a file from disk.
const SHARE_PAGE: &str = include_str!("../share/share.html");

/// Noble's audited AES-GCM modules, served same-origin to the phone page.
///
/// Vendored under `src-tauri/share/_crypto/` instead of being
/// `include_str!`'d out of `node_modules`: the Rust build must not depend on
/// `npm install` having run, and a `cargo build` in a fresh checkout used to
/// fail on a missing path that has nothing to do with Rust. The files are
/// byte-for-byte the package's (`LICENSE` sits beside them); `share/README.md`
/// says how to refresh them.
const AES_MODULE: &str = include_str!("../share/_crypto/aes.js");
const POLYVAL_MODULE: &str = include_str!("../share/_crypto/_polyval.js");
const UTILS_MODULE: &str = include_str!("../share/_crypto/utils.js");

/// The snapshot decryptor, shared with the page and with the Node test
/// — one module, so the tested code is the code that runs.
const SNAPSHOT_MODULE: &str = include_str!("../share/_snapshot.js");

/// The design tokens, inlined so the phone page uses the same values as the
/// app without shipping a separate stylesheet.
const TOKENS_CSS: &str = include_str!("../../src/styles/tokens.css");

/// Marker in the page template replaced by [`TOKENS_CSS`].
const TOKENS_MARKER: &str = "/*__TOKENS__*/";

/// Largest snapshot accepted from the desktop (the payload is ~10 KB; the
/// cap only stops a runaway caller from ballooning memory).
pub const MAX_SNAPSHOT_BYTES: usize = 512 * 1024;

/// A disclosure of the user's data to the local network, for the audit log.
/// Carries the port but never the encryption key.
#[derive(Debug, Clone)]
pub enum ShareEvent {
    /// A listener was opened on this port, with consent.
    Started(u16),
    /// The listener closed. Carries the abuse note when it stopped early.
    Stopped(Option<String>),
}

impl ShareEvent {
    /// The audit line for this event. Pure, and — like the key-export line —
    /// has no parameter through which the encryption key could be threaded.
    pub fn audit_line(&self) -> String {
        match self {
            ShareEvent::Started(port) => {
                format!("LAN share STARTED on port {port} (valid consent token)")
            }
            ShareEvent::Stopped(None) => "LAN share STOPPED by the user".to_string(),
            ShareEvent::Stopped(Some(reason)) => format!("LAN share STOPPED: {reason}"),
        }
    }
}

/// How long the accept loop waits for a request before re-checking shutdown,
/// so `stop` never has to wait long to join the thread.
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Responses served at once.
///
/// Each worker owns one `respond` call, so a client that stops reading holds
/// a worker — not the accept loop. That is the whole point: `share_stop`
/// signals shutdown and joins the accept thread, and it used to join a loop
/// that was itself blocked writing to that client, so locking the app could
/// hang behind a stalled LAN socket.
const MAX_WORKERS: usize = 4;

/// Whether a request may be handed to a worker. Pure, so the saturation rule
/// is testable without a socket.
fn has_capacity(active: usize) -> bool {
    active < MAX_WORKERS
}

/// State of the share server as the UI sees it
///
/// Serialized camelCase: Tauri passes command return values through serde
/// as-is, and `src/data/driver.ts` reads `publishedAt` / `port` — the same
/// IPC contract as [`crate::db::ExecuteOutcome`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareInfo {
    pub running: bool,
    /// The link carries the encryption key in its fragment, never in a request.
    pub url: Option<String>,
    /// AES-256-GCM key, carried only in the URL fragment.
    pub key: Option<String>,
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
            key: None,
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
}

struct Running {
    port: u16,
    key: String,
    url: Option<String>,
    snapshot: Arc<Mutex<Option<StoredSnapshot>>>,
    shared: Arc<Shared>,
    join: Option<JoinHandle<()>>,
}

/// The managed share state: at most one listening server (— single writer,
/// one listener). Cloned into Tauri as managed state, so the mutexes are the
/// only shared handles.
#[derive(Default)]
pub struct ShareState {
    inner: Mutex<Option<Running>>,
    consent: Mutex<Option<Consent>>,
}

/// A one-shot proof that the user confirmed the consent prompt.
/// Starting the LAN server binds `0.0.0.0` and puts a read-only view of
/// the user's money and notes on the network; that must not be one bare call
/// away.
#[derive(Debug)]
struct Consent {
    token: String,
    granted: Instant,
}

/// How long a consent token stays usable. The user is confirming a dialog that
/// is already on screen, so this only has to survive a round trip — it exists
/// so a token found in a log or a crash dump later is worthless.
const CONSENT_TTL: Duration = Duration::from_secs(120);

/// Refusal when sharing is started without a fresh consent token. Says what to
/// do, because the UI is the only thing that can obtain one.
const NO_CONSENT: &str =
    "sharing must be confirmed first: call share_arm, then share_start with the token it returns";

impl ShareState {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Option<Running>>, String> {
        // Recover from a poisoned mutex: a panic while holding the
        // guard drops it atomically, so the state is consistent — refusing
        // every later call would wedge sharing for the rest of the session.
        // Unwind-only path: release builds abort on panic (RELEASE.md).
        Ok(self.inner.lock().unwrap_or_else(|e| e.into_inner()))
    }

    fn consent_lock(&self) -> Result<std::sync::MutexGuard<'_, Option<Consent>>, String> {
        // Recovery, same rule as `lock`: a poison left by a panicking
        // command must not make consent unobtainable for the rest of the
        // session — there is no path back except restarting the app.
        // Unwind-only path: release builds abort on panic (RELEASE.md).
        Ok(self.consent.lock().unwrap_or_else(|e| e.into_inner()))
    }

    /// Record the user's confirmation and return a token for [`Self::start`].
    ///
    /// Issuing is not consent: only `start` consumes the token, and only once.
    pub fn arm(&self) -> Result<String, String> {
        let token = random_hex(CONSENT_TOKEN_BYTES)?;
        let mut guard = self.consent_lock()?;
        *guard = Some(Consent {
            token: token.clone(),
            granted: Instant::now(),
        });
        Ok(token)
    }

    /// Take the consent token if it matches and is still fresh.
    ///
    /// The token is cleared on *every* attempt, matched or not. That is the
    /// security-relevant choice: a mismatch burns the real token, so probing for
    /// a valid one costs an arming per guess instead of yielding an oracle. The
    /// cost to a legitimate user is one extra tap on "confirm".
    fn take_consent(&self, presented: &str) -> Result<(), String> {
        let mut guard = self.consent_lock()?;
        let Some(consent) = guard.take() else {
            return Err(NO_CONSENT.to_string());
        };
        if consent.granted.elapsed() > CONSENT_TTL {
            return Err(format!("{NO_CONSENT} (the confirmation expired)"));
        }
        if !constant_time_eq(presented, &consent.token) {
            return Err(NO_CONSENT.to_string());
        }
        Ok(())
    }

    /// Start sharing, binding every interface so the phone can reach it.
    ///
    /// Requires a consent token from [`Self::arm`]: see [`NO_CONSENT`].
    /// Idempotent while running: a second call returns the live link (and still
    /// needs a fresh token, because the caller asked to share again).
    pub fn start(&self, consent_token: &str) -> Result<ShareInfo, String> {
        self.take_consent(consent_token)?;
        self.start_on("0.0.0.0")
    }

    /// Testable bind: production goes through [`Self::start`], which takes the
    /// consent token first; tests bind loopback via a token of their own.
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
        let key = generate_share_key()?;
        let url = lan_ip().map(|ip| format!("http://{ip}:{port}/#key={key}"));
        let snapshot: Arc<Mutex<Option<StoredSnapshot>>> = Arc::new(Mutex::new(None));
        let shared = Arc::new(Shared::default());

        let thread_snapshot = Arc::clone(&snapshot);
        let thread_shared = Arc::clone(&shared);
        let join = thread::Builder::new()
            .name("purple-memo-share".to_string())
            .spawn(move || serve(server, thread_snapshot, thread_shared))
            .map_err(|e| format!("could not start the share thread: {e}"))?;

        let running = Running {
            port,
            key,
            url,
            snapshot,
            shared,
            join: Some(join),
        };
        let info = running.info(None);
        *guard = Some(running);
        // The encryption key is deliberately NOT logged. It stays in the URL
        // fragment and is never sent in an HTTP request.
        crate::note_share_event(ShareEvent::Started(info.port.unwrap_or(0)));
        Ok(info)
    }

    /// Stop sharing and wait for the listener to close. Idempotent.
    pub fn stop(&self) -> Result<ShareInfo, String> {
        let mut guard = self.lock()?;
        match guard.take() {
            Some(running) => {
                reap(running);
                crate::note_share_event(ShareEvent::Stopped(None));
                Ok(ShareInfo::stopped(None))
            }
            None => Ok(ShareInfo::stopped(None)),
        }
    }

    /// Stop the server AND clear any outstanding consent token — factory reset
    /// only. Returns `true` when there was something to remove (a
    /// running server or a pending token) and `false` when sharing was already
    /// fully off, which the reset engine reports as "already absent" rather
    /// than as an error.
    ///
    /// The consent token matters even with the server stopped: a live token
    /// outlives a stop and could reopen the listener, which after a reset
    /// would serve a database that no longer exists.
    pub fn stop_for_reset(&self) -> Result<bool, String> {
        let mut removed = false;
        {
            let mut guard = self.lock()?;
            if let Some(running) = guard.take() {
                reap(running);
                crate::note_share_event(ShareEvent::Stopped(None));
                removed = true;
            }
        }
        if self.consent_lock()?.take().is_some() {
            removed = true;
        }
        Ok(removed)
    }

    /// Current state — also reaps a server that shut itself down.
    pub fn status(&self) -> Result<ShareInfo, String> {
        let mut guard = self.lock()?;
        match guard.as_ref() {
            Some(r) if !r.server_is_gone() => Ok(r.info(None)),
            Some(_) => {
                let running = guard.take().expect("checked above");
                reap(running);
                Ok(ShareInfo::stopped(None))
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
                    // Recover from poison — same rule as `lock`: the
                    // slot is Option<StoredSnapshot>, consistent after a panic.
                    // Unwind-only path: release aborts on panic.
                    let mut slot = r.snapshot.lock().unwrap_or_else(|e| e.into_inner());
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
        self.join.as_ref().is_some_and(|j| j.is_finished())
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
            key: Some(self.key.clone()),
            port: Some(self.port),
            published_at,
            note,
        }
    }
}

/// Signal the accept loop and wait for it to exit.
///
/// The join is bounded by `POLL_INTERVAL`, not by a client: the accept loop
/// never writes a response itself, so this returns even when a
/// worker is stuck writing to a socket nobody is reading.
fn reap(mut running: Running) {
    // Clear personal data before signalling the listener, so a request racing
    // with shutdown can never receive the last published snapshot.
    if let Ok(mut snapshot) = running.snapshot.lock() {
        *snapshot = None;
    }
    running.shared.stop.store(true, Ordering::SeqCst);
    if let Some(join) = running.join.take() {
        let _ = join.join();
    }
}

/// A fresh 256-bit AES key from the OS random source, encoded as lowercase hex.
pub fn generate_share_key() -> Result<String, String> {
    random_hex(32)
}

/// Entropy in the consent token. 32 bytes = 256 bits, so guessing one is not
/// a thing anyone can do, and a leaked one is useless after its TTL.
const CONSENT_TOKEN_BYTES: usize = 32;

/// Lowercase hex, from the OS CSPRNG.
fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| format!("OS random source unavailable: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Best-effort local network address for the printed link. Binding a UDP
/// socket and "connecting" it sends nothing — it only asks the OS which
/// source address the default route would use.
fn lan_ip() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    // RFC 5737 TEST-NEroutable-looking, never a real destination.
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

/// Validate an encrypted snapshot envelope before it is exposed on the LAN.
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
    // Only the versioned AES-GCM envelope is served; plaintext snapshots are
    // rejected at the native boundary.
    let version = object
        .get("version")
        .and_then(JsonValue::as_i64)
        .ok_or_else(|| "snapshot is missing its numeric version".to_string())?;
    if version != 1 {
        return Err("unsupported encrypted snapshot version".to_string());
    }
    let generated_at = object
        .get("generatedAt")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| "snapshot is missing its generatedAt string".to_string())?;
    for field in ["nonce", "ciphertext"] {
        if !object
            .get(field)
            .and_then(JsonValue::as_str)
            .is_some_and(|value| !value.is_empty())
        {
            return Err(format!("encrypted snapshot is missing {field}"));
        }
    }
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
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; \
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

fn javascript(body: &str) -> Response<Cursor<Vec<u8>>> {
    let mut response = Response::from_string(body.to_string()).with_status_code(StatusCode(200));
    add_header(
        &mut response,
        "Content-Type",
        "text/javascript; charset=utf-8",
    );
    add_header(&mut response, "Cache-Control", "no-store");
    add_header(&mut response, "X-Content-Type-Options", "nosniff");
    add_header(&mut response, "Referrer-Policy", "no-referrer");
    response
}

/// The accept loop: poll, admit a request to a worker, stop on shutdown or
/// abuse.
///
/// The loop itself never writes a response, so nothing a client does to its
/// socket can keep this thread from noticing `shared.stop`. The
/// workers are deliberately not joined on the way out: one may be blocked in
/// `respond`, and `stop` must not wait on it. `reap` clears the published
/// snapshot *before* setting the flag, so a worker that has not answered yet
/// falls through to the 503 path rather than serving the user's data.
fn serve(server: Server, snapshot: Arc<Mutex<Option<StoredSnapshot>>>, shared: Arc<Shared>) {
    let mut consecutive_errors = 0u32;
    let mut workers: Vec<JoinHandle<()>> = Vec::new();
    while !shared.stop.load(Ordering::SeqCst) {
        // Finished workers leave the list; a stalled one stays and keeps its
        // slot, which is what bounds concurrent stalled clients.
        workers.retain(|worker| !worker.is_finished());
        match server.recv_timeout(POLL_INTERVAL) {
            Ok(Some(request)) => {
                consecutive_errors = 0;
                if !has_capacity(workers.len()) {
                    // Every slot is held by a client that is slow to read.
                    // Dropping the connection closes it immediately; answering
                    // here would put this loop behind the same slow write it
                    // exists to stay out of.
                    drop(request);
                    continue;
                }
                let worker_snapshot = Arc::clone(&snapshot);
                let spawned = thread::Builder::new()
                    .name("purple-memo-share-worker".to_string())
                    .spawn(move || handle(request, &worker_snapshot));
                // On `Err` there is no thread to track: the request was dropped
                // with the closure, so the client sees a closed connection
                // rather than a stuck one.
                if let Ok(join) = spawned {
                    workers.push(join);
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

/// The request's `Host` headers, taken together, are acceptable only when
/// there is **exactly one** and it is allowed.
///
/// HTTP permits a request to carry the header more than once, and the old
/// check accepted the request if *any* of them was allowed — so a rebound
/// name could ride in alongside a good one (`Host: evil.example.com` +
/// `Host: 127.0.0.1`, in either order) and be waved through by its companion.
/// Zero headers is rejected too: a request that names no host was never one
/// we issued a link for.
fn single_host_is_allowed(hosts: &[&str]) -> bool {
    match hosts {
        [only] => host_is_allowed(only),
        _ => false,
    }
}

/// Serve one request. Returns false when the loop must end.
fn handle(request: Request, snapshot: &Mutex<Option<StoredSnapshot>>) {
    if request.method() != &Method::Get {
        let _ = request.respond(plain(405, "only GET is served here\n"));
        return;
    }
    let hosts: Vec<&str> = request
        .headers()
        .iter()
        .filter(|h| h.field.equiv("Host"))
        .map(|h| h.value.as_str())
        .collect();
    if !single_host_is_allowed(&hosts) {
        let _ = request.respond(plain(421, "unexpected host\n"));
        return;
    }
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or(&url);

    match path {
        "/" | "/index.html" => {
            let _ = request.respond(page(render_page()));
        }
        "/_crypto/aes.js" => {
            let _ = request.respond(javascript(AES_MODULE));
        }
        "/_crypto/_polyval.js" => {
            let _ = request.respond(javascript(POLYVAL_MODULE));
        }
        "/_crypto/utils.js" => {
            let _ = request.respond(javascript(UTILS_MODULE));
        }
        "/_snapshot.js" => {
            let _ = request.respond(javascript(SNAPSHOT_MODULE));
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
}

// ---------------------------------------------------------------------------
// Tests — run with `cargo test`
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream as StdTcpStream;
    use std::sync::mpsc;

    /// Minimal raw HTTP/1.1 GET — enough to exercise the listener.
    fn get(port: u16, path: &str) -> (u16, String) {
        get_with_hosts(port, path, &["127.0.0.1"])
    }

    /// A GET carrying exactly the given `Host` headers, in the given order.
    /// The duplicate-Host regression needs to send two, which `get` cannot.
    fn get_with_hosts(port: u16, path: &str, hosts: &[&str]) -> (u16, String) {
        let mut stream = StdTcpStream::connect(("127.0.0.1", port)).expect("connect to share");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("timeout");
        let host_lines: String = hosts.iter().map(|h| format!("Host: {h}\r\n")).collect();
        write!(
            stream,
            "GET {path} HTTP/1.1\r\n{host_lines}Connection: close\r\n\r\n"
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
        format!(
            "{{\"version\":1,\"generatedAt\":\"{generated_at}\",\
             \"nonce\":\"bm9uY2U=\",\"ciphertext\":\"c2VhbGVk\"}}"
        )
    }

    /// A listener on loopback with a known encryption key; always stopped.
    fn started() -> (ShareState, u16, String) {
        let state = ShareState::new();
        let info = state.start_on("127.0.0.1").expect("start share");
        let port = info.port.expect("port");
        let key = info.key.expect("encryption key");
        (state, port, key)
    }

    #[test]
    fn generated_share_keys_are_256_bit_hex_and_random() {
        let a = generate_share_key().expect("key");
        let b = generate_share_key().expect("key");
        assert_eq!(a.len(), 64);
        assert!(a
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a, b, "two keys must not collide");
    }

    #[test]
    fn constant_time_comparison_matches_only_equal_secrets() {
        assert!(constant_time_eq("ABC234", "ABC234"));
        assert!(!constant_time_eq("ABC234", "ABC235"));
        assert!(!constant_time_eq("ABC234", "ABC23"));
        assert!(!constant_time_eq("", "ABC234"));
    }

    // more than one request at a time (so one slow client cannot delay
    // the next). Checked at compile time — a constant, so a runtime assertion
    // would be dead weight clippy (rightly) flags.
    const _: () = assert!(MAX_WORKERS >= 2, "a single worker is the stall this fixes");

    #[test]
    fn the_worker_pool_is_bounded_and_admits_up_to_the_cap() {
        // Other half: a hard cap, so a flood cannot mint threads.
        assert!(has_capacity(0));
        assert!(has_capacity(MAX_WORKERS - 1));
        assert!(!has_capacity(MAX_WORKERS), "the cap is exclusive");
        assert!(!has_capacity(MAX_WORKERS + 1));
    }

    #[test]
    fn stop_does_not_wait_for_an_in_flight_client() {
        // The lock path calls this. A client holding a half-sent request must
        // not extend it: the accept loop only polls, it never writes a
        // response on this thread.
        //
        // `stop` runs on a worker thread so the verdict is a clean, bounded
        // assertion instead of a hung test binary. The property being tested
        // is "stop answers while the silent client is still connected" — if
        // teardown ever waits on that client again, this channel goes quiet,
        // the test FAILS at the bound, and the panic's unwind closes
        // `stalled`, releasing whatever was blocked on it. The bound is
        // deliberately generous (10 s, not the happy-path ~100 ms): the suite
        // runs 120+ tests in parallel on this machine, and a wall-clock budget
        // tight enough to flake under load is worse than no budget at all.
        // What the bound must catch is "forever", and forever never answers.
        let (state, port, _key) = started();
        let mut stalled = StdTcpStream::connect(("127.0.0.1", port)).expect("connect");
        stalled
            .write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n")
            .expect("partial request");
        stalled.flush().ok();

        let (done_tx, done_rx) = mpsc::channel();
        thread::spawn(move || {
            let _ = state.stop();
            let _ = done_tx.send(());
        });
        assert!(
            done_rx.recv_timeout(Duration::from_secs(10)).is_ok(),
            "stop is waiting on the in-flight client instead of closing the listener"
        );
        drop(stalled);
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
        // Reusing a running listener is still a "start", so it still needs its
        // own token — the caller asked to put the data on the network again.
        let again = state
            .start(&state.arm().expect("arm"))
            .expect("second start");
        assert_eq!(again.port, Some(port), "the live listener is reused");
        assert_eq!(again.key, Some(code));
        assert!(!state.stop().expect("stop").running);
    }

    // -- Consent gate -----------------------------------------

    #[test]
    fn starting_without_consent_is_refused_and_binds_nothing() {
        // The bare call - what an accident or a stray invocation looks like -
        // must not put the user's notes and balances on the network.
        let state = ShareState::new();
        let err = state.start("").expect_err("consent must be required");
        assert!(
            err.contains("share_arm"),
            "points at the consent step: {err}"
        );
        assert!(!state.status().expect("status").running);
        assert!(state.status().expect("status").port.is_none());
    }

    #[test]
    fn a_wrong_token_is_refused_and_burns_the_real_one() {
        let state = ShareState::new();
        let real = state.arm().expect("arm");
        let wrong = "0".repeat(real.len());
        assert_ne!(wrong, real);

        let err = state.start(&wrong).expect_err("must refuse");
        assert!(
            err.contains("share_arm"),
            "points at the consent step: {err}"
        );
        assert!(!state.status().expect("status").running);
        assert!(state.status().expect("status").port.is_none());

        // Presenting a wrong token spends the real one. That is deliberate: it
        // gives an attacker probing for a valid token exactly one guess per
        // arming instead of an oracle, and a legitimate user who fumbled simply
        // confirms again.
        assert!(
            state.take_consent(&real).is_err(),
            "a rejected attempt must not leave the token usable"
        );
    }

    #[test]
    fn a_consent_token_is_good_for_exactly_one_start() {
        // Single use, so a rejected start cannot be retried into a listener and
        // a token found in a log cannot be replayed later.
        let state = ShareState::new();
        let token = state.arm().expect("arm");
        assert!(state.take_consent(&token).is_ok(), "first use is valid");
        assert!(
            state.take_consent(&token).is_err(),
            "the same token must not work twice"
        );

        // And arming again replaces the spent one.
        let fresh = state.arm().expect("arm");
        assert!(state.take_consent(&fresh).is_ok());
    }

    #[test]
    fn arming_again_invalidates_the_previous_token() {
        let state = ShareState::new();
        let first = state.arm().expect("arm");
        let second = state.arm().expect("arm");
        assert_ne!(first, second, "each arming mints a fresh token");
        assert!(
            state.take_consent(&first).is_err(),
            "only the newest token can be spent, and spending burns it"
        );
        assert!(
            state.take_consent(&second).is_err(),
            "the second token went when the stale one was presented"
        );
        // A fresh confirmation always works.
        assert!(state.take_consent(&state.arm().expect("arm")).is_ok());
    }

    #[test]
    fn consent_tokens_are_unpredictable_and_long() {
        let state = ShareState::new();
        let a = state.arm().expect("arm");
        let b = state.arm().expect("arm");
        assert_eq!(a.len(), CONSENT_TOKEN_BYTES * 2, "256 bits of hex");
        assert_ne!(a, b);
        assert!(
            a.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "lowercase hex"
        );
    }

    #[test]
    fn stop_consumes_a_token_too() {
        // Starting is the disclosure; stopping is not. A token must not be
        // spendable on the harmless direction.
        let state = ShareState::new();
        let token = state.arm().expect("arm");
        assert!(!state.stop().expect("stop").running);
        assert!(
            state.take_consent(&token).is_ok(),
            "stopping does not need consent"
        );
    }

    #[test]
    fn stop_for_reset_reports_whether_it_removed_a_server_or_a_token() {
        // Factory reset needs to know "was there anything here?":
        // a fully off share is already absent, not a failure. And a token that
        // survived an ordinary `stop` must not survive a reset — it could
        // reopen the listener and serve a database that no longer exists.
        let idle = ShareState::new();
        assert!(!idle.stop_for_reset().expect("stop"), "nothing to remove");

        let armed = ShareState::new();
        let token = armed.arm().expect("arm");
        assert!(
            armed.stop_for_reset().expect("stop"),
            "an armed consent token counts as something to remove"
        );
        assert!(
            armed.take_consent(&token).is_err(),
            "the token must be gone after a reset stop"
        );
        assert!(
            !armed.stop_for_reset().expect("stop again"),
            "idempotent: the second call finds nothing"
        );

        let (running, _port, _key) = started();
        assert!(running.stop_for_reset().expect("stop the server"));
        assert!(!running.status().expect("status").running);
        assert!(
            !running.stop_for_reset().expect("stop again"),
            "idempotent after stopping a server too"
        );
    }

    // -- The audit trail ------------------------------------------

    #[test]
    fn the_share_audit_line_names_the_port_and_never_the_encryption_key() {
        let line = ShareEvent::Started(8765).audit_line();
        assert!(line.contains("8765"), "the port is what the user needs");
        assert!(line.to_lowercase().contains("started"));
        assert!(
            line.to_lowercase().contains("valid consent token"),
            "the line states what the backend actually verified — a valid, \
             unexpired, one-shot token — not a checkbox it never saw: {line}"
        );
        // The encryption key has no path into this string: the event carries
        // only the port.
        let key = generate_share_key().expect("key");
        assert!(!line.contains(&key));
    }

    #[test]
    fn a_share_that_stopped_on_its_own_says_so_in_the_log() {
        assert_eq!(
            ShareEvent::Stopped(None).audit_line(),
            "LAN share STOPPED by the user"
        );
        assert!(
            ShareEvent::Stopped(Some("server stopped unexpectedly".to_string()))
                .audit_line()
                .contains("server stopped unexpectedly"),
            "the reason is kept - that is the line worth having"
        );
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
    fn host_header_guard_needs_exactly_one_allowed_host() {
        assert!(single_host_is_allowed(&["127.0.0.1:8765"]));
        assert!(single_host_is_allowed(&["localhost"]));
        assert!(!single_host_is_allowed(&[]), "no Host header at all");
        assert!(!single_host_is_allowed(&["evil.example.com"]));
        // The regression: a good header must not wave a bad one through,
        // whichever order they arrive in, and two good ones are still two.
        assert!(!single_host_is_allowed(&["evil.example.com", "127.0.0.1"]));
        assert!(!single_host_is_allowed(&["127.0.0.1", "evil.example.com"]));
        assert!(!single_host_is_allowed(&["127.0.0.1", "127.0.0.1"]));
    }

    #[test]
    fn phone_page_uses_a_fragment_key_and_same_origin_crypto_modules() {
        let (state, port, code) = started();
        let (status, body) = get(port, "/");
        assert_eq!(status, 200);
        assert!(body.contains("location.hash"));
        assert!(
            body.contains("/_snapshot.js"),
            "the page imports the shared decryptor"
        );
        assert!(
            !body.contains(&code),
            "the page response never contains its key"
        );
        assert!(
            state
                .status()
                .expect("status")
                .url
                .is_some_and(|url| url.ends_with(&format!("#key={code}"))),
            "the key is carried only in the URL fragment"
        );
        assert_eq!(get(port, "/_crypto/aes.js").0, 200);
        assert_eq!(get(port, "/_crypto/_polyval.js").0, 200);
        assert_eq!(get(port, "/_crypto/utils.js").0, 200);
        let (snapshot_status, snapshot_module) = get(port, "/_snapshot.js");
        assert_eq!(snapshot_status, 200);
        assert!(
            snapshot_module.contains("export function decryptSnapshot"),
            "the served module is the one the test executes"
        );
        assert!(
            snapshot_module.contains("from \"./_crypto/aes.js\""),
            "the relative import resolves over HTTP and on disk"
        );
        assert_eq!(get(port, "/api/snapshot").0, 503);
        state.stop().expect("stop");
    }

    #[test]
    fn snapshot_endpoint_serves_only_the_encrypted_envelope() {
        let (state, port, _key) = started();
        let (status, _) = get(port, "/api/snapshot");
        assert_eq!(status, 503, "nothing published yet");

        let info = state
            .publish(&payload("2026-10-12T09:30"))
            .expect("publish");
        assert_eq!(info.published_at.as_deref(), Some("2026-10-12T09:30"));

        let (status, body) = get(port, "/api/snapshot");
        assert_eq!(status, 200);
        assert!(body.contains("\"ciphertext\":\"c2VhbGVk\""), "{body}");
        assert!(!body.contains("today"), "plaintext data must not be served");
        state.stop().expect("stop");
    }

    #[test]
    fn stopping_sharing_revokes_the_published_snapshot() {
        let (state, _port, _code) = started();
        state
            .publish(&payload("2026-10-12T09:30"))
            .expect("publish");
        let stopped = state.stop().expect("stop");
        assert!(!stopped.running);
        assert!(stopped.published_at.is_none());
        assert!(!state.status().expect("status").running);
    }

    #[test]
    fn only_get_is_served_and_unknown_paths_are_404() {
        let (state, port, _key) = started();
        assert_eq!(get(port, "/nope").0, 404);
        assert_eq!(get(port, "/favicon.ico").0, 404);
        state.stop().expect("stop");
    }

    #[test]
    fn duplicate_host_headers_are_rejected_without_exposing_the_snapshot() {
        let (state, port, _key) = started();
        for hosts in [
            ["evil.example.com", "127.0.0.1"],
            ["127.0.0.1", "evil.example.com"],
        ] {
            assert_eq!(
                get_with_hosts(port, "/api/snapshot", &hosts).0,
                421,
                "two Host headers ({hosts:?}) must be rejected outright"
            );
        }
        assert_eq!(get(port, "/").0, 200);
        state.stop().expect("stop");
    }

    #[test]
    fn publish_rejects_plaintext_and_malformed_envelopes() {
        let (state, _port, _code) = started();
        assert!(state.publish("{").is_err(), "invalid JSON");
        assert!(state.publish("[]").is_err(), "not an object");
        assert!(
            state
                .publish("{\"version\":1,\"generatedAt\":\"x\"}")
                .is_err(),
            "missing nonce and ciphertext"
        );
        assert!(
            state
                .publish(
                    "{\"version\":2,\"generatedAt\":\"x\",\"nonce\":\"n\",\"ciphertext\":\"c\"}"
                )
                .is_err(),
            "unsupported version"
        );
        let huge = format!(
            "{{\"version\":1,\"generatedAt\":\"x\",\"nonce\":\"n\",\"ciphertext\":\"{}\"}}",
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
            url: Some(format!("http://10.0.0.4:8765/#key={}", "ab".repeat(32))),
            key: Some("ab".repeat(32)),
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
