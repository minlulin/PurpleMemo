import { save } from "@tauri-apps/plugin-dialog";
import { useRef, useState } from "react";
import {
  IconContacts,
  IconDownload,
  IconJournal,
  IconNotes,
  IconWallet,
} from "../components/icons.tsx";
import { useToast } from "../components/Toast.tsx";
import { exportsRepo } from "../data/app.ts";
import { localISODateTime, todayLocal } from "../lib/dates.ts";
import { errText } from "../lib/errors.ts";
import {
  ALL_EXPORT_GROUPS,
  EXPORT_FIELD_MAPPING,
  type ExportGroup,
  type ExportSelection,
} from "../lib/exports.ts";

const GROUPS: {
  key: ExportGroup;
  label: string;
  blurb: string;
  icon: typeof IconNotes;
}[] = [
  {
    key: "notes",
    label: "Notes",
    blurb:
      "Markdown files with front matter, tags, collections and archive state",
    icon: IconNotes,
  },
  {
    key: "journal",
    label: "Journal",
    blurb: "One Markdown file per day under journal/yyyy/",
    icon: IconJournal,
  },
  {
    key: "finance",
    label: "Finance CSV",
    blurb: "Income, expenses, loans, jobs and payables",
    icon: IconWallet,
  },
  {
    key: "contacts",
    label: "Contacts",
    blurb: "A vCard 4.0 address book",
    icon: IconContacts,
  },
];

export default function ExportsPage() {
  const toast = useToast();
  const [selection, setSelection] =
    useState<ExportSelection>(ALL_EXPORT_GROUPS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The pinned double-submit guard: the build walks the
  // whole database, and a second click while the save dialog is open would
  // queue a second full export behind the first.
  const busyRef = useRef(false);

  const toggle = (key: ExportGroup) => {
    setSelection((current) => ({ ...current, [key]: !current[key] }));
  };

  const doExport = async () => {
    if (busyRef.current) return;
    setError(null);
    if (!Object.values(selection).some(Boolean)) {
      setError("Choose at least one group to export.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const today = todayLocal();
      const path = await save({
        title: "Save Purple Memo readable export",
        defaultPath: `purple-memo-readable-${today}.zip`,
        filters: [{ name: "ZIP archive", extensions: ["zip"] }],
      });
      if (path === null) return;
      const exportedAt = localISODateTime(new Date());
      const { bytes, counts, fileCount } = await exportsRepo.build(
        selection,
        today,
        exportedAt,
      );
      await exportsRepo.save(path, bytes);
      toast.success(
        `Readable export saved to ${path} - ${fileCount} files (${counts.notes} notes, ${counts.journal} journal entries, ${counts.contacts} contacts).`,
      );
    } catch (e) {
      setError(errText(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="budget-page exports-page">
      <header className="page-header">
        <div className="page-header-main">
          <div className="page-title-row">
            <span className="page-icon-badge">
              <IconDownload className="icon" />
            </span>
            <div>
              <h2 className="editor-title">Exports</h2>
              <p className="page-subtitle">
                Human-readable Markdown, CSV and vCard in one ZIP archive
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

      <section className="settings-section" aria-labelledby="export-groups">
        <h3 className="settings-heading" id="export-groups">
          What to export
        </h3>
        <p className="muted">
          This is a readable copy, not a restorable backup. Photo files, Vault
          ciphertext, settings and Trash are never included.
        </p>
        <div className="exports-group-grid">
          {GROUPS.map((group) => {
            const Icon = group.icon;
            return (
              <label
                key={group.key}
                className={`exports-group${selection[group.key] ? " is-selected" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={selection[group.key]}
                  disabled={busy}
                  onChange={() => toggle(group.key)}
                />
                <span className="exports-group-icon">
                  <Icon className="icon" />
                </span>
                <span>
                  <span className="exports-group-title">{group.label}</span>
                  <span className="muted">{group.blurb}</span>
                </span>
              </label>
            );
          })}
        </div>
        <div className="exports-actions">
          <button
            type="button"
            className={`btn btn-primary${busy ? " btn-loading" : ""}`}
            disabled={busy}
            onClick={() => void doExport()}
          >
            {busy ? "Building archive..." : "Export readable ZIP"}
          </button>
          <span className="muted">
            One UTF-8 ZIP file. CSV uses RFC 4180 quoting and CRLF; Markdown and
            vCard text keep their Unicode.
          </span>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="export-fields">
        <h3 className="settings-heading" id="export-fields">
          Field mapping
        </h3>
        <p className="muted">
          The same table is written into every archive as EXPORT-FIELDS.md.
        </p>
        <div className="exports-table-wrap">
          <table className="exports-table">
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Fields</th>
                <th scope="col">Destination</th>
                <th scope="col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {EXPORT_FIELD_MAPPING.map((row) => (
                <tr key={row.source}>
                  <th scope="row">{row.source}</th>
                  <td>{row.fields}</td>
                  <td>{row.destination}</td>
                  <td>{row.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
