// P3d Habits page (§2.7): daily logs, current/best streaks, week progress,
// month grid. Pure streak/week math lives in lib/habits.ts; the month grid
// is reused from the journal (same Sunday-start grid, §2.5).

import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "../components/EmptyState.tsx";
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconHabits,
  IconPlus,
} from "../components/icons.tsx";
import { habitsRepo } from "../data/app.ts";
import { shiftYearMonth, todayLocal, yearMonthOf } from "../lib/dates.ts";
import { errText } from "../lib/errors.ts";
import { buildMonthGrid, monthLabel } from "../lib/journal.ts";
import type { HabitRow } from "../lib/types.ts";

interface HabitProgress {
  habit: HabitRow | undefined;
  current: number;
  best: number;
  week: { date: string; done: boolean }[];
}

const DAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

export default function HabitsPage() {
  const today = todayLocal();
  const [habits, setHabits] = useState<HabitRow[]>([]);
  const [progress, setProgress] = useState<Map<number, HabitProgress>>(
    new Map(),
  );
  const [dates, setDates] = useState<Map<number, string[]>>(new Map());
  const [gridMonth, setGridMonth] = useState(() => yearMonthOf(todayLocal()));
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  const reload = useCallback(async () => {
    try {
      const hs = await habitsRepo.listHabits();
      const [progs, allDates] = await Promise.all([
        Promise.all(hs.map((h) => habitsRepo.habitProgress(h.id, today))),
        Promise.all(hs.map((h) => habitsRepo.loggedDates(h.id))),
      ]);
      setHabits(hs);
      setProgress(
        new Map<number, HabitProgress>(
          hs.map((h, i): [number, HabitProgress] => [
            h.id,
            progs[i] ?? { habit: undefined, current: 0, best: 0, week: [] },
          ]),
        ),
      );
      setDates(
        new Map<number, string[]>(
          hs.map((h, i): [number, string[]] => [h.id, allDates[i] ?? []]),
        ),
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

  const addHabit = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    try {
      await habitsRepo.createHabit(trimmed);
      setName("");
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  const toggle = async (habitId: number, date: string) => {
    try {
      await habitsRepo.toggleLog(habitId, date);
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  const removeHabit = async (id: number) => {
    try {
      await habitsRepo.deleteHabit(id);
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  const shiftMonth = (delta: number) => {
    setGridMonth(shiftYearMonth(gridMonth, delta));
  };

  return (
    <div className="budget-page">
      <header className="page-header">
        <div className="page-header-main">
          <div className="page-title-row">
            <span className="page-icon-badge">
              <IconHabits className="icon" />
            </span>
            <div>
              <h2 className="editor-title">Habits &amp; Streaks</h2>
              <p className="page-subtitle">
                Build daily consistency with weekly check-ins and monthly
                history
              </p>
            </div>
          </div>
        </div>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void addHabit();
          }}
        >
          <input
            aria-label="New habit name"
            placeholder="e.g. Read 20 minutes"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={name.trim().length === 0}
          >
            <IconPlus className="icon" /> Add habit
          </button>
        </form>
      </header>

      {loading ? <p className="muted">Loading…</p> : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      {habits.length === 0 ? (
        <section className="settings-section">
          <EmptyState>No habits yet — add one above.</EmptyState>
        </section>
      ) : (
        <div className="dashboard-grid">
          {habits.map((h) => {
            const p = progress.get(h.id);
            const doneToday =
              p?.week.find((d) => d.date === today)?.done ?? false;
            const open = expanded.has(h.id);
            return (
              <section key={h.id} className="budget-manage" aria-label={h.name}>
                <div className="dash-card-head">
                  <div className="row-main">
                    <span className="row-title">
                      <b>{h.name}</b>
                    </span>
                    <span className="row-sub figure">
                      streak {p?.current ?? 0} · best {p?.best ?? 0}
                    </span>
                  </div>
                  <span className="row-actions">
                    <button
                      type="button"
                      className={doneToday ? "btn is-on" : "btn btn-primary"}
                      aria-pressed={doneToday}
                      onClick={() => void toggle(h.id, today)}
                    >
                      {doneToday ? "Done today ✓" : "Mark done today"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => void removeHabit(h.id)}
                    >
                      Delete
                    </button>
                  </span>
                </div>

                <div className="habit-week-block">
                  <span className="editor-pane-label">This week</span>
                  <div className="habit-week-strip">
                    {(p?.week ?? []).map((d) => {
                      const dayIdx = new Date(`${d.date}T00:00:00`).getDay();
                      return (
                        <button
                          key={d.date}
                          type="button"
                          className={
                            d.done ? "habit-day-btn is-on" : "habit-day-btn"
                          }
                          aria-pressed={d.done}
                          aria-label={d.date}
                          onClick={() => void toggle(h.id, d.date)}
                        >
                          <span>{DAY_LABELS[dayIdx]}</span>
                          <span>{d.done ? "✓" : Number(d.date.slice(8))}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="habit-month-toggle">
                  <div className="month-nav">
                    <span className="editor-pane-label">Month history</span>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      aria-expanded={open}
                      onClick={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(h.id)) next.delete(h.id);
                          else next.add(h.id);
                          return next;
                        })
                      }
                    >
                      {open ? (
                        <IconChevronDown className="icon" />
                      ) : (
                        <IconChevronRight className="icon" />
                      )}
                      {open ? "Hide" : "Show"} month
                    </button>
                  </div>
                  {open ? (
                    <>
                      <div className="month-nav">
                        <button
                          type="button"
                          className="btn btn-icon"
                          aria-label="Previous month"
                          title="Previous month"
                          onClick={() => shiftMonth(-1)}
                        >
                          <IconChevronLeft className="icon" />
                        </button>
                        <span className="side-heading month-label">
                          {monthLabel(gridMonth)}
                        </span>
                        <button
                          type="button"
                          className="btn btn-icon"
                          aria-label="Next month"
                          title="Next month"
                          onClick={() => shiftMonth(1)}
                        >
                          <IconChevronRight className="icon" />
                        </button>
                      </div>

                      <table className="month-grid">
                        <caption className="visually-hidden">
                          {monthLabel(gridMonth)} for {h.name}
                        </caption>
                        <thead>
                          <tr className="week-row week-head">
                            {DAY_LABELS.map((l) => (
                              <th key={l} className="day-head" scope="col">
                                {l}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {buildMonthGrid(gridMonth, dates.get(h.id) ?? []).map(
                            (week) => (
                              <tr
                                className="week-row"
                                key={
                                  week.find((c) => c !== null)?.date ??
                                  `${gridMonth}-blank`
                                }
                              >
                                {week.map((cell, ci) => (
                                  <td
                                    key={cell?.date ?? `blank-${ci}`}
                                    className="day-td"
                                  >
                                    {cell === null ? (
                                      <span className="day-cell is-blank" />
                                    ) : (
                                      <button
                                        type="button"
                                        className={[
                                          "day-cell",
                                          cell.hasEntry ? "is-active" : "",
                                          cell.date === today ? "is-today" : "",
                                        ]
                                          .filter((c) => c.length > 0)
                                          .join(" ")}
                                        aria-pressed={cell.hasEntry}
                                        aria-label={cell.date}
                                        disabled={cell.date > today}
                                        onClick={() =>
                                          void toggle(h.id, cell.date)
                                        }
                                      >
                                        {Number(cell.date.slice(8))}
                                      </button>
                                    )}
                                  </td>
                                ))}
                              </tr>
                            ),
                          )}
                        </tbody>
                      </table>
                    </>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
