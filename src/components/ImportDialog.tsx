// Shared CSV import dialog: pick a file, preview what would be written, then
// confirm. Nothing touches the database until the confirm step, and the
// preview is built in memory from the parser's rows.
//
// The file input lives here, inside the dialog, exactly as Settings' backup
// import does — a hidden input behind a styled button, read with the File API.
// No native open/read command is involved. The CALLER owns the read via
// `onPick` (it hands back the text), which keeps size/type policy and any
// future pre-processing with the page that knows its own format.
//
// `parse` and `onConfirm` are supplied by the page, so this component knows
// nothing about tasks or contacts — only about rows, errors and counts.

import { useState } from "react";
import { errText } from "../lib/errors.ts";
import { isMessageKeyError, type MessageKey } from "../lib/i18n.ts";
import { Dialog } from "./Dialog.tsx";
import { IconDownload, IconUpload } from "./icons.tsx";
import { usePlural, useT } from "./useTranslation.ts";

/** One rejected row, as the caller's mapper reports it. */
export interface ImportRowError {
  /** 1-based DATA row — the header row is not row 1. */
  row: number;
  /** Translation key; rendered here in the active locale. */
  reason: MessageKey;
}

/** What `parse` returns: rows safe to write, plus the rows that will be skipped. */
export interface ImportPreview<T> {
  valid: T[];
  errors: ImportRowError[];
}

/**
 * What the caller's `onConfirm` reports back. The dialog adds the skipped count
 * from its own preview — the caller only ever sees the accepted rows.
 */
export interface ImportSummary {
  imported: number;
}

interface ImportDialogProps<T> {
  /** Dialog heading, already translated by the caller. */
  title: string;
  /** Exact text of the template the download button hands out. */
  templateCsv: string;
  /** File name for that download, e.g. `purple-memo-tasks-template.csv`. */
  templateName: string;
  /** Read the picked file and return its text. */
  onPick: (file: File) => Promise<string>;
  /** Parse + validate in memory; throw to refuse the whole file. */
  parse: (text: string) => ImportPreview<T>;
  /** Write the accepted rows; the dialog never writes anything itself. */
  onConfirm: (validRows: T[]) => Promise<ImportSummary>;
  onClose: () => void;
}

type Phase = "pick" | "preview" | "running" | "done";

