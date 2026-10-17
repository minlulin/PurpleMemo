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
import {
  LockedScreen,
  LockScreen,
  SetupScreen,
} from "./components/LockScreens.tsx";
import { Skeleton } from "./components/Skeleton.tsx";
import { ToastProvider } from "./components/Toast.tsx";
import { settingsRepo, shareRepo, tasksRepo, vaultRepo } from "./data/app.ts";
import {
  classifyPin,
  DEFAULT_AUTO_LOCK_MINUTES,
  isIdle,
  type PinState,
  reloadOpensEntry,
  type SecurityReload,
  shellStage,
  showReloadWarning,
} from "./lib/appLock.ts";
import type { PinHash } from "./lib/crypto.ts";
import { localISODateTime } from "./lib/dates.ts";
import { errText } from "./lib/errors.ts";
import type { PageKey } from "./lib/navigation.ts";
import {
  createReminderTicker,
  createShareTicker,
  lockSession,
} from "./lib/session.ts";
import { SETTING_KEYS, type Theme } from "./lib/settings.ts";
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
 * How long a security read may take before it is treated as failed (review
 * P3-8). Generous on purpose — a cold database on a slow disk, with SQLCipher
 * opening, is still well under this — because the cost of waiting is only a
 * slightly longer skeleton, whereas the cost of cutting a live read short is a
 * false error. Pure and exported so the rule is testable without a timer.
 */
export const SECURITY_LOAD_TIMEOUT_MS = 10_000;

/** A promise that rejects after `ms`, for racing against a read that may hang. */
function rejectAfter(ms: number): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
}

/**
 * Reminder notification loop (§2.7). Lives in the app shell — not in
 * TasksPage — so navigating to another section never stops the polling, and
 * pauses while locked (§2.9) so notifications never surface over the lock
 * screen.
 *
 * The rules — permission asked once, ticks that never stack, and the re-arm
 * walk for a repeating reminder left overdue for many periods — are in
 * `lib/session.ts`, where the suite can reach them (review I-02); this hook is
 * only the wiring and the timer.
 */
