// The phone's screens, one module per domain in `components/mobile/`.
//
// Rules live in `lib/mobileShell.ts` / `lib/mobileSearch.ts`; the screens are
// the wiring over the shared repositories, which are the same ones the desktop
// pages use. Nothing there mints identity — `createNote` / `createTask` /
// `addItem` do that, so a record typed on the phone is as sync-ready as one
// typed on the desktop. The ONE driver call is the danger zone's reset act
// (F-1), which runs the same factory-reset engine the desktop's Settings and
// Android's key-loss flow use — `src/reset-gate.test.ts` pins it as one of
// exactly two call sites.
//
// Mobile is view + add + mark-done toggles only (design, interaction model):
// the screens can create a record and flip exactly the one boolean the design
// allows. No other edit exists there on purpose.
//
// This file stays the public path — `MobileShell.tsx` and the tests import the
// screens from here — so the split changed no importer.

export { BudgetScreen, EntryCompose } from "./mobile/budget.tsx";
export { BusinessScreen, JobCompose, ShopCompose } from "./mobile/business.tsx";
export { DashboardScreen } from "./mobile/dashboard.tsx";
export { HabitsScreen } from "./mobile/habits.tsx";
export { LoanCompose, LoansScreen } from "./mobile/loans.tsx";
export { NoteCompose, NoteReaderScreen, NotesScreen } from "./mobile/notes.tsx";
export { RemindersPanel } from "./mobile/reminders.tsx";
export { MobileSearch } from "./mobile/search.tsx";
export { SettingsScreen } from "./mobile/settings.tsx";
export { ShoppingItemCompose, ShoppingScreen } from "./mobile/shopping.tsx";
export { TaskCompose, TasksScreen } from "./mobile/tasks.tsx";
export { VaultScreen } from "./mobile/vault.tsx";
