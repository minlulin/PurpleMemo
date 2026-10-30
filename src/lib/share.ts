// P5 share: the read-only snapshot the phone sees on the same network.
//
// The desktop is the single writer — this module does not sync anything. It
// loads the same rows the Dashboard shows, turns them into a small,
// display-ready, bounded JSON payload, and hands it to Rust, which serves it
// over the LAN as AES-GCM ciphertext. The URL-fragment key is never sent in an
// HTTP request; the network path never touches the DB.
//
// Everything user-facing (labels, money, excerpts) is formatted HERE, so the
// phone page is a dumb painter and the Vault is structurally absent — the
// snapshot builder takes no vault/settings/photo input at all

import { gcm } from "@noble/ciphers/aes.js";
import type { DataDriver, ShareInfo } from "../data/driver.ts";
import { createBudgetRepo, type DayTotals } from "./budget.ts";
import { createBusinessRepo } from "./business.ts";
import { birthdayLabel, createContactsRepo } from "./contacts.ts";
import { bytesToB64, randomBytes } from "./crypto.ts";
import { expiringWarranties } from "./dashboard.ts";
import { localISODateTime, todayLocal } from "./dates.ts";
import { createHabitsRepo } from "./habits.ts";
import { createMemoriesRepo } from "./memories.ts";
import { formatMMK } from "./money.ts";
import { createNotesRepo, noteExcerpt } from "./notes.ts";
import { createTasksRepo } from "./tasks.ts";
import type {
  ContactRow,
  MemoryRow,
  NoteRow,
  ReminderRow,
  TaskRow,
} from "./types.ts";

/** Bumped when the payload shape changes (the phone page reads it). */
export const SHARE_SNAPSHOT_VERSION = 1;
const SHARE_NONCE_BYTES = 12;

/**
 * The forward window every section of the glance looks through, in days —
 * warranties, upcoming memories and birthdays all read the same horizon, so
 * they share one name instead of three copies of `14`.
 */
export const SHARE_HORIZON_DAYS = 14;

/**
 * The ceiling Rust puts on a published envelope, mirrored from
 * `MAX_SNAPSHOT_BYTES` in `src-tauri/src/share.rs` (I4).
 *
 * `parse_snapshot` refuses an over-large snapshot *before* it replaces the
 * stored one, which makes a payload that grows past this the quiet failure
 * this whole module is built to avoid: the phone keeps showing the last good
 * ciphertext, the ticker keeps retrying, and nothing on either side says why.
 * The per-field budgets below keep every envelope inside this; the check in
 * {@link encryptSnapshot} turns a future field that forgot its budget into an
 * error here rather than a refusal across the LAN. The two constants are
 * pinned together by a test in `share.test.ts`.
 */
export const MAX_SNAPSHOT_BYTES = 512 * 1024;

/**
 * UTF-8 byte budget for one user-authored string in the snapshot (I4).
 *
 * `SHARE_LIMITS` bounds how many *rows* each section publishes; nothing
 * bounded how big a row's text could be. A task title is a free-text field
 * that the CSV importer accepts from a 5 MiB file with no length limit of its
 * own, so one imported row could put a 400 KiB title into the snapshot — and
 * `encryptSnapshot` base64s the whole thing into an envelope Rust then
 * refuses.
 *
 * The arithmetic this budget has to win: ~140 user-authored strings across
 * every section fit in this snapshot (`SHARE_LIMITS` sums to 140 rows), so
 * 140 × 1 KiB is a ~140 KiB plaintext — under half of what AES-GCM plus
 * base64 leave room for inside {@link MAX_SNAPSHOT_BYTES}. It is generous for
 * a glance: a title that needs a kilobyte is already unreadable on the phone,
 * and clipping it costs the phone a suffix it would never have shown.
 */
export const SHARE_TEXT_MAX_BYTES = 1024;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

/**
 * Clip a string to `maxBytes` UTF-8 bytes without splitting a code point
 * (I4) — an ellipsis stands in for what was cut.
 *
 * Slicing the *string* would be wrong: a Myanmar or emoji title sliced at
 * `maxBytes` characters would still be up to four times that in bytes, and a
 * byte slice through the middle of a code point would publish a replacement
 * character instead of the text. So the bytes are cut and decoded back, and
 * any half code point the cut left at the end (decoded as U+FFFD) goes with
 * the truncation.
 */
