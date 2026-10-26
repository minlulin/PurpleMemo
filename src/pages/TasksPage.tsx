// P3d Tasks & reminders page: due dates, repeats (daily/weekly/
// monthly), local notifications via the Tauri notification plugin.
// Completing a repeating task rolls its due date to the next future
// occurrence (tasksRepo.completeTask) instead of closing it — the same
// function Today completes through.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { ImportDialog } from "../components/ImportDialog.tsx";
import { IconCalendar, IconTasks, IconUpload } from "../components/icons.tsx";
import { LinksSection } from "../components/LinksSection.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { useToast } from "../components/Toast.tsx";
import { useLocale, usePlural, useT } from "../components/useTranslation.ts";
import { insertImportedTasks, tasksRepo } from "../data/app.ts";
import { parseCsv, readCsvFile } from "../lib/csv.ts";
import { todayLocal } from "../lib/dates.ts";
import { errText } from "../lib/errors.ts";
import { formatDate, formatDateTime } from "../lib/format.ts";
import type { MessageKey } from "../lib/i18n.ts";
import { createLoadGuard } from "../lib/loads.ts";
import { mapTaskRows, TASK_CSV_ALIASES } from "../lib/taskImport.ts";
import type { LinkableEntity, ReminderRow, TaskRow } from "../lib/types.ts";

type Repeat = TaskRow["repeat"];

/**
 * The template CSV the import dialog hands out: the exact header the mapper
 * reads, plus one example row that shows a date, a tolerant `done` spelling
 * and a repeat value.
 */
const TASKS_TEMPLATE_CSV =
  "title,due_date,done,repeat,note\n" +
  "Pay electricity bill,2026-12-01,no,monthly,Paid online\n";

const REPEAT_LABELS: Record<Repeat, MessageKey> = {
  none: "tasks.repeat.none",
  daily: "tasks.repeat.daily",
  weekly: "tasks.repeat.weekly",
  monthly: "tasks.repeat.monthly",
};

function overdue(dueDate: string | null, today: string): boolean {
  return dueDate !== null && dueDate < today;
}

interface TasksPageProps {
  notifyNote: string | null;
  /** Bumped by the shell's poll when a reminder fires (review P3-32). */
  remindersFired: number;
  /**
   * The task to highlight on arrival, from a relationship click.
   *
   * Tasks is a flat list with no detail pane, so "opening the exact task" means
   * focusing the row rather than editing it: the row is marked, scrolled into
   * view, and its relationships are shown. Building a task editor here would be
   * a different feature.
   */
  focusId: number | null;
  focusToken?: number;
  onOpenEntity: (entity: LinkableEntity) => void;
}

