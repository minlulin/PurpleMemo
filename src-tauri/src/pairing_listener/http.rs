//! The pairing window's HTTP layer (§11.1, N5): the accept loop, the worker
//! that serves one connection, and the request/response codec it speaks.
//!
//! No response ever grants a browser origin: the phone's sealed client invokes
//! HTTP from Rust, not from a WebView `fetch` (§11.6.1).

use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{json, Value as JsonValue};

use super::frame::encode_frame;
use super::routes;
use super::routes::common::{active_pin, admit};
use super::{Gate, RefusalReply, Shared, FRAME_HEADER_BYTES, MAX_FRAME_BYTES};

/// A sealed message from the pinned peer (§11.6.1).
const HELLO_PATH: &str = "/pair/hello";

/// The §8.4 snapshot pull: sealed `snapshot-request` / `applied` / `adopted`.
const SNAPSHOT_PATH: &str = "/pair/snapshot";

/// The code-confirmed rendezvous that pins a peer for the first time (§11.1).
const REQUEST_PATH: &str = "/pair/request";

/// The §9.1 upload: sealed `upload` / `upload-commit` / `upload-status`.
const UPLOAD_PATH: &str = "/pair/upload";

/// The §6 ongoing exchange: `sync-push` / `sync-commit` / `sync-pull` /
/// `sync-applied` / `sync-status`. A fourth route with its own kind set, for
/// the same reason each of the others has one (§2.3).
const SYNC_PATH: &str = "/pair/sync";

/// The message kinds `/pair/hello` speaks (§2.3's server-side seam). An
/// operation of any other kind is refused before it can have an effect.
const ACCEPTED_KINDS: [&str; 1] = ["hello"];

/// The kinds `/pair/snapshot` speaks — its own accepted set, never appended to
/// the hello's: a window that pulled data would be one a hello could not close.
const SNAPSHOT_ACCEPTED_KINDS: [&str; 3] = ["snapshot-request", "applied", "adopted"];

/// The kinds `/pair/upload` speaks — again its own set (§2.3): the route that
/// receives records never answers a pull, and the route that serves them never
/// stages an upload.
const UPLOAD_ACCEPTED_KINDS: [&str; 3] = ["upload", "upload-commit", "upload-status"];

/// The kinds `/pair/sync` speaks. The push half and the pull half share the
/// route because they are one exchange — but the kind set is still the route's
/// own: a snapshot message posted here is refused by name.
const SYNC_ACCEPTED_KINDS: [&str; 5] = [
    "sync-push",
    "sync-commit",
    "sync-pull",
    "sync-applied",
    "sync-status",
];

/// How long the accept loop sleeps between non-blocking accepts: the bound on
/// how long a `stop` waits to be seen, and on how long a phone waits to be
/// accepted.
const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// Responses served at once: a client that stalls owns a worker, never the
/// accept loop. Two is enough for a phone plus a retry.
const MAX_WORKERS: usize = 2;

/// How long one connection may take, end to end, before its worker gives up on
/// it. Every read and write is bounded by this too, so a client that dribbles a
/// byte at a time cannot hold a worker either (§11.1, N5).
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(5);

/// A request head is a request line and a handful of headers. Anything larger is
/// a client that will not be served.
const MAX_HEAD_BYTES: usize = 8 * 1024;

/// The reason phrase for every status this listener can answer with.
fn status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Internal Server Error",
    }
}

/// Write one response; the caller's stream is dropped afterwards, which closes
/// the connection.
///
/// No `Access-Control-Allow-Origin` is ever sent (§11.1, N5): the phone's sealed
/// client invokes HTTP from Rust, not from a WebView `fetch`, so no browser is
/// meant to read this port and a wildcard grant would only widen it.
fn write_response(stream: &mut TcpStream, status: u16, body: &[u8]) -> std::io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/octet-stream\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n",
        status_text(status)
    );
    // A 204 has no body and must not carry a length (RFC 9110 §6.4.1).
    if status != 204 {
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    head.push_str("\r\n");
    let mut wire = head.into_bytes();
    wire.extend_from_slice(body);
    stream.write_all(&wire)
}

