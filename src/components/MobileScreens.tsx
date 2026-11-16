// The phone's first real data screens: Notes, Tasks and Shopping, plus the
// Dashboard's quick capture and allowlisted search.
//
// Rules live in `lib/mobileShell.ts` / `lib/mobileSearch.ts`; this file is the
// wiring over the shared repositories, which are the same ones the desktop
// pages use. Nothing here mints identity — `createNote` / `createTask` /
// `addItem` do that, so a record typed on the phone is as sync-ready as one
// typed on the desktop. The ONE driver call in this file is the danger zone's
// reset act (F-1), which runs the same factory-reset engine the desktop's
// Settings and Android's key-loss flow use — `src/reset-gate.test.ts` pins it
// as one of exactly two call sites.
//
// Mobile is view + add + mark-done toggles only (design, interaction model):
// the three flows below can create a record and flip exactly the one boolean
// the design allows. No other edit exists here on purpose.

import { invoke } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  budgetRepo,
  businessRepo,
  habitsRepo,
  loansRepo,
  localDeviceId,
  notesRepo,
  readMobileDiagnostics,
  searchMobileWorkspace,
  settingsRepo,
  shoppingRepo,
  tasksRepo,
  vaultRepo,
} from "../data/app.ts";
import { factoryReset } from "../data/driver.ts";
import {
  copySensitive,
  isAndroidPlatform,
  syncAndroidReminders,
} from "../lib/android-reminders.ts";
import { classifyPin, type PinState } from "../lib/appLock.ts";
import type { WalletEntryRow } from "../lib/budget.ts";
import { localISODateTime, todayLocal } from "../lib/dates.ts";
import { errText } from "../lib/errors.ts";
import type { SearchGroup } from "../lib/globalSearch.ts";
import { entryFormReady, recordedBalanceCents } from "../lib/mobileBudget.ts";
import {
  jobFormReady,
  loanFormReady,
  loanStateKey,
} from "../lib/mobileCreate.ts";
import {
  habitDoneToday,
  pinnedNotes,
  urgentTasks,
} from "../lib/mobileDashboard.ts";
import {
  formatBytes,
  reminderDraftReady,
  reminderIsFuture,
} from "../lib/mobileSettings.ts";
import { formatMMK, parseMMK } from "../lib/money.ts";
import {
  type ResetAttempt,
  resetAttemptFromError,
  resetAttemptFromOutcome,
  resetPinAccepted,
} from "../lib/reset.ts";
import { SEARCH_DEBOUNCE_MS } from "../lib/searchContract.ts";
import { SETTING_KEYS } from "../lib/settings.ts";
import { remindableHere } from "../lib/sync/reminderDelivery.ts";
import type {
  LoanDirection,
  ShoppingItemRow,
  ShoppingListRow,
  TaskRow,
  VaultItemRow,
} from "../lib/types.ts";
import { Dialog } from "./Dialog.tsx";
import { EmptyState } from "./EmptyState.tsx";
import {
  MarkdownDocument,
  markdownComponents,
  markdownUrlTransform,
} from "./MarkdownLink.tsx";
import { MobilePairingCard } from "./MobilePairingCard.tsx";
import { useLocale, useT } from "./useTranslation.ts";

/**
 * Loads a list once per mount and again after a reload.
 *
 * The reload counter is folded into the loader's identity rather than into the
 * effect's dependency list: that way the effect depends on ONE function whose
 * identity changes exactly when a re-read is wanted, and the counter is
 * genuinely used (a bare extra dependency is a lint error here).
 */
