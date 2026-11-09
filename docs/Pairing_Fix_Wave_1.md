# Pairing Foundation Fix — Wave 1 (must-fix before the sealed client)

**Source:** PR #24, Arena audit of the pairing foundation (`docs/Arena_Findings_Pairing_Foundation.md`, findings N1–N13 + decisions D1–D5). This document is self-contained: every finding in this wave is reproduced here in full, so the agent does not need the PR branch. The audit report itself is archived out of the repo; this wave plan is the work order.

**Base:** `dev` HEAD `4adb79b` (Phase C Session 6 verified green, partial: panel + phone entry built, two-device run impossible — the sealed client does not exist yet). **Branch:** `dev`. No commits to `main`, no version bumps, no new dependencies without justification.

**Ordering:** Wave 1 gates Session 7 (the phone's sealed transport client). Waves 2–3 do not gate Session 7.

## Decisions — settled by MinLulin 2026-11-09, do not re-decide

- **D1 — `POST /pair/request`:** sound in core, not ready to freeze. (a) Staging vs trust: rendezvous stages a candidate only; the `sync_peers` write happens only on explicit user confirmation after fingerprint comparison (N1). (b) Generation — **Option A (the flexible one):** `PairRequest` carries no generation (or the listener ignores it); the sealed `"paired"` ack delivers the desktop's authoritative `local_generation`, which the phone stores for this pairing. (c) Pre-code validation + timeouts per N5/N9. (d) Document `POST /pair/request` in spec §11.6.1.
- **D2 — forward secrecy:** **Option A (document as built).** The `es + ss` construction provides sender-key-compromise resistance and per-message key separation — NOT true ephemeral-ephemeral forward secrecy. Correct §11.6.1 and the `envelope.rs` / `envelope.ts` docstrings. True forward secrecy is deferred, bounded by §11.5's short-lived LAN window.
- **D5 — refusal code:** **`"needs-re-pair"`** is canonical (not `"generation-mismatch"`).

## Working rules (standing)

- Work one session at a time (~2 tasks max), then **STOP and report back**: what changed, commit sha, gate result, what is left. Do not start the next session unprompted.
- `npm run verify` must be green before any commit or push. A red gate is a blocker, not a note.
- Touch only the files listed per task (plus their tests and the listed spec lines). If a fix needs a file outside the list, STOP and ask — do not expand scope silently.
- Do not re-break anything in the audit's "Checked and Found Clean" section (slot separation, envelope AEAD + cross-language parity, framing, unbiased code + constant-time compare, `reap()` port-closure proof, §7.1 admission order).

---

## Session 1 — T1: N1 (High) — unconfirmed auto-pinning turns the 6-digit code into a bearer secret

**Evidence:**
- `src-tauri/src/pairing_listener.rs:968-976` — `rendezvous` immediately installs `gate.paired` for `POST /pair/hello`.
- `src/components/PairingPanel.tsx:127-133` — the 1-second poll auto-writes the peer's public key to `sync_peers` with zero user action, while `PairingPanel.tsx:209-210` renders prose telling the user to compare the fingerprint *"before you trust the pairing"*.
- `src/lib/sync/pairingPanel.ts:212-219` — `pinAdmittedPeer` looks up `existing` solely by the unauthenticated `deviceId` string; `src/lib/sync/store.ts:345-366` (`rePairStatements`) silently replaces the real phone's pinned public key, clears `revoked_at = NULL`, zeroes `cursor_in`/`cursor_out`, and deletes its `sync_outbox_delivery` and `sync_tombstone_acks` rows.
- Spec §11.1 (`docs/ANDROID_SYNC_PROTOCOL.md:559-562, 646-650`): a 6-digit code must never become a bearer password (F7) — trust needs out-of-band human fingerprint confirmation on both screens. `PairRequest` is plaintext and `request.device_id` is unauthenticated (`pairing_listener.rs:831-840`). No message sealed *by* `request.public_key` has been opened yet at rendezvous time (the ack is only sealed *to* it).

**What is wrong:** a LAN attacker who glimpses the 2-minute pairing screen (or hits 1-in-200,000 in 5 guesses) is pinned in `sync_peers` before the user can reject a mismatched fingerprint, and can clobber an existing paired phone's pin and sync cursors by spoofing its `device_id`. Once Stage 1 sync lands on `sync_peers`, that attacker gains full read/write sync access.

**Fix (contract — implement exactly this, do not re-decide the shape):**
1. The DB write is gated on explicit user confirmation. The panel must NOT auto-pin on the poll tick. Rendezvous stages a candidate peer in memory (`gate.paired` stays — it is what admits the phone's sealed hello); the panel shows a **pending-confirmation** state with BOTH fingerprints (desktop's + peer's), a warning when `deviceId` matches an existing peer ("Re-pairing existing phone … — this replaces its pinned key", showing the existing peer's `display_name` and fingerprint alongside the presented one), and explicit **Trust matching fingerprint** / **Reject** actions. `pinAdmittedPeer` runs only on Trust. Reject closes the window without writing to `sync_peers` and clears the staged candidate so the listener stops admitting that peer.
2. Key possession: the panel must not offer Trust until the staged peer has proven key possession with a sealed `POST /pair/hello` (opening it proves the requester holds the secret half of the presented key). Until then the panel shows "waiting for the phone's hello — key possession not yet proven". Expose this as a `peerHelloReceived: boolean` (or equivalent) on `PairingListenerInfo`, set when `admit()` accepts a hello from the staged peer.
3. **Scope note:** the phone's sealed transport client does not exist yet (Session 7 builds it). Implement the listener/panel state machine and the Rust socket tests now — the Rust test harness can seal a hello with the presented key. The end-to-end phone hello proof lands in Session 7.

**Tests to add/update:**
- Rust socket tests: rendezvous stages a candidate but writes nothing to any DB (the listener has no DB access — assert gate state only); a second rendezvous with a different key for the same `deviceId` replaces only the STAGED candidate, never a stored row; after Reject (window closed) a hello from the staged peer is refused.
- TS panel tests: the poll tick never calls `pin`; Trust calls `pin` once with the staged peer; Reject calls close without `pin`; a `deviceId` collision shows the warning + existing fingerprint; Trust is disabled (or the "waiting" state shows) until a sealed hello has been admitted.

**Files:** `src-tauri/src/pairing_listener.rs`, `src/components/PairingPanel.tsx`, `src/lib/sync/pairingPanel.ts`, `src/lib/sync/store.ts` (only if the staging contract needs it — prefer no change here), plus tests.

---

## Session 2 — T2: N5 (Med-high) — `POST /pair/request` DoS, blind attempt burning, NUL injection, stale counter, wildcard CORS

**Evidence:**
- `src-tauri/src/pairing_listener.rs:108` (`MAX_WORKERS = 2`), `:644, 661` (`Access-Control-Allow-Origin: *`), `:687-699` (worker cap, `drop(request)` past the cap), `:755, 982-990` (`read_body` blocks in `read_to_end` with no socket read timeout), `:534-540` (`reap()` joins only `serve`, never `workers`).
- `pairing_listener.rs:878-904` — `codes_equal` and `state.attempts += 1` run BEFORE checking `request.device_id == gate.local_device_id`, `request.pairing_id`, `request.protocol_version`, `request.schema_version`, `request.generation`, or `from_hex(&request.public_key)`.
- `src-tauri/src/envelope.rs:169-181` — `kdf_info` relies on `0x00` NUL separators so `(from, to, pairing_id)` cannot be re-split ambiguously; `PairRequest.device_id` is accepted as any arbitrary string (empty, 60 KB, or containing `\u0000`). Spec §1.2 specifies `device_id` as a canonical lowercase UUID v4.
- `pairing_listener.rs:972-976` — populating `gate.paired` replaces `active_pin(gate)` without resetting `*gate.last_counter` (`:451, 1001`); a window opened with `last_counter > 0` then rejects the newly paired peer's first hello (`counter: 1`) as `"replayed"`.

**What is wrong:** 2 stalled TCP connections permanently occupy both worker slots (legitimate phones get dropped) and keep worker threads plus `Arc<Gate>` (holding `local_secret: [u8; 32]`) alive after `stop()` returns. Any blind LAN script can burn all 5 attempts without knowing the `pairingId`. A probe with the *matching* code and a bogus `pairing_id` gets `"pairing-mismatch"` without an attempt — leaking that the code was right. Unvalidated `device_id` breaks the HKDF `info` NUL separation and can enter `sync_peers` raw. Re-pairing on a non-zero counter window causes replay false-positives. Wildcard CORS lets any local webpage `fetch` `/pair/request` and `/pair/hello`.

**Fix:**
1. Bound the read: a short per-connection read/write timeout (e.g. 5 s) on the accepted socket, or bound body reads before worker dispatch. A stalled body must never hold a worker forever.
2. `reap()` (or the serve loop on exit) must join the worker threads, so `stop()` never returns with `Gate`-holding threads alive.
3. Validate BEFORE touching the code or `attempts`, in this order: `pairing_id` (non-null and equal to `gate.pairing_id`), `device_id` (canonical lowercase UUID v4, no NULs), `public_key` (64 lowercase hex chars, a usable X25519 point), `protocol_version`, `schema_version`. Malformed metadata costs no attempt and must not leak code correctness — a probe with the right code and a bogus `pairing_id` gets `"pairing-mismatch"` with `attempts` unchanged, reached *before* any code comparison.
4. Reset `*gate.last_counter = 0` atomically when `gate.paired` is set.
5. Drop `Access-Control-Allow-Origin: *` from both response paths. The phone's sealed client invokes HTTP from Rust, not from a WebView fetch — no browser CORS is needed.

**Tests to add/update (Rust socket tests):**
- 2 stalled connections + 1 legitimate phone connection gets through (past the timeout).
- 5 blind dummy requests with a wrong `pairing_id` do not lock the code; a subsequent correct request still succeeds.
- Right code + wrong `pairing_id` → `"pairing-mismatch"`, `attempts` unchanged. Wrong code + right `pairing_id` → `"wrong-code"`, `attempts` + 1.
- NUL / empty / oversized `device_id`, non-hex or short `public_key` → refused without costing an attempt.
- Window opened with `last_counter > 0`, rendezvous, then hello `counter: 1` accepted.
- Responses carry no `Access-Control-Allow-Origin: *` header.

**Files:** `src-tauri/src/pairing_listener.rs` (plus `envelope.rs` only if the NUL validation belongs there — prefer the listener).

---

## Session 3 — T3: N9 (Med) + T7: N12 (Low)

### T3 — N9: windows with `pairing_id: None` accept hellos under the all-zero salt; `/pair/hello` skips the `same-device` check

**Evidence:**
- Spec §11.6.1 (`docs/ANDROID_SYNC_PROTOCOL.md:627-629`): "salt = the pairing id's UTF-8 bytes. 32 zero bytes only when the flow has no pairing id; a window with no pairing id refuses every hello, so that branch seals nothing in practice." The same claim is repeated in `src-tauri/src/envelope.rs:159-161` and `src/lib/sync/envelope.ts:115-117`.
- `src-tauri/src/pairing_listener.rs:897-904` (`rendezvous`) and `:1031-1039` (`admit`): `if let Some(expected) = gate.pairing_id.as_deref()` — the `pairingId` check is SKIPPED altogether when `gate.pairing_id` is `None` (which `PairingOpenInput.pairing_id: Option<String>` in `commands.rs:876` permits). Both paths then seal real envelopes under the all-zero salt `[0u8; 32]` with an empty `info` pairing suffix.
- `admit` never checks `pin.device_id == gate.local_device_id` (`"same-device"`, §1.2), while `rendezvous` (`:891`) and `protocol.ts:276` (`handshake`) do.

**Fix:** make `pairing_id: String` mandatory on `PairingWindow` / `PairingOpenInput` (preferred), or explicitly return `RefusalReply::refused("unpaired" / "pairing-mismatch", …)` at the top of both `rendezvous` and `admit` whenever `gate.pairing_id` is `None` (and the same in `pairing.ts:422` when `pinned.pairingId === null`). Update the callers (`commands.rs` `pairing_open`, `pairingPanel.ts` `openPairingPanel`) so a window can never be opened without a pairing id. Add the `pin.device_id == gate.local_device_id` `same-device` refusal in `admit`. If the zero-salt fallback stays in the code as a defensive default, its comment must say so honestly — no window without a pairing id is ever opened.

**Tests:** a window with `pairing_id: None` (if the `Option` is kept for the test) refuses every hello and every request; a same-device hello is refused with `"same-device"`.

**Files:** `src-tauri/src/pairing_listener.rs`, `src-tauri/src/commands.rs`, `src/lib/sync/pairing.ts`, plus tests.

### T7 — N12: `a_window_without_a_code_admits_no_first_pairing` tests `/pair/hello` instead of `/pair/request`

**Evidence:** `src-tauri/src/pairing_listener.rs:1701-1712` — the test builds a `PairRequest` payload with `request_body(|_| {})` (`offer == None`, `peer == None`) then sends it with `post(...)` (`POST /pair/hello`, `:1330-1332`) instead of `post_request(...)` (`POST /pair/request`, `:1335-1337`). It passes only because `admit` (`:994-998`) *also* returns `403 "unpaired"` when `active_pin(gate)` is `None`. `rendezvous`'s `let Some(offer) = gate.offer.as_ref() else { … }` guard (`:843-848`) has zero test coverage.

**Fix:** call `post_request(info.port.expect("port"), &request_body(|_| {}))`, and also assert the case where `pinless.peer` IS `Some(...)` while `pinless.offer` is `None`, so only `rendezvous`'s `offer.is_none()` check can produce `403 "unpaired"`.

**Files:** `src-tauri/src/pairing_listener.rs` (tests only).

---

## Session 4 — T4: N2 (High) — missing `Slot::PairingIdentity` silently mints a new key over a paired install; `Lost` has no recovery path

**Evidence:**
- `src-tauri/src/key_store/mod.rs:15-17` — `Ok(None)` is "only valid on a fresh install before minting; if data already exists on disk, db.rs treats this as KeyStoreError::Lost rather than minting a new key over an unreadable store."
- `src-tauri/src/pairing_key.rs:116-122` — `load_or_mint()` calls `mint()` unconditionally on `Ok(None)`, with no check for existing peers.
- `src-tauri/src/commands.rs:838-840, 864-866` — `pairing_local` / `pairing_open` call `load_or_mint()` directly.
- `src-tauri/src/key_store/desktop.rs:25-28` (`NoEntry => Ok(None)`), `android.rs:73-75, 83-100` (`NotFound => Ok(None)`; invalidated alias or corrupt blob => `Err(KeyStoreError::Lost(...))`).
- `src-tauri/src/lib.rs:255-268, 347-376` — boot handles `KeyStoreError::Lost` only for `Slot::Database` (wipe-to-continue screen). `Slot::PairingIdentity` is never checked at boot, and `load_or_mint()` flattens `Lost` to `Err(String)` (`pairing_key.rs:120`).
- Contrast: `src-tauri/src/db.rs:623` — "Purple Memo will not generate a new key over existing data" (the DEK path fails closed; the pairing path does not).

**What is wrong:** on desktop credential-store loss the app silently rotates its long-term identity key without flagging `re_pair_required` or revoking/marking existing pins (peers then fail with `unauthenticated` / `key-mismatch`). On Android, a lost/invalidated `purple_memo_pairing_key_wrap_v1` (or a truncated `pairing-key.wrapped`) wedges pairing permanently — `read()` returns `Err(Lost)` forever, with no recovery short of wiping all user data via full factory reset.

**Fix:**
1. Pass the database pairing state into `pairing_key::load_or_mint` (e.g. whether `sync_peers` has any rows or `sync_state` has ever paired). If `read(Slot::PairingIdentity)` returns `Ok(None)` while peers already exist, fail closed: set `sync_state.re_pair_required = 1` and require explicit user confirmation before minting a replacement identity key for re-pairing. A fresh install (no peers) still mints normally.
2. Preserve typed `KeyStoreError::Lost` from `Slot::PairingIdentity` (do not flatten it to a bare `String` where the UI needs it) so the UI can set `re_pair_required = 1`, delete only `Slot::PairingIdentity`, mint a fresh pairing identity upon user confirmation, and direct the user through §11.4 re-pairing without destroying local notes/tasks.
3. Check `Slot::PairingIdentity` at boot (`lib.rs`) so a lost pairing key is surfaced with that dedicated recovery path, not a bare error string on first pairing use.

**Tests to add/update (Rust + TS):** `Ok(None)` + peers present → `re_pair_required` set, no mint; `Ok(None)` + no peers → mint (fresh install); `Lost` + peers present → typed error, recovery path available; factory reset still deletes the slot.

**Files:** `src-tauri/src/pairing_key.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/key_store/mod.rs` (only if the typed-error plumbing needs it), plus tests.

---

## Session 5 — T5: N10 (Low-med) + D5 (canonical refusal code)

### N10 — `pinStatements` updates existing peers on conflict without zeroing cursors or dropping stale acks; re-pair wipes `display_name`

**Evidence:** `src/lib/sync/store.ts:305-315` (`registerPeerStatements`) — `ON CONFLICT(device_id) DO UPDATE` replaces `pairing_id`, `public_key`, `generation`, clears `revoked_at = NULL`, WITHOUT zeroing `cursor_in`/`cursor_out` and WITHOUT deleting `sync_outbox_delivery` / `sync_tombstone_acks` for that `device_id`. `src/lib/sync/pairingPanel.ts:212-219` — `pinAdmittedPeer` does not pass `displayName: existing.display_name` to `rePairStatements`, so `store.ts:351` (`peer.displayName ?? ""`) overwrites any stored `display_name` with `""`. (`pairingPanel.ts:200-202` itself warns against exactly this silent-update hazard.)

**Fix:** make `registerPeerStatements` fail on conflict (pure `INSERT`, preferred) so re-pairs must go through `rePairStatements` — OR have its conflict branch also zero `cursor_in`/`cursor_out` and clear the acks. Pick the pure-`INSERT` option unless it breaks a caller that legitimately re-pins; if it does, take the second option and say so in the report. And pass `displayName: existing.display_name` in `pinAdmittedPeer`.

**Tests:** `pinStatements` on an existing `device_id` refuses (or resets cursors + acks, whichever option was taken); re-pair preserves `display_name`.

**Files:** `src/lib/sync/store.ts`, `src/lib/sync/pairingPanel.ts`, plus tests.

### D5 — canonical refusal code `"needs-re-pair"`

**Evidence:** `src/lib/sync/pairing.ts:430-441` — `admitPeer` calls `handshake(input.local, remote)` BEFORE checking `pinned.generation !== input.local.generation`. A paired phone sends `remote.generation === pinned.generation`, so after a desktop restore `handshake`'s `"generation-mismatch"` fires first and `pairing.ts:434-441` (`code: "needs-re-pair"`) is unreachable unless the phone forged `remote.generation`. Rust's `admit` (`pairing_listener.rs:1066-1077`) returns `"needs-re-pair"` in both cases. Pinned by `pairing.test.ts:346-369` (`"generation-mismatch"`) vs `pairing_listener.rs:1632-1648` (`"needs-re-pair"`).

**Fix (decision D5, settled):** `"needs-re-pair"` is canonical. In `pairing.ts` `admitPeer`, check `pinned.generation !== input.local.generation` BEFORE calling `handshake` (or map `handshake`'s `"generation-mismatch"` to `"needs-re-pair"` at this layer) so the restore case surfaces `"needs-re-pair"` reachably. Rust `admit` stays as is.

**Tests:** update `pairing.test.ts:346-369` to assert `"needs-re-pair"` for the post-restore case; the Rust test keeps asserting `"needs-re-pair"`.

**Files:** `src/lib/sync/pairing.ts`, plus tests.

---

## Session 6 — T6: spec updates (D1 §11 + D2 claim correction)

### D1 — document `POST /pair/request` in §11

Add `POST /pair/request` (request fields, refusal codes, check order, and the sealed `"paired"` ack schema) alongside `POST /pair/hello` in §11.6.1. Record generation **Option A**: `PairRequest` carries no generation; the sealed ack delivers the desktop's authoritative `local_generation`, which the phone stores for this pairing. Fix §11.1 (`ANDROID_SYNC_PROTOCOL.md:558`): the QR carries the **desktop's** public key (it cannot carry both fingerprints before the desktop knows the phone's key); both screens display **both** fingerprints after `POST /pair/request` exchanges the phone's key. Update the stale implementation-status paragraph at `ANDROID_SYNC_PROTOCOL.md:662-665`.

### D2 — correct the forward-secrecy claim (Option A, document as built)

Amend `ANDROID_SYNC_PROTOCOL.md:637-639` ("Because the message key depends on a secret the sender destroys after one message, a later compromise of both long-term keys does not open recorded envelopes — the forward secrecy this section asks for") and the docstrings in `envelope.rs:28-30` / `envelope.ts:25-27` to state accurately: per-message sender ephemeral X25519 provides **sender-key-compromise resistance and per-message key separation**; a compromised *receiver* long-term key opens past envelopes sent to it (the receiver's secret + the public `eph` suffice for both DH agreements), so true ephemeral-ephemeral forward secrecy is **deferred**, bounded by §11.5's short-lived LAN window. No wire change.

**Files:** `docs/ANDROID_SYNC_PROTOCOL.md`, `src-tauri/src/envelope.rs` (docstring only), `src/lib/sync/envelope.ts` (docstring only). No behavior change in this session — the docstring edits must not touch the construction or the fixtures.

---

## Exit criteria (whole wave)

- N1, N2, N5, N9, N10, N12 fixed with the tests listed; D1/D2/D5 recorded in code + spec as above.
- `npm run verify` green on the wave's final commit.
- No new findings introduced; nothing in "Checked and Found Clean" regressed.
- After this wave, Session 7 (sealed client + snapshot transport + real pairing proof) can be built on the documented, confirmed-gated wire.
