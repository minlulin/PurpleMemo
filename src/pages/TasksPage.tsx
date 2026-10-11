// P3d Tasks & reminders page (§2.7): due dates, repeats (daily/weekly/
// monthly), local notifications via the Tauri notification plugin.
// Completing a repeating task rolls its due date to the next future
// occurrence (nextDueDate) instead of closing it.

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { useCallback, useEffect, useState } from "react";
import { tasksRepo } from "../data/app.ts";
import { todayLocal } from "../lib/dates.ts";
import { nextDueDate } from "../lib/tasks.ts";
import type { ReminderRow, TaskRow } from "../lib/types.ts";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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

/** Ask once for notification permission; false when denied (§2.7). */
async function ensureNotifyPermission(): Promise<boolean> {
  try {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  } catch {
    return false;
  }
}

export default function TasksPage() {
  const today = todayLocal();
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [showDone, setShowDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notifyNote, setNotifyNote] = useState<string | null>(null);

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

  // Reminder notification loop (§2.7): poll for due reminders, fire a local
  // notification, mark fired. Repeating reminders re-arm instead.
  useEffect(() => {
    let cancelled = false;
    let requested = false;
    const tick = async () => {
      try {
        const due = await tasksRepo.dueReminders(
          new Date().toISOString().slice(0, 16),
        );
        if (due.length === 0 || cancelled) return;
        if (!requested) {
          requested = true;
          const granted = await ensureNotifyPermission();
          if (!granted) {
            setNotifyNote(
              "Notifications are blocked — due reminders stay listed here.",
            );
            return;
          }
        }
        for (const r of due) {
          sendNotification({ title: `Reminder: ${r.title}`, body: r.note });
          if (r.repeat === "none") {
            await tasksRepo.markReminderFired(r.id);
          } else {
            // Repeating reminders: re-arm by moving remind_at one period.
            await tasksRepo.deleteReminder(r.id);
            await tasksRepo.createReminder({
              title: r.title,
              remindAt: rollReminderTime(r.remind_at, r.repeat),
              repeat: r.repeat,
              note: r.note,
            });
          }
        }
      } catch {
        // The notification loop must never break the page (§2.7 wiring
        // is best-effort; the reminders list itself is the source of truth).
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

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
        // Repeating: keep it open on its next occurrence.
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
      {loading ? <p className="muted">Loading…</p> : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}
      {notifyNote ? (
        <p className="limit-warn" role="status">
          {notifyNote}
        </p>
      ) : null}

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
        <label>
          Due date (optional)
          <input
            type="date"
            aria-label="Due date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
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
        <label>
          Note (optional)
          <input value={note} onChange={(e) => setNote(e.target.value)} />
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

      <section aria-label="Open tasks">
        <h2 className="side-heading">Open</h2>
        {open.length === 0 ? (
          <p className="muted">Nothing due — enjoy it.</p>
        ) : (
          <ul className="budget-list">
            {open.map((t) => (
              <li key={t.id} className="budget-row">
                <span>
                  {t.title}
                  {overdue(t.due_date, today) ? (
                    <span className="limit-exceeded" role="status">
                      {" "}
                      (overdue)
                    </span>
                  ) : null}
                  {t.due_date ? (
                    <span className="muted"> · due {t.due_date}</span>
                  ) : null}
                  {t.repeat !== "none" ? (
                    <span className="muted"> · {t.repeat}</span>
                  ) : null}
                  {t.note ? <span className="muted"> — {t.note}</span> : null}
                </span>
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
      </section>

      <label className="muted">
        <input
          type="checkbox"
          checked={showDone}
          onChange={(e) => setShowDone(e.target.checked)}
        />{" "}
        Show done
      </label>

      {done.length > 0 ? (
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
      ) : null}

      <RemindersSection />
    </div>
  );
}

/** Roll a repeating reminder's time forward one period (best-effort). */
function rollReminderTime(
  remindAt: string,
  repeat: "daily" | "weekly" | "monthly",
): string {
  const d = new Date(remindAt);
  if (Number.isNaN(d.getTime())) return remindAt;
  if (repeat === "daily") d.setDate(d.getDate() + 1);
  else if (repeat === "weekly") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
    <section aria-label="Reminders">
      <h2 className="side-heading">Reminders</h2>
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      {reminders.length === 0 ? (
        <p className="muted">No reminders.</p>
      ) : (
        <ul className="budget-list">
          {reminders.map((r) => (
            <li key={r.id} className="budget-row">
              <span>
                {r.title}
                <span className="muted">
                  {" "}
                  · {r.remind_at.replace("T", " ")}
                </span>
                {r.repeat !== "none" ? (
                  <span className="muted"> · {r.repeat}</span>
                ) : null}
              </span>
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
          placeholder="e.g. Meeting"
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
