// P3e Memories page: date-based entries with Upcoming (14 days),
// On-this-day, month feed and an all-list CRUD view. Contact birthdays
// surface here: upcoming birthdays join the Upcoming view, today's
// birthdays join On-this-day. Talks only to the memories + contacts repos.

import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import {
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
  IconMemories,
} from "../components/icons.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { contactsRepo, memoriesRepo } from "../data/app.ts";
import { birthdayLabel } from "../lib/contacts.ts";
import { shiftYearMonth, todayLocal, yearMonthOf } from "../lib/dates.ts";
import { errText } from "../lib/errors.ts";
import { monthLabel } from "../lib/journal.ts";
import type { ContactRow, MemoryRow } from "../lib/types.ts";

type MemoryView = "upcoming" | "onthisday" | "month" | "all";

const VIEWS: { key: MemoryView; label: string }[] = [
  { key: "upcoming", label: "Upcoming" },
  { key: "onthisday", label: "On this day" },
  { key: "month", label: "Month" },
  { key: "all", label: "All" },
];

interface MemoryFormProps {
  title: string;
  date: string;
  note: string;
  editing: boolean;
  /** The parent's in-flight flag: the submit button greys out with it (P3-6). */
  saving: boolean;
  onTitle: (v: string) => void;
  onDate: (v: string) => void;
  onNote: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

function MemoryForm(p: MemoryFormProps) {
  return (
    <form
      className="entry-form"
      onSubmit={(e) => {
        e.preventDefault();
        p.onSubmit();
      }}
    >
      <h3 className="side-heading">
        {p.editing ? "Edit memory" : "New memory"}
      </h3>
      <div className="form-grid">
        <label>
          Title
          <input
            className="input"
            value={p.title}
            placeholder="What happened?"
            onChange={(e) => p.onTitle(e.target.value)}
          />
        </label>
        <label>
          Date
          <span className="input-icon-wrap">
            <input
              className="input"
              type="date"
              value={p.date}
              onChange={(e) => p.onDate(e.target.value)}
            />
            <IconCalendar className="icon input-icon is-end" />
          </span>
        </label>
      </div>
      <label>
        Note
        <textarea
          className="textarea"
          rows={3}
          placeholder="Optional reflection or story…"
          value={p.note}
          onChange={(e) => p.onNote(e.target.value)}
        />
      </label>
      <div className="editor-actions">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={
            p.saving || p.title.trim().length === 0 || p.date.length === 0
          }
        >
          {p.editing ? "Save changes" : "Add memory"}
        </button>
        {p.editing ? (
          <button type="button" className="btn" onClick={p.onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

interface MemoryListProps {
  items: MemoryRow[];
  editingId: number | null;
  focusId: number | null;
  onEdit: (m: MemoryRow) => void;
  onDelete: (m: MemoryRow) => void;
}

function MemoryList(p: MemoryListProps) {
  if (p.items.length === 0) return <EmptyState>Nothing here.</EmptyState>;
  return (
    <ul className="budget-list">
      {p.items.map((m) => (
        <li
          key={m.id}
          id={p.focusId === m.id ? `search-target-memory-${m.id}` : undefined}
          className={
            p.focusId === m.id ? "budget-row is-search-target" : "budget-row"
          }
        >
          <div className="row-main">
            <span className="row-title">
              <span className="chip figure">{m.memory_date}</span>
              <b>{m.title}</b>
            </span>
            {m.note ? <span className="row-sub">{m.note}</span> : null}
          </div>
          <span className="row-actions">
            <button
              type="button"
              className={p.editingId === m.id ? "btn is-on" : "btn btn-ghost"}
              onClick={() => p.onEdit(m)}
            >
              Edit
            </button>
            <ConfirmButton
              className="btn btn-ghost"
              what="memory to Trash"
              onConfirm={() => p.onDelete(m)}
            >
              Move to Trash
            </ConfirmButton>
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function MemoriesPage({
  focusId = null,
  focusToken = 0,
}: {
  focusId?: number | null;
  focusToken?: number;
}) {
  const [view, setView] = useState<MemoryView>("upcoming");
  const [upcoming, setUpcoming] = useState<MemoryRow[]>([]);
  const [onThisDay, setOnThisDay] = useState<MemoryRow[]>([]);
  const [all, setAll] = useState<MemoryRow[]>([]);
  /** Mirror of `all` for effects that must not list it as a dependency (C4). */
  const allRef = useRef<MemoryRow[]>([]);
  const [month, setMonth] = useState<MemoryRow[]>([]);
  const [upcomingBirthdays, setUpcomingBirthdays] = useState<ContactRow[]>([]);
  const [todaysBirthdays, setTodaysBirthdays] = useState<ContactRow[]>([]);
  const [feedMonth, setFeedMonth] = useState(() => yearMonthOf(todayLocal()));
  /**
   * The month the feed shows, read by create/delete AFTER their awaits (C3):
   * both used to close over the `feedMonth` of the render they were clicked in,
   * so flipping months while one was in flight installed the old month's
   * entries under the new month's heading. The month is only ever changed
   * through `showMonth`, so the ref and the state cannot disagree.
   */
  const feedMonthRef = useRef(feedMonth);
  /** Sequence token for the month feed: only the newest load installs (C3). */
  const monthSeqRef = useRef(0);
  /**
   * `submitForm` submit guard (review P3-6): the ref is authoritative, the
   * state is what the form's button reads — the pinned money-form shape.
   */
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    editingId: null as number | null,
    title: "",
    date: todayLocal(),
    note: "",
  });

  /**
   * The day the date-derived reads belong to (C2). `reload` calls
   * `todayLocal()` itself instead of taking the render's value: the page is
   * deliberately left mounted, so a render-captured date went stale at
   * midnight and only ever healed if something happened to re-render it.
   */
  const todayRef = useRef(todayLocal());

  const reload = useCallback(async () => {
    const today = todayLocal();
    todayRef.current = today;
    try {
      const [up, otd, everything, bdays, bdaysToday] = await Promise.all([
        memoriesRepo.upcoming(today),
        memoriesRepo.onThisDay(today),
        memoriesRepo.listMemories(),
        contactsRepo.upcomingBirthdays(14, today),
        contactsRepo.birthdaysOn(today),
      ]);
      setUpcoming(up);
      setOnThisDay(otd);
      setAll(everything);
      setUpcomingBirthdays(bdays);
      setTodaysBirthdays(bdaysToday);
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // "Birthdays today", "Next 14 days" and on-this-day are all keyed on the
  // date, and nothing re-renders a parked page when the date rolls over (C2):
  // this tick reloads the moment the local day changes, instead of showing
  // yesterday's lists until the user happens to tap something.
  useEffect(() => {
    const timer = setInterval(() => {
      if (todayLocal() !== todayRef.current) void reload();
    }, 60_000);
    return () => clearInterval(timer);
  }, [reload]);

  // The current list for the focus effect's existence check, kept up to date
  // so that effect can be keyed on the arrival signals alone (C4).
  useEffect(() => {
    allRef.current = all;
  }, [all]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusToken retriggers a jump to the same memory; `all` is deliberately NOT a dependency — with it here, every reload re-ran this and snapped the user back to "all" after each action (C4)
  useEffect(() => {
    if (focusId === null || loading) return;
    setView("all");
    if (!allRef.current.some((memory) => memory.id === focusId)) {
      setError("That memory no longer exists — it may have been deleted.");
    } else setError(null);
  }, [focusId, focusToken, loading]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusToken retriggers scrolling to the same memory
  useEffect(() => {
    if (focusId === null || view !== "all") return;
    document
      .getElementById(`search-target-memory-${focusId}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [focusId, focusToken, view]);

  /**
   * Load one month's feed through the sequence token (C3): a create/delete's
   * load and a month-navigation load can be in flight together, and without a
   * token the older one resolves last and writes its rows under whatever
   * heading is on screen then.
   */
  const loadMonth = useCallback(async (month: string) => {
    const seq = ++monthSeqRef.current;
    try {
      const feed = await memoriesRepo.monthFeed(month);
      if (seq === monthSeqRef.current) setMonth(feed);
    } catch (e) {
      if (seq === monthSeqRef.current) setError(errText(e));
    }
  }, []);

  /** The only writer of `feedMonth`, so `feedMonthRef` tracks it exactly. */
  const showMonth = (month: string) => {
    feedMonthRef.current = month;
    setFeedMonth(month);
  };

  useEffect(() => {
    void loadMonth(feedMonth);
  }, [feedMonth, loadMonth]);

  const submitForm = async () => {
    if (savingRef.current) return;
    const title = form.title.trim();
    if (title.length === 0 || form.date.length === 0) return;
    savingRef.current = true;
    setSaving(true);
    try {
      if (form.editingId !== null) {
        await memoriesRepo.updateMemory(form.editingId, {
          title,
          memoryDate: form.date,
          note: form.note,
        });
      } else {
        await memoriesRepo.createMemory({
          title,
          memoryDate: form.date,
          note: form.note,
        });
      }
      setForm({ editingId: null, title: "", date: todayLocal(), note: "" });
      await reload();
      await loadMonth(feedMonthRef.current);
    } catch (e) {
      setError(errText(e));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const startEdit = (m: MemoryRow) => {
    setForm({
      editingId: m.id,
      title: m.title,
      date: m.memory_date,
      note: m.note,
    });
  };

  const cancelEdit = () => {
    setForm({ editingId: null, title: "", date: todayLocal(), note: "" });
  };

  const remove = async (m: MemoryRow) => {
    try {
      await memoriesRepo.deleteMemory(m.id);
      if (form.editingId === m.id) cancelEdit();
      await reload();
      await loadMonth(feedMonthRef.current);
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
              <IconMemories className="icon" />
            </span>
            <div>
              <h2 className="editor-title">Memories &amp; Milestones</h2>
              <p className="page-subtitle">
                Important dates, anniversaries, on-this-day flashbacks &amp;
                contact birthdays
              </p>
            </div>
          </div>
        </div>
        <nav className="budget-viewnav" aria-label="Memory views">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              className={view === v.key ? "nav-tab is-active" : "nav-tab"}
              aria-current={view === v.key ? "page" : undefined}
              onClick={() => setView(v.key)}
            >
              {v.label}
            </button>
          ))}
        </nav>
      </header>

      {loading ? <Skeleton count={3} /> : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="split-workspace-grid">
        <div>
          {view === "upcoming" ? (
            <div className="budget-manage">
              <div className="dash-card-head">
                <h3 className="side-heading">Next 14 days</h3>
                <span className="badge">{upcoming.length}</span>
              </div>
              <MemoryList
                items={upcoming}
                editingId={form.editingId}
                focusId={null}
                onEdit={startEdit}
                onDelete={(m) => void remove(m)}
              />
              <div className="contact-section">
                <div className="dash-card-head">
                  <h3 className="side-heading">
                    Birthdays in the next 14 days
                  </h3>
                  <span className="badge badge-accent">
                    {upcomingBirthdays.length}
                  </span>
                </div>
                {upcomingBirthdays.length === 0 ? (
                  <p className="muted">No upcoming birthdays.</p>
                ) : (
                  <ul className="budget-list">
                    {upcomingBirthdays.map((c) => (
                      <li key={c.id} className="budget-row">
                        <span>
                          <b>{c.name}</b>
                        </span>
                        <span className="badge badge-accent">
                          {c.birthday ? birthdayLabel(c.birthday) : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : view === "onthisday" ? (
            <div className="budget-manage">
              <div className="dash-card-head">
                <h3 className="side-heading">On this day (any year)</h3>
                <span className="badge">{onThisDay.length}</span>
              </div>
              <MemoryList
                items={onThisDay}
                editingId={form.editingId}
                focusId={null}
                onEdit={startEdit}
                onDelete={(m) => void remove(m)}
              />
              <div className="contact-section">
                <div className="dash-card-head">
                  <h3 className="side-heading">Birthdays today</h3>
                  <span className="badge badge-accent">
                    {todaysBirthdays.length}
                  </span>
                </div>
                {todaysBirthdays.length === 0 ? (
                  <p className="muted">No birthdays today.</p>
                ) : (
                  <ul className="budget-list">
                    {todaysBirthdays.map((c) => (
                      <li key={c.id} className="budget-row">
                        <span>
                          <b>{c.name}</b>
                        </span>
                        <span className="badge badge-accent">
                          {c.birthday ? birthdayLabel(c.birthday) : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : view === "month" ? (
            <div className="budget-manage">
              <div className="month-nav">
                <button
                  type="button"
                  className="btn btn-icon"
                  aria-label="Previous month"
                  title="Previous month"
                  onClick={() => showMonth(shiftYearMonth(feedMonth, -1))}
                >
                  <IconChevronLeft className="icon" />
                </button>
                <h3 className="side-heading month-label">
                  {monthLabel(feedMonth)}
                </h3>
                <button
                  type="button"
                  className="btn btn-icon"
                  aria-label="Next month"
                  title="Next month"
                  onClick={() => showMonth(shiftYearMonth(feedMonth, 1))}
                >
                  <IconChevronRight className="icon" />
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => showMonth(yearMonthOf(todayLocal()))}
                >
                  This month
                </button>
              </div>
              <MemoryList
                items={month}
                editingId={form.editingId}
                focusId={null}
                onEdit={startEdit}
                onDelete={(m) => void remove(m)}
              />
            </div>
          ) : (
            <div className="budget-manage">
              <div className="dash-card-head">
                <h3 className="side-heading">All memories</h3>
                <span className="badge">{all.length}</span>
              </div>
              <MemoryList
                items={all}
                editingId={form.editingId}
                focusId={focusId}
                onEdit={startEdit}
                onDelete={(m) => void remove(m)}
              />
            </div>
          )}
        </div>

        <MemoryForm
          title={form.title}
          date={form.date}
          note={form.note}
          editing={form.editingId !== null}
          saving={saving}
          onTitle={(title) => setForm({ ...form, title })}
          onDate={(date) => setForm({ ...form, date })}
          onNote={(note) => setForm({ ...form, note })}
          onSubmit={() => void submitForm()}
          onCancel={cancelEdit}
        />
      </div>
    </div>
  );
}
