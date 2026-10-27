# Findings — batch 4 audit: journal, inbox, habits (2026-10-27)

Base commit: `dev` at `a3088544` ("fix(audit): repair C1-C6 from the batch-3 findings", after the batch-3 fix merge).
Working branch: `arena/79ccf49a-purplememo` (PR target: `dev`). This document is the
only file in the PR; no source file was modified.

## Scope and method

Files audited in full, one at a time (sizes at base):

- `src/pages/JournalPage.tsx` (429 lines) + `src/lib/journal.ts` (105)
- `src/pages/InboxPage.tsx` (367) + `src/lib/inbox.ts` (311)
- `src/pages/HabitsPage.tsx` (358) + `src/lib/habits.ts` (187)

For each file I also read what it imports and what imports it, because seam bugs
live at the joins:

- `journal.ts` is consumed by `data/app.ts` (`journalRepo`, shared with `trashRepo`),
  `JournalPage.tsx`, the Notes "Send to journal" path (`NotesPage.tsx:871-877`),
  `lib/inbox.ts` (the journal conversion's upsert), `trash.ts` (`journal_entry`
  column list), and the export path (F7's `journalExportPath`, re-verified fixed at
  `exports.ts:291-296` — no regression).
- `JournalPage.tsx` is rendered only by `App.tsx:846-851` (search focus passes
  `focusDate`/`focusToken`) and is read by `submit-guards.test.ts` (the P2-6
  discard test) and `delete-guards.test.ts` (the `handleDelete` routing assertion).
  Its non-trivial imports were read in full: `lib/drafts.ts`, `components/ConfirmButton.tsx`,
  `components/MarkdownLink.tsx`, `lib/errors.ts`, and the date helpers in `lib/dates.ts`.
- `inbox.ts` is consumed by `data/app.ts` and `InboxPage.tsx` (`targetKey`), and is
  pinned by `lib/inbox.test.ts` (mock + real-SQLite layers). `InboxPage.tsx` is
  rendered only by `App.tsx:835` (the `capturesMade` signal prop).
- `habits.ts` is consumed by `data/app.ts`, `share.ts` (ticker), `DashboardPage.tsx`,
  and `HabitsPage.tsx`; `HabitsPage.tsx` is rendered only by `App.tsx:878-879`
  (no focus props — the search contract deliberately excludes habits and inbox,
  `searchContract.ts:233-238`).

I also read the DDL the three tables live on (`schema.rs`: `journal_entries`
:252-258, `habit_logs` :397-403, `inbox_items` :124-143), the i18n catalogue's
inbox keys, `format.ts` (the date renderer InboxPage calls), the Rust command
mutex (`commands.rs:75-95`, checked when assessing save/delete ordering), and the
tests that pin the behaviour examined: `journal.test.ts`, `inbox.test.ts`,
`habits.test.ts`, `drafts.test.ts`, `submit-guards.test.ts`, `delete-guards.test.ts`,
`stale-state-guards.test.ts`, `fan-out-guard.test.ts`.

Method: full read of every file in scope (no skimming), looking for race
conditions and stale-state rendering, wrong-row writes, missing submit/double-click
guards, render-time values used in writes, unsanitized paths, untranslated
user-facing strings, dead code and dead branches, wrong-date and wrong-requirement
logic, and behaviour that contradicts the code's own comments. Tests that pin
behaviour were checked; where a test pins current behaviour that looks wrong, the
entry is framed as a DECISION. Findings F1–F12 (`docs/Arena_Findings_261026.md`),
B1–B14 (`docs/Arena_Findings_Batch2.md`) and C1–C6 (`docs/Arena_Findings_Batch3.md`)
are already fixed on `dev` and are not re-reported; no fix has regressed (the
C2/C3 gates in `stale-state-guards.test.ts` and the F7 write-side validation in
`journal.ts:79-83` all still hold).

Tests run (in-scope suites only), exact command:

```
node --test src/lib/journal.test.ts src/lib/inbox.test.ts src/lib/habits.test.ts \
  src/lib/drafts.test.ts src/pages/submit-guards.test.ts src/pages/delete-guards.test.ts \
  src/pages/stale-state-guards.test.ts src/pages/fan-out-guard.test.ts
```

Result: 75/75 pass, 0 fail. No out-of-scope suite results are reported here.

## Findings

