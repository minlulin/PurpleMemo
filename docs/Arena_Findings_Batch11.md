# PurpleMemo Audit — Batch 11 Findings (shared UI component layer)

- **Base commit:** `44ce3ad` (`dev` HEAD — the Batch 10 fix wave `970ea84`…`44ce3ad` is complete).
- **Audit branch:** `arena/8c3bf905-purplememo` (PR target: `dev`). **No source file was modified** — this document is the only change.
- **Prior batches cross-checked (not re-reported):** `F1`–`F12`, `B1`–`B14`, `C1`–`C6`, `D1`–`D12`, `E1`–`E14`, `G1`–`G14`, `H1`–`H10`, `I1`–`I4`, `J1`–`J8`, `K1`–`K13`. The Batch 6 dialog fixes (the `locked` prop, the focus trap / trigger-restore behaviour, the `applyTotalCap` indicator, D1(a)/D2(a) presentation rules), the H8 submit-guard rule, and the D11 MessageKeyError precedent were re-verified intact in this batch's files and are not re-reported.

## Scope (9 files, 871 lines)

1. `src/components/LinksSection.tsx` (175)
2. `src/components/Dialog.tsx` (146)
3. `src/components/Toast.tsx` (138)
4. `src/components/ConfirmButton.tsx` (113)
5. `src/components/OnboardingGuide.tsx` (106)
6. `src/components/Skeleton.tsx` (66)
7. `src/components/MarkdownLink.tsx` (58)
8. `src/components/useTranslation.ts` (50)
9. `src/components/EmptyState.tsx` (19)

## Method

Each file was read end-to-end with line numbers, one at a time. Seams were read because the bugs live at the joins: `src/lib/links.ts` (`routeLink`), `src/lib/confirm.ts` (the `ConfirmState` machine), `src/lib/i18n.ts` (`translate` / `translateFor` and the missing-key fallback), `src-tauri/src/navigation.rs` (the Rust navigation guard, the XSS backstop), `src/components/EntityPicker.tsx` (the direct `LinksSection` seam), and the rendering pages `NotesPage.tsx`, `ContactsPage.tsx`, `TasksPage.tsx`, `DashboardPage.tsx` (the `OnboardingGuide` caller) and `App.tsx` (the `ToastProvider` / `Skeleton` host). Callers were traced for the `entity` prop, for guard patterns, and for what re-renders them.

The pure-lib tests that pin the behaviour examined here were run on Node `v22.22.3`:

```sh
node --test src/lib/confirm.test.ts src/lib/links.test.ts src/lib/i18n.test.ts
```

**Result:** `23/23` pass (`confirm` 8, `links` 5, `i18n` 10), `0` failures. Component-level React tests need the Vite/React toolchain, which is not installed in this sandbox (`node_modules` absent), so those suites were not run; this is stated rather than inferred.

---

## Summary Table

| ID | Severity | File(s) | Summary |
| :--- | :--- | :--- | :--- |
| **L1** | **Med** | `LinksSection.tsx` + 3 callers | `reload`'s `useCallback` dependency is the inline `p.entity` object literal, so it re-runs on **every** parent render — the related-items list re-queries and flickers on every keystroke in the note/contact/task editor |
| **L2** | **Low-med** | `LinksSection.tsx` | `reload` has no cancellation/sequence token, so a stale response from a previous entity can overwrite the current list |
| **L3** | **Low** | `Skeleton.tsx` | The single-text branch ignores the `className` prop |
| **L4** | **Low** | `Skeleton.tsx` | A lone text bar carries `aria-busy="true"` while its comment calls it "decoration" — no live region, so the busy flag announces nothing |
| **L5** | **Low** | `Toast.tsx` | `timers.current` is never trimmed and grows without bound across the session (the unmount cleanup is correct, so this is not a leak-on-unmount) |

---

## Findings

### L1 — `Med` — LinksSection reloads its list on every parent render because `reload` depends on the inline `p.entity` object

- **File:** `src/components/LinksSection.tsx:45-59`, callers `NotesPage.tsx:1196`, `ContactsPage.tsx:853`, `TasksPage.tsx:433`

