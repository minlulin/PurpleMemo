# Findings — batch 2 audit: contacts, tasks and vault (2026-10-26)

Line numbers are against this branch at `c7c80f6` (base `dev`, after the
F1–F12 repairs). Nothing here is fixed by this document — it records what was
found, with the evidence for each claim, so the fixes can be reviewed
separately.

Scope: `ContactsPage.tsx` (845 lines), `TasksPage.tsx` (727),
`VaultPage.tsx` (613), `lib/tasks.ts` (284) and `lib/vault.ts` (410), plus the
files they lean on — `lib/contacts.ts`, `lib/contactImport.ts`, `lib/csv.ts`,
`components/ImportDialog.tsx`, `lib/loads.ts`, `lib/session.ts`, `lib/dates.ts`,
`lib/crypto.ts`, `lib/taskImport.ts`, `lib/trash.ts`, `App.tsx`'s routing and
focus plumbing, the `contacts` / `contact_channels` / `contact_tags` / `tasks` /
`reminders` / `vault_items` / `settings` DDL in `schema.rs`, and the page gates
(`submit-guards.test.ts`, `delete-guards.test.ts`).

The point of the pass was the parts a diff review does not hold in one head: a
focus effect against the state it depends on, a page handler against the id it
captured before an await, a repository method against the contract written in
its own header comment, and a lock against the asynchronous work still in
flight when it runs.

Two notes on relation to batch 1:

- F6's unguarded inline add-forms are **repaired** here: `addChannel` and
  `addTag` now carry `addingChannelRef` / `addingTagRef` and disable their
  buttons (`ContactsPage:307-330`, `352-370`). That is not re-reported.
- F11's render-time `today` recurs on TasksPage (B8), and the batch-1 note
  about `submit-guards.test.ts` covering only one handler on the two largest
  pages still holds (B10).

## Summary

| # | Area | Severity | Finding |
|---|------|----------|---------|
| B1 | `ContactsPage.tsx` | Med-high | The focus effect depends on `selectedId`, so after a relationship/search jump every other contact click is reverted |
| B2 | `ContactsPage.tsx` | Med | Six handlers reload the detail with the id captured before their `await`; switching contacts mid-write leaves the wrong contact's data in the pane — and in the edit form |
| B3 | `VaultPage.tsx` | Med-low | "Lock vault" clears the revealed secrets and the edit form but not the new-secret draft or the typed change-password fields |
| B4 | `lib/vault.ts` | Low-med | `lockVault()` cannot cancel an in-flight key derivation, so a key can be cached again after the lock |
| B5 | `lib/vault.ts` | Med-low | `updateItem` never proves the password when a plaintext is supplied; a wrong password re-encrypts the item under a key derived from it |
| B6 | `VaultPage.tsx` | Low-med | Reveal/edit/list have no generation guard (unlike `ContactsPage`), so a slower older `getItem` can open the edit form on the previously clicked item |
| B7 | `VaultPage.tsx` | Low | Changing the password rewrites every row's `updated_at` but the page never reloads the list, so every "updated" chip keeps the old date |
| B8 | `TasksPage.tsx` | Low | `today` is captured at render and feeds both the overdue badge and the due-date write |
| B9 | `TasksPage.tsx` | Low-med | A "Show done" flip can be overwritten by an in-flight reload from a row action; nothing marks the list stale while it reloads |
| B10 | `TasksPage.tsx` | Low | `RemindersSection`'s `remove`/`snooze`/`acknowledge` carry none of the page's guard convention, and its add form does not reset `repeat` |
| B11 | `ContactsPage.tsx`, `TasksPage.tsx` | Low | A missing focus target is reported twice — error banner and empty state, same key |
| B12 | `VaultPage.tsx` | Low | A failed `isSetUp()` read is rendered as "the vault does not exist yet" (the setup form) |
| B13 | `VaultPage.tsx` | Low | The page is not on the i18n catalogue at all — 0 `t()` calls, no `vault.*` keys |
| B14 | `lib/tasks.ts` | Low | `nextDueDate`'s catch-up loop is unreachable; an overdue repeat is re-anchored to the completion day, and the "pathological" comment describes code that cannot run |

