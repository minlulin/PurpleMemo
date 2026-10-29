# PurpleMemo Audit Findings — Batch 7 (Lock, Session, Crypto, and Reset Core)

- **Base branch & commit:** `dev` @ `3c0add5` (`3c0add52761f2c91448b21c8247885c486d35127`)
- **Review branch:** `arena/eef0b571-purplememo`
- **Review date:** 2026-10-29
- **Mode:** Audit-only (no source, test, or configuration modifications)

## Scope & Method

### Scoped files read in full (line-by-line, 1,279 lines)
1. `src/lib/session.ts` (lines `1–354`) — lock teardown (`lockSession`, `stopSharingWithRetry`), LAN share status poller (`createShareTicker`), and due-reminder poller (`createReminderTicker`)
2. `src/lib/crypto.ts` (lines `1–331`) — base64/SHA-256/CSPRNG helpers, PBKDF2-SHA256 PIN & recovery-answer hashing/verification, vault key/tag derivation, and AES-256-GCM byte/string encryption & decryption
3. `src/lib/appLock.ts` (lines `1–300`) — retry throttle (`lockRetryDelayMs`), forgotten-PIN block rule (`pinResetBlocked`), monotonic idle check (`isIdle`), `classifyPin`, `lockGate`, `shellStage`, `showReloadWarning`, `reloadOpensEntry`, and `securityReloadNeeded`
4. `src/lib/reset.ts` (lines `1–143`) — `ResetAttempt` model, `shouldRestart` policy gate, heading/body/component/status catalogue mappings, `outcomeRows`, and `hasBlockedComponent`
5. `src/components/ResetScreen.tsx` (lines `1–151`) — `ResetResultScreen` terminal UI, `appRestart()` call site behind `shouldRestart`, per-component failure report, and `onRetry` action

### Caller, IPC seam, and test files read for context
- **UI & shell callers (read in full):** `src/App.tsx` (`1–1082`), `src/components/LockScreens.tsx` (`1–689`), `src/pages/SettingsPage.tsx` (`1–1403`), `src/components/ConfirmButton.tsx` (`1–114`)
- **Data, crypto, & settings callers (read in full):** `src/lib/vault.ts` (`1–452`), `src/lib/backupContainer.ts` (`1–258`), `src/lib/share.ts` (`1–297`), `src/lib/settings.ts` (`1–202`), `src/lib/errors.ts` (`1–12`), `src/data/driver.ts` (`1–326`), `src/data/app.ts` (`1–83`); plus `src/lib/i18n.ts` (`1–559`), `src/lib/backup.ts` (`1–120`), and `src/lib/gallery.ts` (`1–120`) for imported/referenced seams
- **Rust IPC seams (read for argument/ordering/error contracts, not re-audited):** `src-tauri/src/commands.rs` (`450–569`, `690–840`), `src-tauri/src/reset.rs` (`210–329`), `src-tauri/src/lib.rs` (`480–669`), `src-tauri/src/db.rs` (`145–214`)
- **Tests read in full:** `src/lib/session.test.ts` (`1–607`), `src/lib/crypto.test.ts` (`1–101`), `src/lib/appLock.test.ts` (`1–552`), `src/lib/reset.test.ts` (`1–241`), `src/reset-gate.test.ts` (`1–232`), `src/pages/submit-guards.test.ts` (`1–1017`), `src/lib/vault.test.ts` (`1–402`), `src/app-shortcuts.test.ts` (`1–141`); plus `src/lib/settings.test.ts` (`1–200`), `src/pages/delete-guards.test.ts` (`1–200`), `src/lib/backupContainer.test.ts` (`1–120`), and `src/data/ipc.test.ts` (`1–200`)
- **Prior audit batches checked for non-duplication and regressions:** `docs/PurpleMemo_Audit_Findings.md` (`F1`–`F12`) and `docs/Arena_Findings_261026.md` through `docs/Arena_Findings_Batch6.md` (`B1`–`B14`, `C1`–`C6`, `D1`–`D12`, `E1`–`E14`, `G1`–`G14`, and Batch 3–6 `DECISION` resolutions)

### In-scope test verification
Ran on Node `v22.22.3` (`node_modules` is not installed in the sandbox, so suites importing npm packages such as `fflate` cannot execute without network installation; all dependency-free in-scope suites ran directly):

```sh
node --test \
  src/lib/session.test.ts \
  src/lib/crypto.test.ts \
  src/lib/appLock.test.ts \
  src/lib/reset.test.ts \
  src/reset-gate.test.ts \
  src/lib/vault.test.ts \
  src/lib/settings.test.ts \
  src/pages/submit-guards.test.ts \
  src/pages/delete-guards.test.ts \
  src/app-shortcuts.test.ts
node scripts/token-lint.mjs
```

- **Result:** `132 / 132` tests pass (`0` failures); `token-lint` passed (`154` files checked).
- **Regression check:** No regressions of prior fixes (`F1`–`F12`, `B1`–`B14`, `C1`–`C6`, `D1`–`D12`, `E1`–`E14`, `G1`–`G14`, or the `G9` remainder) were found in the scoped files; `H2` documents deeper validation gaps inside `appLock.ts` / `crypto.ts` that remained beneath `G1`'s caller-level fix.

---

## Summary Table

| ID | Severity | File(s) | Summary |
|---|---|---|---|
| **H1** | **Med-high** | `src/lib/session.ts:290-350` | `createReminderTicker` tracks `requested` instead of permission outcome — on the very next 30s tick after OS permission denial (or transient prompt throw), it fires `notify()` anyway and marks/reschedules every due reminder; locking during a denied prompt also fires `onPermissionDenied()` after cancellation |
| **H2** | **Med-high** | `src/lib/appLock.ts:71-74, 136-170, 183-191`, `src/lib/crypto.ts:23-27, 107-125` | `isPinHashShape` / `classifyPin` / `pinResetBlocked` accept non-base64 strings (throwing past `noteFailure()`), whitespace-only `"   "` 0-byte salts (unsalted PBKDF2), and unbounded `iterations` (`> 2^32 - 1` `TypeError` or multi-minute CPU stall), and `lockGate` omits `G1`'s `answerHash` validation |
| **H3** | **Med-high** | `src/components/ResetScreen.tsx:39-46, 138-145` (+ `src/App.tsx:565-680`) | Rendering `ResetResultScreen` leaves `unlocked === true` and `vaultRepo` keys cached in memory; idle auto-lock or `Ctrl+L` locks the shell underneath `ResetResultScreen`, causing `"Retry reset"` to land on `LockScreen` -> `stage === "error"` over a closed DB with no path back to retry |
| **H4** | **Med** | `src/lib/session.ts:48-52, 84-115, 147-153` (+ `src/App.tsx:519-532, 845, 895`) | `stopSharingWithRetry` runs uncancelled for up to ~84s across unlock (letting a prior lock's backoff retry tear down a newly started LAN share), and `onShareStopFailed` writes to `notifyNote`, which is never rendered on `LockScreen` (contradicting `session.ts`'s confidentiality contract) |
| **H5** | **Med** | `src/lib/crypto.ts:7-8, 179-210, 278-294, 321-331` (+ `src/lib/vault.ts:51-67`) | `decryptWithKey` / `decryptBytesWithKey` skips `IV_BYTES` (`12`) and 16-byte GCM tag-length checks, causing short/empty IVs and truncated ciphertexts to throw WebCrypto `OperationError` (reported to users as `WrongPasswordError` even with the right password) while accepting non-96-bit IVs and 0-byte salts |
| **H6** | **Med** | `src/lib/reset.ts:48-50, 71-76`, `src/components/ResetScreen.tsx:81-88` (+ `commands.rs:716, 737`, `lib.rs:627-655`) | Pre-engine `factoryReset()` failure (`mark_reset_started` error) strands the user on `ResetResultScreen` claiming `"the database connection is closed"` while `reset_terminal` is still `false` and the DB is still open, so closing the window hides to tray instead of quitting |
| **H7** | **Low-med** | `src/lib/appLock.ts:88-98` (+ `src/lib/settings.ts:119-121`, `src/App.tsx:508`) | `appLock.ts` provides no validator for `AUTO_LOCK_CHOICES`, and `isIdle` returns `false` on `NaN`/non-numeric `minutes`, silently disabling auto-lock on a corrupt `auto_lock_minutes` row while `SettingsPage` displays `"5 minutes"` |
| **H8** | **Low-med** | `src/components/ResetScreen.tsx:50-68, 81, 97-104` | `ResetResultScreen.restart` lacks a synchronous `useRef` guard (double-click invokes `appRestart()` twice before `restarting` state commits) and renders `<h2>` with no `<h1>` on a full-window screen |
| **H9** | **Low** | `src/lib/appLock.ts:177-181, 288-300` | `UNREADABLE_PIN_REASON["weak-iterations"]` uses locale-dependent `toLocaleString()` inside English copy (breaking `appLock.test.ts` on non-US system locales), and `SECURITY_TRUST_ROOT_KEYS` omits `"security_question"` |
| **H10** | **Low** | `src/lib/crypto.ts:147-150, 204-205, 217-218, 296-302`, `src/lib/reset.ts:132-143`, `src/components/ResetScreen.tsx:33-37`, `src/lib/session.ts:167` | Dead production exports (`VaultKey`, `createVaultKey`, `hasBlockedComponent`), vault salt-model comments contradicting the per-item salt implementation, duplicated blocked-status set in `ResetScreen.tsx`, and truncated JSDoc in `session.ts` |

