// Settings page (§2.8): theme, PIN + security question change, auto-lock
// window, vault entry point, encryption key export, backup & restore, about.
// No accounts, no sync, no cloud settings — they never exist (§2.8).
// The PIN change verifies the current PIN first and re-hashes with
// PBKDF2-SHA256 (600k, §2.9); the PIN itself is never stored.
// Backup (§8) exports/imports a zip of all data + photos — the encryption
// key is never inside it; import replaces ALL current data, so the UI
// confirms before applying and reloads afterwards.

import { save } from "@tauri-apps/plugin-dialog";
import { writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useEffect, useState } from "react";
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
import { backupRepo, settingsRepo, shareRepo } from "../data/app.ts";
import type { ShareInfo } from "../data/driver.ts";
import { AUTO_LOCK_CHOICES, MIN_PIN_LENGTH } from "../lib/appLock.ts";
import { MAX_BACKUP_ARCHIVE_BYTES } from "../lib/backup.ts";
import { hashAnswer, hashPin, type PinHash, verifyPin } from "../lib/crypto.ts";
import { todayLocal } from "../lib/dates.ts";
import { errText } from "../lib/errors.ts";
import type { PageKey } from "../lib/navigation.ts";
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
}

/** Anchors for the sticky sub-nav; the ids live on the sections below. */
const SETTINGS_SECTIONS = [
  { id: "appearance", label: "Appearance" },
  { id: "lock", label: "App lock & PIN" },
  { id: "vault", label: "Vault" },
  { id: "key-export", label: "Key export" },
  { id: "backup", label: "Backup" },
  { id: "share", label: "Share" },
  { id: "updates", label: "Updates" },
  { id: "about", label: "About" },
] as const;

