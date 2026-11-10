/**
 * Adoption tests — counted, not asserted.
 *
 * Two populated sides, real row lists, and the plan's own counts compared
 * against them: a plan that lost a row cannot pass by claiming success (§9.1).
 * The batch test proves §8.3's bound and its aggregate exception; the trash
 * test proves §9.5/§13.2 archives only the three mutable entities.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adoptionSummary,
  batchSnapshot,
  CONFLICT_COPY_LABEL,
  conflictLosers,
  planBootstrap,
  resumeAdoption,
  type SyncedRow,
  TRASHABLE_CONFLICT_TABLES,
} from "./bootstrap.ts";
import type { SyncTable, VersionStamp } from "./protocol.ts";

function stamp(deviceId: string, counter: number): VersionStamp {
  return { counter, deviceId, opId: `${deviceId}#${counter}` };
}

function row(
  table: SyncTable,
  uid: string,
  counter: number,
  fields: Record<string, unknown> = {},
  deviceId = "desktop-7f3c",
): SyncedRow {
  return { table, uid, stamp: stamp(deviceId, counter), fields };
}

const DESKTOP_ROWS: SyncedRow[] = [
  row("notes", "note-d1", 3, { title: "Desktop note" }),
  row("tasks", "task-d1", 4, { title: "Desktop task" }),
  row("shopping_lists", "list-d1", 5, { name: "Groceries" }),
];

const PHONE_ROWS: SyncedRow[] = [
  // Created offline on the phone: unknown to the desktop (§9.2).
  row("notes", "note-p1", 2, { title: "Phone note" }, "phone-91ab"),
  row("tasks", "task-p1", 3, { title: "Phone task" }, "phone-91ab"),
  row("shopping_items", "item-p1", 4, { text: "milk" }, "phone-91ab"),
  // The same UID both sides hold: merged by §4, never duplicated.
  row("notes", "note-d1", 6, { title: "Desktop note" }, "phone-91ab"),
  row("tasks", "task-d1", 7, { title: "Desktop task" }, "phone-91ab"),
];

/**
 * §8.3's byte bound is the wire's, so it is measured in UTF-8 bytes.
 *
 * `.length` counts UTF-16 code units: a letter of Burmese is 1 character and 3
 * bytes, so a 400-character note measured ~530 "bytes" here and cost ~1,330 on
 * the wire. Two such notes fit a 2,000-byte budget when measured in
 * characters, and do not when measured the way the frame is filled.
 */
test("the snapshot budget counts UTF-8 bytes, not UTF-16 characters", () => {
  const burmese =
    "\u{1019}\u{103c}\u{1014}\u{103a}\u{1019}\u{102c}\u{1005}\u{102c}".repeat(
      50,
    );
  assert.equal(burmese.length, 400, "400 characters");
  assert.equal(new TextEncoder().encode(burmese).length, 1_200, "1,200 bytes");
  const rows = [
    row("notes", "note-a", 1, { title: burmese }),
    row("notes", "note-b", 2, { title: burmese }),
  ];
  assert.equal(
    batchSnapshot(rows, { maxBytes: 2_000 }).length,
    2,
    "1,330 bytes each: two of them do not fit 2,000",
  );
  assert.equal(
    batchSnapshot(rows, { maxBytes: 3_000 }).length,
    1,
    "both fit 3,000, so the split above is the measurement and not a floor",
  );
});

test("first pairing between two populated devices keeps every row on both sides", () => {
  const plan = planBootstrap(DESKTOP_ROWS, PHONE_ROWS);

  // Counted against what we started with — a plan that loses rows fails here.
  assert.deepEqual(plan.counts, {
    snapshot: 3,
    upload: 3,
    alreadyKnown: 2,
    desktopOnly: 1,
    phoneKept: 5,
    deletions: 0,
  });
  assert.equal(
    plan.counts.upload + plan.counts.alreadyKnown,
    PHONE_ROWS.length,
  );
  assert.equal(
    plan.counts.desktopOnly + plan.counts.alreadyKnown,
    DESKTOP_ROWS.length,
  );
  assert.deepEqual(plan.deletions, [], "first pairing never deletes (§9.1)");

  const desktopUids = new Set(plan.snapshot.map((r) => r.uid));
  for (const original of DESKTOP_ROWS) {
    assert.ok(
      desktopUids.has(original.uid),
      `${original.uid} must survive the plan`,
    );
  }
  const phoneUids = new Set(
    [...plan.upload, ...plan.alreadyKnown].map((r) => r.uid),
  );
  for (const original of PHONE_ROWS) {
    assert.ok(
      phoneUids.has(original.uid),
      `${original.uid} must stay on the phone`,
    );
  }
});

test("offline phone records upload as new records under their own UIDs", () => {
  const plan = planBootstrap(DESKTOP_ROWS, PHONE_ROWS);
  const desktopUids = new Set(DESKTOP_ROWS.map((r) => r.uid));

  assert.equal(plan.upload.length, 3);
  for (const uploading of plan.upload) {
    assert.ok(
      !desktopUids.has(uploading.uid),
      `${uploading.uid} is already on the desktop and must not be re-created`,
    );
    assert.equal(
      uploading.stamp.deviceId,
      "phone-91ab",
      "the UID and stamp are the phone's own — nothing is rewritten (§9.2)",
    );
  }

  // Idempotent second attempt: the desktop now holds those UIDs, so nothing is
  // uploaded again and nothing is duplicated (§7.2, §9.4).
  const adopted = [...DESKTOP_ROWS, ...plan.upload];
  const second = planBootstrap(adopted, PHONE_ROWS);
  assert.equal(second.counts.upload, 0, "a repeated adoption uploads nothing");
  assert.equal(second.counts.alreadyKnown, PHONE_ROWS.length);
  assert.equal(second.counts.snapshot, adopted.length);
  assert.equal(second.counts.deletions, 0);
});

