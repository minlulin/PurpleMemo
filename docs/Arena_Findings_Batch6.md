# PurpleMemo Audit — Batch 6 Findings

- **Base commit:** `04bcbf7f485fbbc2f9dbde3e18dbc7ce9cf609f5` (`dev` HEAD, `v1.1.24`)
- **Audit branch:** `arena/9d1a8f81-purplememo`
- **Mode:** Audit-only (zero source edits, zero refactoring, zero version bumps)
- **Prior batches cross-checked (not re-reported):** `F1`–`F12` (`docs/Arena_Findings_261026.md`), `B1`–`B14` (`docs/Arena_Findings_Batch2.md`), `C1`–`C6` (`docs/Arena_Findings_Batch3.md`), `D1`–`D12` (`docs/Arena_Findings_Batch4.md`), `E1`–`E14` (`docs/Arena_Findings_Batch5.md`), plus settled design decisions (`B13` unmigrated pages including `ExportsPage`, Batch 5 `#5` `KEEP` raw diagnostic detail on local error alerts, `F7` journal export path, `F12` `pickerResults` total-match counting, and 1-based CSV data-row numbering in `docs/PurpleMemo_Import_Tasks.md`).

## Scope (7 files, 2,471 lines)

1. `src/components/LockScreens.tsx` (592 lines)
2. `src/components/icons.tsx` (527 lines)
3. `src/components/ImportDialog.tsx` (377 lines)
4. `src/components/GlobalSearchDialog.tsx` (295 lines)
5. `src/components/EntityPicker.tsx` (247 lines)
6. `src/components/NoteReaderDialog.tsx` (217 lines)
7. `src/pages/ExportsPage.tsx` (216 lines)

## Method

1. Read each of the 7 target files end-to-end in full without skipping, one at a time in the order listed above.
2. Read the direct imports, callers/rendering pages, shared modal/CSS primitives, and pinning test suites across seams: `src/App.tsx`, `src/components/Dialog.tsx`, `src/components/LinksSection.tsx`, `src/components/MarkdownLink.tsx`, `src/components/useTranslation.ts`, `src/data/app.ts`, `src/lib/appLock.ts`, `src/lib/crypto.ts`, `src/lib/settings.ts`, `src/lib/backup.ts`, `src/lib/csv.ts`, `src/lib/taskImport.ts`, `src/lib/contactImport.ts`, `src/lib/globalSearch.ts`, `src/lib/searchContract.ts`, `src/lib/entityPicker.ts`, `src/lib/entityLinks.ts`, `src/lib/noteReader.ts`, `src/lib/notes.ts`, `src/lib/exports.ts`, `src/lib/format.ts`, `src/lib/errors.ts`, `src/lib/i18n.ts`, `src/pages/SettingsPage.tsx`, `src/pages/ContactsPage.tsx`, `src/pages/TasksPage.tsx`, `src/pages/NotesPage.tsx`, `src/pages/MorePage.tsx`, `src/styles/app.css`, `docs/EXPORTS.md`, and `docs/PurpleMemo_Import_Tasks.md`.
3. Executed all relevant Node-runnable in-scope test suites and token lint directly on Node `v22.22.3`:
   ```sh
   node --test \
     src/lib/appLock.test.ts \
     src/lib/csv.test.ts \
     src/lib/taskImport.test.ts \
     src/lib/contactImport.test.ts \
     src/lib/globalSearch.test.ts \
     src/lib/entityPicker.test.ts \
     src/lib/noteReader.test.ts \
     src/lib/i18n.test.ts \
     src/pages/submit-guards.test.ts \
     src/pages/import-guard.test.ts \
     src/pages/delete-guards.test.ts \
     src/app-shortcuts.test.ts && node scripts/token-lint.mjs
   ```
   **Result:** `143/143` tests passed (`0` failures); `token-lint: OK — 154 file(s) scanned`.
   `src/lib/exports.test.ts` was inspected in full statically; it imports external package `fflate`, and `node_modules` is not installed in this clean sandbox checkout.

---

## Summary Table

| ID | Severity | File | Summary |
| :--- | :--- | :--- | :--- |
| **G1** | **Med-high** | `src/components/LockScreens.tsx` | Recovery `security_answer_hash` skips `classifyPin` / `MIN_PIN_HASH_ITERATIONS`, accepting weak PBKDF2 counts and throwing raw WebCrypto errors without retry throttling on malformed JSON |
| **G2** | **Med-high** | `src/components/EntityPicker.tsx` | Focus/ARIA combobox contract contradicted (`autoFocus` on `×` Close so `Enter` closes), `role="combobox"`/`role="listbox"` missing, and `ArrowDown` on an empty list sticks `active` at `-1` |
| **G3** | **Med** | `src/components/EntityPicker.tsx` | Missing ref submit guard in `choose()` + unblocked close while `busy` closes the dialog early on double-tap and drops post-close link rejections across the `LinksSection` seam |
| **G4** | **Med** | `src/components/LockScreens.tsx` | `unlockWithPin`/`resetPin` check neither `busy` nor a ref guard, hold `busy = true` across the 5s cooldown (making `"Wait…"` dead code), fire `onUnlock`/`onDone` unawaited, and allow mode switches that wipe cooldown errors |
| **G5** | **Med** | `ImportDialog.tsx`, `GlobalSearchDialog.tsx`, `NoteReaderDialog.tsx`, `EntityPicker.tsx` | Modal focus escape during `ImportDialog` `"running"` phase, missing initial focus in `ImportDialog`, clobbered `Dialog` `triggerRef` from inline `onClose` props, and explicit Close/Cancel/Done buttons bypassing focus restore |
| **G6** | **Med** | `src/pages/ExportsPage.tsx` | Primary export button adds `.btn-loading` (`color: transparent`) without `<IconSpinner />` — rendering completely blank while busy — and completion toast omits Finance row counts |
| **G7** | **Med** | `src/components/GlobalSearchDialog.tsx` | Result `<button role="option">` items stay in the `Tab` order (desyncing DOM focus from `activeIndex`/`aria-activedescendant`) and `<p>` / `<fieldset>` children violate `role="listbox"` ownership |
| **G8** | **Low-med** | `EntityPicker.tsx`, `GlobalSearchDialog.tsx` | Hardcoded `"Link to"` leaves translated `linkPicker.title` dead; misleading `linkPicker.empty` copy on search/error; raw English `createLink` error, raw `reason.message`, and unformatted `"MM-DD"` birthdays |
| **G9** | **Low-med** | `src/components/GlobalSearchDialog.tsx` | Punctuation-only queries bypass `isSearchable()` to flash `"Searching…"` / `"0 results"`, inverted `since > until` ranges run silently, and `"MM-DD"` contact birthdays compare lexicographically against `YYYY-MM-DD` filters |
| **G10** | **Low-med** | `src/components/ImportDialog.tsx` | `downloading` leaves file pick, `Import`, and `Cancel` active (allowing late template-save errors onto `"done"`), `pick()` lacks a synchronous ref guard, and `reading` leaves `<label className="btn btn-primary">` styled active |
| **G11** | **Low-med** | `src/components/LockScreens.tsx` | Cleartext recovery `draft` (`type="text"` answer + new PINs) survives `"Back"`, and blank recovery answers execute 600k-iteration PBKDF2 and consume retry attempts |
| **G12** | **Low-med** | `src/components/NoteReaderDialog.tsx` | `.note-reader-body` scroll offset leaks from one note to the next on Prev/Next navigation, boundary Prev/Next disable drops focus to `<body>`, and `tags.map` keys on un-deduplicated tag strings |
| **G13** | **Low** | `src/components/icons.tsx` | `IconInbox` arrow chevron points upward out of the tray (`(12, 4)`), contradicting its JSDoc (`"dropping into it"`) |
| **G14** | **Low** | `src/pages/ExportsPage.tsx` | `today` is captured before `await save(...)` while `exportedAt` is captured after, and `toggle()` leaves stale `"Choose at least one group to export."` alerts visible |

*(Two additional test-pinned items — silent group slicing/dropping at `SEARCH_TOTAL_CAP` in `GlobalSearchDialog` and English model strings rendered in `GlobalSearchDialog`/`EntityPicker` — are reported under **DECISION** below rather than as plain bugs.)*

---

## Findings

### G1 — `Med-high` — `LockScreen` recovery (`security_answer_hash`) bypasses `classifyPin` / `MIN_PIN_HASH_ITERATIONS`, accepting weak PBKDF2 counts and throwing raw errors without retry throttling on malformed JSON

- **File:** `src/components/LockScreens.tsx:250, 371-412, 473-476`
- **Seam files:** `src/App.tsx:439-440, 718-722`, `src/lib/appLock.ts:55-68, 123-159, 277-280`, `src/lib/crypto.ts:86-119`, `src/lib/backup.ts:148`