export default function SettingsPage(p: SettingsPageProps) {
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

  /** Section filter — matches the nav labels, so search and nav agree. An id
   * missing from the table stays visible rather than vanishing. */
  const needle = query.trim().toLowerCase();
  const shows = (id: string) => {
    if (needle === "") return true;
    const section = SETTINGS_SECTIONS.find((s) => s.id === id);
    return section ? section.label.toLowerCase().includes(needle) : true;
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

  const setAutoLock = async (minutes: number) => {
    try {
      await settingsRepo.setAutoLockMinutes(minutes);
      p.onChanged();
    } catch (e) {
      setError(errText(e));
    }
  };

  const changePin = async () => {
    setError(null);
    try {
      const stored = await settingsRepo.getJSON<PinHash>(SETTING_KEYS.pinHash);
      if (!stored) {
        setError("No PIN is set yet — complete the first-run setup.");
        return;
      }
      if (!(await verifyPin(pin.current, stored))) {
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
      toast.success("PIN updated.");
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const [keyBusy, setKeyBusy] = useState(false);
  const [keyAck, setKeyAck] = useState(false);
  const [exportedKey, setExportedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // -- Backup & restore (§8) ----------------------------------------------------
  const [backupBusy, setBackupBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [pending, setPending] = useState<{
    bytes: Uint8Array;
    summary: {
      exportedAt: string;
      tableCount: number;
      rowCount: number;
      photoCount: number;
    };
  } | null>(null);

  const doExport = async () => {
    setError(null);
    setPending(null);
    setBackupBusy(true);
    try {
      const { bytes, summary } = await backupRepo.exportBackup();
      const path = await save({
        title: "Save Purple Memo backup",
        defaultPath: `purple-memo-backup-${todayLocal()}.zip`,
        filters: [{ name: "Purple Memo backup", extensions: ["zip"] }],
      });
      if (path === null) return;
      await writeFile(path, bytes);
      toast.success(
        `Backup saved to ${path} — ${summary.rowCount} rows, ${summary.photoCount} photos`,
      );
    } catch (e) {
      setError(errText(e));
    } finally {
      setBackupBusy(false);
    }
  };

  const onPickBackup = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setError(null);
    try {
      if (file.size > MAX_BACKUP_ARCHIVE_BYTES) {
        throw new Error(
          `Backup archive is larger than the ${MAX_BACKUP_ARCHIVE_BYTES} byte limit — import rejected.`,
        );
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { summary } = await backupRepo.inspectBackup(bytes);
      setPending({ bytes, summary });
    } catch (e) {
      setError(errText(e));
    }
  };

  const confirmImport = async () => {
    if (!pending) return;
    setImportBusy(true);
    setError(null);
    try {
      // Sharing must stop BEFORE the data is replaced: the listener would
      // otherwise keep serving the pre-import snapshot to the phone (§8).
      await shareRepo.stop();
      const result = await backupRepo.importBackup(pending.bytes);
      setPending(null);
      toast.success(
        `Imported ${result.rows} rows and ${result.photos} photos — reloading…`,
      );
      // The imported backup carries its own settings (theme, PIN, …), so
      // the app re-boots from the database instead of trusting live state.
      window.setTimeout(() => window.location.reload(), 900);
    } catch (e) {
      setError(errText(e));
      setImportBusy(false);
    }
  };

  const exportKey = async () => {
    setError(null);
    setCopied(false);
    if (!keyAck) {
      setError(
        "Tick the acknowledgement first — the key must go into its own file, never into a backup.",
      );
      return;
    }
    setKeyBusy(true);
    try {
      setExportedKey(await settingsRepo.exportDatabaseKey());
    } catch (e) {
      setError(errText(e));
    } finally {
      setKeyBusy(false);
    }
  };

  const copyKey = async () => {
    if (!exportedKey) return;
    try {
      await navigator.clipboard.writeText(exportedKey);
      setCopied(true);
    } catch {
      setError("Copy failed — select the key text and copy it manually.");
    }
  };

  const saveKeyFile = async () => {
    if (!exportedKey) return;
    try {
      const path = await save({
        title: "Save Purple Memo encryption key",
        defaultPath: "purple-memo-db-key.txt",
        filters: [{ name: "Text file", extensions: ["txt"] }],
      });
      if (path === null) return;
      await writeTextFile(path, `${exportedKey}\n`);
      toast.success(
        `Encryption key saved to ${path}. Store it separately from backups.`,
      );
    } catch (e) {
      setError(errText(e));
    }
  };

  // -- Same-network read-only share (§8, P5) ------------------------------------
  const [shareState, setShareState] = useState<ShareInfo | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);

  // The app shell keeps re-publishing while sharing; this mirrors the state
  // here (including a server that stopped itself after wrong pairing codes).
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

  const startShare = async () => {
    setError(null);
    setShareCopied(false);
    setShareBusy(true);
    try {
      setShareState(await shareRepo.start());
      // Publish at once so the phone has data before the shell's next tick.
      setShareState(await shareRepo.publishSnapshot());
    } catch (e) {
      setError(errText(e));
    } finally {
      setShareBusy(false);
    }
  };

  const stopShare = async () => {
    setError(null);
    setShareCopied(false);
    setShareBusy(true);
    try {
      setShareState(await shareRepo.stop());
    } catch (e) {
      setError(errText(e));
    } finally {
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

  // -- In-app updates (§9) ------------------------------------------------------
  const [update, setUpdate] = useState<UpdateHandle | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateChecked, setUpdateChecked] = useState(false);
  const [updatePercent, setUpdatePercent] = useState<number | null>(null);
  const [updateDone, setUpdateDone] = useState(false);

  const checkUpdates = async () => {
    setError(null);
    setUpdateDone(false);
    setUpdatePercent(null);
    setUpdateBusy(true);
    try {
      setUpdate(await checkForUpdate());
    } catch (e) {
      // No release published yet is the expected answer before the first
      // hand-made release (§9) — report it plainly instead of hiding it.
      setUpdate(null);
      setError(`Could not check for updates: ${errText(e)}`);
    } finally {
      setUpdateChecked(true);
      setUpdateBusy(false);
    }
  };

  const installNow = async () => {
    if (update === null) return;
    setError(null);
    setUpdateBusy(true);
    setUpdateDone(false);
    try {
      await installUpdate(update, setUpdatePercent);
      setUpdateDone(true);
    } catch (e) {
      setError(`Update failed: ${errText(e)}`);
    } finally {
      setUpdateBusy(false);
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
          backup, and never send it anywhere. Backup export and import live
          below.
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
            className="btn"
            disabled={keyBusy}
            onClick={() => void exportKey()}
          >
            {keyBusy ? "Reading…" : "Show encryption key"}
          </button>
          {exportedKey !== null && (
            <button
              type="button"
              className="btn"
              onClick={() => void copyKey()}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          )}
          {exportedKey !== null && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={saveKeyFile}
            >
              Save key file
            </button>
          )}
        </div>
        {exportedKey !== null && (
          <textarea
            className="textarea key-export-box"
            rows={3}
            readOnly
            value={exportedKey}
            onFocus={(e) => e.target.select()}
          />
        )}
      </section>

      <section
        className="settings-section settings-section-expanded"
        id="settings-backup"
        hidden={!shows("backup")}
      >
        <div className="dash-card-head">
          <h3 className="settings-heading">Backup &amp; restore</h3>
          <span className="badge">.zip archive</span>
        </div>
        <p className="muted">
          Export everything — every table and photo — into one zip file, saved
          wherever you like. The encryption key is never inside the backup.
          Importing a backup replaces ALL current data with the backup&apos;s.
        </p>
        <div className="editor-row">
          <button
            type="button"
            className={`btn btn-primary${backupBusy ? " btn-loading" : ""}`}
            disabled={backupBusy || pending !== null}
            onClick={() => void doExport()}
          >
            <IconDownload className="icon" />
            {backupBusy && <IconSpinner />}
            {backupBusy ? "Exporting…" : "Export backup"}
          </button>
          <label className="btn">
            <IconUpload className="icon" />
            {importBusy ? "Importing…" : "Import backup"}
            <input
              className="visually-hidden"
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              disabled={importBusy || pending !== null}
              onChange={(e) => {
                void onPickBackup(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        </div>
        {pending !== null && (
          <div>
            <p className="alert alert-note">
              Backup from{" "}
              {new Date(pending.summary.exportedAt).toLocaleString()}:{" "}
              {pending.summary.rowCount} rows across{" "}
              {pending.summary.tableCount} tables, {pending.summary.photoCount}{" "}
              photos. Continuing replaces ALL current data.
            </p>
            <div className="editor-row">
              <button
                type="button"
                className={`btn btn-danger${importBusy ? " btn-loading" : ""}`}
                disabled={importBusy}
                onClick={() => void confirmImport()}
              >
                {importBusy && <IconSpinner />}
                {importBusy ? "Importing…" : "Replace all data"}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={importBusy}
                onClick={() => setPending(null)}
              >
                Cancel
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
          LAN sharing uses unencrypted HTTP. Use it only on a trusted private
          network: anyone who can observe the Wi-Fi traffic may capture the
          pairing link and snapshot.
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
              Open this on the phone (it carries the pairing code)
              <input
                className="input"
                readOnly
                value={shareState.url ?? ""}
                onFocus={(e) => e.target.select()}
              />
            </label>
            <p className="muted">
              Pairing code <b>{shareState.code}</b> · port{" "}
              {shareState.port ?? "?"}
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
        <p className="muted">
          Purple Memo — a personal, offline-first notebook and finance manager.
          No accounts, no servers, no cloud. Everything lives in an encrypted
          SQLCipher database on this machine.
        </p>
      </section>
    </div>
  );
}
