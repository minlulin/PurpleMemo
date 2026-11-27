// Composition root of the data layer: the one production Tauri driver
// wired into the per-domain repositories. Pages import the repos from here —
// they never touch the driver or Tauri IPC directly.

import { isAndroidPlatform } from "../lib/android-reminders.ts";
import { createBackupRepo } from "../lib/backup.ts";
import { createBudgetRepo } from "../lib/budget.ts";
import { createBusinessRepo } from "../lib/business.ts";
import { type ContactInsert, insertContacts } from "../lib/contactImport.ts";
import { createContactsRepo } from "../lib/contacts.ts";
import { encodeCsvTemplate } from "../lib/csv.ts";
import { createEntityLinksRepo } from "../lib/entityLinks.ts";
import { createExportsRepo } from "../lib/exports.ts";
import { createGalleryRepo } from "../lib/gallery.ts";
import { globalSearch, type SearchOptions } from "../lib/globalSearch.ts";
import { createHabitsRepo } from "../lib/habits.ts";
import type { Locale } from "../lib/i18n.ts";
import { createInboxRepo } from "../lib/inbox.ts";
import { createJournalRepo } from "../lib/journal.ts";
import { createLoansRepo } from "../lib/loans.ts";
import { createMemoriesRepo } from "../lib/memories.ts";
import { mobileSearch } from "../lib/mobileSearch.ts";
import { databaseBytes } from "../lib/mobileSettings.ts";
import { createNotesRepo } from "../lib/notes.ts";
import { createSettingsRepo } from "../lib/settings.ts";
import { createShoppingRepo } from "../lib/shopping.ts";
import {
  type DurableOutcome,
  ensurePairedPhoneReachable,
} from "../lib/sync/durablePairing.ts";
import { forgetPairingStatements } from "../lib/sync/forget.ts";
import { createMobilePairingRepo } from "../lib/sync/mobilePairing.ts";
import { createPairingRepo } from "../lib/sync/pairingPanel.ts";
import { holdsLocalData } from "../lib/sync/pairingWarning.ts";
import type { Origin } from "../lib/sync/protocol.ts";
import { readOwnDeviceId } from "../lib/sync/reminderDelivery.ts";
import { readPeers } from "../lib/sync/store.ts";
import { createSyncRepo } from "../lib/sync/syncSession.ts";
import { insertTasks, type TaskInsert } from "../lib/taskImport.ts";
import { createTasksRepo } from "../lib/tasks.ts";
import { createTrashRepo } from "../lib/trash.ts";
import { createVaultRepo } from "../lib/vault.ts";
import { type BootStatus, createTauriDriver } from "./driver.ts";

const driver = createTauriDriver();

/**
 * Tell Rust the interface language (D7).
 *
 * The tray menu and the boot-failure dialogs are built before this renderer can
 * answer — and the dialogs run exactly when the database could not be opened —
 * so they read the language from a marker this publishes.
 *
 * Best effort: the UI has already switched, and a failed write costs only a
 * restart in the previous language, which the next boot corrects.
 */
export function publishUiLocale(locale: Locale): void {
  void driver.uiLocaleSet?.(locale)?.catch(() => undefined);
}

/**
 * Where Rust's boot stands (F13).
 *
 * A driver without the call, or a failed query, answers `"ready"`: the wait
 * below then does not block and the shell behaves exactly as it did before
 * the handshake existed — the safe direction, since a phantom wait would be
 * worse than the race it replaces.
 */
export async function readBootStatus(): Promise<BootStatus> {
  try {
    return (await driver.bootStatus?.()) ?? { state: "ready", error: null };
  } catch {
    return { state: "ready", error: null };
  }
}

/** How long the shell's first read waits for boot to settle (F13). */
export const BOOT_WAIT_TIMEOUT_MS = 15_000;
const BOOT_WAIT_POLL_MS = 150;

/**
 * Wait until Rust's boot leaves `"pending"` (F13), or the budget runs out.
 *
 * The WebView can be live and issuing reads half a second before the
 * database key is even unwrapped (the Keystore call alone took 244 ms in
 * the captured launch), and a read issued in that window fails with "state
 * not managed" — which the error screen then latched for the whole
 * session. Waiting for the recorded phase turns that race into a
 * handshake. A budget expiry returns the still-pending status and the
 * caller proceeds to its ordinary read, whose failure path is unchanged.
 */