**Evidence:**
- `src/App.tsx:439-440` loads `pin_hash` as raw text for `classifyPin(pinRaw)` (`appLock.ts:144-159`, which enforces `isPinHashShape` and `parsed.iterations >= MIN_PIN_HASH_ITERATIONS` = `100_000`), but loads `security_answer_hash` directly via `settingsRepo.getJSON<PinHash>(SETTING_KEYS.securityAnswerHash)` — an unvalidated `JSON.parse` (`settings.ts:17-25`) that collapses corrupt JSON to `null` and passes any valid JSON value (`{}`, `42`, `{ iterations: 1, ... }`) straight through as `PinHash`:
  ```ts
  // src/App.tsx:439-440
  settingsRepo.getRaw(SETTING_KEYS.pinHash),
  settingsRepo.getJSON<PinHash>(SETTING_KEYS.securityAnswerHash),
  ```
- `src/lib/appLock.ts:55-68` (`pinResetBlocked`) checks only `input.answerHash === null || input.answerHash === undefined`, and `src/components/LockScreens.tsx:397-409` hands `answerHash` straight to `verifyAnswer(draft.answer, answerHash)` -> `verifyPin(..., stored)` (`crypto.ts:107-119`):
  ```ts
  // src/components/LockScreens.tsx:397-409
  if (!(await verifyAnswer(draft.answer, answerHash))) {
    setError(t("lock.error.wrongAnswer"));
    await noteFailure();
    return;
  }
  await settingsRepo.setManyJSON([
    { key: SETTING_KEYS.pinHash, value: await hashPin(draft.pin) },
  ]);
  ...
  } catch (e) {
    setError(errText(e));
  }
  ```
- Note that backup restore (`src/lib/backup.ts:148`) writes archived `settings` rows — including `security_answer_hash` — into SQLite.

**What is wrong:**
`SECURITY_TRUST_ROOT_KEYS` (`appLock.ts:277-280`) explicitly names both `"pin_hash"` and `"security_answer_hash"` as the lock screen's trust root, and `resetPin` overwrites `pin_hash` (`LockScreens.tsx:402-404`). Yet `security_answer_hash` receives none of `classifyPin`'s shape or iteration-floor validation:
1. **PBKDF2 iteration downgrade on the PIN-replacement path:** A row with `iterations: 1` (e.g. from a crafted backup or tampered row) is honoured by `verifyPin` (`crypto.ts:80, 114`), whereas `classifyPin` rejects `pin_hash` below `MIN_PIN_HASH_ITERATIONS` (`100_000`) for that exact reason (`appLock.ts:117-123`).
2. **Malformed JSON bypasses both localization and `noteFailure()`:** If `security_answer_hash` parses to `42`, `{}`, `{ salt: "***", hash: "x", iterations: 600000 }`, or `{ ..., iterations: 0 }`, `LockScreen` still offers `"Forgot PIN?"` (`LockScreens.tsx:473`), and submitting throws inside `atob` or `crypto.subtle.deriveBits` (`InvalidCharacterError` / `OperationError` / `TypeError`). Execution jumps over `await noteFailure()` (`:399`) into `catch` (`:407-409`), rendering raw runtime exception text instead of a localized `lock.error.*` / `lock.unreadable.*` message and never incrementing `failuresRef`.

**User impact:**
A downgraded `security_answer_hash` weakens the recovery secret that can replace the workspace PIN; a malformed `security_answer_hash` advertises PIN recovery as available and then fails with a raw browser/WebCrypto error in both English and Burmese without engaging the retry throttle.

**Fix direction:**
Load `security_answer_hash` with `settingsRepo.getRaw` and classify it through `classifyPin` (or a shared `classifyPinHash` helper enforcing `isPinHashShape` and `iterations >= MIN_PIN_HASH_ITERATIONS`). Treat `"absent"` and `"unreadable"` as unavailable for recovery (`answerHash = null`, or surface a localized unreadable-recovery message in `LockScreen`) and enforce `isPinHashShape` + `MIN_PIN_HASH_ITERATIONS` inside `pinResetBlocked` so every caller fails closed.

---

### G2 — `Med-high` — `EntityPicker` contradicts its own keyboard/focus contract (`autoFocus` on `×` Close instead of Search), omits required `combobox`/`listbox` ARIA roles, and traps `ArrowDown` on an empty list at `active = -1`

- **File:** `src/components/EntityPicker.tsx:6-9, 91-93, 119-129, 134-158, 179-219`

**Evidence:**
```tsx
// src/components/EntityPicker.tsx:6-9
// Keyboard: the search box keeps focus, Up/Down move the active row, Enter
// links it, Escape closes. That is the combobox pattern — focus in the field,
// `aria-activedescendant` pointing at the active option — so a screen reader
// reads the highlighted row as the user arrows through.
```
```tsx
// src/components/EntityPicker.tsx:91-93
useEffect(() => {
  setActive((current) => (current < hits.length ? current : 0));
}, [hits.length]);
```
```tsx
// src/components/EntityPicker.tsx:119-158
<button
  type="button"
  className="btn btn-icon"
  aria-label={t("linkPicker.close")}
  title={t("common.close")}
  // biome-ignore lint/a11y/noAutofocus: the dialog's first stop
  autoFocus
  onClick={p.onClose}
>
  ×
</button>
...
<input
  className="input"
  type="search"
  aria-label={t("linkPicker.searchAria")}
  aria-controls="link-picker-list"
  aria-activedescendant={
    hits[active] === undefined
      ? undefined
      : `link-option-${hits[active].entity.type}-${hits[active].entity.id}`
  }
  ...
  onKeyDown={(e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((n) => Math.min(n + 1, hits.length - 1));
    } ...
```
```tsx
// src/components/EntityPicker.tsx:179-203
<ul
  className="budget-list"
  id="link-picker-list"
  aria-label={t("linkPicker.listAria")}
  ref={listRef}
>
  {hits.map((hit, index) => (
    <li key={`${hit.entity.type}-${hit.entity.id}`} className="budget-row">
      <button
        type="button"
        role="option"
        id={`link-option-${hit.entity.type}-${hit.entity.id}`}
        aria-selected={index === active}
        ...
```

**What is wrong:**
Three defects break `EntityPicker`'s documented combobox/listbox interaction:
1. **`autoFocus` is on the Close button, contradicting lines `6-9`:** Opening `"Link to…"` focuses `×` (`:125`), not `<input type="search">` (`:134`). Typing a query immediately after opening enters nothing, `ArrowDown` does nothing, and pressing `Enter` activates `×` and **closes the dialog** instead of linking the highlighted item.
2. **Broken ARIA combobox/listbox ownership and Tab-stop desync:** `<input>` (`:134-143`) sets `aria-controls="link-picker-list"` and `aria-activedescendant` without `role="combobox"` or `aria-expanded` (and when `loading` or `hits.length === 0`, `#link-picker-list` is not in the DOM at all, leaving `aria-controls` dangling). Conversely, `<ul id="link-picker-list">` (`:179-184`) has no `role="listbox"` (and `<li>` at `:186` has no `role="presentation"`), leaving `<button role="option">` (`:196`) orphaned outside any `listbox` despite comment `:190-193`. Those `<button>` options also omit `tabIndex={-1}`, putting up to 50 options into the `Tab` ring.
3. **`active` sticks at `-1` after `ArrowDown` on an empty/loading list:** Pressing `ArrowDown` while `loading` is `true` or `hits.length === 0` evaluates `Math.min(0 + 1, 0 - 1) = -1` (`:149`). When rows finish loading (or the user clears a zero-match query so `hits.length > 0`), the clamp effect `(current < hits.length ? current : 0)` (`:92`) evaluates `-1 < hits.length` as `true` and keeps `active === -1`. No row receives `.is-on`, `hits[-1]` is `undefined`, and pressing `Enter` (`:155`) silently no-ops.

**User impact:**
Keyboard users who open `"Link to…"` and start typing or press `Enter` either type into thin air or dismiss the modal; pressing `ArrowDown` during load or on a no-match query leaves the picker with no active row even after matches appear; assistive technologies encounter invalid `aria-activedescendant` / orphaned `role="option"` markup.

**Fix direction:**
Move initial focus (`autoFocus` or `requestAnimationFrame(() => inputRef.current?.focus())`) to the search `<input>`; add `role="combobox"`, `aria-autocomplete="list"`, and `aria-expanded={hits.length > 0}` on `<input>` (only setting `aria-controls` when the listbox is rendered, or keeping the listbox element mounted); add `role="listbox"` on `<ul>`, `role="presentation"` on `<li>`, and `tabIndex={-1}` on `<button role="option">`; guard `ArrowDown` when `hits.length === 0` and clamp `(current >= 0 && current < hits.length ? current : 0)` in the `hits.length` effect.

---

### G3 — `Med` — `EntityPicker` lacks a synchronous submit guard and allows closing mid-link, causing double-tap to close early and dropping post-close link rejections

- **File:** `src/components/EntityPicker.tsx:47, 100-111, 114, 119-129`
- **Seam file:** `src/components/LinksSection.tsx:78-94, 165-172`

