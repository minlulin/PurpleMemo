// Localization.
//
// One flat catalogue of dotted keys per locale, a typed English source of
// truth, and a Burmese catalogue that the compiler and the suite both require
// to be complete. Pages ask for a key; they never branch on the language.
//
// Storage stays locale-neutral: dates remain ISO and money remains integer
// cents. Only presentation is translated — see `lib/format.ts`.
//
// Missing keys fail loudly in development and safely in release: a dev build
// throws (so a forgotten translation cannot reach a commit unnoticed), while a
// release build falls back to English, then to the key itself, because a blank
// button is worse than an English one.

export const LOCALES = ["en", "my"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** Language names as the language names itself, for the Settings switch. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  my: "မြန်မာ",
};

export function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "my";
}

/**
 * `navigator.language` (or a stored tag) to a supported locale. Burmese
 * (`my`, `my-MM`) is the only non-English locale the app ships; everything
 * else reads in English rather than guessing.
 */
export function localeFromLanguageTag(tag: string | null | undefined): Locale {
  if (typeof tag !== "string") return DEFAULT_LOCALE;
  return tag.trim().toLowerCase().startsWith("my") ? "my" : DEFAULT_LOCALE;
}

// -- Catalogue ----------------------------------------------------------------

export const en = {
  "common.cancel": "Cancel",
  "common.delete": "Delete",
  "common.close": "Close",
  "common.closeDialog": "Close dialog",
  "common.tryAgain": "Try again",
  "common.retrying": "Retrying…",
  "common.back": "Back",
  "common.wait": "Wait…",
  "common.checking": "Checking…",
  "common.dismiss": "Dismiss",
  "common.dismissNotification": "Dismiss notification",
  "common.deleteWhat": "Delete {what}",

  "shell.skipToContent": "Skip to content",
  "shell.sections": "Sections",
  "shell.brandTagline": "Offline Workspace",
  "shell.search": "Search",
  "shell.searchTitle": "Search the workspace",
  "shell.searchAria": "Search workspace",
  "shell.newMemo": "New memo",
  "shell.newMemoTitle": "Capture a memo without leaving this page",
  "shell.lock": "Lock workspace",
  "shell.lockTitle": "Lock the app now",
  "shell.shortcuts": "Shortcuts",
  "shell.shortcutsTitle": "Keyboard shortcuts",
  "shell.shortcutsClose": "Close keyboard shortcuts",
  "shell.navGroup.workspace": "Workspace",
  "shell.navGroup.finance": "Finance",
  "shell.navGroup.personal": "Personal",
  "shell.navGroup.system": "System",
  "shell.error.readDb": "Could not read the encrypted database: {error}",
  "shell.error.reloadWarning":
    "{error} Purple Memo will ask you to restart before the next lock.",
  "shell.notificationsBlocked":
    "Notifications are blocked — due reminders stay listed in Tasks.",
  "shell.shareStopFailed":
    "Sharing to your phone did not stop — turn it off in Settings, Backup & share.",

  "nav.dashboard": "Dashboard",
  "nav.inbox": "Inbox",
  "nav.notes": "Notes",
  "nav.journal": "Journal",
  "nav.budget": "Budget",
  "nav.business": "Business",
  "nav.loans": "Loans",
  "nav.habits": "Habits",
  "nav.tasks": "Tasks",
  "nav.shopping": "Shopping",
  "nav.contacts": "Contacts",
  "nav.memories": "Memories",
  "nav.gallery": "Gallery",
  "nav.trash": "Trash",
  "nav.vault": "Vault",
  "nav.more": "All tools",
  "nav.settings": "Settings",

  "shortcuts.esc": "Close a dialog",
  "shortcuts.tab": "Move inside a dialog, never behind it",
  "shortcuts.tabFirst": "First stop skips straight to the content",

  "capture.title": "New memo",
  "capture.label": "Memo",
  "capture.aria": "New memo",
  "capture.placeholder":
    "Type it. Enter captures, Shift+Enter starts a new line.",
  "capture.capturing": "Capturing…",
  "capture.submit": "Capture",
  "capture.hint":
    "It waits in the inbox until you decide whether it is a note, a task, or a line for today's journal.",
  "capture.empty": "Type something before capturing.",
  "capture.saved": "Captured. It will wait in the inbox.",
  "capture.close": "Close new memo",

  "search.title": "Search workspace",
  "search.close": "Close search",
  "search.contentAria": "Search workspace content",
  "search.placeholder": "Search notes, tasks, people…",
  "search.filters": "Search filters",
  "search.type": "Type",
  "search.allTypes": "All types",
  "search.from": "From",
  "search.through": "Through",
  "search.includeInactive": "Include inactive",
  "search.searching": "Searching…",
  "search.failed": "Search failed: {error}",
  "search.resultsAria": "Search results",
  "search.moreAvailable": " · more available",
  "search.noMatches": "No matches.",
  "search.type.note": "Note",
  "search.type.task": "Task",
  "search.type.contact": "Contact",
  "search.type.journal": "Journal",
  "search.type.memory": "Memory",
  "search.type.job": "Job",
  "search.type.payable": "Payable",
  "search.type.loan": "Loan",
  "search.type.shoppingItem": "Shopping item",

  "settings.language": "Language",
  "settings.languageHint":
    "Changes the interface only. Stored dates, amounts and records keep their existing formats.",
  "settings.closeToTray": "Minimize to tray on close",
  "settings.closeToTrayHint":
    "Closing the window keeps Purple Memo running in the system tray, so reminders keep firing while it looks closed. Turn this off to make closing quit the app instead.",

  "session.remindersTitle": "Reminders",
  "session.previewTitle": "Reminder: {title}",
  "session.dueTitle": "Reminder due",
  "session.dueBody": "Open Purple Memo to see the reminder.",

  "lock.setup.badge": "Offline Encrypted Workspace",
  "lock.setup.title": "Welcome to Purple Memo",
  "lock.setup.intro":
    "Set a local PIN to protect your workspace. The PIN is required — there is no online recovery. Your security question below is the only way back in if you forget your PIN, and anyone who knows its answer can set a new PIN with it — so choose something only you know.",
  "lock.setup.choosePin": "Choose a PIN",
  "lock.setup.pinNote":
    "At least {count} characters. Stored as a salted hash — it is never written in plain text.",
  "lock.setup.pinLabel": "PIN (at least {count} characters)",
  "lock.setup.confirmPin": "Confirm PIN",
  "lock.setup.recoveryTitle": "Set your recovery question",
  "lock.setup.recoveryNote":
    "Your only way back in if you forget the PIN. Answer something only you know.",
  "lock.setup.question": "Security question",
  "lock.setup.questionPlaceholder": "e.g. What street did I grow up on?",
  "lock.setup.answer": "Security answer",
  "lock.setup.answerPlaceholder": "Memorable answer",
  "lock.setup.submit": "Set PIN and continue",
  "lock.setup.busy": "Setting up…",
  "lock.error.pinShort": "PIN must be at least {count} characters.",
  "lock.error.pinMismatch": "PINs do not match.",
  "lock.error.questionRequired":
    "A security question is required — it is your only recovery.",
  "lock.error.answerRequired": "The security answer is required.",

  "lock.badge": "Session Locked",
  "lock.title": "Purple Memo is locked",
  "lock.intro":
    "Enter your PIN to unlock your encrypted notebook and finance ledger.",
  "lock.pinLabel": "PIN",
  "lock.pinPlaceholder": "Enter PIN…",
  "lock.unlock": "Unlock",
  "lock.forgot": "Forgot PIN?",
  "lock.error.noAnswer":
    "No security answer is stored for this install — the PIN cannot be reset.",
  "lock.error.wrongPin": "Wrong PIN.",
  "lock.error.wrongAnswer": "Wrong answer.",
  "lock.error.tooMany":
    "Too many wrong attempts — wait {seconds} seconds before trying again.",
  "lock.reset.title": "Reset your PIN",
  "lock.reset.intro":
    "Answer your security question to set a new PIN. There is no other way to recover the PIN.",
  "lock.reset.warning":
    "This replaces your PIN. Anyone who knows your security answer can do the same and lock you out — if you still know your PIN, go back and use Change PIN in Settings instead.",
  "lock.reset.answer": "Answer",
  "lock.reset.answerPlaceholder": "Your security answer",
  "lock.reset.newPin": "New PIN",
  "lock.reset.confirmPin": "Confirm new PIN",
  "lock.reset.ack":
    "I understand this replaces my PIN, and that this is the only way to set one without knowing the current PIN.",
  "lock.reset.submit": "Set new PIN",
  "lock.reset.noAnswer":
    "The recovery fallback is unavailable for this install — the stored PIN is the only way in.",
  "lock.reset.shortPin": "New PIN must be at least {count} characters.",
  "lock.reset.unacknowledged":
    "Tick the acknowledgement first — a new PIN replaces the old one and cannot be undone.",
  "lock.unreadable.title": "Purple Memo is locked",
  "lock.unreadable.corrupt": "The stored PIN record could not be read.",
  "lock.unreadable.malformed":
    "The stored PIN record is not in a recognised format.",
  "lock.unreadable.weakIterations":
    "The stored PIN record was made with a key-derivation strength this version will not accept.",
  "lock.unreadable.body":
    "{detail} A PIN is set on this install, so the first-run setup is not offered and nothing can be unlocked until this record is readable. Restore the database from a backup taken before the problem started, or restore the settings row from another copy of this install.",

  "inbox.title": "Inbox",
  "inbox.subtitle":
    "Write it down the moment you think of it. Decide later what it becomes.",
  "inbox.newMemo": "New memo",
  "inbox.placeholder":
    "Type it. Enter captures, Shift+Enter starts a new line.",
  "inbox.capture": "Capture",
  "inbox.capturing": "Capturing…",
  "inbox.empty":
    "Nothing waiting. Write something above, or press Ctrl+Shift+M from anywhere.",
  "inbox.capturedAt": "captured {date}",
  "inbox.archive": "Archive",
  "inbox.archiving": "Archiving…",
  "inbox.converting": "Converting…",
  // The three conversion refusals: thrown keyed from lib/inbox.ts so a
  // raced or stale Convert click explains itself in the active locale (D11).
  "inbox.convertGone": "That capture no longer exists.",
  "inbox.convertArchived":
    "That capture was archived, so there is nothing to convert.",
  "inbox.convertFailed":
    "The capture was not converted and nothing was written. Try again.",
  "inbox.convertedToast": "Converted to {target} #{id}.",
  "inbox.earlier": "Earlier",
  "inbox.earlierBadge": "converted & archived",
  "inbox.earlierNote":
    "A converted capture records which note, task or journal entry it became. That record stays even if the target is later deleted — the capture was still captured, and it is never converted a second time.",
  "inbox.show": "Show",
  "inbox.hide": "Hide",
  "inbox.nothingEarlier": "Nothing converted or archived yet.",
  "inbox.convertedTo": "converted to {target} #{id}",
  "inbox.convertedGone": "converted to {target} #{id}, which no longer exists",
  "inbox.convertedOnly": "converted",
  "inbox.archivedAt": "archived {date}",
  "inbox.target.note": "note",
  "inbox.target.task": "task",
  "inbox.target.journal": "journal",
  "inbox.makeNote": "Make a note",
  "inbox.makeTask": "Make a task",
  "inbox.addToJournal": "Add to today's journal",
  "inbox.what.capture": "capture",
  "inbox.what.convertedCapture": "converted capture",
  "inbox.what.archivedCapture": "archived capture",

  "trash.title": "Trash",
  "trash.subtitle":
    "Deleted notes, tasks, contacts, memories, and journal entries stay here for {days} days, up to {max} items.",
  "trash.notice":
    "Permanent deletion removes the item from Purple Memo. It is not forensic erasure, and operating-system backups may retain copies.",
  "trash.empty": "Trash is empty.",
  "trash.restore": "Restore",
  "trash.deletePermanently": "Delete permanently",
  "trash.deletedAt": "{type} · deleted {date}",
  "trash.restored": "Restored.",
  "trash.permanentlyDeleted": "Permanently deleted.",
  "trash.deleteWhat": "Trash item permanently",
  "trash.type.note": "Note",
  "trash.type.task": "Task",
  "trash.type.contact": "Contact",
  "trash.type.memory": "Memory",
  "trash.type.journalEntry": "Journal entry",

  "notes.untitled": "Untitled",
  "notes.titleAria": "Note title",
  "notes.tagsPlaceholder": "Tags (comma separated, e.g. work, ideas)",
  "notes.tagsAria": "Note tags",
  "notes.collectionAria": "Note collection",
  "notes.noCollection": "No collection",
  "notes.markdown": "Markdown",
  "notes.contentPlaceholder": "Write markdown…",
  "notes.contentAria": "Note content (markdown)",
  "notes.resizeAria": "Resize editor and preview panes",
  "notes.livePreview": "Live preview",
  "notes.previewEmpty": "Live preview appears here.",
  "notes.saving": "Saving…",
  "notes.save": "Save",
  "notes.unsaved": "Unsaved draft",
  "notes.discardTitle": "Discard the unsaved draft and reload the saved note",
  "notes.discard": "Discard draft",
  "notes.unpin": "Unpin",
  "notes.pin": "Pin",
  "notes.unarchive": "Unarchive",
  "notes.archive": "Archive",
  "notes.toJournalTitle": "Append this note to today's journal entry",
  "notes.adding": "Adding…",
  "notes.sendToJournal": "Send to journal",
  "notes.deleteWhat": "note to Trash",
  "notes.moveToTrash": "Move to Trash",
  "notes.addedToJournal": "Added “{title}” to today's journal entry.",
  "notes.noMatch": "No notes match this search.",
  "notes.noNotes": "No notes yet — create your first note.",
  "notes.pinned": "Pinned",
  "notes.archivedBadge": "Archived",
  "notes.noExcerpt": "No additional text…",
  "notes.missing": "That note no longer exists — it may have been deleted.",
  "notes.selectPrompt":
    "Select a note from the list, or create a new one to start writing in Markdown.",
  "notes.collections": "Collections",
  "notes.allNotes": "All notes",
  "notes.deleteCollectionWhat": "collection “{name}”",
  "notes.deleteCollectionAria": "Delete collection {name}",
  "notes.newCollectionPlaceholder": "New collection…",
  "notes.newCollectionAria": "New collection name",
  "notes.add": "Add",
  "notes.notesAria": "Notes",
  "notes.notesHeading": "Notes",
  "notes.searchPlaceholder": "Search notes (full-text)…",
  "notes.searchAria": "Search notes",
  "notes.showArchived": "Archived",
  "notes.newNote": "New note",
  "notes.noteListAria": "Note list",
  "notes.editorAria": "Note editor",
  "notes.viewAria": "Editor view mode",
  "notes.viewEdit": "Edit",
  "notes.viewSplit": "Split",
  "notes.viewRead": "Read",
  "notes.openReader": "Pop-up reader",
  "notes.openReaderAria": "Open note in pop-up reader",
  "notes.prevNote": "Previous note",
  "notes.nextNote": "Next note",
  "notes.copyMarkdown": "Copy Markdown",
  "notes.copied": "Copied to clipboard",
  "notes.collapseCollections": "Collapse collections",
  "notes.expandCollections": "Expand collections",

  "tasks.title": "Tasks & Reminders",
  "tasks.subtitle":
    "Actionable to-dos & repeating schedules. Alerts appear only while Purple Memo is open and unlocked.",
  "tasks.openAria": "Open tasks",
  "tasks.open": "Open tasks",
  "tasks.showDone": "Show done",
  "tasks.empty": "Nothing due — enjoy it.",
  "tasks.overdue": "Overdue",
  "tasks.due": "due {date}",
  "tasks.done": "Done",
  "tasks.moveToTrash": "Move to Trash",
  "tasks.deleteWhat": "task to Trash",
  "tasks.completed": "Completed",
  "tasks.reopen": "Reopen",
  "tasks.missing": "That task no longer exists — it may have been deleted.",
  "tasks.newTask": "New task",
  "tasks.titleLabel": "Title",
  "tasks.titlePlaceholder": "e.g. Pay electricity bill",
  "tasks.dueLabel": "Due date (optional)",
  "tasks.dueAria": "Due date",
  "tasks.repeatLabel": "Repeat",
  "tasks.repeatAria": "Repeat",
  "tasks.noteLabel": "Note (optional)",
  "tasks.notePlaceholder": "Details or context",
  "tasks.add": "Add task",
  "tasks.importCsv": "Import CSV",
  "tasks.importTitle": "Import tasks from CSV",
  "tasks.dueColumn": "Due date",
  "tasks.doneColumn": "Done",
  "tasks.noteColumn": "Note",
  "tasks.remindersAria": "Reminders",
  "tasks.remindersHeading": "Scheduled Reminders",
  "tasks.noReminders": "No scheduled reminders.",
  "tasks.fired": "Fired",
  "tasks.snoozeUntil": "Snooze {title} until",
  "tasks.snooze": "Snooze",
  "tasks.acknowledgeWhat": "fired reminder",
  "tasks.acknowledge": "Acknowledge",
  "tasks.reminderWhat": "reminder",
  "tasks.reminderTitleAria": "Reminder title",
  "tasks.reminderTitlePlaceholder": "Reminder title (e.g. Call supplier)",
  "tasks.remindAtAria": "Remind at",
  "tasks.reminderRepeatAria": "Reminder repeat",
  "tasks.addReminder": "Add reminder",
  "tasks.repeat.none": "No repeat",
  "tasks.repeat.daily": "Daily",
  "tasks.repeat.weekly": "Weekly",
  "tasks.repeat.monthly": "Monthly",

  "dashboard.title": "Today",
  "dashboard.trendLevel": "level vs yesterday",
  "dashboard.trendChange": "{pct}% vs yesterday",
  "dashboard.overview": "Overview",
  "dashboard.moneyIn": "Money In Today",
  "dashboard.cashInflow": "Cash-basis daily inflow",
  "dashboard.moneyOut": "Money Out Today",
  "dashboard.netToday": "Net today: {amount}",
  "dashboard.totalReceivable": "Total Receivable",
  "dashboard.openBalances": "Open customer balances",
  "dashboard.actionItems": "Action Items",
  "dashboard.habitsLogged": "{done}/{total} habits logged today",
  "dashboard.queue": "Tasks & reminders queue",
  "dashboard.notesAction": "Notes",
  "dashboard.journalAction": "Journal",
  "dashboard.logTransaction": "Log Transaction",
  "dashboard.todayHeading": "Today",
  "dashboard.tasksRemindersHeading": "Tasks & reminders",
  "dashboard.urgencyLegend":
    "Green: due in more than {days} days · Yellow: due within {days} days · Red: overdue · No color: no due date",
  "dashboard.noOpenTasks": "No open tasks",
  "dashboard.task": "Task",
  "dashboard.taskDue": "Task · due {date}",
  "dashboard.complete": "Complete",
  "dashboard.newDueDate": "New due date for {title}",
  "dashboard.reschedule": "Reschedule",
  "dashboard.reminder": "Reminder",
  "dashboard.reminderAt": "Reminder · {date}",
  "dashboard.firedHeading": "Fired — acknowledge or snooze",
  "dashboard.firedInfo": "Fired {date} — still here until you resolve it",
  "dashboard.openTasks": "Open Tasks",
  "dashboard.todaysMoney": "Today's money",
  "dashboard.in": "In",
  "dashboard.out": "Out",
  "dashboard.openBudget": "Open Budget",
  "dashboard.habitWeekHeading": "Habit week progress",
  "dashboard.noHabits": "No habits yet.",
  "dashboard.habitWeekProgress": "{done}/7 this week",
  "dashboard.openHabits": "Open Habits",
  "dashboard.comingUp": "Coming up",
  "dashboard.upcomingHeading": "Upcoming memories & birthdays",
  "dashboard.nothingNext": "Nothing in the next {days} days.",
  "dashboard.memory": "Memory",
  "dashboard.birthday": "Birthday",
  "dashboard.birthdayWithDate": "Birthday · {date}",
  "dashboard.openMemories": "Open Memories",
  "dashboard.recurringHeading": "Recurring payments",
  "dashboard.noRecurring": "No recurring payments due in the next {days} days.",
  "dashboard.recurring": "Recurring",
  "dashboard.dueOn": "due {date}",
  "dashboard.openBusiness": "Open Business",
  "dashboard.warrantiesHeading": "Expiring warranties",
  "dashboard.noWarranties": "No warranties expiring in the next {days} days.",
  "dashboard.warranty": "Warranty",
  "dashboard.until": "until {date}",
  "dashboard.totalReceivableHeading": "Total receivable",
  "dashboard.outstanding": "Outstanding",
  "dashboard.receivableNote":
    "Unpaid balance across open customer repair & service jobs.",
  "dashboard.openReceivable": "Open Receivable",

  "settings.backupTitle": "Backup & restore",
  "settings.backupBadge": ".zip or password-protected",
  "settings.protectBackup":
    "Protect the backup with a password (a .{ext} file that needs this password to open)",
  "settings.backupPassword": "Backup password",
  "settings.confirmBackupPassword": "Confirm backup password",
  "settings.exporting": "Exporting…",
  "settings.exportBackup": "Export backup",
  "settings.importing": "Importing…",
  "settings.importBackup": "Import backup",
  "settings.opening": "Opening…",
  "settings.openBackup": "Open backup",
  "settings.summary":
    "Backup from {date}: {rows} rows across {tables} tables, {photos} photos. Continuing replaces ALL current data.",
  "settings.replaceAll": "Replace all data",
  "settings.passwordMismatch":
    "The two passwords do not match — nothing was exported.",
  "settings.passwordRequired":
    "Tick password protection and choose a password before exporting, or untick it to export without one — nothing was exported.",
  "settings.saveBackupTitle": "Save Purple Memo backup",
  "settings.encryptedBackupFilter": "Password-protected Purple Memo backup",
  "settings.backupFilter": "Purple Memo backup",
  "settings.backupSaved":
    "Backup saved to {path} — {rows} rows, {photos} photos",
  "settings.backupSavedEncrypted":
    "Backup saved to {path} — {rows} rows, {photos} photos, password-protected",
  "settings.tooLarge":
    "Backup archive is larger than the {limit} byte limit — import rejected.",
  "settings.imported":
    "Imported {rows} rows and {photos} photos — the previous data is in {path}. Reloading…",

  "reset.dangerZone": "Danger zone",
  "reset.dangerZoneBadge": "Permanent",
  "reset.factoryReset": "Factory reset",
  "reset.irreversible": "A factory reset cannot be undone.",
  "reset.acknowledge":
    "I understand this permanently deletes everything Purple Memo stores on this device, and that it cannot be undone.",
  "reset.confirmWhat": "everything Purple Memo stores",
  "reset.run": "Factory reset…",
  "reset.running":
    "Factory reset is running — the database is being closed and everything is being deleted. Do not close the app.",
  "reset.successTitle": "Factory reset complete",
  "reset.successBody":
    "Everything Purple Memo stored on this device was removed. Restart to run first-run setup again.",
  "reset.restart": "Restart Purple Memo",
  "reset.incompleteTitle": "Factory reset did NOT complete",
  "reset.incompleteBody":
    "Some items could not be removed, and this session is over: the database connection is closed, so Purple Memo cannot be used until it is started again. The reset is safe to run again — retry it. If it keeps failing, close Purple Memo and start it yourself: the next launch opens either with whatever remains or into first-run setup, and the list below is exactly what was left behind.",
  "reset.retry": "Retry reset",
  "reset.errorTitle": "The factory reset could not run",
  "reset.errorBody":
    "The reset attempt failed before a full report could be produced. Nothing can be assumed about what was removed — the session is over either way: the database connection is closed, so retry the reset or close Purple Memo and start it yourself.",
  "reset.component.shareStop": "LAN sharing",
  "reset.component.database": "Encrypted database",
  "reset.component.photos": "Photos",
  "reset.component.backups": "Backup copies the app made",
  "reset.component.logs": "Log files",
  "reset.component.keyringKey": "Database key (Windows credential store)",
  "reset.status.removed": "Removed",
  "reset.status.alreadyAbsent": "Already absent",
  "reset.status.failed": "Failed",
  "reset.status.notAttempted": "Not attempted",

  "linkPicker.title": "Link to",
  "linkPicker.close": "Close the link picker",
  "linkPicker.searchLabel": "Search",
  "linkPicker.searchAria": "Search notes, tasks and contacts",
  "linkPicker.includeInactive": "Include archived notes and completed tasks",
  "linkPicker.empty":
    "Nothing to link here. A note, task or contact has to exist first.",
  "linkPicker.listAria": "Things you can link to",
  "linkPicker.capped":
    "Showing {shown} of {matched} matches. Narrow the search, or include archived and completed items.",
  "linkPicker.linking": "Linking…",
  "linkPicker.loading": "Loading your notes, tasks and contacts…",

  "links.relatedAria": "Related items",
  "links.related": "Related",
  "links.linkTo": "Link to…",
  "links.loading": "Loading related items…",
  "links.alreadyLinked": "Those two are already linked.",
  "links.empty": "Not related to anything yet.",
  "links.unavailable": "{type} — unavailable (it was deleted)",
  "links.unlinkWhat": "link",
  "links.unlink": "Unlink",

  "import.chooseFile": "Choose CSV file",
  "import.chooseAnother": "Choose another file",
  "import.fileHint":
    "CSV files only. Nothing is written until you confirm the preview.",
  "import.downloadTemplate": "Download template CSV",
  "import.savingTemplate": "Saving…",
  "import.saveTemplateTitle": "Save CSV template",
  "import.csvFilter": "CSV file",
  "import.templateSaved": "Template CSV saved to {path}.",
  "import.previewCapped":
    "Showing the first {shown} of {total} rows in the preview — all {total} valid rows will be imported.",
  "import.yes": "Yes",
  "import.no": "No",
  "import.reading": "Reading…",
  "import.rowsToImportAria": "Rows to import",
  "import.errorsTitle": "Rows that will be skipped",
  "import.errorsAria": "Row errors",
  "import.rowError": "Row {row}: {reason}",
  "import.nothing":
    "No rows can be imported — fix the errors and choose the file again.",
  "import.import": "Import",
  "import.importing": "Importing…",
  "import.resultTitle": "Import complete",
  "import.done": "Done",
  "import.error.tooLarge":
    "CSV file is larger than the {limit} MiB limit — import rejected.",
  "import.error.tooManyRows":
    "CSV has more than {rows} rows — import rejected.",
  "import.error.missingColumn":
    "CSV is missing the required column {columns} — import rejected.",
  "import.error.missingColumns":
    "CSV is missing the required columns {columns} — import rejected.",
  "import.reason.titleRequired": "Title is required.",
  "import.reason.dueDate":
    "Due date must be a valid YYYY-MM-DD date (or empty).",
  "import.reason.done": "Done must be true, false, yes, no, 1 or 0 (or empty).",
  "import.reason.repeat":
    "Repeat must be none, daily, weekly or monthly (or empty).",
  "import.reason.nameRequired": "Name is required.",
  "import.reason.birthday":
    "Birthday must be a valid YYYY-MM-DD or MM-DD date (or empty).",

  "contacts.title": "Address Book",
  "contacts.subtitle":
    "Personal & business contacts, channels, tags & birthdays",
  "contacts.importCsv": "Import CSV",
  "contacts.importTitle": "Import contacts from CSV",
  "contacts.directory": "Directory",
  "contacts.searchPlaceholder": "Search contacts…",
  "contacts.searchAria": "Search contacts",
  "contacts.newNamePlaceholder": "New contact name",
  "contacts.newNameAria": "New contact name",
  "contacts.add": "Add",
  "contacts.emptyAll": "No contacts yet — add one above.",
  "contacts.emptySearch": "No contact matches the search.",
  "contacts.selectPrompt": "Select a contact on the left, or add a new one.",
  "contacts.missing":
    "That contact no longer exists — it may have been deleted.",
  "contacts.birthdayBadge": "Birthday: {date}",
  "contacts.save": "Save",
  "contacts.moveToTrash": "Move to Trash",
  "contacts.deleteWhat": "contact to Trash",
  "contacts.nameLabel": "Name",
  "contacts.addressLabel": "Address",
  "contacts.addressPlaceholder": "Street, city…",
  "contacts.birthdayLabel": "Birthday",
  "contacts.birthdayTypeAria": "Birthday type",
  "contacts.birthdayNone": "No birthday",
  "contacts.birthdayFull": "Full date",
  "contacts.birthdayMonthDay": "Month and day",
  "contacts.birthdayDateAria": "Birthday date",
  "contacts.birthdayMonthDayAria": "Birthday month and day",
  "contacts.birthdayInvalidDate": "Birthday must be a valid date.",
  "contacts.birthdayInvalidMonthDay":
    "Month-day must be between 01-01 and 12-31.",
  "contacts.notesLabel": "Notes",
  "contacts.channelsHeading": "Channels",
  "contacts.channelsEmpty": "No channels yet.",
  "contacts.channelKind.phone": "Phone",
  "contacts.channelKind.email": "Email",
  "contacts.channelKind.other": "Other",
  "contacts.primaryBadge": "Primary",
  "contacts.makePrimary": "Make primary",
  "contacts.channelDeleteWhat": "channel {kind}",
  "contacts.channelKindAria": "Channel kind",
  "contacts.channelValueAria": "Channel value",
  "contacts.channelValuePlaceholder": "09… or name@mail.com",
  "contacts.addChannel": "Add channel",
  "contacts.tagsHeading": "Tags",
  "contacts.tagsEmpty": "No tags yet.",
  "contacts.removeTagAria": "Remove tag {tag}",
  "contacts.newTagAria": "New tag",
  "contacts.newTagPlaceholder": "Tag (e.g. family, VIP)",
  "contacts.addTag": "Add tag",

  "business.jobMissing":
    "That job is no longer in this view — it may have changed or been deleted.",
  "business.payableMissing":
    "That payable is no longer in this view — it may have changed or been deleted.",

  "onboarding.title": "Welcome to Purple Memo",
  "onboarding.intro": "A quick note on what this app can and cannot do.",
  "onboarding.pinTitle": "PIN recovery has limits",
  "onboarding.pinBody":
    "If you forget your PIN, recovery depends on the security question you set. There is no master reset that keeps your data.",
  "onboarding.keyTitle": "Keep the database key safe",
  "onboarding.keyBody":
    "Settings → Encryption key export writes a separate key file. Without it, a backup cannot open the database it came from.",
  "onboarding.backupTitle": "Backups replace everything",
  "onboarding.backupBody":
    "Restoring a backup replaces all current data. Export first if you are unsure.",
  "onboarding.offlineTitle": "Offline, with limits",
  "onboarding.offlineBody":
    "Reminders appear only while Purple Memo is open and unlocked. Nothing syncs to a server.",
  "onboarding.dismiss": "Got it",

  // Vault — the page whose copy carries the security contract, so it is on the
  // catalogue like every other page (B13). The no-recovery warning in
  // particular must not stay English-only.
  "vault.title": "Encrypted Vault",
  "vault.subtitle":
    "Per-item AES-256-GCM encrypted secrets derived via PBKDF2-SHA256 (600k iterations)",
  "vault.itemsAria": "Vault items",
  "vault.changePassword": "Change password",
  "vault.lock": "Lock vault",
  "vault.unavailable":
    "The vault could not be read, so Purple Memo does not know whether one exists yet. Your password and your secrets are unchanged.",
  "vault.setupHeading": "Set a vault password",
  "vault.noRecovery":
    "There is NO recovery. If you forget this password, your secrets cannot be recovered by anyone — not even on this machine. Store it somewhere safe before you continue.",
  "vault.passwordAtLeast": "Password (at least {min} characters)",
  "vault.confirmPassword": "Confirm password",
  "vault.settingUp": "Setting up…",
  "vault.setPassword": "Set password",
  "vault.lockedHeading": "Vault locked",
  "vault.lockedSubtitle":
    "Enter your vault password to decrypt and manage secrets.",
  "vault.password": "Password",
  "vault.unlocking": "Unlocking…",
  "vault.unlock": "Unlock",
  "vault.changeHeading": "Change vault password",
  "vault.currentPassword": "Current password",
  "vault.newPassword": "New password",
  "vault.confirmNewPassword": "Confirm new password",
  "vault.reencrypting": "Re-encrypting…",
  "vault.storedSecrets": "Stored Secrets",
  "vault.empty": "The vault is empty — add a secret.",
  "vault.updated": "updated {date}",
  "vault.reveal": "Reveal",
  "vault.hide": "Hide",
  "vault.edit": "Edit",
  "vault.deleteWhat": "secret",
  "vault.editHeading": "Edit secret",
  "vault.newHeading": "New secret",
  "vault.titleField": "Title",
  "vault.secretField": "Secret",
  "vault.titlePlaceholder": "e.g. Email login, Recovery seed",
  "vault.secretPlaceholder": "Password, note, recovery code…",
  "vault.save": "Save",
  "vault.addSecret": "Add secret",
  "vault.error.wrongPassword": "Wrong password — nothing was unlocked.",
  "vault.error.wrongItem": "Could not decrypt this item — wrong password.",
  "vault.error.passwordShort": "Password must be at least {min} characters.",
  "vault.error.noMatch": "Passwords do not match.",
  "vault.error.newPasswordShort":
    "New password must be at least {min} characters.",
  "vault.error.newNoMatch": "New passwords do not match.",
  "vault.error.wrongCurrent": "Wrong current password — nothing was changed.",
} as const;

