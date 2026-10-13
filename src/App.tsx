import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconBudget,
  IconBusiness,
  IconDashboard,
  IconJournal,
  IconLoans,
  IconLock,
  IconMore,
  IconNotes,
  IconSettings,
} from "./components/icons.tsx";
import { LockScreen, SetupScreen } from "./components/LockScreens.tsx";
import { settingsRepo, shareRepo, tasksRepo, vaultRepo } from "./data/app.ts";
import { DEFAULT_AUTO_LOCK_MINUTES, isIdle, lockGate } from "./lib/appLock.ts";
import type { PinHash } from "./lib/crypto.ts";
import {
  addDaysToDateTime,
  addMonthsToDateTime,
  localISODateTime,
} from "./lib/dates.ts";
import { errText } from "./lib/errors.ts";
import type { PageKey } from "./lib/navigation.ts";
import { SETTING_KEYS, type Theme } from "./lib/settings.ts";
import { REPEAT_ROLL_MAX_STEPS } from "./lib/tasks.ts";
import BudgetPage from "./pages/BudgetPage";
import BusinessPage from "./pages/BusinessPage";
import ContactsPage from "./pages/ContactsPage";
import DashboardPage from "./pages/DashboardPage";
import GalleryPage from "./pages/GalleryPage";
import HabitsPage from "./pages/HabitsPage";
import JournalPage from "./pages/JournalPage";
import LoansPage from "./pages/LoansPage";
import MemoriesPage from "./pages/MemoriesPage";
import MorePage from "./pages/MorePage";
import NotesPage from "./pages/NotesPage";
import SettingsPage from "./pages/SettingsPage";
import ShoppingPage from "./pages/ShoppingPage";
import TasksPage from "./pages/TasksPage";
import VaultPage from "./pages/VaultPage";

const TABS: { key: PageKey; label: string; Icon: typeof IconNotes }[] = [
  { key: "dashboard", label: "Dashboard", Icon: IconDashboard },
  { key: "notes", label: "Notes", Icon: IconNotes },
  { key: "journal", label: "Journal", Icon: IconJournal },
  { key: "budget", label: "Budget", Icon: IconBudget },
  { key: "business", label: "Business", Icon: IconBusiness },
  { key: "loans", label: "Loans", Icon: IconLoans },
  { key: "more", label: "More", Icon: IconMore },
  { key: "settings", label: "Settings", Icon: IconSettings },
];

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
 * Roll a repeating reminder's time forward one period, via the shared
 * datetime helpers in lib/dates.ts (single source of truth for the
 * month-end clamp — no inline re-implementation).
 */
