import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DataDriver } from "../data/driver.ts";
import type { MockDriver } from "../data/mock-driver.ts";
import { createMockDriver } from "../data/mock-driver.ts";
import { at, first } from "../test-utils.ts";
import {
  buildShareSnapshot,
  createShareRepo,
  SHARE_LIMITS,
  SHARE_SNAPSHOT_VERSION,
  type ShareSnapshotInput,
} from "./share.ts";
import type { ContactRow, NoteRow, TaskRow } from "./types.ts";

/** Args of the first recorded call to `method` (tests always call it once). */
function argsOf(driver: MockDriver, method: keyof DataDriver): unknown[] {
  const call = driver.callsTo(method)[0];
  assert.ok(call, `expected a ${method} call`);
  return call.args;
}

/** A snapshot input with nothing in it — the baseline every test starts from. */
function emptyInput(): ShareSnapshotInput {
  return {
    today: "2026-10-12",
    generatedAt: "2026-10-12T09:30",
    dayEntries: [],
    walletBalances: [],
    receivableCents: 0,
    dueTasks: [],
    reminders: [],
    habits: [],
    upcoming: [],
    birthdays: [],
    warranties: [],
    notes: [],
  };
}

test("buildShareSnapshot: money is formatted to display strings in the builder (§2.1)", () => {
  const snap = buildShareSnapshot({
    ...emptyInput(),
    dayEntries: [
      {
        kind: "income",
        id: 1,
        amount_cents: 150_000,
        category_id: 1,
        wallet_id: 1,
        entry_date: "2026-10-12",
        note: "job",
        created_at: "2026-10-12",
      },
      {
        kind: "expense",
        id: 2,
        amount_cents: 2_500,
        category_id: 1,
        wallet_id: 1,
        entry_date: "2026-10-12",
        note: "noodles",
        created_at: "2026-10-12",
      },
    ],
    walletBalances: [
      { name: "Cash", balanceCents: 12_345 },
      { name: "Kpay", balanceCents: 0 },
    ],
    receivableCents: 99_900,
  });
  assert.deepEqual(snap.money, { income: "1,500.00", expense: "25.00" });
  assert.deepEqual(snap.wallets, [
    { name: "Cash", balance: "123.45" },
    { name: "Kpay", balance: "0.00" },
  ]);
  assert.equal(snap.receivableTotal, "999.00");
});

test("buildShareSnapshot: lists are capped, order-preserving (§8 snapshot stays small)", () => {
  const many = (n: number): NoteRow[] =>
    Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      title: `note ${i}`,
      content: `body ${i}`,
      tags: "",
      collection_id: null,
      pinned: 0,
      archived: 0,
      created_at: "2026-10-12",
      updated_at: "2026-10-12",
    }));
  const tasks: TaskRow[] = Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    title: `task ${i}`,
    due_date: "2026-10-12",
    done: 0,
    repeat: "none",
    note: "",
    created_at: "2026-10-12",
  }));
  const snap = buildShareSnapshot({
    ...emptyInput(),
    dueTasks: tasks,
    notes: many(40),
  });
  assert.equal(snap.tasks.length, SHARE_LIMITS.tasks);
  assert.equal(snap.notes.length, SHARE_LIMITS.notes);
  assert.equal(first(snap.tasks, "tasks").title, "task 0");
  assert.equal(first(snap.notes, "notes").title, "note 0");
  assert.ok(SHARE_LIMITS.notes < 40, "the cap must actually bite at 40 rows");
});

test("wallets are capped too — the whole snapshot is a bounded glance", () => {
  const wallets = Array.from({ length: 40 }, (_, i) => ({
    name: `wallet ${i}`,
    balanceCents: i * 100,
  }));
  const snap = buildShareSnapshot({ ...emptyInput(), walletBalances: wallets });
  assert.equal(snap.wallets.length, SHARE_LIMITS.wallets);
  assert.equal(first(snap.wallets, "wallets").name, "wallet 0");
  assert.ok(
    SHARE_LIMITS.wallets < 40,
    "the wallet cap must actually bite at 40 rows",
  );
});