---

## Findings

### H1 — `createReminderTicker` forgets OS permission denial after one tick, consuming due reminders silently 30 seconds later (and can call `onPermissionDenied` after lock)
- **Severity:** **Med-high**
- **Location:** `src/lib/session.ts:290-350` (seam: `src/App.tsx:161-168, 194-226`, `src/lib/i18n.ts:75-76`, `src/lib/session.test.ts:448-455, 479-497`)
- **Evidence:**
  ```ts
  // src/lib/session.ts:290-305, 336-347
  let requested = false;
  return async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const now = ports.now();
      const due = await ports.due(now);
      if (due.length === 0 || ports.isCancelled()) return;
      if (!requested) {
        requested = true;
        if (!(await ports.requestPermission())) {
          ports.onPermissionDenied();
          return;
        }
      }
      if (ports.isCancelled()) return;
      ...
      ports.notify(...);
      for (const reminder of due) {
        if (reminder.repeat === "none") {
          await ports.markFired(reminder.id);
        } else {
          await ports.reschedule(
            reminder.id,
            nextReminderAt(reminder.remind_at, reminder.repeat, now),
          );
        }
      }
      ports.onFired?.();
  ```
- **What is wrong:**
  1. **Tick 2 drops every due reminder when OS notification permission is denied:** `createReminderTicker` records only `let requested = false` (`:290`), not whether permission was granted. On tick 1, when `requestPermission()` resolves `false`, the ticker calls `ports.onPermissionDenied()` (`i18n.ts:75-76`: *"Notifications are blocked — due reminders stay listed in Tasks"*) and returns without mutating the database. On tick 2 (30 seconds later via `App.tsx:221`), `if (!requested)` (`:298`) is skipped because `requested === true`, so the ticker proceeds as if permission had been granted: it calls `ports.notify(...)` (dropped by the OS) and then executes `markFired` / `reschedule` on every due row (`:336-345`). `src/lib/session.test.ts:448-455` (`"the reminder ticker reports a denied permission instead of dropping reminders"`) calls `await tick()` only once and therefore never exercises tick 2.
  2. **Transient `requestPermission()` throw permanently bypasses the permission check:** Setting `requested = true` at `:299` *before* `await ports.requestPermission()` (`:300`) means any transient rejection from `requestPermission()` is swallowed by `catch` (`:348`) while leaving `requested = true`, so tick 2 marks reminders fired without ever having obtained permission.
  3. **Post-lock `onPermissionDenied()` and `onFired()` races:** At `:300-305`, if the user locks or unmounts the shell while the OS permission dialog is open and the dialog resolves `false`, `ports.onPermissionDenied()` runs at `:301` *before* `if (ports.isCancelled()) return;` at `:305` (violating `:276`: *"Nothing fires after the shell unmounts or locks"*; `session.test.ts:479-497` tested `grantPermission?.(true)` on lock, not `false`). Likewise, `ports.isCancelled()` is not re-checked before `ports.onFired?.()` (`:347`) after the async `markFired` / `reschedule` loop (`:336-345`).
- **User impact:** When OS notifications are blocked, Purple Memo tells the user *"Notifications are blocked — due reminders stay listed in Tasks"*, then 30 seconds later silently marks all due one-off reminders as fired and advances repeating reminders to their next cycle without delivering any OS notification.
- **Concrete fix direction:**
  - Replace `let requested = false` with explicit permission state (e.g. `type PermState = "unknown" | "granted" | "denied"`), or re-check `isPermissionGranted()` cleanly while firing `onPermissionDenied()` only once per ticker lifecycle (`let denialReported = false`): while permission remains denied, return before `notify` / `markFired` / `reschedule` so due reminders genuinely stay listed in Tasks, while picking up permission if the user later enables it in OS Settings.
  - Only update cached permission state *after* `await ports.requestPermission()` resolves, check `if (ports.isCancelled()) return;` immediately after `await ports.requestPermission()` (before `ports.onPermissionDenied()`), and guard `ports.onFired?.()` with `if (!ports.isCancelled())`.
  - Extend `session.test.ts:448-455` to invoke `await tick()` twice after denial and assert `events` is still `["denied"]` (no `notify`, no `mark`, no `reschedule`), plus a lock-during-denial test alongside `:479-497`.

---

### H2 — `isPinHashShape` / `classifyPin` / `pinResetBlocked` accept invalid base64, zero-byte (`"   "`) salts, and unbounded `iterations`, and `lockGate` omits `G1`'s `answerHash` validation
- **Severity:** **Med-high**
- **Location:** `src/lib/appLock.ts:71-74, 136-170, 183-191`, `src/lib/crypto.ts:23-27, 107-125` (seam: `src/App.tsx:498-504`, `src/components/LockScreens.tsx:383-425, 433-498`, `src/pages/SettingsPage.tsx:271-290`)
- **Evidence:**
  ```ts
  // src/lib/appLock.ts:136-147, 183-191
  function isPinHashShape(value: unknown): value is PinHash {
    if (typeof value !== "object" || value === null) return false;
    const v = value as Partial<PinHash>;
    return (
      typeof v.salt === "string" &&
      v.salt.length > 0 &&
      typeof v.hash === "string" &&
      v.hash.length > 0 &&
      typeof v.iterations === "number" &&
      Number.isInteger(v.iterations)
    );
  }
  ...
  export function lockGate(pin: PinState, answerHash: unknown): LockGate {
    if (pin.kind === "absent") return "setup";
    if (pin.kind === "unreadable") return "locked";
    return answerHash === null || answerHash === undefined ? "pin-only" : "pin";
  }
  ```
  ```ts
  // src/lib/crypto.ts:23-27, 111-117
  export function b64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  ...
  const hash = await pbkdf2Sha256(pin, b64ToBytes(stored.salt), stored.iterations);
  const expected = b64ToBytes(stored.hash);
  if (hash.length !== expected.length) return false;
  ```
