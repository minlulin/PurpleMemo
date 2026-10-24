// The app shell's session coordination — locking, the LAN publisher
// and the reminder poll — extracted from `AppShell` so the rules
// can be tested.
//
// `node --test` runs modules, not components: anything that lives inside
// `App.tsx` is unreachable for the suite, which is how the fix
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
  /** Drop the vault key cache — in-memory keys only. */
  lockVault: () => void;
  /** Tear the LAN listener down. */
  stopSharing: () => Promise<unknown>;
  /** Flip the shell to locked. */
  onLocked: () => void;
  /**
   * Called once, after every retry failed, when the listener could not be
   * stopped. Optional because a caller with nowhere to show it
   * should not have to invent a handler.
   */
  onShareStopFailed?: (error: unknown) => void;
  /** Delay before each retry, in order; the first attempt is immediate. */
  retryDelaysMs?: readonly number[];
  /** Per-attempt budget: a listener that never answers counts as failed. */
  stopTimeoutMs?: number;
  /** Test seam, so a retry test does not spend real time waiting. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * How hard the lock tries to stop the LAN listener before giving up.
 *
 * Roughly a minute of background attempts. The lock screen never waits on any
 * of this — it is scheduled and forgotten — but a stop that fails once (a busy
 * worker, a client mid-write) or hangs (a listener joined on a stalled socket)
 * gets another chance, and the last failure is the only one reported.
 */
export const SHARE_STOP_RETRY_DELAYS_MS = [
  250, 1_000, 3_000, 5_000, 10_000, 30_000,
];
/** A stop that has not answered in this long is treated as a failed attempt. */
export const SHARE_STOP_TIMEOUT_MS = 5_000;

/**
 * Race `work` against a timer, and always clear the timer: a pending 5 s
 * timeout would otherwise keep the process (or a test run) alive after a
 * successful stop.
 */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Stop sharing, retrying with backoff, and report the last failure once.
 *
 * Returns whether the listener is known to be down. Exported because this is
 * the rule the audit found missing: the old teardown swallowed the result, and
 * the status poller is paused while locked, so a listener that failed to stop
 * kept serving the dashboard with nothing on screen to say so.
 */
export async function stopSharingWithRetry(
  stopSharing: () => Promise<unknown>,
  opts: {
    retryDelaysMs?: readonly number[];
    stopTimeoutMs?: number;
    wait?: (ms: number) => Promise<void>;
    onFailed?: (error: unknown) => void;
  } = {},
): Promise<boolean> {
  const delays = opts.retryDelaysMs ?? SHARE_STOP_RETRY_DELAYS_MS;
  const timeoutMs = opts.stopTimeoutMs ?? SHARE_STOP_TIMEOUT_MS;
  const wait =
    opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: unknown = new Error("sharing was never stopped");
  // One immediate attempt, then one per configured delay.
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      await withTimeout(stopSharing(), timeoutMs);
      return true;
    } catch (error) {
      lastError = error;
    }
    const delay = delays[attempt];
    if (delay !== undefined) await wait(delay);
  }
  try {
    opts.onFailed?.(lastError);
  } catch {
    // Reporting is best-effort too; the lock still stands.
  }
  return false;
}

/**
 * Lock now. Three rules, each pinned by a test:
 *
 * 1. **Locking ends sharing**. The phone link must die with the
 *    session: a lock that leaves the LAN server running keeps publishing the
 *    dashboard to the network for as long as the app stays open, which is the
 *    opposite of what the lock screen promises.
 * 2. **The shell always ends up locked**, whatever the earlier steps do.
 *    Failing open is the one outcome this must never have.
 * 3. **The teardown is best-effort, but not silent.** The lock screen never
 *    waits on the network listener; the stop runs in the background with a
 *    short retry schedule and a per-attempt timeout, and only after every
 *    attempt fails does `onShareStopFailed` run. A listener that
 *    did not stop is a serving confidentiality problem, not a cosmetic one.
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
  // Scheduled, never awaited: a hung `share_stop` must not freeze the lock
  // screen. `stopSharingWithRetry` absorbs a synchronous throw as a rejected
  // attempt just like a rejected promise.
  void stopSharingWithRetry(ports.stopSharing, {
    retryDelaysMs: ports.retryDelaysMs,
    stopTimeoutMs: ports.stopTimeoutMs,
    wait: ports.wait,
    onFailed: ports.onShareStopFailed,
  });
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
  /** True once the shell unmounted or locked — see  */
  isCancelled: () => boolean;
}

