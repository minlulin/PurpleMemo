// P3d Habits page (§2.7): daily logs, current/best streaks, week progress,
// month grid. Pure streak/week math lives in lib/habits.ts; the month grid
// is reused from the journal (same Sunday-start grid, §2.5).

import { useCallback, useEffect, useState } from "react";
import { habitsRepo } from "../data/app.ts";
import { todayLocal, yearMonthOf } from "../lib/dates.ts";
import { buildMonthGrid, monthLabel } from "../lib/journal.ts";
import type { HabitRow } from "../lib/types.ts";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface HabitProgress {
  habit: HabitRow | undefined;
  current: number;
  best: number;
  week: { date: string; done: boolean }[];
}

export default function HabitsPage() {
  const today = todayLocal();
  const [habits, setHabits] = useState<HabitRow[]>([]);
  const [progress, setProgress] = useState<Map<number, HabitProgress>>(
    new Map(),
  );
  const [dates, setDates] = useState<Map<number, string[]>>(new Map());
  const [gridMonth, setGridMonth] = useState(() => yearMonthOf(todayLocal()));
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
    const [y, m] = gridMonth.split("-").map(Number);
    if (!y || !m) return;
    const d = new Date(y, m - 1 + delta, 1);
    setGridMonth(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
    );
  };

  const DAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

  return (
    <div className="budget-page">
      {loading ? <p className="muted">Loading…</p> : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

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
          Add habit
        </button>
      </form>

      {habits.length === 0 ? (
        <p className="muted">No habits yet — add one above.</p>
      ) : (
        habits.map((h) => {
          const p = progress.get(h.id);
          const doneToday =
            p?.week.find((d) => d.date === today)?.done ?? false;
          return (
            <section key={h.id} className="budget-manage" aria-label={h.name}>
              <div className="budget-row">
                <span>{h.name}</span>
                <span className="muted">
                  streak {p?.current ?? 0} · best {p?.best ?? 0}
                </span>
                <span className="row-actions">
                  <button
                    type="button"
                    className={doneToday ? "btn is-on" : "btn"}
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

              <div className="day-nav">
                {(p?.week ?? []).map((d) => (
                  <button
                    key={d.date}
                    type="button"
                    className={d.done ? "btn is-on" : "btn"}
                    aria-pressed={d.done}
                    aria-label={d.date}
                    onClick={() => void toggle(h.id, d.date)}
                  >
                    {d.done
                      ? "✓"
                      : DAY_LABELS[new Date(`${d.date}T00:00:00`).getDay()]}
                  </button>
                ))}
              </div>

              <div className="day-nav">
                <button
                  type="button"
                  className="btn"
                  onClick={() => shiftMonth(-1)}
                >
                  ◀
                </button>
                <span className="side-heading month-label">
                  {monthLabel(gridMonth)}
                </span>
                <button
                  type="button"
                  className="btn"
                  onClick={() => shiftMonth(1)}
                >
                  ▶
                </button>
              </div>
              <table className="year-table">
                <caption className="visually-hidden">
                  {monthLabel(gridMonth)} for {h.name}
                </caption>
                <thead>
                  <tr>
                    {DAY_LABELS.map((l) => (
                      <th key={l} scope="col">
                        {l}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {buildMonthGrid(gridMonth, dates.get(h.id) ?? []).map(
                    (week) => (
                      <tr
                        key={
                          week.find((c) => c !== null)?.date ??
                          `${gridMonth}-blank`
                        }
                      >
                        {week.map((cell, ci) => (
                          <td key={cell?.date ?? `blank-${ci}`}>
                            {cell === null ? (
                              ""
                            ) : (
                              <button
                                type="button"
                                className={
                                  cell.hasEntry ? "btn is-on" : "btn btn-ghost"
                                }
                                aria-pressed={cell.hasEntry}
                                aria-label={cell.date}
                                onClick={() => void toggle(h.id, cell.date)}
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
            </section>
          );
        })
      )}
    </div>
  );
}
