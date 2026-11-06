// The phone Dashboard's rules, kept out of the React tree so they can be
// pinned by tests: which tasks are urgent, which notes are pinned, and whether
// a habit is already checked in today.
//
// Pure functions over rows the repos already loaded — no driver, no SQL. The
// Dashboard never computes a number of its own from nothing: every value it
// shows is either a row it was given or a sum of rows it was given.

import type { NoteListRow, TaskRow } from "./types.ts";

/**
 * Open tasks due today or earlier, soonest first.
 *
 * An overdue task is the most urgent thing on the screen, so it sorts to the
 * front by its own date; undated and completed rows never appear.
 */
export function urgentTasks(tasks: TaskRow[], today: string): TaskRow[] {
  return tasks
    .filter(
      (task): task is TaskRow & { due_date: string } =>
        task.done === 0 && task.due_date !== null && task.due_date <= today,
    )
    .sort((a, b) =>
      a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : a.id - b.id,
    );
}

/** Pinned, live notes — the Dashboard preview, in the order the repo returned. */
export function pinnedNotes(notes: NoteListRow[]): NoteListRow[] {
  return notes.filter((note) => note.pinned === 1 && note.archived === 0);
}

/** True when today's check-in is already logged for this habit. */
export function habitDoneToday(
  week: { date: string; done: boolean }[],
  today: string,
): boolean {
  return week.some((day) => day.date === today && day.done);
}