## B1 — The contact page cannot be navigated after arriving at a contact

`src/pages/ContactsPage.tsx:206-232`

The focus effect hands `selectedId` to React as a dependency, and its body
calls `select` — which sets `selectedId`:

```ts
if (selectedId === focusId) {
  await reloadDetail(focusId, false);
} else {
  await select(focusId);          // :223  select() does setSelectedId(focusId)
}
...
}, [p.focusId, p.focusToken, selectedId, reloadDetail]);   // :232
```

`p.focusId` is not a one-shot: `App.tsx` keeps `focus` until `navigate()` clears
it (`App.tsx:320-330`), and `focusedRowFor` hands the id to every ContactsPage
render (`navigation.ts:89-94`, `App.tsx:902-910`). So the effect runs again on
**every** selection change, and when the user clicks contact B while the page
was opened at contact A it sees `selectedId !== focusId` and calls
`select(A)` again. The sidebar highlight snaps back, the detail pane returns to
A, and the page stays pinned to A until the user leaves and comes back.

The same effect also breaks the page's own create flow: `addContact` ends in
`await select(id)` (`ContactsPage:244`), and the re-run immediately replaces the
new contact with the focus target.

The repository already has the correct shape: `NotesPage`'s focus effect is
keyed on the focus id and token only, with no selection state in the dependency
list (`NotesPage.tsx:470-499`). `ContactsPage` needs the same, with the current
selection read from a ref (or the handled token remembered) instead of being a
dependency. There is also a smaller symptom on arrival: the effect runs twice
(select → `selectedId` changes → `reloadDetail`), so the detail is fetched twice.

## B2 — A detail reload started before a contact switch wins the guard and shows the old contact

`src/pages/ContactsPage.tsx:286-305` (`saveContact`), `:309-330` (`addChannel`),
`:332-350` (`makePrimary` / `removeChannel`), `:354-380` (`addTag` /
`removeTag`), guard at `:152-179`

`reloadDetail` has a token guard that is correct for *selection* races — an
older detail load cannot overwrite a newer one (`:160-163`). But every write
handler captures `selectedId` at click time and calls `reloadDetail` **after**
its await:

```ts
await contactsRepo.updateContact(selectedId, { ... });   // :292
await reload();
await reloadDetail(selectedId, true);                    // :301  old id, new token
```

Sequence: select A, edit the form, press Save; while the update is in flight,
click contact B (the list is not disabled). `select(B)` starts its own
`reloadDetail(B)` and finishes first. Save then starts `reloadDetail(A)` with a
*higher* token, so the guard accepts it: `detail` becomes A, and because
`repopulateForm` is true, `edit` is refilled with A's name/address/birthday/
notes while `selectedId` is B. The heading shows A's name above a sidebar that
highlights B, and the form now holds A's values under B's selection — pressing
Save again calls `updateContact(B, A's fields)`. That second click is what
turns a display bug into a wrong-row write; the mislabelled pane happens on its
own.

`addChannel` (`:323`), `addTag` (`:363`), `makePrimary` (`:336`),
`removeChannel` (`:346`) and `removeTag` (`:376`) have the same shape with a
narrower effect (they reload `repopulateForm: false`, so only the pane is
wrong).

Fix direction: reload the detail for `selectedId` **as it is now** (a ref, or
`reloadDetail` reading the current selection), and treat a switch as
invalidating the in-flight write's refresh rather than as a newer request.

## B3 — Locking the vault leaves the secret draft and the typed passwords in state

`src/pages/VaultPage.tsx:126-133`, state at `:44-57`, forms at `:407-455` and
`:569-608`

```ts
const doLock = () => {
  vaultRepo.lockVault();
  setPassword(null);
  setRevealed(new Map());
  setEdit(null);
  setItems([]);
  setPhase("unlock");
};
```

Everything that holds plaintext **except two fields** is cleared. `draft`
(`:46`, the new-secret title + plaintext) and `change` (`:52-57`, the three
password strings) survive. `change.open` also survives, so after unlocking the
change-password form reappears with the old password still in `change.old`, and
the "New secret" form (`:575-593`) is on screen with `draft.secret` in a plain
textarea. (This is the manual button; the app-level lock unmounts the page.)