| ID | Area | Severity |
|----|------|----------|
| D1 | `src/lib/inbox.ts`, `src/pages/JournalPage.tsx`, `src/lib/drafts.ts` | Med-high |
| D2 | `src/pages/JournalPage.tsx` | Med |
| D3 | `src/pages/HabitsPage.tsx`, `src/lib/habits.ts` | Low-med |
| D4 | `src/pages/HabitsPage.tsx` | Low-med |
| D5 | `src/pages/JournalPage.tsx` | Low-med |
| D6 | `src/pages/InboxPage.tsx` | Low-med |
| D7 | `src/pages/InboxPage.tsx`, `src/lib/format.ts` | Low-med |
| D8 | `src/pages/JournalPage.tsx` | Low |
| D9 | `src/pages/JournalPage.tsx` | Low |
| D10 | `src/pages/InboxPage.tsx`, `src/pages/submit-guards.test.ts` | Low |
| D11 | `src/lib/inbox.ts` | Low |
| D12 | `src/lib/habits.ts`, `src/pages/HabitsPage.tsx` | Low |

---

### D1 — Inbox "Add to journal" writes the day behind the journal draft's back; the date-granular draft base hides same-day appends (block wiped on Save, or typing silently dropped)

**Evidence.**

- `src/lib/inbox.ts:140-155` — the journal conversion is one row-side batch
  (`INSERT ... ON CONFLICT(entry_date) DO UPDATE SET content = journal_entries.content || ? || excluded.content`,
  with `updated_at = excluded.updated_at = todayLocal()` at params `:147-154`).
  Nothing in `convert` (`:235-260`) touches `settings`-side journal drafts; the
  repo does not even receive a draft store.
- `src/pages/JournalPage.tsx:69-111` — `loadEntry` restores the day's draft
  whenever `draftBaseMatches(draft.baseUpdatedAt, base)` (`:86-87`), letting the
  draft win over the row (`draftContent ?? rowContent`, `:102-103`), and clears it
  as stale otherwise (`:97-99`).
- `src/lib/journal.ts:79-88` — `upsertEntry` stamps `updated_at = todayLocal()`,
  i.e. a **date-only** string (`dates.ts:50-52`), so a same-day write never moves
  the base.
- `src/lib/drafts.ts:8-13` — the stated policy: "once the row moves on (a save
  elsewhere, a backup import), the draft is stale and is dropped rather than
  resurrected over newer data"; `draftBaseMatches` is exact string equality
  (`:206-211`). With a date-only base, "the row moves on" is invisible within the
  same day.
- `src/lib/drafts.ts:108-114` — the app already names this hazard for the sibling
  path: the stored entry and the unsaved draft must be "folded identically —
  otherwise a restored draft would hide the appended note".
- `src/pages/NotesPage.tsx:879-895` — `handleToJournal` does exactly that fold:
  it reads `baseBefore`, then after the row append re-reads the day's draft and,
  if the base still matches, rewrites it with `appendJournalBlock(draft.content, block)`
  rebased to `todayLocal()`. The inbox path has no equivalent step.

**What is wrong.** Two loss modes, both triggered by converting an inbox capture
to journal on a day the user has unsaved journal typing:

1. *Same-day entry* — the entry was saved today, so `row.updated_at` is today and
   the draft was written against today. The conversion rewrites content but stamps
   the same date-only `updated_at`, so the base still matches: the journal page
   restores the draft **over the entry that now contains the appended block**.
   The block is invisible, and the next Save (`JournalPage.tsx:167-195`
   upserts `snapshot` over the row) permanently removes it. The inbox row stays
   `converted` pointing at that journal entry, so nothing ever re-appends it.
2. *First entry, or entry last saved a prior day* — base `null`/yesterday vs the
   conversion's `todayLocal()` → mismatch → `staleDraft` → the draft is cleared
   (`:97-99`) and the user's unsaved typing is silently discarded when they
   return to the page.