export type MessageKey = keyof typeof en;

export const my: Record<MessageKey, string> = {
  "common.cancel": "ပယ်ဖျက်",
  "common.delete": "ဖျက်မည်",
  "common.close": "ပိတ်မည်",
  "common.closeDialog": "ဒိုင်ယာလော့ဂ်ကို ပိတ်မည်",
  "common.tryAgain": "ထပ်စမ်းကြည့်မည်",
  "common.retrying": "ပြန်စမ်းနေသည်…",
  "common.back": "နောက်သို့",
  "common.wait": "စောင့်ပါ…",
  "common.checking": "စစ်ဆေးနေသည်…",
  "common.dismiss": "ပိတ်မည်",
  "common.dismissNotification": "အသိပေးချက်ကို ပိတ်မည်",
  "common.deleteWhat": "{what} ကို ဖျက်မည်",

  "shell.skipToContent": "အကြောင်းအရာသို့ ကျော်သွားမည်",
  "shell.sections": "ကဏ္ဍများ",
  "shell.brandTagline": "အော့ဖ်လိုင်း လုပ်ငန်းခွင်",
  "shell.search": "ရှာဖွေမည်",
  "shell.searchTitle": "လုပ်ငန်းခွင်ကို ရှာဖွေမည်",
  "shell.searchAria": "လုပ်ငန်းခွင်ကို ရှာဖွေမည်",
  "shell.newMemo": "မှတ်စုအသစ်",
  "shell.newMemoTitle": "ဤစာမျက်နှာမှ မထွက်ဘဲ မှတ်စုတိုတစ်ခု ဖမ်းယူမည်",
  "shell.lock": "လုပ်ငန်းခွင်ကို သော့ခတ်မည်",
  "shell.lockTitle": "အက်ပ်ကို ယခု သော့ခတ်မည်",
  "shell.shortcuts": "အတိုကောက်များ",
  "shell.shortcutsTitle": "ကီးဘုတ်အတိုကောက်များ",
  "shell.shortcutsClose": "ကီးဘုတ်အတိုကောက်များကို ပိတ်မည်",
  "shell.navGroup.workspace": "လုပ်ငန်းခွင်",
  "shell.navGroup.finance": "ဘဏ္ဍာရေး",
  "shell.navGroup.personal": "ကိုယ်ပိုင်",
  "shell.navGroup.system": "စနစ်",
  "shell.error.readDb": "ကုဒ်ဝှက်ထားသော ဒေတာဘေ့စ်ကို ဖတ်၍ မရပါ — {error}",
  "shell.error.reloadWarning":
    "{error} နောက်တစ်ကြိမ် သော့ခတ်မီ Purple Memo က ပြန်လည်စတင်ရန် တောင်းဆိုပါမည်။",
  "shell.notificationsBlocked":
    "အသိပေးချက်များ ပိတ်ထားသည် — ရောက်ရှိနေသော သတိပေးချက်များကို လုပ်ငန်းများတွင် စာရင်းပြထားဆဲဖြစ်သည်။",
  "shell.shareStopFailed":
    "ဖုန်းသို့ မျှဝေခြင်း မရပ်တန့်နိုင်ပါ — ဆက်တင်များ (Backup & share) တွင် ပိတ်ပါ။",

  "nav.dashboard": "ဒက်ရှ်ဘုတ်",
  "nav.inbox": "ဝင်စာ",
  "nav.notes": "မှတ်စုများ",
  "nav.journal": "ဒိုင်ယာရီ",
  "nav.budget": "ဘတ်ဂျက်",
  "nav.business": "စီးပွားရေး",
  "nav.loans": "ချေးငွေများ",
  "nav.habits": "အလေ့အထများ",
  "nav.tasks": "လုပ်ငန်းများ",
  "nav.shopping": "ဈေးဝယ်ခြင်း",
  "nav.contacts": "ဆက်သွယ်ရန်စာရင်း",
  "nav.memories": "အမှတ်တရများ",
  "nav.gallery": "ဓာတ်ပုံပြခန်း",
  "nav.trash": "အမှိုက်ပုံး",
  "nav.vault": "လျှို့ဝှက်သေတ္တာ",
  "nav.more": "ကိရိယာအားလုံး",
  "nav.settings": "ဆက်တင်များ",

  "shortcuts.esc": "ဒိုင်ယာလော့ဂ်တစ်ခုကို ပိတ်မည်",
  "shortcuts.tab": "ဒိုင်ယာလော့ဂ်အတွင်း ရွေ့သွားမည်၊ နောက်ဘက်သို့ ဘယ်တော့မှ မရောက်ပါ",
  "shortcuts.tabFirst": "ပထမဆုံး ရပ်နားရာက အကြောင်းအရာသို့ တိုက်ရိုက် ကျော်သွားသည်",

  "capture.title": "မှတ်စုအသစ်",
  "capture.label": "မှတ်စု",
  "capture.aria": "မှတ်စုအသစ်",
  "capture.placeholder":
    "ရိုက်ထည့်ပါ။ Enter ဖြင့် ဖမ်းယူပြီး Shift+Enter ဖြင့် လိုင်းအသစ် စတင်ပါ။",
  "capture.capturing": "ဖမ်းယူနေသည်…",
  "capture.submit": "ဖမ်းယူမည်",
  "capture.hint":
    "၎င်းသည် မှတ်စု၊ လုပ်ငန်း သို့မဟုတ် ယနေ့ ဒိုင်ယာရီအတွက် တစ်ကြောင်း ဖြစ်မည်ကို သင်ဆုံးဖြတ်သည်အထိ ဝင်စာထဲတွင် စောင့်နေပါမည်။",
  "capture.empty": "မဖမ်းယူမီ တစ်ခုခု ရိုက်ထည့်ပါ။",
  "capture.saved": "ဖမ်းယူပြီးပါပြီ။ ဝင်စာထဲတွင် စောင့်နေပါမည်။",
  "capture.close": "မှတ်စုအသစ်ကို ပိတ်မည်",

  "search.title": "လုပ်ငန်းခွင် ရှာဖွေခြင်း",
  "search.close": "ရှာဖွေမှုကို ပိတ်မည်",
  "search.contentAria": "လုပ်ငန်းခွင်အကြောင်းအရာကို ရှာဖွေမည်",
  "search.placeholder": "မှတ်စုများ၊ လုပ်ငန်းများ၊ လူများကို ရှာဖွေပါ…",
  "search.filters": "ရှာဖွေမှု စစ်ထုတ်ချက်များ",
  "search.type": "အမျိုးအစား",
  "search.allTypes": "အမျိုးအစားအားလုံး",
  "search.from": "မှ",
  "search.through": "အထိ",
  "search.includeInactive": "မလှုပ်ရှားတော့သည်များ ပါဝင်စေမည်",
  "search.searching": "ရှာဖွေနေသည်…",
  "search.failed": "ရှာဖွေမှု မအောင်မြင်ပါ — {error}",
  "search.resultsAria": "ရှာဖွေမှု ရလဒ်များ",
  "search.moreAvailable": " · နောက်ထပ်ရှိသည်",
  "search.noMatches": "ကိုက်ညီမှု မရှိပါ။",
  "search.type.note": "မှတ်စု",
  "search.type.task": "လုပ်ငန်း",
  "search.type.contact": "ဆက်သွယ်ရန်",
  "search.type.journal": "ဒိုင်ယာရီ",
  "search.type.memory": "အမှတ်တရ",
  "search.type.job": "အလုပ်",
  "search.type.payable": "ပေးချေရန်",
  "search.type.loan": "ချေးငွေ",
  "search.type.shoppingItem": "ဈေးဝယ်ပစ္စည်း",

  "settings.language": "ဘာသာစကား",
  "settings.languageHint":
    "အင်တာဖေ့စ်ကိုသာ ပြောင်းလဲသည်။ သိမ်းဆည်းထားသော ရက်စွဲများ၊ ပမာဏများနှင့် မှတ်တမ်းများသည် လက်ရှိပုံစံအတိုင်း ရှိနေပါမည်။",
  "settings.closeToTray": "ပိတ်လိုက်ပါက Tray တွင် ချုံ့ထားမည်",
  "settings.closeToTrayHint":
    "စာမျက်နှာ ပိတ်လိုက်ပါက Purple Memo သည် စနစ် tray တွင် ဆက်လက်အလုပ်လုပ်နေဆဲဖြစ်၍ ပိတ်ထားသည့်အတိုင်းပင် သတိပေးချက်များ ဆက်လက်ပေါ်လာနိုင်ပါသည်။ ဤခလုတ်ကို ပိတ်လိုက်ပါက စာမျက်နှာ ပိတ်လိုက်တိုင်း အက်ပ်လည်း ပိတ်သွားပါမည်။",

  "session.remindersTitle": "သတိပေးချက်များ",
  "session.previewTitle": "သတိပေးချက် − {title}",
  "session.dueTitle": "သတိပေးချက် ရောက်နေသည်",
  "session.dueBody": "သတိပေးချက်ကို ကြည့်ရန် Purple Memo ကို ဖွင့်ပါ။",

  "lock.setup.badge": "အော့ဖ်လိုင်း ကုဒ်ဝှက်ထားသော လုပ်ငန်းခွင်",
  "lock.setup.title": "Purple Memo မှ ကြိုဆိုပါသည်",
  "lock.setup.intro":
    "သင့်လုပ်ငန်းခွင်ကို ကာကွယ်ရန် စက်တွင်းသုံး PIN တစ်ခု သတ်မှတ်ပါ။ PIN သည် မဖြစ်မနေ လိုအပ်ပြီး အွန်လိုင်းမှ ပြန်လည်ရယူနိုင်မည် မဟုတ်ပါ။ အောက်ပါ လုံခြုံရေးမေးခွန်းသည် PIN မေ့သွားပါက ပြန်ဝင်ရန် တစ်ခုတည်းသော နည်းလမ်းဖြစ်ပြီး ထိုအဖြေကို သိသူမည်သူမဆို ၎င်းဖြင့် PIN အသစ် သတ်မှတ်နိုင်သည် — ထို့ကြောင့် သင့်တစ်ဦးတည်း သိသောအရာကို ရွေးချယ်ပါ။",
  "lock.setup.choosePin": "PIN ရွေးချယ်ပါ",
  "lock.setup.pinNote":
    "အနည်းဆုံး စာလုံး {count} လုံး လိုအပ်သည်။ ဆားထည့်ထားသော hash အဖြစ် သိမ်းဆည်းပြီး ရိုးရိုးစာသားအဖြစ် ဘယ်တော့မှ မရေးပါ။",
  "lock.setup.pinLabel": "PIN (အနည်းဆုံး စာလုံး {count} လုံး)",
  "lock.setup.confirmPin": "PIN အတည်ပြုပါ",
  "lock.setup.recoveryTitle": "ပြန်လည်ရယူရန် မေးခွန်း သတ်မှတ်ပါ",
  "lock.setup.recoveryNote":
    "PIN မေ့သွားပါက ပြန်ဝင်ရန် တစ်ခုတည်းသော နည်းလမ်း။ သင့်တစ်ဦးတည်း သိသောအရာကို ဖြေပါ။",
  "lock.setup.question": "လုံခြုံရေးမေးခွန်း",
  "lock.setup.questionPlaceholder": "ဥပမာ − ကျွန်ုပ် ကြီးပြင်းခဲ့သော လမ်းအမည်ကား အဘယ်နည်း။",
  "lock.setup.answer": "လုံခြုံရေးအဖြေ",
  "lock.setup.answerPlaceholder": "မှတ်မိလွယ်သော အဖြေ",
  "lock.setup.submit": "PIN သတ်မှတ်ပြီး ဆက်လုပ်မည်",
  "lock.setup.busy": "ပြင်ဆင်နေသည်…",
  "lock.error.pinShort": "PIN သည် အနည်းဆုံး စာလုံး {count} လုံး ရှိရမည်။",
  "lock.error.pinMismatch": "PIN နှစ်ခု မတူညီပါ။",
  "lock.error.questionRequired":
    "လုံခြုံရေးမေးခွန်း လိုအပ်သည် — ၎င်းသည် သင့်အတွက် တစ်ခုတည်းသော ပြန်လည်ရယူရေး နည်းလမ်းဖြစ်သည်။",
  "lock.error.answerRequired": "လုံခြုံရေးအဖြေ လိုအပ်သည်။",

  "lock.badge": "စက်ရှင် သော့ခတ်ထားသည်",
  "lock.title": "Purple Memo ကို သော့ခတ်ထားသည်",
  "lock.intro": "ကုဒ်ဝှက်ထားသော မှတ်စုစာအုပ်နှင့် ဘဏ္ဍာရေးစာရင်းကို ဖွင့်ရန် PIN ထည့်ပါ။",
  "lock.pinLabel": "PIN",
  "lock.pinPlaceholder": "PIN ထည့်ပါ…",
  "lock.unlock": "ဖွင့်မည်",
  "lock.forgot": "PIN မေ့နေပါသလား။",
  "lock.error.noAnswer":
    "ဤတပ်ဆင်မှုအတွက် လုံခြုံရေးအဖြေ မသိမ်းဆည်းထားပါ — PIN ကို ပြန်လည်သတ်မှတ်၍ မရပါ။",
  "lock.error.wrongPin": "PIN မှားနေသည်။",
  "lock.error.wrongAnswer": "အဖြေ မှားနေသည်။",
  "lock.error.tooMany":
    "မှားယွင်းစွာ ကြိုးစားမှု များလွန်းသည် — ထပ်မံကြိုးစားမီ စက္ကန့် {seconds} စောင့်ပါ။",
  "lock.reset.title": "PIN ပြန်လည်သတ်မှတ်ပါ",
  "lock.reset.intro":
    "PIN အသစ် သတ်မှတ်ရန် သင့်လုံခြုံရေးမေးခွန်းကို ဖြေပါ။ PIN ပြန်လည်ရယူရန် အခြားနည်းလမ်း မရှိပါ။",
  "lock.reset.warning":
    "ဤလုပ်ဆောင်ချက်သည် သင့် PIN ကို အစားထိုးပါမည်။ သင့်လုံခြုံရေးအဖြေကို သိသူမည်သူမဆို ထိုသို့ပြုလုပ်ပြီး သင့်ကို ပိတ်ဆို့နိုင်သည် — PIN ကို အလွတ်ရသေးပါက နောက်သို့ပြန်ပြီး ဆက်တင်များရှိ PIN ပြောင်းလဲခြင်းကို အသုံးပြုပါ။",
  "lock.reset.answer": "အဖြေ",
  "lock.reset.answerPlaceholder": "သင့်လုံခြုံရေးအဖြေ",
  "lock.reset.newPin": "PIN အသစ်",
  "lock.reset.confirmPin": "PIN အသစ် အတည်ပြုပါ",
  "lock.reset.ack":
    "ဤလုပ်ဆောင်ချက်သည် ကျွန်ုပ်၏ PIN ကို အစားထိုးကြောင်း၊ လက်ရှိ PIN မသိဘဲ PIN သတ်မှတ်ရန် ဤနည်းလမ်းသာ ရှိကြောင်း နားလည်ပါသည်။",
  "lock.reset.submit": "PIN အသစ် သတ်မှတ်မည်",
  "lock.reset.noAnswer":
    "ဤတပ်ဆင်မှုအတွက် ပြန်လည်ရယူရေးနည်းလမ်း မရနိုင်ပါ — သိမ်းဆည်းထားသော PIN သာ တစ်ခုတည်းသော ဝင်ပေါက်ဖြစ်သည်။",
  "lock.reset.shortPin": "PIN အသစ်သည် အနည်းဆုံး စာလုံး {count} လုံး ရှိရမည်။",
  "lock.reset.unacknowledged":
    "အသိအမှတ်ပြုချက်ကို အရင်စစ်ပါ — PIN အသစ်သည် အတူတူကို အစားထိုးပြီး ပြန်လည်ပြုပြင်၍ မရပါ။",
  "lock.unreadable.title": "Purple Memo ကို သော့ခတ်ထားသည်",
  "lock.unreadable.corrupt": "သိမ်းဆည်းထားသော PIN မှတ်တမ်းကို ဖတ်၍ မရပါ။",
  "lock.unreadable.malformed":
    "သိမ်းဆည်းထားသော PIN မှတ်တမ်းသည် အသိအမှတ်ပြုထားသော ပုံစံဖြင့် မဟုတ်ပါ။",
  "lock.unreadable.weakIterations":
    "သိမ်းဆည်းထားသော PIN မှတ်တမ်းကို ဤဗားရှင်း လက်မခံနိုင်သော key-derivation ခွန်အားဖြင့် ပြုလုပ်ထားသည်။",
  "lock.unreadable.body":
    "{detail} ဤတပ်ဆင်မှုတွင် PIN သတ်မှတ်ထားသောကြောင့် ပထမဆုံးအသုံးပြုမှု ပြင်ဆင်ခြင်းကို မကမ်းလှမ်းပါ၊ ဤမှတ်တမ်းကို ဖတ်နိုင်သည်အထိ မည်သည့်အရာကိုမျှ ဖွင့်၍ မရပါ။ ပြဿနာ မစမီ ရယူထားသော အရန်သိမ်းဆည်းမှုမှ ဒေတာဘေ့စ်ကို ပြန်လည်ရယူပါ၊ သို့မဟုတ် ဤတပ်ဆင်မှု၏ အခြားမိတ္တူမှ ဆက်တင်များအတန်းကို ပြန်လည်ရယူပါ။",

  "inbox.title": "ဝင်စာ",
  "inbox.subtitle":
    "စဉ်းစားမိသည့် အခိုက်အတန့်တွင် ချရေးပါ။ ၎င်းသည် ဘာဖြစ်လာမည်ကို နောက်မှ ဆုံးဖြတ်ပါ။",
  "inbox.newMemo": "မှတ်စုအသစ်",
  "inbox.placeholder":
    "ရိုက်ထည့်ပါ။ Enter ဖြင့် ဖမ်းယူပြီး Shift+Enter ဖြင့် လိုင်းအသစ် စတင်ပါ။",
  "inbox.capture": "ဖမ်းယူမည်",
  "inbox.capturing": "ဖမ်းယူနေသည်…",
  "inbox.empty":
    "စောင့်နေသည့်အရာ မရှိပါ။ အပေါ်တွင် ချရေးပါ၊ သို့မဟုတ် မည်သည့်နေရာမှမဆို Ctrl+Shift+M ကို နှိပ်ပါ။",
  "inbox.capturedAt": "{date} တွင် ဖမ်းယူသည်",
  "inbox.archive": "စုစည်းသိမ်းမည်",
  "inbox.archiving": "စုစည်းသိမ်းနေသည်…",
  "inbox.converting": "ပြောင်းလဲနေသည်…",
  "inbox.convertGone": "အဆိုပါ ဖမ်းယူမှု မရှိတော့ပါ။",
  "inbox.convertArchived":
    "အဆိုပါ ဖမ်းယူမှုကို စုစည်းသိမ်းထားပြီးဖြစ်သောကြောင့် ပြောင်းလဲ၍ မရပါ။",
  "inbox.convertFailed":
    "ဖမ်းယူမှုကို ပြောင်းလဲခြင်း မပြုနိုင်ခဲ့ပါ။ ဘာမျှ မရေးသိမ်းထားပါ။ ထပ်မံကြိုးစားပါ။",
  "inbox.convertedToast": "{target} #{id} သို့ ပြောင်းလဲပြီးပါပြီ။",
  "inbox.earlier": "ယခင်က",
  "inbox.earlierBadge": "ပြောင်းလဲပြီး စုစည်းထားသည်",
  "inbox.earlierNote":
    "ပြောင်းလဲထားသော ဖမ်းယူမှုသည် မည်သည့် မှတ်စု၊ လုပ်ငန်း သို့မဟုတ် ဒိုင်ယာရီထည့်သွင်းမှု ဖြစ်သွားသည်ကို မှတ်တမ်းတင်ထားသည်။ ထို မှတ်တမ်းသည် ပစ်မှတ်ကို နောက်ပိုင်း ဖျက်လိုက်သော်လည်း ကျန်ရှိနေပြီး ထပ်မံပြောင်းလဲခြင်း မရှိပါ။",
  "inbox.show": "ပြမည်",
  "inbox.hide": "ဖျောက်မည်",
  "inbox.nothingEarlier": "ပြောင်းလဲထားသည် သို့မဟုတ် စုစည်းထားသည် မရှိသေးပါ။",
  "inbox.convertedTo": "{target} #{id} သို့ ပြောင်းလဲထားသည်",
  "inbox.convertedGone": "{target} #{id} သို့ ပြောင်းလဲထားသည်၊ သို့သော် ၎င်းမရှိတော့ပါ",
  "inbox.convertedOnly": "ပြောင်းလဲထားသည်",
  "inbox.archivedAt": "{date} တွင် စုစည်းသိမ်းထားသည်",
  "inbox.target.note": "မှတ်စု",
  "inbox.target.task": "လုပ်ငန်း",
  "inbox.target.journal": "ဒိုင်ယာရီ",
  "inbox.makeNote": "မှတ်စုတစ်ခု ပြုလုပ်မည်",
  "inbox.makeTask": "လုပ်ငန်းတစ်ခု ပြုလုပ်မည်",
  "inbox.addToJournal": "ယနေ့ ဒိုင်ယာရီသို့ ထည့်မည်",
  "inbox.what.capture": "ဖမ်းယူမှု",
  "inbox.what.convertedCapture": "ပြောင်းလဲထားသော ဖမ်းယူမှု",
  "inbox.what.archivedCapture": "စုစည်းထားသော ဖမ်းယူမှု",

  "trash.title": "အမှိုက်ပုံး",
  "trash.subtitle":
    "ဖျက်လိုက်သော မှတ်စုများ၊ လုပ်ငန်းများ၊ ဆက်သွယ်ရန်များ၊ အမှတ်တရများနှင့် ဒိုင်ယာရီထည့်သွင်းမှုများကို ဤနေရာတွင် ရက် {days} ရက်အထိ၊ အများဆုံး {max} ခုအထိ သိမ်းထားသည်။",
  "trash.notice":
    "အပြီးအပိုင် ဖျက်ခြင်းသည် ပစ္စည်းကို Purple Memo မှ ဖယ်ရှားသည်။ ၎င်းသည် မှုခင်းဆိုင်ရာ ဖျက်ပစ်ခြင်း မဟုတ်ပါ၊ လည်ပတ်မှုစနစ်၏ အရန်သိမ်းဆည်းမှုများတွင် မိတ္တူများ ကျန်နိုင်ပါသည်။",
  "trash.empty": "အမှိုက်ပုံး ဗလာဖြစ်နေသည်။",
  "trash.restore": "ပြန်လည်ရယူမည်",
  "trash.deletePermanently": "အပြီးအပိုင် ဖျက်မည်",
  "trash.deletedAt": "{type} · {date} တွင် ဖျက်ခဲ့သည်",
  "trash.restored": "ပြန်လည်ရယူပြီးပါပြီ။",
  "trash.permanentlyDeleted": "အပြီးအပိုင် ဖျက်ပြီးပါပြီ။",
  "trash.deleteWhat": "အမှိုက်ပုံးပစ္စည်း (အပြီးအပိုင်)",
  "trash.type.note": "မှတ်စု",
  "trash.type.task": "လုပ်ငန်း",
  "trash.type.contact": "ဆက်သွယ်ရန်",
  "trash.type.memory": "အမှတ်တရ",
  "trash.type.journalEntry": "ဒိုင်ယာရီထည့်သွင်းမှု",

  "notes.untitled": "ခေါင်းစဉ်မဲ့",
  "notes.titleAria": "မှတ်စု ခေါင်းစဉ်",
  "notes.tagsPlaceholder": "တဂ်များ (ကော်မာဖြင့် ခြားပါ၊ ဥပမာ work, ideas)",
  "notes.tagsAria": "မှတ်စု တဂ်များ",
  "notes.collectionAria": "မှတ်စု စုစည်းမှု",
  "notes.noCollection": "စုစည်းမှု မရှိ",
  "notes.markdown": "Markdown",
  "notes.contentPlaceholder": "Markdown ဖြင့် ရေးပါ…",
  "notes.contentAria": "မှတ်စု အကြောင်းအရာ (Markdown)",
  "notes.resizeAria": "တည်းဖြတ်ကွက်နှင့် အစမ်းကြည့်ကွက်ကို အရွယ်ပြောင်းမည်",
  "notes.livePreview": "အချိန်နှင့်တပြေးညီ အစမ်းကြည့်",
  "notes.previewEmpty": "အစမ်းကြည့်ရလဒ်ကို ဤနေရာတွင် ပြပါမည်။",
  "notes.saving": "သိမ်းနေသည်…",
  "notes.save": "သိမ်းမည်",
  "notes.unsaved": "မသိမ်းရသေးသော မူကြမ်း",
  "notes.discardTitle": "မသိမ်းရသေးသော မူကြမ်းကို ပယ်ပြီး သိမ်းထားသည့် မှတ်စုကို ပြန်ဖွင့်မည်",
  "notes.discard": "မူကြမ်း ပယ်မည်",
  "notes.unpin": "ပင်ထိုးမှ ဖြုတ်မည်",
  "notes.pin": "ပင်ထိုးမည်",
  "notes.unarchive": "မော်ကွန်းမှ ပြန်ထုတ်မည်",
  "notes.archive": "မော်ကွန်းတင်မည်",
  "notes.toJournalTitle": "ဤမှတ်စုကို ယနေ့၏ ဒိုင်ယာရီထည့်သွင်းမှုတွင် ဆက်စပ်ထည့်မည်",
  "notes.adding": "ထည့်နေသည်…",
  "notes.sendToJournal": "ဒိုင်ယာရီသို့ ပို့မည်",
  "notes.deleteWhat": "မှတ်စု",
  "notes.moveToTrash": "အမှိုက်ပုံးသို့ ရွှေ့မည်",
  "notes.addedToJournal": "“{title}” ကို ယနေ့၏ ဒိုင်ယာရီထည့်သွင်းမှုသို့ ထည့်ပြီးပါပြီ။",
  "notes.noMatch": "ဤရှာဖွေမှုနှင့် ကိုက်ညီသော မှတ်စု မရှိပါ။",
  "notes.noNotes": "မှတ်စု မရှိသေးပါ — ပထမဆုံး မှတ်စုကို ဖန်တီးပါ။",
  "notes.pinned": "ပင်ထိုးထားသည်",
  "notes.archivedBadge": "မော်ကွန်းတင်ထားသည်",
  "notes.noExcerpt": "ထပ်ဆောင်း စာသား မရှိပါ…",
  "notes.missing": "ထို မှတ်စု မရှိတော့ပါ — ဖျက်လိုက်ခြင်း ဖြစ်နိုင်သည်။",
  "notes.selectPrompt":
    "စာရင်းမှ မှတ်စုတစ်ခုကို ရွေးပါ၊ သို့မဟုတ် Markdown ဖြင့် စတင်ရေးသားရန် အသစ်တစ်ခု ဖန်တီးပါ။",
  "notes.collections": "စုစည်းမှုများ",
  "notes.allNotes": "မှတ်စုအားလုံး",
  "notes.deleteCollectionWhat": "စုစည်းမှု “{name}”",
  "notes.deleteCollectionAria": "စုစည်းမှု {name} ကို ဖျက်မည်",
  "notes.newCollectionPlaceholder": "စုစည်းမှု အသစ်…",
  "notes.newCollectionAria": "စုစည်းမှု အသစ် အမည်",
  "notes.add": "ထည့်မည်",
  "notes.notesAria": "မှတ်စုများ",
  "notes.notesHeading": "မှတ်စုများ",
  "notes.searchPlaceholder": "မှတ်စုများ ရှာဖွေမည် (စာသားအပြည့်)…",
  "notes.searchAria": "မှတ်စုများ ရှာဖွေမည်",
  "notes.showArchived": "မော်ကွန်းတင်ထားသည်",
  "notes.newNote": "မှတ်စု အသစ်",
  "notes.noteListAria": "မှတ်စု စာရင်း",
  "notes.editorAria": "မှတ်စု တည်းဖြတ်ကွက်",
  "notes.viewAria": "တည်းဖြတ်ကွက် မြင်ကွင်းပုံစံ",
  "notes.viewEdit": "တည်းဖြတ်ရန်",
  "notes.viewSplit": "နှစ်ကွက်ပြရန်",
  "notes.viewRead": "ဖတ်ရန်",
  "notes.openReader": "ပေါ့ပ်အပ်ဖြင့် ဖတ်ရန်",
  "notes.openReaderAria": "မှတ်စုကို ပေါ့ပ်အပ်ဖြင့် ဖတ်ရန်",
  "notes.prevNote": "ယခင် မှတ်စု",
  "notes.nextNote": "နောက် မှတ်စု",
  "notes.copyMarkdown": "Markdown ကူးယူရန်",
  "notes.copied": "ကူးယူပြီးပါပြီ",
  "notes.collapseCollections": "စုစည်းမှုများ ချုံ့မည်",
  "notes.expandCollections": "စုစည်းမှုများ ချဲ့မည်",

  "tasks.title": "လုပ်ငန်းများနှင့် သတိပေးချက်များ",
  "tasks.subtitle":
    "လုပ်ဆောင်ရန် ကျန်ရှိသော အလုပ်များနှင့် ထပ်ခါတလဲလဲ အချိန်ဇယားများ။ သတိပေးချက်များသည် Purple Memo ဖွင့်ထားပြီး လော့ခ်ဖွင့်ထားစဉ်တွင်သာ ပေါ်လာမည်။",
  "tasks.openAria": "ကျန်ရှိသော လုပ်ငန်းများ",
  "tasks.open": "ကျန်ရှိသော လုပ်ငန်းများ",
  "tasks.showDone": "ပြီးစီးသူများ ပြမည်",
  "tasks.empty": "ရက်ချိန်းရှိသမျှ မရှိပါ — ခံစားလိုက်ပါ။",
  "tasks.overdue": "ရက်လွန်နေသည်",
  "tasks.due": "ရက်ချိန်း {date}",
  "tasks.done": "ပြီးပါပြီ",
  "tasks.moveToTrash": "အမှိုက်ပုံးသို့ ရွှေ့မည်",
  "tasks.deleteWhat": "လုပ်ငန်း",
  "tasks.completed": "ပြီးစီးပြီး",
  "tasks.reopen": "ပြန်ဖွင့်မည်",
  "tasks.missing": "ထို လုပ်ငန်း မရှိတော့ပါ — ဖျက်လိုက်ခြင်း ဖြစ်နိုင်သည်။",
  "tasks.newTask": "လုပ်ငန်း အသစ်",
  "tasks.titleLabel": "ခေါင်းစဉ်",
  "tasks.titlePlaceholder": "ဥပမာ လျှပ်စစ်မီတာခပေးရန်",
  "tasks.dueLabel": "ရက်ချိန်း (မဖြစ်မနေ မဟုတ်)",
  "tasks.dueAria": "ရက်ချိန်း",
  "tasks.repeatLabel": "ထပ်ခါတလဲလဲ",
  "tasks.repeatAria": "ထပ်ခါတလဲလဲ",
  "tasks.noteLabel": "မှတ်ချက် (မဖြစ်မနေ မဟုတ်)",
  "tasks.notePlaceholder": "အသေးစိတ် သို့မဟုတ် အကြောင်းအရာ",
  "tasks.add": "လုပ်ငန်း ထည့်မည်",
  "tasks.importCsv": "CSV တင်သွင်းမည်",
  "tasks.importTitle": "CSV မှ လုပ်ငန်းများ တင်သွင်းမည်",
  "tasks.dueColumn": "ရက်ချိန်း",
  "tasks.doneColumn": "ပြီးစီးမှု",
  "tasks.noteColumn": "မှတ်ချက်",
  "tasks.remindersAria": "သတိပေးချက်များ",
  "tasks.remindersHeading": "အချိန်ဇယားဆွဲထားသော သတိပေးချက်များ",
  "tasks.noReminders": "အချိန်ဇယားဆွဲထားသော သတိပေးချက် မရှိပါ။",
  "tasks.fired": "ပေါ်ပြီး",
  "tasks.snoozeUntil": "{title} ကို ဤအချိန်အထိ ရွှေ့မည်",
  "tasks.snooze": "ရွှေ့မည်",
  "tasks.acknowledgeWhat": "ပေါ်ပြီး သတိပေးချက်",
  "tasks.acknowledge": "သိပြီးကြောင်း မှတ်မည်",
  "tasks.reminderWhat": "သတိပေးချက်",
  "tasks.reminderTitleAria": "သတိပေးချက် ခေါင်းစဉ်",
  "tasks.reminderTitlePlaceholder":
    "သတိပေးချက် ခေါင်းစဉ် (ဥပမာ ကုန်ပစ္စည်းပေးသွင်းသူကို ဖုန်းဆက်ရန်)",
  "tasks.remindAtAria": "သတိပေးမည့် အချိန်",
  "tasks.reminderRepeatAria": "သတိပေးချက် ထပ်ခါတလဲလဲ",
  "tasks.addReminder": "သတိပေးချက် ထည့်မည်",
  "tasks.repeat.none": "ထပ်ခါတလဲလဲ မရှိ",
  "tasks.repeat.daily": "နေ့စဉ်",
  "tasks.repeat.weekly": "အပတ်စဉ်",
  "tasks.repeat.monthly": "လစဉ်",

  "dashboard.title": "ယနေ့",
  "dashboard.trendLevel": "မနေ့နှင့် တူညီသည်",
  "dashboard.trendChange": "မနေ့ထက် {pct}%",
  "dashboard.overview": "ခြုံငုံသုံးသပ်ချက်",
  "dashboard.moneyIn": "ယနေ့ ဝင်ငွေ",
  "dashboard.cashInflow": "နေ့စဉ် ငွေဝင်စီးဆင်းမှု (cash-basis)",
  "dashboard.moneyOut": "ယနေ့ ထွက်ငွေ",
  "dashboard.netToday": "ယနေ့ အသားတင် — {amount}",
  "dashboard.totalReceivable": "စုစုပေါင်း ရရန်ကျန်",
  "dashboard.openBalances": "ဖွင့်ထားသော ဖောက်သည်လက်ကျန်များ",
  "dashboard.actionItems": "လုပ်ဆောင်ရန် ခေါင်းစဉ်များ",
  "dashboard.habitsLogged": "ယနေ့ အလေ့အထ {done}/{total} ခု မှတ်တမ်းတင်ပြီး",
  "dashboard.queue": "လုပ်ငန်းနှင့် သတိပေးချက် တန်းစီမှု",
  "dashboard.notesAction": "မှတ်စုများ",
  "dashboard.journalAction": "ဒိုင်ယာရီ",
  "dashboard.logTransaction": "ငွေလွှဲမှု မှတ်တမ်းတင်မည်",
  "dashboard.todayHeading": "ယနေ့",
  "dashboard.tasksRemindersHeading": "လုပ်ငန်းများနှင့် သတိပေးချက်များ",
  "dashboard.urgencyLegend":
    "အစိမ်းရောင် — {days} ရက်ထက် ကျော်လွန်သော ရက်ချိန်း · အဝါရောင် — {days} ရက်အတွင်း ရက်ချိန်း · အနီရောင် — ရက်လွန်သွားပြီ · အရောင်မပါ — ရက်ချိန်းမရှိပါ",
  "dashboard.noOpenTasks": "ဖွင့်ထားသော လုပ်ငန်းများ မရှိပါ",
  "dashboard.task": "လုပ်ငန်း",
  "dashboard.taskDue": "လုပ်ငန်း · ရက်ချိန်း {date}",
  "dashboard.complete": "ပြီးစီးမည်",
  "dashboard.newDueDate": "{title} အတွက် ရက်ချိန်းအသစ်",
  "dashboard.reschedule": "ရက်ပြန်ချိန်းမည်",
  "dashboard.reminder": "သတိပေးချက်",
  "dashboard.reminderAt": "သတိပေးချက် · {date}",
  "dashboard.firedHeading": "ပေါ်ပြီး — သိပြီးကြောင်းမှတ်ပါ သို့မဟုတ် ရွှေ့ပါ",
  "dashboard.firedInfo": "{date} တွင် ပေါ်ခဲ့သည် — ဖြေရှင်းသည်အထိ ဤနေရာတွင် ရှိနေမည်",
  "dashboard.openTasks": "လုပ်ငန်းများ ဖွင့်မည်",
  "dashboard.todaysMoney": "ယနေ့ ငွေကြေး",
  "dashboard.in": "ဝင်",
  "dashboard.out": "ထွက်",
  "dashboard.openBudget": "ဘတ်ဂျက် ဖွင့်မည်",
  "dashboard.habitWeekHeading": "အလေ့အထ ရက်သတ္တပတ် တိုးတက်မှု",
  "dashboard.noHabits": "အလေ့အထ မရှိသေးပါ။",
  "dashboard.habitWeekProgress": "ဤရက်သတ္တပတ် {done}/7",
  "dashboard.openHabits": "အလေ့အထများ ဖွင့်မည်",
  "dashboard.comingUp": "ရောက်လာမည့်",
  "dashboard.upcomingHeading": "ရောက်လာမည့် အမှတ်တရများနှင့် မွေးနေ့များ",
  "dashboard.nothingNext": "လာမည့် {days} ရက်အတွင်း မရှိပါ။",
  "dashboard.memory": "အမှတ်တရ",
  "dashboard.birthday": "မွေးနေ့",
  "dashboard.birthdayWithDate": "မွေးနေ့ · {date}",
  "dashboard.openMemories": "အမှတ်တရများ ဖွင့်မည်",
  "dashboard.recurringHeading": "ထပ်ခါတလဲလဲ ငွေပေးချေမှုများ",
  "dashboard.noRecurring": "လာမည့် {days} ရက်အတွင်း ထပ်ခါတလဲလဲ ငွေပေးချေမှု မရှိပါ။",
  "dashboard.recurring": "ထပ်ခါတလဲလဲ",
  "dashboard.dueOn": "ရက်ချိန်း {date}",
  "dashboard.openBusiness": "လုပ်ငန်း ဖွင့်မည်",
  "dashboard.warrantiesHeading": "သက်တမ်းကုန်မည့် အာမခံများ",
  "dashboard.noWarranties": "လာမည့် {days} ရက်အတွင်း သက်တမ်းကုန်မည့် အာမခံ မရှိပါ။",
  "dashboard.warranty": "အာမခံ",
  "dashboard.until": "{date} အထိ",
  "dashboard.totalReceivableHeading": "စုစုပေါင်း ရရန်ကျန်",
  "dashboard.outstanding": "မဆပ်ရသေးသော",
  "dashboard.receivableNote":
    "ဖွင့်ထားသော ဖောက်သည် ပြုပြင်ရေးနှင့် ဝန်ဆောင်မှု အလုပ်များ၏ မဆပ်ရသေးသော လက်ကျန်။",
  "dashboard.openReceivable": "ရရန်ကျန် ဖွင့်မည်",

  "settings.backupTitle": "အရန်သိမ်းဆည်းမှုနှင့် ပြန်လည်ရယူမှု",
  "settings.backupBadge": ".zip သို့မဟုတ် စကားဝှက်ကာကွယ်ထားသည်",
  "settings.protectBackup":
    "အရန်သိမ်းဆည်းမှုကို စကားဝှက်ဖြင့် ကာကွယ်မည် (ဖွင့်ရန် ဤစကားဝှက် လိုအပ်သော .{ext} ဖိုင်)",
  "settings.backupPassword": "အရန်သိမ်းဆည်းမှု စကားဝှက်",
  "settings.confirmBackupPassword": "အရန်သိမ်းဆည်းမှု စကားဝှက် အတည်ပြုမည်",
  "settings.exporting": "ထုတ်ယူနေသည်…",
  "settings.exportBackup": "အရန်သိမ်းဆည်းမှု ထုတ်ယူမည်",
  "settings.importing": "တင်သွင်းနေသည်…",
  "settings.importBackup": "အရန်သိမ်းဆည်းမှု တင်သွင်းမည်",
  "settings.opening": "ဖွင့်နေသည်…",
  "settings.openBackup": "အရန်သိမ်းဆည်းမှု ဖွင့်မည်",
  "settings.summary":
    "{date} မှ အရန်သိမ်းဆည်းမှု — ဇယား {tables} ခုတွင် အတန်း {rows} ခု၊ ဓာတ်ပုံ {photos} ခု။ ဆက်လုပ်ပါက လက်ရှိဒေတာအားလုံးကို အစားထိုးမည်။",
  "settings.replaceAll": "ဒေတာအားလုံး အစားထိုးမည်",
  "settings.passwordMismatch": "စကားဝှက်နှစ်ခု မကိုက်ညီပါ — မည်သည့်အရာမျှ မထုတ်ယူရသေးပါ။",
  "settings.passwordRequired":
    "စကားဝှက်ဖြင့် ကာကွယ်ရန် ရွေးချယ်ပြီး စကားဝှက် သတ်မှတ်ပါ — မဟုတ်ပါက ကာကွယ်မှုမထားဘဲ ထုတ်ယူရန် ရွေးချယ်ပါ — မည်သည့်အရာမျှ မထုတ်ယူရသေးပါ။",
  "settings.saveBackupTitle": "Purple Memo အရန်သိမ်းဆည်းမှု သိမ်းမည်",
  "settings.encryptedBackupFilter": "စကားဝှက်ကာကွယ်ထားသော Purple Memo အရန်သိမ်းဆည်းမှု",
  "settings.backupFilter": "Purple Memo အရန်သိမ်းဆည်းမှု",
  "settings.backupSaved":
    "အရန်သိမ်းဆည်းမှုကို {path} တွင် သိမ်းပြီးပါပြီ — အတန်း {rows} ခု၊ ဓာတ်ပုံ {photos} ခု",
  "settings.backupSavedEncrypted":
    "အရန်သိမ်းဆည်းမှုကို {path} တွင် သိမ်းပြီးပါပြီ — အတန်း {rows} ခု၊ ဓာတ်ပုံ {photos} ခု၊ စကားဝှက်ကာကွယ်ထားသည်",
  "settings.tooLarge":
    "အရန်သိမ်းဆည်းမှု ဖိုင်သည် {limit} ဘိုက် ကန့်သတ်ချက်ထက် ကြီးနေသည် — တင်သွင်းမှုကို ပယ်ခဲ့သည်။",
  "settings.imported":
    "အတန်း {rows} ခုနှင့် ဓာတ်ပုံ {photos} ခုကို တင်သွင်းပြီးပါပြီ — ယခင်ဒေတာကို {path} တွင် သိမ်းထားသည်။ ပြန်လည်ဖွင့်နေသည်…",

  "reset.dangerZone": "အန္တရာယ်ရှိ အပိုင်း",
  "reset.dangerZoneBadge": "အပြီးအပိုင်း ဖျက်မည်",
  "reset.factoryReset": "ဖက်တိုရီ ရိစတေ့ (Factory reset)",
  "reset.irreversible": "ဖက်တိုရီ ရိစတေ့ကို ပြန်လည်ရယူ၍ မရနိုင်ပါ။",
  "reset.acknowledge":
    "ဤလုပ်ဆောင်ချက်က Purple Memo ဤစက်တွင် သိမ်းဆည်းထားသမျှအားလုံးကို အပြီးအပိုင်း ဖျက်ပစ်မည်ဖြစ်ပြီး ပြန်လည်ရယူ၍ မရကြောင်း ကျွန်ုပ် နားလည်ပါသည်။",
  "reset.confirmWhat": "Purple Memo သိမ်းဆည်းထားသမျှ",
  "reset.run": "ဖျက်ပစ်မည်…",
  "reset.running":
    "ဖက်တိုရီ ရိစတေ့ လုပ်ဆောင်နေပါသည် — ဒေတာဘေ့စ်ကို ပိတ်ပြီး အားလုံးကို ဖျက်နေပါသည်။ အက်ပ်ကို မပိတ်ပါနှင့်။",
  "reset.successTitle": "ဖက်တိုရီ ရိစတေ့ ပြီးဆုံးပါပြီ",
  "reset.successBody":
    "ဤစက်တွင် Purple Memo သိမ်းဆည်းထားသမျှအားလုံး ဖျက်ပြီးပါပြီ။ ပထမဆုံး သတ်မှတ်ခြင်း အဆင့် ပြန်စရန် အက်ပ်ကို ပြန်ဖွင့်ပါ။",
  "reset.restart": "Purple Memo ကို ပြန်ဖွင့်မည်",
  "reset.incompleteTitle": "ဖက်တိုရီ ရိစတေ့ ပြီးဆုံးခြင်း မရှိပါ",
  "reset.incompleteBody":
    "အချို့ အစိတ်အပိုင်းများကို ဖျက်၍ မရသေးပါ၊ ပြီးတော့ ဤအသုံးပြုချိန် ပြီးဆုံးပါပြီ — ဒေတာဘေ့စ် ချိတ်ဆက်မှု ပိတ်ထားသဖြင့် ပြန်မဖွင့်မီ Purple Memo ကို အသုံးပြု၍ မရပါ။ ရိစတေ့ကို ထပ်ဖွင့်ရန် ဘေးကင်းပါသည် — ထပ်စမ်းကြည့်ပါ။ ထပ်မံ မအောင်မြင်ပါက Purple Memo ကို ပိတ်ပြီး ကိုယ်တိုင် ပြန်ဖွင့်ပါ — နောက်တစ်ကြိမ် ဖွင့်သောအခါ ကျန်ရှိသည်များဖြင့် ပုံမှန်အတိုင်း ဖွင့်လာမည် သို့မဟုတ် ပထမဆုံး သတ်မှတ်ခြင်း အဆင့်သို့ ရောက်သွားပါမည် — အောက်ပါ စာရင်းက အပြင်ကျန်ခဲ့သည်များအားလုံး ဖြစ်ပါသည်။",
  "reset.retry": "ထပ်စမ်းမည်",
  "reset.errorTitle": "ဖက်တိုရီ ရိစတေ့ မလုပ်ဆောင်နိုင်ပါ",
  "reset.errorBody":
    "ရိစတေ့ ကြိုးစားမှု မအောင်မြင်ပါ။ အဘယ်အရာ ဖျက်ခဲ့သည်ကို မည်သို့မျှ မယူဆရပါ — မည်သို့ဖြစ်စေ ဤအသုံးပြုချိန် ပြီးဆုံးပါပြီ — ဒေတာဘေ့စ် ချိတ်ဆက်မှု ပိတ်ထားသဖြင့် ရိစတေ့ကို ထပ်စမ်းပါ သို့မဟုတ် Purple Memo ကို ပိတ်ပြီး ကိုယ်တိုင် ပြန်ဖွင့်ပါ။",
  "reset.component.shareStop": "LAN မျှဝေခြင်း",
  "reset.component.database": "ကုဒ်ဝှက်ထားသော ဒေတာဘေ့စ်",
  "reset.component.photos": "ဓာတ်ပုံများ",
  "reset.component.backups": "အက်ပ်၏ အရန်မိတ္တူများ",
  "reset.component.logs": "မှတ်တမ်းဖိုင်များ",
  "reset.component.keyringKey": "ဒေတာဘေ့စ် သော့ (Windows credential store)",
  "reset.status.removed": "ဖျက်ပြီး",
  "reset.status.alreadyAbsent": "မရှိတော့ပါ",
  "reset.status.failed": "မအောင်မြင်ပါ",
  "reset.status.notAttempted": "မကြိုးစားရသေးပါ",

  "linkPicker.title": "ချိတ်ဆက်မည့်အရာ",
  "linkPicker.close": "ချိတ်ဆက်မှု ရွေးချယ်ကွက်ကို ပိတ်မည်",
  "linkPicker.searchLabel": "ရှာဖွေမည်",
  "linkPicker.searchAria": "မှတ်စုများ၊ လုပ်ငန်းများနှင့် ဆက်သွယ်ရန်များ ရှာဖွေမည်",
  "linkPicker.includeInactive":
    "မော်ကွန်းတင်ထားသော မှတ်စုများနှင့် ပြီးစီးသော လုပ်ငန်းများ ပါဝင်စေမည်",
  "linkPicker.empty":
    "ဤနေရာတွင် ချိတ်ဆက်ရန် မရှိပါ။ မှတ်စု၊ လုပ်ငန်း သို့မဟုတ် ဆက်သွယ်ရန် တစ်ခု ရှိရပါမည်။",
  "linkPicker.listAria": "ချိတ်ဆက်နိုင်သော အရာများ",
  "linkPicker.capped":
    "ကိုက်ညီမှု {matched} ခုအနက် {shown} ခု ပြနေသည်။ ရှာဖွေမှုကို ကျဉ်းမြောင်းစေပါ၊ သို့မဟုတ် မော်ကွန်းတင်ထားသော၊ ပြီးစီးသော အရာများ ပါဝင်စေပါ။",
  "linkPicker.linking": "ချိတ်ဆက်နေသည်…",
  "linkPicker.loading": "သင့်မှတ်စုများ၊ လုပ်ငန်းများနှင့် ဆက်သွယ်ရန်များကို ဖွင့်နေသည်…",

  "links.relatedAria": "ဆက်စပ်အရာများ",
  "links.related": "ဆက်စပ်မှု",
  "links.linkTo": "ချိတ်ဆက်မည်…",
  "links.loading": "ဆက်စပ်အရာများကို ဖွင့်နေသည်…",
  "links.alreadyLinked": "ထို နှစ်ခု ချိတ်ဆက်ပြီးဖြစ်သည်။",
  "links.empty": "မည်သည့်အရာနှင့်မျှ မဆက်စပ်ရသေးပါ။",
  "links.unavailable": "{type} — မရနိုင်တော့ပါ (ဖျက်လိုက်ခြင်း)",
  "links.unlinkWhat": "ချိတ်ဆက်မှု",
  "links.unlink": "ချိတ်ဆက်မှု ဖြုတ်မည်",

  "import.chooseFile": "CSV ဖိုင် ရွေးချယ်မည်",
  "import.chooseAnother": "အခြားဖိုင် ရွေးချယ်မည်",
  "import.fileHint": "CSV ဖိုင်များသာ။ အစမ်းကြည့်ရှုမှုကို အတည်ပြုသည်အထိ မည်သည့်အရာမျှ မရေးပါ။",
  "import.downloadTemplate": "စံပြစာရွက် CSV ဒေါင်းလုဒ်လုပ်မည်",
  "import.savingTemplate": "သိမ်းဆည်းနေသည်…",
  "import.saveTemplateTitle": "CSV စံပြစာရွက် သိမ်းဆည်းမည်",
  "import.csvFilter": "CSV ဖိုင်",
  "import.templateSaved": "စံပြစာရွက် CSV ကို {path} တွင် သိမ်းဆည်းပြီးပါပြီ။",
  "import.previewCapped":
    "အစမ်းကြည့်ရှုမှုတွင် အတန်း {total} ခုအနက် ပထမ {shown} ခုကိုသာ ပြနေသည် — မှန်ကန်သော အတန်း {total} ခုလုံး တင်သွင်းပါမည်။",
  "import.yes": "ပြီး",
  "import.no": "မပြီးသေး",
  "import.reading": "ဖတ်နေသည်…",
  "import.rowsToImportAria": "တင်သွင်းမည့် အတန်းများ",
  "import.errorsTitle": "ကျော်သွားမည့် အတန်းများ",
  "import.errorsAria": "အတန်း အမှားများ",
  "import.rowError": "အတန်း {row}: {reason}",
  "import.nothing": "တင်သွင်း၍ ရသော အတန်း မရှိပါ — အမှားများကို ပြင်ပြီး ဖိုင်ကို ပြန်ရွေးပါ။",
  "import.import": "တင်သွင်းမည်",
  "import.importing": "တင်သွင်းနေသည်…",
  "import.resultTitle": "တင်သွင်းမှု ပြီးပါပြီ",
  "import.done": "ပြီးပါပြီ",
  "import.error.tooLarge":
    "CSV ဖိုင်သည် {limit} MiB ကန့်သတ်ချက်ထက် ကြီးနေသည် — တင်သွင်းမှု ငြင်းပယ်ခဲ့သည်။",
  "import.error.tooManyRows":
    "CSV တွင် အတန်း {rows} ခုထက် ပိုနေသည် — တင်သွင်းမှု ငြင်းပယ်ခဲ့သည်။",
  "import.error.missingColumn":
    "CSV တွင် လိုအပ်သော ကော်လံ {columns} မပါဝင်ပါ — တင်သွင်းမှု ငြင်းပယ်ခဲ့သည်။",
  "import.error.missingColumns":
    "CSV တွင် လိုအပ်သော ကော်လံများ {columns} မပါဝင်ပါ — တင်သွင်းမှု ငြင်းပယ်ခဲ့သည်။",
  "import.reason.titleRequired": "ခေါင်းစဉ် လိုအပ်ပါသည်။",
  "import.reason.dueDate":
    "ရက်ချိန်းသည် မှန်ကန်သော YYYY-MM-DD ရက်စွဲ ဖြစ်ရမည် (သို့မဟုတ် အလွတ်ထားနိုင်သည်)။",
  "import.reason.done":
    "done သည် true၊ false၊ yes၊ no၊ 1 သို့မဟုတ် 0 ဖြစ်ရမည် (သို့မဟုတ် အလွတ်ထားနိုင်သည်)။",
  "import.reason.repeat":
    "repeat သည် none၊ daily၊ weekly သို့မဟုတ် monthly ဖြစ်ရမည် (သို့မဟုတ် အလွတ်ထားနိုင်သည်)။",
  "import.reason.nameRequired": "အမည် လိုအပ်ပါသည်။",
  "import.reason.birthday":
    "မွေးနေ့သည် မှန်ကန်သော YYYY-MM-DD သို့မဟုတ် MM-DD ရက်စွဲ ဖြစ်ရမည် (သို့မဟုတ် အလွတ်ထားနိုင်သည်)။",

  "contacts.title": "ဆက်သွယ်ရန် စာရင်း",
  "contacts.subtitle":
    "ကိုယ်ရေးနှင့် လုပ်ငန်း ဆက်သွယ်ရန်များ၊ ဆက်သွယ်ရေး လမ်းကြောင်းများ၊ တက်ဂ်များနှင့် မွေးနေ့များ",
  "contacts.importCsv": "CSV တင်သွင်းမည်",
  "contacts.importTitle": "CSV မှ ဆက်သွယ်ရန်များ တင်သွင်းမည်",
  "contacts.directory": "လမ်းညွှန်စာရင်း",
  "contacts.searchPlaceholder": "ဆက်သွယ်ရန်များ ရှာဖွေမည်…",
  "contacts.searchAria": "ဆက်သွယ်ရန်များ ရှာဖွေမည်",
  "contacts.newNamePlaceholder": "ဆက်သွယ်ရန် အမည်အသစ်",
  "contacts.newNameAria": "ဆက်သွယ်ရန် အမည်အသစ်",
  "contacts.add": "ထည့်မည်",
  "contacts.emptyAll": "ဆက်သွယ်ရန် မရှိသေးပါ — အပေါ်တွင် တစ်ခု ထည့်ပါ။",
  "contacts.emptySearch": "ရှာဖွေမှုနှင့် ကိုက်ညီသော ဆက်သွယ်ရန် မရှိပါ။",
  "contacts.selectPrompt": "ဘယ်ဘက်မှ ဆက်သွယ်ရန် တစ်ခုကို ရွေးပါ၊ သို့မဟုတ် အသစ်ထည့်ပါ။",
  "contacts.missing": "ထို ဆက်သွယ်ရန် မရှိတော့ပါ — ဖျက်လိုက်ခြင်း ဖြစ်နိုင်သည်။",
  "contacts.birthdayBadge": "မွေးနေ့ - {date}",
  "contacts.save": "သိမ်းဆည်းမည်",
  "contacts.moveToTrash": "အမှိုက်ပုံးသို့ ရွှေ့မည်",
  "contacts.deleteWhat": "ဆက်သွယ်ရန်",
  "contacts.nameLabel": "အမည်",
  "contacts.addressLabel": "လိပ်စာ",
  "contacts.addressPlaceholder": "လမ်း၊ မြို့…",
  "contacts.birthdayLabel": "မွေးနေ့",
  "contacts.birthdayTypeAria": "မွေးနေ့ အမျိုးအစား",
  "contacts.birthdayNone": "မွေးနေ့ မထည့်ပါ",
  "contacts.birthdayFull": "ရက်စွဲ အပြည့်အစုံ",
  "contacts.birthdayMonthDay": "လနှင့် ရက်",
  "contacts.birthdayDateAria": "မွေးနေ့ ရက်စွဲ",
  "contacts.birthdayMonthDayAria": "မွေးနေ့ လနှင့် ရက်",
  "contacts.birthdayInvalidDate": "မွေးနေ့သည် မှန်ကန်သော ရက်စွဲ ဖြစ်ရပါမည်။",
  "contacts.birthdayInvalidMonthDay": "လနှင့် ရက်သည် 01-01 မှ 12-31 အတွင်း ဖြစ်ရပါမည်။",
  "contacts.notesLabel": "မှတ်ချက်များ",
  "contacts.channelsHeading": "ဆက်သွယ်ရေး လမ်းကြောင်းများ",
  "contacts.channelsEmpty": "ဆက်သွယ်ရေး လမ်းကြောင်း မရှိသေးပါ။",
  "contacts.channelKind.phone": "ဖုန်း",
  "contacts.channelKind.email": "အီးမေးလ်",
  "contacts.channelKind.other": "အခြား",
  "contacts.primaryBadge": "အဓိက",
  "contacts.makePrimary": "အဓိက ထားမည်",
  "contacts.channelDeleteWhat": "{kind} လမ်းကြောင်း",
  "contacts.channelKindAria": "လမ်းကြောင်း အမျိုးအစား",
  "contacts.channelValueAria": "ဖုန်း သို့မဟုတ် လိပ်စာ",
  "contacts.channelValuePlaceholder": "09… သို့မဟုတ် name@mail.com",
  "contacts.addChannel": "လမ်းကြောင်း ထည့်မည်",
  "contacts.tagsHeading": "တက်ဂ်များ",
  "contacts.tagsEmpty": "တက်ဂ် မရှိသေးပါ။",
  "contacts.removeTagAria": "{tag} တက်ဂ် ဖယ်ရှားမည်",
  "contacts.newTagAria": "တက်ဂ် အသစ်",
  "contacts.newTagPlaceholder": "တက်ဂ် (ဥပမာ မိသားစု၊ VIP)",
  "contacts.addTag": "တက်ဂ် ထည့်မည်",
  "business.jobMissing":
    "ထို အလုပ် ဤ မြင်ကွင်းတွင် မရှိတော့ပါ — ပြောင်းလဲခြင်း သို့မဟုတ် ဖျက်ခြင်း ဖြစ်နိုင်သည်။",
  "business.payableMissing":
    "ထို ပေးရန်ကျန်ငွေ ဤ မြင်ကွင်းတွင် မရှိတော့ပါ — ပြောင်းလဲခြင်း သို့မဟုတ် ဖျက်ခြင်း ဖြစ်နိုင်သည်။",

  "onboarding.title": "Purple Memo မှ ကြိုဆိုပါသည်",
  "onboarding.intro": "ဤအက်ပ်က ဘာလုပ်နိုင်သည်၊ ဘာမလုပ်နိုင်သည်ကို အမြန်ရှင်းပြချက်။",
  "onboarding.pinTitle": "PIN ပြန်လည်ရယူမှုတွင် ကန့်သတ်ချက်များ ရှိသည်",
  "onboarding.pinBody":
    "PIN မေ့သွားပါက ပြန်လည်ရယူမှုသည် သင်သတ်မှတ်ထားသော လုံခြုံရေးမေးခွန်းအပေါ် မူတည်သည်။ ဒေတာများ ဆက်လက်ရှိနေစေမည့် master reset မရှိပါ။",
  "onboarding.keyTitle": "ဒေတာဘေ့စ်သော့ကို လုံခြုံစွာ သိမ်းထားပါ",
  "onboarding.keyBody":
    "ဆက်တင်များ → ကုဒ်ဖျက်သော့ ထုတ်ယူမှုသည် သီးခြားသော့ဖိုင်တစ်ခု ရေးသည်။ ၎င်းမရှိလျှင် အရန်သိမ်းဆည်းမှုဖြင့် မူလဒေတာဘေ့စ်ကို ဖွင့်၍ မရပါ။",
  "onboarding.backupTitle": "အရန်သိမ်းဆည်းမှုများသည် အရာအားလုံးကို အစားထိုးသည်",
  "onboarding.backupBody":
    "အရန်သိမ်းဆည်းမှု ပြန်လည်ရယူခြင်းသည် လက်ရှိဒေတာအားလုံးကို အစားထိုးမည်။ မသေချာပါက ဦးစွာ ထုတ်ယူပါ။",
  "onboarding.offlineTitle": "အော့ဖ်လိုင်း၊ ကန့်သတ်ချက်များနှင့်အတူ",
  "onboarding.offlineBody":
    "သတိပေးချက်များသည် Purple Memo ဖွင့်ထားပြီး လော့ခ်ဖွင့်ထားစဉ်တွင်သာ ပေါ်လာမည်။ ဆာဗာသို့ မည်သည့်အရာမျှ မထပ်တူပြုပါ။",
  "onboarding.dismiss": "နားလည်ပါပြီ",

  // Vault — mirrors the English block above key for key, including the
  // {min} / {date} slots (the catalogue test pins placeholder parity).
  "vault.title": "ကုဒ်ဝှက်ထားသော လျှို့ဝှက်သေတ္တာ",
  "vault.subtitle":
    "တစ်ခုချင်းစီကို AES-256-GCM ဖြင့် ကုဒ်ဖျက်ထားပြီး PBKDF2-SHA256 (600k iterations) ဖြင့် သော့များ ဆွဲထားသည်",
  "vault.itemsAria": "လျှို့ဝှက်သေတ္တာ အကြောင်းအရာများ",
  "vault.changePassword": "စကားဝှက် ပြောင်းမည်",
  "vault.lock": "သော့ခတ်မည်",
  "vault.unavailable":
    "လျှို့ဝှက်သေတ္တာကို ဖတ်၍ မရပါ — ရှိ/မရှိကို Purple Memo မသိရသေးပါ။ သင့်စကားဝှက်နှင့် လျှို့ဝှက်အချက်အလက်များ မပြောင်းလဲပါ။",
  "vault.setupHeading": "လျှို့ဝှက်သေတ္တာ စကားဝှက် သတ်မှတ်မည်",
  "vault.noRecovery":
    "ပြန်လည်ရယူ၍ မရပါ။ ဤစကားဝှက်ကို မေ့သွားပါက သင့်လျှို့ဝှက်အချက်အလက်များကို မည်သူမှ ပြန်လည်ရယူ၍ မရပါ — ဤစက်ပေါ်တွင်ပင် မရပါ။ ဆက်လက်မလုပ်မီ ၎င်းကို ဘေးကင်းရာတွင် သိမ်းဆည်းပါ။",
  "vault.passwordAtLeast": "စကားဝှက် (အနည်းဆုံး စာလုံး {min} လုံး)",
  "vault.confirmPassword": "စကားဝှက် အတည်ပြုမည်",
  "vault.settingUp": "သတ်မှတ်နေသည်…",
  "vault.setPassword": "စကားဝှက် သတ်မှတ်မည်",
  "vault.lockedHeading": "လျှို့ဝှက်သေတ္တာ သော့ခတ်ထားသည်",
  "vault.lockedSubtitle": "လျှို့ဝှက်အချက်အလက်များကို ဖွင့်ရန် သင့်လျှို့ဝှက်သေတ္တာစကားဝှက်ကို ထည့်ပါ။",
  "vault.password": "စကားဝှက်",
  "vault.unlocking": "ဖွင့်နေသည်…",
  "vault.unlock": "ဖွင့်မည်",
  "vault.changeHeading": "လျှို့ဝှက်သေတ္တာ စကားဝှက် ပြောင်းမည်",
  "vault.currentPassword": "လက်ရှိစကားဝှက်",
  "vault.newPassword": "စကားဝှက်အသစ်",
  "vault.confirmNewPassword": "စကားဝှက်အသစ် အတည်ပြုမည်",
  "vault.reencrypting": "ပြန်လည်ကုဒ်ဖျက်နေသည်…",
  "vault.storedSecrets": "သိမ်းဆည်းထားသော လျှို့ဝှက်များ",
  "vault.empty": "လျှို့ဝှက်သေတ္တာ ဗလာဖြစ်နေသည် — ထည့်ပါ။",
  "vault.updated": "အသစ်ပြင်ဆင်ခြင်း {date}",
  "vault.reveal": "ပြမည်",
  "vault.hide": "ကွယ်မည်",
  "vault.edit": "ပြင်မည်",
  "vault.deleteWhat": "လျှို့ဝှက်",
  "vault.editHeading": "လျှို့ဝှက် ပြင်ဆင်မည်",
  "vault.newHeading": "လျှို့ဝှက်အသစ်",
  "vault.titleField": "ခေါင်းစဉ်",
  "vault.secretField": "လျှို့ဝှက်",
  "vault.titlePlaceholder": "ဥပမာ အီးမေးလ်အကောင့်၊ Recovery seed",
  "vault.secretPlaceholder": "စကားဝှက်၊ မှတ်စု၊ recovery code…",
  "vault.save": "သိမ်းမည်",
  "vault.addSecret": "လျှို့ဝှက် ထည့်မည်",
  "vault.error.wrongPassword": "စကားဝှက် မှားနေသည် — မည်သည့်အရာမျှ မဖွင့်ရသေးပါ။",
  "vault.error.wrongItem": "ဤအကြောင်းအရာကို ဖွင့်၍ မရပါ — စကားဝှက် မှားနေသည်။",
  "vault.error.passwordShort": "စကားဝှက်သည် အနည်းဆုံး စာလုံး {min} လုံး ရှိရမည်။",
  "vault.error.noMatch": "စကားဝှက်များ မတူပါ။",
  "vault.error.newPasswordShort": "စကားဝှက်အသစ်သည် အနည်းဆုံး စာလုံး {min} လုံး ရှိရမည်။",
  "vault.error.newNoMatch": "စကားဝှက်အသစ်များ မတူပါ။",
  "vault.error.wrongCurrent": "လက်ရှိစကားဝှက် မှားနေသည် — မည်သည့်အရာမျှ မပြောင်းလဲပါ။",
};

