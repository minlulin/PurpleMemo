// P3a Journal page: one entry per day, month grid navigation,
// markdown editor + live preview. Talks only to the journal repo

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import {
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
  IconJournal,
} from "../components/icons.tsx";
import {
  markdownComponents,
  markdownUrlTransform,
} from "../components/MarkdownLink.tsx";
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
import { buildMonthGrid, monthLabel, weekRowKey } from "../lib/journal.ts";
import { useDayRollover } from "../lib/useDayRollover.ts";

const WEEKDAY_HEADS = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

export default function JournalPage({
  focusDate = null,
  focusToken = 0,
}: {
  focusDate?: string | null;
  focusToken?: number;
}) {
  const [month, setMonth] = useState(() => yearMonthOf(todayLocal()));
  const [entryDates, setEntryDates] = useState<string[]>([]);
  const [activeDate, setActiveDate] = useState(() => todayLocal());
  /**
   * The day the grid's "is-today" ring marks (D9 — the C2 family): state with
   * a rollover tick, because the app leaves this page mounted across midnight
   * and nothing else re-renders it — the ring used to sit on yesterday's cell
   * until the first interaction. The Today button re-reads `todayLocal()` at
   * click time, and no write depends on this value.
   */
  const [today, setToday] = useState(() => todayLocal());
  const [content, setContent] = useState("");
  /** The entry's stored content — `dirty` is `content !== savedContent`. */
  const [savedContent, setSavedContent] = useState("");
  /** The entry row's `updated_at` (null = no row yet): the draft base. */
  const [entryBase, setEntryBase] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchMissing, setSearchMissing] = useState(false);
  /** Mirror of the textarea for decisions made after an awaited save —
   *  closures cannot see keystrokes typed while a save is in flight. */
  const contentRef = useRef("");
  /** Monotonic load token: a slow load for day A must never clobber day B. */
  const loadSeqRef = useRef(0);
  /**
   * The day the editor's text was actually loaded for (D2). `activeDate`
   * flips on the click; `content` two awaits later. A Save in that window
   * would upsert the PREVIOUS day's text into the day just clicked —
   * overwriting its entry if it had one, creating a phantom entry if not.
   */
  const loadedForRef = useRef<string | null>(null);
  /**
   * `handleSave` in-flight guard (D8): the ref is authoritative, `saving` is
   * what the button reads. A double click writes the same `(date, content)`
   * twice today — idempotent — but the convention is the invariant, and the
   * next non-idempotent addition to this handler must inherit a guard.
   */
  const savingRef = useRef(false);

  /**
   * The month the grid on screen shows (D5). Save/Delete used to refresh
   * `yearMonthOf(date)` — the month of the date they were CLICKED on — so
   * navigating while a save was in flight installed the edited date's month
   * under whatever heading was showing. Handlers read this ref AFTER their
   * awaits, so it can never be a stale render's capture.
   */
  const monthRef = useRef(month);
  /** Monotonic token for the grid read: only the newest one may install (D5). */
  const gridSeqRef = useRef(0);

  const refreshGrid = useCallback(async () => {
    const seq = ++gridSeqRef.current;
    try {
      const dates = await journalRepo.datesInMonth(monthRef.current);
      if (seq !== gridSeqRef.current) return; // superseded — newest wins
      setEntryDates(dates);
    } catch (e) {
      if (seq === gridSeqRef.current) setError(errText(e));
    }
  }, []);

  // Effects run in declaration order, so this mirror lands before the grid
  // effect below reads it on the same month change.
  useEffect(() => {
    monthRef.current = month;
  }, [month]);

  const loadEntry = useCallback(
    async (date: string) => {
      const seq = ++loadSeqRef.current;
      setLoading(true);
      setError(null);
      try {
        const row = await journalRepo.getEntry(date);
        if (focusDate === date) setSearchMissing(row === null);
        const base = row?.updated_at ?? null;
        const rowContent = row?.content ?? "";
        // Restore an unsaved draft written before the last lock/navigation,
        // but only onto the exact entry state it was written for.
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
        loadedForRef.current = date;
        contentRef.current = draftContent ?? rowContent;
        setContent(draftContent ?? rowContent);
      } catch (e) {
        if (seq === loadSeqRef.current) setError(errText(e));
      } finally {
        if (seq === loadSeqRef.current) setLoading(false);
      }
    },
    [focusDate],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `month` is the deliberate trigger — refreshGrid reads monthRef at execution time
  useEffect(() => {
    void refreshGrid();
  }, [month, refreshGrid]);

  // D9: nothing re-renders a parked page when the date rolls over — this tick
  // moves the "today" ring without hijacking the day the user is editing.
  useDayRollover((day) => setToday(day));

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusToken retriggers a jump to the same journal date
  useEffect(() => {
    if (focusDate === null) {
      setSearchMissing(false);
      return;
    }
    setActiveDate(focusDate);
    setMonth(yearMonthOf(focusDate));
  }, [focusDate, focusToken]);

  useEffect(() => {
    void loadEntry(activeDate);
  }, [activeDate, loadEntry]);

  const dirty = !loading && content !== savedContent;

  /**
   * Single keystroke path: update state and mirror a draft against the entry
   * state the editor was loaded from. Best-effort — typing never
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
    // Refused while a save is in flight (review P2-6) — the same
    // interleaving NotesPage has: `handleSave` snapshots `content`, and on
    // resume writes a draft if the CURRENT content differs from that snapshot.
    // A discard in between puts the pre-save entry text back in `contentRef`,
    // so the comparison reads as "the editor moved on" and the save
    // re-persists the discarded draft — showing the user text they had just
    // thrown away, labelled unsaved, restored again on the next visit.
    if (saving) return;
    contentRef.current = savedContent;
    setContent(savedContent);
    void clearJournalDraft(settingsRepo, activeDate).catch(() => undefined);
  }

  async function handleSave(): Promise<void> {
    if (savingRef.current) return;
    // Refuse while the day the editor was loaded for is not the day on
    // screen (D2): `activeDate` has already flipped but `content` still holds
    // the previous day's text — the window spans the whole load (two awaits)
    // plus the effect gap before it starts.
    if (loadedForRef.current !== activeDate) return;
    const date = activeDate;
    const snapshot = content; // what this save persists
    // The load generation this text belongs to: a day switch that starts
    // while the write is in flight now owns the editor.
    const seq = loadSeqRef.current;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await journalRepo.upsertEntry(date, snapshot);
      // upsertEntry stamped updated_at = todayLocal(); rebase every later
      // draft onto the new entry state.
      const base = todayLocal();
      if (seq === loadSeqRef.current) {
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
      }
      // The month ON SCREEN, read now — not the saved date's month (D5).
      await refreshGrid();
    } catch (e) {
      setError(errText(e));
    } finally {
      savingRef.current = false;
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
      // The month ON SCREEN, read now — not the deleted date's month (D5).
      await refreshGrid();
    } catch (e) {
      setError(errText(e));
    }
  }

  const weeks = useMemo(
    () => buildMonthGrid(month, entryDates),
    [month, entryDates],
  );
  const label = monthLabel(month);
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
              const rowKey = weekRowKey(week);
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
        {searchMissing && focusDate === activeDate ? (
          <p className="alert alert-error" role="status">
            That journal entry no longer exists — it may have been deleted.
          </p>
        ) : null}
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
              disabled={saving}
              onClick={handleDiscardDraft}
            >
              Discard draft
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || loading}
            onClick={() => void handleSave()}
          >
            {saving ? "Saving…" : "Save entry"}
          </button>
          <ConfirmButton
            className="btn btn-danger"
            what="journal entry to Trash"
            onConfirm={() => handleDelete()}
          >
            Move to Trash
          </ConfirmButton>
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
                  <ReactMarkdown
                    components={markdownComponents}
                    urlTransform={markdownUrlTransform}
                  >
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