- **What is wrong:** Batch 6 (`G1`) routed `security_answer_hash` through `classifyPin` and `isPinHashShape`, but reading `appLock.ts` and `crypto.ts` in full shows four validation gaps inside the shared classifier itself:
  1. **Undecodable base64 strings pass `classifyPin` and `pinResetBlocked` (`appLock.ts:140-143`):** `{ "salt": "***", "hash": "x", "iterations": 600000 }` classifies as `{ kind: "stored" }` instead of `{ kind: "unreadable", reason: "malformed" }`. On `pin_hash`, the user is sent to `LockScreen` instead of `LockedScreen`, and every unlock submit throws `DOMException [InvalidCharacterError]` inside `b64ToBytes` (`crypto.ts:24`), jumping into `catch` (`LockScreens.tsx:414`) **without calling `noteFailure()`** and rendering raw DOMException text; on `security_answer_hash`, `"Forgot PIN?"` remains enabled (`App.tsx:503`) and throws on submit without incrementing the retry throttle.
  2. **Whitespace-only `salt` (`"   "`) decodes to `0` bytes — accepting unsalted PBKDF2 (`crypto.ts:24`, `appLock.ts:140-141`):** `v.salt.length > 0` accepts `"   "`, and Web `atob("   ")` ignores ASCII whitespace and returns `""` (`Uint8Array(0)`). `verifyPin` / `verifyAnswer` runs PBKDF2 with an empty 0-byte salt and returns `true` on digest match, enabling precomputed rainbow-table digests in a crafted backup's `settings` table. (See also **DECISION 2** regarding enforcing exact 16-byte salt / 32-byte digest lengths vs `appLock.test.ts:30`'s 4-byte test fixture.)
  3. **No upper bound on `iterations` (`appLock.ts:144-145, 166`):** `iterations` has a floor (`MIN_PIN_HASH_ITERATIONS = 100_000`) but no ceiling:
     - `iterations > 4_294_967_295` (`2^32 - 1`, e.g. `5_000_000_000`, still passing `Number.isInteger`) passes `classifyPin` and throws a WebIDL `TypeError` (`outside the expected range of 0 to 4294967295`) inside `crypto.subtle.deriveBits`, again skipping `noteFailure()` and stranding the user on `LockScreen` instead of `LockedScreen`.
     - Large 32-bit values (e.g. `iterations: 1_000_000_000`, `> 1,600×` `PBKDF2_ITERATIONS`) stall WebCrypto worker threads for minutes on every PIN check (contrast `backupContainer.ts:163`, which rejects `iterations !== PBKDF2_ITERATIONS`).
  4. **`lockGate` (`appLock.ts:183-191`) was not updated alongside `pinResetBlocked` (`:71-74`):** `lockGate(storedPin, { iterations: 1 })` and `lockGate(storedPin, 42)` still return `"pin"` instead of `"pin-only"`. `App.tsx:498-503` masks this today by pre-filtering `answerRaw` through `classifyPin`, but `lockGate`'s public contract disagrees with `pinResetBlocked`.
- **User impact:** A corrupted or tampered `settings` row (e.g. from an imported backup) can bypass `LockedScreen` recovery guidance with raw WebCrypto errors that skip retry throttling, freeze the unlock UI via excessive PBKDF2 iterations, or verify against an unsalted PBKDF2 digest.
- **Concrete fix direction:**
  - Validate strict canonical base64 in `b64ToBytes` (reject whitespace/invalid alphabet/bad padding cleanly) and have `isPinHashShape` / `classifyPin` / `pinResetBlocked` reject undecodable or 0-byte `salt`/`hash` values as `"malformed"`.
  - Add a sensible `MAX_PIN_HASH_ITERATIONS` ceiling (e.g. `10_000_000`, well above `600_000` for future KDF bumps while bounded under `<10s` and `<= 2^32 - 1`) in `classifyPin` and `pinResetBlocked`.
  - Validate `answerHash` inside `lockGate` with the exact same helper used by `pinResetBlocked` (`isValidStoredPinHash(answerHash)`), and add unit tests in `appLock.test.ts` covering invalid base64, whitespace salt, oversized `iterations`, and malformed `answerHash` in `lockGate`.

---

### H3 — `ResetResultScreen` leaves the shell `unlocked` (vault keys cached in memory, pollers querying a closed DB, and auto-lock / `Ctrl+L` active, breaking `"Retry reset"`)
- **Severity:** **Med-high**
- **Location:** `src/components/ResetScreen.tsx:39-46, 138-145` (seam: `src/App.tsx:519-532, 547-652, 669-680, 916`, `src/pages/SettingsPage.tsx:753-771`, `src/lib/vault.ts:163-166, 290-292`)
- **Evidence:**
  ```tsx
  // src/App.tsx:565-591, 669-680
  useEffect(() => {
    if (!unlocked) return;
    ...
    const timer = window.setInterval(() => {
      if (isIdle(lastActivityRef.current, performance.now(), boot.autoLockMinutes)) {
        lockNow();
      }
    }, 15_000);
    ...
  }, [unlocked, boot.autoLockMinutes, lockNow]);
  ...
  if (resetAttempt !== null) {
    return (
      <ResetResultScreen
        attempt={resetAttempt}
        onRetry={() => setResetAttempt(null)}
      />
    );
  }
  ```
- **What is wrong:** When `SettingsPage.runFactoryReset` calls `p.onResetFinished(attempt)` (`setResetAttempt`), `AppShell` renders `ResetResultScreen` via an early `return` (`App.tsx:674-680`) **without clearing `vaultRepo` keys or pausing workspace-only effects**:
  1. **Vault `CryptoKey`s and password tags stay cached in memory after factory reset:** `vaultRepo.lockVault()` is never called when entering or completing factory reset. Even after `complete: true` (when SQLite files, photos, safety copies, logs, and the OS keyring entry have all been erased and `ResetResultScreen` states *"Everything Purple Memo stored on this device was removed"*), derived AES-256-GCM `CryptoKey`s and `VAULT_TAG_ITERATIONS` tags remain live in `vault.ts`'s `keyCache` until process restart.
  2. **Idle auto-lock or `Ctrl+L` locks the shell underneath `ResetResultScreen` and strands `"Retry reset"`:** On a partial/blocked reset (`done === false`), `reset.incompleteBody` tells the user to close external programs holding files open and click `Retry reset`. Because `unlocked` is still `true`, the 15-second `isIdle` timer (`App.tsx:579-586`) and global `keydown` handler (`Ctrl+L` at `:632-634`) remain active:
     - If the user takes longer than `boot.autoLockMinutes` (as short as 5 minutes) closing another application — or presses `Ctrl+L` — `lockNow()` sets `unlocked = false` behind `ResetResultScreen`.
     - Clicking **`Retry reset`** (`ResetScreen.tsx:141` -> `setResetAttempt(null)`) then reveals `stage === "lock"` (`LockScreen`) instead of `SettingsPage`.
     - Submitting the PIN on `LockScreen` calls `enterWorkspace()` -> `loadSecurity()` (`App.tsx:547-549`), which reads `settings` against the **closed** database connection (`commands.rs:726`), transitioning to `stage === "error"` (*"Could not read the encrypted database: database connection is closed — restart the app"*), where neither `ResetResultScreen` nor `SettingsPage` can ever be reached again.
  3. **Background pollers & shortcut modals stay active (`App.tsx:593-600, 620-652`):** `useReminderPoll` and `useSharePublisher` keep polling the closed DB every 30 seconds, and `Ctrl+Shift+M` / `Ctrl+K` / `?` arm hidden `captureOpen` / `searchOpen` / `shortcutsOpen` modal state while `ResetResultScreen` is displayed.
