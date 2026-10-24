// Composition root of the data layer: the one production Tauri driver
// wired into the per-domain repositories. Pages import the repos from here —
// they never touch the driver or Tauri IPC directly.

import { createBackupRepo } from "../lib/backup.ts";
import { createBudgetRepo } from "../lib/budget.ts";
import { createBusinessRepo } from "../lib/business.ts";
import { createContactsRepo } from "../lib/contacts.ts";
import { createEntityLinksRepo } from "../lib/entityLinks.ts";
import { createExportsRepo } from "../lib/exports.ts";
import { createGalleryRepo } from "../lib/gallery.ts";
import { globalSearch, type SearchOptions } from "../lib/globalSearch.ts";
import { createHabitsRepo } from "../lib/habits.ts";
import { createInboxRepo } from "../lib/inbox.ts";
import { createJournalRepo } from "../lib/journal.ts";
import { createLoansRepo } from "../lib/loans.ts";
import { createMemoriesRepo } from "../lib/memories.ts";
import { createNotesRepo } from "../lib/notes.ts";
import { createSettingsRepo } from "../lib/settings.ts";
import { createShareRepo } from "../lib/share.ts";
import { createShoppingRepo } from "../lib/shopping.ts";
import { createTasksRepo } from "../lib/tasks.ts";
import { createTrashRepo } from "../lib/trash.ts";
import { createVaultRepo } from "../lib/vault.ts";
import { createTauriDriver } from "./driver.ts";

const driver = createTauriDriver();

export const backupRepo = createBackupRepo(driver);
export const trashRepo = createTrashRepo(driver);
export const inboxRepo = createInboxRepo(driver);
export const notesRepo = createNotesRepo(driver, trashRepo);
export const journalRepo = createJournalRepo(driver, trashRepo);
export const budgetRepo = createBudgetRepo(driver);
export const businessRepo = createBusinessRepo(driver);
export const loansRepo = createLoansRepo(driver);
export const habitsRepo = createHabitsRepo(driver);
export const tasksRepo = createTasksRepo(driver, trashRepo);
export const shoppingRepo = createShoppingRepo(driver);
export const contactsRepo = createContactsRepo(driver, trashRepo);
export const entityLinksRepo = createEntityLinksRepo(driver);
export const exportsRepo = createExportsRepo(driver);
export const memoriesRepo = createMemoriesRepo(driver, trashRepo);
export const galleryRepo = createGalleryRepo(driver);
export const vaultRepo = createVaultRepo(driver);
export const settingsRepo = createSettingsRepo(driver);
export const shareRepo = createShareRepo(driver);

export function searchWorkspace(input: string, options?: SearchOptions) {
  return globalSearch(driver, input, options);
}
