// The app shell's session coordination: locking must
// end sharing, the LAN publisher must not repeat its stop notice, and the
// reminder poll must ask for permission once, never stack ticks and never fire
// after the shell locked. These rules used to live inside `App.tsx`, where no
// test could reach them.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createReminderTicker,
  createShareTicker,
  lockSession,
  type ReminderTickPorts,
  SHARE_STOP_RETRY_DELAYS_MS,
  SHARE_STOP_TIMEOUT_MS,
  stopSharingWithRetry,
} from "./session.ts";
import type { ReminderRow } from "./types.ts";

function reminderRow(over: Partial<ReminderRow> = {}): ReminderRow {
  return {
    id: 1,
    title: "Water the plants",
    remind_at: "2026-10-16T09:00",
    repeat: "none",
    note: "kitchen + balcony",
    fired: 0,
    created_at: "2026-10-01T08:00",
    ...over,
  };
}

test("lockSession ends the LAN session (locking ends sharing)", () => {
  const stopped: string[] = [];
  let locked = false;
  lockSession({
    lockVault: () => stopped.push("vault"),
    stopSharing: async () => stopped.push("share"),
    onLocked: () => {
      locked = true;
    },
  });
  assert.equal(locked, true, "the shell must lock");
  assert.deepEqual(
    stopped.sort(),
    ["share", "vault"],
    "both the vault cache and the LAN listener are dropped",
  );
});

test("lockSession locks the shell even when the vault lock throws", () => {
  let locked = false;
  let sharingStopped = false;
  lockSession({
    lockVault: () => {
      throw new Error("vault cache already gone");
    },
    stopSharing: async () => {
      sharingStopped = true;
    },
    onLocked: () => {
      locked = true;
    },
  });
  assert.equal(locked, true, "failing open is the one outcome to avoid");
  assert.equal(sharingStopped, true, "sharing still stops");
});

test("lockSession never lets the teardown failure reach the lock screen", () => {
  // Rejected promise, and a synchronous throw — both are best-effort. The
  // retry schedule is emptied so the background teardown finishes in one
  // attempt instead of keeping the test run alive.
  for (const stopSharing of [
    () => Promise.reject(new Error("listener busy")),
    () => {
      throw new Error("no runtime");
    },
  ]) {
    let locked = false;
    assert.doesNotThrow(() =>
      lockSession({
        lockVault: () => undefined,
        stopSharing,
        onLocked: () => {
          locked = true;
        },
        retryDelaysMs: [],
        stopTimeoutMs: 50,
      }),
    );
    assert.equal(locked, true);
  }
});

test("stopSharingWithRetry retries a failed stop and stays quiet on success", async () => {
  // one failure is not the story. A busy worker or a client mid-write
  // usually clears on the next attempt, and that recovery should not alarm the
  // user with a notice.
  let attempts = 0;
  const waits: number[] = [];
  const failures: unknown[] = [];
  const stopped = await stopSharingWithRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("listener busy");
    },
    {
      retryDelaysMs: [0, 0],
      wait: async (ms) => {
        waits.push(ms);
      },
      onFailed: (e) => failures.push(e),
    },
  );
  assert.equal(stopped, true);
  assert.equal(attempts, 3, "one immediate attempt plus the two retries");
  assert.deepEqual(waits, [0, 0], "the configured backoff is used in order");
  assert.deepEqual(failures, [], "a recovered stop is not a failure to report");
});

test("stopSharingWithRetry reports the last failure exactly once", async () => {
  let attempts = 0;
  const failures: unknown[] = [];
  const stopped = await stopSharingWithRetry(
    async () => {
      attempts += 1;
      throw new Error(`attempt ${attempts} failed`);
    },
    {
      retryDelaysMs: [0, 0],
      wait: async () => undefined,
      onFailed: (e) => failures.push(e),
    },
  );
  assert.equal(stopped, false);
  assert.equal(attempts, 3);
  assert.equal(failures.length, 1, "one notice, not one per attempt");
  assert.match(
    failures[0] instanceof Error ? failures[0].message : "",
    /attempt 3 failed/,
  );
});

