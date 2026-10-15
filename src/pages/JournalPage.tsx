// P3a Journal page (§2.5): one entry per day, month grid navigation,
// markdown editor + live preview. Talks only to the journal repo (§4).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
  IconJournal,
} from "../components/icons.tsx";
import { markdownComponents } from "../components/MarkdownLink.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { journalRepo, settingsRepo } from "../data/app.ts";
import { shiftYearMonth, todayLocal, yearMonthOf } from "../lib/dates.ts";
import {
  clearJournalDraft,
  draftBaseMatches,
  loadJournalDraft,
  saveJournalDraft,
} from "../lib/drafts.ts";
import { errText } from "../lib/errors.ts";
import { buildMonthGrid, monthLabel } from "../lib/journal.ts";

const WEEKDAY_HEADS = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

export default function JournalPage() {
  const [month, setMonth] = useState(() => yearMonthOf(todayLocal()));
  const [entryDates, setEntryDates] = useState<string[]>([]);
  const [activeDate, setActiveDate] = useState(() => todayLocal());
  const [content, setContent] = useState("");
  /** The entry's stored content — `dirty` is `content !== savedContent`. */
  const [savedContent, setSavedContent] = useState("");
  /** The entry row's `updated_at` (null = no row yet): the draft base. */
  const [entryBase, setEntryBase] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Mirror of the textarea for decisions made after an awaited save —
   *  closures cannot see keystrokes typed while a save is in flight. */
  const contentRef = useRef("");
  /** Monotonic load token: a slow load for day A must never clobber day B. */
  const loadSeqRef = useRef(0);

  const refreshGrid = useCallback(async (ym: string) => {
    try {
      setEntryDates(await journalRepo.datesInMonth(ym));
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  const loadEntry = useCallback(async (date: string) => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const row = await journalRepo.getEntry(date);
      const base = row?.updated_at ?? null;
      const rowContent = row?.content ?? "";
      // Restore an unsaved draft written before the last lock/navigation,
      // but only onto the exact entry state it was written for (M-01).
      // Best-effort: a failed draft read leaves the stored entry in place.
      let draftContent: string | null = null;
      let staleDraft = false;
      try {
        const draft = await loadJournalDraft(settingsRepo, date);
        if (draft !== null) {
          if (draftBaseMatches(draft.baseUpdatedAt, base)) {
            draftContent = draft.content;
          } else {
            staleDraft = true;
          }
        }
      } catch {
        // Best-effort: the stored entry still loads without the draft.
      }
      if (seq !== loadSeqRef.current) return; // superseded by a newer load
      if (staleDraft) {
        void clearJournalDraft(settingsRepo, date).catch(() => undefined);
      }
      setEntryBase(base);
      setSavedContent(rowContent);
      contentRef.current = draftContent ?? rowContent;
      setContent(draftContent ?? rowContent);
    } catch (e) {
      if (seq === loadSeqRef.current) setError(errText(e));
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshGrid(month);
  }, [month, refreshGrid]);

  useEffect(() => {
    void loadEntry(activeDate);
  }, [activeDate, loadEntry]);

  const dirty = !loading && content !== savedContent;

  /**
   * Single keystroke path: update state and mirror a draft against the entry
   * state the editor was loaded from (M-01). Best-effort — typing never
   * waits on it; the explicit Save still reports its own errors.
   */
  function editContent(value: string): void {
    contentRef.current = value;
    setContent(value);
    const op =
      value === savedContent
        ? clearJournalDraft(settingsRepo, activeDate)
        : saveJournalDraft(settingsRepo, activeDate, {
            baseUpdatedAt: entryBase,
            savedAt: Date.now(),
            content: value,
          });
    void op.catch(() => undefined);
  }

  /** Explicit escape hatch for a restored draft: reload the stored entry. */
  function handleDiscardDraft(): void {
    contentRef.current = savedContent;
    setContent(savedContent);
    void clearJournalDraft(settingsRepo, activeDate).catch(() => undefined);
  }

  async function handleSave(): Promise<void> {
    const date = activeDate;
    const snapshot = content; // what this save persists
    setSaving(true);
    setError(null);
    try {
      await journalRepo.upsertEntry(date, snapshot);
      // upsertEntry stamped updated_at = todayLocal(); rebase every later
      // draft onto the new entry state (M-01).
      const base = todayLocal();
      setEntryBase(base);
      setSavedContent(snapshot);
      // Keystrokes typed while the save was in flight keep their draft.
      const movedOn = contentRef.current !== snapshot;
      const op = movedOn
        ? saveJournalDraft(settingsRepo, date, {
            baseUpdatedAt: base,
            savedAt: Date.now(),
            content: contentRef.current,
          })
        : clearJournalDraft(settingsRepo, date);
      await op.catch(() => undefined);
      await refreshGrid(yearMonthOf(date));
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(): Promise<void> {
    const date = activeDate;
    setError(null);
    try {
      await journalRepo.deleteEntry(date);
      // A deleted day's draft is meaningless — never let it reappear.
      await clearJournalDraft(settingsRepo, date).catch(() => undefined);
      contentRef.current = "";
      setEntryBase(null);
      setSavedContent("");
      setContent("");
      await refreshGrid(yearMonthOf(date));
    } catch (e) {
      setError(errText(e));
    }
  }

  const weeks = useMemo(
    () => buildMonthGrid(month, entryDates),
    [month, entryDates],
  );
  const label = monthLabel(month);
  const today = todayLocal();
  const entrySet = useMemo(() => new Set(entryDates), [entryDates]);
  const readableActiveDate = new Date(
    `${activeDate}T00:00:00`,
  ).toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <div className="feature-split">
      <aside className="feature-side" aria-label="Month grid">
        <div className="dash-card-head">
          <div className="dash-card-title">
            <IconCalendar className="icon" />
            <span className="side-heading">Calendar</span>
          </div>
          <span className="badge badge-accent">
            {entryDates.length} {entryDates.length === 1 ? "entry" : "entries"}
          </span>
        </div>
        <div className="month-nav">
          <button
            type="button"
            className="btn btn-icon"
            aria-label="Previous month"
            title="Previous month"
            onClick={() => setMonth((m) => shiftYearMonth(m, -1))}
          >
            <IconChevronLeft className="icon" />
          </button>
          <h2 className="side-heading month-label">{label}</h2>
          <button
            type="button"
            className="btn btn-icon"
            aria-label="Next month"
            title="Next month"
            onClick={() => setMonth((m) => shiftYearMonth(m, 1))}
          >
            <IconChevronRight className="icon" />
          </button>
        </div>
        <table className="month-grid">
          <caption className="visually-hidden">{label}</caption>
          <thead>
            <tr className="week-row week-head">
              {WEEKDAY_HEADS.map((d) => (
                <th key={d} className="day-head" scope="col">
                  {d.slice(0, 1)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => {
              const rowKey =
                week.find((cell) => cell !== null)?.date ?? week.length;
              let blanks = 0;
              return (
                <tr className="week-row" key={rowKey}>
                  {week.map((cell) => {
                    if (cell === null) {
                      blanks += 1;
                      const blankPos = blanks;
                      return (
                        <td
                          key={`${String(rowKey)}-blank-${blankPos}`}
                          className="day-cell is-blank"
                        />
                      );
                    }
                    return (
                      <td key={cell.date} className="day-td">
                        <button
                          type="button"
                          aria-label={cell.date}
                          aria-pressed={cell.date === activeDate}
                          className={[
                            "day-cell",
                            cell.date === activeDate ? "is-active" : "",
                            cell.date === today ? "is-today" : "",
                            entrySet.has(cell.date) ? "has-entry" : "",
                          ]
                            .filter((c) => c.length > 0)
                            .join(" ")}
                          onClick={() => {
                            setActiveDate(cell.date);
                            setMonth(yearMonthOf(cell.date));
                          }}
                        >
                          {Number(cell.date.slice(8, 10))}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        <button
          type="button"
          className="btn"
          onClick={() => {
            const t = todayLocal();
            setActiveDate(t);
            setMonth(yearMonthOf(t));
          }}
        >
          Today
        </button>
      </aside>

      <section className="notes-main" aria-label="Journal entry">
        <div className="notes-toolbar">
          <div className="dash-card-title">
            <IconJournal className="icon" />
            <h2 className="entry-date figure">{activeDate}</h2>
            <span className="badge">{readableActiveDate}</span>
            {entrySet.has(activeDate) ? (
              <span className="badge badge-accent">Saved</span>
            ) : null}
          </div>
          <span className="toolbar-spacer" />
          {dirty && (
            <span className="badge badge-warn" aria-live="polite">
              Unsaved draft
            </span>
          )}
          {dirty && (
            <button
              type="button"
              className="btn"
              title="Discard the unsaved draft and reload the saved entry"
              onClick={handleDiscardDraft}
            >
              Discard draft
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving}
            onClick={() => void handleSave()}
          >
            {saving ? "Saving…" : "Save entry"}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => void handleDelete()}
          >
            Delete
          </button>
        </div>

        {error !== null && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <div className="editor-split journal-split">
            <div className="editor-pane-box">
              <span className="editor-pane-label">Daily reflection</span>
              <Skeleton variant="card" />
            </div>
            <div className="editor-pane-box">
              <span className="editor-pane-label">History</span>
              <Skeleton count={4} />
            </div>
          </div>
        ) : (
          <div className="editor-split journal-split">
            <div className="editor-pane-box">
              <span className="editor-pane-label">Daily reflection</span>
              <textarea
                className="textarea editor-input"
                value={content}
                onChange={(e) => editContent(e.target.value)}
                placeholder="Write today's entry in markdown…"
                aria-label="Journal entry content (markdown)"
              />
            </div>
            <div className="editor-pane-box">
              <span className="editor-pane-label">Live preview</span>
              <div className="editor-preview markdown" aria-live="polite">
                {content.trim().length === 0 ? (
                  <p className="empty-state">Live preview appears here.</p>
                ) : (
                  <ReactMarkdown components={markdownComponents}>
                    {content}
                  </ReactMarkdown>
                )}
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
