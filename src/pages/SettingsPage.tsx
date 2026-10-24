// Settings page: theme, PIN + security question change, auto-lock
// window, vault entry point, encryption key export, backup & restore, about.
// No accounts, no sync, no cloud settings — they never exist
// The PIN change verifies the current PIN first and re-hashes with
// PBKDF2-SHA256 (600k); the PIN itself is never stored.
// Backup exports/imports a zip of all data + photos — the encryption
// key is never inside it; a password optionally seals that zip in its own
// container (.pmbk); import replaces ALL current data, so the UI confirms
// before applying and reloads afterwards.

import { save } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import {
  IconArrowRight,
  IconDownload,
  IconFilter,
  IconMoon,
  IconSettings,
  IconSpinner,
  IconSun,
  IconUpload,
} from "../components/icons.tsx";
import { useToast } from "../components/Toast.tsx";
import { useLocale, useT } from "../components/useTranslation.ts";
import { backupRepo, settingsRepo, shareRepo } from "../data/app.ts";
import { factoryReset, type ShareInfo } from "../data/driver.ts";
import {
  AUTO_LOCK_CHOICES,
  classifyPin,
  MIN_PIN_LENGTH,
  securityReloadNeeded,
  UNREADABLE_PIN_REASON,
} from "../lib/appLock.ts";
import {
  MAX_BACKUP_ARCHIVE_BYTES,
  MAX_ENCRYPTED_BACKUP_BYTES,
} from "../lib/backup.ts";
import {
  ENCRYPTED_BACKUP_EXTENSION,
  ENCRYPTED_BACKUP_MIME,
  isEncryptedBackup,
} from "../lib/backupContainer.ts";
import { hashAnswer, hashPin, verifyPin } from "../lib/crypto.ts";
import { localISODateTime, todayLocal } from "../lib/dates.ts";
import { errText } from "../lib/errors.ts";
import { formatDateTime } from "../lib/format.ts";
import {
  isLocale,
  LOCALE_LABELS,
  LOCALES,
  type Locale,
  setLocale,
} from "../lib/i18n.ts";
import type { PageKey } from "../lib/navigation.ts";
import {
  type ResetAttempt,
  resetAttemptFromError,
  resetAttemptFromOutcome,
} from "../lib/reset.ts";
import { SETTING_KEYS, type Theme } from "../lib/settings.ts";
import {
  checkForUpdate,
  describeUpdate,
  installUpdate,
  notesExcerpt,
  type UpdateHandle,
} from "../lib/update.ts";

interface SettingsPageProps {
  theme: Theme;
  autoLockMinutes: number;
  /** Reload boot state (theme/auto-lock) after a settings write. */
  onChanged: () => void;
  /** Navigate to another section (the vault entry point). */
  onNavigate: (key: PageKey) => void;
  /**
   * Hand a finished factory-reset attempt (resolved outcome OR throw) to
   * the shell. The shell holds it in top-level state and
   * swaps the whole workspace for the terminal result screen — this page is
   * never seen again after the call, so it never re-enters its own UI.
   */
  onResetFinished: (attempt: ResetAttempt) => void;
}

/** Anchors for the sticky sub-nav; the ids live on the sections below. */
const SETTINGS_SECTIONS = [
  { id: "appearance", label: "Appearance" },
  { id: "lock", label: "App lock & PIN" },
  { id: "notifications", label: "Notifications" },
  { id: "vault", label: "Vault" },
  { id: "key-export", label: "Key export" },
  { id: "backup", label: "Backup" },
  { id: "share", label: "Share" },
  { id: "updates", label: "Updates" },
  { id: "about", label: "About" },
  { id: "danger", label: "Danger zone" },
] as const;

/**
 * Extra search terms per section (review P3-31).
 *
 * The filter matched only the eight nav titles, so the words people actually
 * type — "theme", "dark", "idle", "restore", "zip", "lan" — all returned
 * `No settings match`. A search box that cannot find the thing you can see on
 * screen reads as broken, and it is the one control on this page with no
 * affordance for discovering its vocabulary.
 *
 * Derived from each section's own copy rather than invented separately, so
 * these cannot drift from the text they are supposed to match.
 */
const SETTINGS_ALIASES: Record<string, string[]> = {
  appearance: [
    "theme",
    "dark",
    "light",
    "colour",
    "color",
    "palette",
    "language",
    "locale",
    "burmese",
    "myanmar",
    "english",
  ],
  lock: ["pin", "idle", "auto", "lock", "timeout", "security"],
  notifications: ["reminder", "notification", "preview", "toast", "alert"],
  vault: ["secret", "password", "encrypt", "aes"],
  "key-export": ["key", "backup key", "encryption", "master"],
  backup: ["restore", "import", "export", "zip", "archive", "recovery"],
  share: ["lan", "network", "phone", "pairing", "code", "link"],
  updates: ["update", "version", "release", "download", "upgrade"],
  about: ["version", "info", "offline", "open source"],
  danger: ["factory", "reset", "erase", "wipe", "delete everything"],
};