test("a cancelled teardown neither retries nor reports (the stale-retry rule)", async () => {
  // The H4 scenario: lock #1's backoff is still sleeping when the shell
  // unlocks and the user starts a NEW LAN share. The next attempt must never
  // run — it would stop the share that was just started — and walking away is
  // not itself a failure to show: the owner that cancelled the teardown has
  // taken share state over and decides what, if anything, the user is told.
  let attempts = 0;
  let cancelled = false;
  const failures: unknown[] = [];
  const stopped = await stopSharingWithRetry(
    async () => {
      attempts += 1;
      throw new Error("listener busy");
    },
    {
      retryDelaysMs: [0, 0],
      wait: async () => {
        cancelled = true; // the shell unlocked while backing off
      },
      onFailed: (e) => failures.push(e),
      isCancelled: () => cancelled,
    },
  );
  assert.equal(stopped, false, "no claim about a listener it no longer owns");
  assert.equal(attempts, 1, "no further stop after the cancellation");
  assert.deepEqual(failures, [], "the retired teardown reports nothing");
});

test("a stop that never answers is bounded and counted as a failure", async () => {
  // The plausible hang: `share_stop` joins a worker blocked writing to a
  // stalled client. Without the per-attempt timeout the lock's teardown would
  // wait forever and never report anything.
  const failures: unknown[] = [];
  const stopped = await stopSharingWithRetry(
    () => new Promise<void>(() => undefined),
    {
      retryDelaysMs: [],
      stopTimeoutMs: 10,
      onFailed: (e) => failures.push(e),
    },
  );
  assert.equal(stopped, false);
  assert.equal(failures.length, 1);
  assert.match(
    failures[0] instanceof Error ? failures[0].message : "",
    /timed out after 10 ms/,
  );
});

test("lockSession surfaces a listener that survived every retry", async () => {
  // The old behaviour cancelled the stop and threw the result away. Because the
  // status poller is paused while locked, a listener that stayed up was still
  // serving the dashboard with nothing on screen saying so.
  let locked = false;
  const notes: unknown[] = [];
  lockSession({
    lockVault: () => undefined,
    stopSharing: async () => {
      throw new Error("worker wedged");
    },
    onLocked: () => {
      locked = true;
    },
    onShareStopFailed: (e) => notes.push(e),
    retryDelaysMs: [0, 0],
    wait: async () => undefined,
  });
  assert.equal(locked, true, "the lock does not wait for the listener");
  assert.equal(notes.length, 0, "the retries have not finished yet");
  // Let the background teardown run to its end.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(notes.length, 1, "the failed stop reaches the user");
  assert.match(
    notes[0] instanceof Error ? notes[0].message : "",
    /worker wedged/,
  );
});

test("the lock does not wait on a hung listener", async () => {
  let locked = false;
  const notes: unknown[] = [];
  lockSession({
    lockVault: () => undefined,
    stopSharing: () => new Promise<void>(() => undefined),
    onLocked: () => {
      locked = true;
    },
    onShareStopFailed: (e) => notes.push(e),
    retryDelaysMs: [],
    stopTimeoutMs: 10,
  });
  assert.equal(locked, true, "locking is synchronous");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(notes.length, 1);
});