function useReminderPoll(
  setNotifyNote: (note: string | null) => void,
  enabled: boolean,
  onFired: () => void,
): void {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const tick = createReminderTicker({
      now: () => localISODateTime(new Date()),
      due: (now) => tasksRepo.dueReminders(now),
      markFired: (id) => tasksRepo.markReminderFired(id),
      reschedule: (id, remindAt) => tasksRepo.rescheduleReminder(id, remindAt),
      requestPermission: ensureNotifyPermission,
      notify: ({ title, body }) => sendNotification({ title, body }),
      onPermissionDenied: () =>
        setNotifyNote(
          "Notifications are blocked — due reminders stay listed in Tasks.",
        ),
      // The poll lives here so it survives navigation; an open Tasks page does
      // not, so it is told when a reminder changed (review P3-32).
      onFired,
      isCancelled: () => cancelled,
    });
    void tick();
    const timer = setInterval(() => void tick(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [setNotifyNote, enabled, onFired]);
}

/**
 * Keeps the LAN snapshot current (§8, P5). It lives in the app shell — not in
 * SettingsPage — so navigating away never freezes what the phone sees, and it
 * pauses while locked (§2.9) exactly like the reminder poll. The desktop stays
 * the only writer: this only re-reads rows and re-publishes them.
 *
 * A server that stopped unexpectedly is surfaced
 * through the same in-app note channel as notifications. That edge, and the
 * best-effort rules, are in `createShareTicker` (`lib/session.ts`).
 */
function useSharePublisher(
  setNotifyNote: (note: string | null) => void,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const tick = createShareTicker({
      status: () => shareRepo.status(),
      publish: () => shareRepo.publishSnapshot(),
      onNote: setNotifyNote,
      isCancelled: () => cancelled,
    });
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
  /**
   * Tri-state, not `PinHash | null` (review C-3): the lock shell must be able
   * to tell "no PIN was ever stored" (setup is allowed) from "a PIN is stored
   * but cannot be trusted" (setup must be refused). A nullable hash cannot.
   */
  pin: PinState;
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
    pin: { kind: "absent" },
    answerHash: null,
    question: "",
    theme: "dark",
    autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
  });
  const [unlocked, setUnlocked] = useState(false);
  /** A "Try again" on the boot-error screen is in flight (review P3-7). */
  const [retrying, setRetrying] = useState(false);
  const [page, setPage] = useState<PageKey>("dashboard");
  const [notifyNote, setNotifyNote] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [shortcutRows, setShortcutRows] = useState<
    { keys: string; label: string }[]
  >([]);
  const lastActivity = useRef(Date.now());

  /**
   * Bumped whenever the shell's reminder poll fires one. `TasksPage` keys its
   * reminders list off this (review P3-32): the poll lives in the shell so it
   * survives navigation, which means a `RemindersSection` already on screen had
   * no way to learn a reminder had been marked fired — so it kept showing a
   * fired reminder as pending until the user navigated away and back.
   */
  const [remindersFired, setRemindersFired] = useState(0);
  const onReminderFired = useCallback(
    () => setRemindersFired((n) => n + 1),
    [],
  );

  const loadSecurity = useCallback(async (): Promise<SecurityReload> => {
    try {
      // The PIN is read RAW and classified (review C-3): `getJSON` returns
      // null for a row that does not exist AND for one whose JSON is
      // unparseable, and telling those apart is the whole fail-closed rule.
      //
      // Raced against a timeout (review P3-8). These are five local reads
      // against an open database, so they are fast or they have failed — and a
      // hung `invoke` used to leave the user on the skeleton for the life of
      // the process, with no error and no way forward. Timing out turns that
      // into the error screen, which is both honest and retryable.
      const [pinRaw, answerHash, question, theme, minutes] = await Promise.race(
        [
          Promise.all([
            settingsRepo.getRaw(SETTING_KEYS.pinHash),
            settingsRepo.getJSON<PinHash>(SETTING_KEYS.securityAnswerHash),
            settingsRepo.getJSON<string>(SETTING_KEYS.securityQuestion),
            settingsRepo.getTheme(),
            settingsRepo.getAutoLockMinutes(),
          ]),
          rejectAfter(SECURITY_LOAD_TIMEOUT_MS),
        ],
      );
      const t = theme ?? "dark";
      document.documentElement.dataset.theme = t;
      // `error: null` here is the ONLY place that error is cleared, so a
      // failed reload can never be forgotten by a later unrelated state
      // update (review P2-2).
      setBoot({
        ready: true,
        error: null,
        pin: classifyPin(pinRaw),
        answerHash,
        question:
          typeof question === "string" && question.length > 0
            ? question
            : "Security question",
        theme: t,
        autoLockMinutes: minutes ?? DEFAULT_AUTO_LOCK_MINUTES,
      });
      return { ok: true };
    } catch (e) {
      // A failed settings read is NOT "first run". Falling through to the
      // setup screen would invite a PIN overwrite — e.g. right after a
      // backup import reload. Surface the failure instead (§2.9).
      const error = `Could not read the encrypted database: ${errText(e)}`;
      setBoot((b) => ({ ...b, ready: true, error }));
      return { ok: false, error };
    }
  }, []);

  useEffect(() => {
    void loadSecurity();
  }, [loadSecurity]);

  /**
   * Lock now (§2.9): drops the vault keys too (§5.3 auto-lock bounds) and ends
   * any active LAN session (audit A-01). The rules live in `lockSession`, which
   * is tested — including that the shell locks even if a step fails.
   */
  const lockNow = useCallback(() => {
    lockSession({
      lockVault: () => vaultRepo.lockVault(),
      stopSharing: () => shareRepo.stop(),
      onLocked: () => setUnlocked(false),
    });
  }, []);

  /**
   * Entering the shell always re-reads the security state first (review C-2),
   * and may only do so on a SUCCESSFUL read (review P2-2).
   *
   * `LockScreen` writes a NEW pin hash on the forgot-PIN reset path before
   * calling this, so unlocking without reloading left `boot.pin` pointing at
   * the old hash: the very next lock rejected the user's new PIN and still
   * accepted the old one. This used to call `setUnlocked(true)` unconditionally
   * — so when the reload itself failed the error was set but never shown, the
   * shell stayed on the pre-reload trust root, and the failure was invisible.
   * `reloadOpensEntry` is the gate; the message it leaves behind is what
   * `shellStage` puts on screen.
   */
  const enterWorkspace = useCallback(async () => {
    const reload = await loadSecurity();
    if (!reloadOpensEntry(reload)) return;
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

  useReminderPoll(setNotifyNote, unlocked, onReminderFired);
  useSharePublisher(setNotifyNote, unlocked);

  // The overlay lists shortcuts by reading `data-shortcut` off the controls
  // themselves, so the help can never drift from what the app actually binds.
  useEffect(() => {
    if (!shortcutsOpen) return;
    setShortcutRows(
      Array.from(document.querySelectorAll<HTMLElement>("[data-shortcut]")).map(
        (el) => ({
          keys: el.dataset.shortcut ?? "",
          label: (el.getAttribute("aria-label") ?? el.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim(),
        }),
      ),
    );
  }, [shortcutsOpen]);

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

  // Every branch below comes from `shellStage`, so the order in which the
  // shell prefers screens — a failed security read ahead of every lock screen,
  // an open session ahead of both — is stated once and tested, not implied by
  // the order of these branches (review P2-2).
  const stage = shellStage({
    ready: boot.ready,
    unlocked,
    error: boot.error,
    pin: boot.pin,
    answerHash: boot.answerHash,
  });

  if (stage === "booting") {
    return (
      <div className="lock-wrap">
        <div className="entry-form vault-narrow">
          <Skeleton variant="icon" />
          <Skeleton variant="card" />
        </div>
      </div>
    );
  }

  // The settings read failed while locked: show the error, never the setup
  // screen — setup would overwrite an existing PIN. This is also where a
  // failure that happened mid-session lands the moment the app locks.
  if (stage === "error") {
    return (
      <div className="lock-wrap">
        <div className="entry-form vault-narrow">
          <p className="alert alert-error" role="alert">
            {boot.error}
          </p>
          {/* Retry rather than "restart and hope" (review P3-7). This screen is
              the frontend's own failure to read the settings — the database is
              open, Rust never refused to boot — so the read is genuinely worth
              trying again: a transient SQLITE_BUSY or a momentarily locked
              credential store both clear on their own, and telling someone to
              relaunch a desktop app over it costs them their session. */}
          <div className="editor-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={retrying}
              onClick={() => {
                setRetrying(true);
                void loadSecurity().finally(() => setRetrying(false));
              }}
            >
              {retrying ? "Retrying…" : "Try again"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={lockNow}>
              Lock workspace
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (stage !== "workspace") {
    // Fail closed (§2.9): the setup screen overwrites the PIN without
    // verifying the old one, so it is reachable ONLY when no PIN has ever
    // been stored. `classifyPin` is what makes that checkable — see C-3.
    if (stage === "setup") {
      return <SetupScreen onDone={() => void enterWorkspace()} />;
    }
    if (stage === "locked" && boot.pin.kind === "unreadable") {
      return <LockedScreen reason={boot.pin.reason} />;
    }
    return (
      <LockScreen
        pinHash={boot.pin.kind === "stored" ? boot.pin.hash : undefined}
        question={boot.question}
        answerHash={boot.answerHash}
        onUnlock={() => void enterWorkspace()}
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
      {/* Keyed by page so the workspace re-fades on every route change (13.8). */}
      <main
        className="app-main animate-fade-in"
        id="main-content"
        tabIndex={-1}
        key={page}
      >
        {/* A reload that failed while this session is open: not fatal now, but
            it must not be invisible, and the next lock lands on the error
            screen until it succeeds (review P2-2). */}
        {showReloadWarning({ stage, error: boot.error }) && (
          <p className="alert alert-error" role="alert">
            {boot.error} Purple Memo will ask you to restart before the next
            lock.
          </p>
        )}
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
          <TasksPage notifyNote={notifyNote} remindersFired={remindersFired} />
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
          className="shortcuts-modal"
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
          {/* Element-triggered shortcuts are scraped from `data-shortcut`, so
              adding a shortcut to a control lists itself here. */}
          <dl className="shortcut-list">
            {shortcutRows.map((row) => (
              <div className="shortcut-row" key={row.keys}>
                <dt>{row.keys}</dt>
                <dd>{row.label}</dd>
              </div>
            ))}
            <div className="shortcut-row">
              <dt>Esc</dt>
              <dd>Close a dialog</dd>
            </div>
            <div className="shortcut-row">
              <dt>Tab</dt>
              <dd>Move inside a dialog, never behind it</dd>
            </div>
            <div className="shortcut-row">
              <dt>Tab</dt>
              <dd>First stop skips straight to the content</dd>
            </div>
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