**Evidence:**
```tsx
// src/components/EntityPicker.tsx:100-115
const choose = async (hit: PickerHit | undefined) => {
  if (!hit || busy) return;
  setBusy(true);
  setError(null);
  try {
    await p.onPick(hit.entity);
    p.onClose();
  } catch (e) {
    setError(errText(e));
    setBusy(false);
  }
};

return (
  <Dialog labelledBy="link-picker-title" onClose={p.onClose}>
```
```tsx
// src/components/LinksSection.tsx:79-94
const link = async (target: LinkableEntity) => {
  if (busyRef.current) return;
  busyRef.current = true;
  setBusy(true);
  setError(null);
  try {
    const result = await entityLinksRepo.createLink(p.entity, target);
    if (result.alreadyLinked) {
      setError(t("links.alreadyLinked"));
    }
    await reload();
  } finally {
    busyRef.current = false;
    setBusy(false);
  }
};
```

**What is wrong:**
1. **Double-Enter / double-click race across the `LinksSection.link` seam:** `EntityPicker.choose` (`:101`) checks only React state `busy` (`useState(false)` at `:47`), with no synchronous `useRef` guard. Pressing `Enter` twice rapidly in the search input (or double-clicking an option button before React commits `setBusy(true)`) invokes `choose` twice:
   - Call 1 enters `LinksSection.link`, sets `LinksSection`'s `busyRef.current = true`, and awaits `entityLinksRepo.createLink(...)` + `reload()`.
   - Call 2 enters `LinksSection.link`, hits `if (busyRef.current) return;` (`LinksSection.tsx:80`), resolves `undefined` **immediately**, and runs `p.onClose()` (`EntityPicker.tsx:106`) — unmounting `EntityPicker` while Call 1's database write is still in flight.
2. **Unblocked dismissal while `busy` + swallowed/unhandled failure:** Neither `<Dialog onClose={p.onClose}>` (`:114`, no `locked={busy}`) nor the `×` Close button (`:119-129`, no `disabled={busy}`) blocks closing while `busy` is `true` (and the search `<input>` and `includeInactive` checkbox at `:134-167` stay enabled as well). Because `LinksSection.link` (`LinksSection.tsx:79-94`) deliberately has no `catch` block (delegating error display to `EntityPicker.choose` at `:107-110`), if `createLink` or `reload` rejects after `EntityPicker` has already closed (via the double-tap race or `Escape`/backdrop/`×`), `EntityPicker`'s `setError(errText(e))` fires on an unmounted component and `LinksSection` displays no error at all.

**User impact:**
A fast double-`Enter` or double-click dismisses the picker before `createLink` finishes; if the write fails (e.g. target concurrently deleted or SQLite busy/error), the failure is silently lost with neither dialog alert nor section error.

**Fix direction:**
Add a synchronous `choosingRef = useRef(false)` guard in `EntityPicker.choose` (cleared in `finally`), pass `locked={busy}` to `<Dialog>`, and disable `×`, the search `<input>`, and the `includeInactive` checkbox while `busy` is `true`.

---

### G4 — `Med` — `LockScreen` omits `busy` and ref guards in `unlockWithPin`/`resetPin`, holds `busy = true` across the 5-second cooldown (making `"Wait…"` dead code), fires async `onUnlock`/`onDone` unawaited, and allows mode switches that wipe cooldown errors

- **File:** `src/components/LockScreens.tsx:102-124, 327-412, 457-485, 565-588`
- **Seam files:** `src/App.tsx:517-525, 711, 721`, `src/pages/submit-guards.test.ts:555-561`

**Evidence:**
```tsx
// src/components/LockScreens.tsx:327-369
const noteFailure = async () => {
  const next = failuresRef.current + 1;
  failuresRef.current = next;
  setShaking(true);
  const waitMs = lockRetryDelayMs(next);
  if (waitMs > 0) {
    setCooling(true);
    setError(
      t("lock.error.tooMany", { seconds: LOCK_RETRY_DELAY_MS / 1000 }),
    );
    await new Promise((r) => setTimeout(r, waitMs));
    // A success cannot land while cooling (both submitters return early),
    // so unconditionally clearing here never wipes a newer state.
    setCooling(false);
    setError(null);
  }
};

const unlockWithPin = async () => {
  if (cooling) return;
  ...
  setBusy(true);
  try {
    if (await verifyPin(pin, p.pinHash)) {
      failuresRef.current = 0;
      p.onUnlock();
    } else {
      setError(t("lock.error.wrongPin"));
      setPin("");
      await noteFailure();
    }
  } catch (e) {
    setError(errText(e));
  } finally {
    setBusy(false);
  }
};
```
```tsx
// src/components/LockScreens.tsx:462-466 (and :570-574)
{busy
  ? t("common.checking")
  : cooling
    ? t("common.wait")
    : t("lock.unlock")}
```

**What is wrong:**
1. **No `submittingRef` AND no `if (busy) return;` on `unlockWithPin` (`:345`) or `resetPin` (`:371`):** Unlike `SetupScreen.submit` (`:102`, pinned in `submit-guards.test.ts:555-561`), neither `LockScreen` handler checks a ref or even `busy` — only `if (cooling) return;` (React state). Rapid `Enter` presses before commit launch concurrent 600,000-iteration PBKDF2 derivations (`verifyPin` / `verifyAnswer` + `hashPin` + `settingsRepo.setManyJSON` at `:397-404`). If two concurrent wrong attempts cross `FREE_LOCK_ATTEMPTS`, both enter `noteFailure()`: the first timer's wakeup at `:340-341` clears `cooling` and `error` (and its `finally` clears `busy`) before the second attempt's 5-second penalty has elapsed, contradicting the comment at `:338-339`.
2. **`t("common.wait")` (`"Wait…"`) is unreachable dead UI on both submit buttons (`:462-466`, `:570-574`):** Because `await noteFailure()` is awaited *inside* `try` (`:362`, `:399`) before `finally { setBusy(false); }` (`:367`, `:410`), `busy` remains `true` for the entire 5-second `setTimeout` inside `noteFailure()`. In `{busy ? t("common.checking") : cooling ? t("common.wait") : ...}`, `busy` always wins over `cooling`, so both buttons display `"Checking…"` throughout the 5-second lockout pause and never show `"Wait…"`.
3. **Mode-switch buttons (`"Forgot PIN?"` at `:470-484` and `"Back"` at `:576-587`) are not disabled during `busy || cooling`:** Clicking either button mid-cooldown switches forms and calls `setError(null)` (`:478`, `:581`), erasing the `"Too many wrong attempts — wait 5s"` alert while the form's submit button stays disabled for up to 5 seconds with no explanation. Conversely, if `"Forgot PIN?"` sets `t("lock.error.noAnswer")` (`:474`) while a cooldown timer is running, `noteFailure()`'s wakeup (`:341`) wipes that newer error.
4. **`onDone()` (`:117`) and `onUnlock()` (`:358`, `:406`) fire async `enterWorkspace()` without awaiting (`App.tsx:517-525, 711, 721`):** Both callbacks invoke `void enterWorkspace()`, which asynchronously runs `await loadSecurity()` before `setUnlocked(true)`. `SetupScreen` leaves `busy === true` on success (so if `loadSecurity()` fails and `reloadOpensEntry(reload)` returns `false` before `securityReloadError` renders, or if `SetupScreen` stayed mounted, `busy` was never reset), whereas `LockScreen`'s `finally` immediately sets `busy = false` while `loadSecurity()` is still in flight.

**User impact:**
During the 5-second retry throttle, the lock button misleadingly says `"Checking…"` instead of `"Wait…"`; switching between PIN and Forgot-PIN mid-cooldown leaves a disabled submit button with no visible error message; double-submitting before re-render runs duplicate 600k-iteration PBKDF2 derivations and desynchronizes cooldown timers.

**Fix direction:**
Guard `unlockWithPin` and `resetPin` with a shared `submittingRef` (plus a `coolingUntilRef` / cleared timeout ref on unmount), clear `busy` *before* awaiting the cooldown sleep so `cooling ? t("common.wait")` actually renders, disable `"Forgot PIN?"` and `"Back"` while `busy || cooling`, and type `onDone` / `onUnlock` as `() => Promise<void> | void` and `await` them inside `try`/`finally`.

---

### G5 — `Med` — Modal focus management breaks across `ImportDialog`, `GlobalSearchDialog`, `NoteReaderDialog`, and `EntityPicker` (focus escape during `ImportDialog` `"running"`, missing initial focus, clobbered `triggerRef`, and bypassed focus restore)

- **Files:** `src/components/ImportDialog.tsx:109-111, 185-187, 204-208, 228-246, 332-357, 369-371`, `src/components/GlobalSearchDialog.tsx:57-60, 129-147`, `src/components/NoteReaderDialog.tsx:5-6, 121-125, 157-167, 210-212`, `src/components/EntityPicker.tsx:114, 119-129`
- **Seam files:** `src/components/Dialog.tsx:34-81`, `src/App.tsx:1004-1007`, `src/pages/NotesPage.tsx:558-563, 1176-1185`