`inbox.test.ts:378-445` pins the row-side behaviour ("appends to today and never
overwrites") but involves no draft store, so neither mode is covered.

**User impact.** Silent data loss in both directions: either the captured note
vanishes from the journal on the next Save (while the inbox asserts it was
converted), or the user's unsaved reflection for the day disappears. The window
is ordinary usage: type in the journal, pop to the inbox, "Add to journal", come
back.

**Fix direction.** Mirror `NotesPage.handleToJournal`'s settings-side fold in the
inbox convert path: read the day's draft and the row's pre-append `updated_at`
before the batch, and after a successful claim rewrite a matching draft with
`appendJournalBlock(draft.content, block)` rebased to the new base (the row side
stays read-free, which is the constraint `drafts.ts:101-105` documents).
Alternatively (or additionally), make the draft base finer than a date so any
same-day external write invalidates it.

---

### D2 — JournalPage's Save runs against a day switch in flight: no `loading` gate, and the save's completion writes are not sequenced against the day load

**Evidence.**

- `src/pages/JournalPage.tsx:167-170` — `handleSave` snapshots
  `const date = activeDate; const snapshot = content;` at click time, with no
  `loading` check; the button (`:367-372`) is `disabled={saving}` only.
- The toolbar — including Save and Move to Trash — renders unconditionally
  (`:340-377`); `loading` gates only the editor pane's `loading` ternary
  (`:389+`). The day-cell click (`:306-309`) switches `activeDate` immediately,
  and `loadEntry` (`:69-111`) only replaces `content` after two awaits
  (`getEntry` + `loadJournalDraft`); its sequence token (`:71`, `:96`) governs
  loads only — `handleSave` neither reads nor participates in `loadSeqRef`.
- On completion the save writes `setEntryBase(base)` / `setSavedContent(snapshot)`
  unconditionally (`:177-178`), then `refreshGrid(yearMonthOf(date))` (`:189`).

**What is wrong.** Click day B, then Save before `loadEntry(B)` resolves: `date`
is B but `content` is still day A's editor text, so `upsertEntry(B, A's text)`
runs — a **wrong-row write**. If B had an entry, its stored content is replaced
by A's text (upsert does not trash the old content); if B had none, a phantom
entry is created. The window is the full load (two IPC round trips), plus the
post-paint effect gap where `activeDate` is already B while `loading` is still
false. The interleaving is symmetric: if `loadEntry(B)` resolves first and the
save's continuation lands afterwards, `savedContent`/`entryBase` are overwritten
with A's values while `content` holds B's — a false "Unsaved draft" badge, and
any subsequent keystrokes write drafts for B keyed on A's base, which the next
load then discards as stale.

**User impact.** On the fast path, one day's journal text overwrites another
day's entry with no trash copy; on the slow path, confusing unsaved-state
reporting and dropped drafts. Deliberate slow use stays safe — the only barrier
is the load's own latency.

**Fix direction.** Disable Save while `loading` (and early-return in
`handleSave` on the same condition), and gate the save-completion state writes
on the load sequence (or pair date/content/base from one loaded generation) so a
save can only report against the day whose content it snapshotted.

---

### D3 — HabitsPage's `toggle` has no in-flight guard: a double tap reverts the log or trips the UNIQUE constraint, and its reloads are unsequenced

**Evidence.**

- `src/pages/HabitsPage.tsx:99-106` — `toggle` awaits `toggleLog` then `reload`
  with no ref, no busy state, and no early return. Neither the "Mark done today"
  button (`:197-204`) nor the week-strip buttons (`:223-241`) is disabled while a
  toggle runs (only future month-grid cells are, `:333`).
- `src/lib/habits.ts:79-91` — `toggleLog` is a read-then-write: `getLog`, then
  `DELETE` if a row exists, else `INSERT`. Two clicks in the same direction
  sequentially = delete what the first insert wrote = **one intent, no log**.
  Two clicks interleaved before either write = both `INSERT`s, and the second
  violates `UNIQUE (habit_id, log_date)` (`schema.rs:402`), surfacing as a raw
  `UNIQUE constraint failed: habit_logs...` banner (`errText`, `errors.ts:11-12`).
- `src/pages/HabitsPage.tsx:47-75` — `reload` carries no sequence token, so two
  overlapping toggles' reloads can install the older snapshot last.
- Contrast: the gate's own rationale for the same shape elsewhere —
  "double-clicking Complete on a repeating task rolls its due date two periods"
  (`submit-guards.test.ts:203-205`) — and ShoppingPage's C5 reorder guard added
  in batch 3. `toggle` has no row in `submit-guards.test.ts`'s GUARDS table
  (HabitsPage's only row is `addHabit`, `:379-384`).

**What is wrong.** The page's primary action is the one action on the page
outside its own guard convention. `toggleLog` is not idempotent, so the
double-fire class the guards exist for is live here: the second click either
undoes the first or fails loudly at the database.

**User impact.** Double-tap "Mark done today" and the habit reads not-done
(confusion, extra taps), or the user gets a raw SQLite constraint message on an
error banner. Rapid toggling can also flash the pre-toggle state when an older
reload lands last.

**Fix direction.** Apply the page/repo convention: a per-row (or page-level)
busy ref raised before the first await, cleared in `finally`, with the row's
buttons disabled while it is set — plus a GUARDS row so the gate pins it.
Optionally make `toggleLog` itself atomic (single guarded statement) so the data
layer absorbs retries.

---

### D4 — HabitsPage computes `today` in the component body: after midnight the first click writes yesterday's date, today's cells lock, and `reload` is keyed on the render-captured value

**Evidence.**

- `src/pages/HabitsPage.tsx:32` — `const today = todayLocal();` in the component
  body; no `setInterval`/rollover anywhere in the file (grep: none).
- The value feeds a **write**: `onClick={() => void toggle(h.id, today)}` (`:201`);
  reads: `doneToday` (`:183`), the streak/week payload through
  `reload → habitProgressList(today)` (`:47-75`, call at `:53`), the "is-today"
  cell class, and `disabled={cell.date > today}` (`:333`).
- `reload` is keyed on the render value: `}, [today]);` (`:75`) — the exact shape
  `stale-state-guards.test.ts:51-76` forbids for Memories/Loans
  (`assert.doesNotMatch(src, /\}, \[today\]\);/)`) and the reason C2 required
  `todayLocal()` inside the reload plus a rollover tick.
- The page stays mounted as long as it is the active view (batch-3's parked-page
  premise), and nothing in it re-renders at the date change.

**What is wrong.** A page left open across midnight: the next render's `today`
changes only when something re-renders — but the *first* interaction is itself a
click on the stale render's closure. The first "Mark done today" tap after
00:00 calls `toggle(h.id, yesterday)`: it logs yesterday (harmless duplicate) or,
if yesterday was already logged (which is what the stale `doneToday` shows as
"Done today ✓"), **deletes yesterday's log**. Meanwhile the week strip and
streaks render the 7 days ending yesterday, and `cell.date > today` disables the
real today's cells — the new day reads as a future date — until that same
re-render. The read halves self-heal on that
same first click (`today` changes → `reload` identity changes → effect re-runs);
the write does not — it *is* the wrong write.

**User impact.** First-thing-in-the-morning logging lands on the wrong day and
can erase yesterday's entry; today appears as a disabled future date until the
first tap. Streak numbers are a day behind until the first interaction.

**Fix direction.** Read `todayLocal()` inside `toggle` and inside `reload` (the
C2 shape the gate already enforces for Memories/Loans), and add the date-rollover
tick those pages received; drop `today` from `reload`'s dependency list.

---

### D5 — The journal month grid's refreshes are unsequenced, and Save/Delete refresh the captured date's month rather than the month on screen

**Evidence.**

- `src/pages/JournalPage.tsx:61-68` — `refreshGrid(ym)` writes
  `setEntryDates(await ...datesInMonth(ym))` with no token or cancellation;
  `:113-115` re-runs it per `month` change. The month-nav buttons (`:242-261`)
  are never disabled.
- `handleSave` (`:189`) and `handleDelete` (`:208`) call
  `refreshGrid(yearMonthOf(date))` where `date` is `activeDate` captured at click
  (`:168`, `:198`) — not the month currently displayed.

**What is wrong.** Two stale-install paths, same family as batch-3 C3:

1. Rapid ‹/› clicks start overlapping `datesInMonth` queries; if an older query
   resolves last, the grid shows the previous month's entry dots (and the
   toolbar's `entrySet`-derived "Saved" badge, `:345-347`) under the new month's
   label until the next navigation.
2. Navigate months while a save/delete is in flight and the completion
   `refreshGrid` installs the *edited date's* month under whatever heading is
   on screen.

**User impact.** Wrong month's marked days / wrong "Saved" badge for a few
seconds; misleading on a calendar whose whole point is which days hold entries.
Self-heals on the next navigation or action; no data impact.

**Fix direction.** Give `refreshGrid` a monotonic token (only the newest load
may write), and have save/delete refresh the month shown *now* (read `month`
after the awaits via a ref), the pattern C3 installed in MemoriesPage.

---

### D6 — InboxPage's `reload` has no supersession, and the list never re-enters a loading/stale state after first paint

**Evidence.**

- `src/pages/InboxPage.tsx:67-82` — `reload` runs a chain of four awaits
  (`listOpen` → `listByStatus` → conditional archived → `liveTargets`, which
  issues up to three more queries) and writes
  `setLive`/`setItems`/`setConverted`/`setArchived` with no `cancelled`
  flag or sequence token; `setLoading(false)` occurs only in the `finally`
  (`:80`) and nothing ever sets `loading` back to `true`.
- Callers: the signal effect (`:90-92`), `capture` (`:114`), `convert` (`:139`),
  `archive` (`:152`), `removeCapture` (`:163`), and the "Show earlier" toggle
  (`:292`, which changes `reload`'s identity via `[showArchived]` at `:82`).

**What is wrong.** Two reloads can be in flight at once (e.g. a row action's
post-write reload and the `capturesMade` signal, or a row action and the
show-archived toggle). Whichever started earlier can resolve last and install
the older snapshot: expand "Earlier" while a convert/capture reload that started
before it is still running, and the newer archived list can be overwritten by
`away = []` (`:71`) — "nothing earlier" under an expanded section — or a just-converted
row can reappear as open. Nothing marks the list stale in the meantime (the
B9 second half), so the UI confidently shows pre-write data until the next
action.

**User impact.** Transient wrong lists — rows that were just archived/converted
shown as still open, or an empty "Earlier" section — until the next interaction;
no data impact.

**Fix direction.** A request token (or `cancelled` flag) per reload so only the
newest may write, and raise `loading` (or a staleness marker) while a reload is
running — the pattern BudgetPage's `MonthView` and MemoriesPage's C3 `loadMonth`
token use.

---

### D7 — InboxPage renders its date-only `created_at` through `formatDateTime`, which parses plain dates as UTC: fabricated clock times, and the previous day west of UTC

**Evidence.**

- `src/lib/inbox.ts:190-192` — `create` stores `todayLocal()` (a bare
  `yyyy-mm-dd`, `dates.ts:50-52`) as `created_at`.
- `src/pages/InboxPage.tsx:246` and `:337` — `formatDateTime(locale, row.created_at)`
  feeds `inbox.capturedAt` ("captured {date}") and `inbox.archivedAt`
  ("archived {date}") (`i18n.ts:228`, `:242`), and `formatDateTime` is invoked
  with `withTime: true`.
- `src/lib/format.ts:61-69` — `new Date("2026-10-27")` is a **UTC** parse per
  ECMAScript (date-only ISO forms), then formatted in the local zone. The helper's
  own comment claims the opposite: "The time is shown in the user's local clock,
  which is how it was stored" — but a plain date stores no time, and no local
  parse is applied (contrast `parseISODate` at `:49-53`, which exists precisely
  for the local-midnight rule, and JournalPage's own local parse at
  `JournalPage.tsx:221-227`).
- `format.test.ts:34-37` pins only a `yyyy-mm-ddTHH:mm` input, never a plain date.

**What is wrong.** Every capture/archived row renders a time nobody stored: in
UTC+ zones (Myanmar is UTC+06:30) all captures show a fixed fabricated time
(06:30 in MMT); in any zone west of UTC the *day* rolls back, so
a capture made on the 27th reads "captured Oct 26, 19:00". The helper comment
asserts fidelity the code does not deliver for plain dates.

**User impact.** Wrong-time (always) and wrong-day (negative offsets) labels on
every inbox row; confusing when dating a capture, harmless to stored data.

**Fix direction.** Render plain dates through `formatDate` (already exists,
`format.ts:55-59`), or make `formatDateTime` route `yyyy-mm-dd` inputs through
the local-midnight `parseISODate` so its comment becomes true. (Other callers of
this shared helper are outside this batch's scope and should be checked
separately.)

---

### D8 — `handleSave` lacks the early-return half of the repo's submit-guard convention (state `disabled` only)

**Evidence.**

- `src/pages/JournalPage.tsx:167-170` — no `savingRef`/early return; the first
  statement that defends is `setSaving(true)` (raise-before-await and
  `finally`-clear at `:170`/`:192-194` are correct), and the button reads
  `disabled={saving}` (`:369`).
- The gate's four-part shape requires the early return as *the invariant*
  (`submit-guards.test.ts:5-18`, `:547-582`); `handleSave` has no GUARDS row at
  all (the file's JournalPage coverage is only the P2-6 discard test at `:768`).
- Same-file precedent: `handleDiscardDraft` does check first —
  `if (saving) return;` (`:161`), pinned at `submit-guards.test.ts:768-796`.

**What is wrong.** The page's only submit handler sits outside the convention
every other write handler follows. Practical damage today is minimal: two
identical upserts of `(date, content)` are idempotent (same values, same
`todayLocal()` stamp), so a double-click writes the same row twice with no
observable difference — this is a convention gap, recorded honestly as such
rather than a live anomaly.

**User impact.** None today. The gap is that the next non-idempotent addition to
`handleSave` inherits no guard and no gate coverage.

**Fix direction.** Add the pinned shape (`savingRef` raised before the first
await, cleared in `finally`, `if (savingRef.current) return`) and a GUARDS row
for `handleSave`.

---

### D9 — JournalPage's "is today" marker derives from a render-time `today` that goes stale while the page is parked

**Evidence.** `src/pages/JournalPage.tsx:219` (`const today = todayLocal();` in
the component body) consumed at `:301` (`cell.date === today ? "is-today"`); no
timer or rollover tick in the file (grep: none). The Today button correctly
re-reads `todayLocal()` at click time (`:324-327`).

**What is wrong.** Read-only instance of the C2 family: a page parked across
midnight keeps yesterday's ring on yesterday's cell until the first interaction
re-renders. No writes depend on this value, and the active date itself is
explicitly displayed (`:343-344`), so nothing is mislabelled — only the
highlight lags.

**User impact.** Cosmetic: after midnight the "today" ring sits on the 27th
until anything re-renders.

**Fix direction.** Same as C2's shape (recompute from a rollover tick or at
grid-build time), or accept and document — see DECISION note 2.

---

### D10 — The gate's comment says the conversion guard is per-row and "does not lock the list"; the guard and the button disables are global, and `archive` has no guard at all

**Evidence.**

- `src/pages/submit-guards.test.ts:175-177` — "the conversion guard is **per
  row** so one row's click does **not lock the list** — the reason it needs an
  explicit `raised`."
- `src/pages/InboxPage.tsx:125` — `if (convertingRef.current !== null) return;`:
  any conversion in flight blocks every conversion, regardless of row.
- `:256` and `:265` — every row's three convert buttons **and** the archive
  button are `disabled={convertingId !== null}` — one row's click locks the
  whole list's actions, the opposite of the comment's claim.
- `:148-156` — `archive` carries no ref, no busy state, and no in-flight
  feedback (contrast `capture`/`convert`, which have both); during an archive
  nothing disables it or the convert buttons until a separate reload happens to
  re-render. Its write is guarded on `status = 'open'` (`inbox.ts:216-221`) so a
  double-click is an idempotent no-op.

**What is wrong.** The gate's stated rationale misdescribes the code it pins — a
reader auditing from the comment would conclude row-level locking is in force
(it is not), and would not notice `archive` sits outside the page's own
in-flight convention. During a conversion the UI is globally locked (usually
invisible — one IPC round trip). The sharper consequence of `archive` having no
busy state at all: while an archive write is in flight, nothing disables the
convert buttons, so a quick Convert click after Archive races it — if the
archive commits first, the user's *later* convert intent is refused with the
D11 "was archived" / "not converted" error and the capture lands as archived.

**User impact.** No direct data harm (archive idempotent; conversion idempotent;
the disabled state stops ordinary sequential clicks). Misleading gate comment,
absent in-flight feedback on Archive, and a reachable race that can file a
convert-intent as archived (the capture then cannot be converted at all —
`inbox.ts:238-242` refuses archived rows).

**Fix direction.** Align code and comment: either make the disables per-row
(`convertingId === row.id`) to honour the stated intent — the data layer already
handles concurrent converts on different rows — or correct the comment to say
the lock is global and why; and give `archive` the page's busy-ref treatment so
its double-click never reaches the database twice either.

---

### D11 — `inbox.ts`'s user-visible error messages bypass the catalogue on an otherwise fully translated page

**Evidence.**

- `src/lib/inbox.ts:237` ("That capture no longer exists."), `:239-241` ("That
  capture was archived, so there is nothing to convert."), `:255-258` ("The
  capture was not converted and nothing was written. Try again."), `:188` ("Type
  something before capturing.") — raw English `Error` messages.
- `src/lib/errors.ts:11-12` — `errText` returns `e.message` verbatim.
- `src/pages/InboxPage.tsx:140-141`, `:153-154`, `:164-165` — the catch blocks
  render those messages directly into the error banner.
- The page itself is fully localized (`t()` throughout; `capture.empty` at
  `:105` even reuses the catalogue key whose English text duplicates
  `inbox.ts:188` — `i18n.ts:113`), and no `inbox.*` keys exist for the three
  convert errors.

**What is wrong.** The convert errors are reachable precisely on the race/stale-list
paths (delete a row then click its stale convert button; the archive-then-convert
race of D10) — and each renders English to a Burmese user on the one
inbox screen that is otherwise translated. This is the F8 message-class problem
(missing-row/errors shown as raw page copy) applied to a migrated page's data
layer.

**User impact.** Untranslated error sentences at the moments the user most needs
an explanation (a failed or raced conversion); the "Try again." advice even
suggests retrying an action that may now be permanently refused.

**Fix direction.** Add `inbox.convertGone` / `inbox.convertArchived` /
`inbox.convertFailed` (EN + MY) and either throw keyed errors from `inbox.ts` or
map the known messages to keys in the page's catch; keep `errText` for genuinely
unexpected failures.

---

### D12 — Dead code: two uncalled habits repo methods, an unread progress field, and two unreachable grid-key fallbacks

**Evidence.**

- `src/lib/habits.ts:94-99` — `listLogs` has no caller anywhere in `src/`
  (repo-wide grep: definition only), not even a test.
- `src/lib/habits.ts:166-187` — `habitProgress` (single-habit variant) has no
  caller anywhere: `share.ts:264` and `DashboardPage.tsx:171` use
  `habitProgressList`, `HabitsPage.tsx:53` uses it too, and `fan-out-guard.test.ts:40-57`
  pins that pages *must not* call it. Its header comment still describes it as
  the method that "suits a page showing one habit" — no such page exists.
- `src/pages/HabitsPage.tsx:60` — the progress map stores `habit: p.habit`, but
  the render reads only `p?.current` / `p?.best` / `p?.week` (`:183`, `:193`,
  `:220`); the habit list comes from `progs.map(p => p.habit)` (`:54`). The
  stored copy is never read.
- `src/pages/HabitsPage.tsx:309-311` and `src/pages/JournalPage.tsx:276-277` —
  the `week.find(...) ?? <blank-key>` fallbacks for an all-blank week are
  unreachable: `buildMonthGrid` (`journal.ts:32-48`) pads with at most 6 leading
  and 6 trailing blanks, so every emitted week contains at least one dated cell.

**What is wrong.** Nothing functionally — but `listLogs` and `habitProgress`
read as supported API (one of them with a doc comment justifying its existence)
while nothing can reach them, and the fallbacks advertise a grid shape that
cannot occur.

**User impact.** None directly; maintenance cost — a reader cannot tell which
habits entry points are live, and a reader reintroducing `habitProgress` per row
would recreate the N+1 fan-out the gate exists to prevent (the gate bans it on
three pages, not repo-wide).

**Fix direction.** Delete the two unused methods (or wire them to a real
consumer), drop the unread `habit` field from the page's `HabitProgress`, and
simplify the unreachable key fallbacks.

---

## DECISION

**1. "This week" label vs the rolling window (behaviour pinned by test).**
`HabitsPage.tsx:218` labels the strip "This week" and the page subtitle promises
"weekly check-ins", but `weekProgress` is "The 7 days **ending today**"
(`habits.ts:35-47`) — a rolling Wed→Tue window, not the calendar week shown in
the month grid directly below (`buildMonthGrid` is Sunday-start calendar weeks).
`habits.test.ts:52-66` pins the rolling behaviour explicitly (today = 2026-10-10
expects a strip starting 2026-10-04), and DashboardPage/share render the same
`week` field. A human must choose: (a) the rolling window is intended — relabel
the strip ("Last 7 days") and align the subtitle, or (b) the calendar week is
intended — change `weekProgress` (and its pinned test, plus the Dashboard/share
consumers). Either way it is a product call, not a silent code fix.

**2. Parked-page midnight policy (carried over from batch-3's C2 decision).**
Batch 3 left it open whether parked pages refresh their date-derived reads on
rollover or only on the next interaction. Batch 4's Journal instance (D9) is a
pure highlight and falls under whatever that call is — but D4's *write* half
("Mark done today" logging yesterday) is a defect regardless of the policy and
should be fixed even if the read halves are declared acceptable.

## Checked and found clean

These areas were examined in full and no issue was found; they bound the audit:

- `src/lib/journal.ts` — `buildMonthGrid` Sunday-start maths, leading/trailing
  blanks and invalid-month `[]` (pinned by `journal.test.ts`), `monthLabel`,
  `datesInMonth`'s `substr` query, `upsertEntry`'s write-side date validation
  (F7's fix intact: `:79-83` throws before any write), ON CONFLICT updating only
  `content`/`updated_at`, `deleteEntry` → `trash.trashEntity("journal_entry", id)`
  (column list exists at `trash.ts:74`; a second delete is a harmless no-op
  because the read precedes the trash write).
- `src/lib/inbox.ts` data layer (outside D1/D11) — conversion idempotency is real
  and pinned against **actual SQLite**: one batch, every statement guarded on
  `status = 'open'`, racing converts produce exactly one target
  (`inbox.test.ts:345-377`), archived/deleted rows refused (`:447-459`), a lost
  claim is reported not swallowed (`:548-553`);
  `converted_*` treated as historical (target deletion keeps the
  row); `liveTargets` uses a code-owned table map with bound ids and handles
  unknown types without SQL interpolation; blank bodies refused at both layers;
  all SQL parameters bound (no user text as syntax); the `inbox_items` CHECKs
  (`schema.rs:124-143`) bound `converted_type`/`status`, so the page's
  `TARGET_LABELS[row.converted_type]` index (`InboxPage.tsx:36-39`) cannot see an
  unknown key under an enforced schema.
- `src/lib/habits.ts` (outside D3/D12) — `currentStreak`'s
  today-not-logged grace and gap break, `bestStreak`'s consecutive-run maths,
  `weekProgress` window (pinned), `habitProgressList`'s two-query batch, id
  scoping and "limit caps habits, never dates" semantics (all passing in
  `habits.test.ts`); `deleteHabit`'s "cascades to every habit_logs row" comment
  matches `schema.rs:399 ON DELETE CASCADE`.
- `JournalPage.tsx` plumbing — `loadEntry`'s monotonic token correctly discards
  superseded loads for both state and error/loading (`:96`, `:104-108`); the focus
  effect is keyed on `focusDate`/`focusToken` only (no B1-style `selectedId`
  dependency trap) and jumps month+day together (`:118-125`); `handleDiscardDraft`
  refuses while saving, before touching state (P2-6, pinned); the
  save-time draft rebase (`:179-188`) correctly keeps keystrokes typed during a
  save; `readableActiveDate` parses dates locally (`T00:00:00`, no UTC shift,
  unlike D7's path); Delete is behind ConfirmButton with `handleDelete` as the
  named handler (routed assertion at `delete-guards.test.ts:227-230`).
- `InboxPage.tsx` guards — `capture` and `convert` raise a ref before their first
  await, clear in `finally`, and disable their buttons with catalogue busy labels
  (pinned GUARDS rows, `submit-guards.test.ts:178-193`); the textarea's Enter
  path goes through the same ref (`:201-206` → `:102-122`); all three delete
  buttons are behind ConfirmButton (open row `:270-276`, converted `:322-328`,
  archived `:341-347`) — `deleteItem` is
  routed through the named `removeCapture`, satisfying `delete-guards`' scan; the
  convert toast deliberately hedges authorship so it stays true when another call
  won the race (`:124-139`); the page has zero raw user-facing strings in its own
  JSX (D11 is the data layer only).
- `HabitsPage.tsx` (outside D3/D4/D12) — `addHabit` is the pinned guard shape
  (ref/state/finally, disabled submit, `:81-96`); delete is behind ConfirmButton
  with the habit named in `what` (`:207-213`) and `removeHabit` routing asserted
  (`delete-guards.test.ts:222-225`); future month-grid cells are disabled
  (`:333`); first paint uses the batch methods, not per-habit fan-out
  (`fan-out-guard.test.ts:58-79`); the page/search contract deliberately
  excludes habits (`searchContract.ts:233-238`), so the absent focus props are
  not a gap.
- Shared imports read for this batch — `ConfirmButton` (two-step state machine,
  awaited `onConfirm` with `common.wait` busy label, refuses re-fire even on
  throw), `MarkdownLink` (only `routeLink`-approved schemes reach the opener
  plugin, hashes scroll in-document, Rust navigation guard as backstop),
  `errText` (string rejections render, never `[object Object]`).
- Save/delete interleaving on JournalPage — the Rust side serializes all DB
  commands through one connection mutex (`commands.rs:75-95`), so an in-flight
  save and a confirm-delayed delete are not claimed here as an ordering bug; the
  analysis is limited to the UI-side races evidenced above.
- No regression of any batch-1–3 fix inside these six files: F7's journal export
  path validates then sanitizes (`exports.ts:291-296`), the C2/C3/C4/C6 gate
  patterns pass, and `submit-guards`/`delete-guards` pass in full (75/75 in-scope,
  exact command above).

Not re-reported: untranslated strings on `JournalPage.tsx` and `HabitsPage.tsx`
— batch 2 (B13) classed both pages among the ten unmigrated pages as consistency
debt, not a regression (`i18n.test.ts` pins catalogue parity, not page coverage);
this batch does not restate that debt, only the new instance on the *translated*
Inbox page (D11).