/// Read one request: a bounded head, then exactly the body its `Content-Length`
/// promises. Bounded in bytes *and* in time, so neither a huge head nor a slow
/// drip holds the worker past [`CONNECTION_TIMEOUT`].
fn read_request(stream: &mut TcpStream) -> Result<(String, String, Vec<u8>), RefusalReply> {
    let deadline = Instant::now() + CONNECTION_TIMEOUT;
    let too_slow = || RefusalReply::malformed("the request did not arrive in time.");
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= MAX_HEAD_BYTES {
            return Err(RefusalReply::malformed("the request head is too large."));
        }
        if Instant::now() >= deadline {
            return Err(too_slow());
        }
        match stream.read(&mut byte) {
            Ok(0) => return Err(RefusalReply::malformed("the request head ended early.")),
            Ok(_) => head.push(byte[0]),
            Err(_) => return Err(too_slow()),
        }
    }
    let text = String::from_utf8(head)
        .map_err(|_| RefusalReply::malformed("the request head is not UTF-8."))?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split(' ');
    let (Some(method), Some(target)) = (parts.next(), parts.next()) else {
        return Err(RefusalReply::malformed(
            "the request line is not METHOD TARGET HTTP/x.y.",
        ));
    };
    if !parts
        .next()
        .is_some_and(|version| version.starts_with("HTTP/1."))
    {
        return Err(RefusalReply::malformed("a pairing message is HTTP/1.x."));
    }

    let mut content_length: Option<usize> = None;
    for line in lines {
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(RefusalReply::malformed("a header has no colon."));
        };
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => {
                let length = value
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| RefusalReply::malformed("Content-Length is a number."))?;
                if content_length.replace(length).is_some() {
                    return Err(RefusalReply::malformed("Content-Length is sent once."));
                }
            }
            // A chunked body is not a pairing message: the frame carries its own
            // length and the HTTP body is exactly that (§11.6.1).
            "transfer-encoding" => {
                return Err(RefusalReply::malformed(
                    "a pairing message is not chunked; send one framed body.",
                ))
            }
            _ => {}
        }
    }

    let body_limit = MAX_FRAME_BYTES + FRAME_HEADER_BYTES + 1;
    let length = content_length.unwrap_or(0);
    if length > body_limit {
        return Err(RefusalReply::malformed(
            "the request body is larger than a pairing message.",
        ));
    }
    let mut body = Vec::with_capacity(length);
    let mut chunk = [0u8; 8192];
    while body.len() < length {
        if Instant::now() >= deadline {
            return Err(too_slow());
        }
        let want = (length - body.len()).min(chunk.len());
        match stream.read(&mut chunk[..want]) {
            Ok(0) => return Err(RefusalReply::malformed("the request body ended early.")),
            Ok(read) => body.extend_from_slice(&chunk[..read]),
            Err(_) => return Err(too_slow()),
        }
    }
    Ok((
        method.to_string(),
        target.split('?').next().unwrap_or(target).to_string(),
        body,
    ))
}