function rollReminderTime(
  remindAt: string,
  repeat: "daily" | "weekly" | "monthly",
): string {
  if (repeat === "daily") return addDaysToDateTime(remindAt, 1);
  if (repeat === "weekly") return addDaysToDateTime(remindAt, 7);
  return addMonthsToDateTime(remindAt, 1);
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
  for (let i = 0; i < REPEAT_ROLL_MAX_STEPS && next <= now; i++) {
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
    let inFlight = false;
    let requested = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
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
            await tasksRepo.rescheduleReminder(
              r.id,
              rollReminderForward(r.remind_at, r.repeat, now),
            );
          }
        }
      } catch {
        // The notification loop must never break the app (§2.7 wiring
        // is best-effort; the reminders list itself is the source of truth).
      } finally {
        inFlight = false;
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

/**
 * Keeps the LAN snapshot current (§8, P5). It lives in the app shell — not in
 * SettingsPage — so navigating away never freezes what the phone sees, and it
 * pauses while locked (§2.9) exactly like the reminder poll. The desktop stays
 * the only writer: this only re-reads rows and re-publishes them.
 *
 * A server that stopped itself (too many wrong pairing codes) is surfaced
 * through the same in-app note channel as notifications.
 */
function useSharePublisher(
  setNotifyNote: (note: string | null) => void,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let wasRunning = false;
    const tick = async () => {
      try {
        const info = await shareRepo.status();
        if (cancelled) return;
        if (!info.running) {
          if (wasRunning && info.note) setNotifyNote(info.note);
          wasRunning = false;
          return;
        }
        wasRunning = true;
        await shareRepo.publishSnapshot();
      } catch {
        // Sharing is best-effort: the database is the source of truth, and a
        // failed publish must never break the app.
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
  /** Set when the settings read itself failed — distinct from "no PIN set". */
  error: string | null;
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
    error: null,
    pinHash: null,
    answerHash: null,
    question: "",
    theme: "dark",
    autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
  });
  const [unlocked, setUnlocked] = useState(false);
  const [page, setPage] = useState<PageKey>("dashboard");
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
        error: null,
        pinHash,
        answerHash,
        question:
          typeof question === "string" && question.length > 0
            ? question
            : "Security question",
        theme: t,
        autoLockMinutes: minutes ?? DEFAULT_AUTO_LOCK_MINUTES,
      });
    } catch (e) {
      // A failed settings read is NOT "first run". Falling through to the
      // setup screen would invite a PIN overwrite — e.g. right after a
      // backup import reload. Surface the failure instead (§2.9).
      setBoot((b) => ({
        ...b,
        ready: true,
        error: `Could not read the encrypted database: ${errText(e)}`,
      }));
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
  useSharePublisher(setNotifyNote, unlocked);

  if (!boot.ready) {
    return (
      <div className="lock-wrap">
        <p className="muted lock-loading">Loading…</p>
      </div>
    );
  }

  // Locked + the settings read failed: show the error, never the setup
  // screen — setup would overwrite an existing PIN.
  if (!unlocked && boot.error !== null) {
    return (
      <div className="lock-wrap">
        <p className="alert alert-error" role="alert">
          {boot.error} Restart Purple Memo and try again.
        </p>
      </div>
    );
  }

  if (!unlocked) {
    // Fail closed (§2.9): the setup screen overwrites the PIN without
    // verifying the old one, so it is reachable ONLY when no PIN has ever
    // been stored. Keying off the answer hash as well used to let a partial
    // settings row (corrupt value, or an import that replaced settings)
    // drop a locked app into first-run setup.
    const gate = lockGate(boot.pinHash, boot.answerHash);
    if (gate === "setup") {
      return <SetupScreen onDone={() => void handleSetupDone()} />;
    }
    return (
      <LockScreen
        pinHash={boot.pinHash as PinHash}
        question={boot.question}
        answerHash={boot.answerHash}
        onUnlock={handleUnlock}
      />
    );
  }

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-brand">
          <img className="app-mark" src="/brand/purple-memo-mark.png" alt="" />
          <span className="app-name">Purple Memo</span>
        </div>
        <nav className="app-nav" aria-label="Sections">
          {TABS.map((tab) => {
            // Secondary pages (Habits, Tasks, …) live under More — keep its
            // rail item lit while the user is inside one of them.
            const active =
              page === tab.key ||
              (tab.key === "more" &&
                tab.key !== page &&
                !TABS.some((t) => t.key === page));
            return (
              <button
                key={tab.key}
                type="button"
                className={active ? "nav-item is-active" : "nav-item"}
                aria-current={active ? "page" : undefined}
                onClick={() => setPage(tab.key)}
              >
                <tab.Icon className="icon" />
                <span className="nav-label">{tab.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <button
            type="button"
            className="nav-item"
            title="Lock the app now (§2.9)"
            onClick={lockNow}
          >
            <IconLock className="icon" />
            <span className="nav-label">Lock</span>
          </button>
        </div>
      </aside>
      <main className="app-main">
        {page === "dashboard" ? (
          <DashboardPage onNavigate={setPage} notifyNote={notifyNote} />
        ) : page === "notes" ? (
          <NotesPage />
        ) : page === "journal" ? (
          <JournalPage />
        ) : page === "budget" ? (
          <BudgetPage />
        ) : page === "business" ? (
          <BusinessPage />
        ) : page === "loans" ? (
          <LoansPage />
        ) : page === "more" ? (
          <MorePage onNavigate={setPage} />
        ) : page === "settings" ? (
          <SettingsPage
            theme={boot.theme}
            autoLockMinutes={boot.autoLockMinutes}
            onChanged={() => void loadSecurity()}
            onNavigate={setPage}
          />
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
