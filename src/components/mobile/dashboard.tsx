// The phone's Dashboard: money, due tasks, pinned notes, habit check-ins
// and the quick capture that opens Notes' compose form.

import { useCallback, useState } from "react";
import {
  budgetRepo,
  habitsRepo,
  notesRepo,
  tasksRepo,
} from "../../data/app.ts";
import { todayLocal } from "../../lib/dates.ts";
import { recordedBalanceCents } from "../../lib/mobileBudget.ts";
import {
  habitDoneToday,
  pinnedNotes,
  urgentTasks,
} from "../../lib/mobileDashboard.ts";
import { formatMMK } from "../../lib/money.ts";
import type { TaskRow } from "../../lib/types.ts";
import { EmptyState } from "../EmptyState.tsx";
import { useLocale, useT } from "../useTranslation.ts";
import { LoadMessage, useLoad } from "./common.tsx";
import { MobileSearch } from "./search.tsx";

// -- Dashboard: money, due tasks, pinned notes, habit check-ins ----------------

export function DashboardScreen({
  onOpenNote,
}: {
  onOpenNote: (id: number) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const load = useCallback(async () => {
    const today = todayLocal();
    const [balances, tasks, notes, habits] = await Promise.all([
      budgetRepo.listWalletBalances(),
      tasksRepo.dueTasks(today),
      notesRepo.listNotes({ limit: 100 }),
      habitsRepo.habitProgressList(today),
    ]);
    return { today, balances, tasks, notes, habits };
  }, []);
  const { data, failed, reload } = useLoad(load);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [writeFailed, setWriteFailed] = useState(false);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);

  const completeTask = async (task: TaskRow) => {
    setBusyKey(`task:${task.id}`);
    setWriteFailed(false);
    try {
      await tasksRepo.completeTask(task.id);
      reload();
    } catch {
      setWriteFailed(true);
    } finally {
      setBusyKey(null);
    }
  };

  const toggleHabit = async (habitId: number, date: string) => {
    setBusyKey(`habit:${habitId}`);
    setWriteFailed(false);
    try {
      await habitsRepo.toggleLog(habitId, date);
      reload();
    } catch {
      setWriteFailed(true);
    } finally {
      setBusyKey(null);
    }
  };

  const today = data?.today ?? todayLocal();
  const balances = data?.balances ?? [];
  const tasks = data === null ? [] : urgentTasks(data.tasks, data.today);
  const pinned = data === null ? [] : pinnedNotes(data.notes);
  const habits = data?.habits ?? [];

  const capture = async () => {
    const body = text.trim();
    if (body === "") return;
    try {
      await notesRepo.createNote({ title: "", content: body });
      setText("");
      setSaved(true);
      reload();
    } catch {
      setSaved(false);
    }
  };

  return (
    <section className="mobile-page">
      <p className="mobile-section-kicker">{t("nav.dashboard")}</p>
      <LoadMessage failed={failed || writeFailed} />

      <div className="mobile-quick">
        <p className="mobile-section-kicker">
          {t("mobile.dashboard.recordedBalance")}
        </p>
        {data !== null && balances.length === 0 ? (
          <EmptyState>{t("mobile.dashboard.noWallets")}</EmptyState>
        ) : (
          <>
            <p className="mobile-balance">
              {formatMMK(recordedBalanceCents(balances), locale)}
            </p>
            <ul
              className="mobile-list"
              aria-label={t("mobile.dashboard.walletsAria")}
            >
              {balances.map((wallet) => (
                <li key={wallet.id} className="mobile-wallet-line">
                  <span className="mobile-row-text">{wallet.name}</span>
                  <span className="mobile-row-meta">
                    {formatMMK(wallet.balanceCents, locale)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="mobile-quick">
        <p className="mobile-section-kicker">
          {t("mobile.dashboard.tasksHeading")}
        </p>
        {data !== null && tasks.length === 0 ? (
          <EmptyState>{t("mobile.dashboard.noTasks")}</EmptyState>
        ) : null}
        <ul
          className="mobile-list"
          aria-label={t("mobile.dashboard.tasksAria")}
        >
          {tasks.map((task) => (
            <li key={task.id}>
              <label className="mobile-row">
                <input
                  type="checkbox"
                  checked={false}
                  disabled={busyKey === `task:${task.id}`}
                  aria-label={t("mobile.markDoneOf", { title: task.title })}
                  onChange={() => void completeTask(task)}
                />
                <span className="mobile-row-text">
                  {task.title}
                  {task.due_date !== null ? (
                    <span className="mobile-row-meta">
                      {task.due_date < today
                        ? t("tasks.overdue")
                        : t("tasks.due", { date: task.due_date })}
                    </span>
                  ) : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      <div className="mobile-quick">
        <p className="mobile-section-kicker">
          {t("mobile.dashboard.pinnedHeading")}
        </p>
        {data !== null && pinned.length === 0 ? (
          <EmptyState>{t("mobile.dashboard.noPinned")}</EmptyState>
        ) : null}
        <ul
          className="mobile-list"
          aria-label={t("mobile.dashboard.pinnedAria")}
        >
          {pinned.map((note) => (
            <li key={note.id}>
              <button
                type="button"
                className="mobile-card mobile-card-btn"
                onClick={() => onOpenNote(note.id)}
              >
                <span className="mobile-card-title">
                  {note.title.trim() === "" ? t("notes.untitled") : note.title}
                </span>
                {note.content.trim() !== "" ? (
                  <span className="mobile-card-body">{note.content}</span>
                ) : null}
                <span className="mobile-card-meta">
                  {t("mobile.dashboard.openNote")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="mobile-quick">
        <p className="mobile-section-kicker">
          {t("mobile.dashboard.habitsHeading")}
        </p>
        {data !== null && habits.length === 0 ? (
          <EmptyState>{t("mobile.dashboard.noHabits")}</EmptyState>
        ) : null}
        <ul
          className="mobile-list"
          aria-label={t("mobile.dashboard.habitsAria")}
        >
          {habits.map((progress) => {
            const done = habitDoneToday(progress.week, today);
            return (
              <li key={progress.habit.id}>
                <label className={done ? "mobile-row is-done" : "mobile-row"}>
                  <input
                    type="checkbox"
                    checked={done}
                    disabled={busyKey === `habit:${progress.habit.id}`}
                    aria-label={
                      done
                        ? t("mobile.markNotDoneOf", {
                            title: progress.habit.name,
                          })
                        : t("mobile.markDoneOf", { title: progress.habit.name })
                    }
                    onChange={() => void toggleHabit(progress.habit.id, today)}
                  />
                  <span className="mobile-row-text">{progress.habit.name}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="mobile-quick">
        <label className="mobile-quick-label" htmlFor="mobile-quick-capture">
          {t("mobile.quickCapture")}
        </label>
        <input
          id="mobile-quick-capture"
          className="input"
          type="text"
          value={text}
          placeholder={t("mobile.quickCapturePlaceholder")}
          onChange={(event) => {
            setText(event.currentTarget.value);
            setSaved(false);
          }}
          onFocus={(event) => {
            const field = event.currentTarget;
            requestAnimationFrame(() =>
              field.scrollIntoView({ block: "center" }),
            );
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void capture();
            }
          }}
        />
        <p className="muted">{t("mobile.quickCaptureHint")}</p>
        <div className="mobile-actions">
          <button
            type="button"
            className="btn"
            disabled={text.trim() === ""}
            onClick={() => void capture()}
          >
            {t("notes.save")}
          </button>
        </div>
        {saved ? (
          <p className="mobile-saved" role="status">
            {t("mobile.noteSaved")}
          </p>
        ) : null}
      </div>
      <MobileSearch />
    </section>
  );
}
