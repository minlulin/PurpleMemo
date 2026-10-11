// Composition root of the data layer (§4): the one production Tauri driver
// wired into the per-domain repositories. Pages import the repos from here —
// they never touch the driver or Tauri IPC directly.

import { createBudgetRepo } from "../lib/budget.ts";
import { createBusinessRepo } from "../lib/business.ts";
import { createContactsRepo } from "../lib/contacts.ts";
import { createGalleryRepo } from "../lib/gallery.ts";
import { createHabitsRepo } from "../lib/habits.ts";
import { createJournalRepo } from "../lib/journal.ts";
import { createLoansRepo } from "../lib/loans.ts";
import { createMemoriesRepo } from "../lib/memories.ts";
import { createNotesRepo } from "../lib/notes.ts";
import { createShoppingRepo } from "../lib/shopping.ts";
import { createTasksRepo } from "../lib/tasks.ts";
import { createVaultRepo } from "../lib/vault.ts";
import { createTauriDriver } from "./driver.ts";

const driver = createTauriDriver();

export const notesRepo = createNotesRepo(driver);
export const journalRepo = createJournalRepo(driver);
export const budgetRepo = createBudgetRepo(driver);
export const businessRepo = createBusinessRepo(driver);
export const loansRepo = createLoansRepo(driver);
export const habitsRepo = createHabitsRepo(driver);
export const tasksRepo = createTasksRepo(driver);
export const shoppingRepo = createShoppingRepo(driver);
export const contactsRepo = createContactsRepo(driver);
export const memoriesRepo = createMemoriesRepo(driver);
export const galleryRepo = createGalleryRepo(driver);
export const vaultRepo = createVaultRepo(driver);
