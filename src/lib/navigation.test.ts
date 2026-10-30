import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ENTITY_PAGE, focusedRowFor } from "./navigation.ts";

test("ENTITY_PAGE: every linkable kind maps to the page that shows it", () => {
  // The whole map, in one place: a new linkable kind must pick a page here
  // or it does not compile.
  assert.deepEqual(ENTITY_PAGE, {
    note: "notes",
    task: "tasks",
    contact: "contacts",
  });
});

test("focusedRowFor: a focus of the page's own kind selects its id", () => {
  assert.equal(focusedRowFor({ type: "note", id: 7 }, "note"), 7);
  assert.equal(focusedRowFor({ type: "task", id: 3 }, "task"), 3);
  assert.equal(focusedRowFor({ type: "contact", id: 1 }, "contact"), 1);
});

test("focusedRowFor: the wrong kind or no focus selects nothing", () => {
  // The two id-taking pages are distinguished only by this type check —
  // a task focus must never select note 7.
  assert.equal(
    focusedRowFor({ type: "task", id: 7 }, "note"),
    null,
    "a task target can never select note 7",
  );
  assert.equal(focusedRowFor(null, "note"), null);
});

test("focusedRowFor: an id that cannot name a real row selects nothing (J8)", () => {
  for (const id of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
    assert.equal(
      focusedRowFor({ type: "note", id }, "note"),
      null,
      `id ${id} cannot name a row and must not be handed to a page`,
    );
  }
});
