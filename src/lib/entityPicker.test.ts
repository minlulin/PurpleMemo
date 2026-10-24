import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  PICKER_PER_TYPE_CAP,
  PICKER_TOTAL_CAP,
  pickerResults,
  pickerRowLabel,
} from "./entityPicker.ts";
import type { ContactRow, NoteRow, TaskRow } from "./types.ts";

function note(id: number, over: Partial<NoteRow> = {}): NoteRow {
  return {
    id,
    title: `Note ${id}`,
    content: "",
    tags: "",
    collection_id: null,
    pinned: 0,
    archived: 0,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    ...over,
  };
}

function task(id: number, over: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    title: `Task ${id}`,
    due_date: null,
    done: 0,
    repeat: "none",
    note: "",
    created_at: "2026-01-01",
    ...over,
  };
}

function contact(id: number, over: Partial<ContactRow> = {}): ContactRow {
  return {
    id,
    name: `Contact ${id}`,
    address: "",
    birthday: null,
    notes: "",
    created_at: "2026-01-01",
    ...over,
  };
}

const FROM = { type: "note" as const, id: 1 };

test("every live row of all three types is offered", () => {
  const result = pickerResults(
    { notes: [note(2), note(3)], tasks: [task(1)], contacts: [contact(1)] },
    { from: FROM },
  );
  assert.equal(result.hits.length, 4);
  assert.equal(result.capped, false);
});

test("the entity the relationship starts from is never offered", () => {
  const result = pickerResults(
    { notes: [note(1), note(2)], tasks: [], contacts: [] },
    { from: FROM },
  );
  assert.deepEqual(
    result.hits.map((h) => h.entity.id),
    [2],
  );
});

test("already-linked rows are not offered again", () => {
  const result = pickerResults(
    {
      notes: [note(2), note(3)],
      tasks: [task(1)],
      contacts: [],
      alreadyLinked: [{ type: "task", id: 1 }],
    },
    { from: FROM },
  );
  assert.deepEqual(
    result.hits.map((h) => `${h.entity.type}${h.entity.id}`),
    ["note2", "note3"],
  );
});

test("archived notes and completed tasks are hidden unless asked for", () => {
  const source = {
    notes: [note(2, { archived: 1 }), note(3)],
    tasks: [task(1, { done: 1 }), task(2)],
    contacts: [],
  };
  const hidden = pickerResults(source, { from: FROM });
  assert.deepEqual(
    hidden.hits.map((h) => `${h.entity.type}${h.entity.id}`),
    ["note3", "task2"],
  );
  const shown = pickerResults(source, { from: FROM, includeInactive: true });
  assert.equal(shown.hits.length, 4);
  assert.equal(shown.hits.filter((h) => h.state !== null).length, 2);
});

test("a live row outranks an inactive one with the same title", () => {
  const result = pickerResults(
    {
      notes: [
        note(2, { title: "Same", archived: 1 }),
        note(3, { title: "Same" }),
      ],
      tasks: [],
      contacts: [],
    },
    { from: FROM, includeInactive: true },
  );
  assert.deepEqual(
    result.hits.map((h) => h.entity.id),
    [3, 2],
  );
});

test("the search is case-insensitive and covers the fields a person would use", () => {
  const source = {
    notes: [note(2, { title: "Groceries", content: "milk and eggs" })],
    tasks: [task(1, { title: "Pay rent", note: "by friday" })],
    contacts: [contact(1, { name: "Aunt Ma", address: "Bahan" })],
  };
  assert.equal(
    pickerResults(source, { from: FROM, query: "GROCER" }).hits.length,
    1,
  );
  assert.equal(
    pickerResults(source, { from: FROM, query: "eggs" }).hits.length,
    1,
  );
  assert.equal(
    pickerResults(source, { from: FROM, query: "bahan" }).hits.length,
    1,
  );
  assert.equal(
    pickerResults(source, { from: FROM, query: "nothing here" }).hits.length,
    0,
  );
  // An empty query is not a filter: everything comes back.
  assert.equal(
    pickerResults(source, { from: FROM, query: "   " }).hits.length,
    3,
  );
});

