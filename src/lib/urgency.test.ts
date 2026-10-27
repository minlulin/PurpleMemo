// Dashboard urgency rule (plan §A.2): fixed thresholds on local calendar
// days — overdue / soon (today..+3) / ok / none.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { addDays } from "./dates.ts";
import { badgeFor, urgencyFor } from "./urgency.ts";

const TODAY = "2026-10-11";

test("urgencyFor: yesterday is overdue", () => {
  assert.equal(urgencyFor("2026-10-10", TODAY), "overdue");
});

test("urgencyFor: today is soon (calendar day, not 24h)", () => {
  assert.equal(urgencyFor(TODAY, TODAY), "soon");
});

test("urgencyFor: today + 3 days is still soon", () => {
  assert.equal(urgencyFor(addDays(TODAY, 3), TODAY), "soon");
});

test("urgencyFor: today + 4 days is ok", () => {
  assert.equal(urgencyFor(addDays(TODAY, 4), TODAY), "ok");
});

test("urgencyFor: null due date is none", () => {
  assert.equal(urgencyFor(null, TODAY), "none");
});

test("badgeFor maps each urgency to its badge class", () => {
  assert.equal(badgeFor("overdue"), "badge badge-danger");
  assert.equal(badgeFor("soon"), "badge badge-warn");
  assert.equal(badgeFor("ok"), "badge badge-success");
  assert.equal(badgeFor("none"), "badge");
});
