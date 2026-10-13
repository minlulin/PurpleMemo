// P3f Dashboard page (§2.8): today at a glance — due tasks/reminders,
// today's money in-out, habit week progress, upcoming memories/birthdays,
// expiring warranties, total receivable. Every card links to its feature.

import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "../components/EmptyState.tsx";
import {
  IconBudget,
  IconBusiness,
  IconDashboard,
  IconHabits,
  IconJournal,
  IconMemories,
  IconNotes,
  IconTasks,
  IconTrendDown,
  IconTrendUp,
} from "../components/icons.tsx";
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

const SHORT_DAYS = ["S", "M", "T", "W", "T", "F", "S"] as const;

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

  const dateLabel = new Date(`${today}T00:00:00`).toLocaleDateString(
    undefined,
    {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    },
  );

  if (loading) {
    return (
      <div className="budget-page">
        <header className="page-header">
          <div className="page-header-main">
            <div className="page-title-row">
              <span className="page-icon-badge">
                <IconDashboard className="icon" />
              </span>
              <div>
                <h2 className="editor-title">Today</h2>
                <p className="page-subtitle">{dateLabel}</p>
              </div>
            </div>
          </div>
        </header>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  const dueCount = dueTasks.length + reminders.length;
  const habitsDoneToday = habitWeeks.filter((h) =>
    h.week.some((d) => d.date === today && d.done),
  ).length;
  const netTodayCents = money.incomeCents - money.expenseCents;

  return (
    <div className="budget-page">
      <header className="page-header">
        <div className="page-header-main">
          <div className="page-title-row">
            <span className="page-icon-badge">
              <IconDashboard className="icon" />
            </span>
            <div>
              <h2 className="editor-title">Today</h2>
              <p className="page-subtitle">{dateLabel}</p>
            </div>
          </div>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn"
            onClick={() => p.onNavigate("notes")}
          >
            <IconNotes className="icon" /> Notes
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => p.onNavigate("journal")}
          >
            <IconJournal className="icon" /> Journal
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => p.onNavigate("budget")}
          >
            <IconBudget className="icon" /> Log Transaction
          </button>
        </div>
      </header>

      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}
      {p.notifyNote ? <p className="alert alert-note">{p.notifyNote}</p> : null}

      {/* Executive KPI Strip */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-head">
            <span className="kpi-label">Money In Today</span>
            <span className="kpi-icon is-income">
              <IconTrendUp className="icon" />
            </span>
          </div>
          <span className="kpi-value figure amount-income">
            +{formatMMK(money.incomeCents)}
          </span>
          <span className="kpi-sub">Cash-basis daily inflow</span>
        </div>

        <div className="kpi-card">
          <div className="kpi-head">
            <span className="kpi-label">Money Out Today</span>
            <span className="kpi-icon is-expense">
              <IconTrendDown className="icon" />
            </span>
          </div>
          <span className="kpi-value figure amount-expense">
            −{formatMMK(money.expenseCents)}
          </span>
          <span className="kpi-sub">
            Net today: {netTodayCents >= 0 ? "+" : "−"}
            {formatMMK(Math.abs(netTodayCents))}
          </span>
        </div>

        <div className="kpi-card">
          <div className="kpi-head">
            <span className="kpi-label">Total Receivable</span>
            <span className="kpi-icon">
              <IconBusiness className="icon" />
            </span>
          </div>
          <span className="kpi-value figure">{formatMMK(receivableCents)}</span>
          <span className="kpi-sub">
            {warranties.length > 0
              ? `${warranties.length} warrant${warranties.length === 1 ? "y" : "ies"} expiring soon`
              : "Open customer balances"}
          </span>
        </div>

        <div className="kpi-card">
          <div className="kpi-head">
            <span className="kpi-label">Action Items</span>
            <span className={dueCount > 0 ? "kpi-icon is-warn" : "kpi-icon"}>
              <IconTasks className="icon" />
            </span>
          </div>
          <span className="kpi-value figure">
            {dueCount} {dueCount === 1 ? "item due" : "items due"}
          </span>
          <span className="kpi-sub">
            {habitWeeks.length > 0
              ? `${habitsDoneToday}/${habitWeeks.length} habits logged today`
              : "Tasks & reminders queue"}
          </span>
        </div>
      </div>

      {/* Bento Dashboard Sections */}
      <div className="dashboard-grid">
        <section className="settings-section">
          <div className="dash-card-top">
            <div className="dash-card-head">
              <div className="dash-card-title">
                <IconTasks className="icon" />
                <h3 className="settings-heading">Due tasks &amp; reminders</h3>
              </div>
              <span className={dueCount > 0 ? "badge badge-warn" : "badge"}>
                {dueCount}
              </span>
            </div>
            {dueTasks.length === 0 && reminders.length === 0 ? (
              <EmptyState>Nothing due. Enjoy the quiet.</EmptyState>
            ) : (
              <ul className="budget-list">
                {dueTasks.map((t) => (
                  <li key={`task-${t.id}`} className="budget-row">
                    <div className="row-main">
                      <span className="row-title">
                        <b>{t.title}</b>
                      </span>
                      <span className="row-sub">
                        Task{t.due_date ? ` · due ${t.due_date}` : ""}
                      </span>
                    </div>
                    <span className="badge badge-warn">Task</span>
                  </li>
                ))}
                {reminders.map((r) => (
                  <li key={`rem-${r.id}`} className="budget-row">
                    <div className="row-main">
                      <span className="row-title">
                        <b>{r.title}</b>
                      </span>
                      <span className="row-sub">
                        Reminder · {r.remind_at.replace("T", " ")}
                      </span>
                    </div>
                    <span className="badge badge-accent">Reminder</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="dash-card-foot">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => p.onNavigate("tasks")}
            >
              Open Tasks →
            </button>
          </div>
        </section>

        <section className="settings-section">
          <div className="dash-card-top">
            <div className="dash-card-head">
              <div className="dash-card-title">
                <IconBudget className="icon" />
                <h3 className="settings-heading">Today&apos;s money</h3>
              </div>
              <span className="badge badge-accent">MMK</span>
            </div>
            <div className="summary-figures">
              <div>
                <span className="muted">In</span>
                <span className="figure amount-income">
                  {formatMMK(money.incomeCents)}
                </span>
              </div>
              <div>
                <span className="muted">Out</span>
                <span className="figure amount-expense">
                  {formatMMK(money.expenseCents)}
                </span>
              </div>
            </div>
          </div>
          <div className="dash-card-foot">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => p.onNavigate("budget")}
            >
              Open Budget →
            </button>
          </div>
        </section>

        <section className="settings-section">
          <div className="dash-card-top">
            <div className="dash-card-head">
              <div className="dash-card-title">
                <IconHabits className="icon" />
                <h3 className="settings-heading">Habit week progress</h3>
              </div>
              <span className="badge">{habitWeeks.length}</span>
            </div>
            {habitWeeks.length === 0 ? (
              <EmptyState>No habits yet.</EmptyState>
            ) : (
              <ul className="budget-list">
                {habitWeeks.map((h) => {
                  const doneCount = h.week.filter((d) => d.done).length;
                  return (
                    <li key={h.name} className="budget-row">
                      <div className="row-main">
                        <span className="row-title">
                          <b>{h.name}</b>
                        </span>
                        <span className="row-sub">{doneCount}/7 this week</span>
                      </div>
                      <div className="habit-week-mini" aria-hidden="true">
                        {h.week.map((d) => {
                          const dayIdx = new Date(
                            `${d.date}T00:00:00`,
                          ).getDay();
                          return (
                            <span
                              key={d.date}
                              className={
                                d.done ? "habit-dot is-done" : "habit-dot"
                              }
                              title={d.date}
                            >
                              {d.done ? "✓" : SHORT_DAYS[dayIdx]}
                            </span>
                          );
                        })}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="dash-card-foot">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => p.onNavigate("habits")}
            >
              Open Habits →
            </button>
          </div>
        </section>

        <section className="settings-section">
          <div className="dash-card-top">
            <div className="dash-card-head">
              <div className="dash-card-title">
                <IconMemories className="icon" />
                <h3 className="settings-heading">
                  Upcoming memories &amp; birthdays
                </h3>
              </div>
              <span className="badge">
                {memories.length + birthdays.length}
              </span>
            </div>
            {memories.length === 0 && birthdays.length === 0 ? (
              <EmptyState>Nothing in the next 14 days.</EmptyState>
            ) : (
              <ul className="budget-list">
                {memories.map((m) => (
                  <li key={`mem-${m.id}`} className="budget-row">
                    <div className="row-main">
                      <span className="row-title">
                        <b>{m.title}</b>
                      </span>
                      <span className="row-sub figure">{m.memory_date}</span>
                    </div>
                    <span className="badge">Memory</span>
                  </li>
                ))}
                {birthdays.map((c) => (
                  <li key={`bday-${c.id}`} className="budget-row">
                    <div className="row-main">
                      <span className="row-title">
                        <b>{c.name}</b>
                      </span>
                      <span className="row-sub">
                        Birthday{c.birthday ? ` · ${c.birthday}` : ""}
                      </span>
                    </div>
                    <span className="badge badge-accent">Birthday</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="dash-card-foot">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => p.onNavigate("memories")}
            >
              Open Memories →
            </button>
          </div>
        </section>

        <section className="settings-section">
          <div className="dash-card-top">
            <div className="dash-card-head">
              <div className="dash-card-title">
                <IconBusiness className="icon" />
                <h3 className="settings-heading">Expiring warranties</h3>
              </div>
              <span className="badge">{warranties.length}</span>
            </div>
            {warranties.length === 0 ? (
              <EmptyState>
                No warranties expiring in the next 14 days.
              </EmptyState>
            ) : (
              <ul className="budget-list">
                {warranties.map((w) => (
                  <li key={w.id} className="budget-row">
                    <div className="row-main">
                      <span className="row-title">
                        <b>{w.title}</b>
                      </span>
                      <span className="row-sub figure">until {w.endDate}</span>
                    </div>
                    <span className="badge badge-warn">Warranty</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="dash-card-foot">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => p.onNavigate("business")}
            >
              Open Business →
            </button>
          </div>
        </section>

        <section className="settings-section">
          <div className="dash-card-top">
            <div className="dash-card-head">
              <div className="dash-card-title">
                <IconBusiness className="icon" />
                <h3 className="settings-heading">Total receivable</h3>
              </div>
              <span className="badge badge-accent">Outstanding</span>
            </div>
            <p className="figure editor-title">{formatMMK(receivableCents)}</p>
            <p className="page-subtitle">
              Unpaid balance across open customer repair &amp; service jobs.
            </p>
          </div>
          <div className="dash-card-foot">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => p.onNavigate("business")}
            >
              Open Receivable →
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