**Evidence:**
```tsx
// src/components/Dialog.tsx:34-44, 53-58, 81
const close = useCallback(() => {
  if (locked) return;
  onClose();
  triggerRef.current?.focus();
}, [locked, onClose]);

useEffect(() => {
  triggerRef.current =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  ...
    const stops = Array.from(
      dialog.querySelectorAll<HTMLElement>(FOCUSABLE),
    ).filter((el) => !el.hasAttribute("disabled"));
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) return;
  ...
}, [close]);
```
```tsx
// src/components/ImportDialog.tsx:109-111, 204-207, 335, 344, 352
const close = () => {
  if (phase !== "running") onClose();
};
...
<Dialog labelledBy="import-dialog-title" onClose={close} className="import-dialog">
```

**What is wrong:**
1. **`Tab` escapes `ImportDialog` into the background app during `phase === "running"` (`ImportDialog.tsx:186, 335, 344, 352` + `Dialog.tsx:53-58`):** When the user confirms an import, every button in `ImportDialog` (`Choose another file`, `Download template CSV`, `Cancel`, `Import`) becomes `disabled`. `Dialog`'s Tab handler computes `stops = []` and hits `if (!first || !last) return;` **without calling `e.preventDefault()`**, allowing `Tab` / `Shift+Tab` to walk straight out of the `aria-modal="true"` dialog into the underlying sidebar and page buttons while the SQLite batch is running.
2. **`ImportDialog` sets no initial focus (`ImportDialog.tsx:221-246`):** No control inside `ImportDialog` carries `autoFocus` or a mount `.focus()` call, so opening CSV Import leaves `document.activeElement` outside the modal on the page's `"Import CSV"` button until the user presses `Tab`.
3. **Inline `onClose` callbacks re-run `Dialog`'s `[close]` effect and overwrite `triggerRef.current` (`ImportDialog.tsx:109, 206`, `App.tsx:1005`, `NotesPage.tsx:1183`):** `Dialog` captures `triggerRef.current = document.activeElement` inside `useEffect(..., [close])` (`Dialog.tsx:39-43, 81`), where `close` depends on `onClose`.
   - `ImportDialog` creates a fresh `const close = () => ...` on every render (`:109`), so picking a file (`setReading` / `setPhase("preview")`) overwrites `triggerRef.current` with an element inside `ImportDialog`.
   - `NotesPage` passes `onClose={() => setReaderOpen(false)}` (`NotesPage.tsx:1183`); even opening `NoteReaderDialog` by double-clicking a note card asynchronously resolves `notesRepo.getNote(selectedId)` (`NotesPage.tsx:558-563`), re-rendering `NotesPage` *after* `NoteReaderDialog`'s `autoFocus` moved focus to `IconClose` (`NoteReaderDialog.tsx:163`), overwriting `triggerRef.current` with `NoteReaderDialog`'s own Close button (and likewise on every Next/Prev note step or Copy click).
   - `App.tsx:1005` passes `onClose={() => setSearchOpen(false)}` to `GlobalSearchDialog`, overwriting `triggerRef.current` with the search `<input>` (`GlobalSearchDialog.tsx:58`) if `AppShell` re-renders while search is open.
4. **Explicit Close / Cancel / Done buttons bypass `Dialog`'s focus restoration in all four dialogs:** `ImportDialog` (`:244, 345, 369`), `GlobalSearchDialog` (`:143`), `EntityPicker` (`:126`), and `NoteReaderDialog` (`:164, 210`) all wire `onClick={onClose}` directly instead of routing through `Dialog`'s `triggerRef.current?.focus()` path, leaving `document.activeElement` on `<body>` whenever closed by button click.

**User impact:**
Keyboard users can Tab out of `ImportDialog` into background controls mid-import, start outside `ImportDialog` when it opens, and lose their keyboard position back to `<body>` whenever closing `ImportDialog`, `GlobalSearchDialog`, `EntityPicker`, or `NoteReaderDialog` (contradicting `NoteReaderDialog.tsx:5-6`).

**Fix direction:**
In `ImportDialog`, pass `locked={phase === "running"}` to `<Dialog>`, focus the primary control on mount, and keep focus inside the dialog (`tabIndex={-1}` container focus + `e.preventDefault()` in `Dialog` when `stops.length === 0`); in `Dialog`, capture `triggerRef.current` once on mount (`[]`) and restore focus in mount-effect cleanup so every close path (`Escape`, backdrop, `×`, `Cancel`, `Done`) restores the opener reliably.

---

### G6 — `Med` — `ExportsPage` applies `.btn-loading` (`color: transparent`) without `<IconSpinner />` — turning the primary button completely blank while busy — and omits Finance counts from the completion toast

- **File:** `src/pages/ExportsPage.tsx:83-102, 169-176`
- **Seam files:** `src/styles/app.css:296-310`, `src/lib/exports.ts:105-115, 767-771`, `src/pages/SettingsPage.tsx:1098-1104`

**Evidence:**
```tsx
// src/pages/ExportsPage.tsx:99-102, 169-176
await exportsRepo.save(path, bytes);
toast.success(
  `Readable export saved to ${path} - ${fileCount} files (${counts.notes} notes, ${counts.journal} journal entries, ${counts.tasks} tasks, ${counts.contacts} contacts).`,
);
...
<button
  type="button"
  className={`btn btn-primary${busy ? " btn-loading" : ""}`}
  disabled={busy}
  onClick={() => void doExport()}
>
  {busy ? "Building archive..." : "Export readable ZIP"}
</button>
```
```css
/* src/styles/app.css:296-310 */
/* Swap the label for a spinner without changing the button's footprint. */
.btn-loading {
  color: transparent;
  pointer-events: none;
  position: relative;
}
.btn-loading .icon-spin { ... }
```

**What is wrong:**
1. **Blank purple button throughout the entire export flow:** `.btn-loading` in `app.css:297-298` sets `color: transparent` specifically so `<IconSpinner />` (`.icon-spin`) replaces the text visually without resizing the button (as every `.btn-loading` button in `SettingsPage.tsx:1103, 1144, 1178, 1269, 1307` does). `ExportsPage.tsx` adds `btn-loading` when `busy` is `true` (`:171`) **without importing or rendering `<IconSpinner />`**. As a result, `"Building archive..."` (`:175`) is rendered in `color: transparent` and no spinner exists — the button becomes an empty solid-purple rectangle from the moment the save dialog opens until the ZIP write finishes.
2. **Completion toast omits Finance (`ExportsPage.tsx:100-102` vs `exports.ts:105-115, 767-771`):** `ExportsPage` offers five export groups (`notes`, `journal`, `finance`, `tasks`, `contacts`), and `exportsRepo.build` returns `counts.income`, `counts.expenses`, `counts.loans`, `counts.jobs`, and `counts.payables`. The success toast formats only four groups and ignores all five finance counters. Exporting **Finance CSV** alone announces e.g. `7 files (0 notes, 0 journal entries, 0 tasks, 0 contacts)` even when hundreds of finance rows were written.

**User impact:**
Clicking `"Export readable ZIP"` blanks out the primary action button with neither text nor spinner while the OS file dialog and ZIP build run; exporting Finance data produces a success toast claiming `0` items across every listed category.

**Fix direction:**
Render `{busy && <IconSpinner />}` inside the export `<button>` (matching `SettingsPage.tsx`), and include the finance row count (e.g. `${counts.income + counts.expenses + counts.loans + counts.jobs + counts.payables} finance rows`) in the `toast.success` summary.

---

### G7 — `Med` — `GlobalSearchDialog` leaves up to 40 result `<button role="option">` items in the `Tab` order and nests `<fieldset>` / `<p>` inside `role="listbox"`

- **File:** `src/components/GlobalSearchDialog.tsx:152-180, 242-292`

**Evidence:**
```tsx
// src/components/GlobalSearchDialog.tsx:152-166
<input
  ref={inputRef}
  className="input"
  type="search"
  role="combobox"
  aria-autocomplete="list"
  aria-expanded={results.length > 0}
  value={query}
  placeholder={t("search.placeholder")}
  aria-controls="global-search-results"
  aria-activedescendant={
    results.length > 0 ? `global-search-result-${activeIndex}` : undefined
  }
```
```tsx
// src/components/GlobalSearchDialog.tsx:242-292
<div
  className="global-search-results"
  id="global-search-results"
  role="listbox"
  aria-label={t("search.resultsAria")}
>
  {groups.map((group) => (
    <fieldset className="global-search-group" key={group.type}>
      <legend>...</legend>
      {group.results.map((result) => {
        ...
        return (
          <button
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            ...
          >
  ...
  {!loading && !error && query.trim() && count === 0 ? (
    <p className="muted">{t("search.noMatches")}</p>
  ) : null}
</div>
```