export async function waitForBoot(
  timeoutMs: number = BOOT_WAIT_TIMEOUT_MS,
): Promise<BootStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await readBootStatus();
    if (status.state !== "pending") return status;
    if (Date.now() >= deadline) return status;
    await new Promise((resolve) => setTimeout(resolve, BOOT_WAIT_POLL_MS));
  }
}

/**
 * Ask Rust to run boot again (F13): the retry the boot-failure dialog's
 * Retry button runs, invoked from the renderer's error screen on the phone
 * where that dialog is not the surface the user gets. Boot re-runs on its
 * own thread; the caller polls its settings read until the database answers
 * (a successful boot also reloads the window, which restarts the shell).
 */
export async function retryBoot(): Promise<void> {
  await driver.bootRetry?.();
}

/**
 * This installation's own side of a pairing (§2.3): the APK is the phone, and
 * both desktop builds are the desktop.
 *
 * Resolved ONCE, here, where the repositories are built — no library guesses
 * it. The Trash needs it because a restore records a create op, and a create
 * is only recordable from an origin §2.3 allows to write that table.
 */
const DEVICE_ORIGIN: Origin = isAndroidPlatform() ? "mobile" : "desktop";

export const trashRepo = createTrashRepo(driver, DEVICE_ORIGIN);
export const inboxRepo = createInboxRepo(driver);
export const notesRepo = createNotesRepo(driver, trashRepo);
export const journalRepo = createJournalRepo(driver, trashRepo);
export const budgetRepo = createBudgetRepo(driver);
export const businessRepo = createBusinessRepo(driver);
export const loansRepo = createLoansRepo(driver);
export const habitsRepo = createHabitsRepo(driver);
export const tasksRepo = createTasksRepo(driver, trashRepo);

/**
 * The tasks CSV import's batch write, bound to the one driver here.
 *
 * `insertTasks` takes a driver so its one-batch/rollback contract is unit
 * tested; pages never touch the driver themselves, so this is the seam they
 * call instead of importing the driver or building a second one.
 */
export function insertImportedTasks(rows: TaskInsert[]): Promise<void> {
  return insertTasks(driver, rows);
}

/** The contacts CSV import's batch write, bound to the same one driver. */
export function insertImportedContacts(rows: ContactInsert[]): Promise<void> {
  return insertContacts(driver, rows);
}

/**
 * Write a CSV import template (UTF-8 with BOM) through Rust's atomic export
 * file writer — `<a href="data:..." download>` is blocked by `navigation.rs`.
 */
export function saveCsvTemplate(
  path: string,
  templateCsv: string,
): Promise<void> {
  return driver.saveExportFile(path, encodeCsvTemplate(templateCsv));
}

export const shoppingRepo = createShoppingRepo(driver);
export const contactsRepo = createContactsRepo(driver, trashRepo);
export const entityLinksRepo = createEntityLinksRepo(driver);
export const exportsRepo = createExportsRepo(driver, {
  notes: notesRepo,
  loans: loansRepo,
});
export const memoriesRepo = createMemoriesRepo(driver, trashRepo);
export const galleryRepo = createGalleryRepo(driver);
/**
 * The vault records its mutations only on the desktop (§2.3, §12.3): `origin`
 * is the same one the Trash resolves, so a phone holding this repo writes its
 * own rows and records no operation a peer would refuse.
 */
export const vaultRepo = createVaultRepo(driver, DEVICE_ORIGIN);
export const settingsRepo = createSettingsRepo(driver);
/**
 * The backup repo, wired to the vault (J5). `importBackup` replaces every
 * table, so the vault's in-memory `CryptoKey` cache — whose keys belong to
 * rows that are about to be gone — must die with them. The hook runs at the
 * top of `importBackup`, before the first write, so the invalidation holds
 * for EVERY caller of `importBackup`, not only the Settings confirm step
 * (which already reloads). Declared after `vaultRepo` because the hook
 * names it.
 */
export const backupRepo = createBackupRepo(driver, {
  onBeforeImport: () => vaultRepo.lockVault(),
});
/**
 * The pairing panel's repo: the real listener plus the store's own pin
 * statements, over the one driver. The panel never touches IPC itself.
 */
export const pairingRepo = createPairingRepo(driver, {
  // Durable pairing: when the offer window closes itself (the code
  // expired), the resting state is the pinned-only window — the
  // remembered phone must not go dark until the next unlock.
  onWindowClosed: () => {
    void ensurePairedPhoneReachableNow().catch(() => undefined);
  },
});

