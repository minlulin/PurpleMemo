// P3a Journal page (§2.5): one entry per day, month grid navigation,
// markdown editor + live preview. Talks only to the journal repo (§4).

import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { journalRepo } from "../data/app.ts";
import { shiftYearMonth, todayLocal, yearMonthOf } from "../lib/dates.ts";
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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshGrid = useCallback(async (ym: string) => {
    try {
      setEntryDates(await journalRepo.datesInMonth(ym));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadEntry = useCallback(async (date: string) => {
    setLoading(true);
    setError(null);
    try {
      const row = await journalRepo.getEntry(date);
      setContent(row?.content ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshGrid(month);
  }, [month, refreshGrid]);

  useEffect(() => {
    void loadEntry(activeDate);
  }, [activeDate, loadEntry]);

  async function handleSave(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await journalRepo.upsertEntry(activeDate, content);
      await refreshGrid(yearMonthOf(activeDate));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(): Promise<void> {
    setError(null);
    try {
      await journalRepo.deleteEntry(activeDate);
      setContent("");
      await refreshGrid(yearMonthOf(activeDate));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const weeks = useMemo(
    () => buildMonthGrid(month, entryDates),
    [month, entryDates],
  );
  const label = monthLabel(month);
  const today = todayLocal();
  const entrySet = useMemo(() => new Set(entryDates), [entryDates]);

  return (
    <div className="feature-split">
      <aside className="feature-side" aria-label="Month grid">
        <div className="month-nav">
          <button
            type="button"
            className="btn"
            aria-label="Previous month"
            onClick={() => setMonth((m) => shiftYearMonth(m, -1))}
          >
            ‹
          </button>
          <h2 className="side-heading month-label">{label}</h2>
          <button
            type="button"
            className="btn"
            aria-label="Next month"
            onClick={() => setMonth((m) => shiftYearMonth(m, 1))}
          >
            ›
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
          <h2 className="entry-date figure">{activeDate}</h2>
          <span className="toolbar-spacer" />
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
          <p className="empty-state">Loading entry…</p>
        ) : (
          <div className="editor-split journal-split">
            <textarea
              className="textarea editor-input"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Write today's entry in markdown…"
              aria-label="Journal entry content (markdown)"
            />
            <div className="editor-preview markdown" aria-live="polite">
              {content.trim().length === 0 ? (
                <p className="empty-state">Live preview appears here.</p>
              ) : (
                <ReactMarkdown>{content}</ReactMarkdown>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
