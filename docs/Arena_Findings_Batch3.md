# Findings — batch 3 audit: business, gallery, memories, loans, shopping (2026-10-26)

Base commit: `dev` at `5afd9459` ("fix(audit): repair B1-B14 and close the batch-2 gate gaps", after the batch-2 fix merge).
Working branch: `arena/a669ba02-purplememo` (PR target: `dev`). This document is the only file in the PR; no source file was modified.

## Scope and method

Files audited in full, one at a time:

- `src/lib/business.ts` (616 lines)
- `src/pages/GalleryPage.tsx` (588 lines)
- `src/lib/gallery.ts` (370 lines)
- `src/pages/MemoriesPage.tsx` (498 lines) + `src/lib/memories.ts` (102 lines)
- `src/pages/LoansPage.tsx` (476 lines) + `src/lib/loans.ts` (164 lines)
- `src/pages/ShoppingPage.tsx` (456 lines) + `src/lib/shopping.ts` (122 lines)

For each file I also read what it imports and what imports it, because seam bugs live at the joins:

- `business.ts` is consumed by `src/data/app.ts`, `src/lib/dashboard.ts` (`warrantyEndDate`), `src/lib/share.ts` (`createBusinessRepo`), and `src/pages/BusinessPage.tsx`; it imports `deleteLinkedEntity` from `gallery.ts`.
- `gallery.ts` is consumed by `data/app.ts`, `business.ts` (`deleteJob`), and `GalleryPage.tsx` (`createThumbUrlBook`, `photoExtFromName`).
- `memories.ts` is consumed by `data/app.ts`, `share.ts`, `gallery.test.ts`; it builds on `trash.ts` (`trashEntity`).
- `loans.ts` is consumed only by `data/app.ts`; `LoansPage.tsx` is the sole UI consumer.
- `shopping.ts` is consumed by `data/app.ts` and `ShoppingPage.tsx` (`moveItem`).

I also read `lib/money.ts` (`applyPayment`), `lib/mutex.ts`, `lib/dates.ts`, `lib/loads.ts`, `lib/trash.ts`, `data/driver.ts`, `lib/types.ts`, the tests pinning each module (`business.test.ts`, `gallery.test.ts`, `memories.test.ts`, `loans.test.ts`, `shopping.test.ts`), and the gate tests (`submit-guards.test.ts`, `delete-guards.test.ts`).

Method: full read of every file in scope (no skimming), looking for race conditions and stale-state rendering, wrong-row writes, missing submit/double-click guards, render-time values used in writes, unsanitized paths, untranslated user-facing strings, dead code/branches, wrong-date/wrong-requirement logic, and behaviour contradicting the code's own comments. Tests that pin behaviour were checked; where a test pins current behaviour that looks wrong, the entry is framed as what the code does versus what it should do. Findings F1–F12 (`docs/Arena_Findings_261026.md`) and B1–B14 (`docs/Arena_Findings_Batch2.md`) are already fixed on `dev` and are not re-reported; no fix has regressed.

Baseline check: the full suite passes except six suites outside this scope (`ipc`, `backup`, `backupContainer`, `exports`, `phone-page`, `share`); every in-suite (`business`, `gallery`, `memories`, `loans`, `shopping`, `submit-guards`, `delete-guards`) passes.

## Findings

| ID | Area | Severity |
|----|------|----------|
| C1 | `src/lib/gallery.ts` | Low |
| C2 | `src/pages/MemoriesPage.tsx`, `src/pages/LoansPage.tsx` | Low |
| C3 | `src/pages/MemoriesPage.tsx` | Low-med |
| C4 | `src/pages/MemoriesPage.tsx` | Low-med |
| C5 | `src/pages/ShoppingPage.tsx` | Low |
| C6 | `src/pages/GalleryPage.tsx` | Low |

---

### C1 — `deleteLinkedEntity`'s comment claims `deleteJob` does not exist yet

**Evidence.** `src/lib/gallery.ts:146-148`: "`job` is included for the day `business.ts` grows a `deleteJob`; it has no delete path at all today (P2-9)." Against `src/lib/business.ts:351-352`:

