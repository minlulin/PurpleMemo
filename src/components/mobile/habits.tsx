// The phone's Habits screen: 1-tap check-ins, no creation.

import { useCallback, useState } from "react";
import { habitsRepo } from "../../data/app.ts";
import { todayLocal } from "../../lib/dates.ts";
import { habitDoneToday } from "../../lib/mobileDashboard.ts";
import { EmptyState } from "../EmptyState.tsx";
import { useT } from "../useTranslation.ts";
import { LoadMessage, useLoad } from "./common.tsx";

// -- Habits: 1-tap check-ins, no creation -------------------------------------

/**
 * The Habits page: every habit with today's check-in and its streak.
 *
 * The checkbox reads the same `week` the Dashboard reads (both go through
 * `habitDoneToday` over `habitProgressList`), so one habit has one truth. A
 * toggle writes today's `habit_logs` row (with its UUID v4 `uid`) or removes
 * it; there is no add-habit form here, because habits are created on the
 * desktop and the FAB deliberately has no habit action.
 */
export function HabitsScreen() {
  const t = useT();
  const today = todayLocal();
  const load = useCallback(() => habitsRepo.habitProgressList(today), [today]);
  const { data, failed, reload } = useLoad(load);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [writeFailed, setWriteFailed] = useState(false);

  const toggle = async (habitId: number) => {
    setBusyId(habitId);
    setWriteFailed(false);
    try {
      await habitsRepo.toggleLog(habitId, today);
      reload();
    } catch {
      setWriteFailed(true);
    } finally {
      setBusyId(null);
    }
  };

  const habits = data ?? [];

  return (
    <section className="mobile-page">
      <p className="mobile-section-kicker">{t("nav.habits")}</p>
      <p className="muted">{t("mobile.habits.noCreate")}</p>
      <LoadMessage failed={failed || writeFailed} />
      {data !== null && habits.length === 0 ? (
        <EmptyState>{t("mobile.habits.empty")}</EmptyState>
      ) : null}
      <ul className="mobile-list" aria-label={t("mobile.habits.listAria")}>
        {habits.map((progress) => {
          const done = habitDoneToday(progress.week, today);
          return (
            <li key={progress.habit.id}>
              <label className={done ? "mobile-row is-done" : "mobile-row"}>
                <input
                  type="checkbox"
                  checked={done}
                  disabled={busyId === progress.habit.id}
                  aria-label={
                    done
                      ? t("mobile.markNotDoneOf", {
                          title: progress.habit.name,
                        })
                      : t("mobile.markDoneOf", { title: progress.habit.name })
                  }
                  onChange={() => void toggle(progress.habit.id)}
                />
                <span className="mobile-row-text">
                  {progress.habit.name}
                  <span className="mobile-row-meta">
                    {t("mobile.habits.streak", {
                      count: String(progress.current),
                    })}
                    {" · "}
                    {t("mobile.habits.best", {
                      count: String(progress.best),
                    })}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="mobile-link-btn"
        onClick={reload}
        hidden={!failed}
      >
        {t("common.tryAgain")}
      </button>
    </section>
  );
}