The page's own comments treat the password as page memory only, and
`lockVault` is documented as "drop all in-memory keys", so the omission reads as
an oversight rather than a deliberate "don't lose typing" choice — especially
for `change.old`, which is a credential and is never meant to outlive the form.

Fix: clear `draft`, `change` and `error` in `doLock`, next to `setEdit(null)`.

## B4 — A key derived before the lock is cached after it

`src/lib/vault.ts:167-188` (`deriveItemKey`), `:261-281` (`addItem`),
`:256-259` (`lockVault`)

`lockVault` is synchronous:

```ts
lockVault(): void {
  keyCache.clear();
},
```

but both writers of the cache sit after awaits:

```ts
const rows = await driver.query(...);       // :178
const salt = rows[0]?.salt;
const key = await deriveVaultKey(password, salt);   // :184  600k PBKDF2
keyCache.set(itemId, entry);                        // :186
```

`addItem` does the same after its `INSERT` (`:269-280`). `VaultPage.doLock`
(`:126-127`) calls `lockVault` while `toggleReveal` (`:151-171`) or `startEdit`
(`:173-183`) may be awaiting a cold-item derivation of hundreds of milliseconds,
so the clear happens on an empty cache and the key lands immediately afterwards.
The vault then stays locked with a decrypting `CryptoKey` still in the module
cache — which is exactly the window `lockVault`'s comment says it bounds.

The practical exposure is small (every use still re-checks the password tag, and
the key is non-extractable), but the guarantee is false as written. A generation
counter checked before `keyCache.set`, or a `locked` flag that `deriveItemKey`
re-checks after its awaits, would make it true.

## B5 — `updateItem` accepts a wrong password and re-encrypts under the wrong key

`src/lib/vault.ts:311-337`

`getItem` proves the password by decrypting the stored ciphertext (`:303-306`,
`decryptItem` at `:56-68`). `updateItem` skips that proof whenever the caller
supplies the new plaintext — which is exactly what the edit form does:

```ts
const { key } = await deriveItemKey(id, password);          // :322
const plaintext =
  fields.plaintext ??
  (await decryptItem(key, { ciphertext: row.ciphertext, iv: row.iv }));  // :323-325
const cipher = await encryptWithKey(key, plaintext);        // :326
await driver.execute(
  "UPDATE vault_items SET title = ?, ciphertext = ?, iv = ?, updated_at = ? WHERE id = ?",
  [fields.title ?? row.title, cipher.ciphertext, cipher.iv, todayLocal(), id],
);
```

`deriveItemKey` does not fail on a wrong password — the tag only decides whether
a cached key can be reused; otherwise it derives a fresh key from whatever
password it was given (`:173-186`), caches it, and returns it. So
`updateItem(id, { plaintext }, wrongPassword)` encrypts the item under a key
derived from the wrong password, keeps the item's existing salt, and reports
success. The item is then undecryptable by the real password
(`decryptItem` → `OperationError` → `WrongPasswordError`), and because `unlock`
proves against `MIN(id)` (`:227-240`), corrupting the lowest-id item makes the
correct password rejected for the whole vault.

Not reachable from the UI today — `VaultPage.saveEdit` only ever passes the
password that was proven at unlock (`VaultPage:185-195`) — so this is a latent
trap, not a live defect. It is worth fixing anyway because it is the one write
path that violates the header comment's contract ("a cached key never bypasses
password validation") and the damage is permanent. `updateItem` should decrypt
the stored ciphertext with the supplied password before re-encrypting, even when
the new plaintext is supplied.

## B6 — Reveal and edit can render a result for the wrong row

`src/pages/VaultPage.tsx:151-183`, list at `:77-85`

Both handlers await a per-item `getItem` (a cold item costs a 600k-iteration
PBKDF2 before decryption) and then write the result straight to state with no
sequence check:

```ts
const startEdit = async (item: ItemMeta) => {
  ...
  const got = await vaultRepo.getItem(item.id, password);
  setEdit({ id: item.id, title: item.title, secret: got?.plaintext ?? "" });
```

