import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "./components/Dialog.tsx";
import {
  IconBudget,
  IconBusiness,
  IconClose,
  IconContacts,
  IconDashboard,
  IconGallery,
  IconHabits,
  IconJournal,
  IconKeyboard,
  IconLoans,
  IconLock,
  IconMemories,
  IconMore,
  IconNotes,
  IconSettings,
  IconShopping,
  IconTasks,
  IconVault,
} from "./components/icons.tsx";
import { LockScreen, SetupScreen } from "./components/LockScreens.tsx";
import { Skeleton } from "./components/Skeleton.tsx";
import { ToastProvider } from "./components/Toast.tsx";
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

interface NavItem {
  key: PageKey;
  label: string;
  Icon: typeof IconNotes;
}

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Workspace",
    items: [
      { key: "dashboard", label: "Dashboard", Icon: IconDashboard },
      { key: "notes", label: "Notes", Icon: IconNotes },
      { key: "journal", label: "Journal", Icon: IconJournal },
    ],
  },
  {
    label: "Finance",
    items: [
      { key: "budget", label: "Budget", Icon: IconBudget },
      { key: "business", label: "Business", Icon: IconBusiness },
      { key: "loans", label: "Loans", Icon: IconLoans },
    ],
  },
  {
    label: "Personal",
    items: [
      { key: "habits", label: "Habits", Icon: IconHabits },
      { key: "tasks", label: "Tasks", Icon: IconTasks },
      { key: "shopping", label: "Shopping", Icon: IconShopping },
      { key: "contacts", label: "Contacts", Icon: IconContacts },
      { key: "memories", label: "Memories", Icon: IconMemories },
      { key: "gallery", label: "Gallery", Icon: IconGallery },
      { key: "vault", label: "Vault", Icon: IconVault },
    ],
  },
  {
    label: "System",
    items: [
      { key: "more", label: "All tools", Icon: IconMore },
      { key: "settings", label: "Settings", Icon: IconSettings },
    ],
  },
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
function AppShell() {
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
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
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

  // Shortcuts (plan 12b.1): `?` opens the list, Ctrl/Cmd+L locks. Both are
  // ignored while typing in a field, and the overlay itself is a Dialog, so
  // Escape/Tab/focus-restore come for free.
  useEffect(() => {
    if (!unlocked) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable === true;
      if (typing) return;
      // Don't stack a second dialog on top of an open one.
      if (e.key === "?" && document.querySelector("[role=dialog]") === null) {
        e.preventDefault();
        setShortcutsOpen(true);
      } else if (e.key.toLowerCase() === "l" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        lockNow();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [unlocked, lockNow]);

  if (!boot.ready) {
    return (
      <div className="lock-wrap">
        <div className="entry-form vault-narrow">
          <Skeleton variant="icon" />
          <Skeleton variant="card" />
        </div>
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
      <a className="skip-to-content" href="#main-content">
        Skip to content
      </a>
      <aside className="app-sidebar">
        <div className="app-brand">
          <img className="app-mark" src="/brand/purple-memo-mark.png" alt="" />
          <div className="app-brand-text">
            <span className="app-name">Purple Memo</span>
            <span className="app-tagline">Offline Workspace</span>
          </div>
        </div>
        <nav className="app-nav" aria-label="Sections">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="nav-group">
              <span className="nav-group-label">{group.label}</span>
              {group.items.map((tab) => {
                const active = page === tab.key;
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
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button
            type="button"
            className="nav-item"
            title="Lock the app now (§2.9)"
            data-shortcut="Ctrl+L"
            onClick={lockNow}
          >
            <IconLock className="icon" />
            <span className="nav-label">Lock workspace</span>
          </button>
          <button
            type="button"
            className="nav-item"
            title="Keyboard shortcuts"
            data-shortcut="?"
            onClick={() => setShortcutsOpen(true)}
          >
            <IconKeyboard className="icon" />
            <span className="nav-label">Shortcuts</span>
          </button>
        </div>
      </aside>
      <main className="app-main" id="main-content" tabIndex={-1}>
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
      {shortcutsOpen && (
        <Dialog
          labelledBy="shortcuts-title"
          onClose={() => setShortcutsOpen(false)}
        >
          <div className="modal-head">
            <h2 className="side-heading" id="shortcuts-title">
              Keyboard shortcuts
            </h2>
            <button
              type="button"
              className="btn btn-icon"
              aria-label="Close keyboard shortcuts"
              title="Close"
              // biome-ignore lint/a11y/noAutofocus: the dialog's first stop
              autoFocus
              onClick={() => setShortcutsOpen(false)}
            >
              <IconClose className="icon" />
            </button>
          </div>
          <dl className="shortcut-list">
            <dt>Ctrl / ⌘ + L</dt>
            <dd>Lock the workspace</dd>
            <dt>?</dt>
            <dd>Show or hide this list</dd>
            <dt>Esc</dt>
            <dd>Close this dialog</dd>
            <dt>Tab</dt>
            <dd>Move inside a dialog (never behind it)</dd>
            <dt>Tab (from the top)</dt>
            <dd>Skip to content link</dd>
          </dl>
        </Dialog>
      )}
    </div>
  );
}

/**
 * The toast host wraps everything — including the lock and boot screens — so a
 * provider is never missing from a branch. All shell state lives in AppShell.
 */
export default function App() {
  return (
    <ToastProvider>
      <AppShell />
    </ToastProvider>
  );
}