const messages: Record<Locale, Partial<Record<MessageKey, string>>> = {
  en,
  my,
};

// -- Plurals ------------------------------------------------------------------

export interface PluralForms {
  one: string;
  other: string;
}

export const enPlurals = {
  "session.remindersDue": {
    one: "{count} reminder is due — open Purple Memo.",
    other: "{count} reminders are due — open Purple Memo.",
  },
  "search.results": {
    one: "{count} result",
    other: "{count} results",
  },
  "notes.wordCount": {
    one: "{count} word",
    other: "{count} words",
  },
  "dashboard.warrantiesSoon": {
    one: "{count} warranty expiring soon",
    other: "{count} warranties expiring soon",
  },
  "dashboard.itemsDue": {
    one: "{count} item due",
    other: "{count} items due",
  },
  "import.ready": {
    one: "{count} row ready to import",
    other: "{count} rows ready to import",
  },
  "import.failed": {
    one: "{count} row has errors",
    other: "{count} rows have errors",
  },
  "import.resultImported": {
    one: "{count} row imported",
    other: "{count} rows imported",
  },
  "import.resultSkipped": {
    one: "{count} row had errors and was skipped",
    other: "{count} rows had errors and were skipped",
  },
  "tasks.imported": {
    one: "{count} task imported",
    other: "{count} tasks imported",
  },
  "contacts.imported": {
    one: "{count} contact imported",
    other: "{count} contacts imported",
  },
} as const;

