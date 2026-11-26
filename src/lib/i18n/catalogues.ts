// The catalogues, assembled.
//
// One file per subject next to this one, each holding its English keys and the
// matching Burmese keys side by side. `en` is the typed source of truth, and
// `my` must cover every one of its keys or a namespace fails to compile. The
// merge follows catalogue order, which nothing reads.

import { enBudget, myBudget } from "./budget.ts";
import { enBusiness, myBusiness } from "./business.ts";
import { enCapture, myCapture } from "./capture.ts";
import { enCommon, myCommon } from "./common.ts";
import { enContacts, myContacts } from "./contacts.ts";
import { enDashboard, myDashboard } from "./dashboard.ts";
import { enDates, myDates } from "./dates.ts";
import { enExports, myExports } from "./exports.ts";
import { enGallery, myGallery } from "./gallery.ts";
import { enHabits, myHabits } from "./habits.ts";
import { enImport, myImport } from "./import.ts";
import { enInbox, myInbox } from "./inbox.ts";
import { enJournal, myJournal } from "./journal.ts";
import { enLinkPicker, myLinkPicker } from "./link-picker.ts";
import { enLinks, myLinks } from "./links.ts";
import { enLoans, myLoans } from "./loans.ts";
import { enLock, myLock } from "./lock.ts";
import { enMemories, myMemories } from "./memories.ts";
import { enMobile, myMobile } from "./mobile.ts";
import { enNav, myNav } from "./nav.ts";
import { enNotes, myNotes } from "./notes.ts";
import { enOnboarding, myOnboarding } from "./onboarding.ts";
import { enPairing, myPairing } from "./pairing.ts";
import { enReminders, myReminders } from "./reminders.ts";
import { enReset, myReset } from "./reset.ts";
import { enRust, myRust } from "./rust.ts";
import { enSearch, mySearch } from "./search.ts";
import { enSettings, mySettings } from "./settings.ts";
import { enShell, myShell } from "./shell.ts";
import { enShopping, myShopping } from "./shopping.ts";
import { enTasks, myTasks } from "./tasks.ts";
import { enTrash, myTrash } from "./trash.ts";
import { enVault, myVault } from "./vault.ts";

export const en = {
  ...enCommon,
  ...enShell,
  ...enNav,
  ...enSettings,
  ...enRust,
  ...enMobile,
  ...enPairing,
  ...enReminders,
  ...enCapture,
  ...enSearch,
  ...enLock,
  ...enInbox,
  ...enTrash,
  ...enNotes,
  ...enTasks,
  ...enDashboard,
  ...enReset,
  ...enLinkPicker,
  ...enLinks,
  ...enImport,
  ...enContacts,
  ...enBusiness,
  ...enLoans,
  ...enHabits,
  ...enShopping,
  ...enGallery,
  ...enJournal,
  ...enMemories,
  ...enExports,
  ...enDates,
  ...enOnboarding,
  ...enVault,
  ...enBudget,
} as const;

export type MessageKey = keyof typeof en;

export const my: Record<MessageKey, string> = {
  ...myCommon,
  ...myShell,
  ...myNav,
  ...mySettings,
  ...myRust,
  ...myMobile,
  ...myPairing,
  ...myReminders,
  ...myCapture,
  ...mySearch,
  ...myLock,
  ...myInbox,
  ...myTrash,
  ...myNotes,
  ...myTasks,
  ...myDashboard,
  ...myReset,
  ...myLinkPicker,
  ...myLinks,
  ...myImport,
  ...myContacts,
  ...myBusiness,
  ...myLoans,
  ...myHabits,
  ...myShopping,
  ...myGallery,
  ...myJournal,
  ...myMemories,
  ...myExports,
  ...myDates,
  ...myOnboarding,
  ...myVault,
  ...myBudget,
};
