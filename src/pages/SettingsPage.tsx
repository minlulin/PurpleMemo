// Settings page (§2.8): theme, PIN + security question change, auto-lock
// window, vault entry point, encryption key export, backup & restore, about.
// No accounts, no sync, no cloud settings — they never exist (§2.8).
// The PIN change verifies the current PIN first and re-hashes with
// PBKDF2-SHA256 (600k, §2.9); the PIN itself is never stored.
// Backup (§8) exports/imports a zip of all data + photos — the encryption
// key is never inside it; import replaces ALL current data, so the UI
// confirms before applying and reloads afterwards.

import { useState } from "react";
import { IconDownload, IconUpload } from "../components/icons.tsx";
import { backupRepo, settingsRepo } from "../data/app.ts";
import { AUTO_LOCK_CHOICES, MIN_PIN_LENGTH } from "../lib/appLock.ts";
import { hashAnswer, hashPin, type PinHash, verifyPin } from "../lib/crypto.ts";
import { todayLocal } from "../lib/dates.ts";
import type { PageKey } from "../lib/navigation.ts";
import { SETTING_KEYS, type Theme } from "../lib/settings.ts";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface SettingsPageProps {
  theme: Theme;
  autoLockMinutes: number;
  /** Reload boot state (theme/auto-lock) after a settings write. */
  onChanged: () => void;
  /** Navigate to another section (the vault entry point). */
  onNavigate: (key: PageKey) => void;
}

export default function SettingsPage(p: SettingsPageProps) {
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pin, setPin] = useState({
    current: "",
    next: "",
    confirm: "",
    question: "",
    answer: "",
  });

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
    setNote(null);
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
      setNote("PIN updated.");
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
    setNote(null);
    setError(null);
    setPending(null);
    setBackupBusy(true);
    try {
      const { bytes, summary } = await backupRepo.exportBackup();
      const blob = new Blob([new Uint8Array(bytes)], {
        type: "application/zip",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `purple-memo-backup-${todayLocal()}.zip`;
      link.click();
      URL.revokeObjectURL(url);
      setNote(
        `Backup saved (${summary.rowCount} rows, ${summary.photoCount} photos) — keep it with your key file, somewhere safe.`,
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
    setNote(null);
    try {
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
      const result = await backupRepo.importBackup(pending.bytes);
      setPending(null);
      setNote(
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
    setNote(null);
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

  const saveKeyFile = () => {
    if (!exportedKey) return;
    const blob = new Blob([`${exportedKey}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "purple-memo-db-key.txt";
    link.click();
    URL.revokeObjectURL(url);
    setNote(
      "Encryption key file download started. Store it separately from backups.",
    );
  };

  return (
    <div className="budget-page">
      <h2 className="editor-title">Settings</h2>
      {error !== null && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}
      {note !== null && <p className="alert alert-note">{note}</p>}

      <section className="settings-section">
        <h3 className="settings-heading">Appearance</h3>
        <div className="editor-row">
          <button
            type="button"
            className={p.theme === "dark" ? "btn btn-primary" : "btn btn-ghost"}
            aria-pressed={p.theme === "dark"}
            onClick={() => void setTheme("dark")}
          >
            Dark
          </button>
          <button
            type="button"
            className={
              p.theme === "light" ? "btn btn-primary" : "btn btn-ghost"
            }
            aria-pressed={p.theme === "light"}
            onClick={() => void setTheme("light")}
          >
            Light
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h3 className="settings-heading">App lock</h3>
        <label className="side-form">
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
        <div className="side-form">
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
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void changePin()}
          >
            {busy ? "Updating…" : "Change PIN"}
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h3 className="settings-heading">Vault</h3>
        <p className="muted">
          Password-protected secrets. Setup, unlock and password changes live on
          the Vault page.
        </p>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => p.onNavigate("vault")}
        >
          Open Vault
        </button>
      </section>

      <section className="settings-section">
        <h3 className="settings-heading">Encryption key export</h3>
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
            className="btn btn-ghost"
            disabled={keyBusy}
            onClick={() => void exportKey()}
          >
            {keyBusy ? "Reading…" : "Show encryption key"}
          </button>
          {exportedKey !== null && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void copyKey()}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          )}
          {exportedKey !== null && (
            <button
              type="button"
              className="btn btn-ghost"
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

      <section className="settings-section">
        <h3 className="settings-heading">Backup &amp; restore</h3>
        <p className="muted">
          Export everything — every table and photo — into one zip file, saved
          wherever you like. The encryption key is never inside the backup.
          Importing a backup replaces ALL current data with the backup&apos;s.
        </p>
        <div className="editor-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={backupBusy || pending !== null}
            onClick={() => void doExport()}
          >
            <IconDownload className="icon" />
            {backupBusy ? "Exporting…" : "Export backup"}
          </button>
          <label className="btn btn-ghost">
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
                className="btn btn-danger"
                disabled={importBusy}
                onClick={() => void confirmImport()}
              >
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

      <section className="settings-section">
        <h3 className="settings-heading">About</h3>
        <p className="muted">
          Purple Memo — a personal, offline-first notebook. No accounts, no
          servers, no cloud. Everything lives in an encrypted database on this
          machine.
        </p>
      </section>
    </div>
  );
}