**Evidence:**
```ts
// src/components/LinksSection.tsx:45-54
const reload = useCallback(async () => {
  try {
    setItems(await entityLinksRepo.listRelated(p.entity));
    setError(null);
  } catch (e) {
    setError(errText(e));
  } finally {
    setLoading(false);
  }
}, [p.entity]);                       // <- dependency is the object reference

// src/components/LinksSection.tsx:56-59
useEffect(() => {
  setLoading(true);
  void reload();
}, [reload]);                         // <- re-runs whenever `reload` changes identity
```

All three callers pass `entity` as an **inline object literal**, so `p.entity` is a fresh reference on every parent render:
```tsx
// NotesPage.tsx:1196
entity={{ type: "note", id: selected.id }}
// ContactsPage.tsx:853
entity={{ type: "contact", id: selectedContact.id }}
// TasksPage.tsx:433
entity={{ type: "task", id: focusedTask.id }}
```

Each page holds its editor fields in state, so every keystroke re-renders the page: NotesPage `const [content, setContent] = useState("")` (`:353`) with `editNote` calling `setContent` (`:698`); ContactsPage `const [edit, setEdit] = useState({…})` (`:115`); TasksPage `const [title, setTitle]` / `const [note, setNote]` (`:102-105`).

**What is wrong:** `useCallback` returns a new function whenever a dependency changes reference; `p.entity` is a new object on every render, so `reload` is recreated on every render, so the `[reload]` effect re-runs on every render. The effect sets `loading = true` and issues a fresh `entityLinksRepo.listRelated(p.entity)` IPC call on every render — not when the relationship target changes. The component's own comment ("a row that no longer exists is SHOWN as unavailable") frames the reload as keyed on the *target*, not on every paint.

**User impact:** While a note/contact/task is selected, every keystroke in the editor above the relationships panel triggers a full reload: the list unmounts to the `"Loading…"` spinner (`:110-113`) and re-mounts, and an extra `listRelated` query crosses IPC. On the note editor — the app's primary writing surface — the panel flickers on every keystroke. No data is lost, but the redundant work and the flicker are real and frequent.

**Fix direction:** Depend on a stable primitive identity rather than the object reference — e.g. `const entityKey = `${p.entity.type}-${p.entity.id}`;` and key `reload` (and its effect) on `entityKey`, reconstructing or capturing `p.entity` inside — or memoize the `entity` object in the three callers. Pair with L2's cancellation token so only the newest response writes.

---

### L2 — `Low-med` — LinksSection `reload` has no cancellation/sequence token, so a stale response can overwrite the current list

- **File:** `src/components/LinksSection.tsx:45-59`

**Evidence:** `reload` (`:45-54`) is async, awaits `entityLinksRepo.listRelated(p.entity)`, then calls `setItems(...)`; there is no `cancelled` flag or monotonic sequence token anywhere in the function or in its effect (`:56-59`).

**What is wrong:** `reload` captures `p.entity` in its closure. When the entity changes (the user selects a different note/contact/task), a `reload` created for the *old* entity can still be in flight; if it resolves after the new entity's `reload`, its `setItems(oldRelated)` overwrites the fresh list. L1 makes this more likely (reloads are constantly in flight on every render), but the race is independent: even with a stable dependency, a rapid entity switch during an in-flight query can install the previous entity's rows under the new one.

**User impact:** A transient wrong list — the relationships panel briefly shows the previously-selected entity's links under the newly-selected entity — until the next reload overwrites it. Self-healing, but the panel briefly misrepresents which entity's relationships are shown.

**Fix direction:** Add a cancellation flag or a monotonic sequence token to `reload` (only the newest invocation may write `setItems`/`setLoading`) — the pattern `stale-state-guards.test.ts` already enforces for other pages.

---

### L3 — `Low` — Skeleton's single-text branch ignores the `className` prop

- **File:** `src/components/Skeleton.tsx:28-45`

**Evidence:**
```tsx
// Skeleton.tsx:28-33 — the prop is accepted
export function Skeleton({ variant = "text", width = "full", count = 1, className }: SkeletonProps) {

// Skeleton.tsx:43-45 — the single-text branch drops it
  if (count <= 1 && variant === "text") {
    return <span className={barClass(variant, width)} aria-busy="true" />;
  }

// Skeleton.tsx:54-56 — every other branch applies it
  return (
    <>
      <span className="visually-hidden" role="status">Loading…</span>
      <span className={`skeleton-stack ${className ?? ""}`.trim()} aria-busy="true">
```

