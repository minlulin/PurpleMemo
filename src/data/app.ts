// Composition root of the data layer: the one production Tauri driver
// wired into the per-domain repositories. Pages import the repos from here —
// they never touch the driver or Tauri IPC directly.

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
import { createInboxRepo } from "../lib/inbox.ts";
import { createJournalRepo } from "../lib/journal.ts";
import { createLoansRepo } from "../lib/loans.ts";
import { createMemoriesRepo } from "../lib/memories.ts";
import { mobileSearch } from "../lib/mobileSearch.ts";
import { databaseBytes } from "../lib/mobileSettings.ts";
import { createNotesRepo } from "../lib/notes.ts";
import { createSettingsRepo } from "../lib/settings.ts";
import { createShareRepo } from "../lib/share.ts";
import { createShoppingRepo } from "../lib/shopping.ts";
import { createMobilePairingRepo } from "../lib/sync/mobilePairing.ts";
import { createPairingRepo } from "../lib/sync/pairingPanel.ts";
import { createSyncRepo } from "../lib/sync/syncSession.ts";
import { insertTasks, type TaskInsert } from "../lib/taskImport.ts";
import { createTasksRepo } from "../lib/tasks.ts";
import { createTrashRepo } from "../lib/trash.ts";
import { createVaultRepo } from "../lib/vault.ts";
import { createTauriDriver } from "./driver.ts";

const driver = createTauriDriver();

export const trashRepo = createTrashRepo(driver);
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
export const vaultRepo = createVaultRepo(driver);
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
 * The share repo receives the singletons above instead of rebuilding them
 * (J5): `createShareRepo` used to construct seven more domain repos — and
 * through them four more `trashRepo`s and two more `KeyedMutex`es — over
 * the same driver, so any per-instance state would have split across two
 * copies the moment it appeared.
 */
export const shareRepo = createShareRepo(driver, {
  budget: budgetRepo,
  business: businessRepo,
  tasks: tasksRepo,
  habits: habitsRepo,
  memories: memoriesRepo,
  contacts: contactsRepo,
  notes: notesRepo,
});

/**
 * The pairing panel's repo: the real listener plus the store's own pin
 * statements, over the one driver. The panel never touches IPC itself.
 */
export const pairingRepo = createPairingRepo(driver);

/** The phone's side of pairing: redeem, wire, then pin (§11.6.1, Session 7 T2). */
export const mobilePairingRepo = createMobilePairingRepo(driver);
export const syncRepo = createSyncRepo(driver);

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
