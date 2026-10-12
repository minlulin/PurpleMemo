// P3e Memories page (§2.7): date-based entries with Upcoming (14 days),
// On-this-day, month feed and an all-list CRUD view. Contact birthdays
// surface here (§2.7): upcoming birthdays join the Upcoming view, today's
// birthdays join On-this-day. Talks only to the memories + contacts repos.

import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "../components/EmptyState.tsx";
import { contactsRepo, memoriesRepo } from "../data/app.ts";
import { birthdayLabel } from "../lib/contacts.ts";
import { todayLocal, yearMonthOf } from "../lib/dates.ts";
import { monthLabel } from "../lib/journal.ts";
import { shiftYearMonth } from "../lib/memories.ts";
import type { ContactRow, MemoryRow } from "../lib/types.ts";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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
        <input
          className="input"
          type="date"
          value={p.date}
          onChange={(e) => p.onDate(e.target.value)}
        />
      </label>
      <label>
        Note
        <textarea
          className="textarea"
          rows={3}
          value={p.note}
          onChange={(e) => p.onNote(e.target.value)}
        />
      </label>
      <div className="editor-actions">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={p.title.trim().length === 0 || p.date.length === 0}
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
  onEdit: (m: MemoryRow) => void;
  onDelete: (m: MemoryRow) => void;
}

function MemoryList(p: MemoryListProps) {
  if (p.items.length === 0) return <EmptyState>Nothing here.</EmptyState>;
  return (
    <ul className="budget-list">
      {p.items.map((m) => (
        <li key={m.id} className="budget-row">
          <span>
            <span className="chip">{m.memory_date}</span> <b>{m.title}</b>
            {m.note ? <span className="muted"> — {m.note}</span> : null}
          </span>
          <span className="row-actions">
            <button
              type="button"
              className={p.editingId === m.id ? "btn is-on" : "btn btn-ghost"}
              onClick={() => p.onEdit(m)}
            >
              Edit
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => p.onDelete(m)}
            >
              Delete
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function MemoriesPage() {
  const today = todayLocal();
  const [view, setView] = useState<MemoryView>("upcoming");
  const [upcoming, setUpcoming] = useState<MemoryRow[]>([]);
  const [onThisDay, setOnThisDay] = useState<MemoryRow[]>([]);
  const [all, setAll] = useState<MemoryRow[]>([]);
  const [month, setMonth] = useState<MemoryRow[]>([]);
  const [upcomingBirthdays, setUpcomingBirthdays] = useState<ContactRow[]>([]);
  const [todaysBirthdays, setTodaysBirthdays] = useState<ContactRow[]>([]);
  const [feedMonth, setFeedMonth] = useState(() => yearMonthOf(todayLocal()));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    editingId: null as number | null,
    title: "",
    date: todayLocal(),
    note: "",
  });

  const reload = useCallback(async () => {
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
  }, [today]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const feed = await memoriesRepo.monthFeed(feedMonth);
        if (!cancelled) setMonth(feed);
      } catch (e) {
        if (!cancelled) setError(errText(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [feedMonth]);

  const submitForm = async () => {
    const title = form.title.trim();
    if (title.length === 0 || form.date.length === 0) return;
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
      const feed = await memoriesRepo.monthFeed(feedMonth);
      setMonth(feed);
    } catch (e) {
      setError(errText(e));
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
      const feed = await memoriesRepo.monthFeed(feedMonth);
      setMonth(feed);
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <div className="budget-page">
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

      {loading ? <p className="muted">Loading…</p> : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      <MemoryForm
        title={form.title}
        date={form.date}
        note={form.note}
        editing={form.editingId !== null}
        onTitle={(title) => setForm({ ...form, title })}
        onDate={(date) => setForm({ ...form, date })}
        onNote={(note) => setForm({ ...form, note })}
        onSubmit={() => void submitForm()}
        onCancel={cancelEdit}
      />

      {view === "upcoming" ? (
        <>
          <h3 className="side-heading">Next 14 days</h3>
          <MemoryList
            items={upcoming}
            editingId={form.editingId}
            onEdit={startEdit}
            onDelete={(m) => void remove(m)}
          />
          <h3 className="side-heading">Birthdays in the next 14 days</h3>
          {upcomingBirthdays.length === 0 ? (
            <p className="muted">No upcoming birthdays.</p>
          ) : (
            <ul className="budget-list">
              {upcomingBirthdays.map((c) => (
                <li key={c.id} className="budget-row">
                  <span>{c.name}</span>
                  <span className="muted">
                    {c.birthday ? birthdayLabel(c.birthday) : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : view === "onthisday" ? (
        <>
          <h3 className="side-heading">On this day (any year)</h3>
          <MemoryList
            items={onThisDay}
            editingId={form.editingId}
            onEdit={startEdit}
            onDelete={(m) => void remove(m)}
          />
          <h3 className="side-heading">Birthdays today</h3>
          {todaysBirthdays.length === 0 ? (
            <p className="muted">No birthdays today.</p>
          ) : (
            <ul className="budget-list">
              {todaysBirthdays.map((c) => (
                <li key={c.id} className="budget-row">
                  <span>{c.name}</span>
                  <span className="muted">
                    {c.birthday ? birthdayLabel(c.birthday) : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : view === "month" ? (
        <>
          <div className="month-nav">
            <button
              type="button"
              className="btn btn-ghost"
              aria-label="Previous month"
              onClick={() => setFeedMonth(shiftYearMonth(feedMonth, -1))}
            >
              ‹
            </button>
            <h3 className="month-label">{monthLabel(feedMonth)}</h3>
            <button
              type="button"
              className="btn btn-ghost"
              aria-label="Next month"
              onClick={() => setFeedMonth(shiftYearMonth(feedMonth, 1))}
            >
              ›
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setFeedMonth(yearMonthOf(today))}
            >
              This month
            </button>
          </div>
          <MemoryList
            items={month}
            editingId={form.editingId}
            onEdit={startEdit}
            onDelete={(m) => void remove(m)}
          />
        </>
      ) : (
        <MemoryList
          items={all}
          editingId={form.editingId}
          onEdit={startEdit}
          onDelete={(m) => void remove(m)}
        />
      )}
    </div>
  );
}
