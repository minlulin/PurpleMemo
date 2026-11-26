// The phone's Settings screen: the pairing card, the reminder and
// diagnostics facts, and the danger zone's two-step factory reset (F-1).
// This is the one driver call among the phone's screens —
// `src/reset-gate.test.ts` pins it as one of exactly two call sites.

import { invoke } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import { useEffect, useRef, useState } from "react";
import { readMobileDiagnostics, settingsRepo } from "../../data/app.ts";
import { factoryReset } from "../../data/driver.ts";
import {
  type BiometricStatus,
  biometricStatus,
} from "../../lib/android-biometric.ts";
import { isAndroidPlatform } from "../../lib/android-reminders.ts";
import { classifyPin, type PinState } from "../../lib/appLock.ts";
import {
  BIOMETRIC_TOGGLE_REASON,
  biometricToggleBlock,
} from "../../lib/biometricUnlock.ts";
import { verifyPin } from "../../lib/crypto.ts";
import { errText } from "../../lib/errors.ts";
import { formatBytes } from "../../lib/mobileSettings.ts";
import {
  type ResetAttempt,
  resetAttemptFromError,
  resetAttemptFromOutcome,
  resetPinAccepted,
} from "../../lib/reset.ts";
import { SETTING_KEYS, type Theme } from "../../lib/settings.ts";
import { Dialog } from "../Dialog.tsx";
import { MobilePairingCard } from "../MobilePairingCard.tsx";
import { useT } from "../useTranslation.ts";

// -- Settings ----------------------------------------------------------------

type ExactState = "exact" | "inexact" | "unknown";

/**
 * The reset act's step: no dialog open, the consequence disclosure (with the
 * PIN gate), or the second, explicit "Erase everything" confirmation.
 */
type ResetStage = "idle" | "confirm" | "erase";

interface SettingsFacts {
  /** The bundle version this APK carries — the phone has no About screen. */
  appVersion: string | null;
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
  appVersion: null,
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
  const [theme, setThemeState] = useState<Theme>("dark");
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