export default function SettingsPage(p: SettingsPageProps) {
  const t = useT();
  const locale = useLocale();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Confirmations are transient by nature — they were a dismiss-less banner
  // before; a toast says the same thing without parking on the page.
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [pin, setPin] = useState({
    current: "",
    next: "",
    confirm: "",
    question: "",
    answer: "",
  });
  /**
   * Whether OS notifications may carry reminder text.
   * Read on mount rather than passed through boot: this is a page concern,
   * and re-reading keeps the toggle truthful if an import replaced settings.
   */
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void settingsRepo
      .getNotificationPreview()
      .then((enabled) => {
        if (!cancelled) setPreview(enabled);
      })
      // A failed read leaves the toggle at the safe default (OFF).
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  /** Section filter — matches the nav labels, so search and nav agree. An id
   * missing from the table stays visible rather than vanishing. Aliases widen
   * the vocabulary to the words people type (review P3-31). */
  const needle = query.trim().toLowerCase();
  const shows = (id: string) => {
    if (needle === "") return true;
    const section = SETTINGS_SECTIONS.find((s) => s.id === id);
    if (!section) return true;
    const terms = [section.label, ...(SETTINGS_ALIASES[id] ?? [])].map((t) =>
      t.toLowerCase(),
    );
    return terms.some((t) => t.includes(needle));
  };

  const setTheme = async (theme: Theme) => {
    try {
      await settingsRepo.setTheme(theme);
      document.documentElement.dataset.theme = theme;
      p.onChanged();
    } catch (e) {
      setError(errText(e));
    }
  };

  /**
   * Presentation only: switch immediately so the UI is
   * readable in the chosen language, then persist. A failed write is reported
   * but does not silently snap the interface back.
   */
  const changeLocale = async (next: Locale) => {
    if (!isLocale(next)) return;
    setLocale(next);
    try {
      await settingsRepo.setLocale(next);
    } catch (e) {
      setError(errText(e));
    }
  };

  const setAutoLock = async (minutes: number) => {
    try {
      await settingsRepo.setAutoLockMinutes(minutes);
      p.onChanged();
    } catch (e) {
      setError(errText(e));
    }
  };

  const changePreview = async (enabled: boolean) => {
    try {
      await settingsRepo.setNotificationPreview(enabled);
      setPreview(enabled);
    } catch (e) {
      setError(errText(e));
    }
  };

  const changePin = async () => {
    setError(null);
    try {
      // Read the RAW value and classify it (review P3-18), rather than
      // `getJSON<PinHash>`. `getJSON` returns null both when no PIN was ever set
      // and when the stored row is unparseable, so this path could not tell
      // "no PIN yet" from "corrupt PIN" — and it never checked the stored
      // iteration count at all. Boot already fail-closes on a weak hash, so this
      // is unreachable today; it is fixed because it is a second trust root
      // reaching the same secret, and a trust root that validates nothing should
      // not be one. Same function, same rule, two callers.
      const state = classifyPin(
        await settingsRepo.getRaw(SETTING_KEYS.pinHash),
      );
      if (state.kind === "absent") {
        setError("No PIN is set yet — complete the first-run setup.");
        return;
      }
      if (state.kind === "unreadable") {
        setError(
          `The stored PIN is ${UNREADABLE_PIN_REASON[state.reason]} — nothing was changed.`,
        );
        return;
      }
      if (!(await verifyPin(pin.current, state.hash))) {
        setError("Current PIN is wrong.");
        return;
      }
      if (pin.next.length < MIN_PIN_LENGTH) {
        setError(`New PIN must be at least ${MIN_PIN_LENGTH} characters.`);
        return;
      }
      if (pin.next !== pin.confirm) {
        setError("New PINs do not match.");
        return;
      }
      // The question/answer change is optional — empty fields keep the old
      // ones (the fallback must never be silently wiped). Validate the pair
      // BEFORE any write so a half-filled change writes nothing at all.
      const question = pin.question.trim();
      const answer = pin.answer.trim();
      if (question.length > 0 !== answer.length > 0) {
        setError(
          "Provide BOTH a question and an answer to change the fallback — nothing was changed.",
        );
        return;
      }
      setBusy(true);
      const changes: { key: string; value: unknown }[] = [
        { key: SETTING_KEYS.pinHash, value: await hashPin(pin.next) },
      ];
      if (question.length > 0) {
        changes.push(
          { key: SETTING_KEYS.securityQuestion, value: question },
          {
            key: SETTING_KEYS.securityAnswerHash,
            value: await hashAnswer(answer),
          },
        );
      }
      await settingsRepo.setManyJSON(changes);
      setPin({ current: "", next: "", confirm: "", question: "", answer: "" });
      // Re-read the security state: the shell's `boot.pin` is what
      // the lock screen verifies against, and without this the next lock
      // rejected the PIN just set and accepted the previous one.
      if (securityReloadNeeded(changes.map((c) => c.key))) p.onChanged();
      toast.success("PIN updated.");
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const [keyBusy, setKeyBusy] = useState(false);
  const [keyAck, setKeyAck] = useState(false);

  /**
   * The pinned double-submit guard, shared by every
   * async action on this page — export, import, key export, share
   * start/stop, update check/install. One flag is enough because
   * `shows(section)` means only one section is mounted at a time, so two
   * guarded handlers can never be in flight together; the per-handler
   * busy states stay for the buttons, this ref is what refuses the second
   * click before React has re-rendered.
   */
  const savingRef = useRef(false);

  // -- Backup & restore ----------------------------------------------------
  const [backupBusy, setBackupBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  /**
   * The export password. It lives here only while a dialog or an export is in
   * flight and is cleared in `finally` — a password kept in component state
   * after the dialog closes would outlive the operation in a long-lived
   * renderer, which is exactly what delivery rule 9 forbids.
   */
  const [backupPassword, setBackupPassword] = useState("");
  const [backupPasswordConfirm, setBackupPasswordConfirm] = useState("");
  const [passwordBackup, setPasswordBackup] = useState(false);
  /**
   * A picked file waiting for its password, before it can be inspected. Held
   * as bytes, never as a promise to decrypt later, so the password is used
   * once and dropped.
   */
  const [lockedFile, setLockedFile] = useState<Uint8Array | null>(null);
  const [importPassword, setImportPassword] = useState("");
  const [pending, setPending] = useState<{
    /** The authenticated zip, ready for `importBackup`. */
    bytes: Uint8Array;
    summary: {
      exportedAt: string;
      tableCount: number;
      rowCount: number;
      photoCount: number;
    };
  } | null>(null);

  const doExport = async () => {
    if (savingRef.current) return;
    setError(null);
    setPending(null);
    if (passwordBackup && backupPassword !== backupPasswordConfirm) {
      setError(t("settings.passwordMismatch"));
      return;
    }
    if (passwordBackup && backupPassword === "") {
      setError(t("settings.passwordRequired"));
      return;
    }
    savingRef.current = true;
    setBackupBusy(true);
    try {
      // The dialog comes first: the extension the user
      // sees follows the password toggle, not the build's own result, and
      // the backup is only built once a destination exists — cancelling the
      // dialog now costs nothing.
      const path = await save({
        title: t("settings.saveBackupTitle"),
        defaultPath: `purple-memo-backup-${todayLocal()}.${passwordBackup ? ENCRYPTED_BACKUP_EXTENSION : "zip"}`,
        filters: [
          {
            name: passwordBackup
              ? t("settings.encryptedBackupFilter")
              : t("settings.backupFilter"),
            extensions: [passwordBackup ? ENCRYPTED_BACKUP_EXTENSION : "zip"],
          },
        ],
      });
      if (path === null) return;
      const { bytes, summary, encrypted } = await backupRepo.exportBackup(
        passwordBackup ? backupPassword : undefined,
      );
      await backupRepo.saveBackupFile(path, bytes);
      toast.success(
        t(
          encrypted ? "settings.backupSavedEncrypted" : "settings.backupSaved",
          {
            path,
            rows: summary.rowCount,
            photos: summary.photoCount,
          },
        ),
      );
    } catch (e) {
      setError(errText(e));
    } finally {
      savingRef.current = false;
      // The key was derived for this one operation and is dropped with it.
      setBackupPassword("");
      setBackupPasswordConfirm("");
      setBackupBusy(false);
    }
  };

  /** Inspect a picked archive and hold the result for the confirm step. */
  const inspectPicked = async (bytes: Uint8Array, password?: string) => {
    const { summary, inner } = await backupRepo.inspectBackup(bytes, password);
    setPending({ bytes: inner, summary });
    setLockedFile(null);
  };

  const onPickBackup = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setError(null);
    setPending(null);
    setLockedFile(null);
    setImportPassword("");
    // Refuse on the reported size BEFORE reading: the largest acceptable file
    // of either kind is the sealed cap, so nothing bigger is ever pulled into
    // the renderer just to be rejected.
    if (file.size > MAX_ENCRYPTED_BACKUP_BYTES) {
      setError(t("settings.tooLarge", { limit: MAX_ENCRYPTED_BACKUP_BYTES }));
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (isEncryptedBackup(bytes)) {
        // Already inside the sealed cap; ask for the password and stop.
        setLockedFile(bytes);
        return;
      }
      if (bytes.byteLength > MAX_BACKUP_ARCHIVE_BYTES) {
        throw new Error(
          t("settings.tooLarge", { limit: MAX_BACKUP_ARCHIVE_BYTES }),
        );
      }
      await inspectPicked(bytes);
    } catch (e) {
      setError(errText(e));
    } finally {
      setImportPassword("");
    }
  };

  const unlockPicked = async () => {
    if (!lockedFile) return;
    setImportBusy(true);
    setError(null);
    try {
      await inspectPicked(lockedFile, importPassword);
    } catch (e) {
      setError(errText(e));
    } finally {
      // Cleared either way: the password was used for this one attempt, and a
      // failed attempt leaves the file in place for another try.
      setImportPassword("");
      setImportBusy(false);
    }
  };

  const confirmImport = async () => {
    if (savingRef.current) return;
    if (!pending) return;
    savingRef.current = true;
    setImportBusy(true);
    setError(null);
    try {
      // Sharing must stop BEFORE the data is replaced: the listener would
      // otherwise keep serving the pre-import snapshot to the phone
      await shareRepo.stop();
      // And before anything is deleted, copy what is about to be gone.
      // This throws on failure, which leaves `pending` in place and the
      // data untouched — an import with no undo is the thing being removed
      // here, so a copy that could not be taken cancels the import.
      const safetyCopy = await backupRepo.saveSafetyCopy(
        localISODateTime(new Date()),
      );
      const result = await backupRepo.importBackup(pending.bytes);
      setPending(null);
      toast.success(
        t("settings.imported", {
          rows: result.rows,
          photos: result.photos,
          path: safetyCopy,
        }),
      );
      // The imported backup carries its own settings (theme, PIN, …), so
      // the app re-boots from the database instead of trusting live state.
      window.setTimeout(() => window.location.reload(), 900);
    } catch (e) {
      setError(errText(e));
      setImportBusy(false);
    } finally {
      savingRef.current = false;
    }
  };

  /**
   * Export the encryption key to a file the user picks.
   *
   * One step, and the key is never displayed, copied to the clipboard, or held
   * in component state: Rust reads it from the credential store, writes it and
   * drops it. The previous flow rendered the plaintext key into a `<textarea>`
   * and offered a clipboard copy — the clipboard survives the app being closed
   * and is readable by any other program, which is a strictly worse place for
   * the master key than the file the user chose.
   */
  const exportKey = async () => {
    if (savingRef.current) return;
    setError(null);
    if (!keyAck) {
      setError(
        "Tick the acknowledgement first — the key must go into its own file, never into a backup.",
      );
      return;
    }
    savingRef.current = true;
    setKeyBusy(true);
    try {
      const path = await save({
        title: "Save Purple Memo encryption key",
        defaultPath: "purple-memo-db-key.txt",
        filters: [{ name: "Text file", extensions: ["txt"] }],
      });
      if (path === null) return;
      await settingsRepo.saveDatabaseKeyFile(path);
      toast.success(
        `Encryption key saved to ${path}. Store it separately from backups.`,
      );
      // The disclosure is now on record; make the user restart from the gate so
      // the acknowledgement cannot be reused silently for a second export.
      setKeyAck(false);
    } catch (e) {
      setError(errText(e));
    } finally {
      savingRef.current = false;
      setKeyBusy(false);
    }
  };

  // -- Same-network read-only share (P5) ------------------------------------
  const [shareState, setShareState] = useState<ShareInfo | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [shareAck, setShareAck] = useState(false);

  // The app shell keeps re-publishing while sharing; this mirrors the state
  // here (including a server that stopped unexpectedly).
  useEffect(() => {
    let cancelled = false;
    const sync = async () => {
      try {
        const info = await shareRepo.status();
        if (!cancelled) setShareState(info);
      } catch {
        // Keep the last known state — the buttons report real errors.
      }
    };
    void sync();
    const timer = setInterval(() => void sync(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  /**
   * Turn the LAN share on.
   *
   * `shareRepo.start` arms and starts in one call, and Rust refuses to bind a
   * listener without the consent token that call obtains — so the gate is
   * enforced on the backend, not merely drawn on screen. What this function owns
   * is making sure the user actually reads what they are agreeing to before the
   * token is minted.
   */
  const startShare = async () => {
    if (savingRef.current) return;
    setError(null);
    setShareCopied(false);
    if (!shareAck) {
      setError(
        "Tick the acknowledgement first — anyone with the share link can decrypt the snapshot.",
      );
      return;
    }
    savingRef.current = true;
    setShareBusy(true);
    try {
      setShareState(await shareRepo.start());
      // Publish at once so the phone has data before the shell's next tick.
      setShareState(await shareRepo.publishSnapshot());
    } catch (e) {
      setError(errText(e));
    } finally {
      savingRef.current = false;
      setShareBusy(false);
    }
  };

  const stopShare = async () => {
    if (savingRef.current) return;
    setError(null);
    setShareCopied(false);
    savingRef.current = true;
    setShareBusy(true);
    try {
      setShareState(await shareRepo.stop());
    } catch (e) {
      setError(errText(e));
    } finally {
      savingRef.current = false;
      setShareBusy(false);
    }
  };

  const copyShareLink = async () => {
    const url = shareState?.url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setShareCopied(true);
    } catch {
      setError("Copy failed — select the link text and copy it manually.");
    }
  };

  // -- In-app updates ------------------------------------------------------
  const [update, setUpdate] = useState<UpdateHandle | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateChecked, setUpdateChecked] = useState(false);
  const [updatePercent, setUpdatePercent] = useState<number | null>(null);
  const [updateDone, setUpdateDone] = useState(false);

  // The About section shows the real bundle version, read through the Tauri
  // runtime — a hard-coded string goes stale with the
  // first release. Imported dynamically like the updater plugin, so the web
  // build never pulls the API in; the section renders without the version if
  // the runtime is absent (plain `npm run dev` in a browser).
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        const v = await getVersion();
        if (!cancelled) setAppVersion(v);
      } catch {
        // Cosmetic only — the About copy stands on its own.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const checkUpdates = async () => {
    if (savingRef.current) return;
    setError(null);
    setUpdateDone(false);
    setUpdatePercent(null);
    savingRef.current = true;
    setUpdateBusy(true);
    try {
      setUpdate(await checkForUpdate());
    } catch (e) {
      // No release published yet is the expected answer before the first
      // hand-made release — report it plainly instead of hiding it.
      setUpdate(null);
      setError(`Could not check for updates: ${errText(e)}`);
    } finally {
      savingRef.current = false;
      setUpdateChecked(true);
      setUpdateBusy(false);
    }
  };

  const installNow = async () => {
    if (savingRef.current) return;
    if (update === null) return;
    setError(null);
    savingRef.current = true;
    setUpdateBusy(true);
    setUpdateDone(false);
    try {
      await installUpdate(update, setUpdatePercent);
      setUpdateDone(true);
    } catch (e) {
      setError(`Update failed: ${errText(e)}`);
    } finally {
      savingRef.current = false;
      setUpdateBusy(false);
    }
  };

  // -- Factory reset ------------------------------------------
  const [resetAck, setResetAck] = useState(false);
  const [resetting, setResetting] = useState(false);
  /** The pinned double-submit guard (see the GUARDS table): a ref, raised
   *  before the first await, so a second engine run cannot race the first
   *  one's file deletions before React has re-rendered. */
  const resettingRef = useRef(false);

  // The acknowledgement is transient: it is a statement the user made about
  // THIS reset, not a preference, so it returns to unchecked whenever the
  // section unmounts and whenever an attempt finishes (the `finally` below)
  // — the engine is re-runnable and a retry must be re-acknowledged.
  useEffect(() => () => setResetAck(false), []);

  /**
   * The ONLY call site of `factoryReset()` in the app (pinned by
   * `src/reset-gate.test.ts`, because the policy gate is frontend-only by
   * design and the tests are what keep it true). Both halves of the gate are
   * enforced here as well as drawn on screen: the permanent-destruction
   * checkbox (`resetAck`) is checked before the engine is invoked, and the
   * action is only reachable through the two-step `ConfirmButton`.
   *
   * The attempt — resolved outcome OR throw — goes straight to the shell,
   * which replaces the workspace with the terminal result screen. This page
   * never restarts the app: on a complete outcome the result screen offers
   * Restart behind the complete-check; a blocked reset never restarts.
   */
  const runFactoryReset = async () => {
    if (resettingRef.current) return;
    if (!resetAck) return;
    resettingRef.current = true;
    setResetting(true);
    try {
      // The engine stops the share, closes the DB connection (after which
      // every DB command fails closed), deletes the files, and deletes the
      // keyring key last. Either way the session is over — the shell's
      // terminal screen takes it from here.
      p.onResetFinished(resetAttemptFromOutcome(await factoryReset()));
    } catch (e) {
      // An IPC failure is an incomplete attempt, never a success: no report
      // arrived, so nothing may be assumed about what was removed.
      p.onResetFinished(resetAttemptFromError(errText(e)));
    } finally {
      resettingRef.current = false;
      setResetting(false);
      setResetAck(false);
    }
  };

  return (
    <div className="budget-page">
      <header className="page-header">
        <div className="page-header-main">
          <div className="page-title-row">
            <span className="page-icon-badge">
              <IconSettings className="icon" />
            </span>
            <div>
              <h2 className="editor-title">Settings</h2>
              <p className="page-subtitle">
                Appearance, PIN security, database key export, local backups,
                LAN share &amp; updates
              </p>
            </div>
          </div>
        </div>
      </header>

      {error !== null && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}

      <span className="input-icon-wrap">
        <input
          className="input"
          type="search"
          placeholder="Filter settings…"
          aria-label="Filter settings"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <IconFilter className="icon input-icon" />
      </span>

      <nav className="settings-nav" aria-label="Settings sections">
        {SETTINGS_SECTIONS.filter((s) => shows(s.id)).map((s) => (
          <a
            key={s.id}
            className="settings-nav-link"
            href={`#settings-${s.id}`}
          >
            {s.label}
          </a>
        ))}
      </nav>

      {needle !== "" && SETTINGS_SECTIONS.every((s) => !shows(s.id)) && (
        <p className="empty-state">No settings match “{query.trim()}”.</p>
      )}

      <section
        className="settings-section"
        id="settings-appearance"
        hidden={!shows("appearance")}
      >
        <div className="dash-card-head">
          <h3 className="settings-heading">Appearance</h3>
          <span className="badge badge-accent">{p.theme}</span>
        </div>
        <p className="page-subtitle">
          Choose between the dark-first PurpleShade palette and its high-clarity
          light mode mirror.
        </p>
        <fieldset className="theme-segmented">
          <legend className="visually-hidden">Theme</legend>
          <button
            type="button"
            className={p.theme === "dark" ? "btn is-on" : "btn"}
            aria-pressed={p.theme === "dark"}
            onClick={() => void setTheme("dark")}
          >
            <IconMoon className="icon" /> Dark
          </button>
          <button
            type="button"
            className={p.theme === "light" ? "btn is-on" : "btn"}
            aria-pressed={p.theme === "light"}
            onClick={() => void setTheme("light")}
          >
            <IconSun className="icon" /> Light
          </button>
        </fieldset>
        <div className="side-form">
          <label>
            {t("settings.language")}
            <select
              className="select"
              value={locale}
              onChange={(e) => void changeLocale(e.target.value as Locale)}
            >
              {LOCALES.map((code) => (
                <option key={code} value={code}>
                  {LOCALE_LABELS[code]}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">{t("settings.languageHint")}</p>
        </div>
      </section>

      <section
        className="settings-section settings-section-expanded"
        id="settings-lock"
        hidden={!shows("lock")}
      >
        <div className="dash-card-head">
          <h3 className="settings-heading">App lock &amp; PIN</h3>
          <span className="badge">PBKDF2-SHA256</span>
        </div>
        <div className="side-form">
          <label>
            Lock after idle
            <select
              className="select"
              value={p.autoLockMinutes}
              onChange={(e) => void setAutoLock(Number(e.target.value))}
            >
              {AUTO_LOCK_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? "Never" : `${m} minutes`}
                </option>
              ))}
            </select>
          </label>
          <label>
            Current PIN
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={pin.current}
              onChange={(e) => setPin({ ...pin, current: e.target.value })}
            />
          </label>
          <div className="form-grid">
            <label>
              New PIN (at least {MIN_PIN_LENGTH} characters)
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={pin.next}
                onChange={(e) => setPin({ ...pin, next: e.target.value })}
              />
            </label>
            <label>
              Confirm new PIN
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={pin.confirm}
                onChange={(e) => setPin({ ...pin, confirm: e.target.value })}
              />
            </label>
          </div>
          <label>
            New security question (blank keeps the old one)
            <input
              className="input"
              value={pin.question}
              onChange={(e) => setPin({ ...pin, question: e.target.value })}
            />
          </label>
          <label>
            New answer
            <input
              className="input"
              value={pin.answer}
              onChange={(e) => setPin({ ...pin, answer: e.target.value })}
            />
          </label>
          <div className="editor-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void changePin()}
            >
              {busy ? "Updating…" : "Change PIN"}
            </button>
          </div>
        </div>
      </section>

      <section
        className="settings-section settings-section-compact"
        id="settings-notifications"
        hidden={!shows("notifications")}
      >
        <div className="dash-card-head">
          <h3 className="settings-heading">Notifications</h3>
          <span className={preview ? "badge badge-accent" : "badge"}>
            {preview ? "previews on" : "previews off"}
          </span>
        </div>
        <p className="page-subtitle">
          Reminders alert only while Purple Memo is open and unlocked — there is
          no background delivery. Your operating system may show notifications
          on screen while they do.
        </p>
        <label className="check-label">
          <input
            type="checkbox"
            checked={preview}
            onChange={(e) => void changePreview(e.target.checked)}
          />
          Include reminder text in notifications. Off (the default) means every
          notification says only that a reminder is due — never its title or
          note. When several come due at once, they share one summary alert
          either way.
        </label>
      </section>

      <section
        className="settings-section settings-section-compact"
        id="settings-vault"
        hidden={!shows("vault")}
      >
        <div className="dash-card-head">
          <h3 className="settings-heading">Vault</h3>
          <span className="badge badge-accent">AES-256-GCM</span>
        </div>
        <p className="muted">
          Password-protected secrets. Setup, unlock and password changes live on
          the Vault page.
        </p>
        <div className="editor-row">
          <button
            type="button"
            className="btn"
            onClick={() => p.onNavigate("vault")}
          >
            Open Vault <IconArrowRight className="icon" />
          </button>
        </div>
      </section>

      <section
        className="settings-section"
        id="settings-key-export"
        hidden={!shows("key-export")}
      >
        <div className="dash-card-head">
          <h3 className="settings-heading">Encryption key export</h3>
          <span className="badge badge-warn">Sensitive</span>
        </div>
        <p className="muted">
          A database backup without this key is unopenable — and this key on its
          own opens your data. Save it as its own file, stored apart from any
          backup, and never send it anywhere. The key is written straight to the
          file you choose and is never shown, copied, or kept in memory by this
          window. Every export is recorded in key-export.log beside the
          database. Backup export and import live below.
        </p>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={keyAck}
            onChange={(e) => setKeyAck(e.target.checked)}
          />
          I understand — the key goes into its own file, never into a backup.
        </label>
        <div className="editor-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={keyBusy}
            onClick={() => void exportKey()}
          >
            {keyBusy ? "Writing…" : "Save encryption key…"}
          </button>
        </div>
      </section>

      <section
        className="settings-section settings-section-expanded"
        id="settings-backup"
        hidden={!shows("backup")}
      >
        <div className="dash-card-head">
          <h3 className="settings-heading">{t("settings.backupTitle")}</h3>
          <span className="badge">{t("settings.backupBadge")}</span>
        </div>
        <p className="muted">{t("settings.backupNote")}</p>
        <label className="check-label">
          <input
            type="checkbox"
            checked={passwordBackup}
            disabled={backupBusy || pending !== null}
            onChange={(e) => {
              setPasswordBackup(e.target.checked);
              setBackupPassword("");
              setBackupPasswordConfirm("");
            }}
          />{" "}
          {t("settings.protectBackup", { ext: ENCRYPTED_BACKUP_EXTENSION })}
        </label>
        {passwordBackup && (
          <>
            <div className="form-grid">
              <label>
                {t("settings.backupPassword")}
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  disabled={backupBusy}
                  value={backupPassword}
                  onChange={(e) => setBackupPassword(e.target.value)}
                />
              </label>
              <label>
                {t("settings.confirmBackupPassword")}
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  disabled={backupBusy}
                  value={backupPasswordConfirm}
                  onChange={(e) => setBackupPasswordConfirm(e.target.value)}
                />
              </label>
            </div>
            <p className="muted">{t("settings.backupPasswordNote")}</p>
          </>
        )}
        <div className="editor-row">
          <button
            type="button"
            className={`btn btn-primary${backupBusy ? " btn-loading" : ""}`}
            disabled={backupBusy || pending !== null}
            onClick={() => void doExport()}
          >
            <IconDownload className="icon" />
            {backupBusy && <IconSpinner />}
            {backupBusy ? t("settings.exporting") : t("settings.exportBackup")}
          </button>
          <label className="btn">
            <IconUpload className="icon" />
            {importBusy ? t("settings.importing") : t("settings.importBackup")}
            <input
              className="visually-hidden"
              type="file"
              accept={`.zip,.${ENCRYPTED_BACKUP_EXTENSION},application/zip,application/x-zip-compressed,${ENCRYPTED_BACKUP_MIME}`}
              disabled={importBusy || pending !== null || lockedFile !== null}
              onChange={(e) => {
                void onPickBackup(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        </div>
        {lockedFile !== null && (
          <div>
            <p className="alert alert-note">{t("settings.lockedNote")}</p>
            <label>
              {t("settings.backupPassword")}
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                disabled={importBusy}
                value={importPassword}
                onChange={(e) => setImportPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void unlockPicked();
                }}
              />
            </label>
            <div className="editor-row">
              <button
                type="button"
                className={`btn btn-primary${importBusy ? " btn-loading" : ""}`}
                disabled={importBusy}
                onClick={() => void unlockPicked()}
              >
                {importBusy && <IconSpinner />}
                {importBusy ? t("settings.opening") : t("settings.openBackup")}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={importBusy}
                onClick={() => {
                  setLockedFile(null);
                  setImportPassword("");
                }}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        )}
        {pending !== null && (
          <div>
            <p className="alert alert-note">
              {t("settings.summary", {
                date: formatDateTime(locale, pending.summary.exportedAt),
                rows: pending.summary.rowCount,
                tables: pending.summary.tableCount,
                photos: pending.summary.photoCount,
              })}
            </p>
            <div className="editor-row">
              <button
                type="button"
                className={`btn btn-danger${importBusy ? " btn-loading" : ""}`}
                disabled={importBusy}
                onClick={() => void confirmImport()}
              >
                {importBusy && <IconSpinner />}
                {importBusy
                  ? t("settings.importing")
                  : t("settings.replaceAll")}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={importBusy}
                onClick={() => setPending(null)}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        )}
      </section>

      <section
        className="settings-section"
        id="settings-share"
        hidden={!shows("share")}
      >
        <div className="dash-card-head">
          <h3 className="settings-heading">Share to this network</h3>
          <span
            className={shareState?.running ? "badge badge-success" : "badge"}
          >
            {shareState?.running ? "Live on LAN" : "Off"}
          </span>
        </div>
        <p className="muted">
          A read-only view of your dashboard for a phone on the same Wi-Fi:
          money, wallets, due items, habits, upcoming dates and recent notes.
          The vault, settings and photos are never part of it. Anyone the link
          reaches can read that snapshot, so turn it off when you are done —
          sharing never survives a restart and stops when the app is locked.
        </p>
        <p className="alert alert-note" role="note">
          The snapshot is AES-256-GCM encrypted. Its key is carried in the link
          fragment, which is not sent in HTTP requests. HTTP cannot authenticate
          the desktop, so an active network attacker could replace this page and
          capture the key. Use only on a trusted private network.
        </p>
        {shareState?.running && (
          <p className="alert alert-note" role="status">
            Sharing is live. Locking Purple Memo stops this sharing session and
            invalidates its link.
          </p>
        )}
        {shareState?.running ? (
          <div className="side-form">
            <label>
              Open this encrypted link on the phone
              <input
                className="input"
                readOnly
                value={shareState.url ?? ""}
                onFocus={(e) => e.target.select()}
              />
            </label>
            <p className="muted">
              Key stays in the link fragment · port {shareState.port ?? "?"}
              {shareState.publishedAt !== null
                ? ` · last snapshot ${shareState.publishedAt.replace("T", " ")}`
                : " · waiting for the first snapshot…"}
            </p>
            <div className="editor-row">
              <button
                type="button"
                className="btn"
                onClick={() => void copyShareLink()}
              >
                {shareCopied ? "Copied" : "Copy link"}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={shareBusy}
                onClick={() => void stopShare()}
              >
                {shareBusy ? "Stopping…" : "Stop sharing"}
              </button>
            </div>
          </div>
        ) : (
          <div className="side-form">
            <label className="settings-check">
              <input
                type="checkbox"
                checked={shareAck}
                onChange={(e) => setShareAck(e.target.checked)}
              />
              I understand — anyone with this link can decrypt my snapshot, and
              HTTP does not authenticate the desktop.
            </label>
            <div className="editor-row">
              <button
                type="button"
                className={`btn btn-primary${shareBusy ? " btn-loading" : ""}`}
                disabled={shareBusy}
                onClick={() => void startShare()}
              >
                {shareBusy && <IconSpinner />}
                {shareBusy ? "Starting…" : "Start sharing"}
              </button>
            </div>
            <p className="muted">
              Every start and stop is recorded in share.log beside the database.
            </p>
          </div>
        )}
        {shareState !== null &&
          !shareState.running &&
          shareState.note !== null && (
            <p className="alert alert-note">{shareState.note}</p>
          )}
      </section>

      <section
        className="settings-section"
        id="settings-updates"
        hidden={!shows("updates")}
      >
        <div className="dash-card-head">
          <h3 className="settings-heading">Updates</h3>
          <span className="badge">Signed releases</span>
        </div>
        <p className="muted">
          Releases are built, signed and published by hand, so Purple Memo only
          checks the release feed when you ask it to. A downloaded update is
          verified against the bundled public key before it is installed.
        </p>
        <div className="editor-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={updateBusy}
            onClick={() => void checkUpdates()}
          >
            {updateBusy && update === null ? "Checking…" : "Check for updates"}
          </button>
          {update !== null && (
            <button
              type="button"
              className={`btn btn-primary${updateBusy ? " btn-loading" : ""}`}
              disabled={updateBusy}
              onClick={() => void installNow()}
            >
              {updateBusy && <IconSpinner />}
              {updateBusy ? "Downloading…" : `Install ${update.version}`}
            </button>
          )}
        </div>
        {update !== null && (
          <div>
            <p className="figure">{describeUpdate(update)}</p>
            {update.date ? (
              <p className="muted">
                Published {new Date(update.date).toLocaleString()}
              </p>
            ) : null}
            {notesExcerpt(update.body).length > 0 && (
              <pre className="update-notes">{notesExcerpt(update.body)}</pre>
            )}
            {updateBusy && (
              <p className="muted">
                {updatePercent === null
                  ? "Downloading…"
                  : `Downloading… ${updatePercent}%`}
              </p>
            )}
          </div>
        )}
        {updateChecked && update === null && !updateDone && (
          <p className="muted">No newer release is published yet.</p>
        )}
        {updateDone && (
          <p className="alert alert-note">
            Update installed — restart Purple Memo to run the new version.
          </p>
        )}
      </section>

      <section
        className="settings-section settings-section-compact"
        id="settings-about"
        hidden={!shows("about")}
      >
        <div className="dash-card-head">
          <h3 className="settings-heading">About</h3>
          <span className="badge badge-accent">Open Source</span>
        </div>
        {appVersion !== null && (
          <p className="muted" data-testid="app-version">
            Version {appVersion}
          </p>
        )}
        <p className="muted">
          Purple Memo — a personal, offline-first notebook and finance manager.
          No accounts, no servers, no cloud. Everything lives in an encrypted
          SQLCipher database on this machine.
        </p>
      </section>

      <section
        className="settings-section settings-section-danger"
        id="settings-danger"
        hidden={!shows("danger")}
        aria-busy={resetting}
      >
        <div className="dash-card-head">
          <h3 className="settings-heading">{t("reset.dangerZone")}</h3>
          <span className="badge badge-danger">
            {t("reset.dangerZoneBadge")}
          </span>
        </div>
        <h4 className="side-heading">{t("reset.factoryReset")}</h4>
        <p className="muted">{t("reset.removes")}</p>
        {/* One child: `.alert` is a flex container, so the sentence must live
            in a single element or every text run becomes its own flex item. */}
        <p className="alert alert-warn" role="note">
          <span>{t("reset.notForensic")}</span>
        </p>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={resetAck}
            disabled={resetting}
            onChange={(e) => setResetAck(e.target.checked)}
          />
          {t("reset.acknowledge")}
        </label>
        {resetting && (
          <p className="alert alert-warn" role="status">
            {t("reset.running")}
          </p>
        )}
        <div className="editor-row">
          {/* The checkbox plus this two-step ConfirmButton are both required
              before the engine can run (owner decision) — the
              second click names its own consequence. */}
          <ConfirmButton
            what={t("reset.confirmWhat")}
            className="btn btn-danger"
            disabled={!resetAck || resetting}
            onConfirm={runFactoryReset}
          >
            {t("reset.run")}
          </ConfirmButton>
        </div>
      </section>
    </div>
  );
}