/// One answered connection: a status and, unless it is a bodiless 204, the
/// framed JSON document the phone reads (§11.6.1).
fn answer(stream: &mut TcpStream, gate: &Gate) -> (u16, Option<JsonValue>) {
    let (method, path, body) = match read_request(stream) {
        Ok(request) => request,
        Err(refusal) => return (refusal.status, Some(refusal.body())),
    };
    let hello = path == HELLO_PATH;
    let snapshot = path == SNAPSHOT_PATH;
    let upload = path == UPLOAD_PATH;
    let sync = path == SYNC_PATH;
    if !hello && !snapshot && !upload && !sync && path != REQUEST_PATH {
        return (
            404,
            Some(json!({
                "ok": false,
                "reason": "not-found",
                "message": "the pairing listener serves POST /pair/hello, POST /pair/request, POST /pair/snapshot, POST /pair/upload and POST /pair/sync.",
            })),
        );
    }
    // Answered, never granted: the 204 carries no CORS headers (N5).
    if method == "OPTIONS" {
        return (204, None);
    }
    if method != "POST" {
        return (
            405,
            Some(json!({
                "ok": false,
                "reason": "method",
                "message": "a pairing message is POSTed.",
            })),
        );
    }
    // §11.3 before anything else: a revoked peer's key is not even looked at.
    // This gates sealed messages only — the rendezvous below *replaces* the
    // pin, and a revocation must never be a lockout from re-pairing. On the
    // snapshot route it also means the reader is never called, so not one batch
    // byte leaves the desktop.
    if (hello || snapshot || upload || sync) && active_pin(gate).is_some_and(|pin| pin.revoked) {
        let refusal = RefusalReply::refused(
            "revoked",
            "this device was revoked on the desktop; re-pair it before anything syncs (§11.3).",
        );
        return (refusal.status, Some(refusal.body()));
    }
    let outcome = if hello {
        admit(gate, &body, &ACCEPTED_KINDS)
            .and_then(|(pin, opened)| routes::hello::acknowledged(gate, &pin, opened))
    } else if snapshot {
        admit(gate, &body, &SNAPSHOT_ACCEPTED_KINDS)
            .and_then(|(pin, opened)| routes::snapshot::snapshot_answer(gate, &pin, &opened))
    } else if upload {
        admit(gate, &body, &UPLOAD_ACCEPTED_KINDS)
            .and_then(|(pin, opened)| routes::upload::upload_answer(gate, &pin, &opened))
    } else if sync {
        admit(gate, &body, &SYNC_ACCEPTED_KINDS)
            .and_then(|(pin, opened)| routes::sync::sync_answer(gate, &pin, &opened))
    } else {
        routes::hello::rendezvous(gate, &body)
    };
    match outcome {
        Ok(reply) => (200, Some(reply)),
        Err(refusal) => (refusal.status, Some(refusal.body())),
    }
}

/// The accept loop. It never writes a response itself, so a client that stalls
/// cannot keep `stop` from returning; and it joins every worker it spawned, so
/// no thread holding `Arc<Gate>` — and with it the local secret — outlives the
/// window (§11.1, N5).
pub(super) fn serve(listener: TcpListener, gate: Arc<Gate>, shared: Arc<Shared>) {
    // Non-blocking accept so the shutdown flag is read without a second socket.
    if listener.set_nonblocking(true).is_err() {
        return;
    }
    let mut consecutive_errors = 0u32;
    let mut workers: Vec<JoinHandle<()>> = Vec::new();
    while !shared.stop.load(Ordering::SeqCst) {
        workers.retain(|worker| !worker.is_finished());
        match listener.accept() {
            Ok((stream, _)) => {
                consecutive_errors = 0;
                if workers.len() >= MAX_WORKERS {
                    // Every slot is busy. Dropping closes the connection without
                    // putting this loop behind a worker that is still reading.
                    drop(stream);
                    continue;
                }
                let worker_gate = Arc::clone(&gate);
                if let Ok(join) = thread::Builder::new()
                    .name("purple-memo-pairing-worker".to_string())
                    .spawn(move || handle(stream, &worker_gate))
                {
                    workers.push(join);
                }
            }
            Err(ref error) if error.kind() == ErrorKind::WouldBlock => {
                consecutive_errors = 0;
                thread::sleep(POLL_INTERVAL);
            }
            // A client hanging up mid-handshake is normal; a listener that keeps
            // failing is not.
            Err(ref error)
                if matches!(
                    error.kind(),
                    ErrorKind::ConnectionAborted
                        | ErrorKind::ConnectionReset
                        | ErrorKind::Interrupted
                ) => {}
            Err(_) => {
                consecutive_errors += 1;
                if consecutive_errors >= 100 {
                    break;
                }
            }
        }
    }
    // Close the port first, then wait for the workers: a stop that returned with
    // `Gate`-holding threads alive would leave the local secret reachable after
    // the window is gone.
    drop(listener);
    for worker in workers {
        let _ = worker.join();
    }
}

