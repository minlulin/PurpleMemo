// The Android reminder seam has no device here, but its rules are pure and
// worth pinning: no reminder text in the alarm with previews off, and an alarm
// that already fired must settle its row exactly like the desktop ticker would.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  deliveredOutcomes,
  isAndroidPlatform,
  missedOutcomes,
  reminderSyncRows,
} from "./android-reminders.ts";
import type { ReminderRow } from "./types.ts";

function row(over: Partial<ReminderRow> = {}): ReminderRow {
  return {
    id: 1,
    title: "Water the plants",
    remind_at: "2026-11-03T14:05",
    repeat: "none",
    note: "kitchen + balcony",
    fired: 0,
    created_at: "2026-11-01T08:00",
    ...over,
  };
}

test("with previews off the alarm carries no reminder text", () => {
  const [payload] = reminderSyncRows([row()], false);
  assert.ok(payload);
  assert.equal(payload.title, "Reminder due");
  assert.equal(payload.body, "Open Purple Memo to see the reminder.");
  assert.ok(!JSON.stringify(payload).includes("plants"), "no title leak");
  assert.ok(!JSON.stringify(payload).includes("balcony"), "no note leak");
  assert.equal(payload.due, "2026-11-03T14:05");
});

test("with previews on the alarm carries the reminder text", () => {
  const [payload] = reminderSyncRows([row()], true);
  assert.equal(payload?.title, "Reminder: Water the plants");
  assert.equal(payload?.body, "kitchen + balcony");
});

test("an already-fired row is not armed again", () => {
  assert.deepEqual(reminderSyncRows([row({ fired: 1 })], true), []);
});

test("a delivered one-shot settles as fired; a repeating one re-arms", () => {
  const outcomes = deliveredOutcomes(
    [
      row({ id: 4 }),
      row({ id: 9, repeat: "daily", remind_at: "2026-11-01T09:00" }),
    ],
    [4, 9],
    "2026-11-03T14:10",
  );
  assert.deepEqual(outcomes, [
    { id: 4, nextRemindAt: null },
    // The next occurrence strictly after "now": the 09:00 slot on the 3rd has
    // already passed at 14:10, so the walk lands on the 4th.
    { id: 9, nextRemindAt: "2026-11-04T09:00" },
  ]);
});

test("ids that did not fire, and rows another path settled, are untouched", () => {
  assert.deepEqual(
    deliveredOutcomes([row({ id: 2 })], [], "2026-11-03T14:10"),
    [],
  );
  assert.deepEqual(
    deliveredOutcomes([row({ id: 3, fired: 1 })], [3], "2026-11-03T14:10"),
    [],
    "an acknowledged reminder must not be resurrected by a stale report",
  );
});

test("a reminder that came due while the phone was off settles as missed", () => {
  // Due 14:05, never delivered, now 14:10: the bridge armed nothing and
  // reported nothing — the missed path is the only thing that closes it.
  assert.deepEqual(missedOutcomes([row({ id: 5 })], [], "2026-11-03T14:10"), [
    { id: 5, nextRemindAt: null },
  ]);
});

test("a missed repeating reminder rolls to its next future occurrence", () => {
  assert.deepEqual(
    missedOutcomes(
      [row({ id: 6, repeat: "daily", remind_at: "2026-11-01T09:00" })],
      [],
      "2026-11-03T14:10",
    ),
    [{ id: 6, nextRemindAt: "2026-11-04T09:00" }],
  );
});

test("delivered, future and already-settled rows are never missed", () => {
  const now = "2026-11-03T14:10";
  // Delivered ids settle through the delivered path, never both.
  assert.deepEqual(missedOutcomes([row({ id: 7 })], [7], now), []);
  // Not yet due.
  assert.deepEqual(
    missedOutcomes([row({ id: 8, remind_at: "2026-11-03T15:00" })], [], now),
    [],
  );
  // Already settled by another path.
  assert.deepEqual(missedOutcomes([row({ id: 9, fired: 1 })], [], now), []);
});

test("the platform check is false outside the Android webview", () => {
  assert.equal(isAndroidPlatform(), false);
});
