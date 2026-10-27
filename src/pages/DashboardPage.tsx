// P3f Dashboard page: today at a glance — due tasks/reminders,
// today's money in-out, habit week progress, upcoming memories/birthdays,
// expiring warranties, total receivable. Every card links to its feature.

import { useCallback, useEffect, useState } from "react";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import {
  IconArrowRight,
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
import { OnboardingGuide } from "../components/OnboardingGuide.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { useLocale, usePlural, useT } from "../components/useTranslation.ts";
import {
  budgetRepo,
  businessRepo,
  contactsRepo,
  habitsRepo,
  memoriesRepo,
  tasksRepo,
} from "../data/app.ts";
import {
  dayMoneyTotals,
  expiringWarranties,
  TODAY_HORIZON_DAYS,
  upcomingRecurring,
} from "../lib/dashboard.ts";
import { addDays, localISODateTime, todayLocal } from "../lib/dates.ts";
import { errText } from "../lib/errors.ts";
import {
  formatDate,
  formatDateTime,
  formatLongDate,
  weekdayNarrow,
} from "../lib/format.ts";
import { formatMMK } from "../lib/money.ts";
import type { PageKey } from "../lib/navigation.ts";
import type {
  ContactRow,
  JobRow,
  MemoryRow,
  RecurringPaymentRow,
  ReminderRow,
  TaskRow,
} from "../lib/types.ts";
import { badgeFor, SOON_DAYS, urgencyFor } from "../lib/urgency.ts";
import { useRevealWithin } from "../lib/useReveal.ts";

interface DashboardPageProps {
  notifyNote: string | null;
  onNavigate: (key: PageKey) => void;
}

interface HabitWeek {
  name: string;
  week: { date: string; done: boolean }[];
}

/**
 * Day-over-day change as a whole percentage, or null when there is no usable
 * baseline (nothing recorded yesterday) — an invented "0%" would be a lie.
 */
function trendPercent(now: number, prev: number): number | null {
  if (prev <= 0) return null;
  return Math.round(((now - prev) / prev) * 100);
}

function KpiTrend({
  now,
  prev,
  upIsGood,
}: {
  now: number;
  prev: number | null;
  upIsGood: boolean;
}) {
  const t = useT();
  const pct = prev === null ? null : trendPercent(now, prev);
  if (pct === null) return null;
  const up = pct > 0;
  const tone = pct === 0 ? "is-flat" : up === upIsGood ? "is-good" : "is-bad";
  return (
    <span className={`kpi-trend ${tone}`}>
      {pct > 0 ? <IconTrendUp /> : pct < 0 ? <IconTrendDown /> : null}
      {pct === 0
        ? t("dashboard.trendLevel")
        : t("dashboard.trendChange", { pct: Math.abs(pct) })}
    </span>
  );
}

export default function DashboardPage(p: DashboardPageProps) {
  const t = useT();
  const plural = usePlural();
  const locale = useLocale();
  /**
   * The day every card here is read against (C2 — the TasksPage B8 shape):
   * state rather than a value read in the render, so the badges and the rows
   * they grade always come from one load. A render-captured date went stale the
   * moment the page was left mounted past midnight; `reload` sets this together
   * with the rows, and the rollover tick below is what re-runs that load.
   * Writes deliberately do NOT use it — they take `todayLocal()` at the moment
   * they write, so even a click inside the tick's window books the real day.
   */
  const [today, setToday] = useState(() => todayLocal());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openTasks, setOpenTasks] = useState<TaskRow[]>([]);
  const [reminders, setReminders] = useState<ReminderRow[]>([]);
  const [money, setMoney] = useState({ incomeCents: 0, expenseCents: 0 });
  const [moneyPrev, setMoneyPrev] = useState<{
    incomeCents: number;
    expenseCents: number;
  } | null>(null);
  const [habitWeeks, setHabitWeeks] = useState<HabitWeek[]>([]);
  const [memories, setMemories] = useState<MemoryRow[]>([]);
  const [birthdays, setBirthdays] = useState<ContactRow[]>([]);
  const [warranties, setWarranties] = useState<
    { id: number; title: string; endDate: string }[]
  >([]);
  const [receivableCents, setReceivableCents] = useState(0);
  /** Fired one-shots awaiting acknowledge/snooze. */
  const [fired, setFired] = useState<ReminderRow[]>([]);
  /** Active recurring payments due within the horizon. */
  const [recurring, setRecurring] = useState<RecurringPaymentRow[]>([]);
  /**
   * The row an action is in flight on (`task:3`, `rem:7`). Double-clicking
   * Complete on a repeating task would roll its due date two periods forward,
   * so every Today action shares this guard and raises it before its first
   * await (see the source-guard tests in submit-guards.test.ts).
   */
  const [busyRow, setBusyRow] = useState<string | null>(null);
  /** Draft reschedule dates (task rows) and snooze times (reminder rows). */
  const [taskDrafts, setTaskDrafts] = useState<Record<number, string>>({});
  const [snoozeDrafts, setSnoozeDrafts] = useState<Record<number, string>>({});
  // Reveal attaches once the cards exist, not while they are still skeletons.
  const pageRef = useRevealWithin<HTMLDivElement>(!loading);

  const reload = useCallback(async () => {
    // The day THIS load is for, read when the load runs — not in the render
    // that happened to be on screen (C2).
    const day = todayLocal();
    try {
      const [
        tasks,
        rems,
        dayEntries,
        prevDayEntries,
        upcoming,
        birthdayContacts,
        jobs,
        receivable,
        firedRows,
        recurringRows,
      ] = await Promise.all([
        tasksRepo.openTasks(),
        tasksRepo.dueReminders(localISODateTime(new Date())),
        budgetRepo.listDayEntries(day),
        budgetRepo.listDayEntries(addDays(day, -1)),
        memoriesRepo.upcoming(day, TODAY_HORIZON_DAYS),
        contactsRepo.upcomingBirthdays(TODAY_HORIZON_DAYS, day),
        businessRepo.listJobs("open"),
        businessRepo.listReceivable(),
        tasksRepo.firedReminders(),
        budgetRepo.listRecurring(false),
      ]);
      setOpenTasks(tasks);
      setReminders(rems);
      setMoney(dayMoneyTotals(dayEntries));
      setMoneyPrev(dayMoneyTotals(prevDayEntries));
      // Every habit's week in one two-query pass instead of two queries per
      // habit; the list read moved into the same call.
      const habitProg = await habitsRepo.habitProgressList(day);
      setHabitWeeks(
        habitProg.map((p) => ({ name: p.habit.name, week: p.week })),
      );
      setMemories(upcoming);
      setBirthdays(birthdayContacts);
      setFired(firedRows);
      setRecurring(upcomingRecurring(recurringRows, day));
      setWarranties(
        expiringWarranties(
          jobs.map((j: JobRow) => ({
            id: j.id,
            title: j.title,
            job_date: j.job_date,
            warranty_days: j.warranty_days,
          })),
          day,
          TODAY_HORIZON_DAYS,
        ),
      );
      setReceivableCents(
        receivable.reduce((sum, j) => sum + j.remaining_cents, 0),
      );
      // The rows and the day they belong to land in the same batch.
      setToday(day);
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

  // The shell keeps this page mounted across midnight, so nothing re-renders
  // it when the date rolls over (C2): this tick is what reloads "today at a
  // glance" — the date label, the overdue badge, the habit check-ins.
  useEffect(() => {
    const timer = setInterval(() => {
      if (todayLocal() !== today) void reload();
    }, 60_000);
    return () => clearInterval(timer);
  }, [reload, today]);

  // -- Today actions -------------------------------------------
  // Every action calls the same repository function its source page uses —
  // `completeTask` rolls repeats identically for Tasks and Today by being one
  // function (task 6), and snooze/acknowledge are the existing reminder repo
  // calls. Today stores nothing of its own; a reload re-reads the source rows.

  const completeTask = async (task: TaskRow) => {
    if (busyRow !== null) return;
    setBusyRow(`task:${task.id}`);
    try {
      // Read here rather than from `today` state (B8): the state is the day
      // the LIST was loaded for, while this write must book the real day —
      // `completeTask` re-anchors a repeating task off this date.
      await tasksRepo.completeTask(task.id, todayLocal());
      await reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusyRow(null);
    }
  };

  const rescheduleTask = async (task: TaskRow) => {
    if (busyRow !== null) return;
    const dueDate = taskDrafts[task.id] ?? "";
    if (dueDate === "") return;
    setBusyRow(`task:${task.id}`);
    try {
      await tasksRepo.updateTask(task.id, { dueDate });
      setTaskDrafts((d) => ({ ...d, [task.id]: "" }));
      await reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusyRow(null);
    }
  };

  /**
   * Snooze/rearm to an explicit timestamp. One call covers pending and fired
   * rows: `rescheduleReminder` writes the time and clears `fired`, and a
   * repeating reminder keeps the `nextReminderAt` anchor — the same semantics
   * the reminders section on Tasks uses.
   */
  const snoozeReminder = async (r: ReminderRow) => {
    if (busyRow !== null) return;
    const remindAt = snoozeDrafts[r.id] ?? "";
    if (remindAt === "") return;
    setBusyRow(`rem:${r.id}`);
    try {
      await tasksRepo.rescheduleReminder(r.id, remindAt);
      setSnoozeDrafts((d) => ({ ...d, [r.id]: "" }));
      await reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusyRow(null);
    }
  };

  /**
   * Acknowledge a fired one-shot: resolve it by deleting
   * the row, with no new "seen" state that could disagree with the list.
   */
  const acknowledgeReminder = async (r: ReminderRow) => {
    if (busyRow !== null) return;
    setBusyRow(`rem:${r.id}`);
    try {
      await tasksRepo.deleteReminder(r.id);
      await reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusyRow(null);
    }
  };

  const dateLabel = formatLongDate(locale, today);

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
                <h2 className="editor-title">{t("dashboard.title")}</h2>
                <p className="page-subtitle">{dateLabel}</p>
              </div>
            </div>
          </div>
        </header>
        {/* Same grids the real page renders, so nothing reflows on load. */}
        <div className="kpi-grid">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={`kpi-${i}`} variant="card" />
          ))}
        </div>
        <div className="dashboard-grid">
          {[0, 1, 2].map((i) => (
            <Skeleton key={`card-${i}`} variant="card" />
          ))}
        </div>
      </div>
    );
  }

  // Attention items (plan §A.3): overdue tasks + due reminders + fired
  // reminders. The open list itself is every color; only the red rows are
  // asking for action.
  const attentionCount =
    openTasks.filter((task) => urgencyFor(task.due_date, today) === "overdue")
      .length +
    reminders.length +
    fired.length;
  const habitsDoneToday = habitWeeks.filter((h) =>
    h.week.some((d) => d.date === today && d.done),
  ).length;
  const netTodayCents = money.incomeCents - money.expenseCents;

  return (
    <div className="budget-page" ref={pageRef}>
      <header className="page-header">
        <div className="page-header-main">
          <div className="page-title-row">
            <span className="page-icon-badge">
              <IconDashboard className="icon" />
            </span>
            <div>
              <h2 className="editor-title">{t("dashboard.title")}</h2>
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
            <IconNotes className="icon" /> {t("dashboard.notesAction")}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => p.onNavigate("journal")}
          >
            <IconJournal className="icon" /> {t("dashboard.journalAction")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => p.onNavigate("budget")}
          >
            <IconBudget className="icon" /> {t("dashboard.logTransaction")}
          </button>
        </div>
      </header>

      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}
      {p.notifyNote ? <p className="alert alert-note">{p.notifyNote}</p> : null}

      <OnboardingGuide />

      {/* Executive KPI Strip */}
      <h2 className="dashboard-section-title">{t("dashboard.overview")}</h2>
      <div className="kpi-grid">
        <div className="kpi-card reveal-on-scroll delay-1 kpi-card-variation is-income">
          <div className="kpi-head">
            <span className="kpi-label">{t("dashboard.moneyIn")}</span>
            <span className="kpi-icon is-income">
              <IconTrendUp className="icon" />
            </span>
          </div>
          <span className="kpi-value figure amount-income">
            +{formatMMK(money.incomeCents)}
          </span>
          <span className="kpi-trend-row">
            <KpiTrend
              now={money.incomeCents}
              prev={moneyPrev?.incomeCents ?? null}
              upIsGood
            />
            <span className="kpi-sub">{t("dashboard.cashInflow")}</span>
          </span>
        </div>

        <div className="kpi-card reveal-on-scroll delay-2 kpi-card-variation is-expense">
          <div className="kpi-head">
            <span className="kpi-label">{t("dashboard.moneyOut")}</span>
            <span className="kpi-icon is-expense">
              <IconTrendDown className="icon" />
            </span>
          </div>
          <span className="kpi-value figure amount-expense">
            −{formatMMK(money.expenseCents)}
          </span>
          <span className="kpi-trend-row">
            <KpiTrend
              now={money.expenseCents}
              prev={moneyPrev?.expenseCents ?? null}
              upIsGood={false}
            />
            <span className="kpi-sub">
              {t("dashboard.netToday", {
                amount: `${netTodayCents >= 0 ? "+" : "−"}${formatMMK(
                  Math.abs(netTodayCents),
                )}`,
              })}
            </span>
          </span>
        </div>

        <div className="kpi-card reveal-on-scroll delay-3 kpi-card-variation">
          <div className="kpi-head">
            <span className="kpi-label">{t("dashboard.totalReceivable")}</span>
            <span className="kpi-icon">
              <IconBusiness className="icon" />
            </span>
          </div>
          <span className="kpi-value figure">{formatMMK(receivableCents)}</span>
          <span className="kpi-sub">
            {warranties.length > 0
              ? plural("dashboard.warrantiesSoon", warranties.length)
              : t("dashboard.openBalances")}
          </span>
        </div>

        <div className="kpi-card reveal-on-scroll delay-4 kpi-card-variation is-warn">
          <div className="kpi-head">
            <span className="kpi-label">{t("dashboard.actionItems")}</span>
            <span
              className={attentionCount > 0 ? "kpi-icon is-warn" : "kpi-icon"}
            >
              <IconTasks className="icon" />
            </span>
          </div>
          <span className="kpi-value figure">
            {plural("dashboard.itemsDue", attentionCount)}
          </span>
          <span className="kpi-sub">
            {habitWeeks.length > 0
              ? t("dashboard.habitsLogged", {
                  done: habitsDoneToday,
                  total: habitWeeks.length,
                })
              : t("dashboard.queue")}
          </span>
        </div>
      </div>

      {/* Bento Dashboard Sections */}
      <h2 className="dashboard-section-title">{t("dashboard.todayHeading")}</h2>
      <div className="dashboard-grid">
        <section className="settings-section reveal-on-scroll delay-5">
          <div className="dash-card-top">
            <div className="dash-card-head">
              <div className="dash-card-title">
                <IconTasks className="icon" />
                <h3 className="settings-heading">
                  {t("dashboard.tasksRemindersHeading")}
                </h3>
              </div>
              <span
                className={attentionCount > 0 ? "badge badge-warn" : "badge"}
              >
                {attentionCount}
              </span>
            </div>
            <p className="muted">
              {t("dashboard.urgencyLegend", { days: SOON_DAYS })}
            </p>
            {openTasks.length === 0 &&
            reminders.length === 0 &&
            fired.length === 0 ? (
              <EmptyState>{t("dashboard.noOpenTasks")}</EmptyState>
            ) : (
              <>
                <ul className="budget-list">
                  {openTasks.map((task) => (
                    <li key={`task-${task.id}`} className="budget-row">
                      <div className="row-main">
                        <span className="row-title">
                          <b>{task.title}</b>
                        </span>
                        <span className="row-sub">
                          {task.due_date
                            ? t("dashboard.taskDue", {
                                date: formatDate(locale, task.due_date),
                              })
                            : t("dashboard.task")}
                        </span>
                        <span className="row-actions">
                          <button
                            type="button"
                            className="btn btn-ghost"
                            disabled={busyRow !== null}
                            onClick={() => void completeTask(task)}
                          >
                            {t("dashboard.complete")}
                          </button>
                          <input
                            type="date"
                            aria-label={t("dashboard.newDueDate", {
                              title: task.title,
                            })}
                            value={taskDrafts[task.id] ?? ""}
                            onChange={(e) =>
                              setTaskDrafts((d) => ({
                                ...d,
                                [task.id]: e.target.value,
                              }))
                            }
                          />
                          <button
                            type="button"
                            className="btn btn-ghost"
                            disabled={
                              busyRow !== null ||
                              (taskDrafts[task.id] ?? "") === ""
                            }
                            onClick={() => void rescheduleTask(task)}
                          >
                            {t("dashboard.reschedule")}
                          </button>
                        </span>
                      </div>
                      <span
                        className={badgeFor(urgencyFor(task.due_date, today))}
                      >
                        {t("dashboard.task")}
                      </span>
                    </li>
                  ))}
                  {reminders.map((r) => (
                    <li key={`rem-${r.id}`} className="budget-row">
                      <div className="row-main">
                        <span className="row-title">
                          <b>{r.title}</b>
                        </span>
                        <span className="row-sub">
                          {t("dashboard.reminderAt", {
                            date: formatDateTime(locale, r.remind_at),
                          })}
                        </span>
                        <span className="row-actions">
                          <input
                            type="datetime-local"
                            aria-label={t("tasks.snoozeUntil", {
                              title: r.title,
                            })}
                            value={snoozeDrafts[r.id] ?? ""}
                            onChange={(e) =>
                              setSnoozeDrafts((d) => ({
                                ...d,
                                [r.id]: e.target.value,
                              }))
                            }
                          />
                          <button
                            type="button"
                            className="btn btn-ghost"
                            disabled={
                              busyRow !== null ||
                              (snoozeDrafts[r.id] ?? "") === ""
                            }
                            onClick={() => void snoozeReminder(r)}
                          >
                            {t("tasks.snooze")}
                          </button>
                        </span>
                      </div>
                      <span className="badge badge-accent">
                        {t("dashboard.reminder")}
                      </span>
                    </li>
                  ))}
                </ul>
                {/* Fired one-shots stay visible until resolved (task 4): the
                    poll marks them fired, which means handed to the OS — never
                    "seen" — so hiding them would drop exactly the reminders
                    the user missed. */}
                {fired.length > 0 ? (
                  <div className="contact-section">
                    <h4 className="side-heading">
                      {t("dashboard.firedHeading")}
                    </h4>
                    <ul className="budget-list">
                      {fired.map((r) => (
                        <li key={`fired-${r.id}`} className="budget-row">
                          <div className="row-main">
                            <span className="row-title">
                              <b>{r.title}</b>
                            </span>
                            <span className="row-sub">
                              {t("dashboard.firedInfo", {
                                date: formatDateTime(locale, r.remind_at),
                              })}
                            </span>
                            <span className="row-actions">
                              <input
                                type="datetime-local"
                                aria-label={t("tasks.snoozeUntil", {
                                  title: r.title,
                                })}
                                value={snoozeDrafts[r.id] ?? ""}
                                onChange={(e) =>
                                  setSnoozeDrafts((d) => ({
                                    ...d,
                                    [r.id]: e.target.value,
                                  }))
                                }
                              />
                              <button
                                type="button"
                                className="btn btn-ghost"
                                disabled={
                                  busyRow !== null ||
                                  (snoozeDrafts[r.id] ?? "") === ""
                                }
                                onClick={() => void snoozeReminder(r)}
                              >
                                {t("tasks.snooze")}
                              </button>
                              <ConfirmButton
                                className="btn btn-ghost"
                                what={t("tasks.acknowledgeWhat")}
                                onConfirm={() => acknowledgeReminder(r)}
                              >
                                {t("tasks.acknowledge")}
                              </ConfirmButton>
                            </span>
                          </div>
                          <span className="badge badge-warn">
                            {t("tasks.fired")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            )}
          </div>
          <div className="dash-card-foot">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => p.onNavigate("tasks")}
            >
              {t("dashboard.openTasks")} <IconArrowRight className="icon" />
            </button>
          </div>
        </section>

        <section className="settings-section reveal-on-scroll delay-6">
          <div className="dash-card-top">
            <div className="dash-card-head">
              <div className="dash-card-title">
                <IconBudget className="icon" />
                <h3 className="settings-heading">
                  {t("dashboard.todaysMoney")}
                </h3>
              </div>
              <span className="badge badge-accent">MMK</span>
            </div>
            <div className="summary-figures">
              <div>
                <span className="muted">{t("dashboard.in")}</span>
                <span className="figure amount-income">
                  {formatMMK(money.incomeCents)}
                </span>
              </div>
              <div>
                <span className="muted">{t("dashboard.out")}</span>
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
              {t("dashboard.openBudget")} <IconArrowRight className="icon" />
            </button>
          </div>
        </section>

        <section className="settings-section reveal-on-scroll delay-7">
          <div className="dash-card-top">
            <div className="dash-card-head">
              <div className="dash-card-title">
                <IconHabits className="icon" />
                <h3 className="settings-heading">
                  {t("dashboard.habitWeekHeading")}
                </h3>
              </div>
              <span className="badge">{habitWeeks.length}</span>
            </div>
            {habitWeeks.length === 0 ? (
              <EmptyState>{t("dashboard.noHabits")}</EmptyState>
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
                        <span className="row-sub">
                          {t("dashboard.habitWeekProgress", {
                            done: doneCount,
                          })}
                        </span>
                      </div>
                      <div className="habit-week-mini" aria-hidden="true">
                        {h.week.map((d) => {
                          return (
                            <span
                              key={d.date}
                              className={
                                d.done ? "habit-dot is-done" : "habit-dot"
                              }
                              title={d.date}
                            >
                              {d.done ? "✓" : weekdayNarrow(locale, d.date)}
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
              {t("dashboard.openHabits")} <IconArrowRight className="icon" />
            </button>
          </div>
        </section>
      </div>

      <h2 className="dashboard-section-title">{t("dashboard.comingUp")}</h2>
      <div className="dashboard-grid">
        <section className="settings-section reveal-on-scroll delay-8">
          <div className="dash-card-top">
            <div className="dash-card-head">
              <div className="dash-card-title">
                <IconMemories className="icon" />
                <h3 className="settings-heading">
                  {t("dashboard.upcomingHeading")}
                </h3>
              </div>
              <span className="badge">
                {memories.length + birthdays.length}
              </span>
            </div>
            {memories.length === 0 && birthdays.length === 0 ? (
              <EmptyState>
                {t("dashboard.nothingNext", { days: TODAY_HORIZON_DAYS })}
              </EmptyState>
            ) : (
              <ul className="budget-list">
                {memories.map((m) => (
                  <li key={`mem-${m.id}`} className="budget-row">
                    <div className="row-main">
                      <span className="row-title">
                        <b>{m.title}</b>
                      </span>
                      <span className="row-sub figure">
                        {formatDate(locale, m.memory_date)}
                      </span>
                    </div>
                    <span className="badge">{t("dashboard.memory")}</span>
                  </li>
                ))}
                {birthdays.map((c) => (
                  <li key={`bday-${c.id}`} className="budget-row">
                    <div className="row-main">
                      <span className="row-title">
                        <b>{c.name}</b>
                      </span>
                      <span className="row-sub">
                        {c.birthday
                          ? t("dashboard.birthdayWithDate", {
                              date: formatDate(locale, c.birthday),
                            })
                          : t("dashboard.birthday")}
                      </span>
                    </div>
                    <span className="badge badge-accent">
                      {t("dashboard.birthday")}
                    </span>
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
              {t("dashboard.openMemories")} <IconArrowRight className="icon" />
            </button>
          </div>
        </section>

        <section className="settings-section">
          <div className="dash-card-top">
            <div className="dash-card-head">
              <div className="dash-card-title">
                <IconBudget className="icon" />
                <h3 className="settings-heading">
                  {t("dashboard.recurringHeading")}
                </h3>
              </div>
              <span className="badge">{recurring.length}</span>
            </div>
            {/* Read-only: marking a rule paid books real
                money, so Today links to the Budget page where the existing,
                tested mark-paid flow lives instead of duplicating it. */}
            {recurring.length === 0 ? (
              <EmptyState>
                {t("dashboard.noRecurring", { days: TODAY_HORIZON_DAYS })}
              </EmptyState>
            ) : (
              <ul className="budget-list">
                {recurring.map((r) => (
                  <li key={`rec-${r.id}`} className="budget-row">
                    <div className="row-main">
                      <span className="row-title">
                        <b>{r.title}</b>
                      </span>
                      <span className="row-sub figure">
                        {formatMMK(r.amount_cents)} ·{" "}
                        {t("dashboard.dueOn", {
                          date: formatDate(locale, r.next_due_date),
                        })}
                      </span>
                    </div>
                    <span className="badge badge-accent">
                      {t("dashboard.recurring")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="dash-card-foot">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => p.onNavigate("budget")}
            >
              {t("dashboard.openBudget")} <IconArrowRight className="icon" />
            </button>
          </div>
        </section>

        <section className="settings-section">
          <div className="dash-card-top">
            <div className="dash-card-head">
              <div className="dash-card-title">
                <IconBusiness className="icon" />
                <h3 className="settings-heading">
                  {t("dashboard.warrantiesHeading")}
                </h3>
              </div>
              <span className="badge">{warranties.length}</span>
            </div>
            {warranties.length === 0 ? (
              <EmptyState>
                {t("dashboard.noWarranties", { days: TODAY_HORIZON_DAYS })}
              </EmptyState>
            ) : (
              <ul className="budget-list">
                {warranties.map((w) => (
                  <li key={w.id} className="budget-row">
                    <div className="row-main">
                      <span className="row-title">
                        <b>{w.title}</b>
                      </span>
                      <span className="row-sub figure">
                        {t("dashboard.until", {
                          date: formatDate(locale, w.endDate),
                        })}
                      </span>
                    </div>
                    <span className="badge badge-warn">
                      {t("dashboard.warranty")}
                    </span>
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
              {t("dashboard.openBusiness")} <IconArrowRight className="icon" />
            </button>
          </div>
        </section>

        <section className="settings-section">
          <div className="dash-card-top">
            <div className="dash-card-head">
              <div className="dash-card-title">
                <IconBusiness className="icon" />
                <h3 className="settings-heading">
                  {t("dashboard.totalReceivableHeading")}
                </h3>
              </div>
              <span className="badge badge-accent">
                {t("dashboard.outstanding")}
              </span>
            </div>
            <p className="figure amount-large">{formatMMK(receivableCents)}</p>
            <p className="page-subtitle">{t("dashboard.receivableNote")}</p>
          </div>
          <div className="dash-card-foot">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => p.onNavigate("business")}
            >
              {t("dashboard.openReceivable")}{" "}
              <IconArrowRight className="icon" />
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