Click Edit on A, then B: if A resolves last, the edit form opens on A even
though B was the last click. `loadItems` (`:77-85`) has the same problem — an
older list read can land after a newer one — so a reveal/refresh pair can leave
a stale list.

`ContactsPage` uses `createLoadGuard()` for exactly this hazard
(`ContactsPage:129`, `:152-163`; `lib/loads.ts`), and `loads.test.ts` pins the
helper. `VaultPage` imports nothing from `loads.ts`. A guard per load (or a
request token) is the established fix. Reveal is less visible than edit (it only
toggles a row), but the same pattern is what opens the wrong secret in the edit
form, so both should be guarded.

## B7 — The "updated" dates go stale after a password change

`src/pages/VaultPage.tsx:221-244`; `src/lib/vault.ts:390-396`

`changePassword` rewrites every item — it has to, because every item gets a new
salt and ciphertext — and the batch sets a fresh `updated_at`:

```sql
UPDATE vault_items SET ciphertext = ?, salt = ?, iv = ?, updated_at = ? WHERE id = ?
```

`doChangePassword` updates `password` and closes the form, but never calls
`loadItems()`. `items` is still the pre-change metadata, so every row keeps
showing the old date (`VaultPage:481`, `updated {item.updated_at}`) until the
user navigates away and back. Every other vault write ends in `loadItems()`
(`:143`, `:200`, `:215`), which makes this the odd one out.

## B8 — `today` is captured at render and used for a due-date write

`src/pages/TasksPage.tsx:75`, `:199`, `:302`

```ts
const today = todayLocal();                       // :75, component body
...
await tasksRepo.completeTask(t.id, today);        // :199
...
{overdue(task.due_date, today) ? ...}             // :302
```

Anything that leaves the page mounted across midnight (this is the page the app
deliberately stays on) computes the overdue badge from yesterday, and — the
half that writes — hands `completeTask` yesterday, so a repeating task is
re-anchored one day early. `reload()` re-renders after every action, so the
window closes on the next interaction, but a task completed first thing in the
morning can still roll from the wrong day. This is the batch-1 F11 shape; the
difference is that BudgetPage has no timer either, so the same fix applies:
read `todayLocal()` inside `complete`, and derive `overdue` from a value that is
recomputed by the reload rather than by the render.

## B9 — The "Show done" filter can be overtaken by a row action's reload

`src/pages/TasksPage.tsx:107-120`, `:193-206`, `:280-286`

`reload` is a `useCallback` over `showDone` (`:107-116`); the effect re-runs it
when the flag changes (`:118-120`), but `complete`/`reopen`/`remove` hold the
`reload` from the render they were clicked in. Sequence: with "Show done"
ticked, click Complete on a row; while the two IPC calls plus the reload are in
flight, untick the box. The new `reload` (`listTasks(false)`, open rows only)
resolves first; the handler's older `reload` (`listTasks(true)`) resolves last
and writes the full list into state while the box is unticked. The completed
section then renders under an unchecked box until the next action. Nothing marks
the list as stale during the flip: `loading` starts true and is set false in the
first `reload`'s `finally` (`:113-115`) and never set back, so the skeleton at
`:263` shows only on first paint.

Fix direction: a request token in `reload` (the pattern used by
`MonthView`/`YearView` in BudgetPage), or read the current filter at write time
instead of closing over it.

## B10 — `RemindersSection` is outside the page's own guard and reset conventions

`src/pages/TasksPage.tsx:551-568` (`add`), `:570-577` and `:585-609`
(`remove`/`snooze`/`acknowledge`)

The page's task handlers all follow the pinned shape — `addTask` raises
`savingRef`/`saving` (`:167-190`), and the row actions share `busyRow`
(`:193-232`) — but the reminders half does not:

```ts
const remove = async (id: number) => {
  try { await tasksRepo.deleteReminder(id); await reload(); } ...
};
const snooze = async (id: number) => { ... };        // no flag at all
const acknowledge = async (id: number) => { ... };   // no flag at all
```

Today the second click is harmless because all three end in an idempotent
write, so this is a convention gap rather than data loss. It becomes real the
moment `acknowledge` grows a state column. The gate cannot see it either:
`submit-guards.test.ts` resolves a handler name with a first-match brace scan,
and its own comment says `` `remove` resolves to the task-row handler: it is
declared first in the file, ahead of RemindersSection's own `remove` ``
(`submit-guards.test.ts:179-181`) — so none of the three is asserted.

