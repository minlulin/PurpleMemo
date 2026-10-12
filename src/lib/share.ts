// P5 share (§8): the read-only snapshot the phone sees on the same network.
//
// The desktop is the single writer — this module does not sync anything. It
// loads the same rows the Dashboard shows, turns them into a small,
// display-ready, bounded JSON payload, and hands it to Rust, which serves it
// over the LAN behind a pairing code. The network path never touches the DB
// or the encryption key: it only ever serves bytes this module produced.
//
// Everything user-facing (labels, money, excerpts) is formatted HERE, so the
// phone page is a dumb painter and the Vault is structurally absent — the
// snapshot builder takes no vault/settings/photo input at all (§5.3).

import type { DataDriver } from "../data/driver.ts";
import { createBudgetRepo, type DayEntry } from "./budget.ts";
import { createBusinessRepo } from "./business.ts";
import { birthdayLabel, createContactsRepo } from "./contacts.ts";
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

/** Everything the snapshot needs, already loaded — no driver, no SQL (§2.8). */
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
 * desktop (§6: one formatting path).
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
 * Today-at-a-glance → the phone payload (§8). Pure: same input, same output,
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
 * snapshot and publishes it to Rust (§4 — the same single-driver path as
 * every other feature; the UI never talks to Tauri directly).
 *
 * `publishSnapshot` is the only writer: the phone can read what the desktop
 * last published, and nothing else.
 */
export function createShareRepo(driver: DataDriver) {
  const budget = createBudgetRepo(driver);
  const business = createBusinessRepo(driver);
  const tasks = createTasksRepo(driver);
  const habits = createHabitsRepo(driver);
  const memories = createMemoriesRepo(driver);
  const contacts = createContactsRepo(driver);
  const notes = createNotesRepo(driver);

  return {
    start: () => driver.shareStart(),
    stop: () => driver.shareStop(),
    status: () => driver.shareStatus(),

    async publishSnapshot() {
      const today = todayLocal();
      const [
        dayEntries,
        walletRows,
        jobs,
        dueTasks,
        reminders,
        habitRows,
        upcoming,
        birthdays,
        noteRows,
        receivable,
      ] = await Promise.all([
        budget.listDayEntries(today),
        budget.listWallets(),
        business.listJobs("open"),
        tasks.dueTasks(today),
        tasks.dueReminders(localISODateTime(new Date())),
        habits.listHabits(),
        memories.upcoming(today, 14),
        contacts.upcomingBirthdays(14, today),
        notes.listNotes(),
        business.listReceivable(),
      ]);

      const walletBalances = await Promise.all(
        walletRows.map(async (w) => ({
          name: w.name,
          balanceCents: await budget.walletBalanceCents(w.id),
        })),
      );
      const habitProgress = await Promise.all(
        habitRows.map(async (h) => {
          const progress = await habits.habitProgress(h.id, today);
          return {
            name: h.name,
            doneThisWeek: progress.week.filter((d) => d.done).length,
            current: progress.current,
            best: progress.best,
          };
        }),
      );

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
        habits: habitProgress,
        upcoming,
        birthdays,
        warranties: expiringWarranties(jobs, today, 14),
        notes: noteRows,
      });
      return driver.sharePublish(JSON.stringify(snapshot));
    },
  };
}
