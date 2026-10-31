> **Historical plan — not a requirement.**
> The work described here has shipped (see `src/`, `docs/RELEASE.md` and
> `docs/EXPORTS.md`); this file is kept only as the record of what was
> planned. Do not treat it as the current specification.

# Purple Memo — Dashboard Ongoing Tasks + System Tray Plan (dev branch)

**Scope:** two features, one plan, built on `dev` (never `main`).
This document supersedes the standalone dashboard plan — its decisions are
carried over unchanged below.

**Status:** design + build plan. All decisions settled by Muus on the
owner's delegation ("do what you think is best"). The owner reviews this
plan; the build follows the session order in §5.

---

# Part A — Dashboard: all open tasks with traffic-light urgency

## A.1 Current state (verified in code)

- Dashboard loads `tasksRepo.dueTasks(today)`:
  `SELECT * FROM tasks WHERE done = 0 AND due_date IS NOT NULL
  AND due_date <= ? ORDER BY due_date, id` — only tasks due today or
  earlier appear, every row carrying the same fixed `badge badge-warn`.
  Future-dated and dateless tasks never reach the Dashboard.
- Reminders load separately (`dueReminders(now)` + `firedReminders()`).
- The KPI badge counts `dueTasks + reminders + fired`.
- Badge colors already exist in `src/styles/app.css`: `badge-success`
  (green), `badge-warn` (yellow), `badge-danger` (red).

## A.2 The urgency rule (fixed thresholds, not a setting)

New pure helper, `src/lib/urgency.ts`:

```ts
export type Urgency = "overdue" | "soon" | "ok" | "none";
export function urgencyFor(dueDate: string | null, today: string): Urgency;
```

| Case | Condition (local calendar days) | Color | Badge class |
|---|---|---|---|
| overdue | `due_date < today` | red | `badge-danger` |
| soon | `today <= due_date <= today + 3 days` | yellow | `badge-warn` |
| ok | `due_date > today + 3 days` | green | `badge-success` |
| none | `due_date` is null | no color | plain `badge` |

Why 3 days: the app's 14-day horizon (`TODAY_HORIZON_DAYS`) belongs to
memories/birthdays and is far too wide for task urgency — with 14 days
nearly every open task would be yellow and the signal would die. No
settings toggle for the threshold: a preference here is scope creep for a
first version; the number is one constant if it ever needs changing.

## A.3 Dashboard change

- New repo method `tasksRepo.openTasks()`:
  `SELECT * FROM tasks WHERE done = 0 ORDER BY due_date IS NULL, due_date, id`
  (the Tasks page list already uses this ordering shape). Plain date order
  already yields the display order for free: overdue first, then soon,
  then ok, then no-date last.
- Dashboard replaces the `dueTasks(today)` load with `openTasks()`. The
  section heading becomes "Tasks & reminders" and the row badge becomes
  the urgency badge from §A.2 (label stays "Task"). Complete + reschedule
  actions stay on every row — the existing handlers already work on any
  task row, so no handler changes.
- KPI: the count becomes **attention items** = overdue (red) tasks + due
  reminders + fired reminders. The badge stays warn when the count > 0.
- A muted legend line under the heading explains the colors
  (green = due in more than 3 days, yellow = due within 3 days,
  red = overdue, no badge color = no due date).
- Empty state: when there are no open tasks, no due reminders, and no
  fired reminders, show "No open tasks".

## A.4 i18n + out of scope

- New keys (EN + MY): section heading, legend line, empty-state text.
- Remove the old keys (`dueTasksHeading`, `dueTasksNote`, `nothingDue`)
  **only if** a grep shows no other usage — check, don't assume.
- Out of scope: reminders sections stay exactly as they are; Tasks page
  untouched; no threshold setting; no schema change.

## A.5 Tests

- Urgency boundaries: yesterday → overdue; today → soon; today+3 → soon;
  today+4 → ok; null → none. Calendar-day based, not 24-hour based — a
  task due "today" is soon at any hour of today.
- Repo: `openTasks()` returns done=0 only, nulls last, overdue first.
- No Dashboard component tests exist today; the owner does the installed
  check (one task in each color + one dateless task, order and colors
  confirmed).

---

# Part B — System tray: close to tray, reminders keep firing

## B.1 Current state (verified in code)

- Reminders already fire native OS toasts via `plugin-notification`
  (registered in `lib.rs`, wired in `App.tsx` through the session ticker):
  **minimized → toasts DO arrive**, as long as the app is unlocked.
- **Locked (PIN lock) → no toasts, by design.** The poll pauses while
  locked so nothing surfaces over the lock screen. Preview off by default:
  the toast says "Reminder due" with no reminder text (Settings toggle
  opts into text).
- **Closed → no toasts.** No tray code exists (grep clean), no autostart.
  Closing the window quits the process and the poll stops. The only
  `window.hide()` in Rust serves boot-failure dialogs.