**What is wrong:**
1. **Focus / `activeIndex` desynchronization via `Tab`:** `GlobalSearchDialog` implements the `aria-activedescendant` combobox pattern where keyboard selection is managed from `<input>` (`:168-179`), yet each `<button type="button" role="option">` (`:263-276`) omits `tabIndex={-1}`. Pressing `Tab` past the filter bar walks through up to 40 individual result buttons before wrapping back to Close. Moving focus onto result `#k` via `Tab` does not update `activeIndex` (`onMouseMove` at `:274` only fires on pointer movement), leaving `.is-active` and `aria-activedescendant` pointing at `#0` while pressing `Enter` activates focused `#k` — and pressing `ArrowDown` / `ArrowUp` while a result button is focused does nothing because the arrow handler lives only on `<input>`.
2. **Invalid `role="listbox"` child roles:** ARIA requires `role="listbox"` children to be `option` elements or `role="group"` containers (`aria-labelledby`). Here, `div[role="listbox"]` (`:242-247`) directly wraps native `<fieldset>` + `<legend>` elements (`:249-253`, implicit `group` role with `<legend>` instead of `option` ownership in several screen readers) and, when `count === 0`, renders `<p className="muted">{t("search.noMatches")}</p>` (`:290`) directly inside `role="listbox"`.

**User impact:**
Tabbing to reach Close or filters gets bogged down in 40 result stops where visual highlight (`is-active`) and `Enter` target different items, and screen readers encounter non-option `<p>` content inside `role="listbox"`.

**Fix direction:**
Add `tabIndex={-1}` on `<button role="option">` so `Tab` moves cleanly between Close, the combobox input, and the filter controls while `ArrowUp`/`ArrowDown` manage `activeIndex`; move `<p>{t("search.noMatches")}</p>` outside `div[role="listbox"]`; and use `<div role="group" aria-labelledby={groupHeadingId}>` for grouped options inside the listbox.

---

### G8 — `Low-med` — Localization and formatting leaks in `EntityPicker` and `GlobalSearchDialog`: hardcoded `"Link to"` title, misleading `linkPicker.empty` copy on search/error, raw English `createLink` error, raw `reason.message`, and unformatted `"MM-DD"` birthdays

- **Files:** `src/components/EntityPicker.tsx:107-109, 116-118, 173-177`, `src/components/GlobalSearchDialog.tsx:93-97, 256-261`
- **Seam files:** `src/lib/i18n.ts:515, 520-521, 1179, 1184-1185`, `src/lib/entityLinks.ts:238, 251`, `src/lib/format.ts:20-26`, `src/lib/errors.ts:6-18`

**Evidence:**
```tsx
// src/components/EntityPicker.tsx:116-118, 173-177
<h2 className="side-heading" id="link-picker-title">
  Link to
</h2>
...
{loading ? (
  <SkeletonRows />
) : hits.length === 0 ? (
  <p className="muted">{t("linkPicker.empty")}</p>
) : (
```
```ts
// src/lib/i18n.ts:515, 520-521, 1179
"linkPicker.title": "Link to",
"linkPicker.empty":
  "Nothing to link here. A note, task or contact has to exist first.",
// Burmese:
"linkPicker.title": "ချိတ်ဆက်မည့်အရာ",
```
```tsx
// src/components/GlobalSearchDialog.tsx:93-97, 256-259
.catch((reason: unknown) => {
  if (cancelled) return;
  setGroups([]);
  setError(reason instanceof Error ? reason.message : String(reason));
})
...
const details = [
  result.state,
  result.date ? formatDate(locale, result.date) : undefined,
]
```

**What is wrong:**
Both `EntityPicker` and `GlobalSearchDialog` are localized components (`useT()`, `useLocale()`) mounted inside localized shells/pages (`AppShell`, `NotesPage`, `TasksPage`, `ContactsPage`):
1. **Hardcoded `"Link to"` heading leaves `linkPicker.title` unused (`EntityPicker.tsx:116-118`):** `"linkPicker.title"` is already translated in both `en` (`i18n.ts:515`) and `my` (`i18n.ts:1179`), yet `EntityPicker.tsx:117` hardcodes `"Link to"` (leaving `linkPicker.title` with zero callers in `src/`). Also note `:128` renders raw `"×"` text instead of `<IconClose className="icon" />` used by every sibling dialog (`GlobalSearchDialog.tsx:145`, `NoteReaderDialog.tsx:166`, `App.tsx:1028`).
2. **Misleading `linkPicker.empty` message on search miss, already-linked filtering, or load error (`EntityPicker.tsx:175-177`):** Whenever `hits.length === 0` — including when `error !== null` (the initial DB read threw at `:69-71`!), when a user's `query` matches nothing, or when existing items are simply already linked or archived/done — `EntityPicker` renders `"Nothing to link here. A note, task or contact has to exist first."`, asserting no records exist in the workspace even when dozens exist (or when loading failed; compare `B12`).
3. **Raw English error from `entityLinksRepo.createLink` (`EntityPicker.tsx:107-109` + `entityLinks.ts:238, 251`):** If the target or source item was deleted before linking completes, `entityLinks.ts:238, 251` throws plain `new Error("That item no longer exists, so nothing was linked.")` rather than a `MessageKeyError` (unlike `csv.ts`, `taskImport.ts`, `contactImport.ts`, and `inbox.ts` after `D11`), surfacing raw English inside localized `EntityPicker` in Burmese mode.
4. **Raw `String(reason)` error formatting and unformatted `"MM-DD"` contact birthdays in `GlobalSearchDialog` (`GlobalSearchDialog.tsx:96, 258`):**
   - `:96` formats rejections with `reason instanceof Error ? reason.message : String(reason)` instead of `errText(reason)` (`errors.ts:6-18`), turning plain-object rejections into `"[object Object]"`.
   - `:258` passes `result.date` (`contacts.birthday` for contact hits, `searchContract.ts:116`) to `formatDate(locale, result.date)`. `formatDate` (`format.ts:20-26`) only parses `^\d{4}-\d{2}-\d{2}`, so month-day birthdays (`"MM-DD"`, e.g. `"10-20"`) render raw as `"10-20"` in both English and Burmese instead of localized month-day text (`birthdayLabel` in `contacts.ts`).

*(Test-pinned English strings in `SearchResult.state` and `PickerHit` are reported separately in **DECISION 2** below.)*

**User impact:**
Burmese users see an English `"Link to"` dialog title and English missing-target errors; users whose search query matches no linkable item (or whose DB read failed) are falsely told they have created no notes, tasks, or contacts; month-day contact birthdays render as raw `"MM-DD"` digits in global search.

**Fix direction:**
Render `{t("linkPicker.title")}` and `<IconClose className="icon" />` in `EntityPicker.tsx:117, 128`; suppress the empty state when `error !== null` and use a filter-miss message (e.g. `search.noMatches` / dedicated `linkPicker.noMatches`) when `notes.length + tasks.length + contacts.length > 0`; attach a `MessageKeyError` in `entityLinks.ts` and read `isMessageKeyError` in `EntityPicker.choose`; use `errText(reason)` at `GlobalSearchDialog.tsx:96` and format `"MM-DD"` dates via a month-day formatter when `result.type === "contact"`.

---

### G9 — `Low-med` — `GlobalSearchDialog` triggers `"Searching…"` / `"0 results"` on punctuation-only input, runs inverted `since > until` date ranges silently, and compares `"MM-DD"` contact birthdays lexicographically against `YYYY-MM-DD` bounds

- **File:** `src/components/GlobalSearchDialog.tsx:65-86, 202-219, 230-236, 289-291`
- **Seam files:** `src/lib/searchContract.ts:116, 281-295`, `src/lib/globalSearch.ts:138-149, 234-240`

**Evidence:**
```tsx
// src/components/GlobalSearchDialog.tsx:65-73, 230-235, 289-291
useEffect(() => {
  const term = query.trim();
  if (term.length === 0) {
    ...
    return;
  }
...
<div className="global-search-status" aria-live="polite">
  {loading
    ? t("search.searching")
    : query.trim() && !error
      ? plural("search.results", count)
      : ""}
</div>
...
{!loading && !error && query.trim() && count === 0 ? (
  <p className="muted">{t("search.noMatches")}</p>
) : null}
```
```ts
// src/lib/searchContract.ts:281-289
/**
 * Is this input worth searching at all?
 *
 * Punctuation-only input returns false rather than searching for nothing:
 * `"` and `-` are legitimate characters in the FTS expression builder, and a
 * search box that briefly shows an error for them is worse than one that waits.
 */