export default function TasksPage({
  notifyNote,
  remindersFired,
  focusId,
  focusToken = 0,
  onOpenEntity,
}: TasksPageProps) {
  const t = useT();
  const plural = usePlural();
  const locale = useLocale();
  const toast = useToast();
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** The task a relationship sent us to; highlighted in the list. */
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [focusMissing, setFocusMissing] = useState(false);
  const focusedRef = useRef<HTMLLIElement | null>(null);
  /**
   * Row action in flight (review P2-3), one shared per-row flag exactly as
   * Today's list uses (`DashboardPage` busyRow): Complete/Reopen/remove all
   * round-trip through `reload`, and a second click on Complete before the
   * first lands would roll a repeating task two periods from one intent.
   */
  const [busyRow, setBusyRow] = useState<string | null>(null);
  /**
   * `savingRef` is the authoritative add-task guard and the state is what the
   * button reads (the pinned money-form shape): React flushes a `useState`
   * update from a discrete event before dispatching the next one, so by the
   * time a second Enter is delivered the button is already disabled *and* this
   * closure reads `true`.
   */
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);

  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [repeat, setRepeat] = useState<Repeat>("none");
  const [note, setNote] = useState("");
  /**
   * The day the loaded rows belong to (B8). The overdue badge reads this
   * instead of a date read in the render, so badge and rows come from one
   * load — `loadTasks` refreshes both.
   *
   * The WRITE path deliberately does not: `complete` calls `todayLocal()` at
   * the moment it writes. This page is the one the app stays on across
   * midnight, so a captured date would hand `completeTask` yesterday and
   * re-anchor a repeating task a day early.
   */
  const [today, setToday] = useState(() => todayLocal());
  /** Guards the list against an out-of-order load (B9). */
  const listGuard = useMemo(() => createLoadGuard(), []);
  /**
   * The filter as it is *now*, read by `reload` after a handler's awaits (B9):
   * the closure a row action holds was built in the render it was clicked in,
   * and still carries the old `showDone`.
   */
  const showDoneRef = useRef(showDone);

  /**
   * Load the list for one filter.
   *
   * Token-guarded (B9): flipping "Show done" starts a load while a row
   * action's own load may still be in flight, and without a token the older
   * one resolves last and writes rows for the other filter — the completed
   * section rendering under an unchecked box. A superseded load also may not
   * clear an error or the loading flag the current one owns.
   */
  const loadTasks = useCallback(
    async (showDoneNow: boolean) => {
      const token = listGuard.begin();
      try {
        const rows = await tasksRepo.listTasks(showDoneNow);
        if (!listGuard.isCurrent(token)) return;
        setToday(todayLocal());
        setTasks(rows);
        setError(null);
      } catch (e) {
        if (listGuard.isCurrent(token)) setError(errText(e));
      } finally {
        if (listGuard.isCurrent(token)) setLoading(false);
      }
    },
    [listGuard],
  );

  /** Refresh with the CURRENT filter — what every row action ends with. */
  const reload = useCallback(() => loadTasks(showDoneRef.current), [loadTasks]);

  // Runs on mount and on every flip of the filter: it owns the ref, so the
  // read happens before any handler awaiting this render can call `reload`.
  useEffect(() => {
    showDoneRef.current = showDone;
    // The flip is the one moment where the rows on screen are knowingly about
    // the other filter — say so, instead of leaving the skeleton to first paint.
    setLoading(true);
    void loadTasks(showDone);
  }, [loadTasks, showDone]);

  /**
   * Arrive at one exact task.
   *
   * Fetched by id rather than looked up in the list, because `listTasks(false)`
   * omits completed tasks — a link to a completed task is a real link, and
   * answering "not found" for it would be wrong. When the row is completed the
   * "Show done" box is ticked, so the highlight has something to land on.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusToken retriggers a jump to the same task
  useEffect(() => {
    if (focusId === null) return;
    let cancelled = false;
    (async () => {
      try {
        const task = await tasksRepo.getTask(focusId);
        if (cancelled) return;
        if (!task) {
          // The empty state below already says this, once (B11): an error
          // banner carrying the same sentence said it a second time.
          setFocusMissing(true);
          return;
        }
        setFocusMissing(false);
        if (task.done === 1) setShowDone(true);
        else setShowDone(false);
        setFocusedId(task.id);
      } catch (e) {
        if (!cancelled) setError(errText(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [focusId, focusToken]);

  // The row may only appear after `showDone` flips, so scroll when the list
  // changes rather than when the focus is set.
  // biome-ignore lint/correctness/useExhaustiveDependencies: signal, not data
  useEffect(() => {
    if (focusedId === null) return;
    focusedRef.current?.scrollIntoView({ block: "center" });
  }, [focusedId, tasks]);

  /** The focused task's relationships, or nothing when none is focused. */
  const focusedTask = tasks.find((t) => t.id === focusedId) ?? null;

  const addTask = async () => {
    if (savingRef.current) return;
    const trimmed = title.trim();
    if (trimmed.length === 0) return;
    savingRef.current = true;
    setSaving(true);
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
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const complete = async (t: TaskRow) => {
    if (busyRow !== null) return;
    setBusyRow(`task:${t.id}`);
    try {
      // The repo owns the repeat roll — Today completes
      // through this same function, so the two surfaces cannot drift.
      // The date is read HERE (B8), not from the render the click came from.
      await tasksRepo.completeTask(t.id, todayLocal());
      await reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusyRow(null);
    }
  };

  const reopen = async (t: TaskRow) => {
    if (busyRow !== null) return;
    setBusyRow(`task:${t.id}`);
    try {
      await tasksRepo.toggleTask(t.id, false);
      await reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusyRow(null);
    }
  };

  const remove = async (id: number) => {
    if (busyRow !== null) return;
    setBusyRow(`task:${id}`);
    try {
      await tasksRepo.deleteTask(id);
      await reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusyRow(null);
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
              <h2 className="editor-title">{t("tasks.title")}</h2>
              <p className="page-subtitle">{t("tasks.subtitle")}</p>
            </div>
          </div>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setImportOpen(true)}
          >
            <IconUpload className="icon" />
            {t("tasks.importCsv")}
          </button>
        </div>
      </header>

      {loading ? <Skeleton count={3} /> : null}
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
        <section className="settings-section" aria-label={t("tasks.openAria")}>
          <div className="dash-card-head">
            <h2 className="side-heading">{t("tasks.open")}</h2>
            <label className="check-label">
              <input
                type="checkbox"
                checked={showDone}
                onChange={(e) => setShowDone(e.target.checked)}
              />{" "}
              {t("tasks.showDone")}
            </label>
          </div>

          {open.length === 0 ? (
            <EmptyState>{t("tasks.empty")}</EmptyState>
          ) : (
            <ul className="budget-list">
              {open.map((task) => (
                <li
                  key={task.id}
                  className={`budget-row${focusedId === task.id ? " is-focused" : ""}`}
                  ref={focusedId === task.id ? focusedRef : undefined}
                >
                  <div className="row-main">
                    <span className="row-title">
                      <b>{task.title}</b>
                      {overdue(task.due_date, today) ? (
                        <span className="badge badge-danger" role="status">
                          {t("tasks.overdue")}
                        </span>
                      ) : null}
                      {task.due_date ? (
                        <span className="chip figure">
                          {t("tasks.due", {
                            date: formatDate(locale, task.due_date),
                          })}
                        </span>
                      ) : null}
                      {task.repeat !== "none" ? (
                        <span className="badge badge-accent">
                          {t(REPEAT_LABELS[task.repeat])}
                        </span>
                      ) : null}
                    </span>
                    {task.note ? (
                      <span className="row-sub">{task.note}</span>
                    ) : null}
                  </div>
                  <span className="row-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busyRow !== null}
                      onClick={() => void complete(task)}
                    >
                      {t("tasks.done")}
                    </button>
                    <ConfirmButton
                      className="btn btn-ghost"
                      what={t("tasks.deleteWhat")}
                      disabled={busyRow !== null}
                      onConfirm={() => remove(task.id)}
                    >
                      {t("tasks.moveToTrash")}
                    </ConfirmButton>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {done.length > 0 ? (
            <div className="contact-section">
              <h3 className="side-heading">{t("tasks.completed")}</h3>
              <ul className="budget-list">
                {done.map((task) => (
                  <li
                    key={task.id}
                    className={`budget-row${focusedId === task.id ? " is-focused" : ""}`}
                    ref={focusedId === task.id ? focusedRef : undefined}
                  >
                    <span className="muted">{task.title}</span>
                    <span className="row-actions">
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={busyRow !== null}
                        onClick={() => void reopen(task)}
                      >
                        {t("tasks.reopen")}
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        {/*
          Where a relationship click lands: the row is highlighted above, and
          its relationships are editable right here. A task that was deleted in
          the meantime says so rather than showing an empty page.
        */}
        {focusMissing ? (
          <section className="settings-section">
            <EmptyState>{t("tasks.missing")}</EmptyState>
          </section>
        ) : null}
        {focusedTask !== null ? (
          <LinksSection
            entity={{ type: "task", id: focusedTask.id }}
            onOpenEntity={onOpenEntity}
          />
        ) : null}

        <form
          className="entry-form"
          onSubmit={(e) => {
            e.preventDefault();
            void addTask();
          }}
        >
          <h2 className="side-heading">{t("tasks.newTask")}</h2>
          <label>
            {t("tasks.titleLabel")}
            <input
              value={title}
              placeholder={t("tasks.titlePlaceholder")}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <div className="form-grid">
            <label>
              {t("tasks.dueLabel")}
              <span className="input-icon-wrap">
                <input
                  type="date"
                  aria-label={t("tasks.dueAria")}
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
                <IconCalendar className="icon input-icon is-end" />
              </span>
            </label>
            <label>
              {t("tasks.repeatLabel")}
              <select
                aria-label={t("tasks.repeatAria")}
                value={repeat}
                onChange={(e) => setRepeat(e.target.value as Repeat)}
              >
                {(Object.keys(REPEAT_LABELS) as Repeat[]).map((value) => (
                  <option key={value} value={value}>
                    {t(REPEAT_LABELS[value])}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            {t("tasks.noteLabel")}
            <input
              value={note}
              placeholder={t("tasks.notePlaceholder")}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <div className="row-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={saving || title.trim().length === 0}
            >
              {t("tasks.add")}
            </button>
          </div>
        </form>
      </div>

      <RemindersSection refreshKey={remindersFired} />

      {importOpen ? (
        <ImportDialog
          title={t("tasks.importTitle")}
          templateCsv={TASKS_TEMPLATE_CSV}
          templateName="purple-memo-tasks-template.csv"
          onPick={readCsvFile}
          parse={(text) =>
            mapTaskRows(parseCsv(text, ["title"], TASK_CSV_ALIASES).rows)
          }
          columns={[
            { key: "title", label: t("tasks.titleLabel") },
            {
              key: "due_date",
              label: t("tasks.dueColumn"),
              render: (row) =>
                row.due_date === null ? "—" : formatDate(locale, row.due_date),
            },
            {
              key: "done",
              label: t("tasks.doneColumn"),
              render: (row) =>
                row.done === 1 ? t("import.yes") : t("import.no"),
            },
            {
              key: "repeat",
              label: t("tasks.repeatLabel"),
              render: (row) => t(REPEAT_LABELS[row.repeat]),
            },
            {
              key: "note",
              label: t("tasks.noteColumn"),
              render: (row) => (row.note === "" ? "—" : row.note),
            },
          ]}
          onConfirm={async (rows) => {
            // One batch; a failure throws before the list refresh and the
            // toast, and the dialog keeps its preview for a retry.
            await insertImportedTasks(rows);
            await reload();
            toast.success(plural("tasks.imported", rows.length));
            return { imported: rows.length };
          }}
          onClose={() => setImportOpen(false)}
        />
      ) : null}
    </div>
  );
}

const REMINDER_REPEATS = ["none", "daily", "weekly", "monthly"] as const;

function RemindersSection({ refreshKey }: { refreshKey: number }) {
  const t = useT();
  const locale = useLocale();
  const [reminders, setReminders] = useState<ReminderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [remindAt, setRemindAt] = useState("");
  const [repeat, setRepeat] = useState<"none" | "daily" | "weekly" | "monthly">(
    "none",
  );
  /** Draft snooze timestamps, keyed by reminder id. */
  const [snoozeDrafts, setSnoozeDrafts] = useState<Record<number, string>>({});
  /** Add-reminder submit guard: ref authoritative, state for the button. */
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  /**
   * Row action in flight — the page's `busyRow` shape, scoped to this section
   * (B10). The three handlers below used to have no flag at all, so a second
   * click fired a second write; harmless while they are idempotent, and a
   * double write the moment `acknowledge` grows a state column.
   */
  const [busyRow, setBusyRow] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      // Fired one-shots included: `fired` means handed to the
      // OS, not seen, so a fired reminder stays listed — badged "Fired" —
      // until the user acknowledges or snoozes it, instead of vanishing.
      setReminders(await tasksRepo.listReminders(true));
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  // Re-reads on mount and whenever the shell reports a fired reminder
  // (review P3-32) — otherwise a reminder marked fired by the background poll
  // stayed on this list as pending until the user navigated away and back.
  //
  // `refreshKey` is deliberately not read in the body: it is a signal, not
  // data, and its whole job is to change this effect's identity. Keying the
  // component on it instead would be tidier but would remount the section and
  // discard a half-typed new-reminder form if one happened to be open when a
  // reminder fired — trading a stale row for lost typing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: signal, not data
  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  const add = async () => {
    if (savingRef.current) return;
    const trimmed = title.trim();
    if (trimmed.length === 0 || remindAt === "") return;
    savingRef.current = true;
    setSaving(true);
    try {
      await tasksRepo.createReminder({ title: trimmed, remindAt, repeat });
      setTitle("");
      setRemindAt("");
      // Reset the repeat too (B10) — `addTask` does the same. Leaving it where
      // the last reminder put it silently created more daily reminders after
      // one daily and several one-offs.
      setRepeat("none");
      await reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const remove = async (id: number) => {
    if (busyRow !== null) return;
    setBusyRow(`reminder:${id}`);
    try {
      await tasksRepo.deleteReminder(id);
      await reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusyRow(null);
    }
  };

  /**
   * Snooze/rearm to an explicit timestamp. One repo call
   * covers pending and fired rows: `rescheduleReminder` writes the time and
   * clears `fired`, so a fired one-shot returns to the pending list at the
   * new time and a repeating one keeps its `nextReminderAt` anchor.
   */
  const snooze = async (id: number) => {
    // Flag first, then validation — the pinned order, so the guard is what the
    // second click meets rather than a form check it happens to pass.
    if (busyRow !== null) return;
    const at = snoozeDrafts[id] ?? "";
    if (at === "") return;
    setBusyRow(`reminder:${id}`);
    try {
      await tasksRepo.rescheduleReminder(id, at);
      setSnoozeDrafts((d) => ({ ...d, [id]: "" }));
      await reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusyRow(null);
    }
  };

  /**
   * Acknowledge a fired reminder. A one-shot has no purpose
   * after it fires, so acknowledging resolves it by deleting the row — no
   * schema column, no hidden "seen" state that could disagree with the list.
   */
  const acknowledge = async (id: number) => {
    if (busyRow !== null) return;
    setBusyRow(`reminder:${id}`);
    try {
      await tasksRepo.deleteReminder(id);
      await reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusyRow(null);
    }
  };

  return (
    <section className="settings-section" aria-label={t("tasks.remindersAria")}>
      <div className="dash-card-head">
        <h2 className="side-heading">{t("tasks.remindersHeading")}</h2>
        <span className="badge">{reminders.length}</span>
      </div>
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      {reminders.length === 0 ? (
        <p className="muted">{t("tasks.noReminders")}</p>
      ) : (
        <ul className="budget-list">
          {reminders.map((r) => (
            <li key={r.id} className="budget-row">
              <div className="row-main">
                <span className="row-title">
                  <b>{r.title}</b>
                  <span className="chip figure">
                    {formatDateTime(locale, r.remind_at)}
                  </span>
                  {r.fired === 1 ? (
                    <span className="badge badge-warn">{t("tasks.fired")}</span>
                  ) : r.repeat !== "none" ? (
                    <span className="badge badge-accent">
                      {t(REPEAT_LABELS[r.repeat])}
                    </span>
                  ) : null}
                </span>
                <span className="row-actions">
                  <input
                    type="datetime-local"
                    aria-label={t("tasks.snoozeUntil", { title: r.title })}
                    value={snoozeDrafts[r.id] ?? ""}
                    onChange={(e) =>
                      setSnoozeDrafts((d) => ({ ...d, [r.id]: e.target.value }))
                    }
                  />
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={
                      busyRow !== null || (snoozeDrafts[r.id] ?? "") === ""
                    }
                    onClick={() => void snooze(r.id)}
                  >
                    {t("tasks.snooze")}
                  </button>
                  {r.fired === 1 ? (
                    <ConfirmButton
                      className="btn btn-ghost"
                      what={t("tasks.acknowledgeWhat")}
                      disabled={busyRow !== null}
                      onConfirm={() => acknowledge(r.id)}
                    >
                      {t("tasks.acknowledge")}
                    </ConfirmButton>
                  ) : null}
                  <ConfirmButton
                    className="btn btn-ghost"
                    what={t("tasks.reminderWhat")}
                    disabled={busyRow !== null}
                    onConfirm={() => remove(r.id)}
                  >
                    {t("common.delete")}
                  </ConfirmButton>
                </span>
              </div>
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
          aria-label={t("tasks.reminderTitleAria")}
          placeholder={t("tasks.reminderTitlePlaceholder")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <input
          type="datetime-local"
          aria-label={t("tasks.remindAtAria")}
          value={remindAt}
          onChange={(e) => setRemindAt(e.target.value)}
        />
        <select
          className="select"
          aria-label={t("tasks.reminderRepeatAria")}
          value={repeat}
          onChange={(e) =>
            setRepeat(e.target.value as "none" | "daily" | "weekly" | "monthly")
          }
        >
          {REMINDER_REPEATS.map((value) => (
            <option key={value} value={value}>
              {t(REPEAT_LABELS[value])}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={saving || title.trim().length === 0 || remindAt === ""}
        >
          {t("tasks.addReminder")}
        </button>
      </form>
    </section>
  );
}
