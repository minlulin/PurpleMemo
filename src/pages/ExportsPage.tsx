import { save } from "@tauri-apps/plugin-dialog";
import { useRef, useState } from "react";
import {
  IconContacts,
  IconDownload,
  IconJournal,
  IconNotes,
  IconSpinner,
  IconTasks,
  IconWallet,
} from "../components/icons.tsx";
import { useToast } from "../components/Toast.tsx";
import { useT } from "../components/useTranslation.ts";
import { exportsRepo } from "../data/app.ts";
import { localISODateTime, todayLocal } from "../lib/dates.ts";
import { errText } from "../lib/errors.ts";
import {
  ALL_EXPORT_GROUPS,
  EXPORT_FIELD_MAPPING,
  type ExportGroup,
  type ExportSelection,
} from "../lib/exports.ts";
import type { MessageKey } from "../lib/i18n.ts";

const GROUPS: {
  key: ExportGroup;
  labelKey: MessageKey;
  blurbKey: MessageKey;
  icon: typeof IconNotes;
}[] = [
  {
    key: "notes",
    labelKey: "nav.notes",
    blurbKey: "exports.group.notesBlurb",
    icon: IconNotes,
  },
  {
    key: "journal",
    labelKey: "nav.journal",
    blurbKey: "exports.group.journalBlurb",
    icon: IconJournal,
  },
  {
    key: "finance",
    labelKey: "exports.group.finance",
    blurbKey: "exports.group.financeBlurb",
    icon: IconWallet,
  },
  {
    key: "tasks",
    labelKey: "exports.group.tasks",
    blurbKey: "exports.group.tasksBlurb",
    icon: IconTasks,
  },
  {
    key: "contacts",
    labelKey: "nav.contacts",
    blurbKey: "exports.group.contactsBlurb",
    icon: IconContacts,
  },
];

export default function ExportsPage() {
  const t = useT();
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
    // Clear the "choose at least one group" refusal the moment the selection
    // changes (G14): re-checking a group used to leave the stale red alert on
    // screen until Export was clicked a second time.
    setError(null);
    setSelection((current) => ({ ...current, [key]: !current[key] }));
  };

  const doExport = async () => {
    if (busyRef.current) return;
    setError(null);
    if (!Object.values(selection).some(Boolean)) {
      setError(t("exports.chooseOne"));
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const defaultDay = todayLocal();
      const path = await save({
        title: t("exports.saveTitle"),
        defaultPath: `purple-memo-readable-${defaultDay}.zip`,
        filters: [{ name: t("exports.zipFilter"), extensions: ["zip"] }],
      });
      if (path === null) return;
      // ONE clock for the whole export (G14). `today` used to be read before
      // `await save(...)` (which can sit open across midnight) while
      // `exportedAt` was read after, so `README.txt`'s "Generated:" and the
      // loan states in `finance/loans.csv` (both graded against the day)
      // could disagree by a day. `deriveLoanState` grades against `today`, so
      // the day is read here, beside `exportedAt`, not before the dialog.
      const today = todayLocal();
      const exportedAt = localISODateTime(new Date());
      const { bytes, counts, fileCount } = await exportsRepo.build(
        selection,
        today,
        exportedAt,
      );
      await exportsRepo.save(path, bytes);
      // Finance reported as its own count (G6): it used to be omitted, so a
      // Finance-only export announced "0 notes, 0 journal entries, 0 tasks,
      // 0 contacts" even after writing hundreds of finance rows.
      const financeRows =
        counts.income +
        counts.expenses +
        counts.loans +
        counts.jobs +
        counts.payables;
      toast.success(
        t("exports.saved", {
          path,
          files: fileCount,
          notes: counts.notes,
          journal: counts.journal,
          finance: financeRows,
          tasks: counts.tasks,
          contacts: counts.contacts,
        }),
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
              <h2 className="editor-title">{t("exports.title")}</h2>
              <p className="page-subtitle">{t("exports.subtitle")}</p>
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
          {t("exports.whatToExport")}
        </h3>
        <p className="muted">{t("exports.readableCopy")}</p>
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
                  <span className="exports-group-title">
                    {t(group.labelKey)}
                  </span>
                  <span className="muted">{t(group.blurbKey)}</span>
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
            {/* G6: `.btn-loading` sets `color: transparent` so a spinner
                replaces the label without changing the footprint. Without a
                spinner here the button rendered as a blank purple rectangle
                for the whole export. */}
            {busy ? (
              <>
                <IconSpinner className="icon" /> {t("exports.building")}
              </>
            ) : (
              t("exports.export")
            )}
          </button>
          <span className="muted">{t("exports.oneFile")}</span>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="export-fields">
        <h3 className="settings-heading" id="export-fields">
          {t("exports.fieldMapping")}
        </h3>
        <p className="muted">{t("exports.sameTable")}</p>
        <div className="exports-table-wrap">
          <table className="exports-table">
            <thead>
              <tr>
                <th scope="col">{t("exports.source")}</th>
                <th scope="col">{t("exports.fields")}</th>
                <th scope="col">{t("exports.destination")}</th>
                <th scope="col">{t("exports.notes")}</th>
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