/**
 * One tick of the LAN publisher (P5): re-read the rows the phone sees and
 * publish them, and surface a server that stopped unexpectedly through the
 * note channel.
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
    // Ticks never stack, same rule as the reminder poll: if a slow
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

/**
 * User-visible notification copy. Injected rather than imported so
 * this module stays free of locale state and its tests keep pinning one set of
 * strings; the shell supplies the active language.
 */
export interface ReminderMessages {
  remindersTitle: string;
  remindersDue: (count: number) => string;
  previewTitle: (title: string) => string;
  dueTitle: string;
  dueBody: string;
}

export const ENGLISH_REMINDER_MESSAGES: ReminderMessages = {
  remindersTitle: "Reminders",
  remindersDue: (count) => `${count} reminders are due — open Purple Memo.`,
  previewTitle: (title) => `Reminder: ${title}`,
  dueTitle: "Reminder due",
  dueBody: "Open Purple Memo to see the reminder.",
};

/** Ports for one reminder tick. */
export interface ReminderTickPorts {
  /** Local datetime (`yyyy-mm-ddTHH:mm`), injected so tests own the clock. */
  now: () => string;
  due: (now: string) => Promise<ReminderRow[]>;
  markFired: (id: number) => Promise<void>;
  reschedule: (id: number, remindAt: string) => Promise<void>;
  /** Ask the OS for notification permission; false when denied. */
  requestPermission: () => Promise<boolean>;
  /**
   * Whether the notification may carry the reminder's text. Read fresh on every tick, so a Settings toggle
   * applies within one poll without restarting the app. A failure to read it
   * answers false — the private direction.
   */
  previewEnabled: () => Promise<boolean>;
  notify: (input: { title: string; body: string }) => void;
  /** Notification copy in the active language; English when omitted. */
  messages?: ReminderMessages;
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
 * One tick of the reminder poll: fire a local notification for the due
 * reminders, then either mark each one fired (`repeat: none`) or re-arm it to
 * its next future occurrence via [`nextReminderAt`].
 *
 * Four rules that the component used to hold on its own:
 *
 * * **Permission is asked once per session**, and a denial is reported once
 *   instead of silently dropping every reminder.
 * * **Ticks never stack.** A tick that is still awaiting its query makes the
 *   next one a no-op, so a slow database cannot multiply notifications.
 * * **Nothing fires after the shell unmounts or locks** — the poll is paused
 *   while locked, so notifications never surface over the lock screen.
 * * **Notification text is opt-in, and bursts coalesce**. With previews off — the default — a single due reminder raises
 *   "Reminder due" and no reminder text reaches the OS. A tick that finds more
 *   than one (the unlock-after-downtime burst) raises one summary instead of a
 *   toast per reminder. Either way the rows below are still marked or re-armed
 *   exactly as before: the notification is best-effort, the row is the truth.
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
      if (ports.isCancelled()) return;
      // A failed preview read answers false (the port's contract), so the
      // fallback here is only for a port that throws instead of answering.
      let preview = false;
      try {
        preview = await ports.previewEnabled();
      } catch {
        // Private by default, even when the settings read is broken.
      }
      if (ports.isCancelled()) return;
      const messages = ports.messages ?? ENGLISH_REMINDER_MESSAGES;
      if (due.length > 1) {
        // One summary for the wake/unlock burst: N toasts after downtime is
        // noise, and the count is the whole message — it carries no reminder
        // text even when previews are on.
        ports.notify({
          title: messages.remindersTitle,
          body: messages.remindersDue(due.length),
        });
      } else {
        // `due.length` is 1 here (0 returned above); the explicit undefined
        // check is what lets TypeScript believe that too.
        const only = due.length === 1 ? due[0] : undefined;
        if (only !== undefined) {
          ports.notify(
            preview
              ? { title: messages.previewTitle(only.title), body: only.note }
              : { title: messages.dueTitle, body: messages.dueBody },
          );
        }
      }
      for (const reminder of due) {
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
