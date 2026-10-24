// Quick capture inbox.
//
// One action captures; the list is what is left to decide about. The shell can
// also capture from anywhere (Ctrl+Shift+M), and `capturesMade` is how that
// tells this page to re-read — the same channel the reminder poll uses.
//
// The idempotency of conversion lives in the data layer (`lib/inbox.ts`), not
// here: a second click finds the row already converted, receives the recorded
// target, and says so. The in-flight refs below are UX, so a double-click does
// not even reach the database twice.

import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { IconInbox, IconSpinner } from "../components/icons.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { useToast } from "../components/Toast.tsx";
import { useLocale, useT } from "../components/useTranslation.ts";
import { inboxRepo } from "../data/app.ts";
import { errText } from "../lib/errors.ts";
import { formatDateTime } from "../lib/format.ts";
import type { MessageKey } from "../lib/i18n.ts";
import { targetKey } from "../lib/inbox.ts";
import type { InboxRow, InboxTarget } from "../lib/types.ts";

interface InboxPageProps {
  /** Bumped by the shell whenever it captured something from anywhere. */
  capturesMade: number;
}

const TARGET_LABELS: Record<InboxTarget, MessageKey> = {
  note: "inbox.target.note",
  task: "inbox.target.task",
  journal: "inbox.target.journal",
};

/** One word on a button is the whole budget here — three targets, three verbs. */
const TARGET_BUTTONS: { target: InboxTarget; label: MessageKey }[] = [
  { target: "note", label: "inbox.makeNote" },
  { target: "task", label: "inbox.makeTask" },
  { target: "journal", label: "inbox.addToJournal" },
];