test("Burmese text matches however the keyboard composed it", () => {
  const source = {
    notes: [note(2, { title: "မြန်မာ စာရေးရန်" })],
    tasks: [],
    contacts: [],
  };
  // Both sides are normalized to NFC and stripped of combining marks, so the
  // same word typed in a different composition is still the same search.
  assert.equal(
    pickerResults(source, { from: FROM, query: "မြန်မာ" }).hits.length,
    1,
  );
  assert.equal(
    pickerResults(source, { from: FROM, query: "မွန္မာ" }).hits.length,
    1,
  );
  // A word that appears later in the title, and one that does not appear at all.
  assert.equal(
    pickerResults(source, { from: FROM, query: "စာရေး" }).hits.length,
    1,
  );
  // A different word still does not match.
  assert.equal(
    pickerResults(source, { from: FROM, query: "မြန်မာတို့" }).hits.length,
    0,
  );
});

test("an untitled row still has a label", () => {
  const result = pickerResults(
    { notes: [note(2, { title: "   " })], tasks: [], contacts: [] },
    { from: FROM },
  );
  assert.equal(result.hits[0]?.label, "Untitled note");
});

test("results are capped per type and in total, and say so", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => note(i + 10));
  const capped = pickerResults(
    { notes: many(40), tasks: [], contacts: [] },
    { from: FROM },
  );
  assert.equal(capped.hits.length, PICKER_PER_TYPE_CAP);
  assert.equal(capped.capped, true);
  assert.equal(
    capped.matched,
    40,
    "the true count is reported, not the capped one",
  );

  const byType = pickerResults(
    {
      notes: many(30),
      tasks: Array.from({ length: 30 }, (_, i) => task(i + 10)),
      contacts: [],
    },
    { from: FROM },
  );
  assert.equal(byType.hits.length, PICKER_TOTAL_CAP, "the total cap wins");
  assert.equal(byType.capped, true);
  assert.equal(
    byType.hits.filter((h) => h.entity.type === "note").length,
    PICKER_PER_TYPE_CAP,
    "no type may take more than its share",
  );
});

test("an untitled note's content becomes its detail, not its label", () => {
  const result = pickerResults(
    {
      notes: [note(2, { title: "", content: "first line\nsecond line" })],
      tasks: [],
      contacts: [],
    },
    { from: FROM },
  );
  assert.equal(result.hits[0]?.label, "Untitled note");
  assert.equal(result.hits[0]?.detail, "first line second line");
});

test("a row's wording names its kind, so two 'Same' rows are told apart", () => {
  const result = pickerResults(
    {
      notes: [note(2, { title: "Same" })],
      tasks: [task(1, { title: "Same" })],
      contacts: [],
    },
    { from: FROM },
  );
  const labels = result.hits.map(pickerRowLabel);
  assert.ok(labels.includes("Note · Same"), labels.join(" | "));
  assert.ok(labels.includes("Task · Same"), labels.join(" | "));
});

test("a due date and a birthday show as the disambiguating detail", () => {
  const result = pickerResults(
    {
      notes: [],
      tasks: [task(1, { due_date: "2026-10-20" })],
      contacts: [contact(1, { birthday: "1990-04-01" })],
    },
    { from: FROM },
  );
  const byKind = new Map(
    result.hits.map((h) => [`${h.entity.type}:${h.entity.id}`, h]),
  );
  assert.equal(byKind.get("task:1")?.detail, "Due 2026-10-20");
  assert.equal(byKind.get("contact:1")?.detail, "Birthday 1990-04-01");
});

// The sortKey separators above are written as the `\u0000` escape, never as a
// raw NUL byte: a literal 0x00 in a source file is invisible in review and in
// most diffs, and it made the file register as binary.
// This pins that no TypeScript source under src/ ever carries one again.
test("no source file under src/ contains a raw NUL byte", () => {
  const srcRoot = new URL("../", import.meta.url);
  const seen: string[] = [];
  const walk = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      seen.push(entry.name);
      const bytes = readFileSync(full);
      const nul = bytes.indexOf(0);
      assert.equal(nul, -1, `${entry.name} has a raw NUL byte at ${nul}`);
    }
  };
  walk(srcRoot);
  assert.ok(seen.length > 50, `walked ${seen.length} files`);
});
