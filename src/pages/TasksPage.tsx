// P3d Tasks & reminders page (§2.7): due dates, repeats (daily/weekly/
// monthly), local notifications via the Tauri notification plugin.
// Completing a repeating task rolls its due date to the next future
// occurrence (nextDueDate) instead of closing it.

import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "../components/EmptyState.tsx";
import { IconCalendar, IconTasks } from "../components/icons.tsx";
import { tasksRepo } from "../data/app.ts";
import { todayLocal } from "../lib/dates.ts";
import { errText } from "../lib/errors.ts";
import { nextDueDate } from "../lib/tasks.ts";
import type { ReminderRow, TaskRow } from "../lib/types.ts";

type Repeat = TaskRow["repeat"];

const REPEAT_OPTIONS: { value: Repeat; label: string }[] = [
  { value: "none", label: "No repeat" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

function overdue(dueDate: string | null, today: string): boolean {
  return dueDate !== null && dueDate < today;
}

export default function TasksPage({
  notifyNote,
}: {
  notifyNote: string | null;
}) {
  const today = todayLocal();
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [showDone, setShowDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [repeat, setRepeat] = useState<Repeat>("none");
  const [note, setNote] = useState("");

  const reload = useCallback(async () => {
    try {
      setTasks(await tasksRepo.listTasks(showDone));
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [showDone]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const addTask = async () => {
    const trimmed = title.trim();
    if (trimmed.length === 0) return;
    try {
      await tasksRepo.createTask({
        title: trimmed,
        dueDate: dueDate === "" ? null : dueDate,
        repeat,
        note: note.trim(),
      });
      setTitle("");
      setDueDate("");
      setNote("");
      setRepeat("none");
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  const complete = async (t: TaskRow) => {
    try {
      const rolled = nextDueDate(t.due_date, t.repeat, today);
      if (rolled !== null) {
        await tasksRepo.updateTask(t.id, { dueDate: rolled });
      } else {
        await tasksRepo.toggleTask(t.id, true);
      }
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  const reopen = async (t: TaskRow) => {
    try {
      await tasksRepo.toggleTask(t.id, false);
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  const remove = async (id: number) => {
    try {
      await tasksRepo.deleteTask(id);
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  const open = tasks.filter((t) => t.done === 0);
  const done = tasks.filter((t) => t.done === 1);

  return (
    <div className="budget-page">
      <header className="page-header">
        <div className="page-header-main">
          <div className="page-title-row">
            <span className="page-icon-badge">
              <IconTasks className="icon" />
            </span>
            <div>
              <h2 className="editor-title">Tasks &amp; Reminders</h2>
              <p className="page-subtitle">
                Actionable to-dos, repeating schedules &amp; local desktop
                notifications
              </p>
            </div>
          </div>
        </div>
      </header>

      {loading ? <p className="muted">Loading…</p> : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}
      {notifyNote ? (
        <p className="alert alert-note" role="status">
          {notifyNote}
        </p>
      ) : null}

      <div className="split-workspace-grid">
        <section className="settings-section" aria-label="Open tasks">
          <div className="dash-card-head">
            <h2 className="side-heading">Open tasks</h2>
            <label className="check-label">
              <input
                type="checkbox"
                checked={showDone}
                onChange={(e) => setShowDone(e.target.checked)}
              />{" "}
              Show done
            </label>
          </div>

          {open.length === 0 ? (
            <EmptyState>Nothing due — enjoy it.</EmptyState>
          ) : (
            <ul className="budget-list">
              {open.map((t) => (
                <li key={t.id} className="budget-row">
                  <div className="row-main">
                    <span className="row-title">
                      <b>{t.title}</b>
                      {overdue(t.due_date, today) ? (
                        <span className="badge badge-danger" role="status">
                          Overdue
                        </span>
                      ) : null}
                      {t.due_date ? (
                        <span className="chip figure">due {t.due_date}</span>
                      ) : null}
                      {t.repeat !== "none" ? (
                        <span className="badge badge-accent">{t.repeat}</span>
                      ) : null}
                    </span>
                    {t.note ? <span className="row-sub">{t.note}</span> : null}
                  </div>
                  <span className="row-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => void complete(t)}
                    >
                      Done
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => void remove(t.id)}
                    >
                      Delete
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {done.length > 0 ? (
            <div className="contact-section">
              <h3 className="side-heading">Completed</h3>
              <ul className="budget-list">
                {done.map((t) => (
                  <li key={t.id} className="budget-row">
                    <span className="muted">{t.title}</span>
                    <span className="row-actions">
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => void reopen(t)}
                      >
                        Reopen
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        <form
          className="entry-form"
          onSubmit={(e) => {
            e.preventDefault();
            void addTask();
          }}
        >
          <h2 className="side-heading">New task</h2>
          <label>
            Title
            <input
              value={title}
              placeholder="e.g. Pay electricity bill"
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <div className="form-grid">
            <label>
              Due date (optional)
              <span className="input-icon-wrap">
                <input
                  type="date"
                  aria-label="Due date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
                <IconCalendar className="icon input-icon is-end" />
              </span>
            </label>
            <label>
              Repeat
              <select
                aria-label="Repeat"
                value={repeat}
                onChange={(e) => setRepeat(e.target.value as Repeat)}
              >
                {REPEAT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Note (optional)
            <input
              value={note}
              placeholder="Details or context"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <div className="row-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={title.trim().length === 0}
            >
              Add task
            </button>
          </div>
        </form>
      </div>

      <RemindersSection />
    </div>
  );
}

function RemindersSection() {
  const [reminders, setReminders] = useState<ReminderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [remindAt, setRemindAt] = useState("");
  const [repeat, setRepeat] = useState<"none" | "daily" | "weekly" | "monthly">(
    "none",
  );

  const reload = useCallback(async () => {
    try {
      setReminders(await tasksRepo.listReminders(false));
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = async () => {
    const trimmed = title.trim();
    if (trimmed.length === 0 || remindAt === "") return;
    try {
      await tasksRepo.createReminder({ title: trimmed, remindAt, repeat });
      setTitle("");
      setRemindAt("");
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  const remove = async (id: number) => {
    try {
      await tasksRepo.deleteReminder(id);
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <section className="settings-section" aria-label="Reminders">
      <div className="dash-card-head">
        <h2 className="side-heading">Scheduled Reminders</h2>
        <span className="badge">{reminders.length}</span>
      </div>
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      {reminders.length === 0 ? (
        <p className="muted">No scheduled reminders.</p>
      ) : (
        <ul className="budget-list">
          {reminders.map((r) => (
            <li key={r.id} className="budget-row">
              <div className="row-main">
                <span className="row-title">
                  <b>{r.title}</b>
                  <span className="chip figure">
                    {r.remind_at.replace("T", " ")}
                  </span>
                  {r.repeat !== "none" ? (
                    <span className="badge badge-accent">{r.repeat}</span>
                  ) : null}
                </span>
              </div>
              <span className="row-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void remove(r.id)}
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input
          aria-label="Reminder title"
          placeholder="Reminder title (e.g. Call supplier)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <input
          type="datetime-local"
          aria-label="Remind at"
          value={remindAt}
          onChange={(e) => setRemindAt(e.target.value)}
        />
        <select
          className="select"
          aria-label="Reminder repeat"
          value={repeat}
          onChange={(e) =>
            setRepeat(e.target.value as "none" | "daily" | "weekly" | "monthly")
          }
        >
          <option value="none">No repeat</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
        </select>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={title.trim().length === 0 || remindAt === ""}
        >
          Add reminder
        </button>
      </form>
    </section>
  );
}