- **User impact:** Sensitive vault keys stay cached in renderer RAM after a completed factory wipe, and on an incomplete reset waiting past the auto-lock window (or pressing `Ctrl+L`) turns `"Retry reset"` into a dead-end `LockScreen` -> `error` trap.
- **Concrete fix direction:**
  - Immediately invoke `vaultRepo.lockVault()` when `onResetFinished` fires (before or inside setting `resetAttempt`), and close any open shell modals (`setCaptureOpen(false)`, `setSearchOpen(false)`, `setShortcutsOpen(false)`).
  - Gate `useReminderPoll`, `useSharePublisher`, the `isIdle` `useEffect`, and the global shortcut `keydown` `useEffect` on `unlocked && resetAttempt === null` so no workspace timer, shortcut, or `lockNow()` transition runs while `ResetResultScreen` owns the window. (See also **DECISION 1** on whether `onRetry` should stay inside `ResetResultScreen` rather than returning to `AppShell`.)

---

### H4 — `stopSharingWithRetry` runs uncancelled across unlock (allowing a stale retry to stop a new LAN share) and reports `onShareStopFailed` to a channel invisible while locked
- **Severity:** **Med**
- **Location:** `src/lib/session.ts:48-52, 81-115, 131-153` (seam: `src/App.tsx:347, 519-532, 718-725, 845, 895`, `src/lib/share.ts:224-236`)
- **Evidence:**
  ```ts
  // src/lib/session.ts:48-52, 99-111, 147-152
  export const SHARE_STOP_RETRY_DELAYS_MS = [
    250, 1_000, 3_000, 5_000, 10_000, 30_000,
  ];
  export const SHARE_STOP_TIMEOUT_MS = 5_000;
  ...
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      await withTimeout(stopSharing(), timeoutMs);
      return true;
    } catch (error) {
      lastError = error;
    }
    const delay = delays[attempt];
    if (delay !== undefined) await wait(delay);
  }
  try {
    opts.onFailed?.(lastError);
  ...
  void stopSharingWithRetry(ports.stopSharing, {
    retryDelaysMs: ports.retryDelaysMs,
    stopTimeoutMs: ports.stopTimeoutMs,
    wait: ports.wait,
    onFailed: ports.onShareStopFailed,
  });
  ```
  ```tsx
  // src/App.tsx:519-532 (notifyNote is rendered ONLY at :845 DashboardPage & :895 TasksPage)
  const lockNow = useCallback(() => {
    lockSession({
      lockVault: () => vaultRepo.lockVault(),
      stopSharing: () => shareRepo.stop(),
      onLocked: () => { ... setUnlocked(false); },
      onShareStopFailed: () => setNotifyNote(shareStopFailed),
    });
  }, [shareStopFailed]);
  ```
- **What is wrong:**
  1. **Detached retry loop has no cancellation or epoch guard across unlock/re-share:** Unlike `createShareTicker` (`:168`) and `createReminderTicker` (`:266`), `stopSharingWithRetry` has no `shouldAbort` / `isCancelled` hook. Its backoff spans `49.25s` of sleeps plus up to `7 × 5s = 35s` of per-attempt timeouts (`~84.25s` total). If `share_stop` times out or fails on Lock #1, and the user unlocks Purple Memo within that window and starts a **new** LAN share (`SettingsPage.startShare` -> `shareRepo.start()`), Lock #1's sleeping retry wakes up and calls `shareRepo.stop()`, tearing down the newly started listener and clearing `shareKey` (`share.ts:233`). Repeated lock/unlock cycles while wedged also stack concurrent retry loops.
  2. **`onShareStopFailed` is completely invisible on `LockScreen` (behaviour contradicts comments):** `session.ts:82-85` and `:131-136` state that `onShareStopFailed` exists because *"the status poller is paused while locked, so a listener that failed to stop kept serving the dashboard with nothing on screen to say so"* — *"a serving confidentiality problem, not a cosmetic one"* (echoed in `session.test.ts:212-215`: *"reported while the user is still standing at the lock screen"*). Yet `App.tsx:530` passes `() => setNotifyNote(shareStopFailed)`, and `notifyNote` is rendered **only** inside `DashboardPage` (`:845`) and `TasksPage` (`:895`) when `stage === "workspace"` — never on `LockScreen`, never via `ToastProvider`, and not on the other 15 workspace pages (including `SettingsPage`).
- **User impact:** A LAN listener that fails to stop on lock continues serving the shared dashboard over the network with zero warning on `LockScreen`; conversely, if an earlier stop attempt stalled and recovered after unlock, its orphaned retry loop silently kills a freshly started LAN share up to a minute later.
- **Concrete fix direction:**
  - Add an optional `isCancelled?: () => boolean` to `stopSharingWithRetry` / `LockPorts` (checked before each attempt after `wait(delay)` and before `onFailed`), wired to a lock/share generation token invalidated whenever a new share is explicitly started (and superseded when a newer `lockSession` begins).
  - Surface `onShareStopFailed` via a dedicated alert banner rendered on `LockScreen` (and shell-wide across workspace pages, analogous to `showReloadWarning` in `App.tsx:734-738`) or `toast.error(shareStopFailed)` (`ToastProvider` wraps `AppShell` at `App.tsx:1075` and renders above `LockScreen`).

---

### H5 — `decryptWithKey` / `decryptBytesWithKey` omits IV-length (`12`) and GCM tag-length (`16`) checks, misclassifying corrupt vault ciphertexts as `WrongPasswordError`
- **Severity:** **Med**
- **Location:** `src/lib/crypto.ts:7-8, 179-210, 273-294, 321-331` (seam: `src/lib/vault.ts:51-67`, `src/lib/vault.test.ts:212-235`, `src/lib/backupContainer.ts:169-176`)
- **Evidence:**
  ```ts
  // src/lib/crypto.ts:273-294, 321-331
  /**
   * AES-256-GCM open. Throws `OperationError` when the tag does not verify —
   * wrong key, modified header, or tampered ciphertext; callers translate that
   * into the one message they may honestly show.
   */
  export async function decryptBytesWithKey(
    key: CryptoKey,
    iv: Uint8Array,
    ciphertext: Uint8Array,
    additionalData?: Uint8Array,
  ): Promise<Uint8Array> {
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource, ... },
      key,
      ciphertext as BufferSource,
    );
    return new Uint8Array(opened);
  }
  ...
  export async function decryptWithKey(key: CryptoKey, cipher: VaultCipher): Promise<string> {
    const plain = await decryptBytesWithKey(
      key,
      b64ToBytes(cipher.iv),
      b64ToBytes(cipher.ciphertext),
    );
    return new TextDecoder().decode(plain);
  }
  ```
- **What is wrong:** `vault.ts:51-67` (`decryptItem`) relies on `decryptBytesWithKey`'s JSDoc contract (`e.name === "OperationError"` -> `throw new WrongPasswordError()`) to enforce the invariant tested in `vault.test.ts:212-235` (*"corrupt stored ciphertext is NOT reported as a wrong password"*). Unlike `backupContainer.ts:169-176` (which checks 12-byte IV and minimum 16-byte GCM tag before calling `decryptBytesWithKey`), `decryptWithKey` / `decryptBytesWithKey` performs no length validation:
  1. **Empty/short IVs (`0` bytes or `< 12` bytes) and truncated ciphertexts (`< 16` bytes, shorter than the 128-bit GCM authentication tag) throw WebCrypto `OperationError`:** Verified at runtime on Node `v22.22.3` (and per the WebCrypto AES-GCM specification, which raises `OperationError` when `iv` is empty or `ciphertext.byteLength < tagLength / 8`). When a `vault_items` row has `iv: ""` or `ciphertext: "AAAA"` (3 bytes), `vault.getItem`, `vault.unlock`, `vault.updateItem`, and `vault.changePassword` throw **`WrongPasswordError` ("wrong vault password")** even when the user enters the **correct** password.
  2. **Non-96-bit IVs and 0-byte salts are silently accepted:** `decryptBytesWithKey` accepts e.g. 16-byte IVs despite `const IV_BYTES = 12` (`crypto.ts:8`), and `deriveVaultTag` / `deriveVaultKey` (`:179-210`) accept empty/whitespace `saltB64` (`0` decoded bytes).