test("a teardown the shell retired is neither retried nor reported", async () => {
  // The ports are the shell's only handle on the background loop: once
  // `isCancelled` answers true (an unlock, or a newer lock superseding this
  // one), the retry that would have torn down a freshly started share must not
  // run, and the walk-away must not surface as a failure notice either.
  let unlocked = false;
  let attempts = 0;
  const notes: unknown[] = [];
  lockSession({
    lockVault: () => undefined,
    stopSharing: async () => {
      attempts += 1;
      throw new Error("worker wedged");
    },
    onLocked: () => {
      unlocked = false;
    },
    onShareStopFailed: (e) => notes.push(e),
    retryDelaysMs: [0, 0],
    wait: async () => {
      unlocked = true; // the user unlocked while the teardown backed off
    },
    isCancelled: () => unlocked,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    attempts,
    1,
    "the retry that would stop a newly started share never runs",
  );
  assert.equal(
    notes.length,
    0,
    "a teardown the shell walked away from is not a failure to show",
  );
});

test("the retry schedule is bounded and leaves the lock responsive", () => {
  // The defaults are a product decision, not an implementation detail: long
  // enough to ride out a busy worker, short enough that a wedged listener is
  // reported while the user is still standing at the lock screen.
  assert.ok(SHARE_STOP_RETRY_DELAYS_MS.length > 0);
  const total = SHARE_STOP_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
  assert.ok(
    total <= 120_000,
    `retries must finish within two minutes: ${total}`,
  );
  assert.ok(SHARE_STOP_TIMEOUT_MS <= 10_000);
});

test("the share ticker publishes only while the server runs", async () => {
  const published: number[] = [];
  let status: { running: boolean; note?: string | null } = { running: false };
  const tick = createShareTicker({
    status: async () => status,
    publish: async () => {
      published.push(1);
    },
    onNote: () => undefined,
    isCancelled: () => false,
  });
  await tick();
  assert.equal(published.length, 0, "nothing to publish while stopped");
  status = { running: true };
  await tick();
  await tick();
  assert.equal(published.length, 2, "every tick republishes while running");
});

test("the share ticker raises the stop notice once, on the running → stopped edge", async () => {
  const notes: string[] = [];
  let status = { running: true, note: null as string | null };
  const tick = createShareTicker({
    status: async () => status,
    publish: async () => undefined,
    onNote: (note) => notes.push(note),
    isCancelled: () => false,
  });
  await tick();
  // The server stopped itself: note it, and only once.
  status = {
    running: false,
    note: "Sharing server stopped unexpectedly.",
  };
  await tick();
  await tick();
  await tick();
  assert.deepEqual(notes, ["Sharing server stopped unexpectedly."]);
});

test("the share ticker raises nothing for an app that was never sharing", async () => {
  const notes: string[] = [];
  const tick = createShareTicker({
    status: async () => ({ running: false, note: "Stopped sharing." }),
    publish: async () => undefined,
    onNote: (note) => notes.push(note),
    isCancelled: () => false,
  });
  await tick();
  assert.deepEqual(notes, [], "not sharing is the normal state, not a notice");
});

test("the share ticker contains its failures and does not read them as a stop", async () => {
  const notes: string[] = [];
  let publishFails = true;
  const tick = createShareTicker({
    status: async () => ({ running: true, note: null }),
    publish: async () => {
      if (publishFails) throw new Error("database is busy");
    },
    onNote: (note) => notes.push(note),
    isCancelled: () => false,
  });
  await assert.doesNotReject(() => tick());
  publishFails = false;
  await tick();
  assert.deepEqual(notes, [], "a failed publish is not a stopped server");
});

test("the share ticker does nothing after the shell locked", async () => {
  let published = 0;
  let cancelled = false;
  const tick = createShareTicker({
    status: async () => ({ running: true, note: null }),
    publish: async () => {
      published += 1;
    },
    onNote: () => undefined,
    isCancelled: () => cancelled,
  });
  cancelled = true;
  await tick();
  assert.equal(published, 0, "the publisher is paused while locked");
});

test("concurrent share ticks do not double-fire the stop note", async () => {
  // A `status()` read that started before sharing stopped answers late, with
  // the stale `running: true` view it took when it began. Without the
  // inFlight guard, a newer tick can observe the stop in between,
  // raise the note, and then the stale answer re-arms `wasRunning` — so the
  // next tick raises the same note a second time.
  const notes: string[] = [];
  let running = true;
  let slowNext = false;
  const tick = createShareTicker({
    status: async () => {
      if (slowNext) {
        slowNext = false;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { running: true, note: null };
      }
      return { running, note: running ? null : "Stopped sharing." };
    },
    publish: async () => undefined,
    onNote: (note) => notes.push(note),
    isCancelled: () => false,
  });

  await tick(); // server up → wasRunning is armed
  running = false; // the server stops...
  slowNext = true;
  const stale = tick(); // ...while a stale read is still in flight
  await tick(); // must be a no-op while the stale tick runs
  await stale; // the stale answer re-arms wasRunning
  await tick(); // the first tick to actually see the stop raises the note
  assert.equal(notes.length, 1, "the stop note fires exactly once");
});

function reminderTick(over: Partial<ReminderTickPorts> = {}) {
  const events: string[] = [];
  const ports: ReminderTickPorts = {
    now: () => "2026-10-16T09:00",
    due: async () => [],
    // One settle call per tick (docs/AUDIT.md PERF-08); the events keep the
    // same per-reminder names the old per-row ports pushed.
    settle: async (outcomes) => {
      for (const o of outcomes) {
        events.push(
          o.nextRemindAt === null
            ? `fired:${o.id}`
            : `rescheduled:${o.id}:${o.nextRemindAt}`,
        );
      }
    },
    requestPermission: async () => true,
    // Default ON so the earlier expectations below (the per-reminder
    // "Reminder: {title}" title) keep exercising the opt-in path; the preview
    // and burst tests override this.
    previewEnabled: async () => true,
    notify: ({ title }) => {
      events.push(`notify:${title}`);
    },
    onPermissionDenied: () => {
      events.push("denied");
    },
    // `onFired` is deliberately absent from the shared fixture: it is optional,
    // and leaving it out means the pre-P3-32 tests below keep exercising the
    // exact port set that shipped before it existed.
    isCancelled: () => false,
    ...over,
  };
  return { tick: createReminderTicker(ports), events };
}

test("the ticker reports that it fired, after the rows are written (P3-32)", async () => {
  // The signal an already-open `RemindersSection` uses to re-read. Without it a
  // reminder marked fired by the background poll stayed on the list as pending
  // until the user navigated away and back.
  const { tick, events } = reminderTick({
    due: async () => [reminderRow({ id: 7, title: "Pay rent" })],
    onFired: () => {
      events.push("onFired");
    },
  });
  await tick();
  assert.deepEqual(events, ["notify:Reminder: Pay rent", "fired:7", "onFired"]);
  // Ordering is the point: a listener that re-reads on this signal must see the
  // marked row, so `onFired` has to come after the writes.
  assert.ok(
    events.indexOf("onFired") > events.indexOf("fired:7"),
    "onFired must follow the write, not precede it",
  );
});

test("the ticker stays silent when nothing was due (P3-32)", async () => {
  // No signal, no re-read: a listener that reloads on every tick would hammer
  // the database 30 times a minute for no reason.
  const { tick, events } = reminderTick({
    onFired: () => {
      events.push("onFired");
    },
  });
  await tick();
  assert.deepEqual(events, []);
});

test("the reminder ticker notifies and marks a one-off reminder fired", async () => {
  const { tick, events } = reminderTick({
    due: async () => [reminderRow({ id: 7, title: "Pay rent" })],
  });
  await tick();
  assert.deepEqual(events, ["notify:Reminder: Pay rent", "fired:7"]);
});

test("the reminder ticker re-arms a repeating reminder into the future", async () => {
  const { tick, events } = reminderTick({
    due: async () => [
      reminderRow({ id: 3, repeat: "daily", remind_at: "2026-10-01T09:00" }),
    ],
  });
  await tick();
  assert.deepEqual(events, [
    "notify:Reminder: Water the plants",
    "rescheduled:3:2026-10-17T09:00",
  ]);
});

test("the reminder ticker asks for permission once per session", async () => {
  let asked = 0;
  const { tick } = reminderTick({
    due: async () => [reminderRow()],
    requestPermission: async () => {
      asked += 1;
      return true;
    },
  });
  await tick();
  await tick();
  assert.equal(asked, 1, "a granted permission is not re-requested");
});

test("the reminder ticker reports a denied permission instead of dropping reminders", async () => {
  const { tick, events } = reminderTick({
    due: async () => [reminderRow()],
    requestPermission: async () => false,
  });
  await tick();
  assert.deepEqual(events, ["denied"], "no notification is attempted");
});

test("a denial stays a denial on every later tick — the rows are never consumed", async () => {
  // The H1 regression: the old ticker recorded only "a prompt happened", so
  // tick 2 skipped the check, called `notify()` (dropped by the OS) and marked
  // or re-armed every due reminder 30 seconds after telling the user that
  // blocked notifications leave due reminders listed in Tasks.
  let asks = 0;
  const { tick, events } = reminderTick({
    due: async () => [reminderRow()],
    requestPermission: async () => {
      asks += 1;
      return false;
    },
  });
  await tick();
  await tick();
  await tick();
  assert.deepEqual(
    events,
    ["denied"],
    "one notice, and still no notify, no mark and no reschedule",
  );
  assert.equal(
    asks,
    3,
    "permission is re-checked, so enabling it in OS settings is picked up",
  );
});

test("a thrown permission prompt is contained and asked again, not assumed granted", async () => {
  // The old code moved its `requested` flag BEFORE the await, so a transient
  // rejection left the ticker permanently past the permission check.
  let asks = 0;
  const { tick, events } = reminderTick({
    due: async () => [reminderRow()],
    requestPermission: async () => {
      asks += 1;
      if (asks === 1) throw new Error("prompt service unavailable");
      return true;
    },
  });
  await tick();
  assert.deepEqual(
    events,
    [],
    "no notification and no write on an unanswered prompt",
  );
  await tick();
  assert.equal(asks, 2, "the unanswered question is asked again");
  assert.deepEqual(events, ["notify:Reminder: Water the plants", "fired:1"]);
});

test("the reminder ticker reports nothing when the shell locks during a denied prompt", async () => {
  // The other half of the lock-during-permission race: the dialog resolves
  // false AFTER the lock. The denial notice must not be raised from behind the
  // lock screen — cancellation is checked before it, not after.
  let cancelled = false;
  let answer: ((granted: boolean) => void) | undefined;
  const permission = new Promise<boolean>((resolve) => {
    answer = resolve;
  });
  const { tick, events } = reminderTick({
    due: async () => [reminderRow()],
    requestPermission: () => permission,
    isCancelled: () => cancelled,
  });
  const pending = tick();
  await Promise.resolve();
  await Promise.resolve();
  cancelled = true;
  answer?.(false);
  await pending;
  assert.deepEqual(events, [], "no notice, notification or write after lock");
});

test("the reminder ticker does not stack ticks while one is in flight", async () => {
  let release: (() => void) | undefined;
  const { tick, events } = reminderTick({
    due: async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [reminderRow()];
    },
  });
  const first = tick();
  await tick(); // must be a no-op: the first tick is still awaiting
  release?.();
  await first;
  assert.deepEqual(events, ["notify:Reminder: Water the plants", "fired:1"]);
});