export type PluralKey = keyof typeof enPlurals;

export const myPlurals: Record<PluralKey, PluralForms> = {
  // Burmese does not inflect for number; both forms deliberately read the same.
  "session.remindersDue": {
    one: "သတိပေးချက် {count} ခု ရောက်နေသည် — Purple Memo ကို ဖွင့်ပါ။",
    other: "သတိပေးချက် {count} ခု ရောက်နေသည် — Purple Memo ကို ဖွင့်ပါ။",
  },
  "search.results": {
    one: "ရလဒ် {count} ခု",
    other: "ရလဒ် {count} ခု",
  },
  "notes.wordCount": {
    one: "စကားလုံး {count} လုံး",
    other: "စကားလုံး {count} လုံး",
  },
  "dashboard.warrantiesSoon": {
    one: "အာမခံ {count} ခု မကြာမီ သက်တမ်းကုန်မည်",
    other: "အာမခံ {count} ခု မကြာမီ သက်တမ်းကုန်မည်",
  },
  "dashboard.itemsDue": {
    one: "ရက်ချိန်းရောက် {count} ခု",
    other: "ရက်ချိန်း ရောက် {count} ခု",
  },
  "import.ready": {
    one: "တင်သွင်းရန် အသင့်ဖြစ်သော အတန်း {count} ခု",
    other: "တင်သွင်းရန် အသင့်ဖြစ်သော အတန်း {count} ခု",
  },
  "import.failed": {
    one: "အမှားရှိသော အတန်း {count} ခု",
    other: "အမှားရှိသော အတန်း {count} ခု",
  },
  "import.resultImported": {
    one: "တင်သွင်းပြီးသော အတန်း {count} ခု",
    other: "တင်သွင်းပြီးသော အတန်း {count} ခု",
  },
  "import.resultSkipped": {
    one: "အမှားရှိသဖြင့် ကျော်သွားသော အတန်း {count} ခု",
    other: "အမှားရှိသဖြင့် ကျော်သွားသော အတန်း {count} ခု",
  },
  "tasks.imported": {
    one: "လုပ်ငန်း {count} ခု တင်သွင်းပြီး",
    other: "လုပ်ငန်း {count} ခု တင်သွင်းပြီး",
  },
  "contacts.imported": {
    one: "ဆက်သွယ်ရန် {count} ခု တင်သွင်းပြီး",
    other: "ဆက်သွယ်ရန် {count} ခု တင်သွင်းပြီး",
  },
};