```ts
async deleteJob(id: number): Promise<void> {
  await driver.batch(deleteLinkedEntity("job", id));
},
```

and `src/lib/business.test.ts:539` ("deleteJob: removes the job and its photo links in one batch"), which pins the two-statement batch (`photo_refs` first, then `jobs`).

**What is wrong.** Behaviour contradicts the code's own comment: `business.ts` already grows (and ships) `deleteJob`, so the `job` arm of `deleteLinkedEntity` is live code used in production, not future-proofing. The comment misstates the module's state to anyone reading `gallery.ts`.

**User impact.** None — the path works correctly (job row and its photo links removed in one atomic batch, income entries deliberately left). The impact is documentation only: a maintainer could conclude the `job` arm is dead/unused.

**Fix direction.** Update the `gallery.ts` comment to note that `business.ts` already deletes jobs through `deleteLinkedEntity("job", id)`, and remove the "no delete path at all today" claim. No logic change.

---

### C2 — Date-derived reads go stale while a page is parked (`today` captured at render)

**Evidence.** `src/pages/MemoriesPage.tsx:167`: `const today = todayLocal();` in the component body, consumed inside `reload` at :194-195 (`memoriesRepo.upcoming(today)`, `memoriesRepo.onThisDay(today)`) and :196-197 (`contactsRepo.upcomingBirthdays(14, today)`, `contactsRepo.birthdaysOn(today)`); `reload` is a `useCallback` keyed on `[today]` (:203). `src/pages/LoansPage.tsx:44`: same capture, consumed at :84 (`setLoans(await loansRepo.listLoansWithState(today))`), which feeds `deriveLoanState`'s overdue badge.

**What is wrong.** `today` is computed once per render and the page only re-renders on state changes, so a page left open past midnight shows yesterday's "Birthdays today", "Next 14 days", and overdue-loan chips until the next interaction. These are reads only — neither page writes render-time `today` anywhere (contrast batch-2 B8/F11, where `today` was handed into `completeTask` writes). The view self-heals on the next action, but until then it shows the wrong date-derived data.

**User impact.** A user who parks on Memories or Loans across midnight sees stale "today/upcoming" lists and stale overdue chips until they tap anything. Confusing but not destructive.

**Fix direction.** Read `todayLocal()` inside `reload` (fresh on every reload) or recompute when the local date changes, instead of capturing `today` in the component body.

---

### C3 — `MemoriesPage` installs a stale month feed after a create or delete (`feedMonth` captured before awaits)

**Evidence.** `src/pages/MemoriesPage.tsx:175`: `const [feedMonth, setFeedMonth] = useState(() => yearMonthOf(todayLocal()));`. In `submitForm` (:271-272):

```ts
await reload();
const feed = await memoriesRepo.monthFeed(feedMonth);
setMonth(feed);
```

and identically in `remove` (:299-300, after `await memoriesRepo.deleteMemory(m.id)` and `await reload()`). The month nav rewrites `feedMonth` at :433 and :445.