test("the reminder ticker fires nothing after the shell locked", async () => {
  const { tick, events } = reminderTick({
    due: async () => [reminderRow()],
    isCancelled: () => true,
  });
  await tick();
  assert.deepEqual(events, [], "no notification over the lock screen");
});

test("the reminder ticker stops when the shell locks during permission", async () => {
  let cancelled = false;
  let grantPermission: ((granted: boolean) => void) | undefined;
  const permission = new Promise<boolean>((resolve) => {
    grantPermission = resolve;
  });
  const { tick, events } = reminderTick({
    due: async () => [reminderRow()],
    requestPermission: () => permission,
    isCancelled: () => cancelled,
  });
  const pending = tick();
  await Promise.resolve();
  await Promise.resolve();
  cancelled = true;
  grantPermission?.(true);
  await pending;
  assert.deepEqual(events, [], "no notification or write after lock");
});

test("the ticker does not signal a re-read once the shell locked mid-write", async () => {
  // `onFired` runs after the write loop, so a lock landing while the marks are
  // in flight must suppress it: the poll is paused and nothing should poke a
  // listener from behind the lock screen.
  let cancelled = false;
  const { tick, events } = reminderTick({
    due: async () => [reminderRow()],
    settle: async (outcomes) => {
      for (const o of outcomes) events.push(`fired:${o.id}`);
      cancelled = true; // the lock lands while this write is in flight
    },
    onFired: () => {
      events.push("onFired");
    },
    isCancelled: () => cancelled,
  });
  await tick();
  assert.deepEqual(
    events,
    ["notify:Reminder: Water the plants", "fired:1"],
    "the write happened, the re-read signal did not",
  );
});

