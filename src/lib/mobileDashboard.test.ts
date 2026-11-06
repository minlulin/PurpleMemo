import { strict as assert } from "node:assert";
import { test } from "node:test";
import { habitDoneToday, pinnedNotes, urgentTasks } from "./mobileDashboard.ts";
import type { NoteListRow, TaskRow } from "./types.ts";

function task(patch: Partial<TaskRow> & { id: number }): TaskRow {
  return {
    title: `Task ${patch.id}`,
    due_date: null,
    done: 0,
    repeat: "none",
    note: "",
    created_at: "2026-11-01",
    uid: null,
    ...patch,
  };
}

function note(patch: Partial<NoteListRow> & { id: number }): NoteListRow {
  return {
    title: `Note ${patch.id}`,
    content: "",
    tags: "",
    collection_id: null,
    pinned: 0,
    archived: 0,
    created_at: "2026-11-01",
    updated_at: "2026-11-01",
    uid: null,
    ...patch,
  };
}

test("urgentTasks keeps only open tasks due today or earlier", () => {
  const rows = urgentTasks(
    [
      task({ id: 1, due_date: "2026-11-07" }), // tomorrow — not urgent
      task({ id: 2, due_date: "2026-11-06" }), // today
      task({ id: 3, due_date: "2026-11-01" }), // overdue
      task({ id: 4, due_date: null }), // undated
      task({ id: 5, due_date: "2026-11-05", done: 1 }), // completed
    ],
    "2026-11-06",
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    [3, 2],
    "overdue first, then today; nothing future, undated or done",
  );
});

test("urgentTasks breaks same-day ties by id and never mutates the input", () => {
  const input = [
    task({ id: 9, due_date: "2026-11-06" }),
    task({ id: 4, due_date: "2026-11-06" }),
    task({ id: 7, due_date: "2026-11-02" }),
  ];
  const rows = urgentTasks(input, "2026-11-06");
  assert.deepEqual(
    rows.map((row) => row.id),
    [7, 4, 9],
  );
  assert.deepEqual(
    input.map((row) => row.id),
    [9, 4, 7],
  );
});

test("pinnedNotes drops unpinned and archived rows", () => {
  const rows = pinnedNotes([
    note({ id: 1, pinned: 1 }),
    note({ id: 2, pinned: 0 }),
    note({ id: 3, pinned: 1, archived: 1 }),
  ]);
  assert.deepEqual(
    rows.map((row) => row.id),
    [1],
  );
});

test("habitDoneToday reads today's entry out of the week", () => {
  const week = [
    { date: "2026-11-05", done: true },
    { date: "2026-11-06", done: false },
  ];
  assert.equal(habitDoneToday(week, "2026-11-06"), false);
  assert.equal(habitDoneToday(week, "2026-11-05"), true);
  assert.equal(habitDoneToday([], "2026-11-06"), false);
});