/** A preview cell without inventing entity-specific rendering. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.map(cellText).join("; ");
  if (typeof value === "object") {
    // Imported channels carry their display string on `value`; showing the
    // bare object would bury a phone number in JSON in the preview table.
    const record = value as Record<string, unknown>;
    if (typeof record.value === "string") return record.value;
    return JSON.stringify(value);
  }
  return String(value);
}

export function ImportDialog<T extends object>({
  title,
  templateCsv,
  templateName,
  onPick,
  parse,
  onConfirm,
  onClose,
}: ImportDialogProps<T>) {
  const t = useT();
  const plural = usePlural();
  const [phase, setPhase] = useState<Phase>("pick");
  const [preview, setPreview] = useState<ImportPreview<T> | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** A key-carrying refusal is rendered in the current locale; anything else
   * (a file-read failure, a database error) keeps its own text. */
  const describe = (e: unknown) =>
    isMessageKeyError(e) ? t(e.messageKey, e.params) : errText(e);

  // Closing mid-write would hide an import that may already have landed; the
  // user waits for the one batch instead.
  const close = () => {
    if (phase !== "running") onClose();
  };

  const pick = async (file: File) => {
    setError(null);
    setReading(true);
    try {
      const text = await onPick(file);
      const next = parse(text);
      setPreview(next);
      setSummary(null);
      setPhase("preview");
    } catch (e) {
      // A refused file (missing column, cap, unreadable text) stays on the
      // pick step so the user can choose another one.
      setError(describe(e));
      setPreview(null);
      setPhase("pick");
    } finally {
      setReading(false);
    }
  };

  const pickAgain = () => {
    setPreview(null);
    setSummary(null);
    setError(null);
    setPhase("pick");
  };

  const confirm = async () => {
    if (preview === null || preview.valid.length === 0) return;
    setError(null);
    setPhase("running");
    try {
      setSummary(await onConfirm(preview.valid));
      setPhase("done");
    } catch (e) {
      setError(describe(e));
      setPhase("preview");
    }
  };

  const templateLink = (
    <a
      className="btn btn-ghost"
      href={`data:text/csv;charset=utf-8,${encodeURIComponent(templateCsv)}`}
      download={templateName}
    >
      <IconDownload className="icon" />
      {t("import.downloadTemplate")}
    </a>
  );

  const skipped = preview?.errors.length ?? 0;
  const columns =
    preview !== null && preview.valid.length > 0
      ? Object.keys(preview.valid[0] ?? {})
      : [];

  return (
    <Dialog
      labelledBy="import-dialog-title"
      onClose={close}
      className="import-dialog"
    >
      <header className="note-reader-header">
        <h2 className="editor-title" id="import-dialog-title">
          {title}
        </h2>
      </header>

      {error !== null ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      {phase === "pick" ? (
        <div className="import-step">
          <p className="muted">{t("import.fileHint")}</p>
          <div className="row-actions">
            {/* A label wrapping the input is the app's existing pick pattern
                (SettingsPage's backup import), and keeps the button a real
                focusable control. */}
            <label className="btn btn-primary">
              <IconUpload className="icon" />
              {reading ? t("import.reading") : t("import.chooseFile")}
              <input
                className="visually-hidden"
                type="file"
                accept=".csv,text/csv"
                disabled={reading}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void pick(file);
                }}
              />
            </label>
            {templateLink}
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : null}

      {(phase === "preview" || phase === "running") && preview !== null ? (
        <div className="import-step">
          <div className="import-counts">
            <span className="badge badge-accent">
              {plural("import.ready", preview.valid.length)}
            </span>
            {preview.errors.length > 0 ? (
              <span className="badge badge-danger">
                {plural("import.failed", preview.errors.length)}
              </span>
            ) : null}
          </div>

          {preview.errors.length > 0 ? (
            <section className="import-errors">
              <h3 className="side-heading">{t("import.errorsTitle")}</h3>
              <ul
                className="import-error-list"
                aria-label={t("import.errorsAria")}
              >
                {preview.errors.map((rowError) => (
                  <li key={rowError.row}>
                    {t("import.rowError", {
                      row: rowError.row,
                      reason: t(rowError.reason),
                    })}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {preview.valid.length === 0 ? (
            <p className="alert alert-error">{t("import.nothing")}</p>
          ) : (
            <div className="exports-table-wrap import-preview-scroll">
              <table
                className="exports-table"
                aria-label={t("import.rowsToImportAria")}
              >
                <thead>
                  <tr>
                    {columns.map((column) => (
                      <th key={column} scope="col">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.valid.map((row, index) => (
                    // Read-only preview; the row order is the import order.
                    // biome-ignore lint/suspicious/noArrayIndexKey: static preview, order is the identity
                    <tr key={index}>
                      {columns.map((column) => (
                        <td key={column}>
                          {cellText((row as Record<string, unknown>)[column])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="row-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={phase === "running"}
              onClick={pickAgain}
            >
              {t("import.chooseAnother")}
            </button>
            {templateLink}
            <button
              type="button"
              className="btn btn-ghost"
              disabled={phase === "running"}
              onClick={onClose}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={phase === "running" || preview.valid.length === 0}
              onClick={() => void confirm()}
            >
              {phase === "running" ? t("import.importing") : t("import.import")}
            </button>
          </div>
        </div>
      ) : null}

      {phase === "done" && summary !== null ? (
        <div className="import-step">
          <h3 className="side-heading">{t("import.resultTitle")}</h3>
          <p>{plural("import.resultImported", summary.imported)}</p>
          {skipped > 0 ? (
            <p className="muted">{plural("import.resultSkipped", skipped)}</p>
          ) : null}
          <div className="row-actions">
            <button type="button" className="btn btn-primary" onClick={onClose}>
              {t("import.done")}
            </button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
