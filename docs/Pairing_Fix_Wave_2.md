# Pairing Foundation Fix — Wave 2 (panel + phone entry UI)

**Source:** PR #24, Arena audit of the pairing foundation (`docs/Arena_Findings_Pairing_Foundation.md`, findings N1–N13 + decisions D1–D5). This document is self-contained: every finding in this wave is reproduced here in full, so the agent does not need the PR branch.

**Base:** `dev` HEAD `4adb79b` (Phase C Session 6 verified green, partial). **Branch:** `dev`. No commits to `main`, no version bumps, no new dependencies without justification.

**Ordering:** Wave 2 does not gate Session 7 (the sealed client). It follows Wave 1; run it after Session 7, or after Wave 1 if the panel files are free — do not run it in parallel with Session 7 (both touch `pairingPanel.ts`, `PairingPanel.tsx`, `MobilePairingCard.tsx`).

## Working rules (standing)

- Work one session at a time (~2 tasks max), then **STOP and report back**: what changed, commit sha, gate result, what is left. Do not start the next session unprompted.
- `npm run verify` must be green before any commit or push. A red gate is a blocker, not a note.
- Touch only the files listed per task (plus their tests and the listed spec lines). If a fix needs a file outside the list, STOP and ask — do not expand scope silently.
- Do not re-break anything in the audit's "Checked and Found Clean" section (slot separation, envelope AEAD + cross-language parity, framing, unbiased code + constant-time compare, `reap()` port-closure proof, §7.1 admission order). Wave 1's staging/confirmation contract (N1) is already settled — do not re-decide it here; build on it.

---

## Session 1 — T1: N3 (Med-high) — panel never learns when the code is `locked` or `used`

**Evidence:**
- `src/lib/sync/pairingPanel.ts:13-15` (module invariant): "expiry, use and lockout close the socket (settlePairingPanel) before the code disappears from the screen, so 'no code after it expires' and 'no port after the code dies' are one step, not two."
- `src-tauri/src/pairing_listener.rs:241-257, 320-336` — `PairingListenerInfo` serializes `running`, `port`, `endpoint`, `public_key`, `fingerprint`, `peer_device_id`, `peer_public_key`, `peer_fingerprint`, `note` — **omitting** `OfferState.attempts` and `OfferState.redeemed`.
- `src/lib/sync/pairingPanel.ts:167-177` — `settlePairingPanel` closes the socket only when `pairingState(state.session, now) !== "active"`, computed from the LOCAL session (`state.session.failedAttempts` / `state.session.usedAt`, initialized to `[]` / `null` in `openPairingPanel` at `:76` and never updated from Rust).
- `src/components/PairingPanel.tsx:174-183` — renders `{view.code ?? "expired"}` above a lifetime that shows `"N s left"` while `view.phase === "active"`.
- `src/lib/sync/pairing.ts:133-135` — '"expired" must never be shown for a session someone was guessing at.'

**What is wrong:** when 5 wrong guesses lock the code on the wire, the panel keeps rendering the locked-out QR and 6-digit code as live with a ticking countdown, and at expiry shows `"expired"` — violating the pairing.ts rule above and the pairingPanel.ts invariant. When a phone redeems the single-use code, the panel keeps rendering the spent QR/code until the 120-second timer runs out. When the listener stops while the phase is still `"active"` (e.g. after app backgrounding closes the port via `App.tsx:700`), the panel simultaneously renders **`Pairing code: expired`** directly above **`Code lifetime: 95 s left`**, with only a **"Stop pairing"** button instead of a button to open a fresh code.

**Fix:**
1. Include `offerAttempts: number` and `offerRedeemed: boolean` in `PairingListenerInfo` (`pairing_listener.rs`).
2. Project them into `state.session` inside `settlePairingPanel` so `pairingState` transitions to `"locked"` (closing the socket immediately) or `"used"` (hiding the spent QR/code while keeping the window open only if still needed for `/pair/hello`).
3. Replace the hardcoded `"expired"` fallback in `PairingPanel.tsx:175` with phase-accurate copy (`"used"`, `"locked"`, `"closed"`, `"expired"`), and show a "open a fresh code" action when the listener stopped while the session is otherwise still live.