/// Serve one connection: install the deadlines, answer, close.
fn handle(mut stream: TcpStream, gate: &Gate) {
    // `accept` hands over a socket that inherits the listener's non-blocking
    // mode, and a read timeout is ignored on one: the first read would answer
    // `WouldBlock` microseconds after the connection arrived, before a phone's
    // request was on the wire, and be refused as "did not arrive in time" (N5).
    // Clearing it here is what makes CONNECTION_TIMEOUT mean what it says.
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(CONNECTION_TIMEOUT));
    let _ = stream.set_write_timeout(Some(CONNECTION_TIMEOUT));
    let (status, body) = answer(&mut stream, gate);
    // A body that cannot be framed is a REFUSAL, never an empty 2xx: the old
    // `unwrap_or_default()` answered 200 with no bytes, which a phone reads as a
    // malformed batch after its own push has already committed — the two-way
    // wedge SW-04 describes. Named, and still framed, so the client can report
    // the reason instead of guessing (§7.7).
    let (status, framed) = match body {
        Some(body) => match encode_frame(&body.to_string()) {
            Ok(frame) => (status, frame),
            Err(message) => {
                let refusal = RefusalReply {
                    code: "frame-too-large",
                    message,
                    status: 500,
                    attempts_left: None,
                };
                let framed = encode_frame(&refusal.body().to_string())
                    .expect("a refusal body is far under the frame cap");
                (refusal.status, framed)
            }
        },
        None => (status, Vec::new()),
    };
    let _ = write_response(&mut stream, status, &framed);
}

#[cfg(test)]
mod tests {
    use super::*;

    use super::super::frame::decode_frame;
    use super::super::tests::{hello_frame, post, raw_response, request, started};

    use std::net::TcpStream as StdTcpStream;

    #[test]
    fn only_the_hello_endpoint_speaks_and_only_by_post() {
        let (state, port) = started(false);

        let (status, raw) = request(port, "GET /", b"");
        assert_eq!(status, 404, "no other path is served");
        let text = decode_frame(&raw).expect("even a 404 is one framed document");
        let reply: JsonValue = serde_json::from_str(&text).expect("reply json");
        assert_eq!(reply["reason"], json!("not-found"));

        let (status, raw) = request(port, "GET /pair/hello", b"");
        assert_eq!(status, 405, "a hello is POSTed");
        let text = decode_frame(&raw).expect("even a 405 is one framed document");
        let reply: JsonValue = serde_json::from_str(&text).expect("reply json");
        assert_eq!(reply["reason"], json!("method"));
        state.stop().expect("stop");
    }

    /// A stalled client owns a worker only until its own deadline: two of them
    /// cannot keep the real phone out of the window (§11.1, N5).
    #[test]
    fn two_stalled_connections_do_not_keep_the_phone_out() {
        let (state, port) = started(false);
        // Two clients announce a body and never send it: both worker slots are
        // held until the connection's own deadline expires.
        let mut stalled = Vec::new();
        for _ in 0..MAX_WORKERS {
            let mut stream = StdTcpStream::connect(("127.0.0.1", port)).expect("connect");
            write!(
                stream,
                "POST /pair/hello HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\n"
            )
            .expect("write head");
            stalled.push(stream);
        }
        thread::sleep(CONNECTION_TIMEOUT + Duration::from_millis(500));

        // The deadline freed the workers, so the real phone is served.
        let (status, body) = post(port, &hello_frame(1));
        assert_eq!(status, 200, "{body}");
        drop(stalled);
        state.stop().expect("stop");
    }

    #[test]
    fn no_response_grants_a_browser_origin() {
        let (state, port) = started(false);
        for line in ["POST /pair/hello", "OPTIONS /pair/hello"] {
            let head = String::from_utf8_lossy(&raw_response(port, line, &[])).to_lowercase();
            assert!(!head.contains("access-control"), "{line}: {head}");
        }
        state.stop().expect("stop");
    }
}