- **User impact:** Structural corruption of a stored `vault_items` row (`iv` or `ciphertext` truncated below the GCM tag size) tells the user their vault password is wrong instead of surfacing a corrupt-data error, sending them chasing a password mismatch that does not exist.
- **Concrete fix direction:**
  - Export `IV_BYTES = 12` and `GCM_TAG_BYTES = 16` in `src/lib/crypto.ts`.
  - In `decryptBytesWithKey` (or `decryptWithKey`), validate `iv.byteLength === IV_BYTES` and `ciphertext.byteLength >= GCM_TAG_BYTES` **before** calling `crypto.subtle.decrypt`, throwing a descriptive `Error` (not `OperationError`) when violated so `vault.ts` surfaces `"Stored vault entry is corrupt and cannot be decrypted"` while `OperationError` strictly means authentication-tag failure.
  - Reject decoded salts shorter than `SALT_BYTES` (`16`) in `deriveVaultKey` and `deriveVaultTag`, and add tests in `crypto.test.ts` and `vault.test.ts` for empty/non-12-byte IVs and `< 16`-byte ciphertexts.

---

### H6 — Pre-engine `factoryReset()` failure (`ipc-error`) strands the user on `ResetResultScreen` claiming the DB is closed while `reset_terminal` is `false` (so closing the window hides to tray)
- **Severity:** **Med**
- **Location:** `src/lib/reset.ts:48-50, 71-76`, `src/components/ResetScreen.tsx:3-8, 81-88` (seam: `src/pages/SettingsPage.tsx:761-766`, `src-tauri/src/commands.rs:716-751`, `src-tauri/src/lib.rs:627-655`, `src/lib/i18n.ts:509-513`)
- **Evidence:**
  ```ts
  // src/lib/reset.ts:48-50, 71-76
  export function resetAttemptFromError(error: string): ResetAttempt {
    return { kind: "ipc-error", error };
  }
  ...
  export function bodyKey(attempt: ResetAttempt): MessageKey {
    if (attempt.kind === "ipc-error") return "reset.errorBody";
    return attempt.outcome.complete ? "reset.successBody" : "reset.incompleteBody";
  }
  ```
  ```rust
  // src-tauri/src/commands.rs:716-738
  crate::reset::mark_reset_started(&db_state.data_dir)?;
  let _reset_gate = lifecycle.raise_reset()?;
  db::close_connection_for_reset(&db_state);
  ...
  db_state.reset_terminal.store(true, Ordering::SeqCst);
  ```
  ```rust
  // src-tauri/src/lib.rs:637-639
  if state.reset_terminal.load(Ordering::SeqCst) {
      return false;
  }
  ```
- **What is wrong:** `reset.errorBody` (`i18n.ts:510-513`) and `ResetScreen.tsx:5-6` assume that whenever `factoryReset()` throws, the Rust engine has closed the database connection and entered terminal reset mode:
  > *"The reset attempt failed before a full report could be produced. Nothing can be assumed about what was removed — the session is over either way: **the database connection is closed**, so retry the reset or **close Purple Memo and start it yourself**."*
  Across the IPC boundary in `commands.rs:716-751`, however, **every** `Err(...)` path of `factory_reset` occurs either:
  1. **Before closing the DB or touching any data:** `mark_reset_started(&db_state.data_dir)?` (`:716`, returning `"could not record the reset in ... — nothing was deleted; a reset only starts once it can be recovered"`) or `lifecycle.raise_reset()?` (`:721`). Here the DB connection is **still open**, nothing was deleted, and `db_state.reset_terminal` is intentionally left `false` (pinned by `commands.rs:885`); or
  2. **On `spawn_blocking` panic (`:750`):** after closing the DB (`:726`), where `.map_err(...)` returns early **before** `db_state.reset_terminal.store(true, ...)` at `:737`!
  In both cases `db_state.reset_terminal` remains `false`. When the user follows `ResetResultScreen`'s instruction to *"close Purple Memo and start it yourself"* by clicking the window close button (`X`) with `close_to_tray` at its default `true` (`lib.rs:648-654`), `close_to_tray_enabled` (`lib.rs:637`) returns `true` and **hides `ResetResultScreen` to the system tray instead of exiting**, and reopening the app from the tray or desktop shortcut merely re-focuses the same stuck `ResetResultScreen`.
- **User impact:** An abort before reset begins (e.g. disk full when writing the reset marker) unnecessarily evicts the user onto `ResetResultScreen` with contradictory copy (`"the database connection is closed"` alongside `"nothing was deleted"`), and clicking the window close button hides the stuck terminal screen to the tray instead of quitting.
- **Concrete fix direction:**
  - Either keep pre-engine aborts (where Rust guarantees nothing was closed or deleted) in `SettingsPage` as an inline `alert-error` without transitioning to `ResetResultScreen`, **or** if `ResetResultScreen` remains the single sink for all `factoryReset()` errors, ensure `reset_terminal` is set whenever the DB has been closed (including if `spawn_blocking` panics, e.g. immediately after `close_connection_for_reset`) and update `reset.errorBody` / window-close handling so closing `ResetResultScreen` always exits cleanly.

---

### H7 — `appLock.ts` provides no validator for `auto_lock_minutes`, allowing non-numeric settings values to silently disable auto-lock via `isIdle`
- **Severity:** **Low-med**
- **Location:** `src/lib/appLock.ts:88-98` (seam: `src/lib/settings.ts:31-39, 119-121`, `src/App.tsx:483, 508, 577-583`, `src/pages/SettingsPage.tsx:859-871`)
- **Evidence:**
  ```ts
  // src/lib/appLock.ts:88-98
  export function isIdle(
    lastActivityMs: number,
    nowMs: number,
    minutes: number,
  ): boolean {
    if (minutes <= 0) return false;
    return nowMs - lastActivityMs > minutes * 60_000;
  }

  /** The idle-timeout choices offered in Settings (minutes; 0 = never). */
  export const AUTO_LOCK_CHOICES = [5, 10, 15, 30, 0] as const;
  ```
- **What is wrong:** `settingsRepo.getAutoLockMinutes()` (`settings.ts:119-121`) performs an unchecked `JSON.parse(raw) as number`, and `App.tsx:508` applies `minutes ?? DEFAULT_AUTO_LOCK_MINUTES` (`??` falls back only on `null`/`undefined`). If `settings.auto_lock_minutes` holds a non-number or out-of-domain JSON value (e.g. `"never"`, `{}`, `[10]`, `false`, or `NaN` from a malformed backup or damaged row):
  - `isIdle` evaluates `minutes <= 0` and `nowMs - lastActivityMs > minutes * 60_000`, which both evaluate to `false` on `NaN` (`"never"`, `{}`) and `false` — **silently disabling idle auto-lock** instead of failing safe to `DEFAULT_AUTO_LOCK_MINUTES` (`10`). (Conversely, `0.001` locks the workspace every 15 seconds.)
  - Meanwhile, `<select value={p.autoLockMinutes}>` (`SettingsPage.tsx:862-870`) matches none of `AUTO_LOCK_CHOICES`, so HTML `<select>` displays its first `<option>` (**`"5 minutes"`**) while auto-lock is completely inactive.