**Tests to add/update (TS panel tests):** lockout on the wire → socket closed + panel shows `"locked"`; redemption → spent QR/code hidden; background stop while active → phase-accurate copy, never `"expired"` + `"N s left"` together.

**Files:** `src-tauri/src/pairing_listener.rs`, `src/lib/sync/pairingPanel.ts`, `src/components/PairingPanel.tsx`, `src/lib/sync/pairing.ts` (only if the state projection needs it), plus tests.

---

## Session 2 — T2: N4 (Med-high) — listener open/close races, idempotent `start` ignoring new offers, swallowed close errors

**Evidence:**
- `src-tauri/src/pairing_listener.rs:404-408` — when `start` finds an already-running listener it returns `Ok(running.info(None))` WITHOUT replacing `Gate`'s `offer`, `pairing_id`, `pin`, or `local_generation`. `openPairingPanel` (`pairingPanel.ts:99-104`) then returns its newly minted `session.offer.code` / `session.offer.pairingId` to the UI — a QR and 6-digit code the live Rust `Gate` does NOT accept, violating `pairingPanel.ts:8-10` ("the panel does not draw a code nobody checks").
- `pairing_listener.rs:489-495` — `stop_for_lock` is just `stop()`; the comment claiming *"no … pairing code lives in Rust"* is stale now that `Gate.offer` holds `OfferState.code`. `PairingListenerState` has no lock/close epoch, unlike `ShareState` (which increments `lock_epoch` in `stop_for_lock` and re-checks it under the server mutex in `start_with_epoch` — the codebase's own D2a pattern, `src-tauri/src/share.rs:321-333`).
- `src/lib/sync/pairingPanel.ts:75-93` — `openPairingPanel` awaits `transport.pairingLocal()` and then `transport.pairingOpen(...)`; `src-tauri/src/commands.rs:864-883` reads SQLite and the OS keystore before calling `listener.start("0.0.0.0", ...)`. If the user locks, backgrounds, or leaves Settings in that gap, `pairing_close` runs first on `None`, and `pairing_open` subsequently binds `0.0.0.0` AFTER the app is locked, backgrounded, or unmounted. `PairingPanel.tsx:85-87` has no `unmounted` guard after `await pairingRepo.open()`.
- `src/App.tsx:662` — `void pairingRepo.close().catch(() => {});` on lock, unawaited and without retry/warning (unlike `shareRepo.stopForLock()` at `:670-683`); `:700` (`visibilitychange` background). `PairingPanel.tsx:123` catches `settle` failures as `null` and returns early — if `pairingClose()` throws on expiry, React keeps rendering the expired QR and code.
- `src/pages/SettingsPage.tsx:1304` — filtering out `"pairing"` in Settings search sets HTML `hidden` on the `<section>` without unmounting `<PairingPanel />`, keeping the LAN port open while the pairing UI is invisible.

**What is wrong:** locking, backgrounding, or navigating away while the listener is starting can leave an active `0.0.0.0` pairing port open behind the lock screen; reopening the panel afterwards displays a code and QR that always fail on the phone (the listener is still gating on the previous offer); swallowed close errors leave dead codes on screen.

**Fix:**
1. Add a monotonic `lock_epoch` to `PairingListenerState`, mirroring `ShareState` D2a: `stop_for_lock` / `stop_for_reset` raise the epoch (barrier) before stopping; `start` re-checks the epoch under the listener lock and refuses if a lock/reset landed in the gap. Fix the stale comment at `pairing_listener.rs:489-491`.
2. Make `PairingListenerState::start` reap and replace any existing `Running` window when given a new `PairingWindow` (or reject the concurrent open — pick one and record it; replacing is preferred so reopening the panel always yields a live code).
3. Add an `unmounted` guard in `PairingPanel.tsx` after `await pairingRepo.open()` (do not set state or leave a port open for an unmounted panel).
4. Await and surface `pairingRepo.close()` failures on lock alongside `shareRepo.stopForLock()` (`App.tsx:662`); hide the expired QR/code even when `pairingClose` errors (`PairingPanel.tsx:123`).
5. Close or unmount `<PairingPanel />` when hidden by Settings search (`SettingsPage.tsx:1304`), and on close-to-tray `WindowEvent::CloseRequested` (`src-tauri/src/lib.rs:720-728`, where `hide()` may not fire `visibilitychange` on all desktop WebViews).

**Tests to add/update:** Rust tests for the epoch (lock during start → refused, nothing bound) and for start-replace (new offer replaces the running window; the new code is the one the listener checks). TS tests for the unmount guard and for the hidden panel closing the port.

**Files:** `src-tauri/src/pairing_listener.rs`, `src/components/PairingPanel.tsx`, `src/App.tsx`, `src/pages/SettingsPage.tsx`, `src-tauri/src/lib.rs` (only the CloseRequested path), plus tests.

---

## Session 3 — T3: N6 (Med-high) — phone card has no camera-less manual entry, truncates spaced codes, drops QR refusals, leaks camera tracks, fails on clock skew

**Evidence:**
- Spec §11.1 (`docs/ANDROID_SYNC_PROTOCOL.md:558-563`): "Camera permission is the QR path only; manual entry must remain first-class."
- `src/components/MobilePairingCard.tsx:141-166` — when camera permission is denied/unavailable (`scanning === "unavailable"`, `offer === null`), the card renders BOTH paragraphs stacked: *"Type the six-digit code shown on the desktop instead"* (`i18n.ts:288-291`, `pairCameraOff`) and on the next line *"Scan the desktop's QR first"* (`pairNoOffer`) — while rendering **no input field at all** (`offer === null` hides `<input>`). There is no way to paste a pairing offer URI or enter desktop connection details without a working camera.
- `MobilePairingCard.tsx:162` — `maxLength={7}`; `normalizeCode` (`pairing.ts:154-156`) and `mobilePairing.test.ts:119` explicitly support spaces and dashes such as `"12 34 56"` (8 characters) or `"123 - 456"` (9 characters). `maxLength={7}` truncates `"12 34 56"` to `"12 34 5"`, leaving `isCompleteCode(typed)` false and **Confirm code** disabled with no explanation.
- `MobilePairingCard.tsx:81-96`, `qr.ts:126-135` — `scanOffer` returns `{ ok: false, reason: "no pairing code in view." }` when `jsQR` sees no symbol, and `{ ok: false, reason: parsed.reason }` when a QR WAS decoded but `parseOffer` refused it (wrong format version `v=2`, non-PurpleMemo QR, incomplete offer). `step()` checks only `if (result.ok)` and loops `requestAnimationFrame(step)` forever without distinguishing the two — never surfacing the refusal (contradicting `mobilePairing.ts:7-9`).
- `MobilePairingCard.tsx:46, 57-61` — if the user leaves Settings while `await navigator.mediaDevices.getUserMedia(...)` is awaiting the OS permission prompt, the unmount cleanup runs `stopCamera()` while `streamRef.current` is still `null`; when `getUserMedia` resolves, `scan()` assigns `streamRef.current = stream` and keeps the hardware camera active in the background. No stop on `document` `visibilitychange` (`hidden`) during the 1-minute mobile lock grace window (`App.tsx:730-750`).
- `MobilePairingCard.tsx:106`, `mobilePairing.ts:51-56`, `pairing.ts:143` — `offer.expiresAt` is stamped with the *desktop's* `Date.now() + 120_000`, while `confirmTypedCode` checks `now >= session.offer.expiresAt` using the *phone's* `Date.now()`. Spec §4.1 notes the phone's auto-time can be minutes or days off; a phone ≥ 2 minutes fast rejects every freshly scanned offer locally as `"expired"` before a single request reaches the desktop.

**Fix:**
1. First-class manual entry: a paste/entry field for the desktop's pairing offer string (`purplememo-pair://v1?...`) so camera-less pairing works per §11.1. Update `pairCameraOff` / `pairNoOffer` copy (EN + MY in `i18n.ts`) to match — the two messages must never contradict each other again.
2. Raise `maxLength` (e.g. `12`) so spaced/dashed 6-digit codes fit.
3. Split `ScanResult` into `"empty-frame"` vs `"invalid-qr"` so `parseOffer` refusals stop scanning and display `reason`.
4. Check a `mountedRef` + `visibilitychange` after `await getUserMedia(...)` and stop the `stream` immediately if unmounted/hidden.
5. Evaluate local code expiry against `(offer.expiresAt - offer.createdAt)` elapsed since scan time on the phone's monotonic clock; the desktop listener remains authoritative on window expiry.

**Tests to add/update:** manual-entry path (paste an offer URI → offer parsed → code entry works, no camera); `"12 34 56"` submittable; a wrong-version QR stops scanning with the refusal shown; unmount during the permission prompt leaves no live camera track; a phone clock 2+ minutes fast still accepts a freshly scanned offer locally.

**Files:** `src/components/MobilePairingCard.tsx`, `src/lib/sync/mobilePairing.ts`, `src/lib/sync/qr.ts`, `src/lib/i18n.ts`, `src/lib/sync/pairing.ts` (only if the expiry evaluation needs it), plus tests.

---

## Session 4 — T4: N7 (Med) — `parseOffer` coerces omitted numerics to `0`, skips key/endpoint validation; empty-endpoint QRs when offline

**Evidence:**
- `src/lib/sync/pairing.ts:283-285` (docstring: "never partially trusted, and never filled in with defaults") vs `:303-321` — `Number(get("generation"))` etc. In JavaScript `Number(null) === 0` and `Number("") === 0`, and `Number.isFinite(0)` is `true`. An omitted (or empty) `generation`, `protocol`, `schema`, `created`, or `expires` is silently filled in with `0`. It also accepts negative numbers, floats (`1.5`), non-hex or wrong-length `key` values (e.g. `key=nothex`, for which `keyFingerprint` returns `""`), and arbitrary `endpoint` strings (full URLs, credentials, paths — not a `host:port` LAN socket address, risking SSRF once the transport client connects to `offer.endpoint`).
- `src-tauri/src/share.rs:564-569` (`lan_ip()`) probes `192.0.2.1:80` via UDP to read the default-route interface IP. On an isolated offline Wi-Fi LAN or phone hotspot **with no default internet gateway**, `socket.connect("192.0.2.1:80")` fails and `lan_ip()` returns `None`. `openPairingPanel` (`src/lib/sync/pairingPanel.ts:103`) substitutes `endpoint: ""` instead of failing or enumerating local LAN interfaces, so `PairingPanel.tsx` renders a live QR with `endpoint=` empty — which `parseOffer` on the phone (`!endpoint`, `pairing.ts:312`) immediately refuses as `"that pairing code is incomplete."`.

**Fix:**
1. In `parseOffer`: check `raw !== null && raw !== ""` and `Number.isSafeInteger(n)` (with `>= 1` for `generation`/`protocol`/`schema` and `expiresAt > createdAt > 0`); validate `publicKey` as 64 hex chars and `endpoint` as a bare `<ipv4-or-bracketed-ipv6>:<1..65535>` LAN socket address.
2. On the desktop: fall back to enumerating non-loopback LAN interfaces when `lan_ip()` has no default route; refuse to render a QR in `openPairingPanel` when `listener.endpoint === null` (show a plain error instead of a dead QR).

**Tests to add/update (`pairing.test.ts` + panel tests):** omitted/empty/negative/float numerics refused; non-hex or wrong-length `key` refused; non-`host:port` `endpoint` refused; no QR rendered when the endpoint is null.

**Files:** `src/lib/sync/pairing.ts`, `src/lib/sync/pairingPanel.ts`, `src-tauri/src/share.rs` (the `lan_ip` fallback), `src/components/PairingPanel.tsx` (only the no-QR-when-no-endpoint render), plus tests.

---

## Exit criteria (whole wave)

- N3, N4, N6, N7 fixed with the tests listed.
- `npm run verify` green on the wave's final commit.
- No new findings introduced; nothing in "Checked and Found Clean" regressed; Wave 1's staging/confirmation contract untouched.
- The panel and the phone entry are honest about every state they can be in (locked, used, closed, expired, no camera, no endpoint) — no dead code or QR ever renders as live.
