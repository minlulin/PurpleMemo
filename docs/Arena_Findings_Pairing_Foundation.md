# Arena Audit Findings — Pairing Foundation (Phase C)

- **Base commit:** `4adb79b35a2626b41e037ae1ef10e49096c74e84` (`4adb79b`, `dev` HEAD)
- **Audit branch:** `arena/deccbdc5-purplememo` (audit-only; no application, test, or config files modified)
- **Primary files audited in full:**
  - Rust: `src-tauri/src/pairing_listener.rs` (1765 lines), `src-tauri/src/envelope.rs` (712), `src-tauri/src/pairing_key.rs` (253), `src-tauri/src/key_store/mod.rs` (180), `src-tauri/src/key_store/desktop.rs` (55), `src-tauri/src/key_store/android.rs` (962), `src-tauri/src/commands.rs` (`pairing_local`, `pairing_open`, `pairing_close`, `pairing_status`, plus reset/share lifecycle seams)
  - TypeScript & UI: `src/lib/sync/pairing.ts` (513), `src/lib/sync/envelope.ts` (400), `src/lib/sync/bootstrap.ts` (265), `src/lib/sync/pairingPanel.ts` (245), `src/components/PairingPanel.tsx` (233), `src/components/MobilePairingCard.tsx` (191), `src/lib/sync/qr.ts` (136), `src/lib/sync/mobilePairing.ts` (77), `src/lib/sync/frame.ts` (62)
  - Specification: `docs/ANDROID_SYNC_PROTOCOL.md` (870 lines)
- **Caller, seam, fixture, and test files inspected for context:**
  - `docs/ANDROID_BUILD_TODO.md`, `src/lib/sync/store.ts`, `src/lib/sync/protocol.ts`, `src/data/driver.ts`, `src/App.tsx`, `src/pages/SettingsPage.tsx`, `src/components/MobileScreens.tsx`, `src/lib/i18n.ts`, `src-tauri/src/lib.rs`, `src-tauri/src/db.rs`, `src-tauri/src/schema.rs`, `src-tauri/src/share.rs` (`lan_ip` and D2a `lock_epoch` comparison), `src-tauri/Cargo.toml`, `package.json`
  - Fixtures & tests: `src/lib/sync/__fixtures__/envelope-from-ts.json`, `src/lib/sync/__fixtures__/envelope-from-rust.json`, `src/lib/sync/envelope.test.ts`, `src/lib/sync/envelope-cross.test.ts`, `src/lib/sync/frame.test.ts`, `src/lib/sync/pairing.test.ts`, `src/lib/sync/pairingPanel.test.ts`, `src/lib/sync/mobilePairing.test.ts`, `src/lib/sync/bootstrap.test.ts`, `src/lib/sync/qr.test.ts`, `src/lib/sync/store.test.ts`, `src/data/pairing-ipc.test.ts`