export function isSearchable(input: string): boolean {
  return normalizeTerm(input).replace(/[^\p{L}\p{N}]/gu, "").length > 0;
}
```

**What is wrong:**
1. **Punctuation-only input flashes `"Searching…"` then `"0 results"` / `"No matches."`:** `globalSearch` (`globalSearch.ts:239`) immediately returns `[]` when `!isSearchable(input)` (e.g. `"-"`, `"..."`, `'"'`, `"()"`), because non-alphanumeric punctuation is stripped before searching. However, `GlobalSearchDialog.tsx:66, 233, 289` gates idle vs active state on `query.trim()` rather than `isSearchable(query)`. Typing `"..."` or `'"'` sets `loading = true` (`"Searching…"`), waits `SEARCH_DEBOUNCE_MS` (`150ms`), receives `[]` without touching SQLite, and announces `"0 results"` + `"No matches."` as if the database was searched and contained no match.
2. **Inverted `From` / `Through` date range (`GlobalSearchDialog.tsx:202-219`):** Neither `<input type="date">` sets `max={until || undefined}` or `min={since || undefined}`, and `GlobalSearchDialog` shows no hint or guard when `since > until`. Setting `From: 2026-11-01` and `Through: 2026-10-01` executes impossible SQL `col >= '2026-11-01' AND col <= '2026-10-01'` queries across all dated entities and reports `"0 results"` / `"No matches."`.
3. **Month-day `"MM-DD"` contact birthdays break lexical SQL date filtering (`GlobalSearchDialog.tsx:83-84` + `searchContract.ts:116` + `globalSearch.ts:138-149`):** `contacts` declares `date: "birthday"`, which stores yearless birthdays as `"MM-DD"` (`"01-01"`..`"12-31"`). Because `"0"`/`"1"` sort before `"2"` (`"10-20" < "2026-01-01"`), setting **any** `From` date excludes every yearless contact birthday, while setting **only** `Through` (e.g. `2026-05-01`) includes every `"MM-DD"` contact birthday unconditionally (`"12-31" <= "2026-05-01"` is `true`).

**User impact:**
Typing quotes or hyphens shows a bogus `"0 results / No matches."` state without running a search; accidentally inverted date bounds look like missing data; date-filtered searches silently misclassify every contact stored with a month-day birthday.

**Fix direction:**
Gate idle state in `GlobalSearchDialog.tsx:66, 233, 289` on `isSearchable(query)` (from `searchContract.ts`); constrain `max`/`min` on the two date inputs (or show a date-order message when `since && until && since > until`); and guard `contacts.birthday` date-range SQL with `length(contacts.birthday) = 10` so yearless `"MM-DD"` strings are not compared lexicographically against `YYYY-MM-DD` bounds.

---

### G10 — `Low-med` — `ImportDialog` leaves file-pick, `Import`, and `Cancel` active during `downloading`, omits a ref guard on `pick()`, and keeps the file-picker `<label>` styled active while `reading`

- **File:** `src/components/ImportDialog.tsx:109-131, 159-192, 228-246, 332-357`

**Evidence:**
```tsx
// src/components/ImportDialog.tsx:113-131, 159-180
const pick = async (file: File) => {
  setError(null);
  setReading(true);
  try {
    const text = await onPick(file);
    ...
  } finally {
    setReading(false);
  }
};
...
const downloadTemplate = async () => {
  if (downloadingRef.current) return;
  if (phase === "running") return;
  downloadingRef.current = true;
  setDownloading(true);
  setError(null);
  try {
    const path = await save({ ... });
    if (path === null) return;
    await saveCsvTemplate(path, templateCsv);
    toast.success(t("import.templateSaved", { path }));
  } catch (e) {
    setError(describe(e));
  } finally {
    downloadingRef.current = false;
    setDownloading(false);
  }
};
```
```tsx
// src/components/ImportDialog.tsx:228-246
<label className="btn btn-primary">
  <IconUpload className="icon" />
  {reading ? t("import.reading") : t("import.chooseFile")}
  <input
    className="visually-hidden"
    type="file"
    accept=".csv,text/csv"
    disabled={reading}
    ...
  />
</label>
{templateButton}
<button type="button" className="btn btn-ghost" onClick={onClose}>
  {t("common.cancel")}
</button>
```

**What is wrong:**
1. **`downloading` is isolated from `pick`, `confirm`, and `close` (`:109-111, 235, 244, 335, 344, 352`):** While `downloadTemplate` awaits `save(...)` and `saveCsvTemplate(...)`, `<input type="file">` (`:235`, `disabled={reading}`), `Choose another file` (`:335`), `Cancel` (`:244, 344`), `Escape`/backdrop (`:110`), and `Import` (`:352`) all remain enabled. If the user clicks `Import` and reaches `phase === "done"` (`:361`) before a slow/failing `saveCsvTemplate` rejects at `:175`, `setError(describe(e))` renders a red `role="alert"` banner directly above `"Import complete"` (`:215-219, 361-374`). Conversely, picking a file while `downloading` calls `setError(null)` (`:114`), or closing the dialog unmounts it mid-save.
2. **`pick()` has no synchronous `readingRef` guard and does not block `Cancel` / `close` (`:109-131, 244`):** `pick` sets React state `setReading(true)` (`:115`) without a `useRef` guard before `await onPick(file)` (`file.text()`), and neither `close` (`:110`) nor the pick-step `Cancel` button (`:244`) is disabled while `reading` is `true`.
3. **Active button appearance while `reading` (`:228-242`):** Disabling `<input className="visually-hidden" disabled={reading}>` does not style the wrapping `<label className="btn btn-primary">` (`:228`) as disabled or set `aria-disabled={reading}`, so `"Reading…"` retains full primary-button hover/cursor styling.

**User impact:**
Template-download failures can land on top of `"Import complete"` (making a succeeded import look failed), and during large file reads the `"Reading…"` button still looks clickable while `Cancel`/`Escape` remain unguarded.

**Fix direction:**
Introduce a single `busy = reading || downloading || phase === "running"` flag (plus a `readingRef` guard in `pick`), disable all step actions and lock `<Dialog>` whenever `busy` is `true`, and add `aria-disabled={busy}` / disabled styling to `<label className="btn btn-primary">`.

---

### G11 — `Low-med` — `LockScreen` retains cleartext recovery answer and new-PIN drafts across `"Back"` / `"Forgot PIN?"`, and runs 600k-iteration PBKDF2 + retry penalties on blank recovery answers

- **File:** `src/components/LockScreens.tsx:98-100, 293-298, 385-401, 470-484, 521-529, 565-588`
- **Seam file:** `src/lib/appLock.ts:55-68`

**Evidence:**
```tsx
// src/components/LockScreens.tsx:521-529, 576-587
<label>
  {t("lock.reset.answer")}
  <input
    className="input"
    placeholder={t("lock.reset.answerPlaceholder")}
    value={draft.answer}
    onChange={(e) => setDraft({ ...draft, answer: e.target.value })}
  />
</label>
...
<button
  type="button"
  className="btn"
  onClick={() => {
    setMode("pin");
    setError(null);
    setShaking(false);
    setAck(false);
  }}
>
  {t("common.back")}