**What is wrong.** Both writes close over the `feedMonth` value that was current when the user tapped Add or Delete. If the user switches months while that create/delete is in flight, the in-flight call resolves with the old month and `setMonth` installs the old month's entries under the newly selected month's heading (e.g. March's memories under "April"). No data is lost and it self-heals on the next month navigation, but the user sees the wrong month's list under the right heading. Same stale-value-after-await family as batch-2 B2 (ContactsPage reloading a stale detail after a contact switch); here the victim is the month feed rather than a row.

**User impact.** After creating or deleting a memory while flipping months, the month view briefly shows another month's entries under the current heading.

**Fix direction.** Read the current `feedMonth` at write time (e.g. via a ref) or gate `setMonth` with a request token so a stale in-flight feed cannot overwrite a newer selection.

---

### C4 — `MemoriesPage` focus effect forces the "all" view on every reload while a search target persists

**Evidence.** `src/pages/MemoriesPage.tsx:216-221`:

```ts
useEffect(() => {
  if (focusId === null || loading) return;
  setView("all");                          // :220
  ...
}, [focusId, focusToken, loading, all]);   // :221
```

`focusId` comes from `App.tsx:913` (`searchTarget?.type === "memory" ? searchTarget.id : null`), and `App.tsx:326-330` (`navigate`) clears focus — so `focusId` persists on the page until the user navigates away.

**What is wrong.** Arriving at a memory from search correctly sets the view to "all" once. But because `all` is in the dependency list, every subsequent `reload` (create, edit, or delete replaces `all`) re-runs the effect and calls `setView("all")` again — snapping the user out of Upcoming / On-this-day / Month and back to "all" after every action, for the rest of the session. batch-2's prescribed shape (NotesPage: focus effect keyed on focus id and token only) avoids this; `all` should not be a dependency of an effect whose body forces the view.

**User impact.** After opening a memory from search, any page action kicks the user back to the "all" view until they navigate away — disruptive navigation with no data impact.

**Fix direction.** Key the effect on `focusId`/`focusToken` only and handle the arrival view switch once (e.g. a ref marking the arrival handled), so reloading data does not force the view.

---

### C5 — `ShoppingPage` reorder (`move`) has no in-flight guard and reorders a stale snapshot

**Evidence.** `src/pages/ShoppingPage.tsx:214-228`:

```ts
const move = async (index: number, direction: "up" | "down") => {
  const next = moveItem(
    items.map((i) => i.id),     // snapshot from this render
    index,
    direction,
  );
  try {
    await shoppingRepo.reorderItems(next);  // full-order write, no guard
    await reloadItems(selectedId);
  } ...
};
```

No busy flag and the up/down arrows are never disabled. Contrast `addList`/:249ff and `addItem`/:249ff, which raise `savingRef` before the first await and disable their buttons (pinned by `src/pages/submit-guards.test.ts:356-363`). `reloadItems` itself carries a sequence token (`itemLoadSeq`), but the reorder writes do not.

**What is wrong.** Two rapid clicks in the same direction compute the same target order from the same stale `items` snapshot, so `reorderItems` runs the same full order twice — two clicks, one step. Two opposing moves computed from one snapshot let the last write win, losing the other intent. `moveItem` itself is pure and correct; the defect is the unguarded, unsequenced write derived from a render-time snapshot.

**User impact.** Rapid reordering loses steps: the list order does not reflect all the user's clicks until they redo the missed move. No data loss; the order is always a valid permutation.

**Fix direction.** Guard reorder while one is in flight (ref plus disabled arrows, the page's own `savingRef` convention) or apply moves optimistically so later clicks see the updated order.

---

### C6 — `GalleryPage` link-picker lists (notes/memories/jobs) load once at mount and never refresh

**Evidence.** `src/pages/GalleryPage.tsx:160-184` — the mount effect loads `notesRepo.listNotes()`, `memoriesRepo.listMemories()`, `businessRepo.listJobs()` exactly once (:173-175) into `notes`/:178, `memories`/:179, `jobs`/:180. No other code path writes these three states (not after `saveMeta`, `pickFiles`, `addLink`, or `removeLink`). They feed `titleOf` (:445-453) and `pickerRows` (:485-506), which render the inspector's "Linked to" titles and the link-picker options.

**What is wrong.** The link-picker data is mount-once. Renaming a job (BusinessPage), note, or memory elsewhere in the session leaves Gallery's link picker and the inspector's "Linked to" titles showing the old names until the page is revisited. Links themselves are stored by id and remain correct; only the rendered labels are stale.

**User impact.** Cosmetic: a link target's displayed name can lag its current title for the rest of the session. No data impact.

**Fix direction.** Refresh the notes/memories/jobs picker lists when the inspector opens or alongside each photo reload, so link labels stay current within a session.

---

## Checked and found clean

These areas were examined in full and no issue was found; they bound the audit:

- `src/lib/business.ts` — `updateJob`: per-job mutex (`mutex.withLock("job:${id}"` at :332), total-may-not-drop-below-paid guard, status recomputed from the new total (`:344-346`); `recordJobPayment`: same mutex, `applyPayment` clamp, skips the write when `appliedCents === 0` (concurrent double-submit test at `business.test.ts` passes); `updatePayable`: amount frozen once paid (`:252-260`); `markPayablePaid`: idempotent under the payable mutex; `deleteShop`: nulls `jobs`/`payables` references then deletes in one atomic batch (the F1 precedent, intact); `deleteJob`: one `deleteLinkedEntity("job", id)` batch, income entries deliberately left; `shopReceivableRows` ordering (balances largest-first, then no-balance alphabetically — pinned by test); `payableDueStatus`, `warrantyEndDate`/`inWarranty` (pinned by tests).
- `src/lib/gallery.ts` — `isUniqueViolation`: structural match, non-UNIQUE errors rethrown; `photoExtFromName`: hostile extensions fall back to `bin` (path sanitization); `createThumbUrlBook`: `swap`/`drop`/`clear`/`revokeAll` revoke-once, never-while-live accounting (pinned); `deleteLinkedEntity`: table derived from the closed `PHOTO_REF_TABLES` map, links first, atomic batch (pinned); `savePhoto`: lost-insert-race absorption with re-read, rethrow when the colliding row vanished, non-unique failures propagate (pinned); `addRef`: UNIQUE violation absorbed, other errors rethrown (pinned); `deletePhoto`: trash hold check, row delete (FK cascades links) then file delete.
- `src/lib/memories.ts` — partial updates write only provided fields (no NULL wipe — pinned), `deleteMemory` via `trash.trashEntity("memory", id)` (snapshot includes photoRefs), `upcoming`/`onThisDay`/`monthFeed` SQL.
- `src/lib/loans.ts` — `deriveLoanState` precedence (closed > overdue > partial — pinned), `updateLoan` amount≥repaid guard under the per-loan mutex, `recordRepayment` clamp + skip-0, `deleteLoan`.
- `src/lib/shopping.ts` — `moveItem` bounds/no-op semantics (pinned), `reorderItems` batch; `deleteList` cascades items through the schema's `ON DELETE CASCADE` (`src-tauri/src/schema.rs:382`), so "takes every item in the list with it" is accurate.
- `GalleryPage.tsx` — `addLink` double-submit guard (`addingLinkRef` raised before the first await, cleared in `finally`, button disabled while `addingLink` — F6 repair, no regression); `loadFull`/`dropFull` full-resolution URL revocation; `refsGuard` around `listRefsForPhoto` (out-of-order select fixed); `removePhoto`/`removeLink` behaviour; mount-effect photo/thumb loading with cancellation.
- `LoansPage.tsx` — `addLoan`/`repay` guards and the `payingId === l.id` button disable (pinned by `submit-guards.test.ts`); `today` used for derived reads only (see C2).
- `ShoppingPage.tsx` — `addList`/`addItem` guards (pinned); `removeList`/`removeItem` behind `ConfirmButton`; `toggle`/`commitRename` are idempotent on repeat (double tap = same write twice, no anomaly).
- `MemoriesPage.tsx` — `submitForm` guard (pinned); focus effect keyed on `focusId`/`focusToken` with no `selectedId` dependency (the B1 trap is absent); delete behind `ConfirmButton`.
- `delete-guards.test.ts` and `submit-guards.test.ts` pass (all in-scope handlers guarded or exempt with stated reasons; ≥22 ConfirmButton controls; no destructive handler reachable from `onClick`).

Not re-reported: F6's `GalleryPage.addLink` guard (already fixed on `dev`); untranslated strings on these four pages — batch 2 classed Gallery/Loans/Memories/Shopping among the ten unmigrated pages as consistency debt, not a regression (`i18n.test.ts` pins catalogue parity, not page coverage).

## DECISION

No behaviour in scope requires a human policy call: every verified behaviour either matches its pinned tests and documented contract (warranty math, payable due status, loan state precedence, shop-receivable ordering, the `addLink` guard) or has a clear fix direction.

One call is optional rather than mandatory: for C2, choose whether `today` is refreshed on every interaction (read inside `reload`) or the page stays date-current while parked (a timer or date-change watcher). The app deliberately keeps pages mounted across the day, so this is a product/UX choice — the defect itself (stale date-derived reads) is clear and self-heals on the next interaction.
