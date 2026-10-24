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
import { createBudgetRepo, type DayEntry } from "./budget.ts";
import { createBusinessRepo } from "./business.ts";
import { birthdayLabel, createContactsRepo } from "./contacts.ts";
import { bytesToB64, randomBytes } from "./crypto.ts";
import { dayMoneyTotals, expiringWarranties } from "./dashboard.ts";
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
  return JSON.stringify({
    version: SHARE_SNAPSHOT_VERSION,
    generatedAt,
    nonce: bytesToB64(nonce),
    ciphertext: bytesToB64(ciphertext),
  });
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
  dayEntries: DayEntry[];
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
 */
export function buildShareSnapshot(input: ShareSnapshotInput): ShareSnapshot {
  const money = dayMoneyTotals(input.dayEntries);
  return {
    version: SHARE_SNAPSHOT_VERSION,
    generatedAt: input.generatedAt,
    today: input.today,
    money: {
      income: formatMMK(money.incomeCents),
      expense: formatMMK(money.expenseCents),
    },
    wallets: input.walletBalances.slice(0, SHARE_LIMITS.wallets).map((w) => ({
      name: w.name,
      balance: formatMMK(w.balanceCents),
    })),
    receivableTotal: formatMMK(Math.max(0, input.receivableCents)),
    tasks: input.dueTasks.slice(0, SHARE_LIMITS.tasks).map((t) => ({
      title: t.title,
      due: t.due_date,
    })),
    reminders: input.reminders.slice(0, SHARE_LIMITS.reminders).map((r) => ({
      title: r.title,
      at: r.remind_at,
    })),
    habits: input.habits.slice(0, SHARE_LIMITS.habits).map((h) => ({
      name: h.name,
      doneThisWeek: h.doneThisWeek,
      current: h.current,
      best: h.best,
    })),
    upcoming: input.upcoming.slice(0, SHARE_LIMITS.upcoming).map((m) => ({
      title: m.title,
      date: m.memory_date,
    })),
    birthdays: input.birthdays.slice(0, SHARE_LIMITS.birthdays).map((c) => ({
      name: c.name,
      label: birthdayLabel(c.birthday ?? ""),
    })),
    warranties: input.warranties.slice(0, SHARE_LIMITS.warranties).map((w) => ({
      title: w.title,
      endDate: w.endDate,
    })),
    notes: input.notes.slice(0, SHARE_LIMITS.notes).map((n) => ({
      title: n.title,
      excerpt: noteExcerpt(n.content),
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
export function createShareRepo(driver: DataDriver) {
  let shareKey: string | null = null;
  const budget = createBudgetRepo(driver);
  const business = createBusinessRepo(driver);
  const tasks = createTasksRepo(driver);
  const habits = createHabitsRepo(driver);
  const memories = createMemoriesRepo(driver);
  const contacts = createContactsRepo(driver);
  const notes = createNotesRepo(driver);

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
      // One bounded read per section, no fan-out. The ticker runs
      // every 30 s while sharing is on, so the cost of this function is the
      // cost of the feature: it used to load every note body to publish 20
      // excerpts, then make one IPC call per wallet and two per habit. Each
      // section is now capped in SQL at its `SHARE_LIMITS` entry, and wallet
      // balances and habit progress are one read each.
      const [
        dayEntries,
        walletBalances,
        jobs,
        dueTasks,
        reminders,
        habitProgress,
        upcoming,
        birthdays,
        noteRows,
        receivable,
      ] = await Promise.all([
        budget.listDayEntries(today),
        budget.listWalletBalances(SHARE_LIMITS.wallets),
        business.listJobs("open"),
        tasks.dueTasks(today),
        tasks.dueReminders(localISODateTime(new Date())),
        habits.habitProgressList(today, SHARE_LIMITS.habits),
        memories.upcoming(today, 14),
        contacts.upcomingBirthdays(14, today),
        notes.listNotes({ limit: SHARE_LIMITS.notes }),
        business.listReceivable(),
      ]);

      const snapshot = buildShareSnapshot({
        today,
        generatedAt: localISODateTime(new Date()),
        dayEntries,
        walletBalances,
        receivableCents: receivable.reduce(
          (sum, j) => sum + j.remaining_cents,
          0,
        ),
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
        warranties: expiringWarranties(jobs, today, 14),
        notes: noteRows,
      });
      return driver.sharePublish(encryptSnapshot(snapshot, shareKey));
    },
  };
}