/** The phone's side of pairing: redeem, wire, then pin (§11.6.1, Session 7 T2). */
export const mobilePairingRepo = createMobilePairingRepo(driver);
export const syncRepo = createSyncRepo(driver);

/**
 * Durable pairing: open (or re-open) the pinned-only window for the pinned
 * phone, when the reachability toggle says the phone may stay connected.
 * Best-effort for the caller's purposes — the outcome says what happened,
 * and an unreachable phone is a retry away, not an app error.
 */
export function ensurePairedPhoneReachableNow(): Promise<DurableOutcome> {
  return settingsRepo
    .getPairedPhoneReachable()
    .catch(() => true) // absent row = the durable default (ON)
    .then((toggle) =>
      ensurePairedPhoneReachable(
        {
          pairingOpen: (input) => driver.pairingOpen(input),
          peers: () => readPeers(driver),
          batch: (statements) => driver.batch(statements),
        },
        toggle,
        isAndroidPlatform(),
      ),
    );
}

/**
 * Durable pairing: whether the reachability toggle currently says the paired
 * phone may stay connected. Read fresh everywhere it gates a listener
 * decision (lock, background, close), so flipping the toggle in Settings
 * applies at the very next one of those — no restart, no cache.
 */
export function pairedPhoneReachabilityEnabled(): Promise<boolean> {
  return settingsRepo.getPairedPhoneReachable().catch(() => true);
}

/**
 * Durable pairing: forget a pinned peer entirely — the `sync_peers` row and
 * every device-local §7.2 floor row, in one batch. The caller is expected to
 * republish the decision surface it needs (close the listener, discard the
 * phone's pending outbox, refresh its lists) after this resolves.
 */
export function forgetPinnedPeer(deviceId: string): Promise<void> {
  return driver.batch(forgetPairingStatements(deviceId));
}

/**
 * This device's own id from `sync_state` — what §13.1's delivery rule compares
 * a reminder's creator against. Bound here so no component holds the driver.
 */
export function localDeviceId(): Promise<string> {
  return readOwnDeviceId(driver);
}

/**
 * Whether this phone holds records of its own — the third fact behind the line
 * the pairing card shows before Trust (F1 Task 2). Bound here for the same
 * reason as every other read: the component never holds the driver, and the
 * question itself is answered in `lib/sync/pairingWarning.ts`, where a fresh
 * install's shipped seeds are subtracted instead of counted.
 */
export function phoneHoldsLocalData(): Promise<boolean> {
  return holdsLocalData(driver);
}

export function searchWorkspace(input: string, options?: SearchOptions) {
  return globalSearch(driver, input, options);
}

/**
 * The phone's search, scoped to its allowlist (`lib/mobileSearch.ts`). Bound to
 * the same one driver here so no component ever holds the driver itself; the
 * allowlist is applied inside the query, not to its results.
 */
export function searchMobileWorkspace(input: string) {
  return mobileSearch(driver, input);
}

/**
 * The database facts the phone's Settings screen reports.
 *
 * Read from SQLite's own counters rather than by touching a file: the driver
 * is the only thing that may talk to the database, and `page_count *
 * page_size` is the size SQLite itself believes it occupies. Nothing here is
 * user data, and an unreadable counter answers zero rather than failing the
 * whole screen.
 */
export interface MobileDiagnostics {
  schemaVersion: number;
  databaseBytes: number;
}

export async function readMobileDiagnostics(): Promise<MobileDiagnostics> {
  const [version] = await driver.query<{ user_version: number }>(
    "PRAGMA user_version",
  );
  // The table-valued forms, not `PRAGMA page_size`: under SQLCipher the
  // pragma's column is named `cipher_page_size` and comes back as a string,
  // so the plain pragma read "0 B" while the database was 384 KB. These forms
  // keep the documented column names and are parsed with `Number`.
  const [pages] = await driver.query<{ page_count: number | string }>(
    "SELECT page_count FROM pragma_page_count",
  );
  const [size] = await driver.query<{ page_size: number | string }>(
    "SELECT page_size FROM pragma_page_size",
  );
  return {
    schemaVersion: Number(version?.user_version ?? 0),
    databaseBytes: databaseBytes(
      Number(pages?.page_count ?? 0),
      Number(size?.page_size ?? 0),
    ),
  };
}