test("the reminder ticker stops when the shell locks during preview lookup", async () => {
  let cancelled = false;
  let finishPreview: ((enabled: boolean) => void) | undefined;
  const preview = new Promise<boolean>((resolve) => {
    finishPreview = resolve;
  });
  const { tick, events } = reminderTick({
    due: async () => [reminderRow()],
    previewEnabled: () => preview,
    isCancelled: () => cancelled,
  });
  const pending = tick();
  await Promise.resolve();
  await Promise.resolve();
  cancelled = true;
  finishPreview?.(true);
  await pending;
  assert.deepEqual(events, [], "no notification or write after lock");
});

test("the reminder ticker contains a failed query", async () => {
  const { tick, events } = reminderTick({
    due: async () => {
      throw new Error("db is locked");
    },
  });
  await assert.doesNotReject(() => tick());
  assert.deepEqual(events, []);
});

// -- Notification previews and the wake/unlock burst ------------------

/**
 * Capture full `{title, body}` pairs — the shared fixture records only the
 * title, and these tests exist to pin what must NOT reach the OS.
 */
function capturingTick(over: Partial<ReminderTickPorts> = {}) {
  const sent: { title: string; body: string }[] = [];
  const base = reminderTick({
    notify: (input) => {
      sent.push(input);
    },
    ...over,
  });
  return { ...base, sent };
}