- **User impact:** A corrupt or foreign `auto_lock_minutes` row leaves an unlocked session open indefinitely while Settings visually indicates `"5 minutes"`.
- **Concrete fix direction:**
  - Export `DEFAULT_AUTO_LOCK_MINUTES = 10` and `parseAutoLockMinutes(raw: string | undefined): AutoLockMinutes` from `src/lib/appLock.ts` (mirroring `parseViewMode` in `notesView.ts`), accepting only members of `AUTO_LOCK_CHOICES` (or finite non-negative integers if custom intervals are ever intended) and returning `DEFAULT_AUTO_LOCK_MINUTES` on invalid/unparseable values.
  - Harden `isIdle` defensively so `!Number.isFinite(minutes)` does not silently evaluate to `false`, and test non-numeric inputs in `appLock.test.ts`.

---

### H8 — `ResetResultScreen.restart` lacks a synchronous `useRef` submit guard and renders `<h2>` with no `<h1>` landmark
- **Severity:** **Low-med**
- **Location:** `src/components/ResetScreen.tsx:50-68, 81, 97-104` (seam: `src/pages/submit-guards.test.ts:547-595`, `src/reset-gate.test.ts:161-213`, `src/components/LockScreens.tsx:284`)
- **Evidence:**
  ```tsx
  // src/components/ResetScreen.tsx:50-68, 81, 97-104
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);

  const restart = async () => {
    setRestarting(true);
    setRestartError(null);
    try {
      await appRestart();
    } catch (e) {
      setRestartError(errText(e));
      setRestarting(false);
    }
  };
  ...
  <h2 className="editor-title">{t(headingKey(attempt))}</h2>
  ...
  <button
    type="button"
    className="btn btn-primary"
    disabled={restarting}
    onClick={() => void restart()}
  >
  ```
- **What is wrong:**
  1. **No synchronous re-entry guard on `restart()`:** `disabled={restarting}` only takes effect after React commits the re-render queued by `setRestarting(true)`, and `restart()` checks neither a `useRef(false)` guard nor `restarting`. Rapid double-click or double-`Enter` fires two concurrent `appRestart()` (`invoke("app_restart")`) IPC calls (the same class of async handler race closed in `LockScreens.tsx` under `G4` and enforced across pages in `submit-guards.test.ts`).
  2. **Document lacks an `<h1>` when `ResetResultScreen` is mounted:** `ResetResultScreen` replaces the entire `AppShell` (`App.tsx:674-680`), so rendering `<h2 className="editor-title">` (`:81`) leaves the document without any level-1 heading (contrast `LockedScreen` at `LockScreens.tsx:284`, which uses `<h1>`).
- **User impact:** Rapid double-activation on `"Restart Purple Memo"` issues duplicate process-restart IPC requests; screen-reader landmark/heading navigation finds an `<h2>` with no parent `<h1>`.
- **Concrete fix direction:**
  - Add `const restartingRef = useRef(false);` inside `ResetResultScreen`, early-returning in `restart()` when `restartingRef.current` is `true` and resetting `restartingRef.current = false` in `catch` (preserving the exact `const restart = async () => {` / `await appRestart()` structure pinned in `src/reset-gate.test.ts:161-213`), and add `ResetResultScreen.restart` to `src/pages/submit-guards.test.ts`.
  - Change `<h2 className="editor-title">` at `ResetScreen.tsx:81` to `<h1 className="editor-title">`.

---

### H9 — Locale-dependent `UNREADABLE_PIN_REASON["weak-iterations"]` formatting and missing `"security_question"` in `SECURITY_TRUST_ROOT_KEYS` (`appLock.ts`)
- **Severity:** **Low**
- **Location:** `src/lib/appLock.ts:177-181, 288-300` (seam: `src/App.tsx:480, 505-507, 720`, `src/pages/SettingsPage.tsx:281`, `src/lib/appLock.test.ts:476-481`)
- **Evidence:**
  ```ts
  // src/lib/appLock.ts:177-181, 288-300
  export const UNREADABLE_PIN_REASON: Record<PinUnreadable, string> = {
    corrupt: "corrupt (not valid JSON)",
    malformed: "in an unexpected shape",
    "weak-iterations": `hashed with too few iterations (below ${MIN_PIN_HASH_ITERATIONS.toLocaleString()})`,
  };
  ...
  export const SECURITY_TRUST_ROOT_KEYS: readonly string[] = [
    "pin_hash",
    "security_answer_hash",
  ];
  ```
- **What is wrong:**
  1. **`MIN_PIN_HASH_ITERATIONS.toLocaleString()` omits an explicit locale (`:180`):** Evaluated at module load with the host OS/runtime default locale inside hardcoded English prose. On hosts whose default locale formats `100000` differently (e.g. `de-DE` -> `"100.000"`, `fr-FR` -> `"100 000"`, `my-MM` -> `"၁၀၀,၀၀၀"`), it produces mixed-locale English text and fails `appLock.test.ts:478` (`assert.match(..., /100,000/)`).
  2. **`SECURITY_TRUST_ROOT_KEYS` omits `"security_question"` (`:288-291`):** `App.tsx:480, 505-507, 720` caches `boot.question` alongside `boot.pin` and `boot.answerHash` once per `loadSecurity()` pass to render on `LockScreen`. Today `SettingsPage.saveSecurityQuestion` writes both `security_question` and `security_answer_hash` together, so `securityReloadNeeded` happens to return `true`; however, `securityReloadNeeded(["security_question"])` returns `false`, so any caller updating the prompt text alone leaves `LockScreen` displaying the stale recovery question on the next lock.
- **User impact:** Deterministic unit-test failure on non-US developer/CI locales and mixed-script English error copy; fragile trust-root reload contract if recovery question text is ever updated independently.
- **Concrete fix direction:**
  - Pass `"en-US"` explicitly (`MIN_PIN_HASH_ITERATIONS.toLocaleString("en-US")`) in `appLock.ts:180` (and align with i18n keys if localized).
  - Add `"security_question"` to `SECURITY_TRUST_ROOT_KEYS` (`appLock.ts:288-291`) and cover it in `appLock.test.ts:483-507`.

---

### H10 — Dead exports, contradicting vault salt-model comments, duplicated status set, and truncated JSDoc across `crypto.ts`, `reset.ts`, `ResetScreen.tsx`, and `session.ts`
- **Severity:** **Low**
- **Location:** `src/lib/crypto.ts:147-150, 204-205, 217-218, 296-302`, `src/lib/reset.ts:132-143`, `src/components/ResetScreen.tsx:33-37, 120-124`, `src/lib/session.ts:167`
- **Evidence:**
  ```ts
  // src/lib/crypto.ts:147-150, 204-205, 296-302
  export interface VaultKey {
    key: CryptoKey;
    salt: string; // base64 password salt (stored in settings)
  }
  ...
  /** Derive a vault key from a password + the setup salt. */
  export async function deriveVaultKey(password: string, saltB64: string): Promise<CryptoKey> ...
  ...
  /** Create a fresh vault: new password salt + derived key (the key is never stored). */
  export async function createVaultKey(password: string): Promise<VaultKey> { ... }
  ```
  ```ts
  // src/lib/reset.ts:132-143 vs src/components/ResetScreen.tsx:33-37
  /**
   * Whether the report lists any component the user must act on — i.e. the
   * engine said something failed or never ran. Drives the failure styling of the
   * result list; it never drives a restart (see {@link shouldRestart}).
   */
  export function hasBlockedComponent(attempt: ResetAttempt): boolean { ... }
  ```