</button>
```

**What is wrong:**
1. **Cleartext recovery `draft` leaks across mode switches (`:294-298, 472-481, 523-528, 579-584`):** Unlike PIN inputs (`type="password"`), the recovery answer `<input>` defaults to `type="text"` (`:523-528`), displaying the user's answer in plaintext. Clicking `"Back"` (`:579-584`) resets `mode`, `error`, `shaking`, and `ack`, **but leaves `draft` (`answer`, `pin`, `confirm`) intact**. Anyone clicking `"Forgot PIN?"` again while the screen remains locked sees the previously typed security answer in cleartext (and `"Forgot PIN?"` at `:472-481` likewise leaves `pin` intact).
2. **Blank recovery answer executes 600k PBKDF2 and consumes `failuresRef` (`:385-401, 565-575`):** `SetupScreen` rejects whitespace-only answers (`SetupScreen:98-100`: `if (draft.answer.trim().length === 0)`), so no valid stored answer can ever normalize to `""`. Yet in `LockScreen.resetPin`, `pinResetBlocked` (`appLock.ts:55-68`) checks `pin`, `confirm`, and `acknowledged` without checking `draft.answer.trim().length === 0`. Submitting the form with an accidentally blank Answer field runs a full 600,000-iteration `verifyAnswer("", answerHash)` that cannot possibly succeed and calls `noteFailure()` (`:399`), burning a retry attempt toward the 5-second lockout cooldown (whereas `pinResetBlocked` refusals explicitly do *not* count against the retry throttle per `appLock.ts:52-53`).

**User impact:**
Backing out of `"Forgot PIN?"` leaves the user's plaintext recovery answer sitting in memory/DOM state for the next click on `"Forgot PIN?"`; accidentally leaving the Answer field blank triggers a slow PBKDF2 check and penalizes the user's retry budget instead of showing `"A security answer is required."`.

**Fix direction:**
Clear `setDraft({ answer: "", pin: "", confirm: "" })` on `"Back"` (and `setPin("")` on `"Forgot PIN?"`), and check `if (draft.answer.trim().length === 0) { setError(t("lock.error.answerRequired")); return; }` in `resetPin` before `setBusy(true)` / `verifyAnswer` (matching `SetupScreen:98-100`).

---

### G12 — `Low-med` — `NoteReaderDialog` leaks `.note-reader-body` scroll position across Prev/Next notes, drops focus to `<body>` when Prev/Next hits list bounds, and keys tag chips by un-deduplicated tag text

- **File:** `src/components/NoteReaderDialog.tsx:53, 63-71, 145-149, 170-200`
- **Seam files:** `src/styles/app.css:3541-3549`, `src/lib/notes.ts:41-46`

**Evidence:**
```tsx
// src/components/NoteReaderDialog.tsx:53, 63-71, 145-149, 170-199
const tags = useMemo(() => parseTags(note.tags), [note.tags]);
...
useEffect(() => {
  setCopied(false);
  return () => {
    if (copyTimerRef.current !== null) {
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
  };
}, [note.id]);
...
{tags.map((tag) => (
  <span key={tag} className="tag-row">
    #{tag}
  </span>
))}
...
<div className="note-reader-body markdown">
  ...
</div>
```

**What is wrong:**
1. **Scroll offset leaks from Note A to Note B (`:63-71, 170`):** `.note-reader-body` is the dialog's scrollable viewport (`src/styles/app.css:3541-3549`: `max-height: calc(90vh - 16rem); overflow-y: auto;`). Navigating via `"Previous note"` / `"Next note"` (`:182-199`) or `ArrowLeft` / `ArrowRight` (`:108-114`) keeps `NoteReaderDialog` mounted and resets `copied` on `[note.id]` (`:63-71`), **without resetting `.note-reader-body`'s `scrollTop` to `0`**. Scrolling down a long note and advancing to the next opens the new note already scrolled partway down or at the bottom.
2. **Focus drops to `document.body` on boundary Prev/Next activation (`:182-199`):** Clicking or pressing `Enter`/`Space` on `"Next note"` when advancing onto the *last* note flips `disabled={!hasNext}` (`:194`) to `true` on the focused `<button>` (and likewise `"Previous note"` at `:185` on the *first* note), causing the browser to blur focus onto `document.body` outside the modal.
3. **Duplicate React keys on repeated tags (`:53, 145-149` + `notes.ts:41-46`):** `parseTags` splits on commas without deduplicating (`"work, work"` -> `["work", "work"]`, particularly common when `resolveReaderView` in `noteReader.ts:99-108` feeds live unsaved `editor.tags` into `NoteReaderDialog`). `tags.map((tag) => <span key={tag}>)` produces duplicate React keys whenever two entries share the same text.

**User impact:**
Stepping through notes in the full-screen reader starts each new note at the previous note's scroll depth; reaching the first or last note via the footer buttons drops keyboard focus out to `<body>` (where `Space` scrolls the background); duplicate tags emit React duplicate-key warnings/reconciliation glitches.

**Fix direction:**
Attach a `bodyRef = useRef<HTMLDivElement | null>(null)` to `.note-reader-body` and set `if (bodyRef.current) bodyRef.current.scrollTop = 0;` inside the `[note.id]` effect; shift focus to the opposite nav button or Close button when `hasNext`/`hasPrev` becomes `false` while that button was active; deduplicate tags (`[...new Set(parseTags(note.tags))]`) or key by `${tag}-${index}`.

---

### G13 — `Low` — `IconInbox` arrow path points upward out of the tray, contradicting its JSDoc

- **File:** `src/components/icons.tsx:54-65`

**Evidence:**
```tsx
// src/components/icons.tsx:54-65
/** Quick capture: a tray with something dropping into it. */
export function IconInbox(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <path d="M12 3v8" />
      <path d="m8.5 7.5 3.5-3.5 3.5 3.5" />
      <path d="M4 13h4l1.5 3h5L16 13h4" />
      <path d="M4 13v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" />
    </svg>
  );
}
```

**What is wrong:**
Line `54` documents `IconInbox` as `"a tray with something dropping into it"`, and `<path d="M12 3v8" />` draws a vertical stem from `(12, 3)` down to `(12, 11)` above the tray (`y = 13..20`). However, line `60` draws `<path d="m8.5 7.5 3.5-3.5 3.5 3.5" />`, which places the chevron vertices at `(8.5, 7.5) -> (12, 4) -> (15.5, 7.5)` — an **upward** arrowhead at the top of the stem (export/outbox direction) rather than a downward arrowhead at `(12, 11)` dropping into the tray (compare `IconDownload` at `icons.tsx:249-250`: `<path d="M12 3v12" /><path d="m7 10 5 5 5-5" />`).

**User impact:**
The Inbox icon visually depicts an upward "upload/outbox" arrow leaving the tray rather than an item dropping into the inbox.

**Fix direction:**
Flip the chevron to the bottom of the `(12, 3) -> (12, 11)` stem so it points downward into the tray: `<path d="m8.5 7.5 3.5 3.5 3.5-3.5" />`.

---

### G14 — `Low` — `ExportsPage` captures `today` before `await save(...)` while `exportedAt` is captured after, and `toggle()` leaves empty-selection errors visible

- **File:** `src/pages/ExportsPage.tsx:72-98`
- **Seam file:** `src/lib/exports.ts:817-822, 1037-1040`

**Evidence:**
```tsx
// src/pages/ExportsPage.tsx:72-98
const toggle = (key: ExportGroup) => {
  setSelection((current) => ({ ...current, [key]: !current[key] }));
};