test("previews off — a single due reminder raises generic text, never the note (decision 3)", async () => {
  const { tick, events, sent } = capturingTick({
    previewEnabled: async () => false,
    due: async () => [reminderRow({ title: "Therapy appointment" })],
  });
  await tick();
  assert.deepEqual(sent, [
    { title: "Reminder due", body: "Open Purple Memo to see the reminder." },
  ]);
  const first = sent[0] ?? { title: "", body: "" };
  assert.ok(
    !first.body.includes("kitchen") && !first.title.includes("Therapy"),
    "no reminder text of any kind may reach the OS with previews off",
  );
  assert.deepEqual(events, ["fired:1"], "the row is still marked fired");
});

test("previews on — a single due reminder carries its title and note (decision 3)", async () => {
  const { tick, sent } = capturingTick({
    previewEnabled: async () => true,
    due: async () => [reminderRow({ title: "Pay rent" })],
  });
  await tick();
  assert.deepEqual(sent, [
    { title: "Reminder: Pay rent", body: "kitchen + balcony" },
  ]);
});

test("a burst of due reminders coalesces into one summary toast (decision 4)", async () => {
  // The unlock-after-downtime case: everything that came due while the app was
  // closed arrives in one tick. One toast, not one per reminder — and the
  // summary carries no reminder text even with previews on.
  const { tick, events, sent } = capturingTick({
    previewEnabled: async () => true,
    due: async () => [
      reminderRow({ id: 1, title: "Water plants" }),
      reminderRow({ id: 2, title: "Pay rent", repeat: "daily" }),
    ],
  });
  await tick();
  assert.deepEqual(sent, [
    { title: "Reminders", body: "2 reminders are due — open Purple Memo." },
  ]);
  assert.deepEqual(
    events,
    ["fired:1", "rescheduled:2:2026-10-17T09:00"],
    "every row is still marked or re-armed exactly as before",
  );
});

test("a preview read that throws falls back to the private text", async () => {
  // Privacy must not depend on the settings read being healthy.
  const { tick, sent } = capturingTick({
    previewEnabled: async () => {
      throw new Error("settings table unreadable");
    },
    due: async () => [reminderRow()],
  });
  await tick();
  assert.deepEqual(sent, [
    { title: "Reminder due", body: "Open Purple Memo to see the reminder." },
  ]);
});

// docs/AUDIT.md PERF-08: one settle call per tick, whatever the due count.
test("the reminder ticker settles every due reminder in one call", async () => {
  const calls: { id: number; nextRemindAt: string | null }[][] = [];
  const reminders = [
    { ...reminderRow(), id: 1 },
    { ...reminderRow(), id: 2, repeat: "daily" as const },
    { ...reminderRow(), id: 3 },
  ];
  const { tick } = reminderTick({
    due: async () => reminders,
    settle: async (outcomes) => {
      calls.push(outcomes);
    },
  });
  await tick();
  assert.equal(calls.length, 1, "one batch, not one write per reminder");
  assert.deepEqual(
    calls[0]?.map((o) => o.id),
    [1, 2, 3],
  );
  assert.equal(calls[0]?.[0]?.nextRemindAt, null, "one-shot -> fired");
  assert.match(
    String(calls[0]?.[1]?.nextRemindAt),
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/,
    "repeating -> re-armed",
  );
  assert.equal(calls[0]?.[2]?.nextRemindAt, null);
});