export default function InboxPage(p: InboxPageProps) {
  const toast = useToast();
  const t = useT();
  const locale = useLocale();
  const [items, setItems] = useState<InboxRow[]>([]);
  const [archived, setArchived] = useState<InboxRow[]>([]);
  const [converted, setConverted] = useState<InboxRow[]>([]);
  const [live, setLive] = useState<Map<string, boolean>>(new Map());
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  /**
   * In-flight capture guard. A ref, because the repository cannot tell a retry
   * from a second click, and a `useState` flag would be read as stale inside
   * the same tick the click was delivered (review P3-12).
   */
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  /** Which row is being converted, so only its buttons lock. */
  const convertingRef = useRef<number | null>(null);
  const [convertingId, setConvertingId] = useState<number | null>(null);

  const reload = useCallback(async () => {
    try {
      const open = await inboxRepo.listOpen();
      const done = await inboxRepo.listByStatus("converted");
      const away = showArchived ? await inboxRepo.listByStatus("archived") : [];
      setLive(await inboxRepo.liveTargets(done));
      setItems(open);
      setConverted(done);
      setArchived(away);
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [showArchived]);

  // `capturesMade` is deliberately not read in the body: it is a signal, not
  // data, and its whole job is to change this effect's identity — the same
  // arrangement TasksPage uses for `refreshKey`. Keying the page on it would
  // remount and discard a half-typed memo, trading a stale list for lost
  // typing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: signal, not data
  useEffect(() => {
    void reload();
  }, [reload, p.capturesMade]);

  /**
   * Capture, then clear.
   *
   * There is no draft and no autosave: the row is written on submit, which is
   * the whole promise of quick capture. The residual window is the text between
   * the last keystroke and the submit — a crash there loses what was typed, and
   * it is not called crash-safe anywhere.
   */
  const capture = async () => {
    if (savingRef.current) return;
    if (text.trim().length === 0) {
      setError(t("capture.empty"));
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await inboxRepo.create(text);
      setText("");
      await reload();
      toast.success(t("capture.saved"));
    } catch (e) {
      setError(errText(e));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const convert = async (row: InboxRow, target: InboxTarget) => {
    if (convertingRef.current !== null) return;
    convertingRef.current = row.id;
    setConvertingId(row.id);
    setError(null);
    try {
      const result = await inboxRepo.convert(row.id, target);
      // Deliberately does not claim authorship: if another click won the race,
      // this is the target that other call created, and the message stays true.
      toast.success(
        t("inbox.convertedToast", {
          target: t(TARGET_LABELS[result.type]),
          id: result.id,
        }),
      );
      await reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      convertingRef.current = null;
      setConvertingId(null);
    }
  };

  const archive = async (row: InboxRow) => {
    setError(null);
    try {
      await inboxRepo.archive(row.id);
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  /** Named, because a ConfirmButton's `onConfirm` may not do the write itself. */
  const removeCapture = async (row: InboxRow) => {
    setError(null);
    try {
      await inboxRepo.deleteItem(row.id);
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <div className="budget-page">
      <header className="page-header">
        <div className="page-header-main">
          <div className="page-title-row">
            <span className="page-icon-badge">
              <IconInbox className="icon" />
            </span>
            <div>
              <h2 className="editor-title">{t("inbox.title")}</h2>
              <p className="page-subtitle">{t("inbox.subtitle")}</p>
            </div>
          </div>
        </div>
      </header>

      <form
        className="entry-form"
        onSubmit={(e) => {
          e.preventDefault();
          void capture();
        }}
      >
        <label>
          {t("inbox.newMemo")}
          <textarea
            className="input"
            rows={3}
            aria-label={t("inbox.newMemo")}
            placeholder={t("inbox.placeholder")}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void capture();
              }
            }}
          />
        </label>
        <div className="editor-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || text.trim().length === 0}
          >
            {saving && <IconSpinner className="icon" />}
            {saving ? t("inbox.capturing") : t("inbox.capture")}
          </button>
        </div>
      </form>

      {loading ? (
        <div className="dashboard-grid">
          {[0, 1].map((i) => (
            <Skeleton key={`inbox-${i}`} variant="card" />
          ))}
        </div>
      ) : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      {items.length === 0 && !loading ? (
        <section className="settings-section">
          <EmptyState>{t("inbox.empty")}</EmptyState>
        </section>
      ) : (
        <ul className="budget-list">
          {items.map((row) => (
            <li key={row.id} className="budget-row">
              <div className="row-main">
                <p className="row-title inbox-body">{row.body}</p>
                <span className="row-sub">
                  {t("inbox.capturedAt", {
                    date: formatDateTime(locale, row.created_at),
                  })}
                </span>
              </div>
              <span className="row-actions">
                {TARGET_BUTTONS.map(({ target, label }) => (
                  <button
                    key={target}
                    type="button"
                    className={target === "note" ? "btn btn-primary" : "btn"}
                    disabled={convertingId !== null}
                    onClick={() => void convert(row, target)}
                  >
                    {convertingId === row.id ? t("inbox.converting") : t(label)}
                  </button>
                ))}
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={convertingId !== null}
                  onClick={() => void archive(row)}
                >
                  {t("inbox.archive")}
                </button>
                <ConfirmButton
                  className="btn btn-ghost"
                  what={t("inbox.what.capture")}
                  onConfirm={() => removeCapture(row)}
                >
                  {t("common.delete")}
                </ConfirmButton>
              </span>
            </li>
          ))}
        </ul>
      )}

      <section className="settings-section">
        <div className="dash-card-head">
          <h3 className="settings-heading">{t("inbox.earlier")}</h3>
          <span className="badge">{t("inbox.earlierBadge")}</span>
        </div>
        <p className="muted">{t("inbox.earlierNote")}</p>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setShowArchived(!showArchived)}
          aria-expanded={showArchived}
        >
          {showArchived ? t("inbox.hide") : t("inbox.show")}
        </button>
        {showArchived ? (
          <ul className="budget-list">
            {archived.length === 0 && converted.length === 0 && (
              <li className="budget-row">
                <span className="muted">{t("inbox.nothingEarlier")}</span>
              </li>
            )}
            {converted.map((row) => (
              <li key={`converted-${row.id}`} className="budget-row">
                <div className="row-main">
                  <p className="row-title inbox-body">{row.body}</p>
                  <span className="row-sub">
                    {row.converted_type !== null && row.converted_id !== null
                      ? isTargetLive(live, row)
                        ? t("inbox.convertedTo", {
                            target: t(TARGET_LABELS[row.converted_type]),
                            id: row.converted_id,
                          })
                        : t("inbox.convertedGone", {
                            target: t(TARGET_LABELS[row.converted_type]),
                            id: row.converted_id,
                          })
                      : t("inbox.convertedOnly")}
                  </span>
                </div>
                <ConfirmButton
                  className="btn btn-ghost"
                  what={t("inbox.what.convertedCapture")}
                  onConfirm={() => removeCapture(row)}
                >
                  {t("common.delete")}
                </ConfirmButton>
              </li>
            ))}
            {archived.map((row) => (
              <li key={`archived-${row.id}`} className="budget-row">
                <div className="row-main">
                  <p className="row-title inbox-body">{row.body}</p>
                  <span className="row-sub">
                    {t("inbox.archivedAt", {
                      date: formatDateTime(locale, row.created_at),
                    })}
                  </span>
                </div>
                <ConfirmButton
                  className="btn btn-ghost"
                  what={t("inbox.what.archivedCapture")}
                  onConfirm={() => removeCapture(row)}
                >
                  {t("common.delete")}
                </ConfirmButton>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

/**
 * Whether a recorded target still exists.
 *
 * False means "unavailable", which is shown rather than hidden: a capture whose
 * note was deleted afterwards still happened, and the row still says what it
 * became.
 */
function isTargetLive(live: Map<string, boolean>, row: InboxRow): boolean {
  if (row.converted_type === null || row.converted_id === null) return false;
  return live.get(targetKey(row.converted_type, row.converted_id)) ?? false;
}