const plurals: Record<Locale, Partial<Record<PluralKey, PluralForms>>> = {
  en: enPlurals,
  my: myPlurals,
};

// -- Lookup -------------------------------------------------------------------

export type MessageParams = Record<string, string | number>;

/**
 * An Error that names a translation key instead of pre-rendering text, so the
 * UI can render it in the locale active when it is shown rather than the one
 * active when it was thrown.
 */
export interface MessageKeyError extends Error {
  readonly messageKey: MessageKey;
  readonly params: MessageParams;
}

export function isMessageKeyError(value: unknown): value is MessageKeyError {
  if (!(value instanceof Error)) return false;
  const record = value as unknown as Record<string, unknown>;
  return (
    typeof record.messageKey === "string" &&
    typeof record.params === "object" &&
    record.params !== null
  );
}

/** `development` throws on a missing key; `production` falls back to English. */
export type TranslationMode = "development" | "production";

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

/** Placeholder names used by a template, sorted, for parity tests. */
export function placeholdersIn(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name !== undefined) found.add(name);
  }
  return [...found].sort();
}

/**
 * Fill `{name}` slots. An unknown placeholder is left alone rather than
 * rendered as "undefined": a half-filled sentence still names what is missing.
 */
export function interpolate(template: string, params: MessageParams): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** Keys present in English but absent from `locale`, sorted. */
export function missingMessageKeys(locale: Locale): MessageKey[] {
  const catalogue = messages[locale];
  return (Object.keys(en) as MessageKey[]).filter(
    (key) => catalogue[key] === undefined,
  );
}