test("a snapshot is bounded and never splits an aggregate", () => {
  const many = Array.from({ length: 450 }, (_, index) =>
    row("notes", `note-${index}`, index + 1, { title: `Note ${index}` }),
  );
  const batches = batchSnapshot(many, { maxOps: 200 });
  assert.equal(batches.length, 3);
  for (const batch of batches) {
    assert.ok(
      batch.length <= 200,
      `batch of ${batch.length} exceeds the bound`,
    );
  }
  assert.equal(
    batches.reduce((total, batch) => total + batch.length, 0),
    450,
    "batching loses nothing",
  );

  // A list and its items are one aggregate (§8.3). They arrive right at the
  // 200-op boundary, so a batcher that only watched the count would split them.
  const aggregateOf = (candidate: SyncedRow): string | null =>
    candidate.table === "shopping_lists" || candidate.table === "shopping_items"
      ? "list-L"
      : null;
  const boundary = [
    ...Array.from({ length: 199 }, (_, index) =>
      row("notes", `n-${index}`, index + 1),
    ),
    row("shopping_lists", "list-L", 500, { name: "Groceries" }),
    row("shopping_items", "item-L1", 501, { text: "milk" }),
    row("shopping_items", "item-L2", 502, { text: "eggs" }),
  ];
  const cut = batchSnapshot(boundary, { maxOps: 200, aggregateOf });
  const holder = cut.find((batch) => batch.some((r) => r.uid === "item-L2"));
  assert.ok(holder, "the aggregate is somewhere");
  for (const uid of ["list-L", "item-L1", "item-L2"]) {
    assert.ok(
      holder.some((r) => r.uid === uid),
      `${uid} was split across batches — §8.3 forbids it`,
    );
  }
  assert.ok(
    holder.length <= 202,
    "the aggregate exception may exceed the bound by the aggregate only",
  );

  // A tiny byte bound still yields whole batches rather than dropping rows.
  const byBytes = batchSnapshot(many.slice(0, 10), { maxBytes: 300 });
  assert.ok(
    byBytes.length >= 10,
    "each row is its own batch under a tiny bound",
  );
  assert.equal(byBytes.flat().length, 10);
});

test("an interrupted snapshot applies nothing and is re-taken", () => {
  assert.deepEqual(resumeAdoption(null, "pairing-1"), { action: "start" });
  assert.deepEqual(
    resumeAdoption(
      { pairingId: "pairing-1", appliedBatches: 3, totalBatches: 3 },
      "pairing-1",
    ),
    {
      action: "complete",
    },
  );
  const interrupted = resumeAdoption(
    { pairingId: "pairing-1", appliedBatches: 1, totalBatches: 3 },
    "pairing-1",
  );
  assert.equal(interrupted.action, "restart");
  assert.match(
    interrupted.action === "restart" ? interrupted.reason : "",
    /applies nothing/,
  );
  const otherPairing = resumeAdoption(
    { pairingId: "pairing-old", appliedBatches: 3, totalBatches: 3 },
    "pairing-new",
  );
  assert.equal(otherPairing.action, "restart");
});

test("only mutable entities archive a conflict loser, and only the loser does", () => {
  assert.deepEqual(TRASHABLE_CONFLICT_TABLES, [
    "notes",
    "tasks",
    "shopping_lists",
    "shopping_items",
  ]);

  const noteConflict = conflictLosers([
    {
      table: "notes",
      uid: "note-1",
      desktop: row("notes", "note-1", 9, { title: "desktop wins" }),
      mobile: row("notes", "note-1", 4, { title: "phone loses" }, "phone-91ab"),
    },
  ]);
  assert.equal(noteConflict.length, 1);
  assert.equal(noteConflict[0]?.loser, "mobile");
  assert.equal(noteConflict[0]?.label, CONFLICT_COPY_LABEL);
  assert.deepEqual(noteConflict[0]?.kept, { title: "phone loses" });
  assert.deepEqual(noteConflict[0]?.won, { title: "desktop wins" });

  // A check-in is not content worth archiving (§9.5), and append-only rows
  // cannot conflict at all because the phone never edits them (§2.3).
  for (const table of ["habit_logs", "income_entries"] as const) {
    assert.deepEqual(
      conflictLosers([
        {
          table,
          uid: `${table}-1`,
          desktop: row(table, `${table}-1`, 5, { done: false }),
          mobile: row(table, `${table}-1`, 9, { done: true }, "phone-91ab"),
        },
      ]),
      [],
      `${table} must never produce a trash copy`,
    );
  }

  // Identical values are not a conflict; a tie on the same stamp is not either.
  assert.deepEqual(
    conflictLosers([
      {
        table: "tasks",
        uid: "task-1",
        desktop: row("tasks", "task-1", 5, { title: "same" }),
        mobile: row("tasks", "task-1", 9, { title: "same" }, "phone-91ab"),
      },
    ]),
    [],
  );
  assert.deepEqual(
    conflictLosers([
      {
        table: "tasks",
        uid: "task-2",
        desktop: row("tasks", "task-2", 5, { title: "a" }),
        mobile: row("tasks", "task-2", 5, { title: "b" }, "desktop-7f3c"),
      },
    ]),
    [],
  );
});

test("the adoption summary says what moved and that nothing was deleted", () => {
  const lines = adoptionSummary(planBootstrap(DESKTOP_ROWS, PHONE_ROWS));
  assert.deepEqual(lines, [
    "3 record(s) on the desktop are ready for this phone.",
    "3 record(s) created on this phone will be added to the desktop.",
    "2 record(s) already exist on both sides and will be merged.",
    "Nothing is deleted on either device.",
  ]);
});