function useLoad<T>(loader: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  const load = useCallback(() => {
    void version; // the counter is the reason this identity changes
    return loader();
  }, [loader, version]);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    load()
      .then((value) => {
        if (!cancelled) setData(value);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);
  return { data, failed, reload };
}

function LoadMessage({ failed }: { failed: boolean }) {
  const t = useT();
  if (!failed) return null;
  return (
    <p className="mobile-error" role="alert">
      {t("mobile.loadFailed")}
    </p>
  );
}

// -- Notes -------------------------------------------------------------------

export function NotesScreen({ onCompose }: { onCompose: () => void }) {
  const t = useT();
  const load = useCallback(() => notesRepo.listNotes({ limit: 100 }), []);
  const { data, failed, reload } = useLoad(load);

  return (
    <section className="mobile-page">
      <p className="mobile-section-kicker">{t("nav.notes")}</p>
      <div className="mobile-actions">
        <button type="button" className="btn btn-primary" onClick={onCompose}>
          {t("notes.newNote")}
        </button>
      </div>
      <LoadMessage failed={failed} />
      {data !== null && data.length === 0 ? (
        <EmptyState>{t("notes.noNotes")}</EmptyState>
      ) : null}
      <ul className="mobile-list" aria-label={t("notes.notesAria")}>
        {(data ?? []).map((note) => (
          <li key={note.id} className="mobile-card">
            <p className="mobile-card-title">
              {note.title.trim() === "" ? t("notes.untitled") : note.title}
            </p>
            <p className="mobile-card-body">
              {note.content.trim() === "" ? t("notes.noExcerpt") : note.content}
            </p>
            <p className="mobile-card-meta">{note.updated_at}</p>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="mobile-link-btn"
        onClick={reload}
        hidden={!failed}
      >
        {t("common.tryAgain")}
      </button>
    </section>
  );
}

export function NoteCompose({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const empty = title.trim() === "" && content.trim() === "";

  const save = async () => {
    if (empty || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await notesRepo.createNote({ title: title.trim(), content });
      onDone();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mobile-page">
      <form
        className="mobile-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="mobile-field">
          <span>{t("notes.titleAria")}</span>
          <input
            className="input"
            type="text"
            value={title}
            placeholder={t("mobile.noteTitlePlaceholder")}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
        </label>
        <label className="mobile-field">
          <span>{t("notes.contentAria")}</span>
          <textarea
            className="input mobile-textarea"
            value={content}
            placeholder={t("notes.contentPlaceholder")}
            rows={6}
            onChange={(event) => setContent(event.currentTarget.value)}
          />
        </label>
        <LoadMessage failed={failed} />
        <div className="mobile-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || empty}
          >
            {busy ? t("notes.saving") : t("notes.save")}
          </button>
        </div>
      </form>
    </section>
  );
}

// -- Reminders ---------------------------------------------------------------

type ReminderRepeat = "none" | "daily" | "weekly" | "monthly";

const REMINDER_REPEATS: readonly ReminderRepeat[] = [
  "none",
  "daily",
  "weekly",
  "monthly",
];

const REPEAT_LABEL_KEYS: Record<
  ReminderRepeat,
  | "mobile.reminders.repeatNone"
  | "mobile.reminders.repeatDaily"
  | "mobile.reminders.repeatWeekly"
  | "mobile.reminders.repeatMonthly"
> = {
  none: "mobile.reminders.repeatNone",
  daily: "mobile.reminders.repeatDaily",
  weekly: "mobile.reminders.repeatWeekly",
  monthly: "mobile.reminders.repeatMonthly",
};

/**
 * Reminders on the Tasks page (Phase B session 4).
 *
 * The list is the pending rows the OS has been handed; creating one arms it
 * immediately instead of waiting for the app's next reconcile pass, because
 * this device is the one that notifies and the user just asked for that time.
 * There is no edit and no delete here — mobile is view + add only.
 */
export function RemindersPanel() {
  const t = useT();
  const load = useCallback(() => tasksRepo.listReminders(false), []);
  const { data, failed, reload } = useLoad(load);
  const [title, setTitle] = useState("");
  const [remindAt, setRemindAt] = useState("");
  const [repeat, setRepeat] = useState<ReminderRepeat>("none");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    if (busy) return;
    setError(null);
    setNotice(null);
    const draft = { title, remindAt };
    if (!reminderDraftReady(draft)) {
      setError(t("mobile.reminders.incomplete"));
      return;
    }
    if (!reminderIsFuture(draft.remindAt, localISODateTime(new Date()))) {
      setError(t("mobile.reminders.past"));
      return;
    }
    setBusy(true);
    try {
      await tasksRepo.createReminder({
        title: title.trim(),
        remindAt: draft.remindAt,
        repeat,
        note: "",
      });
      const granted = await isPermissionGranted().catch(() => false);
      if (isAndroidPlatform()) {
        // Hand the OS the new alarm now. A reconcile failure keeps the row —
        // the next app tick arms it — so it must not fail the save.
        try {
          // §13.1: the alarm is armed only for reminders this device created.
          const rows = remindableHere(
            await tasksRepo.listReminders(false),
            await localDeviceId(),
          );
          const preview = await settingsRepo
            .getNotificationPreview()
            .catch(() => false);
          const { outcomes } = await syncAndroidReminders(
            rows,
            preview,
            localISODateTime(new Date()),
          );
          if (outcomes.length > 0) await tasksRepo.settleReminders(outcomes);
        } catch {
          // Best effort, exactly like the app-level sync.
        }
      }
      setTitle("");
      setRemindAt("");
      setRepeat("none");
      setNotice(
        granted
          ? t("mobile.reminders.added")
          : t("mobile.reminders.notifyBlocked"),
      );
      reload();
    } catch {
      setError(t("mobile.reminders.addFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="mobile-section-kicker">{t("mobile.reminders.heading")}</p>
      <p className="mobile-note">{t("mobile.reminders.subtitle")}</p>
      <LoadMessage failed={failed} />
      {data !== null && data.length === 0 ? (
        <EmptyState>{t("mobile.reminders.empty")}</EmptyState>
      ) : null}
      <ul className="mobile-list" aria-label={t("mobile.reminders.listAria")}>
        {(data ?? []).map((reminder) => (
          <li key={reminder.id} className="mobile-row">
            <span className="mobile-row-text">
              {reminder.title}
              <span className="mobile-row-meta">
                {reminder.remind_at} · {t(REPEAT_LABEL_KEYS[reminder.repeat])}
              </span>
            </span>
          </li>
        ))}
      </ul>

      <div className="mobile-card">
        <label className="mobile-field">
          <span>{t("mobile.reminders.title")}</span>
          <input
            className="input"
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="mobile-field">
          <span>{t("mobile.reminders.when")}</span>
          <input
            className="input"
            type="datetime-local"
            value={remindAt}
            onChange={(event) => setRemindAt(event.target.value)}
          />
        </label>
        <label className="mobile-field">
          <span>{t("mobile.reminders.repeat")}</span>
          <select
            className="input"
            value={repeat}
            onChange={(event) =>
              setRepeat(event.target.value as ReminderRepeat)
            }
          >
            {REMINDER_REPEATS.map((value) => (
              <option key={value} value={value}>
                {t(REPEAT_LABEL_KEYS[value])}
              </option>
            ))}
          </select>
        </label>
        {error !== null ? (
          <p className="mobile-error" role="alert">
            {error}
          </p>
        ) : null}
        {notice !== null ? (
          <p className="alert alert-note" role="status">
            {notice}
          </p>
        ) : null}
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void add()}
        >
          {t("mobile.reminders.add")}
        </button>
      </div>
    </>
  );
}

// -- Settings ----------------------------------------------------------------

type ExactState = "exact" | "inexact" | "unknown";

/**
 * The reset act's step: no dialog open, the consequence disclosure (with the
 * PIN gate), or the second, explicit "Erase everything" confirmation.
 */
type ResetStage = "idle" | "confirm" | "erase";

interface SettingsFacts {
  schemaVersion: number | null;
  databaseBytes: number | null;
  backing: string | null;
  exact: ExactState;
  notifications: boolean | null;
  /**
   * The lock screen's own classification of `pin_hash`, read here rather than
   * re-derived: `null` means "not read yet", which is what keeps the reset act
   * disabled until the question has actually been answered — a PIN state the
   * screen assumed could only ever fail open.
   */
  pin: PinState | null;
}

const EMPTY_FACTS: SettingsFacts = {
  schemaVersion: null,
  databaseBytes: null,
  backing: null,
  exact: "unknown",
  notifications: null,
  pin: null,
};

/**
 * The phone's Settings (Phase B session 4, H.1).
 *
 * Every claim here is read from the device, never assumed: the sync status is
 * honestly off, the pairing block is a labelled prototype, the permission rows
 * ask the OS, and the diagnostics come from SQLite's counters and the wrapped
 * key's own header. Controls that belong to the desktop (tray, key export,
 * updater) are absent rather than disabled.
 *
 * The danger zone at the bottom is the phone half of F-1's fix: a deliberate
 * act that runs the SAME engine the desktop's Settings and Android's key-loss
 * flow use, behind the consequence disclosure, the app PIN (when one is set)
 * and a second explicit confirmation.
 */
export function SettingsScreen({
  onResetFinished,
}: {
  /**
   * Where a finished attempt lands — the shell's top-level handler, which
   * replaces the workspace with the terminal result screen. Same seam the
   * desktop's Settings page uses, so both paths end in one place.
   */
  onResetFinished: (attempt: ResetAttempt) => void;
}) {
  const t = useT();
  const [facts, setFacts] = useState<SettingsFacts>(EMPTY_FACTS);
  const [diagnosticsFailed, setDiagnosticsFailed] = useState(false);
  const [asking, setAsking] = useState(false);
  const [opening, setOpening] = useState(false);

  // The reset act's two-step state machine: `confirm` is the consequence
  // disclosure (plus the PIN gate), `erase` is the second, explicit
  // confirmation that actually runs the engine. `idle` is the only state with
  // no dialog on screen.
  const [resetStage, setResetStage] = useState<ResetStage>("idle");
  const [pinEntry, setPinEntry] = useState("");
  const [pinWrong, setPinWrong] = useState(false);
  const [checkingPin, setCheckingPin] = useState(false);
  /** The pinned double-submit guard for the PIN check (submit-guards): a ref,
   *  raised before the first `await`, so a second tap cannot start a second
   *  PBKDF2 derivation before React has re-rendered. */
  const checkingPinRef = useRef(false);
  const [resetting, setResetting] = useState(false);
  /** The pinned double-submit guard for the engine itself: a second engine run
   *  would race the first one's file deletions mid-flight. */
  const resettingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setDiagnosticsFailed(false);
    // One fact per promise: a permission or diagnostic that cannot be read
    // must not blank the ones that can.
    void (async () => {
      const [diagnostics, backing, exact, permission, rawPin] =
        await Promise.all([
          readMobileDiagnostics().catch(() => null),
          invoke<string>("keystore_backing").catch(() => null),
          invoke<string>("reminder_exact_state").catch(() => null),
          isPermissionGranted().catch(() => null),
          settingsRepo.getRaw(SETTING_KEYS.pinHash).then(
            (value) => value,
            () => null,
          ),
        ]);
      if (cancelled) return;
      setDiagnosticsFailed(diagnostics === null);
      setFacts({
        schemaVersion: diagnostics?.schemaVersion ?? null,
        databaseBytes: diagnostics?.databaseBytes ?? null,
        backing,
        exact: exact === "exact" || exact === "inexact" ? exact : "unknown",
        notifications: permission,
        pin:
          rawPin === null
            ? { kind: "unreadable", reason: "corrupt" }
            : classifyPin(rawPin),
      });
    })().catch(() => {
      if (!cancelled) setDiagnosticsFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const askNotifications = async () => {
    setAsking(true);
    try {
      const answer = await requestPermission();
      setFacts((current) => ({
        ...current,
        notifications: answer === "granted",
      }));
    } catch {
      setFacts((current) => ({ ...current, notifications: null }));
    } finally {
      setAsking(false);
    }
  };

  const openExact = async () => {
    setOpening(true);
    try {
      await invoke("reminder_open_exact_alarm_settings");
    } catch {
      // The OS screen may refuse; the disclosure already told the truth.
    } finally {
      setOpening(false);
    }
  };

  /** Close whichever dialog is open, and forget the half-typed PIN with it. */
  const closeResetDialog = () => {
    setResetStage("idle");
    setPinEntry("");
    setPinWrong(false);
  };

  /**
   * Step 1 → step 2: the PIN gate (F-1 — a borrowed phone must not be
   * wipeable from Settings). The decision is `lib/reset.ts`'s pure
   * `resetPinAccepted`: no PIN set needs no proof, an unreadable PIN fails
   * closed, a stored PIN must verify. This is only the wiring around it —
   * advance the stage on `true`, say so on `false`.
   */
  const advancePastPin = async () => {
    if (checkingPinRef.current) return;
    const pin = facts.pin;
    // Not read yet. The Continue button is disabled in that state; this return
    // is what keeps a keyboard path from advancing on an assumed answer.
    if (pin === null) return;
    checkingPinRef.current = true;
    setCheckingPin(true);
    setPinWrong(false);
    try {
      if (!(await resetPinAccepted(pin, pinEntry))) {
        setPinWrong(true);
        return;
      }
      setResetStage("erase");
    } finally {
      checkingPinRef.current = false;
      setCheckingPin(false);
    }
  };

  /**
   * Step 2 → the engine: the SECOND sanctioned call site of `factoryReset()`
   * in the app (the desktop's guarded Settings handler is the first; both are
   * pinned by `src/reset-gate.test.ts`, because the policy gate is
   * frontend-only by design and the tests are what keep it true).
   *
   * Reachable from the erase dialog's button alone, and refused here unless
   * the stage machine says the PIN gate already passed — the same shape as the
   * desktop's `runFactoryReset`, down to the double-submit ref and the attempt
   * handed straight to the shell. The attempt, resolved outcome OR throw, ends
   * up on the terminal result screen, which owns the restart behind the
   * complete-check; this screen never restarts the app itself.
   */
  const runPhoneReset = async () => {
    if (resettingRef.current) return;
    if (resetStage !== "erase") return;
    resettingRef.current = true;
    setResetting(true);
    try {
      onResetFinished(resetAttemptFromOutcome(await factoryReset()));
    } catch (e) {
      // An IPC failure is an incomplete attempt, never a success: no report
      // arrived, so nothing may be assumed about what was removed.
      onResetFinished(resetAttemptFromError(errText(e)));
    } finally {
      resettingRef.current = false;
      setResetting(false);
    }
  };

  const pinText =
    facts.pin === null
      ? ""
      : facts.pin.kind === "stored"
        ? t("mobile.settings.pinStored")
        : facts.pin.kind === "absent"
          ? t("mobile.settings.pinAbsent")
          : t("mobile.settings.pinUnreadable");

  return (
    <section className="mobile-page">
      <p className="mobile-section-kicker">
        {t("mobile.settings.syncHeading")}
      </p>
      <div className="mobile-card">
        <p className="mobile-row-text">{t("mobile.settings.syncOff")}</p>
      </div>

      <p className="mobile-section-kicker">
        {t("mobile.settings.pairHeading")}
      </p>
      <MobilePairingCard />

      <p className="mobile-section-kicker">
        {t("mobile.settings.permissionsHeading")}
      </p>
      <div className="mobile-card">
        <p className="mobile-fact-term">{t("mobile.settings.notifications")}</p>
        <p className="mobile-row-text">
          {facts.notifications === null
            ? t("mobile.settings.notificationsUnknown")
            : facts.notifications
              ? t("mobile.settings.notificationsOn")
              : t("mobile.settings.notificationsOff")}
        </p>
        {facts.notifications === false ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={asking}
            onClick={() => void askNotifications()}
          >
            {t("mobile.settings.enableNotifications")}
          </button>
        ) : null}
      </div>
      <div className="mobile-card">
        <p className="mobile-fact-term">{t("mobile.settings.exactAlarms")}</p>
        <p className="mobile-row-text">
          {facts.exact === "exact"
            ? t("mobile.settings.exactOn")
            : facts.exact === "inexact"
              ? t("mobile.settings.exactOff")
              : t("mobile.settings.exactUnknown")}
        </p>
        {facts.exact === "inexact" ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={opening}
            onClick={() => void openExact()}
          >
            {t("mobile.settings.openExact")}
          </button>
        ) : null}
      </div>

      <p className="mobile-section-kicker">
        {t("mobile.settings.securityHeading")}
      </p>
      <ul className="mobile-list">
        {pinText !== "" ? <li className="mobile-row-text">{pinText}</li> : null}
        <li className="mobile-row-text">{t("mobile.settings.screenshots")}</li>
        <li className="mobile-row-text">{t("mobile.settings.encryption")}</li>
        <li className="mobile-row-text">{t("mobile.settings.keyLoss")}</li>
      </ul>

      <p className="mobile-section-kicker">
        {t("mobile.settings.diagnosticsHeading")}
      </p>
      {diagnosticsFailed ? (
        <p className="mobile-error" role="alert">
          {t("mobile.settings.diagnosticsFailed")}
        </p>
      ) : null}
      <dl className="mobile-facts">
        <dt>{t("mobile.settings.schemaVersion")}</dt>
        <dd>{facts.schemaVersion ?? t("mobile.settings.unknown")}</dd>
        <dt>{t("mobile.settings.databaseSize")}</dt>
        <dd>
          {facts.databaseBytes === null
            ? t("mobile.settings.unknown")
            : formatBytes(facts.databaseBytes)}
        </dd>
        <dt>{t("mobile.settings.keystoreBacking")}</dt>
        <dd>{facts.backing ?? t("mobile.settings.unknown")}</dd>
      </dl>

      {/* F-1's phone-side act. Two dialogs on purpose: this button only opens
          the disclosure (consequences + the app PIN when one is set), and the
          engine stays unreachable until the SECOND dialog's own button — which
          `src/reset-gate.test.ts` pins from the source. */}
      <p className="mobile-section-kicker">{t("mobile.reset.title")}</p>
      <div className="mobile-card">
        <p className="mobile-row-text">{t("mobile.reset.lead")}</p>
        {/* Disabled until the PIN question has actually been ANSWERED:
            `facts.pin === null` means "not read yet", and an act that must
            fail closed may not start from an assumed answer. */}
        <button
          type="button"
          className="btn btn-danger"
          disabled={facts.pin === null || resetting}
          onClick={() => {
            setPinEntry("");
            setPinWrong(false);
            setResetStage("confirm");
          }}
        >
          {t("mobile.reset.action")}
        </button>
      </div>

      {resetStage === "confirm" ? (
        <Dialog
          labelledBy="mobile-reset-title"
          onClose={closeResetDialog}
          locked={checkingPin || resetting}
        >
          <h2 className="editor-title" id="mobile-reset-title">
            {t("mobile.reset.dialogTitle")}
          </h2>
          <ul className="mobile-list">
            <li className="mobile-row-text">
              {t("mobile.reset.consequenceDatabase")}
            </li>
            <li className="mobile-row-text">
              {t("mobile.reset.consequencePairing")}
            </li>
            <li className="mobile-row-text">
              {t("mobile.reset.consequenceFirstRun")}
            </li>
            <li className="mobile-row-text">
              {t("mobile.reset.consequenceDesktop")}
            </li>
            <li className="mobile-row-text">
              {t("mobile.reset.consequenceLost")}
            </li>
          </ul>
          {facts.pin?.kind === "unreadable" ? (
            <p className="mobile-error" role="alert">
              {t("mobile.reset.pinUnreadable")}
            </p>
          ) : null}
          {facts.pin?.kind === "stored" ? (
            <label>
              {t("mobile.reset.pinLabel")}
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={pinEntry}
                disabled={checkingPin || resetting}
                onChange={(event) => {
                  setPinEntry(event.target.value);
                  setPinWrong(false);
                }}
              />
            </label>
          ) : null}
          {pinWrong ? (
            <p className="mobile-error" role="alert">
              {t("mobile.reset.pinWrong")}
            </p>
          ) : null}
          <div className="row-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={checkingPin || resetting}
              onClick={closeResetDialog}
            >
              {t("common.cancel")}
            </button>
            {/* Continue is unreachable while the PIN state is unknown or
                unreadable — both fail closed — and needs an entry to check. */}
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                checkingPin ||
                resetting ||
                facts.pin === null ||
                facts.pin.kind === "unreadable" ||
                (facts.pin.kind === "stored" && pinEntry === "")
              }
              onClick={() => void advancePastPin()}
            >
              {checkingPin ? t("common.checking") : t("mobile.reset.continue")}
            </button>
          </div>
        </Dialog>
      ) : null}

      {resetStage === "erase" ? (
        <Dialog
          labelledBy="mobile-reset-erase-title"
          onClose={closeResetDialog}
          locked={resetting}
        >
          <h2 className="editor-title" id="mobile-reset-erase-title">
            {t("mobile.reset.confirmTitle")}
          </h2>
          <p className="muted">{t("mobile.reset.confirmBody")}</p>
          <ul className="mobile-list">
            <li className="mobile-row-text">
              {t("mobile.reset.consequenceDesktop")}
            </li>
            <li className="mobile-row-text">
              {t("mobile.reset.consequenceLost")}
            </li>
          </ul>
          {resetting ? (
            <p className="alert alert-warn" role="status">
              {t("mobile.reset.running")}
            </p>
          ) : null}
          <div className="row-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={resetting}
              onClick={closeResetDialog}
            >
              {t("common.cancel")}
            </button>
            {/* The one entry to the engine on this screen — and only while the
                stage machine says the PIN gate above has already passed. */}
            <button
              type="button"
              className="btn btn-danger"
              disabled={resetting}
              onClick={() => void runPhoneReset()}
            >
              {t("mobile.reset.erase")}
            </button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}

// -- Tasks -------------------------------------------------------------------

export function TasksScreen({ onCompose }: { onCompose: () => void }) {
  const t = useT();
  const load = useCallback(() => tasksRepo.listTasks(true), []);
  const { data, failed, reload } = useLoad(load);
  const [busyId, setBusyId] = useState<number | null>(null);

  const toggle = async (task: TaskRow) => {
    setBusyId(task.id);
    try {
      await tasksRepo.toggleTask(task.id, task.done === 0);
      reload();
    } finally {
      setBusyId(null);
    }
  };

  const tasks = data ?? [];
  const open = tasks.filter((task) => task.done === 0);
  const done = tasks.filter((task) => task.done === 1);

  return (
    <section className="mobile-page">
      <p className="mobile-section-kicker">{t("tasks.title")}</p>
      <div className="mobile-actions">
        <button type="button" className="btn btn-primary" onClick={onCompose}>
          {t("tasks.newTask")}
        </button>
      </div>
      <LoadMessage failed={failed} />
      {data !== null && open.length === 0 ? (
        <EmptyState>{t("tasks.empty")}</EmptyState>
      ) : null}
      <ul className="mobile-list" aria-label={t("tasks.openAria")}>
        {open.map((task) => (
          <li key={task.id}>
            <label className="mobile-row">
              <input
                type="checkbox"
                checked={false}
                disabled={busyId === task.id}
                aria-label={t("mobile.markDoneOf", { title: task.title })}
                onChange={() => void toggle(task)}
              />
              <span className="mobile-row-text">
                {task.title}
                {task.due_date !== null ? (
                  <span className="mobile-row-meta">
                    {task.due_date < todayLocal()
                      ? t("tasks.overdue")
                      : t("tasks.due", { date: task.due_date })}
                  </span>
                ) : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {done.length > 0 ? (
        <>
          <p className="mobile-section-kicker">{t("tasks.completed")}</p>
          <ul className="mobile-list" aria-label={t("tasks.completed")}>
            {done.map((task) => (
              <li key={task.id}>
                <label className="mobile-row is-done">
                  <input
                    type="checkbox"
                    checked
                    disabled={busyId === task.id}
                    aria-label={t("mobile.markNotDoneOf", {
                      title: task.title,
                    })}
                    onChange={() => void toggle(task)}
                  />
                  <span className="mobile-row-text">{task.title}</span>
                </label>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <RemindersPanel />
    </section>
  );
}

export function TaskCompose({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const save = async () => {
    if (title.trim() === "" || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await tasksRepo.createTask({
        title: title.trim(),
        dueDate: dueDate === "" ? null : dueDate,
      });
      onDone();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mobile-page">
      <form
        className="mobile-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="mobile-field">
          <span>{t("tasks.titleLabel")}</span>
          <input
            className="input"
            type="text"
            value={title}
            placeholder={t("tasks.titlePlaceholder")}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
        </label>
        <label className="mobile-field">
          <span>{t("tasks.dueLabel")}</span>
          <input
            className="input"
            type="date"
            value={dueDate}
            aria-label={t("tasks.dueAria")}
            onChange={(event) => setDueDate(event.currentTarget.value)}
          />
        </label>
        <LoadMessage failed={failed} />
        <div className="mobile-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || title.trim() === ""}
          >
            {busy ? t("notes.saving") : t("tasks.add")}
          </button>
        </div>
      </form>
    </section>
  );
}

// -- Shopping ----------------------------------------------------------------

export function ShoppingScreen({ onCompose }: { onCompose: () => void }) {
  const t = useT();
  const load = useCallback(() => shoppingRepo.listLists(), []);
  const { data: lists, failed, reload } = useLoad(load);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newList, setNewList] = useState("");
  const [creating, setCreating] = useState(false);
  const [items, setItems] = useState<ShoppingItemRow[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);

  const all = lists ?? [];
  const selected = all.find((list) => list.id === selectedId) ?? all[0];

  // The item list follows the selected list; `reloadIfEmpty` re-reads the
  // lists after the create form adds one.
  useEffect(() => {
    if (selected === undefined) {
      setItems([]);
      return;
    }
    let cancelled = false;
    shoppingRepo
      .listItems(selected.id)
      .then((rows) => {
        if (!cancelled) setItems(rows);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const toggleItem = async (item: ShoppingItemRow) => {
    setBusyId(item.id);
    try {
      await shoppingRepo.toggleItem(item.id, item.done === 0);
      const rows = await shoppingRepo.listItems(item.list_id);
      setItems(rows);
    } finally {
      setBusyId(null);
    }
  };

  const createList = async () => {
    const name = newList.trim();
    if (name === "" || creating) return;
    setCreating(true);
    try {
      const id = await shoppingRepo.createList(name);
      setNewList("");
      setSelectedId(id);
      reload();
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="mobile-page">
      <p className="mobile-section-kicker">{t("nav.shopping")}</p>
      <div className="mobile-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={onCompose}
          disabled={all.length === 0}
        >
          {t("mobile.addItem")}
        </button>
      </div>
      <LoadMessage failed={failed} />
      {all.length === 0 ? (
        <EmptyState>{t("mobile.shoppingNoLists")}</EmptyState>
      ) : (
        <div
          className="mobile-chips"
          role="tablist"
          aria-label={t("nav.shopping")}
        >
          {all.map((list) => (
            <button
              key={list.id}
              type="button"
              role="tab"
              aria-selected={(selected?.id ?? null) === list.id}
              className={
                (selected?.id ?? null) === list.id
                  ? "mobile-chip is-active"
                  : "mobile-chip"
              }
              onClick={() => setSelectedId(list.id)}
            >
              {list.name}
            </button>
          ))}
        </div>
      )}
      {all.length > 0 && items.length === 0 ? (
        <EmptyState>{t("mobile.shoppingEmpty")}</EmptyState>
      ) : null}
      <ul className="mobile-list" aria-label={t("mobile.shoppingItemsAria")}>
        {items.map((item) => (
          <li key={item.id}>
            <label
              className={item.done === 0 ? "mobile-row" : "mobile-row is-done"}
            >
              <input
                type="checkbox"
                checked={item.done === 1}
                disabled={busyId === item.id}
                aria-label={
                  item.done === 1
                    ? t("mobile.markNotBoughtOf", { title: item.text })
                    : t("mobile.markBoughtOf", { title: item.text })
                }
                onChange={() => void toggleItem(item)}
              />
              <span className="mobile-row-text">{item.text}</span>
            </label>
          </li>
        ))}
      </ul>
      <form
        className="mobile-actions"
        onSubmit={(event) => {
          event.preventDefault();
          void createList();
        }}
      >
        <input
          className="input"
          type="text"
          value={newList}
          placeholder={t("mobile.shoppingNewList")}
          aria-label={t("mobile.shoppingNewList")}
          onChange={(event) => setNewList(event.currentTarget.value)}
        />
        <button
          type="submit"
          className="btn"
          disabled={creating || newList.trim() === ""}
        >
          {t("mobile.shoppingCreateList")}
        </button>
      </form>
    </section>
  );
}

export function ShoppingItemCompose({ onDone }: { onDone: () => void }) {
  const t = useT();
  const load = useCallback(() => shoppingRepo.listLists(), []);
  const { data: lists, failed } = useLoad(load);
  const [text, setText] = useState("");
  const [listId, setListId] = useState<number | null>(null);
  const [newListName, setNewListName] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const all: ShoppingListRow[] = lists ?? [];
  const targetId = listId ?? all[0]?.id ?? null;

  const save = async () => {
    if (text.trim() === "" || busy) return;
    setBusy(true);
    setSaveFailed(false);
    try {
      let destination = targetId;
      if (destination === null) {
        const name = newListName.trim();
        if (name === "") {
          setBusy(false);
          return;
        }
        destination = await shoppingRepo.createList(name);
      }
      await shoppingRepo.addItem(destination, text.trim());
      onDone();
    } catch {
      setSaveFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mobile-page">
      <form
        className="mobile-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="mobile-field">
          <span>{t("mobile.shoppingItemLabel")}</span>
          <input
            className="input"
            type="text"
            value={text}
            placeholder={t("mobile.shoppingItemPlaceholder")}
            onChange={(event) => setText(event.currentTarget.value)}
          />
        </label>
        {all.length > 0 ? (
          <label className="mobile-field">
            <span>{t("mobile.shoppingListLabel")}</span>
            <select
              className="input"
              value={String(targetId ?? "")}
              onChange={(event) => setListId(Number(event.currentTarget.value))}
            >
              {all.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="mobile-field">
            <span>{t("mobile.shoppingListName")}</span>
            <input
              className="input"
              type="text"
              value={newListName}
              placeholder={t("mobile.shoppingNewList")}
              onChange={(event) => setNewListName(event.currentTarget.value)}
            />
          </label>
        )}
        <LoadMessage failed={failed || saveFailed} />
        <div className="mobile-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || text.trim() === ""}
          >
            {busy ? t("notes.saving") : t("mobile.addItem")}
          </button>
        </div>
      </form>
    </section>
  );
}

// -- Business: jobs, create-only ---------------------------------------------

/**
 * The Business screen: the shop's jobs with shop, total and status.
 *
 * Create-only (decision 4): the only control here is "New job". There is no
 * amount-paid field and no mark-paid action anywhere on this surface — job
 * payments are recorded on the desktop, and a job created on the phone stays
 * open with its full total outstanding.
 */
export function BusinessScreen({ onCompose }: { onCompose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const load = useCallback(async () => {
    const [jobs, shops] = await Promise.all([
      businessRepo.listJobs(),
      businessRepo.listShops(),
    ]);
    return { jobs, shops };
  }, []);
  const { data, failed, reload } = useLoad(load);

  const jobs = data?.jobs ?? [];
  const shopNames = new Map(
    (data?.shops ?? []).map((shop) => [shop.id, shop.name]),
  );

  return (
    <section className="mobile-page">
      <p className="mobile-section-kicker">{t("nav.business")}</p>
      <div className="mobile-actions">
        <button type="button" className="btn btn-primary" onClick={onCompose}>
          {t("mobile.job.new")}
        </button>
      </div>
      <p className="muted">{t("mobile.job.noPayment")}</p>
      <LoadMessage failed={failed} />
      {data !== null && jobs.length === 0 ? (
        <EmptyState>{t("mobile.job.empty")}</EmptyState>
      ) : null}
      <ul className="mobile-list" aria-label={t("mobile.job.listAria")}>
        {jobs.map((job) => (
          <li key={job.id} className="mobile-card">
            <span className="mobile-wallet-line">
              <span className="mobile-card-title">{job.title}</span>
              <span className="mobile-card-title">
                {formatMMK(job.total_cents, locale)}
              </span>
            </span>
            <span className="mobile-card-meta">
              {job.shop_id === null
                ? t("mobile.job.noShop")
                : (shopNames.get(job.shop_id) ?? t("mobile.job.deletedShop"))}
              {" · "}
              {job.job_date}
              {" · "}
              {job.status === "open"
                ? t("mobile.job.statusOpen")
                : t("mobile.job.statusPaid")}
            </span>
            {job.status === "open" ? (
              <span className="mobile-card-meta">
                {t("mobile.job.outstanding", {
                  amount: formatMMK(job.total_cents - job.paid_cents, locale),
                })}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="mobile-link-btn"
        onClick={reload}
        hidden={!failed}
      >
        {t("common.tryAgain")}
      </button>
    </section>
  );
}

/**
 * The job create form, opened from the FAB speed-dial or the Business screen.
 * It has no payment field: a saved job is open, unpaid, and worth its total.
 */
export function JobCompose({ onDone }: { onDone: () => void }) {
  const t = useT();
  const load = useCallback(() => businessRepo.listShops(), []);
  const { data, failed } = useLoad(load);
  const [title, setTitle] = useState("");
  const [shopId, setShopId] = useState<number | null>(null);
  const [total, setTotal] = useState("");
  const [jobDate, setJobDate] = useState(() => todayLocal());
  const [busy, setBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const shops = data ?? [];
  const totalCents = parseMMK(total);
  const ready = jobFormReady({ title, totalCents });
  const amountProblem =
    total.trim() !== "" && (totalCents === null || totalCents <= 0);

  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setSaveFailed(false);
    try {
      await businessRepo.createJob({
        title: title.trim(),
        shopId,
        totalCents: totalCents ?? 0,
        jobDate: jobDate === "" ? todayLocal() : jobDate,
      });
      onDone();
    } catch {
      setSaveFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mobile-page">
      <p className="muted">{t("mobile.job.noPayment")}</p>
      <LoadMessage failed={failed} />
      <form
        className="mobile-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="mobile-field">
          <span>{t("mobile.job.titleLabel")}</span>
          <input
            className="input"
            type="text"
            value={title}
            placeholder={t("mobile.job.titlePlaceholder")}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
        </label>
        <label className="mobile-field">
          <span>{t("mobile.job.totalLabel")}</span>
          <input
            className="input"
            type="text"
            inputMode="decimal"
            value={total}
            placeholder={t("mobile.job.totalPlaceholder")}
            aria-invalid={amountProblem}
            onChange={(event) => setTotal(event.currentTarget.value)}
          />
        </label>
        {amountProblem ? (
          <p className="mobile-error" role="alert">
            {t("mobile.entry.invalidAmount")}
          </p>
        ) : null}
        <label className="mobile-field">
          <span>{t("mobile.job.shopLabel")}</span>
          <select
            className="input"
            value={String(shopId ?? "")}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setShopId(value === "" ? null : Number(value));
            }}
          >
            <option value="">{t("mobile.job.shopNone")}</option>
            {shops.map((shop) => (
              <option key={shop.id} value={shop.id}>
                {shop.name}
              </option>
            ))}
          </select>
        </label>
        <label className="mobile-field">
          <span>{t("mobile.job.dateLabel")}</span>
          <input
            className="input"
            type="date"
            value={jobDate}
            onChange={(event) => setJobDate(event.currentTarget.value)}
          />
        </label>
        <LoadMessage failed={saveFailed} />
        <div className="mobile-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !ready}
          >
            {busy ? t("notes.saving") : t("mobile.job.save")}
          </button>
        </div>
      </form>
    </section>
  );
}

// -- Loans: view + create, no repayments -------------------------------------

/**
 * The Loans screen: lent and borrowed loans with counterparty, amount and
 * direction.
 *
 * Create-only (decision 4): no repayment control exists here. Repayments are
 * recorded on the desktop; this screen never offers to move money.
 */
export function LoansScreen({ onCompose }: { onCompose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const load = useCallback(
    () => loansRepo.listLoansWithState(todayLocal()),
    [],
  );
  const { data, failed, reload } = useLoad(load);
  const loans = data ?? [];

  return (
    <section className="mobile-page">
      <p className="mobile-section-kicker">{t("nav.loans")}</p>
      <div className="mobile-actions">
        <button type="button" className="btn btn-primary" onClick={onCompose}>
          {t("mobile.loan.new")}
        </button>
      </div>
      <p className="muted">{t("mobile.loan.noRepayment")}</p>
      <LoadMessage failed={failed} />
      {data !== null && loans.length === 0 ? (
        <EmptyState>{t("mobile.loan.empty")}</EmptyState>
      ) : null}
      <ul className="mobile-list" aria-label={t("mobile.loan.listAria")}>
        {loans.map((loan) => (
          <li key={loan.id} className="mobile-card">
            <span className="mobile-wallet-line">
              <span className="mobile-card-title">{loan.counterparty}</span>
              <span className="mobile-card-title">
                {formatMMK(loan.amount_cents, locale)}
              </span>
            </span>
            <span className="mobile-card-meta">
              {loan.direction === "lent"
                ? t("mobile.loan.lent")
                : t("mobile.loan.borrowed")}
              {" · "}
              {t(loanStateKey(loan.state))}
              {loan.due_date !== null
                ? ` · ${t("mobile.loan.due", { date: loan.due_date })}`
                : ""}
            </span>
            {loan.state !== "closed" ? (
              <span className="mobile-card-meta">
                {t("mobile.loan.remaining", {
                  amount: formatMMK(loan.remaining_cents, locale),
                })}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="mobile-link-btn"
        onClick={reload}
        hidden={!failed}
      >
        {t("common.tryAgain")}
      </button>
    </section>
  );
}

/** The loan create form. No repayment field: a saved loan starts unpaid. */
export function LoanCompose({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [direction, setDirection] = useState<LoanDirection>("lent");
  const [counterparty, setCounterparty] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const amountCents = parseMMK(amount);
  const ready = loanFormReady({ counterparty, amountCents });
  const amountProblem =
    amount.trim() !== "" && (amountCents === null || amountCents <= 0);

  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setSaveFailed(false);
    try {
      await loansRepo.createLoan({
        counterparty: counterparty.trim(),
        direction,
        amountCents: amountCents ?? 0,
        dueDate: dueDate === "" ? null : dueDate,
      });
      onDone();
    } catch {
      setSaveFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mobile-page">
      <p className="muted">{t("mobile.loan.noRepayment")}</p>
      <form
        className="mobile-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="mobile-field">
          <span>{t("mobile.loan.directionLabel")}</span>
          <select
            className="input"
            value={direction}
            onChange={(event) => {
              setDirection(
                event.currentTarget.value === "borrowed" ? "borrowed" : "lent",
              );
            }}
          >
            <option value="lent">{t("mobile.loan.lent")}</option>
            <option value="borrowed">{t("mobile.loan.borrowed")}</option>
          </select>
        </label>
        <label className="mobile-field">
          <span>{t("mobile.loan.counterpartyLabel")}</span>
          <input
            className="input"
            type="text"
            value={counterparty}
            placeholder={t("mobile.loan.counterpartyPlaceholder")}
            onChange={(event) => setCounterparty(event.currentTarget.value)}
          />
        </label>
        <label className="mobile-field">
          <span>{t("mobile.loan.amountLabel")}</span>
          <input
            className="input"
            type="text"
            inputMode="decimal"
            value={amount}
            placeholder={t("mobile.loan.amountPlaceholder")}
            aria-invalid={amountProblem}
            onChange={(event) => setAmount(event.currentTarget.value)}
          />
        </label>
        {amountProblem ? (
          <p className="mobile-error" role="alert">
            {t("mobile.entry.invalidAmount")}
          </p>
        ) : null}
        <label className="mobile-field">
          <span>{t("mobile.loan.dueLabel")}</span>
          <input
            className="input"
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.currentTarget.value)}
          />
        </label>
        <LoadMessage failed={saveFailed} />
        <div className="mobile-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !ready}
          >
            {busy ? t("notes.saving") : t("mobile.loan.save")}
          </button>
        </div>
      </form>
    </section>
  );
}

// -- Habits: 1-tap check-ins, no creation -------------------------------------

/**
 * The Habits page: every habit with today's check-in and its streak.
 *
 * The checkbox reads the same `week` the Dashboard reads (both go through
 * `habitDoneToday` over `habitProgressList`), so one habit has one truth. A
 * toggle writes today's `habit_logs` row (with its UUID v4 `uid`) or removes
 * it; there is no add-habit form here, because habits are created on the
 * desktop and the FAB deliberately has no habit action.
 */
export function HabitsScreen() {
  const t = useT();
  const today = todayLocal();
  const load = useCallback(() => habitsRepo.habitProgressList(today), [today]);
  const { data, failed, reload } = useLoad(load);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [writeFailed, setWriteFailed] = useState(false);

  const toggle = async (habitId: number) => {
    setBusyId(habitId);
    setWriteFailed(false);
    try {
      await habitsRepo.toggleLog(habitId, today);
      reload();
    } catch {
      setWriteFailed(true);
    } finally {
      setBusyId(null);
    }
  };

  const habits = data ?? [];

  return (
    <section className="mobile-page">
      <p className="mobile-section-kicker">{t("nav.habits")}</p>
      <p className="muted">{t("mobile.habits.noCreate")}</p>
      <LoadMessage failed={failed || writeFailed} />
      {data !== null && habits.length === 0 ? (
        <EmptyState>{t("mobile.habits.empty")}</EmptyState>
      ) : null}
      <ul className="mobile-list" aria-label={t("mobile.habits.listAria")}>
        {habits.map((progress) => {
          const done = habitDoneToday(progress.week, today);
          return (
            <li key={progress.habit.id}>
              <label className={done ? "mobile-row is-done" : "mobile-row"}>
                <input
                  type="checkbox"
                  checked={done}
                  disabled={busyId === progress.habit.id}
                  aria-label={
                    done
                      ? t("mobile.markNotDoneOf", {
                          title: progress.habit.name,
                        })
                      : t("mobile.markDoneOf", { title: progress.habit.name })
                  }
                  onChange={() => void toggle(progress.habit.id)}
                />
                <span className="mobile-row-text">
                  {progress.habit.name}
                  <span className="mobile-row-meta">
                    {t("mobile.habits.streak", {
                      count: String(progress.current),
                    })}
                    {" · "}
                    {t("mobile.habits.best", {
                      count: String(progress.best),
                    })}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="mobile-link-btn"
        onClick={reload}
        hidden={!failed}
      >
        {t("common.tryAgain")}
      </button>
    </section>
  );
}

// -- Vault: lookup + copy only -----------------------------------------------

type VaultPhase = "loading" | "error" | "unset" | "locked" | "open";

/** Seconds the sensitive clipboard holds the value (the bridge reports it). */
const VAULT_CLIPBOARD_SECONDS = 30;

/**
 * The Vault: titles only until the vault password is entered, then reveal +
 * copy per item.
 *
 * Decision 2: lookup and copy only. There is no add, edit, delete or
 * change-password control on this surface, and no setup form — a phone whose
 * vault was never set up says so and points at the desktop. Decrypted values
 * live only in this component's state, are dropped when the app goes to the
 * background or the screen closes, and the vault's key cache is locked with
 * them.
 */
export function VaultScreen() {
  const t = useT();
  const [phase, setPhase] = useState<VaultPhase>("loading");
  const [items, setItems] = useState<
    Omit<VaultItemRow, "ciphertext" | "salt" | "iv">[]
  >([]);
  const [password, setPassword] = useState<string | null>(null);
  const [unlockPwd, setUnlockPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealedId, setRevealedId] = useState<number | null>(null);
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Metadata only: the list never carries a ciphertext, let alone a secret.
  useEffect(() => {
    void reloadKey; // the counter is the reason this effect re-runs
    let cancelled = false;
    setPhase("loading");
    (async () => {
      const setUp = await vaultRepo.isSetUp();
      if (cancelled) return;
      if (!setUp) {
        setItems([]);
        setPhase("unset");
        return;
      }
      const rows = await vaultRepo.listItems();
      if (cancelled) return;
      setItems(rows);
      setPhase("locked");
    })().catch(() => {
      if (!cancelled) setPhase("error");
    });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // A backgrounded app must not keep a decrypted secret (or a decrypting key)
  // in memory. The shell's one-minute grace applies to the notebook; the vault
  // re-locks the moment it leaves the foreground.
  useEffect(() => {
    const onHidden = () => {
      if (!document.hidden) return;
      vaultRepo.lockVault();
      setPassword(null);
      setRevealedId(null);
      setRevealedValue(null);
      setCopyNotice(null);
      setUnlockPwd("");
      setPhase((current) => (current === "open" ? "locked" : current));
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      vaultRepo.lockVault();
    };
  }, []);

  const unlock = async () => {
    if (unlockPwd === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await vaultRepo.unlock(unlockPwd);
      setPassword(unlockPwd);
      setItems(await vaultRepo.listItems());
      setUnlockPwd("");
      setPhase("open");
    } catch (e) {
      setError(
        e instanceof Error && e.name === "WrongPasswordError"
          ? t("vault.error.wrongPassword")
          : t("mobile.loadFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  const toggleReveal = async (id: number) => {
    if (revealedId === id) {
      setRevealedId(null);
      setRevealedValue(null);
      setCopyNotice(null);
      return;
    }
    if (password === null) return;
    setError(null);
    setCopyNotice(null);
    try {
      const got = await vaultRepo.getItem(id, password);
      if (!got) {
        setError(t("mobile.vault.missing"));
        return;
      }
      setRevealedId(id);
      setRevealedValue(got.plaintext);
    } catch {
      setRevealedId(null);
      setRevealedValue(null);
      setError(t("mobile.vault.decryptFailed"));
    }
  };

  const copy = async (value: string) => {
    setError(null);
    try {
      if (isAndroidPlatform()) {
        // The one proven sensitive path: IS_SENSITIVE-marked, cleared by the
        // native timer. The notice repeats that the clear is best effort.
        const delay = await copySensitive(value);
        setCopyNotice(
          t("notes.copyBestEffort", {
            seconds: String(Math.round(delay / 1000)),
          }),
        );
      } else {
        await navigator.clipboard.writeText(value);
        setCopyNotice(t("notes.copied"));
      }
    } catch {
      setError(t("common.tryAgain"));
    }
  };

  return (
    <section className="mobile-page">
      <p className="mobile-section-kicker">{t("nav.vault")}</p>
      <p className="muted">{t("mobile.vault.noCreate")}</p>

      {phase === "error" ? (
        <>
          <LoadMessage failed />
          <button
            type="button"
            className="mobile-link-btn"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            {t("common.tryAgain")}
          </button>
        </>
      ) : null}

      {phase === "unset" ? (
        <EmptyState>{t("mobile.vault.notSetUp")}</EmptyState>
      ) : null}

      {phase === "locked" ? (
        <>
          <p className="muted">{t("mobile.vault.lockedHint")}</p>
          {items.length === 0 ? (
            <EmptyState>{t("mobile.vault.empty")}</EmptyState>
          ) : (
            <ul className="mobile-list" aria-label={t("mobile.vault.listAria")}>
              {items.map((item) => (
                <li key={item.id} className="mobile-card">
                  <span className="mobile-card-title">{item.title}</span>
                  <span className="mobile-card-meta">{item.updated_at}</span>
                </li>
              ))}
            </ul>
          )}
          <form
            className="mobile-form"
            onSubmit={(event) => {
              event.preventDefault();
              void unlock();
            }}
          >
            <label className="mobile-field">
              <span>{t("vault.password")}</span>
              <input
                className="input"
                type="password"
                value={unlockPwd}
                autoComplete="current-password"
                onChange={(event) => setUnlockPwd(event.currentTarget.value)}
              />
            </label>
            {error !== null ? (
              <p className="mobile-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="mobile-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || unlockPwd === ""}
              >
                {busy ? t("vault.unlocking") : t("vault.unlock")}
              </button>
            </div>
          </form>
        </>
      ) : null}

      {phase === "open" ? (
        <>
          {items.length === 0 ? (
            <EmptyState>{t("mobile.vault.empty")}</EmptyState>
          ) : (
            <p className="muted">{t("mobile.vault.revealHint")}</p>
          )}
          <ul className="mobile-list" aria-label={t("mobile.vault.listAria")}>
            {items.map((item) => {
              const open = revealedId === item.id;
              return (
                <li key={item.id} className="mobile-card">
                  <button
                    type="button"
                    className="mobile-card-btn"
                    aria-expanded={open}
                    onClick={() => void toggleReveal(item.id)}
                  >
                    <span className="mobile-card-title">{item.title}</span>
                    <span className="mobile-card-meta">
                      {open ? t("vault.hide") : t("vault.reveal")}
                    </span>
                  </button>
                  {open && revealedValue !== null ? (
                    <>
                      <p className="mobile-secret">{revealedValue}</p>
                      <div className="mobile-actions">
                        <button
                          type="button"
                          className="btn"
                          onClick={() => void copy(revealedValue)}
                        >
                          {t("mobile.vault.copy")}
                        </button>
                      </div>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="muted">
            {t("mobile.vault.copyDisclosure", {
              seconds: String(VAULT_CLIPBOARD_SECONDS),
            })}
          </p>
          {copyNotice !== null ? (
            <p className="mobile-saved" role="status">
              {copyNotice}
            </p>
          ) : null}
          {error !== null ? (
            <p className="mobile-error" role="alert">
              {error}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

// -- Budget: wallets + append-only entries -----------------------------------

/**
 * The Budget tab: every wallet with its recorded balance, and the entries of
 * the wallet that was tapped.
 *
 * Append-only (decision 4): the screen offers the two create forms and nothing
 * else. There is no edit or delete control anywhere on the mobile surface, and
 * the repo methods behind it (`createIncomeEntry` / `createExpenseEntry`) only
 * INSERT.
 */
export function BudgetScreen({
  onCompose,
}: {
  onCompose: (id: "income" | "expense") => void;
}) {
  const t = useT();
  const locale = useLocale();
  const load = useCallback(async () => {
    const [wallets, balances, incomeCategories, expenseCategories] =
      await Promise.all([
        budgetRepo.listWallets(),
        budgetRepo.listWalletBalances(),
        budgetRepo.listIncomeCategories(),
        budgetRepo.listExpenseCategories(),
      ]);
    return { wallets, balances, incomeCategories, expenseCategories };
  }, []);
  const { data, failed, reload } = useLoad(load);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [entries, setEntries] = useState<WalletEntryRow[]>([]);

  const wallets = data?.wallets ?? [];
  const balanceById = new Map(
    (data?.balances ?? []).map((wallet) => [wallet.id, wallet.balanceCents]),
  );
  // Income and expense categories are separate id spaces (the schema keeps
  // them in separate tables), so they need separate maps: merged by id, an
  // income entry could be labelled with an unrelated expense category.
  const incomeNames = new Map(
    (data?.incomeCategories ?? []).map((row) => [row.id, row.name]),
  );
  const expenseNames = new Map(
    (data?.expenseCategories ?? []).map((row) => [row.id, row.name]),
  );
  const selected = wallets.find((wallet) => wallet.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId === null) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    budgetRepo
      .listWalletEntries(selectedId)
      .then((rows) => {
        if (!cancelled) setEntries(rows);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  return (
    <section className="mobile-page">
      <p className="mobile-section-kicker">{t("nav.budget")}</p>
      <div className="mobile-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onCompose("income")}
        >
          {t("mobile.fab.income")}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => onCompose("expense")}
        >
          {t("mobile.fab.expense")}
        </button>
      </div>
      <p className="muted">{t("mobile.budget.appendOnly")}</p>
      <LoadMessage failed={failed} />
      {data !== null && wallets.length === 0 ? (
        <EmptyState>{t("mobile.budget.noWallets")}</EmptyState>
      ) : null}
      <ul className="mobile-list" aria-label={t("mobile.budget.walletsAria")}>
        {wallets.map((wallet) => {
          const isOpen = selected?.id === wallet.id;
          return (
            <li key={wallet.id}>
              <button
                type="button"
                className={
                  isOpen
                    ? "mobile-card mobile-card-btn is-open"
                    : "mobile-card mobile-card-btn"
                }
                aria-expanded={isOpen}
                onClick={() => setSelectedId(isOpen ? null : wallet.id)}
              >
                <span className="mobile-wallet-line">
                  <span className="mobile-card-title">{wallet.name}</span>
                  <span className="mobile-card-title">
                    {formatMMK(balanceById.get(wallet.id) ?? 0, locale)}
                  </span>
                </span>
                <span className="mobile-card-meta">
                  {isOpen
                    ? t("mobile.budget.hideEntries")
                    : t("mobile.budget.showEntries")}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {selected !== null ? (
        <div className="mobile-quick">
          <p className="mobile-section-kicker">
            {t("mobile.budget.entriesHeading")}
          </p>
          {entries.length === 0 ? (
            <p className="muted">{t("mobile.budget.noEntries")}</p>
          ) : (
            <ul
              className="mobile-list"
              aria-label={t("mobile.budget.entriesAria")}
            >
              {entries.map((entry) => (
                <li key={`${entry.kind}-${entry.id}`} className="mobile-card">
                  <span className="mobile-wallet-line">
                    <span className="mobile-row-text">
                      <span>
                        {entry.kind === "income"
                          ? t("mobile.entry.kindIncome")
                          : t("mobile.entry.kindExpense")}
                        {" · "}
                        {(entry.kind === "income"
                          ? incomeNames
                          : expenseNames
                        ).get(entry.category_id) ?? ""}
                      </span>
                      {entry.note.trim() !== "" ? (
                        <span className="mobile-row-meta">{entry.note}</span>
                      ) : null}
                    </span>
                    <span className="mobile-card-title">
                      {formatMMK(entry.amount_cents, locale)}
                    </span>
                  </span>
                  <span className="mobile-card-meta">{entry.entry_date}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      <button
        type="button"
        className="mobile-link-btn"
        onClick={reload}
        hidden={!failed}
      >
        {t("common.tryAgain")}
      </button>
    </section>
  );
}

/**
 * The create form for one ledger side, opened from the FAB or the Budget tab.
 *
 * The wallet and category lists come from the database. When either is empty
 * the form says where to create one (the desktop) and refuses to save — it
 * never invents a wallet, a category or a balance.
 */
export function EntryCompose({
  kind,
  onDone,
}: {
  kind: "income" | "expense";
  onDone: () => void;
}) {
  const t = useT();
  const load = useCallback(async () => {
    const [wallets, incomeCategories, expenseCategories] = await Promise.all([
      budgetRepo.listWallets(),
      budgetRepo.listIncomeCategories(),
      budgetRepo.listExpenseCategories(),
    ]);
    return { wallets, incomeCategories, expenseCategories };
  }, []);
  const { data, failed } = useLoad(load);
  const [amount, setAmount] = useState("");
  const [walletId, setWalletId] = useState<number | null>(null);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [entryDate, setEntryDate] = useState(() => todayLocal());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const wallets = data?.wallets ?? [];
  const categories =
    (kind === "income" ? data?.incomeCategories : data?.expenseCategories) ??
    [];
  const targetWallet = walletId ?? wallets[0]?.id ?? null;
  const targetCategory = categoryId ?? categories[0]?.id ?? null;
  const amountCents = parseMMK(amount);
  const ready = entryFormReady({
    amountCents,
    walletId: targetWallet,
    categoryId: targetCategory,
  });
  const amountProblem =
    amount.trim() !== "" && (amountCents === null || amountCents <= 0);

  const save = async () => {
    if (!ready || busy || targetWallet === null || targetCategory === null) {
      return;
    }
    setBusy(true);
    setSaveFailed(false);
    try {
      const input = {
        amountCents: amountCents ?? 0,
        categoryId: targetCategory,
        walletId: targetWallet,
        entryDate: entryDate === "" ? todayLocal() : entryDate,
        note: note.trim(),
      };
      if (kind === "income") await budgetRepo.createIncomeEntry(input);
      else await budgetRepo.createExpenseEntry(input);
      onDone();
    } catch {
      setSaveFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mobile-page">
      <p className="muted">{t("mobile.budget.appendOnly")}</p>
      <LoadMessage failed={failed} />
      {data !== null && wallets.length === 0 ? (
        <EmptyState>{t("mobile.entry.noWalletGuide")}</EmptyState>
      ) : null}
      {data !== null && wallets.length > 0 && categories.length === 0 ? (
        <EmptyState>
          {t("mobile.entry.noCategoryGuide", {
            kind:
              kind === "income"
                ? t("mobile.entry.kindIncome")
                : t("mobile.entry.kindExpense"),
          })}
        </EmptyState>
      ) : null}
      <form
        className="mobile-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="mobile-field">
          <span>{t("mobile.entry.amountLabel")}</span>
          <input
            className="input"
            type="text"
            inputMode="decimal"
            value={amount}
            placeholder={t("mobile.entry.amountPlaceholder")}
            aria-invalid={amountProblem}
            onChange={(event) => setAmount(event.currentTarget.value)}
          />
        </label>
        {amountProblem ? (
          <p className="mobile-error" role="alert">
            {t("mobile.entry.invalidAmount")}
          </p>
        ) : null}
        {wallets.length > 0 && categories.length > 0 ? (
          <>
            <label className="mobile-field">
              <span>{t("mobile.entry.walletLabel")}</span>
              <select
                className="input"
                value={String(targetWallet ?? "")}
                onChange={(event) =>
                  setWalletId(Number(event.currentTarget.value))
                }
              >
                {wallets.map((wallet) => (
                  <option key={wallet.id} value={wallet.id}>
                    {wallet.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="mobile-field">
              <span>{t("mobile.entry.categoryLabel")}</span>
              <select
                className="input"
                value={String(targetCategory ?? "")}
                onChange={(event) =>
                  setCategoryId(Number(event.currentTarget.value))
                }
              >
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}
        <label className="mobile-field">
          <span>{t("mobile.entry.dateLabel")}</span>
          <input
            className="input"
            type="date"
            value={entryDate}
            onChange={(event) => setEntryDate(event.currentTarget.value)}
          />
        </label>
        <label className="mobile-field">
          <span>{t("mobile.entry.noteLabel")}</span>
          <input
            className="input"
            type="text"
            value={note}
            placeholder={t("mobile.entry.notePlaceholder")}
            onChange={(event) => setNote(event.currentTarget.value)}
          />
        </label>
        <LoadMessage failed={saveFailed} />
        <div className="mobile-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !ready}
          >
            {busy
              ? t("notes.saving")
              : kind === "income"
                ? t("mobile.entry.saveIncome")
                : t("mobile.entry.saveExpense")}
          </button>
        </div>
      </form>
    </section>
  );
}

// -- Dashboard: money, due tasks, pinned notes, habit check-ins ----------------

export function DashboardScreen({
  onOpenNote,
}: {
  onOpenNote: (id: number) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const load = useCallback(async () => {
    const today = todayLocal();
    const [balances, tasks, notes, habits] = await Promise.all([
      budgetRepo.listWalletBalances(),
      tasksRepo.dueTasks(today),
      notesRepo.listNotes({ limit: 100 }),
      habitsRepo.habitProgressList(today),
    ]);
    return { today, balances, tasks, notes, habits };
  }, []);
  const { data, failed, reload } = useLoad(load);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [writeFailed, setWriteFailed] = useState(false);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);

  const completeTask = async (task: TaskRow) => {
    setBusyKey(`task:${task.id}`);
    setWriteFailed(false);
    try {
      await tasksRepo.completeTask(task.id);
      reload();
    } catch {
      setWriteFailed(true);
    } finally {
      setBusyKey(null);
    }
  };

  const toggleHabit = async (habitId: number, date: string) => {
    setBusyKey(`habit:${habitId}`);
    setWriteFailed(false);
    try {
      await habitsRepo.toggleLog(habitId, date);
      reload();
    } catch {
      setWriteFailed(true);
    } finally {
      setBusyKey(null);
    }
  };

  const today = data?.today ?? todayLocal();
  const balances = data?.balances ?? [];
  const tasks = data === null ? [] : urgentTasks(data.tasks, data.today);
  const pinned = data === null ? [] : pinnedNotes(data.notes);
  const habits = data?.habits ?? [];

  const capture = async () => {
    const body = text.trim();
    if (body === "") return;
    try {
      await notesRepo.createNote({ title: "", content: body });
      setText("");
      setSaved(true);
      reload();
    } catch {
      setSaved(false);
    }
  };

  return (
    <section className="mobile-page">
      <p className="mobile-section-kicker">{t("nav.dashboard")}</p>
      <LoadMessage failed={failed || writeFailed} />

      <div className="mobile-quick">
        <p className="mobile-section-kicker">
          {t("mobile.dashboard.recordedBalance")}
        </p>
        {data !== null && balances.length === 0 ? (
          <EmptyState>{t("mobile.dashboard.noWallets")}</EmptyState>
        ) : (
          <>
            <p className="mobile-balance">
              {formatMMK(recordedBalanceCents(balances), locale)}
            </p>
            <ul
              className="mobile-list"
              aria-label={t("mobile.dashboard.walletsAria")}
            >
              {balances.map((wallet) => (
                <li key={wallet.id} className="mobile-wallet-line">
                  <span className="mobile-row-text">{wallet.name}</span>
                  <span className="mobile-row-meta">
                    {formatMMK(wallet.balanceCents, locale)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="mobile-quick">
        <p className="mobile-section-kicker">
          {t("mobile.dashboard.tasksHeading")}
        </p>
        {data !== null && tasks.length === 0 ? (
          <EmptyState>{t("mobile.dashboard.noTasks")}</EmptyState>
        ) : null}
        <ul
          className="mobile-list"
          aria-label={t("mobile.dashboard.tasksAria")}
        >
          {tasks.map((task) => (
            <li key={task.id}>
              <label className="mobile-row">
                <input
                  type="checkbox"
                  checked={false}
                  disabled={busyKey === `task:${task.id}`}
                  aria-label={t("mobile.markDoneOf", { title: task.title })}
                  onChange={() => void completeTask(task)}
                />
                <span className="mobile-row-text">
                  {task.title}
                  {task.due_date !== null ? (
                    <span className="mobile-row-meta">
                      {task.due_date < today
                        ? t("tasks.overdue")
                        : t("tasks.due", { date: task.due_date })}
                    </span>
                  ) : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      <div className="mobile-quick">
        <p className="mobile-section-kicker">
          {t("mobile.dashboard.pinnedHeading")}
        </p>
        {data !== null && pinned.length === 0 ? (
          <EmptyState>{t("mobile.dashboard.noPinned")}</EmptyState>
        ) : null}
        <ul
          className="mobile-list"
          aria-label={t("mobile.dashboard.pinnedAria")}
        >
          {pinned.map((note) => (
            <li key={note.id}>
              <button
                type="button"
                className="mobile-card mobile-card-btn"
                onClick={() => onOpenNote(note.id)}
              >
                <span className="mobile-card-title">
                  {note.title.trim() === "" ? t("notes.untitled") : note.title}
                </span>
                {note.content.trim() !== "" ? (
                  <span className="mobile-card-body">{note.content}</span>
                ) : null}
                <span className="mobile-card-meta">
                  {t("mobile.dashboard.openNote")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="mobile-quick">
        <p className="mobile-section-kicker">
          {t("mobile.dashboard.habitsHeading")}
        </p>
        {data !== null && habits.length === 0 ? (
          <EmptyState>{t("mobile.dashboard.noHabits")}</EmptyState>
        ) : null}
        <ul
          className="mobile-list"
          aria-label={t("mobile.dashboard.habitsAria")}
        >
          {habits.map((progress) => {
            const done = habitDoneToday(progress.week, today);
            return (
              <li key={progress.habit.id}>
                <label className={done ? "mobile-row is-done" : "mobile-row"}>
                  <input
                    type="checkbox"
                    checked={done}
                    disabled={busyKey === `habit:${progress.habit.id}`}
                    aria-label={
                      done
                        ? t("mobile.markNotDoneOf", {
                            title: progress.habit.name,
                          })
                        : t("mobile.markDoneOf", { title: progress.habit.name })
                    }
                    onChange={() => void toggleHabit(progress.habit.id, today)}
                  />
                  <span className="mobile-row-text">{progress.habit.name}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="mobile-quick">
        <label className="mobile-quick-label" htmlFor="mobile-quick-capture">
          {t("mobile.quickCapture")}
        </label>
        <input
          id="mobile-quick-capture"
          className="input"
          type="text"
          value={text}
          placeholder={t("mobile.quickCapturePlaceholder")}
          onChange={(event) => {
            setText(event.currentTarget.value);
            setSaved(false);
          }}
          onFocus={(event) => {
            const field = event.currentTarget;
            requestAnimationFrame(() =>
              field.scrollIntoView({ block: "center" }),
            );
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void capture();
            }
          }}
        />
        <p className="muted">{t("mobile.quickCaptureHint")}</p>
        <div className="mobile-actions">
          <button
            type="button"
            className="btn"
            disabled={text.trim() === ""}
            onClick={() => void capture()}
          >
            {t("notes.save")}
          </button>
        </div>
        {saved ? (
          <p className="mobile-saved" role="status">
            {t("mobile.noteSaved")}
          </p>
        ) : null}
      </div>
      <MobileSearch />
    </section>
  );
}

/**
 * A note opened from the Dashboard preview. Its own screen (a route, not a
 * dialog) so the Android back gesture closes it instead of leaving the app.
 */
export function NoteReaderScreen({ noteId }: { noteId: number }) {
  const t = useT();
  const load = useCallback(() => notesRepo.getNote(noteId), [noteId]);
  const { data, failed, reload } = useLoad(load);

  return (
    <section className="mobile-page">
      <LoadMessage failed={failed} />
      <button
        type="button"
        className="mobile-link-btn"
        onClick={reload}
        hidden={!failed}
      >
        {t("common.tryAgain")}
      </button>
      {data === null ? null : data === undefined ? (
        <EmptyState>{t("mobile.noteReader.notFound")}</EmptyState>
      ) : (
        <article className="mobile-reader">
          <h2 className="mobile-reader-title">
            {data.title.trim() === "" ? t("notes.untitled") : data.title}
          </h2>
          <p className="mobile-card-meta">{data.updated_at}</p>
          {data.content.trim() === "" ? (
            <EmptyState>{t("mobile.noteReader.empty")}</EmptyState>
          ) : (
            <div className="mobile-reader-body">
              {/* One heading-id scope per note, so each note's own
                  `#introduction` anchors resolve (audit A4). */}
              <MarkdownDocument documentKey={`note:${noteId}`}>
                <ReactMarkdown
                  components={markdownComponents}
                  urlTransform={markdownUrlTransform}
                >
                  {data.content}
                </ReactMarkdown>
              </MarkdownDocument>
            </div>
          )}
        </article>
      )}
    </section>
  );
}

/** Search scoped to the two entities the phone may see. */
export function MobileSearch() {
  const t = useT();
  const [term, setTerm] = useState("");
  const [groups, setGroups] = useState<SearchGroup[]>([]);

  useEffect(() => {
    const input = term.trim();
    if (input === "") {
      setGroups([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchMobileWorkspace(input)
        .then((found) => {
          if (!cancelled) setGroups(found);
        })
        .catch(() => {
          if (!cancelled) setGroups([]);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term]);

  const results = groups.flatMap((group) => group.results);

  return (
    <div className="mobile-quick">
      <label className="mobile-quick-label" htmlFor="mobile-search">
        {t("mobile.searchLabel")}
      </label>
      <input
        id="mobile-search"
        className="input"
        type="search"
        value={term}
        placeholder={t("mobile.searchPlaceholder")}
        onChange={(event) => setTerm(event.currentTarget.value)}
      />
      {term.trim() === "" ? (
        <p className="muted">{t("mobile.searchHint")}</p>
      ) : results.length === 0 ? (
        <p className="muted">{t("mobile.searchNoResults")}</p>
      ) : (
        <ul className="mobile-list" aria-label={t("mobile.searchResultsAria")}>
          {results.map((result) => (
            <li key={`${result.type}-${result.id}`} className="mobile-card">
              <p className="mobile-card-title">{result.title}</p>
              {result.excerpt !== null ? (
                <p className="mobile-card-body">{result.excerpt}</p>
              ) : null}
              <p className="mobile-card-meta">
                {t(
                  result.type === "task"
                    ? "search.type.task"
                    : "search.type.note",
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