The same section's add form is missing the reset half of the page's convention:

```ts
await tasksRepo.createReminder({ title: trimmed, remindAt, repeat });   // :558
setTitle("");
setRemindAt("");
// repeat stays where the last reminder put it
```

`addTask` resets `repeat` to `"none"` (`:183`). Adding one daily reminder and
then several one-offs silently creates more daily reminders.

## B11 — A missing row is announced twice

`src/pages/ContactsPage.tsx:214-217`, `:417`, `:776-780`;
`src/pages/TasksPage.tsx:139-140`, `:265`, `:380-384`

Both focus paths set `focusMissing` **and** an error with the same catalogue
text:

```ts
setFocusMissing(true);
setError(t("contacts.missing"));   // ContactsPage:215-216
```

and both pages render the error banner (`Contacts:417`, `Tasks:265`) next to an
empty state that prints the same key (`Contacts:778`, `Tasks:382`). For a
deleted row the user gets the sentence twice; for any other error the banner and
the empty state can disagree. `focusMissing` alone (with the error banner
reserved for actual failures) says it once.

## B12 — A failed vault read is shown as "there is no vault yet"

`src/pages/VaultPage.tsx:59-75`

```ts
try {
  const setUp = await vaultRepo.isSetUp();
  if (!cancelled) setPhase(setUp ? "unlock" : "setup");
} catch (e) {
  if (!cancelled) {
    setError(errText(e));
    setPhase("setup");                 // :68
  }
}
```

A locked database, a failed IPC call or a corrupt settings read is rendered as
the **setup** screen: "Set a vault password", the no-recovery warning, and a
form. The write path re-checks `isSetUp()` (`vault.ts:203-220`) so an existing
vault cannot actually be overwritten — the guard holds — but the screen asserts
the wrong fact, and the "There is NO recovery" copy next to an unexplained
error invites a user to type a *new* password. This is the same class as the
`isSetUp`/`unlock` hardening already recorded in the repo history: a failure
must not be answered with a reassuring, wrong sentence. A separate
"unavailable" phase (or keeping `loading` and showing the error) is the honest
rendering.

## B13 — The vault page is not on the i18n catalogue at all

`src/pages/VaultPage.tsx` (0 `t()` calls); `src/lib/i18n.ts:96`, `:697`
(`nav.vault` only)

Every user-facing string is English: the title "Encrypted Vault" (`:254`), the
buttons "Change password" / "Lock vault" (`:269`, `:272`), "Wrong password —
nothing was unlocked." (`:120`), "Could not decrypt this item — wrong password."
(`:168`, `:180`), the whole setup screen including "There is NO recovery"
(`:311`), "Stored Secrets" (`:468`), "Reveal"/"Hide" (`:496`), "New secret"
(`:575`), `Add secret` (`:605`), and `what="secret"` passed raw to
`ConfirmButton` (`:507`), which renders its own translations around it — so a
Burmese user gets a Burmese "Delete …" with an English noun inside.

Ten of the eighteen pages are still unmigrated (Budget, Exports, Gallery,
Habits, Journal, Loans, Memories, More, Shopping, Vault), so this is
consistency debt rather than a regression. It is listed because the vault is
where the copy carries the security contract, and because `i18n.test.ts` only
pins catalogue parity — nothing in the gates notices a page that never calls
`t()`.

## B14 — `nextDueDate`'s catch-up loop cannot run, and an overdue repeat is re-anchored to today

`src/lib/tasks.ts:20-52`

```ts
let next =
  dueDate !== null && isValidISODate(dueDate) && dueDate > today
    ? dueDate
    : today;                                     // :40-43
for (let i = 0; i < REPEAT_ROLL_MAX_STEPS; i++) {
  const advanced = step(next);
  if (advanced <= next) break;                    // no progress
  next = advanced;
  if (next > today) return next;
}
// Pathological (a decade of daily catch-up) — re-arm one period out.
return next;                                      // :50-51
```