/**
 * The mode-aware lookup the suite can pin in both directions. Production never
 * throws — a release build with a forgotten key shows English, not a crash.
 */
export function translateFor(
  locale: Locale,
  key: MessageKey,
  params: MessageParams = {},
  mode: TranslationMode = "production",
): string {
  const own = messages[locale][key];
  if (own === undefined) {
    // Development is strict about the REQUESTED locale, not just about keys
    // that exist nowhere: a Burmese gap must be visible while translating, or
    // it ships as English and is never noticed.
    if (mode === "development") {
      throw new Error(`Missing message key: ${key} (${locale})`);
    }
    const fallback = messages.en[key];
    return fallback === undefined ? key : interpolate(fallback, params);
  }
  return interpolate(own, params);
}

/** The plural form for `count` in `locale`, with `{count}` already filled. */
export function translatePluralFor(
  locale: Locale,
  key: PluralKey,
  count: number,
  params: MessageParams = {},
  mode: TranslationMode = "production",
): string {
  const own = plurals[locale][key];
  if (own === undefined && mode === "development") {
    throw new Error(`Missing plural message key: ${key} (${locale})`);
  }
  // Release: the English plural is still readable, and a key with no plural
  // anywhere returns itself rather than a blank string.
  const forms = own ?? plurals.en[key];
  if (forms === undefined) return key;
  const category = new Intl.PluralRules(locale).select(count);
  const template = category === "one" ? forms.one : forms.other;
  return interpolate(template, { ...params, count });
}