export function clipToBytes(
  text: string,
  maxBytes: number = SHARE_TEXT_MAX_BYTES,
): string {
  const bytes = TEXT_ENCODER.encode(text);
  if (bytes.length <= maxBytes) return text;
  // Room for the U+2026 that stands in for the rest.
  const head = TEXT_DECODER.decode(
    bytes.subarray(0, Math.max(1, maxBytes - 3)),
  );
  return `${head.replace(/\uFFFD+$/, "").replace(/…$/, "")}…`;
}

function shareKeyBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error("share encryption key is malformed");
  }
  return Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

/**
 * Seal a snapshot into the envelope the phone page decrypts.
 *
 * Exported for the phone-page test: the only honest way to test
 * the decryptor is to feed it an envelope this function produced, rather than
 * a fixture that could drift from the real format.
 */
export function encryptSnapshot(
  snapshot: ShareSnapshot,
  keyHex: string,
): string {
  const nonce = randomBytes(SHARE_NONCE_BYTES);
  const generatedAt = snapshot.generatedAt;
  const aad = new TextEncoder().encode(
    `purple-memo/share/v${SHARE_SNAPSHOT_VERSION}\0${generatedAt}`,
  );
  const ciphertext = gcm(shareKeyBytes(keyHex), nonce, aad).encrypt(
    new TextEncoder().encode(JSON.stringify(snapshot)),
  );
  const envelope = JSON.stringify({
    version: SHARE_SNAPSHOT_VERSION,
    generatedAt,
    nonce: bytesToB64(nonce),
    ciphertext: bytesToB64(ciphertext),
  });
  // I4: the envelope is ASCII (base64 ciphertext, ISO timestamps, a small
  // int), so its length *is* its UTF-8 byte length — the same thing Rust
  // measures against `MAX_SNAPSHOT_BYTES`. Refusing here names the problem
  // and stops it being published; letting it through would be a snapshot the
  // server rejects while the phone goes on showing the one before it.
  //
  // The budgets in `buildShareSnapshot` are what make this unreachable in
  // production — this is the tripwire for the field somebody adds next
  // without them.
  if (envelope.length > MAX_SNAPSHOT_BYTES) {
    throw new Error(
      `share snapshot is ${envelope.length.toLocaleString("en-US")} bytes — over the ${MAX_SNAPSHOT_BYTES.toLocaleString("en-US")} byte limit, not published.`,
    );
  }
  return envelope;
}

/**
 * Row caps per section. The snapshot is a glance, not a database dump: a
 * bounded payload keeps the LAN response small and the phone page fast.
 */
export const SHARE_LIMITS = {
  wallets: 20,
  tasks: 10,
  reminders: 10,
  habits: 20,
  upcoming: 20,
  birthdays: 20,
  warranties: 20,
  notes: 20,
} as const;

/** Everything the snapshot needs, already loaded — no driver, no SQL. */
export interface ShareSnapshotInput {
  today: string;
  generatedAt: string;
  /**
   * Today's money in and out, already summed (I3). It used to arrive as the
   * day's entry rows, which meant the publisher transferred every transaction
   * of the day to publish two numbers it never listed.
   */
  dayTotals: DayTotals;
  walletBalances: { name: string; balanceCents: number }[];
  receivableCents: number;
  dueTasks: TaskRow[];
  reminders: ReminderRow[];
  habits: {
    name: string;
    doneThisWeek: number;
    current: number;
    best: number;
  }[];
  upcoming: MemoryRow[];
  birthdays: ContactRow[];
  warranties: { id: number; title: string; endDate: string }[];
  notes: NoteRow[];
}

/**
 * The served payload. Every field is a display string or a plain number —
 * the phone page formats nothing, so money and dates read identically to the
 * desktop (one formatting path).
 */
export interface ShareSnapshot {
  version: number;
  generatedAt: string;
  today: string;
  money: { income: string; expense: string };
  wallets: { name: string; balance: string }[];
  receivableTotal: string;
  tasks: { title: string; due: string | null }[];
  reminders: { title: string; at: string }[];
  habits: {
    name: string;
    doneThisWeek: number;
    current: number;
    best: number;
  }[];
  upcoming: { title: string; date: string }[];
  birthdays: { name: string; label: string }[];
  warranties: { title: string; endDate: string }[];
  notes: { title: string; excerpt: string; updatedAt: string }[];
}