- **What is wrong:**
  1. **Contradicting vault salt architecture comments + dead `VaultKey` / `createVaultKey` exports (`crypto.ts`):** `crypto.ts:2-3, 145, 176-177` accurately state that vault entries use a **per-item salt** stored on each `vault_items` row (`vault.ts:1-6, 296-309`; no vault salt exists in `settings`), whereas `crypto.ts:149` (`stored in settings`), `:204` (`the setup salt`), `:218` (`its setup salt`), and `:296-302` (`createVaultKey`) describe a superseded single-salt vault design. Neither `VaultKey` nor `createVaultKey` has any production caller in `src/` (imported only in `crypto.test.ts:8`).
  2. **Unreferenced `hasBlockedComponent` (`reset.ts:137`) + duplicated blocked-status set (`ResetScreen.tsx:34-37`):** `hasBlockedComponent`'s JSDoc claims it *"Drives the failure styling of the result list"*, yet it has zero production callers (`reset.test.ts:27` only), while `ResetScreen.tsx:34-37` re-declares `BLOCKED_STATUS_KEYS = new Set(["reset.status.failed", "reset.status.notAttempted"])` for per-row badge styling.
  3. **Truncated JSDoc (`session.ts:167`):** `/** True once the shell unmounted or locked — see  */` ends mid-sentence.
- **User impact:** Maintenance hazard — misleading security documentation around where vault salts live and duplicated status-classification rules that can drift.
- **Concrete fix direction:**
  - Update `crypto.ts:204, 218` comments to say *"per-item salt"*, and remove unused `VaultKey` / `createVaultKey` (updating `crypto.test.ts` to test `deriveVaultKey` + `randomSaltB64` directly, matching `vault.ts`).
  - Export `isBlockedStatusKey(statusKey: MessageKey): boolean` from `src/lib/reset.ts`, use it inside both `hasBlockedComponent` and `ResetScreen.tsx:121`, and complete the JSDoc reference at `session.ts:167`.

---

## Checked and Found Clean

Every area below was verified directly in the scoped files and their immediate callers/IPC seams:

1. **Database encryption key is keyring-backed, never PIN-derived (`src/lib/crypto.ts`, `src-tauri/src/db.rs`):**
   - `hashPin`, `verifyPin`, `hashAnswer`, and `verifyAnswer` (`src/lib/crypto.ts:97-141`) produce/verify only 256-bit PBKDF2-SHA256 verification digests stored in `settings` (`pin_hash`, `security_answer_hash`) and return a `boolean`; no PIN-derived bytes ever form a `CryptoKey` or cross IPC to Rust.
   - `load_or_mint_db_key` (`src-tauri/src/db.rs:169-197`) loads or mints the 256-bit SQLCipher key solely via the OS credential store (`keyring::Entry`) or explicit `.key` recovery before the webview opens.
2. **Core cryptographic parameters, non-extractable keys, IV freshness, constant-time comparison, and AAD (`src/lib/crypto.ts`, `src/lib/vault.ts`, `src/lib/backupContainer.ts`):**
   - `PBKDF2_ITERATIONS = 600_000` (`crypto.ts:6`), `SALT_BYTES = 16` (`:7`), `IV_BYTES = 12` (`:8`), and `crypto.getRandomValues` (`:53`) meet modern OWASP PBKDF2-HMAC-SHA256 and NIST AES-256-GCM parameters.
   - `verifyPin` (`:117-124`) compares equal-length digests in constant time (`diff |= hash[i] ^ expected[i]`).
   - `deriveAesGcmKey` (`:222-246`) marks all derived AES-256-GCM `CryptoKey` objects `extractable = false` (`:243`), and `deriveVaultTag` (`:179-202`) domain-separates the 100k-iteration cache tag salt (`[...salt, 0x9e]`) from the encryption key derivation.
   - `encryptWithKey` (`:308-319`) mints a fresh 12-byte random IV on every write (including `vault.updateItem` at `vault.ts:367`, avoiding AES-GCM nonce reuse), and `encryptBytesWithKey` / `decryptBytesWithKey` (`:255-294`) authenticate the 44-byte `backupContainer` header via AES-GCM `additionalData`.
3. **No secret or key material in logs, toasts, or error strings (`crypto.ts`, `appLock.ts`, `session.ts`, `reset.ts`, `ResetScreen.tsx`, `LockScreens.tsx`, `SettingsPage.tsx`):**
   - Verified all error/toast/diagnostic paths across the 5 scoped files and lock/settings/vault callers: PIN inputs, recovery answers, vault passwords/plaintexts, backup passwords, and the SQLCipher master key never enter `console.*`, `toast.*`, or thrown `Error` messages.
   - Verbatim rendering of `row.detail` in `ResetScreen.tsx:130-132` matches settled Batch 5 Decision 5 (`KEEP` raw local filesystem/keyring diagnostics on reset failure paths).
4. **First-run bypass resistance, monotonic auto-lock clock, and prior Batch 6 lock fixes (`src/lib/appLock.ts`, `src/components/LockScreens.tsx`, `src/App.tsx`):**
   - `classifyPin` (`appLock.ts:155-170`), `lockGate` (`:183-191`), and `shellStage` (`:237-252`) open `SetupScreen` strictly on `pin.kind === "absent"` (`raw === undefined`); corrupt JSON and `< 100,000` iteration counts fail closed to `LockedScreen`, `error !== null` outranks `lockGate` (`"error"`), and `reloadOpensEntry` (`:277-279`) blocks unlocking onto a stale `boot.pin`.
   - `isIdle` (`appLock.ts:88-95`) paired with `App.tsx:353, 550, 567-582` uses monotonic `performance.now()` exclusively, preventing wall-clock rollback from extending an unlocked session.
   - Batch 6 fixes `G4` (`LockScreen` `submittingRef`, `cooldownTimerRef` cleanup on unmount, `busy` reset before `noteFailure()`, `await p.onUnlock()`, `await onDone()`, mode-switch disabled while `busy || cooling`) and `G11` (clearing `pin` on `"Forgot PIN?"` and clearing `draft` on `"Back"`, rejecting whitespace-only `draft.answer` before PBKDF2) remain intact in `src/components/LockScreens.tsx:346-498, 567-575, 670-677`.
5. **Fail-closed lock ordering, non-stacking pollers, and private-by-default reminder coalescing (`src/lib/session.ts`):**
   - `lockSession` (`session.ts:133-153`) isolates `ports.lockVault()` and `ports.onLocked()` in independent `try/catch` blocks before scheduling `stopSharingWithRetry`, ensuring a throwing step cannot prevent `setUnlocked(false)` or LAN teardown; `withTimeout` (`:59-74`) clears its timer in `finally`.
   - `createShareTicker` (`:186-215`) and `createReminderTicker` (`:286-354`) prevent overlapping ticks via `inFlight`, emit LAN unexpected-stop notices only on a `true -> false` edge, default notification previews to `false` on settings-read failure (`:308-313`), and coalesce multi-reminder bursts (`due.length > 1`) into a count-only summary (`:316-324`).
6. **Factory-reset confirmation gate and `shouldRestart` invariant (`src/lib/reset.ts`, `src/components/ResetScreen.tsx`, `src/pages/SettingsPage.tsx`):**
   - `factoryReset()` has a single UI call site (`SettingsPage.tsx:762`), gated behind `resettingRef`, explicit `resetAck` checkbox state, and two-step `ConfirmButton` confirmation (pinned by `src/reset-gate.test.ts` and `src/pages/submit-guards.test.ts:547-552`).
   - `shouldRestart` (`reset.ts:58-60`) returns `true` strictly for `{ kind: "outcome", outcome: { complete: true } }`, gating the sole `appRestart()` call site (`ResetScreen.tsx:60`), and `RESET_COMPONENT_LABEL_KEYS` / `RESET_STATUS_LABEL_KEYS` cover all Rust enum variants in both `en` and `my` (`reset.test.ts:125-156`).

---

## DECISION Items (Test-Pinned Behaviour Requiring Owner Choice)

