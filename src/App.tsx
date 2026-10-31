import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Dialog } from "./components/Dialog.tsx";
import { GlobalSearchDialog } from "./components/GlobalSearchDialog.tsx";
import {
  IconBudget,
  IconBusiness,
  IconClose,
  IconContacts,
  IconDashboard,
  IconGallery,
  IconHabits,
  IconInbox,
  IconJournal,
  IconKeyboard,
  IconLoans,
  IconLock,
  IconMemories,
  IconMore,
  IconNotes,
  IconSearch,
  IconSettings,
  IconShopping,
  IconSpinner,
  IconTasks,
  IconTrash,
  IconVault,
} from "./components/icons.tsx";
import {
  LockedScreen,
  LockScreen,
  SetupScreen,
} from "./components/LockScreens.tsx";
import { ResetResultScreen } from "./components/ResetScreen.tsx";
import { Skeleton } from "./components/Skeleton.tsx";
import { ToastProvider, useToast } from "./components/Toast.tsx";
import { usePlural, useT } from "./components/useTranslation.ts";
import {
  inboxRepo,
  settingsRepo,
  shareRepo,
  tasksRepo,
  trashRepo,
  vaultRepo,
} from "./data/app.ts";
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
import type { SearchResult } from "./lib/globalSearch.ts";
import { detectInitialLocale, type MessageKey, setLocale } from "./lib/i18n.ts";
import { ENTITY_PAGE, focusedRowFor, type PageKey } from "./lib/navigation.ts";
import type { ResetAttempt } from "./lib/reset.ts";
import { specFor } from "./lib/searchContract.ts";
import {
  createReminderTicker,
  createShareTicker,
  lockSession,
  type ReminderMessages,
} from "./lib/session.ts";
import { SETTING_KEYS, type Theme } from "./lib/settings.ts";
import type { LinkableEntity } from "./lib/types.ts";