/**
 * Today-at-a-glance → the phone payload. Pure: same input, same output,
 * and the section list is fixed — there is no field here that could carry a
 * vault item, a setting or photo bytes.
 *
 * Two bounds are applied here, on the way out of every section (I4):
 * {@link SHARE_LIMITS} on how many rows a section may publish, and
 * {@link clipToBytes} on the size of each string inside them — the first is a
 * count, the second is bytes, and only together do they bound the envelope
 * that {@link encryptSnapshot} hands to Rust. The strings that skip clipping
 * are the ones the app itself formats: `formatMMK` output (a number's
 * decimal representation) and ISO dates (fixed-shape columns), neither of
 * which a user can make longer.
 */
export function buildShareSnapshot(input: ShareSnapshotInput): ShareSnapshot {
  return {
    version: SHARE_SNAPSHOT_VERSION,
    generatedAt: input.generatedAt,
    today: input.today,
    money: {
      income: formatMMK(input.dayTotals.incomeCents),
      expense: formatMMK(input.dayTotals.expenseCents),
    },
    wallets: input.walletBalances.slice(0, SHARE_LIMITS.wallets).map((w) => ({
      name: clipToBytes(w.name),
      balance: formatMMK(w.balanceCents),
    })),
    receivableTotal: formatMMK(Math.max(0, input.receivableCents)),
    tasks: input.dueTasks.slice(0, SHARE_LIMITS.tasks).map((t) => ({
      title: clipToBytes(t.title),
      due: t.due_date,
    })),
    reminders: input.reminders.slice(0, SHARE_LIMITS.reminders).map((r) => ({
      title: clipToBytes(r.title),
      at: r.remind_at,
    })),
    habits: input.habits.slice(0, SHARE_LIMITS.habits).map((h) => ({
      name: clipToBytes(h.name),
      doneThisWeek: h.doneThisWeek,
      current: h.current,
      best: h.best,
    })),
    upcoming: input.upcoming.slice(0, SHARE_LIMITS.upcoming).map((m) => ({
      title: clipToBytes(m.title),
      date: m.memory_date,
    })),
    birthdays: input.birthdays.slice(0, SHARE_LIMITS.birthdays).map((c) => ({
      name: clipToBytes(c.name),
      label: clipToBytes(birthdayLabel(c.birthday ?? "")),
    })),
    warranties: input.warranties.slice(0, SHARE_LIMITS.warranties).map((w) => ({
      title: clipToBytes(w.title),
      endDate: w.endDate,
    })),
    notes: input.notes.slice(0, SHARE_LIMITS.notes).map((n) => ({
      title: clipToBytes(n.title),
      excerpt: clipToBytes(noteExcerpt(n.content)),
      updatedAt: n.updated_at,
    })),
  };
}

/**
 * Loads the Dashboard's rows through the normal repositories, builds the
 * snapshot and publishes it to Rust (— the same single-driver path as
 * every other feature; the UI never talks to Tauri directly).
 *
 * `publishSnapshot` is the only writer: the phone can read what the desktop
 * last published, and nothing else.
 */
/**
 * The domain repositories the snapshot reads, as the composition root
 * already built them (J5). Every field is optional: a caller that passes
 * nothing gets the default-constructed repo it always did, while `app.ts`
 * passes its singletons so no domain repo (and no `KeyedMutex` or
 * `trashRepo` inside one) is ever constructed twice for the same driver —
 * per-instance state would otherwise silently split across two copies.
 */
export interface ShareRepos {
  budget?: ReturnType<typeof createBudgetRepo>;
  business?: ReturnType<typeof createBusinessRepo>;
  tasks?: ReturnType<typeof createTasksRepo>;
  habits?: ReturnType<typeof createHabitsRepo>;
  memories?: ReturnType<typeof createMemoriesRepo>;
  contacts?: ReturnType<typeof createContactsRepo>;
  notes?: ReturnType<typeof createNotesRepo>;
}

