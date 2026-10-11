import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { useCallback, useEffect, useRef, useState } from "react";
import { LockScreen, SetupScreen } from "./components/LockScreens.tsx";
import { settingsRepo, tasksRepo, vaultRepo } from "./data/app.ts";
import { DEFAULT_AUTO_LOCK_MINUTES, isIdle } from "./lib/appLock.ts";
import type { PinHash } from "./lib/crypto.ts";
import { localISODateTime } from "./lib/dates.ts";
import { SETTING_KEYS, type Theme } from "./lib/settings.ts";
import BudgetPage from "./pages/BudgetPage";
import BusinessPage from "./pages/BusinessPage";
import ContactsPage from "./pages/ContactsPage";
import GalleryPage from "./pages/GalleryPage";
import HabitsPage from "./pages/HabitsPage";
import JournalPage from "./pages/JournalPage";
import LoansPage from "./pages/LoansPage";
import MemoriesPage from "./pages/MemoriesPage";
import NotesPage from "./pages/NotesPage";
import ShoppingPage from "./pages/ShoppingPage";
import TasksPage from "./pages/TasksPage";
import VaultPage from "./pages/VaultPage";

type PageKey =
  | "notes"
  | "journal"
  | "budget"
  | "business"
  | "loans"
  | "habits"
  | "tasks"
  | "shopping"
  | "contacts"
  | "memories"
  | "gallery"
  | "vault";

const TABS: { key: PageKey; label: string }[] = [
  { key: "notes", label: "Notes" },
  { key: "journal", label: "Journal" },
  { key: "budget", label: "Budget" },
  { key: "business", label: "Business" },
  { key: "loans", label: "Loans" },
  { key: "habits", label: "Habits" },
  { key: "tasks", label: "Tasks" },
  { key: "shopping", label: "Shopping" },
  { key: "contacts", label: "Contacts" },
  { key: "memories", label: "Memories" },
  { key: "gallery", label: "Gallery" },
  { key: "vault", label: "Vault" },
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
 * Repeating reminders re-arm to their next future occurrence. Paused while
 * the app is locked (§2.9) so notifications never surface over the lock
 * screen.
 */
function useReminderPoll(
  setNotifyNote: (note: string | null) => void,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return;
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
  }, [setNotifyNote, enabled]);
}

interface BootState {
  ready: boolean;
  pinHash: PinHash | null;
  answerHash: PinHash | null;
  question: string;
  theme: Theme;
  autoLockMinutes: number;
}

/**
 * App shell (§2.8/§2.9): PIN lock gates everything — first run requires
 * setting a PIN + security question, later launches show the lock screen
 * (with the question fallback). Unlocked, the shell holds the header nav,
 * the reminder poll (paused while locked) and the configurable idle
 * auto-lock. Navigation is state-based — §3 locks the stack and has no
 * router dependency.
 */
export default function App() {
  const [boot, setBoot] = useState<BootState>({
    ready: false,
    pinHash: null,
    answerHash: null,
    question: "",
    theme: "dark",
    autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
  });
  const [unlocked, setUnlocked] = useState(false);
  const [page, setPage] = useState<PageKey>("notes");
  const [notifyNote, setNotifyNote] = useState<string | null>(null);
  const lastActivity = useRef(Date.now());

  const loadSecurity = useCallback(async () => {
    try {
      const [pinHash, answerHash, question, theme, minutes] = await Promise.all(
        [
          settingsRepo.getJSON<PinHash>(SETTING_KEYS.pinHash),
          settingsRepo.getJSON<PinHash>(SETTING_KEYS.securityAnswerHash),
          settingsRepo.getJSON<string>(SETTING_KEYS.securityQuestion),
          settingsRepo.getTheme(),
          settingsRepo.getAutoLockMinutes(),
        ],
      );
      const t = theme ?? "dark";
      document.documentElement.dataset.theme = t;
      setBoot({
        ready: true,
        pinHash,
        answerHash,
        question:
          typeof question === "string" && question.length > 0
            ? question
            : "Security question",
        theme: t,
        autoLockMinutes: minutes ?? DEFAULT_AUTO_LOCK_MINUTES,
      });
    } catch {
      // The lock must not deadlock the app on a settings read failure —
      // fall through to first-run setup, which will surface the error.
      setBoot((b) => ({ ...b, ready: true }));
    }
  }, []);

  useEffect(() => {
    void loadSecurity();
  }, [loadSecurity]);

  /** Lock now (§2.9): drop the vault keys too (§5.3 auto-lock bounds). */
  const lockNow = useCallback(() => {
    vaultRepo.lockVault();
    setUnlocked(false);
  }, []);

  const handleUnlock = useCallback(() => {
    lastActivity.current = Date.now();
    setUnlocked(true);
  }, []);

  const handleSetupDone = useCallback(async () => {
    await loadSecurity();
    lastActivity.current = Date.now();
    setUnlocked(true);
  }, [loadSecurity]);

  // Idle auto-lock (§2.9): any pointer/keyboard activity resets the clock;
  // a tick every 15 s checks the configured window (0 = never).
  useEffect(() => {
    if (!unlocked) return;
    lastActivity.current = Date.now();
    const markActive = () => {
      lastActivity.current = Date.now();
    };
    window.addEventListener("pointerdown", markActive);
    window.addEventListener("keydown", markActive);
    const timer = setInterval(() => {
      if (isIdle(lastActivity.current, Date.now(), boot.autoLockMinutes)) {
        lockNow();
      }
    }, 15_000);
    return () => {
      window.removeEventListener("pointerdown", markActive);
      window.removeEventListener("keydown", markActive);
      clearInterval(timer);
    };
  }, [unlocked, boot.autoLockMinutes, lockNow]);

  useReminderPoll(setNotifyNote, unlocked);

  if (!boot.ready) {
    return (
      <div className="app-shell">
        <p className="muted lock-loading">Loading…</p>
      </div>
    );
  }

  if (!unlocked) {
    if (boot.pinHash !== null && boot.answerHash !== null) {
      return (
        <LockScreen
          pinHash={boot.pinHash}
          question={boot.question}
          answerHash={boot.answerHash}
          onUnlock={handleUnlock}
        />
      );
    }
    return <SetupScreen onDone={() => void handleSetupDone()} />;
  }

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
        <button
          type="button"
          className="btn btn-ghost"
          title="Lock the app now (§2.9)"
          onClick={lockNow}
        >
          Lock
        </button>
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
        ) : page === "shopping" ? (
          <ShoppingPage />
        ) : page === "contacts" ? (
          <ContactsPage />
        ) : page === "memories" ? (
          <MemoriesPage />
        ) : page === "gallery" ? (
          <GalleryPage />
        ) : (
          <VaultPage />
        )}
      </main>
    </div>
  );
}