`next` is never older than `today`, so the first `step` always lands strictly
after `today` and returns. The loop's cap, its progress guard and the
"pathological" fallback are unreachable, and the "one period per step" walk the
header describes never happens: an overdue task is re-anchored to the completion
day, not to its schedule. For daily and weekly tasks that is what the tests
expect (`tasks.test.ts`, "Overdue catch-up"), but for a monthly task due on the
1st and completed on the 19th the next due date is the 19th of the following
month, permanently moving the schedule. The month-end clamp the comment points
at (`dates.ts:addMonths`) is applied to that new anchor, not to the stored one.

No data is lost, and the tests pin today's output — so the fix is a decision:
either say what the code does ("an overdue repeat re-anchors from today") and
drop the loop, or advance from the stored date (capped) and keep the comment.

## Checked and found clean

Recording this bounds the audit. These were examined and are correct as written:

- `lib/contacts.ts` — `updateContact`'s partial update (undefined leaves a
  column, `null` clears it), the `sort_order` allocation + `last_insert_rowid()`
  read after `addChannel`'s batch, `setPrimaryChannel`'s ownership check before
  the two-statement batch, `INSERT OR IGNORE` for tags, `birthdaysOn`'s 1-based
  `substr(birthday, 6, 5)`, `upcomingBirthday`'s year wrap and its NaN-safe
  `diff` comparison, `normalizeMonthDay`'s Feb-30/month-13 rejection, and
  `contactInitial`'s grapheme cluster (Burmese vowels and surrogate pairs stay
  intact).
- `ContactsPage` guards and detail plumbing — `addContact`/`addChannel`/`addTag`
  raise a ref before the first await, clear it in `finally`, and the three
  submit buttons read the state (the pinned shape); `reloadDetail(id, false)`
  deliberately does not refill the edit form after a channel/tag action;
  `select` clears `birthdayError`; birthday mode/resolve/value handling matches
  the two stored shapes; the two data-destroying calls (`deleteContact`,
  `deleteChannel`) go through `ConfirmButton` and a named handler, and
  `removeTag`'s unconfirmed chip is the documented exemption in
  `delete-guards.test.ts`; search is documented as name/address/notes only.