export function createShareRepo(driver: DataDriver, repos: ShareRepos = {}) {
  let shareKey: string | null = null;
  const budget = repos.budget ?? createBudgetRepo(driver);
  const business = repos.business ?? createBusinessRepo(driver);
  const tasks = repos.tasks ?? createTasksRepo(driver);
  const habits = repos.habits ?? createHabitsRepo(driver);
  const memories = repos.memories ?? createMemoriesRepo(driver);
  const contacts = repos.contacts ?? createContactsRepo(driver);
  const notes = repos.notes ?? createNotesRepo(driver);

  return {
    /**
     * Start the LAN share
     *
     * Two steps on purpose: `armConsent` records that the user
     * confirmed the prompt and returns a one-shot token, which `start` must
     * present. Opening a listener on `0.0.0.0` puts a read-only view of the
     * user's notes and balances on the network, and that must not be one bare
     * call away. The token is good for exactly one attempt.
     */
    async start(): Promise<ShareInfo> {
      const info = await driver.shareStart(await driver.shareArm());
      shareKey = info.key;
      return info;
    },
    async stop() {
      const info = await driver.shareStop();
      shareKey = null;
      return info;
    },
    /**
     * Stop for a lock (D2a) — a different stop, on purpose.
     *
     * An ordinary `stop` retires the listener and leaves an armed consent
     * token alive: the token is the user's confirmation of a prompt they may
     * still have on screen, and a stop is not a reason to make them confirm
     * again. Locking is the opposite situation. `lockSession`'s first rule is
     * that locking ends sharing, and a start that was already in flight when
     * the shell locked could otherwise bind `0.0.0.0` a moment later — after
     * the user has walked away from a screen that says the LAN share is off.
     *
     * So this variant revokes the pending token *and* supersedes any token
     * already spent by a start that has not finished binding: Rust bumps a
     * lock epoch here, and `share_start` re-checks its own epoch under the
     * server lock before it binds. Ordinary stop/start token semantics are
     * untouched.
     */
    async stopForLock(): Promise<ShareInfo> {
      const info = await driver.shareStop(true);
      shareKey = null;
      return info;
    },
    async status() {
      const info = await driver.shareStatus();
      shareKey = info.running ? info.key : null;
      return info;
    },

    async publishSnapshot() {
      if (shareKey === null) {
        const info = await driver.shareStatus();
        shareKey = info.running ? info.key : null;
        if (shareKey === null) return info;
      }
      const today = todayLocal();
      // One bounded read per section, no fan-out. The ticker runs every 30 s
      // while sharing is on, so the cost of this function is the cost of the
      // feature — and every read below is bounded by SQL rather than by how
      // much the library happens to hold (I3):
      //
      //   * the day's money and the receivable figure are SUMs, not rows —
      //     both used to ship every matching row so a total could be summed
      //     in JavaScript;
      //   * tasks, reminders, memories, birthdays, warranties and notes carry
      //     their own LIMIT, in the order the snapshot publishes them, so a
      //     cap applied later never has to discard what SQL already sent;
      //   * the note read is the *list* projection — a 200-character prefix
      //     of each body, the same prefix the notes list itself excerpts
      //     from — instead of 20 whole note bodies for 20 excerpts.
      //
      // The builder still slices to SHARE_LIMITS: SQL bounds what is READ,
      // the slice bounds what is PUBLISHED, and neither alone is the other's
      // guarantee.
      const [
        dayTotals,
        walletBalances,
        receivableCents,
        warrantyRows,
        dueTasks,
        reminders,
        habitProgress,
        upcoming,
        birthdays,
        noteRows,
      ] = await Promise.all([
        budget.dayTotals(today),
        budget.listWalletBalances(SHARE_LIMITS.wallets),
        business.receivableTotal(),
        business.warrantiesExpiring(
          today,
          SHARE_HORIZON_DAYS,
          SHARE_LIMITS.warranties,
        ),
        tasks.dueTasks(today, SHARE_LIMITS.tasks),
        tasks.dueReminders(
          localISODateTime(new Date()),
          SHARE_LIMITS.reminders,
        ),
        habits.habitProgressList(today, SHARE_LIMITS.habits),
        memories.upcoming(today, SHARE_HORIZON_DAYS, SHARE_LIMITS.upcoming),
        contacts.upcomingBirthdays(
          SHARE_HORIZON_DAYS,
          today,
          SHARE_LIMITS.birthdays,
        ),
        notes.listNotes({ limit: SHARE_LIMITS.notes }),
      ]);

      const snapshot = buildShareSnapshot({
        today,
        generatedAt: localISODateTime(new Date()),
        dayTotals,
        walletBalances,
        receivableCents,
        dueTasks,
        reminders,
        habits: habitProgress.map((p) => ({
          name: p.habit.name,
          doneThisWeek: p.week.filter((d) => d.done).length,
          current: p.current,
          best: p.best,
        })),
        upcoming,
        birthdays,
        // The rows are already the ones SQL said were in window; this stays
        // the exact check and the sort (I3 keeps SQL no narrower than it).
        warranties: expiringWarranties(warrantyRows, today, SHARE_HORIZON_DAYS),
        notes: noteRows,
      });
      return driver.sharePublish(encryptSnapshot(snapshot, shareKey));
    },
  };
}
