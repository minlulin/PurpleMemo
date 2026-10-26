// Shared CSV import dialog: pick a file, preview what would be written, then
// confirm. Nothing touches the database until the confirm step, and the
// preview is built in memory from the parser's rows.
//
// The file input lives here, inside the dialog, exactly as Settings' backup
// import does — a hidden input behind a styled button, read with the File API.
// The CALLER owns the read via `onPick` (`readCsvFile`, which checks the byte
// cap before calling `file.text()`), keeping size/type policy with the CSV
// module. Saving the template CSV uses the native `save()` dialog + Rust's
// atomic export writer, because `<a href="data:..." download>` is blocked by
// the webview navigation guard (`navigation.rs`).
//
// `parse` and `onConfirm` are supplied by the page, so this component knows
// nothing about tasks or contacts — only about rows, errors and counts.

import { save } from "@tauri-apps/plugin-dialog";
import { useRef, useState } from "react";
import { saveCsvTemplate } from "../data/app.ts";
import { cellText, PREVIEW_ROW_LIMIT } from "../lib/csv.ts";
import { errText } from "../lib/errors.ts";
import { isMessageKeyError, type MessageKey } from "../lib/i18n.ts";
import { Dialog } from "./Dialog.tsx";
import { IconDownload, IconUpload } from "./icons.tsx";
import { useToast } from "./Toast.tsx";
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

export { cellText, PREVIEW_ROW_LIMIT };

/** Optional localized column definition for the preview table. */
export interface ImportColumn<T> {
  key: string;
  label: string;
  render?: (row: NoInfer<T>) => string;
}

interface ImportDialogProps<T> {
  /** Dialog heading, already translated by the caller. */
  title: string;
  /** Exact text of the template the download button hands out. */
  templateCsv: string;
  /** File name for that download, e.g. `purple-memo-tasks-template.csv`. */
  templateName: string;
  /** Optional localized preview columns; falls back to `Object.keys(valid[0])`. */
  columns?: NoInfer<ImportColumn<T>>[];
  /** Read the picked file and return its text. */
  onPick: (file: File) => Promise<string>;
  /** Parse + validate in memory; throw to refuse the whole file. */
  parse: (text: string) => ImportPreview<T>;
  /** Write the accepted rows; the dialog never writes anything itself. */
  onConfirm: (validRows: T[]) => Promise<ImportSummary>;
  onClose: () => void;
}

type Phase = "pick" | "preview" | "running" | "done";

export function ImportDialog<T extends object>({
  title,
  templateCsv,
  templateName,
  columns: customColumns,
  onPick,
  parse,
  onConfirm,
  onClose,
}: ImportDialogProps<T>) {
  const t = useT();
  const plural = usePlural();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>("pick");
  const [preview, setPreview] = useState<ImportPreview<T> | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [reading, setReading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Authoritative in-flight guard for the batch confirm write (P1-5). */
  const runningRef = useRef(false);
  /** Authoritative in-flight guard while the native save dialog is open. */
  const downloadingRef = useRef(false);

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
    if (runningRef.current) return;
    if (preview === null || preview.valid.length === 0) return;
    runningRef.current = true;
    setError(null);
    setPhase("running");
    try {
      setSummary(await onConfirm(preview.valid));
      setPhase("done");
    } catch (e) {
      setError(describe(e));
      setPhase("preview");
    } finally {
      runningRef.current = false;
    }
  };

  // Saved through the native dialog + Rust's atomic writer rather than
  // `<a href="data:..." download>`, which `navigation.rs` blocks in Tauri.
  const downloadTemplate = async () => {
    if (downloadingRef.current) return;
    if (phase === "running") return;
    downloadingRef.current = true;
    setDownloading(true);
    setError(null);
    try {
      const path = await save({
        title: t("import.saveTemplateTitle"),
        defaultPath: templateName,
        filters: [{ name: t("import.csvFilter"), extensions: ["csv"] }],
      });
      if (path === null) return;
      await saveCsvTemplate(path, templateCsv);
      toast.success(t("import.templateSaved", { path }));
    } catch (e) {
      setError(describe(e));
    } finally {
      downloadingRef.current = false;
      setDownloading(false);
    }
  };

  const templateButton = (
    <button
      type="button"
      className="btn btn-ghost"
      disabled={downloading || phase === "running"}
      onClick={() => void downloadTemplate()}
    >
      <IconDownload className="icon" />
      {downloading ? t("import.savingTemplate") : t("import.downloadTemplate")}
    </button>
  );

  const skipped = preview?.errors.length ?? 0;
  const resolvedColumns: ImportColumn<T>[] =
    customColumns ??
    (preview !== null && preview.valid.length > 0
      ? Object.keys(preview.valid[0] ?? {}).map((key) => ({ key, label: key }))
      : []);
  const previewRows =
    preview !== null ? preview.valid.slice(0, PREVIEW_ROW_LIMIT) : [];

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
            {templateButton}
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
            <>
              {preview.valid.length > PREVIEW_ROW_LIMIT ? (
                <p className="muted">
                  {t("import.previewCapped", {
                    shown: PREVIEW_ROW_LIMIT,
                    total: preview.valid.length,
                  })}
                </p>
              ) : null}
              <div className="exports-table-wrap import-preview-scroll">
                <table
                  className="exports-table"
                  aria-label={t("import.rowsToImportAria")}
                >
                  <thead>
                    <tr>
                      {resolvedColumns.map((column) => (
                        <th key={column.key} scope="col">
                          {column.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((row, index) => (
                      // Read-only preview; the row order is the import order.
                      // biome-ignore lint/suspicious/noArrayIndexKey: static preview, order is the identity
                      <tr key={index}>
                        {resolvedColumns.map((column) => (
                          <td key={column.key}>
                            {column.render
                              ? column.render(row)
                              : cellText(
                                  (row as Record<string, unknown>)[column.key],
                                )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
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
            {templateButton}
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
