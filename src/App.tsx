import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { useEffect, useState } from "react";
import { tasksRepo } from "./data/app.ts";
import { localISODateTime } from "./lib/dates.ts";
import BudgetPage from "./pages/BudgetPage";
import BusinessPage from "./pages/BusinessPage";
import HabitsPage from "./pages/HabitsPage";
import JournalPage from "./pages/JournalPage";
import LoansPage from "./pages/LoansPage";
import NotesPage from "./pages/NotesPage";
import ShoppingPage from "./pages/ShoppingPage";
import TasksPage from "./pages/TasksPage";

type PageKey =
  | "notes"
  | "journal"
  | "budget"
  | "business"
  | "loans"
  | "habits"
  | "tasks"
  | "shopping";

const TABS: { key: PageKey; label: string }[] = [
  { key: "notes", label: "Notes" },
  { key: "journal", label: "Journal" },
  { key: "budget", label: "Budget" },
  { key: "business", label: "Business" },
  { key: "loans", label: "Loans" },
  { key: "habits", label: "Habits" },
  { key: "tasks", label: "Tasks" },
  { key: "shopping", label: "Shopping" },
];

/**
 * App shell (§2.4/§2.5 scope for P3a): header + section tabs. Navigation is
 * state-based — §3 locks the stack and has no router dependency. The Dashboard
 * becomes the landing page in P3f; Notes is the placeholder landing here.
 */
/** Ask once for notification permission; false when denied (§2.7). */
async function ensureNotifyPermission(): Promise<boolean> {
  try {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  } catch {
    return false;
  }
}

/**
 * Roll a repeating reminder's time forward one period. Monthly rolls clamp
 * to the target month's last day (Jan 31 -> Feb 28, not Mar 3) — a bare
 * setMonth() would overflow and skip February.
 */
function rollReminderTime(
  remindAt: string,
  repeat: "daily" | "weekly" | "monthly",
): string {
  const d = new Date(remindAt);
  if (Number.isNaN(d.getTime())) return remindAt;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (repeat === "daily") d.setDate(d.getDate() + 1);
  else if (repeat === "weekly") d.setDate(d.getDate() + 7);
  else {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Roll forward until the time is in the future. A repeating reminder left
 * overdue for many periods must re-arm to its next future occurrence — not
 * one period at a time, which would re-fire on every poll until caught up.
 */
function rollReminderForward(
  remindAt: string,
  repeat: "daily" | "weekly" | "monthly",
  now: string,
): string {
  let next = rollReminderTime(remindAt, repeat);
  for (let i = 0; i < 10_000 && next <= now; i++) {
    const advanced = rollReminderTime(next, repeat);
    if (advanced <= next) break; // no progress — never loop forever
    next = advanced;
  }
  return next;
}

/**
 * Reminder notification loop (§2.7). Lives in the app shell — not in
 * TasksPage — so navigating to another section never stops the polling.
 * Polls for due reminders, fires a local notification, marks fired.
 * Repeating reminders re-arm to their next future occurrence.
 */
function useReminderPoll(setNotifyNote: (note: string | null) => void): void {
  useEffect(() => {
    let cancelled = false;
    let requested = false;
    const tick = async () => {
      try {
        const now = localISODateTime(new Date());
        const due = await tasksRepo.dueReminders(now);
        if (due.length === 0 || cancelled) return;
        if (!requested) {
          requested = true;
          const granted = await ensureNotifyPermission();
          if (!granted) {
            setNotifyNote(
              "Notifications are blocked — due reminders stay listed in Tasks.",
            );
            return;
          }
        }
        for (const r of due) {
          sendNotification({ title: `Reminder: ${r.title}`, body: r.note });
          if (r.repeat === "none") {
            await tasksRepo.markReminderFired(r.id);
          } else {
            await tasksRepo.deleteReminder(r.id);
            await tasksRepo.createReminder({
              title: r.title,
              remindAt: rollReminderForward(r.remind_at, r.repeat, now),
              repeat: r.repeat,
              note: r.note,
            });
          }
        }
      } catch {
        // The notification loop must never break the app (§2.7 wiring
        // is best-effort; the reminders list itself is the source of truth).
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [setNotifyNote]);
}

export default function App() {
  const [page, setPage] = useState<PageKey>("notes");
  const [notifyNote, setNotifyNote] = useState<string | null>(null);
  useReminderPoll(setNotifyNote);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-brand">
          <img className="app-mark" src="/brand/purple-memo-mark.png" alt="" />
          <span className="app-name">Purple Memo</span>
        </div>
        <nav className="app-nav" aria-label="Sections">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={page === tab.key ? "nav-tab is-active" : "nav-tab"}
              aria-current={page === tab.key ? "page" : undefined}
              onClick={() => setPage(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="app-main">
        {page === "notes" ? (
          <NotesPage />
        ) : page === "journal" ? (
          <JournalPage />
        ) : page === "budget" ? (
          <BudgetPage />
        ) : page === "business" ? (
          <BusinessPage />
        ) : page === "loans" ? (
          <LoansPage />
        ) : page === "habits" ? (
          <HabitsPage />
        ) : page === "tasks" ? (
          <TasksPage notifyNote={notifyNote} />
        ) : (
          <ShoppingPage />
        )}
      </main>
    </div>
  );
}