**What is wrong:** A caller that passes `className` to a single-text `Skeleton` (the default `variant="text"`, `count=1`) has it silently dropped. The prop is honoured in the stack/card branch but ignored in the one branch the default arguments select. This is latent — no current caller passes `className` to a single-text Skeleton (the only `className` usage, `GalleryPage.tsx:420`, uses `variant="card"`) — but it is a prop-contract violation.

**User impact:** None today; bites the first caller that styles a single-text skeleton.

**Fix direction:** Apply `className` in the single-text branch too (or document that it is ignored there).

---

### L4 — `Low` — A lone Skeleton text bar carries `aria-busy="true"` while its comment calls it "decoration", and it has no live region

- **File:** `src/components/Skeleton.tsx:42-44`

**Evidence:**
```tsx
// Skeleton.tsx:42
// A lone inline bar is decoration; a stack or a card is a loading region.

// Skeleton.tsx:44
return <span className={barClass(variant, width)} aria-busy="true" />;
```
The module's own rule (`:5-8`) places `aria-busy` on the *block* and the announcement on a separate `role="status"` live region precisely so the busy flag does not swallow the announcement. The stack/card branch follows that rule (`:47-64`); the lone bar sets `aria-busy` with no live region and no text.

**What is wrong:** The single-text branch is described as "decoration" yet sets `aria-busy="true"` — a flag whose purpose (per the file's `:5-8` comment) is to mark a loading region that a live region announces. With no `role="status"` and no text, the busy flag announces nothing, and the "decoration" claim and the `aria-busy` attribute contradict each other.

**User impact:** A single-text skeleton used as a loading placeholder gives screen-reader users no indication a load is in progress (the stack/card variants do announce). Minor a11y inconsistency; see DECISION.

**Fix direction:** Either remove `aria-busy` (treat it purely as decoration, matching the comment) or give the lone bar a `role="status"` + `"Loading…"` text so it announces like the other variants.

---

### L5 — `Low` — Toast's `timers.current` array is never trimmed and grows without bound across the session

- **File:** `src/components/Toast.tsx:51, 64, 76, 81-86`

**Evidence:**
```ts
// Toast.tsx:51
const timers = useRef<number[]>([]);

// Toast.tsx:64 (in `dismiss`)
timers.current.push(window.setTimeout(() => remove(id), TOAST_EXIT_MS));

// Toast.tsx:76 (in `push`)
timers.current.push(window.setTimeout(() => dismiss(id), TOAST_MS));

// Toast.tsx:81-86 — clears on unmount, but never resets the array
useEffect(() => () => {
  for (const timer of timers.current) window.clearTimeout(timer);
}, []);
```

**What is wrong:** Every toast pushes one timer id (the auto-dismiss) and every dismiss pushes another (the exit), and no entry is removed when its timer fires. The array grows by 1–2 numbers per toast for the life of the provider. The unmount cleanup is correct, so this is **not** a leak-on-unmount — but it is an unbounded growth that never shrinks.

**User impact:** Negligible in practice (a few thousand numbers), but a real, if tiny, unbounded accumulation; `clearTimeout` on an already-fired id is a no-op, so stale entries only consume memory.

**Fix direction:** Remove the id from `timers.current` when its timer fires (or store `{id, handle}` and filter on fire), keeping the array bounded by the toasts currently mounted.

---

## DECISION

**Skeleton single-text bar: decorative or announced?** (L4.) The file's comment says a lone text bar is "decoration", but it sets `aria-busy="true"` and the module's own `:5-8` rule ties `aria-busy` to an announcing live region. Two coherent resolutions:

1. **Decoration:** remove `aria-busy` from the lone bar (it announces nothing anyway).
2. **Announced:** give it `role="status"` + `"Loading…"` text so a single-text skeleton announces like the stack/card variants.

This is an a11y/product call, not a mechanical defect; either resolution removes the comment/attribute contradiction. The other four findings are mechanical and need no owner call.

**RESOLVED 2026-10-31 (owner-delegated to Muus): option 1 — Decoration.** Remove `aria-busy="true"` from the single-text branch. The module header already states the design: "Decorative by default — a stack (or a card) carries `role=\"status\"` so the wait is still announced, and the bars themselves are hidden from assistive tech" — the lone-bar comment ("A lone inline bar is decoration") agrees, so the `aria-busy` attribute is the defect, not the comment. Adding `role="status"` would make every single-line placeholder announce "Loading…", noisier and contradicting the hidden-from-assistive-tech design. A page that needs an announced loading state uses a stack/card.

---

## Checked and found clean

- **`MarkdownLink.tsx` — the XSS surface is defended in two layers.** `routeLink` (`src/lib/links.ts:30-44`) classifies `javascript:`/`data:`/`file:`/relative/empty hrefs as `"blocked"` (only `http/https/mailto/tel` are `"external"`, `#…` is `"hash"`). `MarkdownLink.tsx:29-39` calls `event.preventDefault()` for every non-hash route, so a blocked scheme never navigates in-app; external links go to `openUrl` with `rel="noreferrer noopener"` (`:46`). The Rust navigation guard (`src-tauri/src/navigation.rs:76-88`, wired at `lib.rs:104`) cancels every navigation away from the app origin, explicitly including `javascript:`, `data:`, `file:` and `about:blank` (`:74`). All three `ReactMarkdown` call sites (`NotesPage.tsx:247`, `JournalPage.tsx:485`, `NoteReaderDialog.tsx:212`) pass `components={markdownComponents}`, so no renderer path bypasses the link rule. `links.test.ts:21-23` pins the dangerous-scheme and relative-href blocking. `LinksSection.tsx` renders no `href` at all — related items are buttons/spans with text content (`:138-148`).
- **`LinksSection.tsx` — guards present; no URL rendering.** `link` and `unlink` both raise `busyRef.current` synchronously before their first `await` and clear it in `finally` (`:62-94`), so a double-click cannot link or unlink twice. `link` deliberately has no `catch` (its comment says so); errors route to `EntityPicker.choose`'s catch, which is the mounted caller. The `picking` state mounts `EntityPicker` conditionally (`:165-172`).
- **`Dialog.tsx` — focus trap, Escape, `locked` gate, trigger restore.** The Tab handler traps focus (wraps at the ends, reclaims focus that left the dialog, and holds the container when no control is enabled, `:71-120`). Escape and the backdrop route through `close`, which returns early while `locked` is true (`:43-48`), so a write in flight cannot be dismissed via the dialog's own paths; the caller's success-path `onClose` is documented as the intended exception. `triggerRef` is captured once on mount and restored in the unmount cleanup (`:61-69`), covering every close path including buttons wired to `onClose` directly. The `locked` prop is intact from the Batch 6 G3 fix.
- **`ConfirmButton.tsx` — no double-fire.** The danger button calls `onConfirm` once; after `send("run")` the state is `"running"`, the armed pair unmounts and a disabled `aria-busy` button renders, so a second click cannot reach the handler. The state machine (`confirm.ts:40-54`, pinned by `confirm.test.ts:41-49`) refuses `arm`/`run` re-entry while running, and `settle` always returns to idle (success or failure).
- **`Toast.tsx` — timers cleared on unmount.** The `[]` cleanup effect (`:81-86`) clears every timer in `timers.current` on unmount, so an auto-dismiss timer cannot fire after the provider goes away. The only issue is the unbounded array growth (L5). The `role="status"` live region and `MAX_TOASTS` cap behave as documented.
- **`OnboardingGuide.tsx` — dismissal state is not stale.** The mount effect reads `getOnboardingDismissed()` once with a `cancelled` guard (`:21-35`); on success `setVisible(false)`, on failure the guide stays hidden and re-reads on the next mount. The dismiss write is idempotent (`setOnboardingDismissed(true)`), so a state-guarded double-click is harmless; the button is `disabled={dismissing}`. No path re-shows the guide after a persisted dismissal.
- **`useTranslation.ts` / `i18n.ts` — the D11 missing-key fallback is intact.** `translate`/`translateFor` (`i18n.ts:1559-1576`) fall back to English in production and to the raw key string if English is also absent (development throws). Every key used by the nine in-scope components exists in both the `en` and `my` catalogues (each key appears exactly twice). `useT`/`useLocale`/`usePlural` are stable per locale via `useSyncExternalStore` + `useCallback`.
- **`EmptyState.tsx`** — presentational only; renders `IconBox` + children. No logic, no props beyond `children`.
- **No `target="_blank"` anywhere in `src/`** (grep: no matches), so the missing-`rel` class does not arise; `MarkdownLink` sets `rel="noreferrer noopener"` regardless.