/**
 * Vite replaces `import.meta.env` at build time. `node --test` imports this
 * module directly and has no `env`, so the cast keeps that path readable
 * without a bundler-only global.
 */
function buildMode(): TranslationMode {
  const meta = import.meta as ImportMeta & {
    readonly env?: { readonly DEV?: boolean };
  };
  return meta.env?.DEV === true ? "development" : "production";
}

export function translate(
  locale: Locale,
  key: MessageKey,
  params?: MessageParams,
): string {
  return translateFor(locale, key, params, buildMode());
}

export function translatePlural(
  locale: Locale,
  key: PluralKey,
  count: number,
  params?: MessageParams,
): string {
  return translatePluralFor(locale, key, count, params, buildMode());
}

// -- Current locale -----------------------------------------------------------

/**
 * The active locale, kept outside React so every early return in the shell
 * (booting, error, setup, locked) renders in the same language, and so the
 * reminder poll can read it without a provider above the lock screen.
 */
let currentLocale: Locale = detectInitialLocale();

/** `navigator.language` before the database opens; the stored setting wins after. */
export function detectInitialLocale(): Locale {
  const tag = typeof navigator === "undefined" ? undefined : navigator.language;
  return localeFromLanguageTag(tag);
}

export function getLocale(): Locale {
  return currentLocale;
}

const localeListeners = new Set<() => void>();

export function subscribeLocale(listener: () => void): () => void {
  localeListeners.add(listener);
  return () => {
    localeListeners.delete(listener);
  };
}

/** Switch the presentation language. Domain rows are never touched. */
export function setLocale(locale: Locale): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
  if (locale === currentLocale) return;
  currentLocale = locale;
  for (const listener of localeListeners) listener();
}
