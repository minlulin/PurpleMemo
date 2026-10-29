import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gcm } from "@noble/ciphers/aes.js";
import type { DataDriver } from "../data/driver.ts";
import type { MockDriver } from "../data/mock-driver.ts";
import { createMockDriver } from "../data/mock-driver.ts";
import { at, first } from "../test-utils.ts";
import { addDays, todayLocal } from "./dates.ts";
import {
  buildShareSnapshot,
  clipToBytes,
  createShareRepo,
  encryptSnapshot,
  MAX_SNAPSHOT_BYTES,
  SHARE_HORIZON_DAYS,
  SHARE_LIMITS,
  SHARE_SNAPSHOT_VERSION,
  SHARE_TEXT_MAX_BYTES,
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
    dayTotals: { incomeCents: 0, expenseCents: 0 },
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

test("buildShareSnapshot: money is formatted to display strings in the builder", () => {
  const snap = buildShareSnapshot({
    ...emptyInput(),
    // Summed in SQL now (I3): the builder takes the two totals, not the day's
    // rows, so publishing them never transfers a transaction.
    dayTotals: { incomeCents: 150_000, expenseCents: 2_500 },
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

test("buildShareSnapshot: lists are capped, order-preserving (snapshot stays small)", () => {
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

test("buildShareSnapshot: notes carry plain-text excerpts, never raw markdown", () => {
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

test("buildShareSnapshot: empty input is well-formed, not a crash", () => {
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

test("createShareRepo: publishSnapshot sends an encrypted snapshot envelope", async () => {
  const driver = createMockDriver();
  const repo = createShareRepo(driver);
  await repo.start();
  const info = await repo.publishSnapshot();
  const published = argsOf(driver, "sharePublish")[0];
  assert.equal(typeof published, "string");
  const parsed = JSON.parse(published as string) as {
    version: number;
    generatedAt: string;
    nonce: string;
    ciphertext: string;
  };
  assert.equal(parsed.version, SHARE_SNAPSHOT_VERSION);
  assert.equal(typeof parsed.generatedAt, "string");
  assert.equal(parsed.nonce.length > 0, true);
  assert.equal(parsed.ciphertext.length > 0, true);
  const key = Uint8Array.from({ length: 32 }, () => 0xab);
  const nonceBytes = Uint8Array.from(atob(parsed.nonce), (c) =>
    c.charCodeAt(0),
  );
  const ciphertextBytes = Uint8Array.from(atob(parsed.ciphertext), (c) =>
    c.charCodeAt(0),
  );
  const aad = new TextEncoder().encode(
    `purple-memo/share/v${parsed.version}\0${parsed.generatedAt}`,
  );
  const plaintext = gcm(key, nonceBytes, aad).decrypt(ciphertextBytes);
  const snapshot = JSON.parse(new TextDecoder().decode(plaintext)) as {
    money: { income: string; expense: string };
  };
  assert.deepEqual(snapshot.money, { income: "0.00", expense: "0.00" });
  assert.equal(typeof info.publishedAt, "string");
});

test("createShareRepo: the ticker reads each section once, bounded in SQL (I3)", async () => {
  // The ticker runs every 30 s while sharing is on, so its cost is the cost
  // of the feature — and every read here used to be bounded only by how much
  // the library happens to hold: all of today's transactions, every open job,
  // every overdue task and reminder, the whole address book, 20 whole note
  // bodies for 20 excerpts. Each section now carries its own SQL bound, the
  // two totals are SUMs instead of rows, and the reads stay one statement per
  // section (wallets and habits were already aggregates).
  const driver = createMockDriver({
    results: [
      [{ income_cents: 150_000, expense_cents: 2_500 }], // day totals (SUM)
      [], // wallet balances (one statement, already aggregate)
      [{ total_cents: 99_900 }], // receivable total (SUM)
      [], // warranties in window (LIMIT)
      [], // due tasks (LIMIT)
      [], // due reminders (LIMIT)
      [{ id: 1, name: "Walk", created_at: "2026-01-01" }], // habits
      [{ habit_id: 1, log_date: "2026-10-12" }], // habit logs
      [], // upcoming memories (LIMIT)
      [], // birthdays (window + LIMIT)
      [], // notes (LIMIT, bounded projection)
    ],
  });
  const repo = createShareRepo(driver);
  await repo.start();
  const info = await repo.publishSnapshot();
  assert.equal(typeof info.publishedAt, "string", "these reads produced one");

  const reads = driver.callsTo("query").map((c) => ({
    sql: c.args[0] as string,
    params: c.args[1] as unknown[],
  }));
  const pick = (re: RegExp) => {
    const hit = reads.find((r) => re.test(r.sql));
    assert.ok(hit, `a query matching ${re} must exist`);
    return hit;
  };
  // Eleven statements for the whole glance: one per section, no fan-out.
  assert.equal(reads.length, 11, "one read per section, no N+1 anywhere");

  // The publisher reads "today" for real, so the expected dates are derived
  // here rather than written down — a fixed date would pin the clock instead
  // of the query.
  const today = todayLocal();
  const horizon = addDays(today, SHARE_HORIZON_DAYS);

  // Totals are aggregates, not rows: the day used to ship every transaction
  // so JavaScript could sum two numbers, and the receivable every open job.
  const day = pick(/FROM income_entries/);
  assert.match(day.sql, /SUM\(amount_cents\)/);
  assert.equal(day.params.length, 2, "one param per entry table");
  assert.deepEqual(day.params, [today, today]);
  assert.doesNotMatch(day.sql, /SELECT \*/);
  const receivable = pick(/CASE WHEN/);
  assert.match(receivable.sql, /FROM jobs/);
  assert.match(receivable.sql, /j\.status = 'open'/);
  assert.equal(
    receivable.params?.length ?? 0,
    0,
    "an aggregate takes no rows back",
  );

  // Wallet balances: one statement, capped at what the snapshot publishes.
  const wallet = pick(/FROM wallets/);
  assert.match(wallet.sql, /AS balance_cents/);
  assert.match(wallet.sql, /LIMIT \?/);
  assert.deepEqual(wallet.params, [SHARE_LIMITS.wallets]);

  // Warranties: the window predicate in SQL, capped in SQL, and the same
  // 14-day horizon the snapshot's other forward-looking sections use.
  const warranty = pick(/warranty_days > 0/);
  assert.match(
    warranty.sql,
    /date\(job_date, '\+' \|\| warranty_days \|\| ' days'\)/,
  );
  assert.match(warranty.sql, /LIMIT \?/);
  assert.deepEqual(warranty.params, [today, horizon, SHARE_LIMITS.warranties]);
  assert.equal(SHARE_HORIZON_DAYS, 14);

  // Tasks and reminders: capped, in the order the snapshot publishes them.
  const taskRead = pick(/FROM tasks/);
  assert.match(taskRead.sql, /LIMIT \?/);
  assert.match(taskRead.sql, /ORDER BY due_date, id LIMIT \?/);
  assert.deepEqual(taskRead.params, [today, SHARE_LIMITS.tasks]);
  const reminderRead = pick(/FROM reminders/);
  assert.match(reminderRead.sql, /LIMIT \?/);
  assert.deepEqual(reminderRead.params.length, 2, "now + the cap");
  assert.equal(reminderRead.params[1], SHARE_LIMITS.reminders);

  // Memories: the date window alone never bounded this — a busy fortnight
  // could hand the ticker every memory in the library.
  const memoryRead = pick(/FROM memories/);
  assert.match(memoryRead.sql, /LIMIT \?/);
  assert.deepEqual(memoryRead.params, [today, horizon, SHARE_LIMITS.upcoming]);

  // Birthdays: the month-day window in SQL, ordered like the address book it
  // replaced, capped — instead of `SELECT * FROM contacts` every 30 s.
  const birthdayRead = pick(/FROM contacts/);
  assert.match(birthdayRead.sql, /substr\(birthday, -5\)/);
  assert.match(birthdayRead.sql, /ORDER BY name LIMIT \?/);
  assert.deepEqual(birthdayRead.params, [
    today.slice(5),
    horizon.slice(5),
    SHARE_LIMITS.birthdays,
  ]);

  // Notes: capped AND projected. `projection: "full"` used to read every
  // selected note's whole body to excerpt 140 characters of it — the list
  // projection takes the same 200-character prefix the notes list excerpts
  // from, so the phone shows what the desktop list shows.
  const noteRead = pick(/FROM notes/);
  assert.match(noteRead.sql, /LIMIT \?/);
  assert.deepEqual(noteRead.params, [SHARE_LIMITS.notes]);
  assert.match(noteRead.sql, /substr\(content, 1, 200\)/);
  assert.doesNotMatch(noteRead.sql, /SELECT \* FROM notes/);

  // Habit progress stays the two bounded reads it already was.
  const habitReads = reads.filter((r) => /FROM habits/.test(r.sql));
  assert.equal(habitReads.length, 1, "one habits read");
  assert.match(habitReads[0]?.sql ?? "", /LIMIT \?/);
  const logRead = pick(/habit_logs/);
  assert.match(logRead.sql, /habit_id IN/);
  assert.deepEqual(logRead.params, [1], "scoped to the habits published");
});

// ---------------------------------------------------------------------------
// I4 — one text field must never be able to outgrow the envelope Rust accepts
// ---------------------------------------------------------------------------

/** A valid 64-hex share key, as the URL fragment carries one. */
const KEY = "ab".repeat(32);

test("clipToBytes: a long string is cut on bytes, never mid-code-point (I4)", () => {
  const myanmar = "မြန်မာ".repeat(200); // 3 bytes a char, so far past any budget
  const clipped = clipToBytes(myanmar, 100);
  const bytes = new TextEncoder().encode(clipped);
  assert.ok(
    bytes.length <= 100,
    `clipped to ${bytes.length} bytes, over the 100 budget`,
  );
  assert.ok(
    !clipped.includes("\uFFFD"),
    "the cut must not leave half a character",
  );
  assert.ok(clipped.endsWith("…"), "an ellipsis stands in for the rest");
  // Short strings pass through untouched — clipping is for the outliers.
  assert.equal(clipToBytes("Cash"), "Cash");
  assert.equal(clipToBytes(""), "");
  // Exactly at the budget is not a cut.
  const atBudget = "a".repeat(SHARE_TEXT_MAX_BYTES);
  assert.equal(clipToBytes(atBudget), atBudget);
});

test("a 400 KiB task title cannot push the envelope past Rust's cap (I4)", () => {
  // Exactly the finding's shape: the CSV importer accepts a 5 MiB file and
  // `mapTaskRows` only trims, so a 400 KiB title is a *valid* imported row,
  // and a due task sits inside the ten the snapshot publishes. Without a byte
  // budget it was copied verbatim, base64'd with the ciphertext, and refused
  // by `parse_snapshot` — so the phone kept the previous snapshot while the
  // ticker retried a payload that could never be accepted.
  const hugeTitle = "a".repeat(400 * 1024);
  const snap = buildShareSnapshot({
    ...emptyInput(),
    dueTasks: [
      {
        id: 1,
        title: hugeTitle,
        due_date: "2026-10-12",
        done: 0,
        repeat: "none",
        note: "",
        created_at: "2026-10-12",
      },
    ],
  });
  const published = first(snap.tasks, "tasks").title;
  assert.ok(
    published.length < hugeTitle.length,
    "the title is clipped, not published whole",
  );
  assert.ok(published.endsWith("…"), "and says so");
  const envelope = encryptSnapshot(snap, KEY);
  assert.ok(
    envelope.length <= MAX_SNAPSHOT_BYTES,
    `envelope of ${envelope.length} bytes must stay inside ${MAX_SNAPSHOT_BYTES}`,
  );
});

test("encryptSnapshot refuses an envelope Rust would reject (I4)", () => {
  // The budgets in `buildShareSnapshot` are what make this unreachable; this
  // is the tripwire for the next field added without one. Rust's refusal
  // happens after the whole envelope has crossed the IPC boundary and only
  // ever leaves the phone stale — so the same limit is checked here, where
  // the error can name the problem.
  const unbudgeted = {
    ...buildShareSnapshot(emptyInput()),
    tasks: [{ title: "x".repeat(600 * 1024), due: null }],
  };
  assert.throws(
    () => encryptSnapshot(unbudgeted, KEY),
    /over the .* byte limit, not published/,
  );
});

test("MAX_SNAPSHOT_BYTES is Rust's cap, byte for byte (I4)", () => {
  // Two constants in two languages is exactly how the app ends up producing
  // envelopes the server refuses — the E6 shape, here on the share path.
  const shareRs = readFileSync(
    new URL("../../src-tauri/src/share.rs", import.meta.url),
    "utf8",
  );
  const rust = /const MAX_SNAPSHOT_BYTES: usize = (\d+) \* 1024;/.exec(shareRs);
  assert.ok(rust, "share.rs must declare MAX_SNAPSHOT_BYTES");
  assert.equal(
    Number(rust[1]) * 1024,
    MAX_SNAPSHOT_BYTES,
    "the mirrored cap must equal the one `parse_snapshot` enforces",
  );
  assert.ok(
    shareRs.includes("json.len() > MAX_SNAPSHOT_BYTES"),
    "and parse_snapshot must still enforce it before replacing a snapshot",
  );
});

// ---------------------------------------------------------------------------
// D2(a) — locking wins over an in-flight share start
// ---------------------------------------------------------------------------

test("the lock stops sharing through the lock path, an ordinary stop does not (D2a)", async () => {
  // The two stops differ by exactly one thing: the lock's revokes the armed
  // consent token and supersedes one an in-flight start already spent, so no
  // listener can bind after the shell locked. Ordinary stop must NOT do that —
  // a Rust test pins that a token survives it, because a stop is not a reason
  // to make the user confirm a prompt they may still have on screen.
  const driver = createMockDriver();
  const repo = createShareRepo(driver);
  await repo.start();
  await repo.stopForLock();
  await repo.stop();
  assert.deepEqual(
    driver.callsTo("shareStop").map((c) => c.args),
    [[true], [false]],
    "the lock asks for the lock path; the ordinary stop stays ordinary",
  );
  // Both clear the published key: neither path may leave one behind that
  // could publish to a listener that is gone.
  assert.equal(driver.callsTo("shareStop").length, 2);
});

test("the shell's lock port stops sharing through the lock path (D2a)", () => {
  // `lockSession` is handed its teardown as a port, so the difference lives
  // in App.tsx — and a port wired to the ordinary stop would leave the very
  // hole the epoch exists to close, with every lockSession test still green.
  const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
  assert.match(
    app,
    /stopSharing: \(\) => shareRepo\.stopForLock\(\)/,
    "the lock must stop sharing through stopForLock",
  );
  assert.doesNotMatch(
    app,
    /stopSharing: \(\) => shareRepo\.stop\(\)/,
    "an ordinary stop leaves an armed token alive — not the lock's stop",
  );
});

test("createShareRepo: start/stop/status go through the driver (single IPC surface)", async () => {
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

test("starting the share arms consent first and presents the token", async () => {
  // the listener must not be reachable by one bare call. Rust
  // refuses `share_start` without a token from `share_arm`, and the repo is the
  // one place that has to put the two halves in order.
  const driver = createMockDriver();
  const repo = createShareRepo(driver);
  await repo.start();

  const armIndex = driver.calls.findIndex((c) => c.method === "shareArm");
  const startIndex = driver.calls.findIndex((c) => c.method === "shareStart");
  assert.ok(armIndex >= 0, "consent must be armed");
  assert.ok(startIndex > armIndex, "arming must come before starting");

  const presented = driver.calls[startIndex]?.args[0];
  assert.equal(typeof presented, "string", "a token is presented, not nothing");
  assert.ok(
    (presented as string).length > 0,
    "an empty token is exactly what Rust refuses",
  );
});

test("starting the share without consent is refused, not silently allowed", async () => {
  // The mock mirrors the Rust refusal, so a future edit that drops the arm step
  // from `shareRepo.start` fails here rather than only in production.
  const driver = createMockDriver();
  await assert.rejects(() => driver.shareStart(""), /must be confirmed first/);
  // Calling it with no argument at all does not compile: `shareStart` takes a
  // required `consentToken`, so the gate is also a type-level fact rather than
  // only a runtime one. This assertion is the runtime half of that pair.
});

test("each start presents a distinct consent token", async () => {
  // One token per disclosure: a second start cannot ride on the first's
  // confirmation.
  const driver = createMockDriver();
  const repo = createShareRepo(driver);
  await repo.start();
  await repo.stop();
  await repo.start();

  const tokens = driver.callsTo("shareStart").map((c) => c.args[0]);
  assert.equal(tokens.length, 2);
  assert.ok(tokens[0], "a token is presented");
  assert.notEqual(tokens[0], tokens[1], "the second start is separately armed");
});
