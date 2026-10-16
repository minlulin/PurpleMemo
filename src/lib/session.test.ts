// The app shell's session coordination (review I-02, audit A-01): locking must
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

test("lockSession ends the LAN session (A-01: locking ends sharing)", () => {
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
  // Rejected promise, and a synchronous throw — both are best-effort.
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
      }),
    );
    assert.equal(locked, true);
  }
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
    note: "Stopped sharing after 10 wrong pairing codes.",
  };
  await tick();
  await tick();
  await tick();
  assert.deepEqual(notes, ["Stopped sharing after 10 wrong pairing codes."]);
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
  assert.equal(published, 0, "the publisher is paused while locked (§2.9)");
});

test("concurrent share ticks do not double-fire the stop note", async () => {
  // A `status()` read that started before sharing stopped answers late, with
  // the stale `running: true` view it took when it began. Without the
  // inFlight guard (FIX-03), a newer tick can observe the stop in between,
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
    markFired: async (id) => {
      events.push(`fired:${id}`);
    },
    reschedule: async (id, at) => {
      events.push(`rescheduled:${id}:${at}`);
    },
    requestPermission: async () => true,
    notify: ({ title }) => {
      events.push(`notify:${title}`);
    },
    onPermissionDenied: () => {
      events.push("denied");
    },
    isCancelled: () => false,
    ...over,
  };
  return { tick: createReminderTicker(ports), events };
}

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
  assert.deepEqual(events, [], "no notification over the lock screen (§2.9)");
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