- **Method & test execution note:**
  - Every scoped file and its specification clauses (`§7`, `§8`, `§9`, `§10`, `§11.1–§11.6.1`) were read end-to-end and cross-checked across the Rust listener/crypto/keystore layer, TypeScript sync/pairing state machines, IPC driver, and React surfaces.
  - In-scope TypeScript tests were executed on Node `v22.22.3` with:
    `node --test src/lib/sync/envelope.test.ts src/lib/sync/envelope-cross.test.ts src/lib/sync/frame.test.ts src/lib/sync/pairing.test.ts src/lib/sync/pairingPanel.test.ts src/lib/sync/mobilePairing.test.ts src/lib/sync/bootstrap.test.ts src/lib/sync/qr.test.ts src/data/pairing-ipc.test.ts`
    Result: **39/39 passed** (`0` failed).
  - Rust (`cargo` / `rustc`) is not installed in this audit sandbox; Rust unit tests in `envelope.rs`, `pairing_listener.rs`, `pairing_key.rs`, and `key_store/` were reviewed statically.
  - Known roadmap items recorded in `docs/ANDROID_BUILD_TODO.md` (absence of the phone's sealed transport client and adoption/upload engine, live-camera manual run, `§13.1` reminder-owner choice, `minSdk 24` vs API 26, signed APK build) are excluded as findings. Behaviours explicitly pinned by existing tests that conflict with the spec or security claims are reported in the **`DECISION`** section rather than as plain bugs.

---

## Findings

### N1 — Unconfirmed auto-pinning on `POST /pair/request` turns the 6-digit code into a bearer secret and lets a spoofed `deviceId` overwrite an existing peer's pin
- **Severity:** High
- **Evidence:**
  - `docs/ANDROID_SYNC_PROTOCOL.md:559-562, 646-650`:
    > `The numeric fallback is short-lived, rate-limited, single-use and confirmed by comparing fingerprints on both screens — a low-entropy code must never become a bearer password (F7).`
    > `the human confirms the pinned key by fingerprint, which is what keeps a 6-digit code from becoming a bearer password (F7). No PAKE is required because the code authenticates no data.`
  - `src-tauri/src/pairing_listener.rs:968-976`:
    ```rust
    state.redeemed = true;
    drop(state);
    ...
    *gate.paired.lock().unwrap_or_else(|e| e.into_inner()) = Some(PairedPeer {
        pin,
        public_key_hex,
        fingerprint,
    });
    ```
  - `src/components/PairingPanel.tsx:127-133, 209-210`:
    ```tsx
    if (pinRef.current === null && next.listener.peerPublicKey !== null) {
      const write = await pairingRepo.pin(next).catch(() => null);
      if (!cancelled && write !== null) {
        pinRef.current = write;
        setPin(write);
      }
    }
    ...
    Compare that fingerprint with the one on the phone before you trust the pairing.
    ```
  - `src/lib/sync/pairingPanel.ts:212-219`:
    ```ts
    const existing = (await transport.peers()).find(
      (row) => row.device_id === deviceId,
    );
    const peer = { deviceId, publicKey, generation: state.local.generation };
    const statements = existing
      ? rePairStatements({ ...peer, pairingId: state.offer.pairingId })
      : pinStatements({ ...peer, pairingId: state.offer.pairingId });
    await transport.batch(statements);
    ```
- **What is wrong:**
  1. The protocol intentionally avoids a PAKE (`§11.6.1`) on the explicit premise that a 6-digit code (`10^6` space, or shoulder-surfed on a shared screen) is **not** sufficient to establish trust without out-of-band human fingerprint confirmation on both screens (`§11.1`, `F7`). In code, however, `rendezvous` immediately installs `gate.paired` for `POST /pair/hello` (`pairing_listener.rs:972`), and `PairingPanel.tsx`'s 1-second poll (`PairingPanel.tsx:127-133`) **automatically writes the peer's public key to `sync_peers`** with zero user action — while simultaneously rendering prose (`PairingPanel.tsx:209-210`) instructing the user to compare the fingerprint *"before you trust the pairing"*.
  2. `PairRequest` is plaintext and `request.device_id` is unauthenticated (`pairing_listener.rs:831-840`). Nor has the requester proven possession of the secret half of `request.public_key` when `PairingPanel.tsx` persists the pin (`rendezvous` only encrypted `ack` *to* `request.public_key`; no message sealed *by* `request.public_key` has been opened yet).
  3. Because `pinAdmittedPeer` looks up `existing` solely by the unauthenticated `deviceId` string (`pairingPanel.ts:212-218`), a LAN attacker who sees or guesses a live 6-digit code can send a `PairRequest` claiming an already-paired (or previously revoked) phone's `deviceId` with the attacker's `publicKey`. Within 1 second, `rePairStatements` (`src/lib/sync/store.ts:345-366`) silently replaces the real phone's pinned public key, clears `revoked_at = NULL`, zeroes `cursor_in`/`cursor_out`, and deletes its `sync_outbox_delivery` and `sync_tombstone_acks` rows.
- **User impact:** Anyone on the local network who glimpses the desktop's 2-minute pairing screen (or hits 1-in-200,000 in 5 guesses) is permanently pinned in `sync_peers` before the user can reject a mismatched fingerprint, and can clobber an existing paired phone's pin and sync cursors by spoofing its `device_id`. Once Stage 1 sync lands on top of `sync_peers`, that attacker gains full read/write sync access to the desktop database.
- **Fix direction:** Gate persistence on explicit user confirmation rather than the poll tick: keep a code-redeemed peer in a `"pending-confirmation"` state on the listener/panel, optionally require a sealed `POST /pair/hello` from that peer first so key possession is proven, display both fingerprints (`view.fingerprint` and `peerFingerprint`) plus a clear warning when `deviceId` matches an existing peer ("Re-pairing existing phone …"), and run `pinAdmittedPeer` only when the user clicks an explicit **Trust matching fingerprint** action (with **Reject** closing the window without writing to `sync_peers`).

---

### N2 — Missing `Slot::PairingIdentity` silently mints a new long-term key over an already-paired install, while `KeyStoreError::Lost` on Android has no fail-closed recovery path
- **Severity:** High
- **Evidence:**
  - `src-tauri/src/key_store/mod.rs:15-17`:
    > `Ok(None) — nothing has been stored in this slot yet. Only valid on a fresh install before minting; if data already exists on disk, db.rs treats this as KeyStoreError::Lost rather than minting a new key over an unreadable store.`
  - `src-tauri/src/pairing_key.rs:116-122`:
    ```rust
    pub fn load_or_mint() -> Result<PairingIdentity, String> {
        match key_store::read(Slot::PairingIdentity) {
            Ok(Some(stored)) => Ok(PairingIdentity::from_secret(parse_secret(&stored)?)),
            Ok(None) => mint(),
            Err(e) => Err(e.to_string()),
        }
    }
    ```
  - `src-tauri/src/commands.rs:838-840, 864-866`:
    ```rust
    let (device_id, generation, schema_version) = local_sync_facts(&db_state)?;
    let identity = crate::pairing_key::load_or_mint()?;
    ```
  - `src-tauri/src/key_store/desktop.rs:25-28` (`keyring::Error::NoEntry => Ok(None)`) and `src-tauri/src/key_store/android.rs:73-75, 83-100` (`ErrorKind::NotFound => Ok(None)`; invalidated Keystore alias or corrupt blob => `Err(KeyStoreError::Lost(...))`).
- **What is wrong:**
  1. **Silent re-mint on `Ok(None)` when peers already exist:** Unlike `db.rs` (which checks whether encrypted database state already exists before minting on `Ok(None)`), `pairing_key::load_or_mint()` unconditionally calls `mint()` whenever `Slot::PairingIdentity` is empty (`NoEntry` in macOS Keychain / Windows Credential Manager / Linux Secret Service after credential reset or OS migration, or deleted `pairing-key.wrapped` on Android). If `sync_peers` already contains pinned peers, the install keeps its old `sync_state.device_id` and old `sync_peers` rows, leaves `re_pair_required = 0`, and silently generates a brand-new long-term X25519 identity key. This violates the fail-closed key-loss contract (`§11.2`, `pairing_key.rs:112-115`).
  2. **Unhandled `KeyStoreError::Lost` on Android:** `lib.rs` boot (`src-tauri/src/lib.rs:255-268, 347-376`) handles `KeyStoreError::Lost` only for `Slot::Database` (`boot_outcome` → wipe-to-continue screen). `Slot::PairingIdentity` is never checked at boot, and `pairing_key::load_or_mint()` flattens `KeyStoreError::Lost` to `Err(String)` (`pairing_key.rs:120`). If Android invalidates `purple_memo_pairing_key_wrap_v1` while `purple_memo_db_key_wrap_v1` survives (or `pairing-key.wrapped` is truncated on disk), `pairing-key.wrapped` still exists so `read()` returns `Err(Lost)` on every call forever with no dedicated pairing-identity reset/re-pair flow short of wiping all user data via full factory reset.
- **User impact:** On desktop credential-store loss, the app silently rotates its long-term identity key without flagging `re_pair_required` or revoking/marking existing pins, causing confusing authentication failures (`unauthenticated` / `key-mismatch`) on peers. On Android `Slot::PairingIdentity` key loss or file corruption, pairing is permanently wedged with an unrecoverable error string unless the user factory-resets the entire app.
- **Fix direction:** Pass database pairing state into `pairing_key::load_or_mint` (e.g. whether `sync_peers` has any rows or `sync_state` has ever paired): if `read(Slot::PairingIdentity)` returns `Ok(None)` while peers already exist, fail closed by setting `sync_state.re_pair_required = 1` and requiring explicit user confirmation before minting a replacement identity key for re-pairing. Likewise, preserve typed `KeyStoreError::Lost` from `Slot::PairingIdentity` so the UI can set `re_pair_required = 1`, delete only `Slot::PairingIdentity`, mint a fresh pairing identity upon user confirmation, and direct the user through `§11.4` re-pairing without destroying local notes/tasks.

---

### N3 — Desktop pairing panel never learns when the listener's code is `locked` or `used`, keeping the socket open and displaying a dead QR/code as live
- **Severity:** Med-high
- **Evidence:**
  - `src/lib/sync/pairingPanel.ts:13-15` (module invariant):
    > `expiry, use and lockout close the socket (settlePairingPanel) before the code disappears from the screen, so "no code after it expires" and "no port after the code dies" are one step, not two`
  - `src-tauri/src/pairing_listener.rs:241-257, 320-336`: `PairingListenerInfo` serializes `running`, `port`, `endpoint`, `public_key`, `fingerprint`, `peer_device_id`, `peer_public_key`, `peer_fingerprint`, and `note` — **omitting** `OfferState.attempts` and `OfferState.redeemed` (`pairing_listener.rs:255-260`).
  - `src/lib/sync/pairingPanel.ts:167-177`:
    ```ts
    export async function settlePairingPanel(
      transport: PairingTransport,
      state: PairingPanelState,
      now: number = Date.now(),
    ): Promise<PairingPanelState> {
      const current = await transport.pairingStatus();
      if (pairingState(state.session, now) !== "active" && current.running) {
        return { ...state, listener: await transport.pairingClose() };
      }
      return { ...state, listener: current };
    }
    ```
  - `src/components/PairingPanel.tsx:174-183`:
    ```tsx
    <dt>Pairing code</dt>
    <dd className="pairing-code">{view.code ?? "expired"}</dd>
    ...
    <dt>Code lifetime</dt>
    <dd>
      {view.phase === "active"
        ? `${view.remainingSeconds} s left`
        : (view.reason ?? "closed")}
    </dd>
    ```
- **What is wrong:**
  1. `state.session.failedAttempts` and `state.session.usedAt` inside `PairingPanelState` are initialized to `[]` and `null` in `openPairingPanel` (`pairingPanel.ts:76`) and are **never updated** from the Rust listener (`PairingListenerInfo` does not even carry `attempts` or `redeemed`).
  2. When 5 wrong guesses hit `POST /pair/request`, Rust locks the offer (`state.attempts >= PAIRING_MAX_ATTEMPTS`, `pairing_listener.rs:868-873`), but `pairingState(state.session, now)` in TypeScript remains `"active"` for the rest of the 120-second window: `settlePairingPanel` does **not** close the socket, `panelView` keeps rendering the locked-out QR and 6-digit code as live, and at `expiresAt` the UI transitions to `"expired"` — violating `pairing.ts:133-135` (*'"expired" must never be shown for a session someone was guessing at'*) and `pairingPanel.ts:13-15`.
  3. When a phone redeems the single-use code (`state.redeemed = true`, `peerPublicKey !== null`), `state.session.usedAt` still remains `null`, so `panelView` continues rendering the spent single-use QR and 6-digit code on screen until the 120-second timer runs out.
  4. When the listener stops while `view.phase === "active"` (for example after app backgrounding closes the port via `App.tsx:700`), `view.code` becomes `null` (`pairingPanel.ts:147-150`), so `PairingPanel.tsx:175, 180-181` simultaneously renders **`Pairing code: expired`** directly above **`Code lifetime: 95 s left`**, with only a **"Stop pairing"** button (`PairingPanel.tsx:226`) instead of a button to open a fresh code.
- **User impact:** If an attacker or mistyping user locks out the 6-digit code on the wire, the desktop keeps advertising a dead QR and code as usable with a ticking countdown instead of warning that 5 wrong attempts locked the code and closing the port. After backgrounding, the panel displays contradictory `"expired"` + `"N s left"` text.
- **Fix direction:** Include `offerAttempts: number` and `offerRedeemed: boolean` in `PairingListenerInfo` (`pairing_listener.rs`), project them into `state.session` inside `settlePairingPanel` so `pairingState` transitions to `"locked"` (closing the socket immediately) or `"used"` (hiding the spent QR/code while keeping the window open only if still needed for `/pair/hello`), and replace the hardcoded `"expired"` fallback in `PairingPanel.tsx:175` with phase-accurate copy (`"used"`, `"locked"`, `"closed"`, `"expired"`).

---

### N4 — Listener open/close races, idempotent `start` ignoring new offers, and swallowed close errors can leave `0.0.0.0` bound behind lock/background/unmount or show a code the listener does not check
- **Severity:** Med-high
- **Evidence:**
  - `src-tauri/src/pairing_listener.rs:404-408, 489-495`:
    ```rust
    if let Some(running) = guard.as_ref() {
        if !running.finished() {
            return Ok(running.info(None));
        }
    }
    ...
    /// Same stop as [`Self::stop`], unlike the LAN share's lock path: no
    /// consent token or pairing code lives in Rust, so there is nothing to
    /// revoke before the socket closes.
    pub fn stop_for_lock(&self) -> Result<PairingListenerInfo, String> {
        self.stop()
    }
    ```
  - `src/lib/sync/pairingPanel.ts:75-93`: `openPairingPanel` awaits `transport.pairingLocal()` and then `transport.pairingOpen(...)`; `src-tauri/src/commands.rs:864-883` reads SQLite and the OS keystore before calling `listener.start("0.0.0.0", ...)`.
  - `src/components/PairingPanel.tsx:70-75, 84-88, 123`:
    ```tsx
    useEffect(() => () => { void pairingRepo.close().catch(() => {}); }, []);
    ...
    const opened = await pairingRepo.open();
    stateRef.current = opened;
    setState(opened);
    ...
    const next = await pairingRepo.settle(current, now).catch(() => null);
    if (cancelled || next === null) return;
    ```
  - Caller context: `src/App.tsx:662` (`void pairingRepo.close().catch(() => {});` on lock, unawaited and without retry/warning, unlike `shareRepo.stopForLock()` at `src/App.tsx:670-683`), `src/App.tsx:700` (`visibilitychange` background), and `src/pages/SettingsPage.tsx:1304` (`<section className="card" hidden={!shows("pairing")}>` keeps `<PairingPanel />` mounted when hidden by the Settings search filter).
- **What is wrong:**
  1. **Start-vs-stop race across lock, background, and unmount (`§11.5`):** Unlike `ShareState` (which increments `lock_epoch` in `stop_for_lock` and re-checks it under the server mutex in `start_with_epoch` — the codebase's own D2a pattern in `src-tauri/src/share.rs:321-333`), `PairingListenerState` has no lock/close epoch (and the comment at `pairing_listener.rs:489-491` claiming *"no … pairing code lives in Rust"* is stale now that `Gate.offer` holds `OfferState.code`). If the user locks the app, backgrounds the window, or leaves Settings while `openPairingPanel` is between `pairingLocal()` and `listener.start()` acquiring `self.lock()`, `pairing_close` runs first on `None`, and `pairing_open` subsequently binds `0.0.0.0` **after** the app is locked, backgrounded, or unmounted. `PairingPanel.tsx:85-87` also lacks an `unmounted` guard after `await pairingRepo.open()`.
  2. **Stale running listener ignores a newly minted offer (`pairing_listener.rs:404-408`):** When `PairingListenerState::start` finds an already-running listener (left behind by the race above, by hiding via Settings search, or by reopening), it returns `Ok(running.info(None))` **without** replacing `Gate`'s `offer`, `pairing_id`, `pin`, or `local_generation`. `openPairingPanel` (`pairingPanel.ts:99-104`) then returns its newly minted `session.offer.code` and `session.offer.pairingId` to the UI — rendering a QR code and 6-digit code that the live Rust `Gate` does **not** accept, directly violating `pairingPanel.ts:8-10` (*"the panel does not draw a code nobody checks"*).
  3. **Swallowed `reap()` failures:** `App.tsx:662` fires `pairingRepo.close()` unawaited and swallows errors (so the lock screen can appear before the port closes, and a port-close timeout raises no warning). Likewise, `PairingPanel.tsx:123` catches `settle` failures as `null` and returns early; if `pairingClose()` throws on expiry, `state` never updates and React keeps rendering the **expired QR and 6-digit code** on screen.
  4. **Hidden-not-unmounted panel:** Filtering out `"pairing"` in Settings search (`SettingsPage.tsx:1304`) sets HTML `hidden` on the `<section>` without unmounting `<PairingPanel />`, keeping the LAN port open while the pairing UI is invisible.
- **User impact:** Locking, backgrounding, or navigating away while the pairing listener is starting can leave an active `0.0.0.0` pairing port open behind the lock screen; reopening the panel afterwards displays a 6-digit code and QR that always fail on the phone because the listener is still gating on the previous offer.
- **Fix direction:** Add a monotonic `lock_epoch` (mirroring `ShareState` D2a) to `PairingListenerState` plus an unmount check in `PairingPanel.tsx` so an in-flight `pairing_open` aborts or closes immediately if lock/background/unmount raced it; make `PairingListenerState::start` reap and replace any existing `Running` window when given a new `PairingWindow` (or reject concurrent open); await and surface `pairingRepo.close()` failures on lock alongside `shareRepo.stopForLock()`; hide expired QR/code even when `pairingClose` errors; and close or unmount `<PairingPanel />` when hidden by Settings search (and on close-to-tray `WindowEvent::CloseRequested` in `src-tauri/src/lib.rs:720-728` where `hide()` may not fire `visibilitychange` on all desktop WebViews).

---

### N5 — `POST /pair/request` allows 2-connection slow-body DoS, blind pre-filter attempt burning, NUL injection into HKDF `info`, stale `last_counter`, and wildcard CORS (`*`)
- **Severity:** Med-high
- **Evidence:**
  - `src-tauri/src/pairing_listener.rs:108, 644, 661, 687-699, 755, 831-977`:
    ```rust
    const MAX_WORKERS: usize = 2;
    ...
    ("Access-Control-Allow-Origin", "*"),
    ...
    if workers.len() >= MAX_WORKERS {
        drop(request);
        continue;
    }
    ...
    let body = match read_body(request.as_reader()) { ... }
    ```
  - `src-tauri/src/pairing_listener.rs:878-904` (inside `rendezvous`): `codes_equal` and `state.attempts += 1` run **before** checking `request.device_id == gate.local_device_id`, `request.pairing_id`, `request.protocol_version`, `request.schema_version`, `request.generation`, or `from_hex(&request.public_key)`.
  - `src-tauri/src/envelope.rs:169-181`:
    ```rust
    /// The HKDF `info`: a fixed prefix then the sender, receiver and pairing id,
    /// each preceded by a NUL byte so the fields cannot be re-split ambiguously.
    fn kdf_info(from: &str, to: &str, pairing_id: Option<&str>) -> Vec<u8> { ... }
    ```
- **What is wrong:**
  1. **2-connection slow-body worker starvation & leaked `Gate` threads:** `serve` caps concurrent handlers at `MAX_WORKERS = 2` (`pairing_listener.rs:108, 687`), while `read_body(request.as_reader())` (`pairing_listener.rs:755, 982-990`) blocks in `read_to_end` with **no socket read timeout**, and `reap()` (`pairing_listener.rs:534-540`) joins only `serve`, never `workers`. Opening 2 TCP connections on the LAN that send HTTP headers (`POST /pair/request` with `Content-Length: 64`) and stall the body permanently occupies both worker slots — causing `serve` to `drop(request)` for every legitimate phone connection — and keeps both worker threads plus `Arc<Gate>` (holding `local_secret: [u8; 32]`) alive in memory even after `stop()` returns.
  2. **Blind LAN attempt burning & code-match oracle (`pairing_listener.rs:878-935`):** Because `codes_equal` and `state.attempts += 1` run *before* verifying `pairing_id`, `protocol_version`, `schema_version`, `device_id`, and `public_key` syntax, any blind LAN script that has **not** scanned the QR (does not know `pairingId`) can send 5 dummy JSON bodies and lock out the user's pairing code in milliseconds. Conversely, if a probe sends the *matching* 6-digit code with a bogus `pairing_id` or `schema_version`, `rendezvous` returns `"pairing-mismatch"` or `"schema-mismatch"` without incrementing `attempts` or setting `redeemed`, leaking that the 6-digit code was right!
  3. **Unvalidated `PairRequest.device_id` breaks HKDF `info` NUL separation (`pairing_listener.rs:832`, `envelope.rs:169-181`):** `PairRequest.device_id` is accepted as any arbitrary string (empty, 60 KB, or containing `\u0000`). `§11.6.1` (`docs/ANDROID_SYNC_PROTOCOL.md:630-632`) relies on `0x00` NUL separators in `kdf_info` so `(from, to, pairing_id)` cannot be re-split ambiguously — an invariant that holds **only** when none of those strings can contain `0x00`. `§1.2` already specifies `device_id` as a canonical lowercase UUID v4.
  4. **Stale `last_counter` after `rendezvous` (`pairing_listener.rs:972-976`):** Populating `gate.paired` replaces `active_pin(gate)` (`pairing_listener.rs:812-821`) without resetting `*gate.last_counter` (`pairing_listener.rs:451, 1001`) to `0`. If a window was opened with `last_counter > 0`, the newly paired peer's first `hello` (`counter: 1`) is rejected as `"replayed"`.
  5. **Wildcard `Access-Control-Allow-Origin: *` (`pairing_listener.rs:644, 661`):** Allows any arbitrary webpage open in a browser on the desktop (via `127.0.0.1:<port>`) or on the LAN to `fetch` `/pair/request` or `/pair/hello`, burn all 5 attempts across origins, and read the framed response body. Notably, `src/lib/sync/mobilePairing.ts:14-17` explains that the phone's keystore-backed secret stays in Rust out of the WebView, so the phone's sealed transport client can invoke HTTP from Rust without needing wildcard browser CORS at all.
- **User impact:** Trivial LAN or local-browser denial of service against any active pairing window (2 stalled sockets or 5 blind requests), code-match side-channel on mismatched metadata, arbitrary/NUL-containing `device_id` values entering HKDF `info` and `sync_peers`, and replay false-positives when re-pairing on a non-zero counter window.
- **Fix direction:** Enforce a short per-connection read/write timeout (e.g. 5 s) or bound body reads before worker dispatch; validate `device_id` (canonical lowercase UUID v4, no NULs), `public_key` (64 lowercase hex chars, usable X25519 point), `pairing_id` (required and equal to `gate.pairing_id`), `protocol_version`, and `schema_version` *before* checking `code` and incrementing `attempts`; reset `*gate.last_counter = 0` atomically when `gate.paired` is set; and drop `Access-Control-Allow-Origin: *` (or restrict strictly to Tauri's WebView origins if WebView `fetch` is kept).

---

### N6 — Phone pairing card has no camera-less manual entry (with self-contradictory UI copy), truncates spaced codes, drops QR parse refusals, leaks camera tracks, and fails on ≥2-minute clock skew
- **Severity:** Med-high
- **Evidence:**
  - `docs/ANDROID_SYNC_PROTOCOL.md:558-563` (`§11.1`):
    > `Camera permission is the QR path only; manual entry must remain first-class.`
  - `src/components/MobilePairingCard.tsx:141-166`:
    ```tsx
    {scanning === "unavailable" ? (
      <p className="mobile-note">{t("mobile.settings.pairCameraOff")}</p>
    ) : null}
    {offer === null ? (
      <p className="mobile-note">{t("mobile.settings.pairNoOffer")}</p>
    ) : (
      <>
        ...
        <input ... maxLength={7} ... />
    ```
  - `src/lib/i18n.ts:288-291`:
    - `pairCameraOff`: `"This build cannot reach a camera here. Type the six-digit code shown on the desktop instead."`
    - `pairNoOffer`: `"Scan the desktop's QR first. A six-digit code on its own does not say which desktop to pair with."`
  - `src/components/MobilePairingCard.tsx:46, 57-61, 81-96` and `src/lib/sync/mobilePairing.ts:51-56`.
- **What is wrong:**
  1. **Unreachable manual entry & contradictory messages (`§11.1` violation):** When camera permission is denied or unavailable (`scanning === "unavailable"`, `offer === null`), `MobilePairingCard` renders **both** paragraphs stacked back-to-back — first telling the user *"Type the six-digit code shown on the desktop instead"*, and on the very next line *"Scan the desktop's QR first"* — while rendering **no input field at all** (`offer === null` hides `<input>`). There is no way to paste a pairing offer URI or enter desktop connection details without a working camera.
  2. **`maxLength={7}` breaks `normalizeCode` typing conveniences (`MobilePairingCard.tsx:162`):** `normalizeCode` (`pairing.ts:154-156`) and `mobilePairing.test.ts:119` explicitly support spaces and dashes such as `"12 34 56"` (8 characters) or `"123 - 456"` (9 characters). `maxLength={7}` truncates `"12 34 56"` at `"12 34 5"` (5 digits), leaving `isCompleteCode(typed)` `false` and the **Confirm code** button disabled with no explanation.
  3. **QR parse refusals are silently swallowed in the camera loop (`MobilePairingCard.tsx:81-96`, `qr.ts:126-135`):** `scanOffer` returns `{ ok: false, reason: "no pairing code in view." }` when `jsQR` sees no symbol, and `{ ok: false, reason: parsed.reason }` when a QR **was** decoded but `parseOffer` refused it (e.g. wrong format version `v=2`, non-PurpleMemo QR, or incomplete offer). `step()` checks only `if (result.ok)` and loops `requestAnimationFrame(step)` forever without distinguishing "no QR in frame" from "QR scanned and refused", never surfacing `parseOffer`'s refusal message (contradicting `mobilePairing.ts:7-9`).
  4. **Camera stream leak on unmount during `getUserMedia` and on app background (`MobilePairingCard.tsx:46, 57-61`):** If the user leaves Settings while `await navigator.mediaDevices.getUserMedia(...)` is awaiting the OS permission prompt, the unmount cleanup runs `stopCamera()` while `streamRef.current` is still `null`; when `getUserMedia` resolves, `scan()` assigns `streamRef.current = stream` and keeps the hardware camera active in the background. Nor does `MobilePairingCard` stop the camera on `document` `visibilitychange` (`hidden`) during the 1-minute mobile lock grace window (`App.tsx:730-750`).
  5. **Cross-device wall-clock expiry check (`MobilePairingCard.tsx:106`, `mobilePairing.ts:51-56`, `pairing.ts:143`):** `offer.expiresAt` is stamped with the *desktop's* `Date.now() + 120_000`, whereas `confirmTypedCode` checks `now >= session.offer.expiresAt` using the *phone's* `Date.now()`. `§4.1` explicitly notes that *"the phone's auto-time can be minutes or days off"*; if the phone's clock is ≥ 2 minutes ahead of the desktop's, every freshly scanned offer is immediately rejected locally as `"expired"` before a single request reaches the desktop.
- **User impact:** Users without camera permission (or with broken WebView camera access) hit a dead-end with two self-contradictory instructions; users typing `"12 34 56"` cannot submit; scanning a wrong-version QR hangs on `"Scanning…"` with no error; and phones whose clock is 2 minutes fast cannot pair at all.
- **Fix direction:** Provide a first-class manual paste/entry field for the desktop's pairing offer string (`purplememo-pair://v1?...`) so camera-less pairing works per `§11.1` (and update `pairCameraOff` / `pairNoOffer` to match); raise `maxLength` (e.g. `12`) so spaced/dashed 6-digit codes fit; split `ScanResult` into `"empty-frame"` vs `"invalid-qr"` so `parseOffer` refusals stop scanning and display `reason`; check a `mountedRef` + `visibilitychange` after `await getUserMedia(...)` and stop `stream` immediately if unmounted/hidden; and evaluate local code expiry against `(offer.expiresAt - offer.createdAt)` elapsed since scan time on the phone's monotonic clock while letting the desktop listener remain authoritative on window expiry.

---

### N7 — `parseOffer` silently coerces omitted numeric query parameters to `0` and skips `key`/`endpoint` validation, while `openPairingPanel` emits empty-endpoint QRs when offline
- **Severity:** Med
- **Evidence:**
  - `src/lib/sync/pairing.ts:283-285` (docstring) vs `303-321`:
    ```ts
    const generation = Number(get("generation"));
    const protocolVersion = Number(get("protocol"));
    const schemaVersion = Number(get("schema"));
    const createdAt = Number(get("created"));
    const expiresAt = Number(get("expires"));
    if (
      ...
      !Number.isFinite(generation) ||
      !Number.isFinite(protocolVersion) ||
      !Number.isFinite(schemaVersion) ||
      !Number.isFinite(createdAt) ||
      !Number.isFinite(expiresAt)
    ) {
      return { ok: false, reason: "that pairing code is incomplete." };
    }
    ```
  - `src-tauri/src/pairing_listener.rs:436-440` (`crate::share::lan_ip().map(...)`) and `src/lib/sync/pairingPanel.ts:103` (`offer: { ...session.offer, endpoint: listener.endpoint ?? "" }`).
- **What is wrong:**
  1. In JavaScript, `Number(null) === 0` and `Number("") === 0`, and `Number.isFinite(0)` is `true`. When `generation`, `protocol`, `schema`, `created`, or `expires` is omitted (or empty) in a `purplememo-pair://v1?...` URI, `url.searchParams.get(...)` returns `null`, and `parseOffer` silently fills in `0` instead of rejecting the URI — directly contradicting its own docstring (`"never partially trusted, and never filled in with defaults"`). It also accepts negative numbers, floats (`1.5`), non-hex or wrong-length `key` values (e.g. `key=nothex`, for which `keyFingerprint` returns `""`), and arbitrary `endpoint` strings (such as full URLs, credentials, or paths rather than a `host:port` LAN socket address, risking SSRF once the transport client connects to `offer.endpoint`).
  2. Conversely, on the desktop side, `crate::share::lan_ip()` (`src-tauri/src/share.rs:564-569`) probes `192.0.2.1:80` via UDP to read the default-route interface IP. On an isolated offline Wi-Fi LAN or phone hotspot **with no default internet gateway**, `socket.connect("192.0.2.1:80")` fails and `lan_ip()` returns `None`. `openPairingPanel` (`pairingPanel.ts:103`) substitutes `endpoint: ""` instead of failing or enumerating local LAN interfaces, so `PairingPanel.tsx` renders a live QR code with `endpoint=` empty — which `parseOffer` on the phone (`!endpoint`, `pairing.ts:312`) immediately refuses as `"that pairing code is incomplete."`.
- **User impact:** Forged or truncated QR URIs pass `parseOffer` with `0`-defaulted fields and blank fingerprints, while legitimate users on an internet-less local router or offline mobile hotspot are shown a QR code on the desktop that the phone always rejects as incomplete.
- **Fix direction:** Check `raw !== null && raw !== ""` and `Number.isSafeInteger(n)` (with `>= 1` for `generation`/`protocol`/`schema` and `expiresAt > createdAt > 0`), validate `publicKey` as 64 hex chars and `endpoint` as a bare `<ipv4-or-bracketed-ipv6>:<1..65535>` LAN socket address in `parseOffer`; on the desktop, fall back to enumerating non-loopback LAN interfaces when `lan_ip()` has no default route, and refuse to render a QR in `openPairingPanel` when `listener.endpoint === null`.

---

### N8 — `bootstrap.ts` undercounts UTF-8 size ~3× on Burmese text, splits non-adjacent rows of an aggregate across batches, keys `planBootstrap` by `uid` alone, and uses key-order-sensitive `JSON.stringify`
- **Severity:** Med
- **Evidence:**
  - `src/lib/sync/bootstrap.ts:67-71`:
    ```ts
    const desktopByUid = new Map(desktop.map((row) => [row.uid, row]));
    const mobileUids = new Set(mobile.map((row) => row.uid));
    ```
  - `src/lib/sync/bootstrap.ts:101-110`:
    ```ts
    function rowBytes(row: SyncedRow): number {
      return (
        JSON.stringify({
          table: row.table,
          uid: row.uid,
          stamp: row.stamp,
          fields: row.fields,
        }).length + 64
      );
    }
    ```
  - `src/lib/sync/bootstrap.ts:129-151`:
    ```ts
    const flush = (): void => {
      if (current.length > 0) batches.push(current);
      current = [];
      currentBytes = 0;
      currentAggregates = new Set();
    };
    ...
    const aggregateStarted =
      aggregate !== null && currentAggregates.has(aggregate);
    if (current.length > 0 && !aggregateStarted && wouldOverflow) flush();
    ```
  - `src/lib/sync/bootstrap.ts:197-200`: `if (JSON.stringify(item.desktop.fields) === JSON.stringify(item.mobile.fields)) continue;`
- **What is wrong:**
  1. **UTF-16 code units vs UTF-8 wire bytes (`rowBytes`):** PurpleMemo is bilingual English/Burmese (`src/lib/i18n.ts`). Every Myanmar-script code point (`U+1000–U+109F`) is 1 UTF-16 code unit (`.length === 1`) in JS strings, **3 bytes in UTF-8**, and **6 bytes** once hex-encoded inside `EnvelopeWire.body` (`envelope.ts:242`). `JSON.stringify(...).length` undercounts UTF-8 byte size on Burmese notes by nearly **3×**, allowing a "256 KiB" batch (`§3.2`) to approach ~768 KiB of UTF-8 JSON (~1.5 MiB on the wire).
  2. **Non-adjacent aggregate rows split across batches (`batchSnapshot`, `§8.3`):** `BatchLimits.aggregateOf` (`bootstrap.ts:93-95`) promises *"two rows that answer the same non-null value here land in the same batch"*. Yet `batchSnapshot` iterates `rows` in input order and clears `currentAggregates` on `flush()`. In a snapshot read table-by-table (`shopping_lists` → 200 `notes` → `shopping_items`, or `jobs` → `income_entries`), the parent row flushes in batch 1 and its child rows land in batch 2+, splitting the aggregate across transactions in violation of `§8.3` (and risking FK failures on apply).
  3. **`uid` vs `(table, uid)` identity (`planBootstrap`):** `§1.1` (`docs/ANDROID_SYNC_PROTOCOL.md:45`) and `§14.2` (`line 725`: *"Keyed by `(table, uid)`"*) scope record identity per table, matching SQLite's per-table `UNIQUE(uid)` indexes (`src-tauri/src/schema.rs:941`). `planBootstrap` indexes `desktopByUid` and `mobileUids` by `row.uid` alone (`new Map` silently overwrites earlier tables on cross-table UID match and misclassifies `alreadyKnown` vs `upload`).
  4. **Property-order sensitivity (`conflictLosers`):** `JSON.stringify(item.desktop.fields) === JSON.stringify(item.mobile.fields)` returns `false` when both devices hold identical field values constructed with different JS property insertion orders, creating unnecessary Trash conflict copies (`§9.5`/`§13.2`).
- **User impact:** Burmese-heavy snapshots can exceed receiver batch byte caps by ~3×; snapshots assembled table-by-table split parent/child aggregates (`shopping_lists`/`shopping_items`, `jobs`/`income_entries`, `habits`/`habit_logs`) across batches despite `§8.3`; and identical records with reordered field keys produce spurious conflict copies in Trash.
- **Fix direction:** Measure `TextEncoder().encode(JSON.stringify(...)).byteLength` in `rowBytes`; pre-group rows sharing a non-null `aggregateOf(row)` key before cutting batches in `batchSnapshot`; key `planBootstrap` maps/sets by `` `${row.table}\0${row.uid}` ``; and canonicalize object key order (recursive sorted-key serialization) before comparing `fields` in `conflictLosers`.

---

### N9 — Listener windows with `pairing_id: None` accept hellos and seal under the all-zero salt (contradicting `§11.6.1` and code comments), and `/pair/hello` skips the `same-device` check
- **Severity:** Med
- **Evidence:**
  - `docs/ANDROID_SYNC_PROTOCOL.md:627-629` (`§11.6.1`):
    > `salt = the pairing id’s UTF-8 bytes. 32 zero bytes only when the flow has no pairing id; a window with no pairing id refuses every hello, so that branch seals nothing in practice.`
  - `src-tauri/src/envelope.rs:159-161` and `src/lib/sync/envelope.ts:115-117` repeat the exact claim: *"a window with no pairing id refuses every hello, so it seals nothing in practice."*
  - `src-tauri/src/pairing_listener.rs:897-904` (`rendezvous`) and `1031-1039` (`admit`):
    ```rust
    if let Some(expected) = gate.pairing_id.as_deref() {
        let presented = opened.message.get("pairingId").and_then(JsonValue::as_str);
        if presented != Some(expected) {
            return Err(RefusalReply::refused("pairing-mismatch", ...));
        }
    }
    ```
  - `src/lib/sync/pairing.ts:422`: `if (pinned.pairingId !== null && input.pairingId !== pinned.pairingId)`.
  - `src-tauri/src/pairing_listener.rs:993-1078` (`admit`) vs `891-896` (`rendezvous`) and `src/lib/sync/protocol.ts:276` (`handshake`): `admit` never checks `pin.device_id == gate.local_device_id` (`"same-device"`, `§1.2`).
- **What is wrong:**
  1. Both `ANDROID_SYNC_PROTOCOL.md` `§11.6.1` and the `kdf_salt` comments in `envelope.rs` and `envelope.ts` explicitly rely on the listener refusing every hello when `pairing_id` is `None`, so that the 32-zero-byte HKDF salt fallback is unreachable on the wire. In `pairing_listener.rs`, however, `if let Some(expected) = gate.pairing_id.as_deref()` **skips** the `pairingId` check altogether when `gate.pairing_id` is `None` (which `PairingOpenInput.pairing_id: Option<String>` in `commands.rs:876` permits!). When `gate.pairing_id` is `None`, both `rendezvous` and `admit` accept **any** `pairingId` (or none) and seal real response envelopes under the all-zero salt `[0u8; 32]` and empty `info` pairing suffix.
  2. On `POST /pair/hello`, `admit` omits the `same-device` check (`pin.device_id == gate.local_device_id`), whereas `rendezvous` (`pairing_listener.rs:891`) and `protocol.ts` `handshake` (`line 276`, `§1.2`) enforce it. If `pairing_open` is invoked with `peer.device_id == local_device_id`, `admit` will not reject it as `same-device`.
- **User impact:** Code and spec disagree on a stated cryptographic invariant (`§11.6.1`): any caller opening a window with `pairingId: null` disables per-pairing key domain separation (`§11.4`) and activates the zero-salt HKDF branch that the spec and comments declare unreachable.
- **Fix direction:** Make `pairing_id: String` mandatory on `PairingWindow` / `PairingOpenInput` (or explicitly return `RefusalReply::refused("unpaired" / "pairing-mismatch", ...)` at the top of both `rendezvous` and `admit` whenever `gate.pairing_id` is `None`, and similarly in `pairing.ts:422` when `pinned.pairingId === null`), and add the `pin.device_id == gate.local_device_id` `same-device` refusal in `admit`.

---

### N10 — `pinStatements` (`registerPeerStatements`) updates existing peers on conflict without zeroing cursors or dropping stale acks, and `pinAdmittedPeer` wipes `display_name` on re-pair
- **Severity:** Low-med
- **Evidence:**
  - `src/lib/sync/pairing.ts:464-484` delegates `pinStatements` to `registerPeerStatements` (`src/lib/sync/store.ts:305-315`):
    ```sql
    INSERT INTO sync_peers (device_id, pairing_id, display_name, public_key, generation, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      pairing_id = excluded.pairing_id,
      display_name = excluded.display_name,
      public_key = excluded.public_key,
      generation = excluded.generation,
      revoked_at = NULL
    ```
  - `src/lib/sync/pairingPanel.ts:212-219`:
    ```ts
    const existing = (await transport.peers()).find((row) => row.device_id === deviceId);
    const peer = { deviceId, publicKey, generation: state.local.generation };
    const statements = existing
      ? rePairStatements({ ...peer, pairingId: state.offer.pairingId })
      : pinStatements({ ...peer, pairingId: state.offer.pairingId });
    ```
- **What is wrong:**
  1. `registerPeerStatements`'s `ON CONFLICT(device_id) DO UPDATE` replaces `pairing_id`, `public_key`, and `generation` and clears `revoked_at = NULL`, **without** zeroing `cursor_in`/`cursor_out` and **without** deleting `sync_outbox_delivery` and `sync_tombstone_acks` for that `device_id`. If any caller invokes `pinStatements` for an already-known `device_id` (or if two `pinAdmittedPeer` calls interleave across `await transport.peers()` and `await transport.batch(...)`), stale cursors and delivery acks from an older pairing survive under a new `pairing_id` (`§11.4` violation).
  2. When `existing` is found, `pinAdmittedPeer` (`pairingPanel.ts:217`) does not pass `displayName: existing.display_name` to `rePairStatements`, so `rePairStatements` (`store.ts:351`: `peer.displayName ?? ""`) overwrites any user-visible peer `display_name` with `""`.
- **User impact:** Re-pairing erases the peer's stored `display_name`, and any code path hitting `pinStatements` on an existing `device_id` silently carries old cursors/acks into a new pairing (`pairingPanel.ts:200-202` specifically warns against this).
- **Fix direction:** Either make `registerPeerStatements` fail on conflict (pure `INSERT`) so re-pairs must go through `rePairStatements`, or have its conflict branch also zero `cursor_in`/`cursor_out` and clear acks; and pass `displayName: existing.display_name` in `pinAdmittedPeer`.

---

### N11 — Minor Rust vs TypeScript envelope wire-parsing drift (uppercase hex, non-integer `counter` in TS, and non-canonical wire JSON re-serialization)
- **Severity:** Low-med
- **Evidence:**
  - `src-tauri/src/envelope.rs:128-131` (`text.bytes().all(|b| b.is_ascii_hexdigit())` accepts `A-F`) vs `src/lib/sync/envelope.ts:96-98` (`/^[0-9a-f]*$/` rejects `A-F`), while `envelope.rs:65-68` documents `nonce` and `eph` as `"lowercase hex"`.
  - `src/lib/sync/envelope.ts:274-278, 339`:
    ```ts
    typeof header.v !== "number" || ... typeof header.counter !== "number"
    ...
    if (header.counter <= input.lastCounter) { ... }
    ```
  - `src-tauri/src/envelope.rs:326-334, 369` and `src/lib/sync/envelope.ts:266-287, 374`: both `open` implementations parse `input.raw` via `serde_json` / `JSON.parse` (ignoring unknown JSON fields and wire key order) and recompute AAD by re-serializing `Header` (`header_bytes(&header)` / `headerBytes(header)`).
- **What is wrong:**
  1. An envelope carrying uppercase hex in `body`, `nonce`, or `eph` is accepted by Rust `envelope::open` and rejected as `"malformed"` by TypeScript `open`.
  2. TypeScript `parseWire` checks only `typeof header.counter === "number"` rather than `Number.isSafeInteger(header.counter) && header.counter >= 1`. A fractional float like `counter: 0.5` passes `0.5 <= 0` (`false`) in TypeScript while failing `u64` deserialization in Rust; conversely, `u64` counters above `Number.MAX_SAFE_INTEGER` (`2^53 - 1`) silently round in JS `JSON.parse`, causing `headerBytes(header)` to serialize a different integer than Rust signed.
  3. Because AAD is computed from the re-serialized `Header` struct/object rather than authenticating raw header bytes (or rejecting unknown keys via `#[serde(deny_unknown_fields)]`), extra JSON properties injected into the outer wire object or `header`, whitespace changes, or reordered `header` keys on the wire are not rejected and do not invalidate the AEAD tag (though the 7 canonical `Header` fields themselves remain authenticated).
- **User impact:** Edge-case parser divergence between Rust and TypeScript implementations of the same `v1` wire format, plus minor wire-envelope malleability on unauthenticated extra JSON fields.
- **Fix direction:** Restrict `envelope::from_hex` in Rust to lowercase ASCII hex `0-9a-f` (matching `envelope.ts` and `Header`'s docstrings); check `Number.isSafeInteger(header.v)` and `Number.isSafeInteger(header.counter) && header.counter >= 1` in `envelope.ts`; and add `#[serde(deny_unknown_fields)]` on Rust wire/header structs with an exact key-count check in TypeScript `parseWire`.

---

### N12 — `a_window_without_a_code_admits_no_first_pairing` tests `/pair/hello` instead of `/pair/request`, leaving `rendezvous`'s no-code guard untested
- **Severity:** Low
- **Evidence:**
  - `src-tauri/src/pairing_listener.rs:1701-1712`:
    ```rust
    #[test]
    fn a_window_without_a_code_admits_no_first_pairing() {
        let state = PairingListenerState::default();
        let mut pinless = window(false);
        pinless.peer = None;
        let info = state
            .start("127.0.0.1", pinless, desktop_identity())
            .expect("start");
        let (status, body) = post(info.port.expect("port"), &request_body(|_| {}));
        assert_eq!(status, 403, "{body}");
        assert_eq!(refusal_reason(&body), "unpaired");
        state.stop().expect("stop");
    }
    ```
  - Compare `post(...)` (`POST /pair/hello`, `pairing_listener.rs:1330-1332`) vs `post_request(...)` (`POST /pair/request`, `pairing_listener.rs:1335-1337`).
- **What is wrong:** The test builds a `PairRequest` payload with `request_body(|_| {})` (`offer == None` and `peer == None`), then sends it with `post(...)` to **`POST /pair/hello`** instead of `post_request(...)` to **`POST /pair/request`**. It passes only because `admit` (`pairing_listener.rs:994-998`) *also* returns `403 "unpaired"` before `decode_frame`/`envelope::open` when `active_pin(gate)` is `None`! As a result, `rendezvous`'s `let Some(offer) = gate.offer.as_ref() else { ... }` guard (`pairing_listener.rs:843-848`) has **zero test coverage** (and if `pinless.peer` were `Some(...)`, `post` would have returned `400 malformed` on the unsealed body rather than testing `rendezvous`).
- **User impact:** Regression in `rendezvous`'s `gate.offer.is_none()` refusal path would go undetected by the test suite.
- **Fix direction:** Call `post_request(info.port.expect("port"), &request_body(|_| {}))` (and also assert the case where `pinless.peer` *is* `Some(...)` while `pinless.offer` is `None`, so only `rendezvous`'s `offer.is_none()` check can produce `403 "unpaired"`).

---

### N13 — Desktop listener IPC commands are exposed on Android, and secret key buffers in memory are not zeroized on drop
- **Severity:** Low
- **Evidence:**
  - `src-tauri/src/lib.rs:179-182` and `src-tauri/src/commands.rs:854-898`: `pairing_open`, `pairing_close`, and `pairing_status` are registered in `invoke_handler` on all targets without `#[cfg(desktop)]` / `#[cfg(not(target_os = "android"))]` guards (whereas `src/data/driver.ts:353-355` notes that only desktop opens the LAN listener).
  - `src-tauri/src/pairing_key.rs:35-38, 117-129`, `src-tauri/src/pairing_listener.rs:312, 395`, `src-tauri/src/envelope.rs:192-201, 259-269`, and `src-tauri/Cargo.toml:30`: raw 32-byte secrets (`PairingIdentity.secret`, `Gate.local_secret`, `mint()` stack `secret` and hex `String`, `key_store::read`'s `String`, `ephemeral_secret`, `dh_eph`, `dh_static`, `ikm`, `key`) are plain `[u8; 32]` / `String` values with no `Zeroize` / `ZeroizeOnDrop` cleanup (unlike `src-tauri/src/key_store/android.rs:94, 116`, which thoughtfully clears `dek.fill(0)` after wrapping/unwrapping).
- **What is wrong:**
  1. On Android, an unexpected call or WebView XSS can invoke `pairing_open` to bind an HTTP listener on `0.0.0.0` on the phone, even though the phone never acts as a sync server (`ANDROID_IPC_SURFACE.md`, `driver.ts:353`).
  2. Long-term and ephemeral X25519 private keys and HKDF `IKM`/AEAD keys remain in heap/stack memory after the pairing window closes.
- **User impact:** Unnecessary LAN listener attack surface reachable via Android IPC, and longer-than-necessary residence of long-term/ephemeral secret material in process memory dumps.
- **Fix direction:** Return a clean platform-unsupported refusal from `pairing_open` when `cfg!(target_os = "android")` (keeping command registration intact if desired for IPC table parity), and enable `zeroize` (`ZeroizeOnDrop`) on `PairingIdentity`, `Gate`'s secret, `StaticSecret`, and intermediate hex/IKM/key buffers in `pairing_key.rs` and `envelope.rs`.

---

## Checked and Found Clean

The following properties and invariants were verified directly in code and held up well:

- **Long-term secret non-serialization, backup exclusion (`§10.3`), and log safety:** `PairingIdentity` implements neither `Serialize` nor `Clone`, and its manual `fmt::Debug` prints only the 6-group public fingerprint (`src-tauri/src/pairing_key.rs:32-73`). `PairingIdentityInfo` and `PairingLocalInfo` carry only `public_key` and `fingerprint` (`pairing_key.rs:78-83`, `commands.rs:820-828`). Corrupt/non-hex values in `Slot::PairingIdentity` fail closed in `parse_secret` without echoing the stored string (`pairing_key.rs:133-147`, tested at `210-230`). Neither SQLite (`src-tauri/src/schema.rs:892-958`) nor desktop backup payloads store the long-term secret.
- **Keystore slot separation (`Database` vs `PairingIdentity`) and reset wipe:** Desktop separates keyring service entries (`"db-encryption-key"` vs `"pairing-identity-key"`, `src-tauri/src/key_store/mod.rs:28-33`, `desktop.rs:15`). Android separates filenames (`db-key.wrapped` vs `pairing-key.wrapped`), 5-byte file headers (`PMKW1` vs `PMPK1`), Keystore aliases (`purple_memo_db_key_wrap_v1` vs `purple_memo_pairing_key_wrap_v1`), and GCM AAD (`purple-memo:db-key:v1` vs `purple-memo:pairing-key:v1`), preventing cross-slot transplant (`mod.rs:35-69`, `android.rs:190-241`, tested at `android.rs:869-888`). `delete_db_key` deletes both slots on factory reset (`db.rs:956-972`), and `commands::factory_reset` stops the pairing listener under the shared `Lifecycle` barrier (`commands.rs:762-772`, `pairing_listener.rs:345, 403`).
- **Envelope AEAD construction, cross-language byte parity, header authentication, and replay rejection:** Both `src-tauri/src/envelope.rs` and `src/lib/sync/envelope.ts` compute `HKDF-SHA256(dh_eph || dh_static, salt, "purple-memo-envelope-v1\0from\0to\0pairingId", 32)`, mint a fresh 32-byte ephemeral X25519 key and 24-byte `XChaCha20-Poly1305` nonce per `seal`, reject all-zero low-order X25519 shared secrets (`envelope.rs:153-155`, `envelope.ts:109-111`), and pass the serialized `Header` (including `eph`) as AEAD associated data so any bit flip in `eph`, `nonce`, `counter`, `from`, `to`, `messageId`, or `body` fails authentication before returning plaintext. Real cross-language vectors in `src/lib/sync/__fixtures__/envelope-from-ts.json` and `envelope-from-rust.json` match byte-for-byte (`envelope-cross.test.ts` passed).
- **Length-prefixed wire framing (`00000011`):** Both `src/lib/sync/frame.ts:24-62` and `src-tauri/src/pairing_listener.rs:124-169` enforce a 4-byte big-endian byte length (`encodeFrame('{"kind":"hello"}')` → `00000010...`; 17-byte vector → `00000011...`), reject truncated, trailing-byte, invalid-UTF-8, and `> 64 KiB` frames, and never guess boundaries.
- **Unbiased 6-digit code generation & constant-time code check:** `mintCode` (`src/lib/sync/pairing.ts:81-94`) uses rejection sampling below `4_000_000_000` (`4000 × 10^6`) over CSPRNG `u32` values (zero modulo bias). Both `pairing.ts:165-171` and `pairing_listener.rs:791-799` compare normalized 6-digit codes in constant time, charge no attempt for malformed codes, enforce a 5-attempt cap, and mark `state.redeemed = true` while holding the `OfferState` mutex before returning (`pairing_listener.rs:968`).
- **Listener port-closure proof (`reap` / `wait_until_refused`):** `reap()` (`src-tauri/src/pairing_listener.rs:534-562`) signals `stop`, joins `serve`, and probes `127.0.0.1:<port>` until `TcpStream::connect_timeout` fails (or returns an explicit error naming the port after `CLOSE_DEADLINE`), eliminating `tiny_http`'s asynchronous drop race.
- **`§7.1` admission order and zero side effects on `POST /pair/hello`:** `handle` + `admit` (`src-tauri/src/pairing_listener.rs:748-768, 993-1085`) checks `revoked` before reading the body or touching keys (`§11.3`), then `unpaired`, frame decode, `envelope::open` (`WrongVersion` → `WrongRecipient` → `WrongSender` → `Replayed` → `Unauthenticated`), `ACCEPTED_KINDS` (`["hello"]`, `§2.3`), `pairingId`, `protocolVersion`, `schemaVersion`, and `generation`, mutating `last_counter` (`line 1082`) **only** after every check succeeds. Meanwhile, a `revoked` pin in `Gate.pin` does not block `POST /pair/request` from re-pairing (`pairing_listener.rs:748, 1715-1738`).
- **QR quiet zone, phone decode seam, and honest incomplete-feature disclosure:** `src/lib/sync/qr.ts` renders SVG modules with `margin: 4` and decodes back through `jsqr` → `parseOffer`; `mobilePairing.ts` routes typed codes through `pairing.ts`'s `redeemCode` rather than re-implementing rules; and `MobilePairingCard.tsx:188` (`i18n.ts:298-299`, EN & MY) plainly discloses that the phone's keystore-to-LAN wire step is not built yet and no data has moved.

---

## DECISION

The items below involve architectural contracts or behaviours **explicitly pinned by current tests** where code and `docs/ANDROID_SYNC_PROTOCOL.md` pull in different directions. Each needs an explicit maintainer call before building the phone's sealed transport client in the next session.

### D1 — Verdict on the `POST /pair/request` wire surface (`src-tauri/src/pairing_listener.rs:824-978` vs `docs/ANDROID_SYNC_PROTOCOL.md` `§11.1`, `§11.6.1`)
- **Verdict:** **Sound in core cryptographic shape, NOT ready to freeze as-is — requires targeted protocol/state changes before building the phone's sealed client, and must then be specified in `docs/ANDROID_SYNC_PROTOCOL.md` `§11`.**
- **Why the plaintext-request + sealed-ack split is sound in principle:** On first pairing (or key-rotation re-pair), the desktop does not yet know the phone's public key, so the phone's initial rendezvous message cannot be sealed under a pre-existing phone pin. Sending `(deviceId, publicKey, pairingId, code, versions)` in a framed request gated by the 120 s / 5-attempt single-use code and returning the desktop's `"paired"` confirmation inside an ordinary `envelope::seal` addressed to `request.publicKey` avoids inventing custom crypto or adding a PAKE — **provided** `§11.1`/`§11.6.1`'s human fingerprint check actually gates trust.
- **Changes required before the phone's sealed client is built on top of `POST /pair/request`:**
  1. **Separate rendezvous staging from trust/pin persistence (see N1):** `POST /pair/request` must only stage a *candidate* peer for fingerprint display and sealed `POST /pair/hello` key-possession proof — never auto-commit to `sync_peers` (or overwrite an existing peer's row by `deviceId`) until the human confirms matching fingerprints on the desktop.
  2. **Define `PairRequest.generation` semantics explicitly (or remove `generation` from `PairRequest`):** Right now `pairing_listener.rs:923-928` refuses `POST /pair/request` with `"needs-re-pair"` (`"this device's data line changed since it paired; re-pair it"`) whenever `request.generation != gate.local_generation`! Because `POST /pair/request` **is** the pairing/re-pairing endpoint, if the phone client sends its *own* stored `sync_state.data_generation` (e.g. `1` on a fresh phone or pre-restore phone) after the desktop restored a backup (`local_generation >= 2`), **every pairing and re-pairing will permanently deadlock with `needs-re-pair`**. Either:
     - **Option A (cleaner):** Drop `generation` from `PairRequest` (or ignore the phone's old generation during rendezvous) and let the desktop's sealed `"paired"` ack (`pairing_listener.rs:948`) deliver the authoritative `local_generation` that the phone stores for this pairing (`§10.2`), or
     - **Option B:** Document in `§11` that `PairRequest.generation` must echo `offer.generation` from the desktop's QR offer (proving the phone is answering *this* offer), never the phone's prior `sync_state.data_generation`.
  3. **Harden pre-code validation and worker timeouts (see N5 & N9):** Require `pairingId` to be non-null and match `gate.pairing_id` *before* spending one of the 5 code attempts; validate `deviceId` as canonical lowercase UUID v4 (no NULs) and `publicKey` as a valid 32-byte X25519 key before touching `attempts`; reset `last_counter = 0` when staging `paired`; and put a read timeout on request bodies.
  4. **Document `POST /pair/request` and fix `§11.1`'s QR wording in `docs/ANDROID_SYNC_PROTOCOL.md`:** Add `POST /pair/request` (request fields, refusal codes, check order, and `"paired"` sealed ack schema) alongside `POST /pair/hello` in `§11.6.1`, update the stale implementation-status paragraph at `ANDROID_SYNC_PROTOCOL.md:662-665`, and amend `§11.1` (`line 558`: *"QR carries … both device public key fingerprints"*, which is impossible before the desktop knows the phone's key) to say the QR carries the **desktop's** public key while both screens display **both** fingerprints after `POST /pair/request` exchanges the phone's key.

---

### D2 — Envelope forward-secrecy claim in `§11.6.1` vs the test-pinned `es + ss` DH construction (`docs/ANDROID_SYNC_PROTOCOL.md:618-639`, `src-tauri/src/envelope.rs:28-30, 205-230`, `src/lib/sync/envelope.ts:22-27, 165-191`)
- **Pinned by:** `src/lib/sync/envelope.test.ts:74-101`, `src/lib/sync/envelope-cross.test.ts`, and `src-tauri/src/envelope.rs:483-507, 682-711`.
- **Tension:** `ANDROID_SYNC_PROTOCOL.md:637-639` states:
  > `Because the message key depends on a secret the sender destroys after one message, a later compromise of both long-term keys does not open recorded envelopes — the forward secrecy this section asks for.`
  That statement does **not** hold for the implemented `es + ss` construction. Because the receiver contributes **only** its long-term static key (`receiver_secret`), and the sender's ephemeral public key `eph` rides in cleartext in `header.eph`, `open_key(receiver_secret, sender_public, header.eph, ...)` (`envelope.rs:219-230`, `envelope.ts:179-191`) requires **only `receiver_secret` plus wire-recorded public values**. Compromising a device's long-term secret (and therefore compromising *both* long-term keys) opens every past recorded envelope ever sent *to* that device. What `es + ss` actually provides is **sender-compromise secrecy / KCI resistance** (compromising only the *sender's* long-term key does not open past envelopes it sent, because the attacker has neither `ephemeral_secret` nor `receiver_secret`) and per-message key randomization.
- **Decision needed:**
  - **Option A (Document as built — no wire change):** Amend `docs/ANDROID_SYNC_PROTOCOL.md:637-639` and the docstrings in `envelope.rs:28-30` / `envelope.ts:25-27` to state accurately that per-message sender ephemeral X25519 provides sender-key-compromise resistance and per-message key separation, while true ephemeral-ephemeral forward secrecy is deferred or bounded by `§11.5`'s manual short-lived LAN window.
  - **Option B (Upgrade to `ee + es + ss` before Stage 1 sync):** Have the desktop listener generate a per-window ephemeral X25519 keypair in memory (exposed in the QR offer and in the hello ack, destroyed when `PairingListenerState::stop` runs) and mix `dh_ee = X25519(eph_sender, eph_receiver)` into HKDF `IKM` (`dh_ee || dh_es || dh_ss`), which genuinely satisfies `§11.6.1`'s *"later compromise of both long-term keys does not open recorded envelopes"* claim.

---

### D3 — Whether re-pairing bumps desktop `data_generation` (`docs/ANDROID_SYNC_PROTOCOL.md:514-515` `§10.1` vs `src/lib/sync/store.ts:333-372`)
- **Pinned by:** `src/lib/sync/pairing.test.ts:452-472` and `src/lib/sync/pairingPanel.test.ts:253-260`.
- **Tension:** `§10.1` (`docs/ANDROID_SYNC_PROTOCOL.md:514-515`) states that desktop `generation` is *"bumped by **any** restore (whatever the backup's age), by a factory reset, **and by a re-pair**"*. In code, `rePairStatements` (`src/lib/sync/store.ts:333-372`) resets `cursor_in = 0`, `cursor_out = 0`, `revoked_at = NULL`, clears acks, and assigns a fresh `pairing_id` (`§11.4`), **without** bumping `sync_state.data_generation`. In fact, keeping `data_generation` stable on a single peer's re-pair preserves compatibility with multiple paired devices (`store.test.ts` tests `UID_PEER_A` and `UID_PEER_B` concurrently), whereas bumping `data_generation` would unnecessarily invalidate other paired peers when `pairing_id` already isolates the re-paired peer's session (`§11.4`).
- **Decision needed:** Confirm whether `rePairStatements`'s behaviour is authoritative (and remove *"and by a re-pair"* from `§10.1` plus adjust `protocol.ts:302`'s message wording), or bump `sync_state.data_generation` inside `rePairStatements` if single-peer global generation bump was intended.

---

### D4 — Aggregate batch boundary overflow (`202 > 200` ops) vs receiver-enforced `MAX_BATCH_OPS` (`src/lib/sync/bootstrap.ts:141-151` vs `docs/ANDROID_SYNC_PROTOCOL.md` `§3.2`, `§8.3`)
- **Pinned by:** `src/lib/sync/bootstrap.test.ts:154-179` (`assert.ok(holder.length <= 202, "the aggregate exception may exceed the bound by the aggregate only")`).
- **Tension:** `§3.2` (`docs/ANDROID_SYNC_PROTOCOL.md:191-192`) and `§8.3` (`lines 446-453`) state *"At most 200 ops or 256 KiB per batch, whichever binds first; an aggregate is never split across batches"* and *"200 ops / 256 KiB per batch (§3.2); the sender chooses the size, **the receiver enforces the bound**"*. Currently, if batch 1 has 199 unrelated notes and row 200 starts a 3-row shopping list (`list-L`, `item-L1`, `item-L2`), `batchSnapshot` puts row 200 into batch 1 (`199 < 200`) and then forces rows 201 and 202 into batch 1 (`202` ops) — which a strict 200-op receiver validator in Stage 1 will **reject**!
- **Decision needed:** Before writing Stage 1's receiver batch validator, decide whether:
  - **Option A:** Pre-measure each grouped aggregate before appending so `batchSnapshot` flushes at 199 and places the 3-row shopping list cleanly into batch 2 (`3 <= 200`), exceeding `200` ops / `256 KiB` *only* when a single aggregate alone is larger than a whole batch (with a matching single-aggregate rule on the receiver), or
  - **Option B:** Document an explicit receiver slack margin above `200` ops / `256 KiB` in `§3.2`/`§8.3`.

---

### D5 — Refusal code naming on desktop post-restore generation mismatch: `"generation-mismatch"` (`src/lib/sync/pairing.ts:430-441`) vs `"needs-re-pair"` (`src-tauri/src/pairing_listener.rs:1066-1077`)
- **Pinned by:** `src/lib/sync/pairing.test.ts:346-369` (asserts `"generation-mismatch"`) vs `src-tauri/src/pairing_listener.rs:1632-1648` (asserts `"needs-re-pair"`).
- **Tension:** In `pairing.ts:430-441`, `admitPeer` calls `handshake(input.local, remote)` *before* checking `pinned.generation !== input.local.generation`. Because a paired phone sends `remote.generation === pinned.generation`, a desktop restore that bumps `local.generation` triggers `handshake`'s `"generation-mismatch"` at line 430 — making `pairing.ts:434-441` (`code: "needs-re-pair"`) unreachable unless the phone forged `remote.generation` to match the desktop's new generation! Meanwhile, Rust's `admit` (`pairing_listener.rs:1066-1077`) returns `"needs-re-pair"` in both cases.
- **Decision needed:** Pick one canonical wire refusal reason (`"needs-re-pair"` or `"generation-mismatch"`) before the phone's sealed transport client branches on `reason` to prompt re-pairing (`§10.2`).