const doExport = async () => {
  if (busyRef.current) return;
  setError(null);
  if (!Object.values(selection).some(Boolean)) {
    setError("Choose at least one group to export.");
    return;
  }
  busyRef.current = true;
  setBusy(true);
  try {
    const today = todayLocal();
    const path = await save({
      title: "Save Purple Memo readable export",
      defaultPath: `purple-memo-readable-${today}.zip`,
      filters: [{ name: "ZIP archive", extensions: ["zip"] }],
    });
    if (path === null) return;
    const exportedAt = localISODateTime(new Date());
    const { bytes, counts, fileCount } = await exportsRepo.build(
      selection,
      today,
      exportedAt,
    );
```

**What is wrong:**
1. **Split clock across `await save(...)` (`:86` vs `:93`):** `today` is read *before* opening the native OS file-save dialog (`await save(...)`), which can remain open across midnight, whereas `exportedAt` (`:93`) is read *after* the user confirms the path. `exportsRepo.build(selection, today, exportedAt)` uses `exportedAt` in `README.txt` (`Generated: ...`) while `deriveLoanState(row, today)` (`exports.ts:817-822, 1039`) grades `finance/loans.csv` `"overdue"` vs `"open"` against the pre-dialog `today` (compare `C2`).
2. **Sticky validation alert across `toggle()` (`:72-81`):** If the user unchecks all groups and clicks `"Export readable ZIP"`, `error` becomes `"Choose at least one group to export."` (`:80`). Re-checking a group via `toggle` (`:72-74`) does not clear `error` (or disable the button when no group is selected), leaving the error alert displayed while valid groups are checked.

**User impact:**
An export confirmed just after midnight writes inconsistent timestamps/loan states between `README.txt` and `finance/loans.csv`; re-selecting a group after an empty-selection click leaves a stale error banner on screen until Export is clicked again.

**Fix direction:**
Re-read `const buildDay = todayLocal();` alongside `exportedAt` *after* `await save(...)` resolves non-null, and clear `setError(null)` in `toggle` (or disable `"Export readable ZIP"` when `!Object.values(selection).some(Boolean)`).

---

## DECISION (Test-Pinned Behaviour — Document or Change)

### DECISION 1 — `GlobalSearchDialog` shows no truncation indicator when `applyTotalCap` (`SEARCH_TOTAL_CAP = 40`) slices or drops groups

- **Files:** `src/components/GlobalSearchDialog.tsx:251-253`, `src/lib/globalSearch.ts:247-277`, `src/lib/searchContract.ts:292`
- **Pinning test:** `src/lib/globalSearch.test.ts:624-655` (`"the total cap trims from the end and drops emptied groups"`)

**Context & Evidence:**
`GlobalSearchDialog.tsx:251-253` renders `t("search.moreAvailable")` (`" · more available"`) only when `group.capped` is `true`:
```tsx
<legend>
  {t(SEARCH_TYPE_LABELS[group.type])}
  {group.capped ? t("search.moreAvailable") : ""}
</legend>
```
In `src/lib/globalSearch.ts:247`, `group.capped` is set only when an individual entity query returns more than `spec.cap` (`10` or `5`) rows (`rows.length > spec.cap`). When multiple entity types match within their individual `spec.cap` whose combined count exceeds `SEARCH_TOTAL_CAP` (`40`), `applyTotalCap` (`globalSearch.ts:264-277`) slices the trailing group (`out.push({ ...group, results })` at `:274`, keeping `capped: false`) and drops subsequent non-empty groups completely. `globalSearch.test.ts:624-655` pins `applyTotalCap`'s behaviour (`[group("note", 10), group("task", 10), group("contact", 10)]` with `totalCap = 15` trims `task` to `5` results and drops `contact` without setting `capped: true`). Consequently, the UI reports `"40 results"` with no `" · more available"` marker anywhere even though matching items and entire entity groups were truncated.

**Options:**
1. **Keep `applyTotalCap` & existing test unchanged, add dialog-level indicator:** Return or compute a separate `totalCapped` flag (or surface a footer note when `applyTotalCap` trimmed results) in `GlobalSearchDialog.tsx` without mutating per-group `group.capped`.
2. **Mark sliced groups `capped: true` (and surface dropped-group notice):** Update `applyTotalCap` (`out.push({ ...group, results, capped: group.capped || results.length < group.results.length })`) alongside `globalSearch.test.ts:624-655`.

---

### DECISION 2 — Raw English state, detail, and untitled strings from `globalSearch` and `pickerResults` rendered verbatim in localized `GlobalSearchDialog` and `EntityPicker`

- **Files:** `src/components/GlobalSearchDialog.tsx:256-261`, `src/components/EntityPicker.tsx:211-216`, `src/lib/searchContract.ts:89, 103, 159, 173`, `src/lib/entityPicker.ts:112-151`
- **Pinning tests:** `src/lib/globalSearch.test.ts:447-490`, `src/lib/entityPicker.test.ts:186, 220-261`

**Context & Evidence:**
- `GlobalSearchDialog.tsx:256-261` renders `result.state` directly in the result metadata line; `searchContract.ts:89, 103, 159, 173` produces English literals `"Archived"`, `"Done"`, and `"Paid"`, pinned in `globalSearch.test.ts:465, 470, 489`.
- `EntityPicker.tsx:211-216` renders `hit.label`, `hit.state`, and `hit.detail` directly; `entityPicker.ts:112-151` produces English `"Untitled note"`, `"Untitled task"`, `"Unnamed contact"`, `"Archived"`, `"Done"`, `"Due YYYY-MM-DD"`, and `"Birthday ..."`, pinned in `entityPicker.test.ts:186, 229, 259-260`.
- Both dialogs are otherwise localized into Burmese (`my`), so Burmese users see mixed Burmese/English rows such as `လုပ်ငန်း · Pay rent (Done)` + `Due 2026-10-20` or `မှတ်စု · Untitled note (Archived)`.

**Options:**
1. **Translate at the presentation boundary (keep library contracts & tests unchanged):** Map known `result.state` / `hit.state` tokens (`"Archived"`, `"Done"`, `"Paid"`) and `hit.detail` / untitled fallbacks to `t(...)` + `formatDate(locale, ...)` inside `GlobalSearchDialog.tsx` and `EntityPicker.tsx`, leaving `globalSearch` and `pickerResults` tests untouched.
2. **Refactor model types to locale-neutral codes + structured dates:** Change `SearchResult.state` and `PickerHit` (`untitled: boolean`, `state: "archived" | "done" | null`, `detail: { kind: "due" | "birthday"; date: string } | null`) and update `globalSearch.test.ts` and `entityPicker.test.ts` accordingly.

---

## Checked and Found Clean

1. **`src/components/LockScreens.tsx` — first-run gate, unreadable-PIN lockdown, atomic setup write, and P3-12 ref counter:**
   - `LockedScreen` (`:258-288`) has no bypass control, renders localized `UNREADABLE_PIN_REASON` copy (`:263-267`), and never falls back to `SetupScreen` once a `pin_hash` row exists (`appLock.test.ts` tests 7–13, 29–31).
   - `SetupScreen` (`:74-124`) guards double-submit synchronously via `submittingRef` (`:78, 102, 122`), enforces `MIN_PIN_LENGTH` (`6`) and non-empty trimmed question/answer, hashes PIN and answer with 600,000-iteration PBKDF2-SHA256 + 16-byte CSPRNG salt (`crypto.ts:97-105`), and writes `pin_hash`, `security_question`, and `security_answer_hash` atomically in one `settingsRepo.setManyJSON` batch (`:109-116`).
   - `LockScreen` (`:324, 328-329`) tracks consecutive failures in `failuresRef` (fixing P3-12 snapshot under-counting) and requires explicit acknowledgement (`ack`, reset on mode entry at `:480, 583`) before `resetPin` can overwrite `pin_hash`.

2. **`src/components/icons.tsx` — decorative SVG hygiene, token compliance, and zero dead exports:**
   - Audited all 47 exported `Icon*` components (`:27-527`) and `base(props)` (`:13-25`). Every icon spreads `base(props)` (`aria-hidden="true"`, `focusable="false"`, `stroke="currentColor"`, `viewBox="0 0 24 24"`), contains zero hardcoded hex/`rgb()`/`px` literals (`token-lint: OK`), and every one of the 47 exports has at least one live importer across `src/`. `IconSpinner` (`:517-527`) pairs cleanly with `.icon-spin` and `@media (prefers-reduced-motion: reduce)` (`src/styles/app.css:320-335`).

3. **`src/components/ImportDialog.tsx` — preview-before-write contract, batch atomicity seam, formula-guard round-trip, and 1-based row numbering:**
   - Nothing touches SQLite during `"pick"` or `"preview"`; `confirm()` (`:140-155`) is protected by `runningRef.current` (`:141, 143, 153`) and disables `Import` when `preview.valid.length === 0` (`:352`).
   - Both callers (`ContactsPage.tsx:897-925`, `TasksPage.tsx:540-563`) commit accepted rows in a single transactional `driver.batch` (`contactImport.ts`, `taskImport.ts`) and await `reload()` before resolving `onConfirm`.
   - `describe(e)` (`:104-105`) routes `MessageKeyError` refusals (`csv.ts` size/row/column caps and `taskImport.ts` / `contactImport.ts` row reasons) through `t(e.messageKey, e.params)` in both EN and MY (`i18n.test.ts:147-169`). 1-based data-row numbering (`Row 1` = first data row after header) matches `docs/PurpleMemo_Import_Tasks.md` and `csv.test.ts` / `taskImport.test.ts` / `contactImport.test.ts`.

4. **`src/components/GlobalSearchDialog.tsx` — SQL parameterization, FTS punctuation stripping, debounce cancellation, and fresh mount state:**
   - Every search value in `globalSearch.ts` is bound via `?` parameters (`globalSearch.test.ts` test 95), FTS syntax characters are stripped via `ftsMatchQuery`, and `LIKE` wildcards (`%`, `_`, `\`) are escaped with `ESCAPE '\'`.
   - `useEffect` (`:65-107`) sets `cancelled = true` and `clearTimeout(timer)` on every query/filter edit and on unmount, preventing out-of-order search responses from overwriting newer ones. Conditional mounting (`{searchOpen && <GlobalSearchDialog ... />}` in `App.tsx:1003-1008`) resets state cleanly on close.

5. **`src/components/EntityPicker.tsx` — fresh open-time reads, self/duplicate exclusion, cancellation, and `F12` match count:**
   - Mount effect (`:54-78`) fetches fresh `notes`, `tasks`, and `contacts` on each open with `cancelled` cleanup, and `LinksSection.tsx:165-172` mounts `EntityPicker` conditionally (`{picking ? <EntityPicker ... /> : null}`), preventing stale cross-entity state from leaking across opens.
   - `pickerResults` (`entityPicker.ts`) excludes `from` (self-link) and `alreadyLinked` (both directions), and reports full pre-cap `matched` (`F12` remains intact, verified by `entityPicker.test.ts`).

6. **`src/components/NoteReaderDialog.tsx` — safe Markdown link routing, Burmese word segmentation, live-vs-switched note view, and timer cleanup:**
   - `<ReactMarkdown components={markdownComponents}>` (`:174-176`) renders raw HTML inert (no `rehype-raw`) and routes links through `MarkdownLink` (`routeLink` allowlist `http`/`https`/`mailto`/`tel` + `openUrl`).
   - `countWords(note.content, locale)` (`:55-58`, `noteReader.ts:66-74`) uses `Intl.Segmenter` word granularity so Burmese script counts real words rather than space-delimited clauses (`noteReader.test.ts` test 108).
   - `copyTimerRef` (`:63-71`) is cleared on both note switch and unmount, and `ArrowLeft`/`ArrowRight` (`:91-118`) ignore modifier chords (`Ctrl`, `Alt`, `Meta`, `Shift`), `defaultPrevented` events, and text inputs.

7. **`src/pages/ExportsPage.tsx` — double-submit `busyRef` guard, atomic Rust export writer, CSV formula neutralization, and `F7` journal path parity:**
   - `doExport` (`:76-109`) guards re-entry synchronously via `busyRef.current` before `await save(...)` and resets in `finally`.
   - `ExportsPage.tsx:38` (`"One Markdown file per day under journal/yyyy/"`), `EXPORT_FIELD_MAPPING` (`exports.ts:152`: `"journal/<yyyy>/<yyyy-mm-dd>.md"`), `journalExportPath` (`exports.ts:289`: `` `journal/${year}/${date}.md` ``), and `docs/EXPORTS.md:22, 42` all agree (`F7` has not regressed).
   - `ExportsPage` being English-only is already recorded under `B13` (the 10 unmigrated pages) and was deliberately not re-reported here.
