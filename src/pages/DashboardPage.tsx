// P3f Dashboard page (§2.8): today at a glance — due tasks/reminders,
// today's money in-out, habit week progress, upcoming memories/birthdays,
// expiring warranties, total receivable. Every card links to its feature.

import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "../components/EmptyState.tsx";
import {
  budgetRepo,
  businessRepo,
  contactsRepo,
  habitsRepo,
  memoriesRepo,
  tasksRepo,
} from "../data/app.ts";
import { dayMoneyTotals, expiringWarranties } from "../lib/dashboard.ts";
import { localISODateTime, todayLocal } from "../lib/dates.ts";
import { errText } from "../lib/errors.ts";
import { formatMMK } from "../lib/money.ts";
import type { PageKey } from "../lib/navigation.ts";
import type {
  ContactRow,
  HabitRow,
  JobRow,
  MemoryRow,
  ReminderRow,
  TaskRow,
} from "../lib/types.ts";

interface DashboardPageProps {
  notifyNote: string | null;
  onNavigate: (key: PageKey) => void;
}

interface HabitWeek {
  name: string;
  week: { date: string; done: boolean }[];
}

export default function DashboardPage(p: DashboardPageProps) {
  const today = todayLocal();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dueTasks, setDueTasks] = useState<TaskRow[]>([]);
  const [reminders, setReminders] = useState<ReminderRow[]>([]);
  const [money, setMoney] = useState({ incomeCents: 0, expenseCents: 0 });
  const [habitWeeks, setHabitWeeks] = useState<HabitWeek[]>([]);
  const [memories, setMemories] = useState<MemoryRow[]>([]);
  const [birthdays, setBirthdays] = useState<ContactRow[]>([]);
  const [warranties, setWarranties] = useState<
    { id: number; title: string; endDate: string }[]
  >([]);
  const [receivableCents, setReceivableCents] = useState(0);

  const reload = useCallback(async () => {
    try {
      const [
        tasks,
        rems,
        dayEntries,
        habits,
        upcoming,
        birthdayContacts,
        jobs,
        receivable,
      ] = await Promise.all([
        tasksRepo.dueTasks(today),
        tasksRepo.dueReminders(localISODateTime(new Date())),
        budgetRepo.listDayEntries(today),
        habitsRepo.listHabits(),
        memoriesRepo.upcoming(today, 14),
        contactsRepo.upcomingBirthdays(14, today),
        businessRepo.listJobs("open"),
        businessRepo.listReceivable(),
      ]);
      setDueTasks(tasks);
      setReminders(rems);
      setMoney(dayMoneyTotals(dayEntries));
      const weeks = await Promise.all(
        habits.map(async (h: HabitRow) => ({
          name: h.name,
          week: (await habitsRepo.habitProgress(h.id, today)).week,
        })),
      );
      setHabitWeeks(weeks);
      setMemories(upcoming);
      setBirthdays(birthdayContacts);
      setWarranties(
        expiringWarranties(
          jobs.map((j: JobRow) => ({
            id: j.id,
            title: j.title,
            job_date: j.job_date,
            warranty_days: j.warranty_days,
          })),
          today,
          14,
        ),
      );
      setReceivableCents(
        receivable.reduce((sum, j) => sum + j.remaining_cents, 0),
      );
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

  if (loading) {
    return (
      <div className="budget-page">
        <h2 className="editor-title">Today</h2>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  return (
    <div className="budget-page">
      <h2 className="editor-title">Today</h2>
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}
      {p.notifyNote ? <p className="alert alert-note">{p.notifyNote}</p> : null}

      <section className="settings-section">
        <h3 className="settings-heading">Due tasks &amp; reminders</h3>
        {dueTasks.length === 0 && reminders.length === 0 ? (
          <EmptyState>Nothing due. Enjoy the quiet.</EmptyState>
        ) : (
          <ul className="budget-list">
            {dueTasks.map((t) => (
              <li key={`task-${t.id}`} className="budget-row">
                <span>
                  <b>{t.title}</b>
                  <span className="muted">
                    {" "}
                    — task{t.due_date ? `, due ${t.due_date}` : ""}
                  </span>
                </span>
              </li>
            ))}
            {reminders.map((r) => (
              <li key={`rem-${r.id}`} className="budget-row">
                <span>
                  <b>{r.title}</b>
                  <span className="muted"> — reminder</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="editor-row">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => p.onNavigate("tasks")}
          >
            Open Tasks
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h3 className="settings-heading">Today&apos;s money</h3>
        <p className="figure">
          In {formatMMK(money.incomeCents)} · Out{" "}
          {formatMMK(money.expenseCents)}
        </p>
        <div className="editor-row">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => p.onNavigate("budget")}
          >
            Open Budget
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h3 className="settings-heading">Habit week progress</h3>
        {habitWeeks.length === 0 ? (
          <EmptyState>No habits yet.</EmptyState>
        ) : (
          <ul className="budget-list">
            {habitWeeks.map((h) => (
              <li key={h.name} className="budget-row">
                <span>
                  <b>{h.name}</b>
                  <span className="muted">
                    {" "}
                    — {h.week.filter((d) => d.done).length}/7 this week
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="editor-row">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => p.onNavigate("habits")}
          >
            Open Habits
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h3 className="settings-heading">Upcoming memories &amp; birthdays</h3>
        {memories.length === 0 && birthdays.length === 0 ? (
          <EmptyState>Nothing in the next 14 days.</EmptyState>
        ) : (
          <ul className="budget-list">
            {memories.map((m) => (
              <li key={`mem-${m.id}`} className="budget-row">
                <span>
                  <b>{m.title}</b>
                  <span className="muted"> — {m.memory_date}</span>
                </span>
              </li>
            ))}
            {birthdays.map((c) => (
              <li key={`bday-${c.id}`} className="budget-row">
                <span>
                  <b>{c.name}</b>
                  <span className="muted">
                    {" "}
                    — birthday{c.birthday ? ` ${c.birthday}` : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="editor-row">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => p.onNavigate("memories")}
          >
            Open Memories
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h3 className="settings-heading">Expiring warranties</h3>
        {warranties.length === 0 ? (
          <EmptyState>No warranties expiring in the next 14 days.</EmptyState>
        ) : (
          <ul className="budget-list">
            {warranties.map((w) => (
              <li key={w.id} className="budget-row">
                <span>
                  <b>{w.title}</b>
                  <span className="muted"> — until {w.endDate}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="editor-row">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => p.onNavigate("business")}
          >
            Open Business
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h3 className="settings-heading">Total receivable</h3>
        <p className="figure">{formatMMK(receivableCents)}</p>
        <div className="editor-row">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => p.onNavigate("business")}
          >
            Open Receivable
          </button>
        </div>
      </section>
    </div>
  );
}
