// The phone's Tasks screen and its create form.

import { useCallback, useState } from "react";
import { tasksRepo } from "../../data/app.ts";
import { todayLocal } from "../../lib/dates.ts";
import type { TaskRow } from "../../lib/types.ts";
import { EmptyState } from "../EmptyState.tsx";
import { useT } from "../useTranslation.ts";
import { LoadMessage, useLoad } from "./common.tsx";
import { RemindersPanel } from "./reminders.tsx";

export function TasksScreen({ onCompose }: { onCompose: () => void }) {
  const t = useT();
  const load = useCallback(() => tasksRepo.listTasks(true), []);
  const { data, failed, reload } = useLoad(load);
  const [busyId, setBusyId] = useState<number | null>(null);

  const toggle = async (task: TaskRow) => {
    setBusyId(task.id);
    try {
      await tasksRepo.toggleTask(task.id, task.done === 0);
      reload();
    } finally {
      setBusyId(null);
    }
  };

  const tasks = data ?? [];
  const open = tasks.filter((task) => task.done === 0);
  const done = tasks.filter((task) => task.done === 1);

  return (
    <section className="mobile-page">
      <p className="mobile-section-kicker">{t("tasks.title")}</p>
      <div className="mobile-actions">
        <button type="button" className="btn btn-primary" onClick={onCompose}>
          {t("tasks.newTask")}
        </button>
      </div>
      <LoadMessage failed={failed} />
      {data !== null && open.length === 0 ? (
        <EmptyState>{t("tasks.empty")}</EmptyState>
      ) : null}
      <ul className="mobile-list" aria-label={t("tasks.openAria")}>
        {open.map((task) => (
          <li key={task.id}>
            <label className="mobile-row">
              <input
                type="checkbox"
                checked={false}
                disabled={busyId === task.id}
                aria-label={t("mobile.markDoneOf", { title: task.title })}
                onChange={() => void toggle(task)}
              />
              <span className="mobile-row-text">
                {task.title}
                {task.due_date !== null ? (
                  <span className="mobile-row-meta">
                    {task.due_date < todayLocal()
                      ? t("tasks.overdue")
                      : t("tasks.due", { date: task.due_date })}
                  </span>
                ) : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {done.length > 0 ? (
        <>
          <p className="mobile-section-kicker">{t("tasks.completed")}</p>
          <ul className="mobile-list" aria-label={t("tasks.completed")}>
            {done.map((task) => (
              <li key={task.id}>
                <label className="mobile-row is-done">
                  <input
                    type="checkbox"
                    checked
                    disabled={busyId === task.id}
                    aria-label={t("mobile.markNotDoneOf", {
                      title: task.title,
                    })}
                    onChange={() => void toggle(task)}
                  />
                  <span className="mobile-row-text">{task.title}</span>
                </label>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <RemindersPanel />
    </section>
  );
}

export function TaskCompose({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const save = async () => {
    if (title.trim() === "" || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await tasksRepo.createTask({
        title: title.trim(),
        dueDate: dueDate === "" ? null : dueDate,
      });
      onDone();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mobile-page">
      <form
        className="mobile-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="mobile-field">
          <span>{t("tasks.titleLabel")}</span>
          <input
            className="input"
            type="text"
            value={title}
            placeholder={t("tasks.titlePlaceholder")}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
        </label>
        <label className="mobile-field">
          <span>{t("tasks.dueLabel")}</span>
          <input
            className="input"
            type="date"
            value={dueDate}
            aria-label={t("tasks.dueAria")}
            onChange={(event) => setDueDate(event.currentTarget.value)}
          />
        </label>
        <LoadMessage failed={failed} />
        <div className="mobile-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || title.trim() === ""}
          >
            {busy ? t("notes.saving") : t("tasks.add")}
          </button>
        </div>
      </form>
    </section>
  );
}