- `lib/contactImport.ts`, `lib/csv.ts`, `components/ImportDialog.tsx` —
  `CONTACT_CSV_ALIASES` matches the page's template header (`phones`/`emails`/
  `others`/`birthday`/`tags`), `row` numbers are data-row numbers (index + 1) as
  `ImportDialog` expects, a row stops at its first bad value, `tagsOf` dedupes so
  `UNIQUE (contact_id, tag)` cannot be tripped, `channelsOf` keeps column order
  and marks only the first channel primary; `parseCsv` enforces the 5 MB cap
  before parsing and the 5 000-row cap while scanning, tolerates BOM/CRLF, and
  refuses a file missing `name`/`title` outright; `unescapeSpreadsheetCell`
  round-trips `csvText`'s guards and leaves `'90s` alone; `ImportDialog` owns the
  in-flight guards (`runningRef`, `downloadingRef`), blocks closing mid-write,
  caps the preview at `PREVIEW_ROW_LIMIT` while importing every valid row, and
  saves the template through the native dialog + atomic writer.
- `contactImport.insertContacts` — `SELECT MAX(id) FROM contacts` is
  unambiguous inside the one `driver.batch` transaction (the same comment
  explains why `last_insert_rowid()` is wrong after a channel insert); a failed
  statement rolls the whole family back.
- `lib/tasks.ts` — `nextReminderAt`'s cap is reachable and terminating
  (malformed stamps come back unchanged from the date helpers, so the
  no-progress guard ends the walk); `completeTask` is a no-op for a row that
  vanished and takes its default `today` from `todayLocal()`; `updateTask`'s
  partial update, `toggleTask`, `listTasks` ordering (`due_date IS NULL` last),
  `deleteTask` → Trash with the right columns, `listReminders(true)` keeping
  fired one-shots, and `rescheduleReminder`'s in-place `fired = 0` write all
  match the DDL and the poll in `lib/session.ts`.
- `TasksPage` task half — `addTask`/`complete`/`reopen`/`remove` match the
  pinned guard shape (ref/state/finally, `busyRow` before the first await,
  buttons disabled); the focus effect is keyed only on `focusId`/`focusToken`
  (unlike ContactsPage, B1); `focusedRef` scrolls after the row exists;
  `showDone` is flipped for a completed target so the highlight has a row to
  land on; the import's columns/mapper agree with `TASK_CSV_ALIASES` and the
  template.
- `lib/vault.ts` (outside B4/B5) — marker + verifier written in one batch on
  setup, with the marker deliberately a plain INSERT so a concurrent second
  setup fails; the verifier upsert; `unlock` proving against `MIN(id)`'s GCM tag
  when items exist and against the verifier when they do not, with a
  `WrongPasswordError` rather than an accept when the marker exists but the
  verifier does not; `changePassword`'s two-phase build, single atomic batch
  (items + re-sealed verifier) and cache clear only after the batch; only
  `OperationError` translated to "wrong password", so corruption is not
  mislabelled; `listItems` never selects ciphertext; `deleteItem` dropping the
  cached key.
- `VaultPage` — the phase machine and its cancellation on the initial read;
  list state holds metadata only; `revealed` is cleared by the hide path, by
  `saveEdit` for the edited id and by `removeItem` for the deleted one; every
  destructive action is behind `ConfirmButton` (which is what
  `delete-guards.test.ts:206` sanity-checks); the password is held in page state
  only, and `doLock` drops it and clears the repo key cache (see B4 for the
  in-flight window).
- `schema.rs` / `trash.ts` — `tasks.repeat`, `done`, `reminders.fired`,
  `contact_channels.kind/is_primary` CHECKs match the TypeScript unions; the
  contacts FKs cascade, and `trash.ts` snapshots `contact_channels` and
  `contact_tags` alongside the contact (columns, validation and restore
  remapping all present), so `deleteContact` → Trash is recoverable.
- `lib/tasks.ts:nextDueDate` for a *future* due date advances exactly one period
  (the common "complete early" case), and the `repeat === "none"` → `null` →
  toggle-done branch is right.
- `App.tsx` focus plumbing — `openEntity` bumps the token, sets the entity and
  the page; `navigate` clears it; `focusedRowFor` matches on entity type. The
  state is coherent; B1 is the consumer's dependency list, not the shell.

## Why the existing gates miss these

None of the fourteen is a type error or a lint error, and the gates that do
read page source would not see them either. Concretely:

- `submit-guards.test.ts` pins a fixed list of 37 handlers by name, found with a
  first-match brace scan. `VaultPage` has no entry, `ContactsPage` has only
  `addContact`, and `TasksPage`'s three reminders handlers are shadowed by the
  task-row ones (its own comment records that). A guard that is absent, or that
  lives on the second handler with a given name, is not asserted by anything.
- `delete-guards.test.ts` matches only `\w+Repo\.(delete\w*|remove\w*)`, so
  `lockVault`, `updateItem` and `changePassword` are outside it — and it asserts
  that a destructive call is behind a named handler, never that the handler is
  guarded.
- `i18n.test.ts` pins catalogue parity (same keys, same placeholders), not page
  coverage: a page that never calls `t()` passes it.
- `node --test` cannot mount a component, so an effect whose dependency list
  includes the state its body sets (B1), a handler that reloads with an id
  captured before its await (B2), and a lock that races its own derivations (B4,
  B6) have no reachable test. The only source-level reads of `VaultPage` are
  `delete-guards.test.ts`'s two `removeItem` sanity checks.
- `tasks.test.ts` pins `nextDueDate`'s current output, including the overdue
  re-anchoring, so B14 is "tested as intended" on one side while its comment
  promises a different walk — no test compares the two.

Two structural follow-ups, in order of value:

1. one `ContactsPage`/`VaultPage` row in `submit-guards.test.ts` per write
   handler, plus a guard test that a same-named handler cannot shadow another
   (assert every declaration is covered, not just the first);
2. a `lib/loads.ts`-based generation check in `VaultPage` and a focus-effect
   test for `ContactsPage` that flips the selection after the focus resolves,
   which is the one behavioural test this batch would most want.