- Tauri is 2.12.3: the tray API lives in Tauri 2 core
  (`tauri::tray::TrayIconBuilder`) — **no new plugin crate** is needed.

## B.2 Decisions (settled)

1. **Close → hide to tray, default ON.** Closing the main window hides
   the app to the tray instead of quitting. The process — and therefore
   the reminder poll — keeps running, so toasts fire while "closed".
2. **Settings toggle, default ON.** Settings → Notifications gains
   "Minimize to tray on close". Turning it off restores today's behavior
   (close = quit). The toggle exists because breaking "close means quit"
   silently would be hostile; it must be discoverable and reversible.
3. **Tray menu: exactly two items** — "Show Purple Memo" (restores the
   window) and "Quit" (full exit: poll stops, same as today's close).
4. **Second launch restores the window.** The single-instance plugin
   currently turns a second launch away before setup; with a trayed app
   that would look like a dead launch. Change it: a second launch shows
   the hidden main window instead.
5. **Tray icon = the existing app icon asset.** No new artwork.
6. **Notification rules do NOT change.** Locked → still silent (the lock
   rule is privacy, not a tray limitation). Preview default off stays.
   Permission is still asked once per session, denial still reported once.
7. **Restart paths must fully exit, never hide.** Factory-reset restart
   and updater restart must relaunch the app for real — hiding to tray
   there would leave a stale process behind the new one. The agent must
   verify both paths explicitly (see §B.4).
8. **Out of scope:** autostart on login (a separate, later decision — it
   changes boot behavior, not just close behavior); no notifications
   while the PC is off or asleep (nothing can do that from this app).

## B.3 Implementation notes

- Tray setup lives in Rust (`lib.rs` setup): build the tray icon, handle
  the window close event (prevent close → hide, unless the toggle is off
  or the exit is a real quit/restart path), handle tray menu clicks.
- The Settings toggle is a plain boolean setting (same settings storage
  as the other toggles); the Rust close handler reads it fresh on every
  close so toggling applies without restart.
- No new Cargo dependency for the tray itself; if the agent finds the
  installed Tauri version needs a feature flag for tray, that is a
  one-line manifest change to report, not a redesign.

## B.4 Tests + manual checklist (tray behavior is OS-level; most of it
cannot be unit-tested, so the checklist is the acceptance)

- Close window → tray icon appears, process still alive.
- Tray → Show restores the window; tray → Quit exits fully (process gone).
- Second launch while trayed → window restores (no duplicate process).
- Reminder fires while trayed + unlocked → native toast appears.
- Reminder due while trayed + locked → no toast (lock rule holds).
- Toggle off → close quits exactly like today.
- Factory-reset restart and updater restart still relaunch for real
  (not hide).
- Full gate green.

---

# §5. Combined build order (Tasks-Plan shape)

Same working rules as the project's other plans: at most 2 tasks per
session, then STOP and report; owner verifies before any commit; one
commit per verified pair, on `dev`; `npm run verify` fully green before
any commit; no schema change; every user-facing string in EN **and** MY.

## Session A — Dashboard data layer

- **Task A1:** `src/lib/urgency.ts` + `src/lib/urgency.test.ts`
  (boundary tests from §A.5).
- **Task A2:** `tasksRepo.openTasks()` in `src/lib/tasks.ts` + repo test
  (done=0 only, nulls last, overdue first).

## Session B — Dashboard wiring

- **Task B1:** DashboardPage wiring — replace the `dueTasks` load with
  `openTasks()`, urgency badges on rows, KPI = attention items, heading,
  legend line, empty state.
- **Task B2:** i18n keys (EN + MY) + stale-key grep (remove old keys
  only if unused) + full gate.

## Session C — Tray core

- **Task C1:** Rust tray setup in `src-tauri/src/lib.rs` — tray icon,
  close → hide (toggle-aware), tray menu (Show / Quit).
- **Task C2:** Second-launch restores window + Settings → Notifications
  toggle (default ON) + i18n keys.

## Session D — Tray edges + final gate

- **Task D1:** Verify the restart paths (factory-reset restart, updater
  restart) fully exit/relaunch; verify toggle-off = today's quit
  behavior; verify locked-trayed silence.
- **Task D2:** Full manual checklist from §B.4 on the installed dev
  build + full gate + report. The owner then does the installed check
  before any merge.

## Report-back format (after each pair)

```
Tasks done: <numbers>
Files changed: <path — one-line summary, per file>
Tests added/changed: <names>
Gate: npm run verify — <green/red; JS test count; cargo test count>
Manual checks done: <what was actually tried in the built app, or "none this pair">
Anything deferred, surprising, or out of scope noticed: <or "none">
```

Then stop. The owner verifies (diff + gate re-run) before any commit.