### DECISION 1 — `ResetResultScreen` `"Retry reset"` (`onRetry={() => setResetAttempt(null)}`) re-opens the full `AppShell` workspace over a closed database vs retrying directly on `ResetResultScreen`
- **Files:** `src/components/ResetScreen.tsx:3-15, 44-45, 138-145`, `src/App.tsx:669-680`
- **Pinning tests:** `src/reset-gate.test.ts:79-91` (pins `factoryReset()` exclusively to `pages/SettingsPage.tsx`) and `src/reset-gate.test.ts:215-231` (explicitly asserts `App.tsx` passes `onRetry={() => setResetAttempt(null)}`)
- **Why this needs a decision:**
  - Both `ResetScreen.tsx:4-6` (*"there is no path back into the app from here, because the engine has closed the database connection and every DB command fails closed from that moment"*) and `reset-gate.test.ts:221-223` (*"after any attempt the database connection is closed, so no workspace screen may render again"*) state that no workspace screen may render once `factoryReset()` has run.
  - Yet `onRetry={() => setResetAttempt(null)}` (`App.tsx:678`) clears `resetAttempt` and **re-mounts the entire `AppShell` workspace**. While `page` happens to still be `"settings"` (with `resetAck` reset to `false`), the entire sidebar (`Dashboard`, `Notes`, `Tasks`, `Budget`, `Vault`, `Trash`, …), `GlobalSearchDialog`, and `Quick Capture` become clickable again — clicking any sidebar item renders broken workspace screens failing with `"database connection is closed — restart the app"` errors, with no banner or button to return to `ResetResultScreen` unless the user navigates back to `Settings -> Danger zone`, re-checks the box, and triggers `factoryReset()` again.
- **Options:**
  1. **Keep & document current flow (plus fix H3):** Keep `factoryReset()` exclusively in `SettingsPage.tsx` and keep `onRetry={() => setResetAttempt(null)}` (paired with `setPage("settings")` and **H3**'s session/poller/auto-lock fixes), and update the misleading comments in `ResetScreen.tsx:4-8` and `reset-gate.test.ts:221-223` to document that `onRetry` intentionally returns to `SettingsPage`'s Danger Zone over a closed DB.
  2. **Make `ResetResultScreen` genuinely terminal:** Keep `resetAttempt !== null` permanently once the DB has closed, and render the acknowledgement checkbox + two-step `ConfirmButton` retry directly inside `ResetResultScreen`'s `!done` branch (updating `src/reset-gate.test.ts:86, 229` to pin the retry gate on `ResetScreen.tsx`).

---

### DECISION 2 — Enforcing exact 16-byte `salt` and 32-byte `hash` decoded lengths in `classifyPin` / `pinResetBlocked` vs `appLock.test.ts`'s 4-byte synthetic `HASH` fixture
- **Files:** `src/lib/appLock.ts:71-74, 136-170`, `src/lib/crypto.ts:7, 97-125`
- **Pinning test:** `src/lib/appLock.test.ts:30, 140-144` (`const HASH = { salt: "c2FsdA==", hash: "aGFzaA==", iterations: 600_000 }`, where `"c2FsdA=="` = 4 bytes `"salt"` and `"aGFzaA=="` = 4 bytes `"hash"`)
- **Why this needs a decision:**
  - `hashPin` (`crypto.ts:97-105`) always produces a **16-byte** `salt` (`SALT_BYTES = 16`) and a **32-byte** `hash` (256-bit PBKDF2-SHA256), and `verifyPin` (`crypto.ts:117`: `if (hash.length !== expected.length) return false;`) **unconditionally returns `false`** for any stored `hash` whose decoded byte length is not `32`.
  - Consequently, if a stored `pin_hash` row has a truncated non-32-byte `hash` (such as 4-byte `"aGFzaA=="`), `classifyPin` currently returns `{ kind: "stored" }` and sends the user to `LockScreen`, where *every* PIN says `"Wrong PIN."` forever instead of routing to `LockedScreen` (`"malformed"`) with recovery instructions; similarly, a 4-byte `security_answer_hash` keeps `"Forgot PIN?"` visible even though `verifyAnswer` can never return `true`.
  - However, enforcing `decodedSalt.byteLength === SALT_BYTES` (`16`) and `decodedHash.byteLength === 32` in `isPinHashShape` requires updating `HASH` at `src/lib/appLock.test.ts:30` from its synthetic 4-byte strings to a real 16-byte-salt / 32-byte-hash fixture (whereas fixing **H2**'s invalid base64, 0-byte `"   "` salt, `iterations` ceiling, and `lockGate` parity passes with `HASH` unchanged).
- **Options:**
  1. **Enforce exact byte lengths (`salt === 16` bytes, `hash === 32` bytes) and update `appLock.test.ts:30`'s fixture (recommended):** Ensures any stored hash that `verifyPin` / `verifyAnswer` could never mathematically match fails closed as `"malformed"` (`LockedScreen` for `pin_hash`, `"pin-only"` / `"no-answer"` for `security_answer_hash`).
  2. **Require only valid base64 with `byteLength >= 1` (keep `appLock.test.ts:30` unchanged):** Fixes **H2**'s undecodable base64 and 0-byte whitespace salt bugs while documenting that wrong-length digests fail closed at `verifyPin` (`return false`) rather than `classifyPin`.

---

## Resolutions — owner decisions, 2026-10-29

The two decisions above are settled as follows. The original wording is
preserved; these resolutions are the fix wave's authority.

1. **Retry reset: option (1) — keep & document the current flow, plus
   fix H3.** `factoryReset()` stays exclusively in `SettingsPage.tsx`
   and `onRetry` keeps returning to `SettingsPage`'s Danger Zone (paired
   with `setPage("settings")` and H3's session/poller/auto-lock fixes);
   the misleading comments in `ResetScreen.tsx:4-8` and
   `reset-gate.test.ts:221-223` are updated to document that return.
   Rationale: the single-call-site gate for factory reset (ack checkbox
   + two-step confirmation, pinned by `reset-gate.test.ts`) is a
   deliberate safety design — moving the retry into `ResetResultScreen`
   would duplicate that gate in a second UI, exactly what the gate
   exists to prevent, plus test-pin churn. H3's fixes already remove
   the dangerous parts (lock trap, live pollers, cached keys); what
   remains is fail-closed broken screens plus misleading comments,
   which this option fixes by documentation.
2. **Hash lengths: option (1) — enforce exact byte lengths (`salt === 16`
   bytes, `hash === 32` bytes) and update `appLock.test.ts:30`'s fixture.**
   Rationale: `hashPin` always produces a 16-byte salt and a 32-byte
   hash, and `verifyPin` can never match anything else — so a truncated
   hash routed to `LockScreen` is a forever-"Wrong PIN" dead end with no
   recovery path offered, while exact-length fail-closed routes to
   `LockedScreen` / `"pin-only"` with recovery. The only cost is one
   synthetic test fixture update (plus any assertions depending on its
   byte lengths); production rows are always 16/32 by construction, so
   only corrupt or tampered rows change routing — precisely the
   fail-closed target. This completes Batch 6's G1 direction.

**Fix-wave note (verification, not a finding).** The fix wave runs in
three commits, in order: commit 1 = H1+H4 (session tickers & sharing:
`session.ts`, `session.test.ts`, `App.tsx` notify channel); commit 2 =
H2+H9+D2(1) (hash validation & lock constants: `appLock.ts`,
`crypto.ts`, `appLock.test.ts`, `crypto.test.ts`); commit 3 =
H3+H5+H6+H8+H10+D1(1) (reset terminal & vault decrypt:
`ResetScreen.tsx`, `reset.ts`, `App.tsx`, `crypto.ts` H5 part,
`vault.ts`, `reset-gate.test.ts`, `submit-guards.test.ts`,
`session.ts` JSDoc, `crypto.test.ts`/`vault.test.ts` H5 tests).
Commits 2–3 share `crypto.ts` and commits 1 and 3 share `App.tsx`, so
they run in this order. Verification note: H6's Rust line citations in
the doc drifted slightly (`raise_reset()` takes no `?`; the store sits
inside the spawned closure) — the mechanism is exactly as described.