test("buildShareSnapshot: notes carry plain-text excerpts, never raw markdown (§2.4)", () => {
  const snap = buildShareSnapshot({
    ...emptyInput(),
    notes: [
      {
        id: 1,
        title: "Plan",
        content: "## Heading\n\n**bold** and [a link](https://example.com)",
        tags: "",
        collection_id: null,
        pinned: 0,
        archived: 0,
        created_at: "2026-10-12T08:00",
        updated_at: "2026-10-12T08:00",
      },
    ],
  });
  const note = first(snap.notes, "notes");
  assert.equal(note.excerpt, "Heading bold and a link");
  assert.equal(note.updatedAt, "2026-10-12T08:00");
});

test("buildShareSnapshot: the snapshot has exactly the documented keys (nothing leaks in)", () => {
  const snap = buildShareSnapshot(emptyInput());
  assert.deepEqual(Object.keys(snap).sort(), [
    "birthdays",
    "generatedAt",
    "habits",
    "money",
    "notes",
    "receivableTotal",
    "reminders",
    "tasks",
    "today",
    "upcoming",
    "version",
    "wallets",
    "warranties",
  ]);
  assert.equal(snap.version, SHARE_SNAPSHOT_VERSION);
  assert.equal(snap.today, "2026-10-12");
  assert.equal(snap.generatedAt, "2026-10-12T09:30");
});

test("buildShareSnapshot: empty input is well-formed, not a crash (§8)", () => {
  const snap = buildShareSnapshot(emptyInput());
  assert.deepEqual(snap.money, { income: "0.00", expense: "0.00" });
  assert.equal(snap.receivableTotal, "0.00");
  assert.deepEqual(snap.wallets, []);
  assert.deepEqual(snap.tasks, []);
  assert.deepEqual(snap.notes, []);
});

test("buildShareSnapshot: a task without a due date and a birthday without a date degrade cleanly", () => {
  const birthdays: ContactRow[] = [
    {
      id: 1,
      name: "Aung",
      address: "",
      birthday: "1990-10-20",
      notes: "",
      created_at: "2026-10-12",
    },
    {
      id: 2,
      name: "No date",
      address: "",
      birthday: null,
      notes: "",
      created_at: "2026-10-12",
    },
  ];
  const snap = buildShareSnapshot({
    ...emptyInput(),
    dueTasks: [
      {
        id: 1,
        title: "Someday",
        due_date: null,
        done: 0,
        repeat: "daily",
        note: "",
        created_at: "2026-10-12",
      },
    ],
    birthdays,
  });
  assert.equal(first(snap.tasks, "tasks").due, null);
  assert.equal(first(snap.birthdays, "birthdays").label, "Oct 20, 1990");
  assert.equal(at(snap.birthdays, 1, "birthdays").label, "");
});

test("createShareRepo: publishSnapshot sends the built snapshot to the driver as JSON", async () => {
  const driver = createMockDriver();
  const repo = createShareRepo(driver);
  const info = await repo.publishSnapshot();
  const published = argsOf(driver, "sharePublish")[0];
  assert.equal(typeof published, "string");
  const parsed = JSON.parse(published as string) as { version: number };
  assert.equal(parsed.version, SHARE_SNAPSHOT_VERSION);
  assert.equal(typeof info.publishedAt, "string");
});

test("createShareRepo: start/stop/status go through the driver (single IPC surface, §4)", async () => {
  const driver = createMockDriver();
  const repo = createShareRepo(driver);
  const started = await repo.start();
  assert.equal(started.running, true);
  assert.ok(started.url, "a running share must expose its LAN url");
  const stopped = await repo.stop();
  assert.equal(stopped.running, false);
  await repo.status();
  assert.equal(driver.callsTo("shareStart").length, 1);
  assert.equal(driver.callsTo("shareStop").length, 1);
  assert.equal(driver.callsTo("shareStatus").length, 1);
});
