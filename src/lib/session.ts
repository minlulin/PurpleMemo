// The app shell's session coordination — locking (§2.9), the LAN publisher
// (§8) and the reminder poll (§2.7) — extracted from `AppShell` so the rules
// can be tested (review I-02).
//
// `node --test` runs modules, not components: anything that lives inside
// `App.tsx` is unreachable for the suite, which is how the A-01 fix
// ("locking ends sharing") came to have no regression test at all. These are
// pure functions over injected ports; the component keeps the React concerns —
// state, effects, timers, event listeners — and nothing else.
//
// Every rule below is a comment in the component's voice, because each one is
// invisible when it breaks: a lock that leaves the phone link up, a poll that
// notifies over the lock screen, a note that repeats on every tick.

import { nextReminderAt } from "./tasks.ts";
import type { ReminderRow } from "./types.ts";

/** What locking has to do, injected so a test can watch it happen. */
export interface LockPorts {
  /** Drop the vault key cache (§5.3) — in-memory keys only. */
  lockVault: () => void;
  /** Tear the LAN listener down (§8). */
  stopSharing: () => Promise<unknown>;
  /** Flip the shell to locked. */
  onLocked: () => void;
}

/**
 * Lock now (§2.9). Three rules, each pinned by a test:
 *
 * 1. **Locking ends sharing** (audit A-01). The phone link must die with the
 *    session: a lock that leaves the LAN server running keeps publishing the
 *    dashboard to the network for as long as the app stays open, which is the
 *    opposite of what the lock screen promises.
 * 2. **The shell always ends up locked**, whatever the earlier steps do.
 *    Failing open is the one outcome this must never have.
 * 3. **The teardown is best-effort.** The lock screen never waits on the
 *    network listener, and a failure there is not the user's problem.
 */
export function lockSession(ports: LockPorts): void {
  try {
    ports.lockVault();
  } catch {
    // The cache is memory, so nothing is left decryptable by this failing;
    // the session still has to end.
  }
  try {
    ports.onLocked();
  } catch {
    // The UI state is the caller's business — sharing still stops below.
  }
  try {
    void Promise.resolve(ports.stopSharing()).catch(() => undefined);
  } catch {
    // `stopSharing` threw synchronously rather than rejecting; same rule.
  }
}

/** The slice of a share status the publisher cares about (structurally `ShareInfo`). */
export interface ShareStatusLike {
  running: boolean;
  note?: string | null;
}

/** Ports for one LAN publisher tick. */
export interface ShareTickPorts {
  status: () => Promise<ShareStatusLike>;
  publish: () => Promise<unknown>;
  /** The in-app note channel, shared with the reminder poll. */
  onNote: (note: string) => void;
  /** True once the shell unmounted or locked — see §2.9. */
  isCancelled: () => boolean;
}

/**
 * One tick of the LAN publisher (§8, P5): re-read the rows the phone sees and
 * publish them, and surface a server that stopped itself (too many wrong
 * pairing codes) through the note channel.
 *
 * The note is raised on the running → stopped edge only. `running: false` is
 * the normal state of an app nobody is sharing from, so surfacing it on every
 * tick would turn a security notice into permanent background noise — and
 * after the first one it would say nothing.
 *
 * Best-effort by design: the database is the source of truth, so neither a
 * failed status read nor a failed publish may break the app. A failed publish
 * deliberately does not read as "stopped": the server is still running, and
 * the next tick tries again.
 */
export function createShareTicker(ports: ShareTickPorts): () => Promise<void> {
  let wasRunning = false;
  let inFlight = false;
  return async () => {
    // Ticks never stack (FIX-03), same rule as the reminder poll: if a slow
    // `status()` or `publish()` is still awaited, the next interval fire is a
    // no-op, so a newer tick can never read `wasRunning` mid-flight of an
    // older one and raise a spurious stop note on the wrong tick.
    if (inFlight) return;
    inFlight = true;
    try {
      const info = await ports.status();
      if (ports.isCancelled()) return;
      if (!info.running) {
        if (wasRunning && info.note) ports.onNote(info.note);
        wasRunning = false;
        return;
      }
      wasRunning = true;
      await ports.publish();
    } catch {
      // See above — the poll must never break the app.
    } finally {
      inFlight = false;
    }
  };
}

/** Ports for one reminder tick (§2.7). */
export interface ReminderTickPorts {
  /** Local datetime (`yyyy-mm-ddTHH:mm`), injected so tests own the clock. */
  now: () => string;
  due: (now: string) => Promise<ReminderRow[]>;
  markFired: (id: number) => Promise<void>;
  reschedule: (id: number, remindAt: string) => Promise<void>;
  /** Ask the OS for notification permission; false when denied. */
  requestPermission: () => Promise<boolean>;
  notify: (input: { title: string; body: string }) => void;
  onPermissionDenied: () => void;
  /**
   * Called once per tick that actually fired at least one reminder (review
   * P3-32). The poll lives in the app shell, so a `RemindersSection` already on
   * screen had no way to learn that a reminder had just fired and been marked —
   * its list kept showing the reminder as pending until the user navigated away
   * and back. This is the signal that lets an open page re-read.
   */
  onFired?: () => void;
  isCancelled: () => boolean;
}

/**
 * One tick of the reminder poll (§2.7): fire a local notification per due
 * reminder, then either mark it fired (`repeat: none`) or re-arm it to its
 * next future occurrence via [`nextReminderAt`].
 *
 * Three rules that the component used to hold on its own:
 *
 * * **Permission is asked once per session**, and a denial is reported once
 *   instead of silently dropping every reminder.
 * * **Ticks never stack.** A tick that is still awaiting its query makes the
 *   next one a no-op, so a slow database cannot multiply notifications.
 * * **Nothing fires after the shell unmounts or locks** — the poll is paused
 *   while locked (§2.9), so notifications never surface over the lock screen.
 *
 * Best-effort, like the publisher: the reminders list is the source of truth.
 */
export function createReminderTicker(
  ports: ReminderTickPorts,
): () => Promise<void> {
  let inFlight = false;
  let requested = false;
  return async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const now = ports.now();
      const due = await ports.due(now);
      if (due.length === 0 || ports.isCancelled()) return;
      if (!requested) {
        requested = true;
        if (!(await ports.requestPermission())) {
          ports.onPermissionDenied();
          return;
        }
      }
      for (const reminder of due) {
        ports.notify({
          title: `Reminder: ${reminder.title}`,
          body: reminder.note,
        });
        if (reminder.repeat === "none") {
          await ports.markFired(reminder.id);
        } else {
          await ports.reschedule(
            reminder.id,
            nextReminderAt(reminder.remind_at, reminder.repeat, now),
          );
        }
      }
      // After the writes, so a listener that re-reads sees the marked rows.
      ports.onFired?.();
    } catch {
      // See above — a broken reminder row must not take the app down.
    } finally {
      inFlight = false;
    }
  };
}