  /**
   * Biometric unlock: the phone's answer, the stored choice, and the PIN
   * confirmation D3 requires before the choice can be switched on.
   *
   * `biometric === null` is "not read yet": the row renders nothing rather
   * than a toggle with an assumed reason.
   */
  const [biometric, setBiometric] = useState<BiometricStatus | null>(null);
  const [biometricOn, setBiometricOn] = useState(false);
  const [bioConfirm, setBioConfirm] = useState(false);
  const [bioPin, setBioPin] = useState("");
  const [bioPinWrong, setBioPinWrong] = useState(false);
  const [bioBusy, setBioBusy] = useState(false);
  /** Synchronous half of the double-submit rule: PIN verification costs a
   *  600k-iteration derivation, so a second tap must be refused before React
   *  has re-rendered. */
  const bioBusyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setDiagnosticsFailed(false);
    // One fact per promise: a permission or diagnostic that cannot be read
    // must not blank the ones that can.
    void (async () => {
      const [
        appVersion,
        diagnostics,
        backing,
        exact,
        permission,
        rawPin,
        storedTheme,
        bioStatus,
        bioEnabled,
      ] = await Promise.all([
        // Dynamic, like the desktop's About line: no Tauri API in a browser build.
        import("@tauri-apps/api/app")
          .then(({ getVersion }) => getVersion())
          .catch(() => null),
        readMobileDiagnostics().catch(() => null),
        invoke<string>("keystore_backing").catch(() => null),
        invoke<string>("reminder_exact_state").catch(() => null),
        isPermissionGranted().catch(() => null),
        settingsRepo.getRaw(SETTING_KEYS.pinHash).then(
          (value) => value,
          () => null,
        ),
        settingsRepo.getTheme().catch(() => null),
        // The phone's own answer, and this device's stored choice. A failed
        // read of either is not an error state: the toggle simply stays off,
        // which is the safe direction.
        biometricStatus().catch(() => null),
        settingsRepo.getBiometricUnlock().catch(() => false),
      ]);
      if (cancelled) return;
      setThemeState(storedTheme ?? "dark");
      setBiometric(bioStatus);
      setBiometricOn(bioEnabled);
      setDiagnosticsFailed(diagnostics === null);
      setFacts({
        appVersion,
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

  /**
   * F-4: the phone's theme control. The theme itself is device-local
   * (§2.2 — settings never sync), stored by the same settings repo the
   * desktop uses, and App's boot already applies it to both shells; the
   * phone simply had no control that could change it, so it sat on the
   * dark default forever. Presentation first (the desktop language
   * switch's rule): repaint at once, persist after; a failed persist
   * restores the previous theme rather than leaving the screen
   * claiming a choice that would not survive a restart.
   */
  const applyTheme = async (next: Theme) => {
    if (next === theme) return;
    const previous = theme;
    setThemeState(next);
    document.documentElement.dataset.theme = next;
    try {
      await settingsRepo.setTheme(next);
    } catch {
      setThemeState(previous);
      document.documentElement.dataset.theme = previous;
    }
  };

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

  /**
   * The Settings toggle's two sides (D3).
   *
   * Turning OFF is immediate and free: the shortcut is coming off, and asking
   * for proof to disable something is how a lockout becomes permanent. Turning
   * ON verifies the current PIN first — it stands beside the PIN lock, so
   * whoever is merely holding an unlocked phone must not be able to arm it.
   * A wrong PIN changes nothing and says so.
   */
  const changeBiometric = async (next: boolean) => {
    if (bioBusyRef.current) return;
    if (!next) {
      bioBusyRef.current = true;
      setBioBusy(true);
      try {
        await settingsRepo.setBiometricUnlock(false);
        setBiometricOn(false);
        setBioConfirm(false);
        setBioPin("");
        setBioPinWrong(false);
      } catch {
        // A failed write leaves the toggle where it was: the row is the truth.
      } finally {
        bioBusyRef.current = false;
        setBioBusy(false);
      }
      return;
    }
    const pin = facts.pin;
    if (pin === null || pin.kind !== "stored") return;
    bioBusyRef.current = true;
    setBioBusy(true);
    setBioPinWrong(false);
    try {
      if (!(await verifyPin(bioPin, pin.hash))) {
        setBioPinWrong(true);
        return;
      }
      await settingsRepo.setBiometricUnlock(true);
      setBiometricOn(true);
      setBioConfirm(false);
      setBioPin("");
    } catch {
      // Same rule as turning off: nothing changes unless the row was written.
    } finally {
      bioBusyRef.current = false;
      setBioBusy(false);
    }
  };

  const pinSet = facts.pin?.kind === "stored";
  const biometricBlock =
    biometric === null
      ? null
      : biometricToggleBlock({ pinSet, status: biometric });

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
        {t("mobile.settings.appearanceHeading")}
      </p>
      <div className="mobile-card">
        <fieldset className="theme-segmented">
          <legend className="visually-hidden">
            {t("mobile.settings.appearanceHeading")}
          </legend>
          <button
            type="button"
            className={theme === "dark" ? "btn is-on" : "btn"}
            aria-pressed={theme === "dark"}
            onClick={() => void applyTheme("dark")}
          >
            {t("mobile.settings.themeDark")}
          </button>
          <button
            type="button"
            className={theme === "light" ? "btn is-on" : "btn"}
            aria-pressed={theme === "light"}
            onClick={() => void applyTheme("light")}
          >
            {t("mobile.settings.themeLight")}
          </button>
        </fieldset>
      </div>

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
      {/* The phone's Settings is the Android shell (App.tsx picks MobileShell
          on the same platform signal), so desktop never renders this block. */}
      {isAndroidPlatform() && biometric !== null ? (
        <div className="mobile-card">
          <p className="mobile-fact-term">{t("settings.biometric.label")}</p>
          <p className="mobile-row-text">
            {t("settings.biometric.description")}
          </p>
          {biometricBlock !== null ? (
            <>
              <p className="mobile-row-text">
                {t(BIOMETRIC_TOGGLE_REASON[biometricBlock])}
              </p>
              <button
                type="button"
                className="btn"
                disabled
                aria-pressed={false}
              >
                {t("settings.biometric.label")}
              </button>
            </>
          ) : bioConfirm && !biometricOn ? (
            <>
              <label>
                {t("settings.biometric.pinPrompt")}
                <input
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  value={bioPin}
                  disabled={bioBusy}
                  onChange={(event) => {
                    setBioPin(event.target.value);
                    setBioPinWrong(false);
                  }}
                />
              </label>
              {bioPinWrong ? (
                <p className="mobile-error" role="alert">
                  {t("settings.biometric.wrongPin")}
                </p>
              ) : null}
              <div className="row-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={bioBusy}
                  onClick={() => {
                    setBioConfirm(false);
                    setBioPin("");
                    setBioPinWrong(false);
                  }}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={bioBusy || bioPin === ""}
                  onClick={() => void changeBiometric(true)}
                >
                  {bioBusy
                    ? t("common.checking")
                    : t("settings.biometric.turnOn")}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="mobile-row-text">
                {biometricOn
                  ? t("settings.biometric.on")
                  : t("settings.biometric.off")}
              </p>
              <button
                type="button"
                className={biometricOn ? "btn is-on" : "btn"}
                aria-pressed={biometricOn}
                disabled={bioBusy}
                onClick={() => {
                  if (biometricOn) {
                    void changeBiometric(false);
                    return;
                  }
                  setBioPin("");
                  setBioPinWrong(false);
                  setBioConfirm(true);
                }}
              >
                {biometricOn
                  ? t("settings.biometric.turnOff")
                  : t("settings.biometric.turnOn")}
              </button>
            </>
          )}
        </div>
      ) : null}

      <p className="mobile-section-kicker">
        {t("mobile.settings.diagnosticsHeading")}
      </p>
      {diagnosticsFailed ? (
        <p className="mobile-error" role="alert">
          {t("mobile.settings.diagnosticsFailed")}
        </p>
      ) : null}
      <dl className="mobile-facts">
        <dt>{t("mobile.settings.appVersion")}</dt>
        <dd>{facts.appVersion ?? t("mobile.settings.unknown")}</dd>
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