// Every page (including Dashboard, which sits behind the lock screen inside
// `<Suspense>`) is split into its own chunk so the initial shell + lock screen
// paint without parsing the workspace pages first. Lazy pages stay cached by
// the WebView after first visit.
const BudgetPage = lazy(() => import("./pages/BudgetPage"));
const BusinessPage = lazy(() => import("./pages/BusinessPage"));
const ContactsPage = lazy(() => import("./pages/ContactsPage"));
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const ExportsPage = lazy(() => import("./pages/ExportsPage"));
const GalleryPage = lazy(() => import("./pages/GalleryPage"));
const HabitsPage = lazy(() => import("./pages/HabitsPage"));
const InboxPage = lazy(() => import("./pages/InboxPage"));
const JournalPage = lazy(() => import("./pages/JournalPage"));
const LoansPage = lazy(() => import("./pages/LoansPage"));
const MemoriesPage = lazy(() => import("./pages/MemoriesPage"));
const MorePage = lazy(() => import("./pages/MorePage"));
const NotesPage = lazy(() => import("./pages/NotesPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const ShoppingPage = lazy(() => import("./pages/ShoppingPage"));
const TasksPage = lazy(() => import("./pages/TasksPage"));
const TrashPage = lazy(() => import("./pages/TrashPage"));
const VaultPage = lazy(() => import("./pages/VaultPage"));

interface NavItem {
  key: PageKey;
  label: MessageKey;
  Icon: typeof IconNotes;
}

/** Navigation labels are keys, resolved at render time, not at import time. */
const NAV_GROUPS: { label: MessageKey; items: NavItem[] }[] = [
  {
    label: "shell.navGroup.workspace",
    items: [
      { key: "dashboard", label: "nav.dashboard", Icon: IconDashboard },
      { key: "inbox", label: "nav.inbox", Icon: IconInbox },
      { key: "notes", label: "nav.notes", Icon: IconNotes },
      { key: "journal", label: "nav.journal", Icon: IconJournal },
    ],
  },
  {
    label: "shell.navGroup.finance",
    items: [
      { key: "budget", label: "nav.budget", Icon: IconBudget },
      { key: "business", label: "nav.business", Icon: IconBusiness },
      { key: "loans", label: "nav.loans", Icon: IconLoans },
    ],
  },
  {
    label: "shell.navGroup.personal",
    items: [
      { key: "habits", label: "nav.habits", Icon: IconHabits },
      { key: "tasks", label: "nav.tasks", Icon: IconTasks },
      { key: "shopping", label: "nav.shopping", Icon: IconShopping },
      { key: "contacts", label: "nav.contacts", Icon: IconContacts },
      { key: "memories", label: "nav.memories", Icon: IconMemories },
      { key: "gallery", label: "nav.gallery", Icon: IconGallery },
      { key: "trash", label: "nav.trash", Icon: IconTrash },
      { key: "vault", label: "nav.vault", Icon: IconVault },
    ],
  },
  {
    label: "shell.navGroup.system",
    items: [
      { key: "more", label: "nav.more", Icon: IconMore },
      { key: "settings", label: "nav.settings", Icon: IconSettings },
    ],
  },
];

/** Ask once for notification permission; false when denied. */
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
 * Budget for the post-reset database probe (H6). Short on purpose: a probe
 * that answers does so in one local IPC round-trip, and one that hangs should
 * fall back to today's behaviour (hold the attempt, show the terminal screen)
 * rather than stall the reset result for the 10 s the boot read allows.
 */
export const RESET_DB_PROBE_TIMEOUT_MS = 3_000;

/**
 * Reminder notification loop. Lives in the app shell — not in
 * TasksPage — so navigating to another section never stops the polling, and
 * pauses while locked so notifications never surface over the lock
 * screen.
 *
 * The rules — permission asked once, ticks that never stack, and the re-arm
 * walk for a repeating reminder left overdue for many periods — are in
 * `lib/session.ts`, where the suite can reach them; this hook is
 * only the wiring and the timer.
 */
function useReminderPoll(
  setNotifyNote: (note: string | null) => void,
  enabled: boolean,
  onFired: () => void,
  messages: ReminderMessages,
  permissionDeniedNote: string,
): void {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const tick = createReminderTicker({
      messages,
      now: () => localISODateTime(new Date()),
      due: (now) => tasksRepo.dueReminders(now),
      settle: (outcomes) => tasksRepo.settleReminders(outcomes),
      requestPermission: ensureNotifyPermission,
      notify: ({ title, body }) => sendNotification({ title, body }),
      // Re-read every tick, so flipping the Settings toggle applies within one
      // poll. An unreadable setting answers false — the private default.
      previewEnabled: () => settingsRepo.getNotificationPreview(),
      onPermissionDenied: () => setNotifyNote(permissionDeniedNote),
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
  }, [setNotifyNote, enabled, onFired, messages, permissionDeniedNote]);
}

/**
 * Keeps the LAN snapshot current (P5). It lives in the app shell — not in
 * SettingsPage — so navigating away never freezes what the phone sees, and it
 * pauses while locked exactly like the reminder poll. The desktop stays
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
   * Tri-state, not `PinHash | null`: the lock shell must be able
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
 * App shell: PIN lock gates everything — first run requires
 * setting a PIN + security question, later launches show the lock screen
 * (with the question fallback). Unlocked, the shell holds the header nav,
 * the reminder poll (paused while locked) and the configurable idle
 * auto-lock. Navigation is state-based — the stack locks and has no
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
  /**
   * The finished factory-reset attempt, held in the shell's
   * TOP-LEVEL state on purpose: once `factoryReset()` resolves or throws, the
   * engine has closed the database connection, the session is over, and the
   * terminal screen below replaces the workspace with no path back. Held in
   * navigation or page state it would be reversible state for an irreversible
   * event — so it outranks every stage, including a failed boot read.
   */
  const [resetAttempt, setResetAttempt] = useState<ResetAttempt | null>(null);
  /** A "Try again" on the boot-error screen is in flight (review P3-7). */
  const [retrying, setRetrying] = useState(false);
  const [page, setPage] = useState<PageKey>("dashboard");
  /**
   * Where a relationship click goes: a page AND the exact row to select.
   *
   * It lives in the shell rather than inside a page because `<main>` is keyed
   * by page and remounts the whole subtree on every navigation — an intent kept
   * in a page would be gone before the page could read it. `focusedRowFor` hands
   * each page only the id that belongs to its own entity type, so a task target
   * can never select note 7.
   */
  const [focus, setFocus] = useState<LinkableEntity | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [searchTarget, setSearchTarget] = useState<SearchResult | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const openEntity = useCallback((entity: LinkableEntity) => {
    setFocusToken((token) => token + 1);
    setSearchTarget(null);
    setFocus(entity);
    setPage(ENTITY_PAGE[entity.type]);
  }, []);
  const navigate = useCallback((key: PageKey) => {
    setFocus(null);
    setSearchTarget(null);
    setPage(key);
  }, []);
  const openSearchResult = useCallback(
    (result: SearchResult) => {
      setSearchOpen(false);
      if (result.entity) {
        openEntity(result.entity);
        return;
      }
      const page = specFor(result.type)?.opens.page;
      if (page === undefined) return;
      setFocusToken((token) => token + 1);
      setFocus(null);
      setSearchTarget(result);
      setPage(page);
    },
    [openEntity],
  );
  const [notifyNote, setNotifyNote] = useState<string | null>(null);
  /**
   * A synchronous mirror of `unlocked`. The LAN teardown scheduled by
   * `lockNow` runs detached in the background — through locks, unlocks and
   * re-renders — so it cannot learn that the shell moved on from React state;
   * it reads this ref instead (H4).
   */
  const unlockedRef = useRef(false);
  /**
   * Generation counter for the LAN teardown: every lock takes the current
   * number, so a retry loop still sleeping from an earlier lock is recognised
   * as stale the moment a newer one starts, instead of waking up and stopping
   * a share that was started after it (H4).
   */
  const shareStopEpoch = useRef(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [shortcutRows, setShortcutRows] = useState<
    { keys: string; label: string }[]
  >([]);
  const lastActivity = useRef(performance.now());

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

  /**
   * Quick capture, from anywhere.
   *
   * The dialog lives in the shell rather than on the Inbox page because the
   * point of capture is that you do not have to go somewhere first: one
   * keystroke anywhere writes the memo. `capturesMade` tells an Inbox page that
   * is already on screen to re-read, the same channel the reminder poll uses.
   */
  const toast = useToast();
  const t = useT();
  const plural = usePlural();
  const reminderMessages = useMemo<ReminderMessages>(
    () => ({
      remindersTitle: t("session.remindersTitle"),
      remindersDue: (count) => plural("session.remindersDue", count),
      previewTitle: (title) => t("session.previewTitle", { title }),
      dueTitle: t("session.dueTitle"),
      dueBody: t("session.dueBody"),
    }),
    [t, plural],
  );
  const notificationsBlocked = t("shell.notificationsBlocked");
  const shareStopFailed = t("shell.shareStopFailed");
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureText, setCaptureText] = useState("");
  const [captureError, setCaptureError] = useState<string | null>(null);
  const capturingRef = useRef(false);
  const [capturing, setCapturing] = useState(false);
  const [capturesMade, setCapturesMade] = useState(0);

  const openCapture = useCallback(() => {
    setCaptureError(null);
    setCaptureOpen(true);
  }, []);

  const submitCapture = async () => {
    if (capturingRef.current) return;
    if (captureText.trim().length === 0) {
      setCaptureError(t("capture.empty"));
      return;
    }
    capturingRef.current = true;
    setCapturing(true);
    setCaptureError(null);
    try {
      await inboxRepo.create(captureText);
      setCaptureText("");
      setCaptureOpen(false);
      setCapturesMade((n) => n + 1);
      toast.success(t("capture.saved"));
    } catch (e) {
      setCaptureError(errText(e));
    } finally {
      capturingRef.current = false;
      setCapturing(false);
    }
  };

  const loadSecurity = useCallback(async (): Promise<SecurityReload> => {
    try {
      // The PIN is read RAW and classified: `getJSON` returns
      // null for a row that does not exist AND for one whose JSON is
      // unparseable, and telling those apart is the whole fail-closed rule.
      //
      // Raced against a timeout (review P3-8). These are five local reads
      // against an open database, so they are fast or they have failed — and a
      // hung `invoke` used to leave the user on the skeleton for the life of
      // the process, with no error and no way forward. Timing out turns that
      // into the error screen, which is both honest and retryable.
      const [pinRaw, answerRaw, question, theme, minutes, locale] =
        await Promise.race([
          Promise.all([
            settingsRepo.getRaw(SETTING_KEYS.pinHash),
            settingsRepo.getRaw(SETTING_KEYS.securityAnswerHash),
            settingsRepo.getJSON<string>(SETTING_KEYS.securityQuestion),
            settingsRepo.getTheme(),
            settingsRepo.getAutoLockMinutes(),
            settingsRepo.getLocale(),
          ]),
          rejectAfter(SECURITY_LOAD_TIMEOUT_MS),
        ]);
      // The stored choice wins; with no stored row, keep the browser language
      // detected at startup.
      setLocale(locale ?? detectInitialLocale());
      const nextTheme = theme ?? "dark";
      document.documentElement.dataset.theme = nextTheme;
      // `error: null` here is the ONLY place that error is cleared, so a
      // failed reload can never be forgotten by a later unrelated state
      // update (review P2-2).
      //
      // The answer hash is classified exactly like the PIN (G1): `getJSON`
      // would collapse corrupt JSON to `null` and pass any parseable value
      // ({}, 42, `{ iterations: 1 }`) straight through as a `PinHash`, so a
      // downgraded or malformed row from a crafted backup would reach
      // `verifyAnswer` as trusted material. Absent and unreadable both
      // normalise to `null` — recovery unavailable, lock screen fails closed —
      // and `pinResetBlocked` re-checks the shape before any write.
      const answerState = classifyPin(answerRaw);
      setBoot({
        ready: true,
        error: null,
        pin: classifyPin(pinRaw),
        answerHash: answerState.kind === "stored" ? answerState.hash : null,
        question:
          typeof question === "string" && question.length > 0
            ? question
            : "Security question",
        theme: nextTheme,
        autoLockMinutes: minutes ?? DEFAULT_AUTO_LOCK_MINUTES,
      });
      return { ok: true };
    } catch (e) {
      // A failed settings read is NOT "first run". Falling through to the
      // setup screen would invite a PIN overwrite — e.g. right after a
      // backup import reload. Surface the failure instead
      //
      // The raw reason is stored; the prefix is translated at the point of
      // display so switching language does not require re-reading the database.
      const error = errText(e);
      setBoot((b) => ({ ...b, ready: true, error }));
      return { ok: false, error };
    }
  }, []);

  useEffect(() => {
    void loadSecurity();
  }, [loadSecurity]);

  /**
   * Whether the engine's database is still reachable (H6).
   *
   * `factoryReset()` throws both BEFORE the engine closed anything — it could
   * not record the reset marker, so the row it returns says "nothing was
   * deleted" — and AFTER: a worker panic with the connection already gone.
   * The two arrive here as the same `ipc-error`, and only the second one has a
   * closed database. A read that answers proves the first, so the probe is the
   * missing signal: the engine's own error paths run either before the close
   * or after it, never "deleted everything but left the connection open".
   *
   * Bounded and fail-closed: a probe that hangs or fails reads as "closed",
   * which is exactly the behaviour the app had before this existed — hold the
   * attempt and show the terminal screen.
   */
  const databaseStillOpen = async (): Promise<boolean> => {
    try {
      await Promise.race([
        settingsRepo.getRaw(SETTING_KEYS.pinHash),
        rejectAfter(RESET_DB_PROBE_TIMEOUT_MS),
      ]);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * D1's "Retry reset": drop the attempt and go back to Settings → Danger
   * zone — the workspace re-arms the moment the attempt is gone (the gates
   * below key off it), and the page is forced so a stale `page` cannot drop
   * the user onto a dead screen over a database the engine may have closed.
   * Deliberately not a second path to `factoryReset()`: the ack checkbox and
   * the two-step ConfirmButton stay single-sited in SettingsPage, and this is
   * never a restart.
   */
  const retryReset = () => {
    setResetAttempt(null);
    setPage("settings");
  };

  /**
   * Where every finished factory-reset attempt lands — SettingsPage's only
   * path onto the terminal screen.
   *
   * Two decisions ride here rather than in the page:
   *
   * - **A throw is terminal only when the database is actually gone (H6).**
   *   If a read still answers, the engine aborted before it closed or deleted
   *   anything, so the session is intact: the user stays where they are, the
   *   vault keys stay usable, and the engine's own reason is shown where they
   *   still stand — beside the button they will press again. Evicting them
   *   onto a screen that asserts "the database connection is closed" would be
   *   false, and its "close Purple Memo and start it yourself" would hide the
   *   window to the tray instead of quitting (H6).
   * - **Holding the attempt ends the workspace behind it (H3).** Vault keys
   *   are dropped and the shell's modals closed the moment the screen takes
   *   over: a completed wipe must not leave CryptoKeys in renderer memory,
   *   and a blocked one must not leave a Ctrl+K dialog armed behind the
   *   result screen.
   */
  const handleResetFinished = async (attempt: ResetAttempt) => {
    if (attempt.kind === "ipc-error" && (await databaseStillOpen())) {
      toast.error(attempt.error);
      return;
    }
    setCaptureOpen(false);
    setSearchOpen(false);
    setShortcutsOpen(false);
    // Best-effort, for the reason `lockSession` catches it: the cache is
    // memory, and the terminal screen must appear whether or not clearing
    // it worked.
    try {
      vaultRepo.lockVault();
    } catch {
      // Nothing is left decryptable by this failing; the attempt still has
      // to be held.
    }
    setResetAttempt(attempt);
  };

  /**
   * Lock now: drops the vault keys too (auto-lock bounds) and ends
   * any active LAN session. The rules live in `lockSession`, which
   * is tested — including that the shell locks even if a step fails.
   */
  const lockNow = useCallback(() => {
    const epoch = shareStopEpoch.current + 1;
    shareStopEpoch.current = epoch;
    lockSession({
      lockVault: () => vaultRepo.lockVault(),
      // The lock's stop, not an ordinary one (D2a): it revokes a consent
      // token the user armed before locking and supersedes one an in-flight
      // start has already spent, so no listener can bind a moment after the
      // shell decided sharing ends here.
      stopSharing: () => shareRepo.stopForLock(),
      onLocked: () => {
        unlockedRef.current = false;
        setUnlocked(false);
      },
      // A listener that survived every retry is still publishing to the LAN,
      // and the status poller is paused while locked. `notifyNote` renders only
      // on the Dashboard and Tasks pages — never on the lock screen where this
      // lands — so it is ALSO raised as a toast: `ToastProvider` wraps the
      // whole shell, including the lock screen, and says it out loud the moment
      // it happens. The note stays behind for the unlocked workspace.
      onShareStopFailed: () => {
        setNotifyNote(shareStopFailed);
        toast.error(shareStopFailed);
      },
      // This teardown belongs to this lock. Once the shell unlocks — or a newer
      // lock supersedes it — it retires silently: a retry still sleeping from
      // the previous session must never wake up and stop a LAN share the user
      // has just started (H4). Only the attempt already in flight (bounded by
      // `SHARE_STOP_TIMEOUT_MS`) can still land after the flip.
      isCancelled: () =>
        unlockedRef.current || shareStopEpoch.current !== epoch,
    });
  }, [shareStopFailed, toast]);

  /**
   * Entering the shell always re-reads the security state first,
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
    lastActivity.current = performance.now();
    unlockedRef.current = true;
    setUnlocked(true);
    void trashRepo.purge().catch((e) => {
      toast.error(errText(e));
    });
  }, [loadSecurity, toast]);

  // While the terminal reset screen holds an attempt, this is not a
  // workspace session any more (H3): no poller may keep reading the database
  // the engine closed, no idle timer may `lockNow()` underneath the result
  // screen — which would strand "Retry reset" on the lock screen — and no
  // shortcut may arm a modal that is not on screen. Dropping the attempt (the
  // Retry button) re-arms all of it, which is the whole of D1's return path.
  const workspaceLive = unlocked && resetAttempt === null;

  // Idle auto-lock: any pointer/keyboard/scroll activity resets the
  // clock; a tick every 15 s checks the configured window (0 = never).
  //
  // Scrolling counts as activity. Reading a long note is the one
  // thing a user does without ever clicking or typing, and it used to be the
  // way to be locked out mid-page — the wheel is the app's busiest input. Both
  // new listeners are passive: they never call `preventDefault`, and scrolling
  // must not wait on a lock-timer bookkeeping write.
  useEffect(() => {
    if (!workspaceLive) return;
    lastActivity.current = performance.now();
    const markActive = () => {
      lastActivity.current = performance.now();
    };
    window.addEventListener("pointerdown", markActive);
    window.addEventListener("keydown", markActive);
    window.addEventListener("wheel", markActive, { passive: true });
    window.addEventListener("touchmove", markActive, { passive: true });
    const timer = setInterval(() => {
      if (
        isIdle(lastActivity.current, performance.now(), boot.autoLockMinutes)
      ) {
        lockNow();
      }
    }, 15_000);
    return () => {
      window.removeEventListener("pointerdown", markActive);
      window.removeEventListener("keydown", markActive);
      window.removeEventListener("wheel", markActive);
      window.removeEventListener("touchmove", markActive);
      clearInterval(timer);
    };
  }, [workspaceLive, boot.autoLockMinutes, lockNow]);

  useReminderPoll(
    setNotifyNote,
    workspaceLive,
    onReminderFired,
    reminderMessages,
    notificationsBlocked,
  );
  useSharePublisher(setNotifyNote, workspaceLive);

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

  // Shortcuts: `?` opens the list, Ctrl/Cmd+L locks,
  // Ctrl/Cmd+Shift+M captures a memo from anywhere. All are ignored while typing
  // in a field, and the overlays are Dialogs, so Escape/Tab/focus-restore come
  // for free. `data-shortcut` on the sidebar buttons is what the help overlay
  // reads, so a shortcut cannot exist without being listed.
  //
  // Modifiers are `||`, never `&&`: Ctrl+Meta is a chord no desktop keyboard
  // sends, so the capture shortcut silently never fired on Windows — the label
  // said Ctrl+Shift+M and the handler wanted Ctrl+Cmd+Shift+M.
  useEffect(() => {
    if (!workspaceLive) return;
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
      } else if (
        e.key.toLowerCase() === "k" &&
        (e.ctrlKey || e.metaKey) &&
        document.querySelector("[role=dialog]") === null
      ) {
        e.preventDefault();
        setSearchOpen(true);
      } else if (
        e.key.toLowerCase() === "m" &&
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey
      ) {
        e.preventDefault();
        openCapture();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [workspaceLive, lockNow, openCapture]);

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

  // The terminal reset screen comes FIRST: after any factory-reset
  // attempt — complete, blocked, or thrown — every DB command fails closed and
  // there is no path back into the workspace, so nothing below may render.
  // "Retry reset" on that screen returns here with the outcome dropped and
  // the workspace remounted at Settings, acknowledgement freshly unticked.
  if (resetAttempt !== null) {
    return <ResetResultScreen attempt={resetAttempt} onRetry={retryReset} />;
  }

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
            {t("shell.error.readDb", { error: boot.error ?? "" })}
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
              {retrying ? t("common.retrying") : t("common.tryAgain")}
            </button>
            <button type="button" className="btn btn-ghost" onClick={lockNow}>
              {t("shell.lock")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (stage !== "workspace") {
    // Fail closed: the setup screen overwrites the PIN without
    // verifying the old one, so it is reachable ONLY when no PIN has ever
    // been stored. `classifyPin` is what makes that checkable.
    if (stage === "setup") {
      // Passed directly, not wrapped in `void` (G4): the screen awaits the
      // returned promise so a failed entry surfaces as an error on the form
      // instead of a dropped promise.
      return <SetupScreen onDone={enterWorkspace} />;
    }
    if (stage === "locked" && boot.pin.kind === "unreadable") {
      return <LockedScreen reason={boot.pin.reason} />;
    }
    return (
      <LockScreen
        pinHash={boot.pin.kind === "stored" ? boot.pin.hash : undefined}
        question={boot.question}
        answerHash={boot.answerHash}
        onUnlock={enterWorkspace}
      />
    );
  }

  return (
    <div className="app-shell">
      <a className="skip-to-content" href="#main-content">
        {t("shell.skipToContent")}
      </a>
      <aside className="app-sidebar">
        <div className="app-brand">
          <img className="app-mark" src="/brand/purple-memo-mark.png" alt="" />
          <div className="app-brand-text">
            <span className="app-name">Purple Memo</span>
            <span className="app-tagline">{t("shell.brandTagline")}</span>
          </div>
        </div>
        <nav className="app-nav" aria-label={t("shell.sections")}>
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="nav-group">
              <span className="nav-group-label">{t(group.label)}</span>
              {group.items.map((tab) => {
                const active = page === tab.key;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    className={active ? "nav-item is-active" : "nav-item"}
                    aria-current={active ? "page" : undefined}
                    onClick={() => navigate(tab.key)}
                  >
                    <tab.Icon className="icon" />
                    <span className="nav-label">{t(tab.label)}</span>
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
            title={t("shell.searchTitle")}
            data-shortcut="Ctrl+K"
            aria-label={t("shell.searchAria")}
            onClick={() => setSearchOpen(true)}
          >
            <IconSearch className="icon" />
            <span className="nav-label">{t("shell.search")}</span>
          </button>
          <button
            type="button"
            className="nav-item"
            title={t("shell.newMemoTitle")}
            data-shortcut="Ctrl+Shift+M"
            aria-label={t("shell.newMemo")}
            onClick={openCapture}
          >
            <IconInbox className="icon" />
            <span className="nav-label">{t("shell.newMemo")}</span>
          </button>
          <button
            type="button"
            className="nav-item"
            title={t("shell.lockTitle")}
            data-shortcut="Ctrl+L"
            onClick={lockNow}
          >
            <IconLock className="icon" />
            <span className="nav-label">{t("shell.lock")}</span>
          </button>
          <button
            type="button"
            className="nav-item"
            title={t("shell.shortcutsTitle")}
            data-shortcut="?"
            onClick={() => setShortcutsOpen(true)}
          >
            <IconKeyboard className="icon" />
            <span className="nav-label">{t("shell.shortcuts")}</span>
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
            {t("shell.error.reloadWarning", { error: boot.error ?? "" })}
          </p>
        )}
        {/* The first visit to a lazy page fetches its chunk, which on a slow
            disk is a real wait — a spinner-less flash of empty main would read
            as a broken link. The fallback is the same skeleton the boot screen
            uses, so the wait looks like the app. */}
        <Suspense
          fallback={
            <div className="page-loading" role="status" aria-busy="true">
              <Skeleton variant="card" />
            </div>
          }
        >
          {page === "dashboard" ? (
            <DashboardPage onNavigate={navigate} notifyNote={notifyNote} />
          ) : page === "inbox" ? (
            <InboxPage capturesMade={capturesMade} />
          ) : page === "notes" ? (
            <NotesPage
              focusToken={focusToken}
              focusId={focusedRowFor(focus, "note")}
              onOpenEntity={openEntity}
            />
          ) : page === "journal" ? (
            <JournalPage
              focusToken={focusToken}
              focusDate={
                searchTarget?.type === "journal" ? searchTarget.dateKey : null
              }
            />
          ) : page === "budget" ? (
            <BudgetPage />
          ) : page === "business" ? (
            <BusinessPage
              focusToken={focusToken}
              searchTarget={
                searchTarget?.type === "job" || searchTarget?.type === "payable"
                  ? searchTarget
                  : null
              }
            />
          ) : page === "loans" ? (
            <LoansPage
              focusToken={focusToken}
              focusId={searchTarget?.type === "loan" ? searchTarget.id : null}
            />
          ) : page === "more" ? (
            <MorePage onNavigate={navigate} />
          ) : page === "settings" ? (
            <SettingsPage
              theme={boot.theme}
              autoLockMinutes={boot.autoLockMinutes}
              onChanged={() => void loadSecurity()}
              onNavigate={navigate}
              onResetFinished={handleResetFinished}
            />
          ) : page === "habits" ? (
            <HabitsPage />
          ) : page === "tasks" ? (
            <TasksPage
              focusToken={focusToken}
              notifyNote={notifyNote}
              remindersFired={remindersFired}
              focusId={focusedRowFor(focus, "task")}
              onOpenEntity={openEntity}
            />
          ) : page === "shopping" ? (
            <ShoppingPage
              focusToken={focusToken}
              focusItemId={
                searchTarget?.type === "shopping_item" ? searchTarget.id : null
              }
              focusListId={
                searchTarget?.type === "shopping_item"
                  ? searchTarget.parentId
                  : null
              }
            />
          ) : page === "contacts" ? (
            <ContactsPage
              focusToken={focusToken}
              focusId={focusedRowFor(focus, "contact")}
              onOpenEntity={openEntity}
            />
          ) : page === "memories" ? (
            <MemoriesPage
              focusToken={focusToken}
              focusId={searchTarget?.type === "memory" ? searchTarget.id : null}
            />
          ) : page === "gallery" ? (
            <GalleryPage />
          ) : page === "exports" ? (
            <ExportsPage />
          ) : page === "trash" ? (
            <TrashPage />
          ) : (
            <VaultPage />
          )}
        </Suspense>
      </main>
      {/* Capture from anywhere. A Dialog, so Escape, the focus trap
          and focus restore come from the one place that owns them. */}
      {captureOpen && (
        <Dialog
          labelledBy="capture-title"
          className="vault-narrow"
          onClose={() => setCaptureOpen(false)}
        >
          <div className="modal-head">
            <h2 className="side-heading" id="capture-title">
              {t("capture.title")}
            </h2>
            <button
              type="button"
              className="btn btn-icon"
              aria-label={t("capture.close")}
              title={t("common.close")}
              // biome-ignore lint/a11y/noAutofocus: the dialog's first stop
              autoFocus
              onClick={() => setCaptureOpen(false)}
            >
              <IconClose className="icon" />
            </button>
          </div>
          <form
            className="entry-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submitCapture();
            }}
          >
            <label>
              {t("capture.label")}
              <textarea
                className="input"
                rows={4}
                aria-label={t("capture.aria")}
                placeholder={t("capture.placeholder")}
                value={captureText}
                onChange={(e) => setCaptureText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void submitCapture();
                  }
                }}
              />
            </label>
            {captureError ? (
              <p className="alert alert-error" role="alert">
                {captureError}
              </p>
            ) : null}
            <p className="muted">{t("capture.hint")}</p>
            <div className="editor-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={capturing}
              >
                {capturing && <IconSpinner className="icon" />}
                {capturing ? t("capture.capturing") : t("capture.submit")}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={capturing}
                onClick={() => setCaptureOpen(false)}
              >
                {t("common.cancel")}
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {searchOpen && (
        <GlobalSearchDialog
          onClose={() => setSearchOpen(false)}
          onOpen={openSearchResult}
        />
      )}
      {shortcutsOpen && (
        <Dialog
          labelledBy="shortcuts-title"
          className="shortcuts-modal"
          onClose={() => setShortcutsOpen(false)}
        >
          <div className="modal-head">
            <h2 className="side-heading" id="shortcuts-title">
              {t("shell.shortcutsTitle")}
            </h2>
            <button
              type="button"
              className="btn btn-icon"
              aria-label={t("shell.shortcutsClose")}
              title={t("common.close")}
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
              <dd>{t("shortcuts.esc")}</dd>
            </div>
            <div className="shortcut-row">
              <dt>Tab</dt>
              <dd>{t("shortcuts.tab")}</dd>
            </div>
            <div className="shortcut-row">
              <dt>Tab</dt>
              <dd>{t("shortcuts.tabFirst")}</dd>
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
