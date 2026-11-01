# Purple Memo 0.1.1

The first update to Purple Memo 0.1.0.

Purple Memo is a personal offline notebook and life/money manager for one
person — notes, journal, tasks and reminders, budget and business tracking,
contacts, and a photo library, in a single encrypted local database.
Desktop-only (Tauri), fully offline: no accounts, no sync, no cloud.

**Platform:** Windows 10/11 (x64). Linux and macOS build from source as
best-effort only and receive no signed artifacts.

## Upgrading

Existing 0.1.0 installs update themselves: **Settings → Updates → Check for
updates**. Your data, photos and settings are carried over untouched.

## What's new

- **CSV import for tasks and contacts.** Pick a spreadsheet, preview what will
  be written, and import only the rows you accept. Rejected rows are listed
  with the data row number that failed, so the file can be corrected and
  re-imported. A template with the exact expected columns downloads from the
  import dialog. Imports are bounded — an oversized file or row count is
  refused before anything is written, and a failure part-way through rolls the
  whole import back.
- **CSV export for tasks and contacts**, ready to open in a spreadsheet. The
  initial bundle was also split, so the app starts lighter.
- **A full-view reader for notes.** Notes open in a focused reading view, with
  `Ctrl+E` switching between reading and editing, and the split workspace
  layout reworked around it.
- **Dashboard and tray.** Tasks on the dashboard carry an urgency badge, the
  dashboard and habits roll over to the new day at midnight, and Purple Memo
  now lives in the system tray: closing the window can leave it running in the
  background, and that behaviour can be switched off in Settings.
- **Settings, simplified.** Settings is now labels and controls — the
  explanatory paragraphs are gone.
- **Hardening, applied in waves.** A full audit sweep covered the engine seam,
  the lock screen and session, PIN and vault crypto, backup and recovery,
  reset, search, notes, contacts, tasks, the vault, business pages, gallery,
  memories, loans, shopping, journal, inbox, habits, and the shared UI layer.
  The fixes include: unverifiable PIN hashes fail closed; reset, import and LAN
  share are coordinated by one lifecycle barrier; backups are validated before
  and after decryption; photo size ceilings are checked before decoding;
  markdown links preserve `tel:` while blocking dangerous schemes; Trash and
  Gallery agree on who owns a photo; and every money-submit handler refuses a
  second submit while one is in flight.
- **Database schema v6.** The v5 → v6 migration adds nine indexes — note
  browsing, photos by creation date, memories by memory date, habit logs,
  budget ledger by category and date (income and expense), jobs by shop,
  payables by paid state and due date, and shopping items by list and order —
  and replaces the notes full-text trigger, so pinning or archiving a note no
  longer rewrites its search row. Schema objects only: no rows are rewritten.

## Please read before installing

- **Your database key is not in your backup.** Backups (Settings → Backup)
  contain your data and photos, never the database key. The key lives in
  your operating system's credential store and is exported separately
  (Settings → Key export). Keep the exported key file somewhere safe and
  separate — a backup without its key cannot be opened.
- **No downgrades.** The database schema is forward-only (currently v6).
  An older version of Purple Memo cannot open a database a newer version
  has migrated, and installing an older version does not roll your data
  back. To return to an older version, restore a backup taken before the
  upgrade.
- **One instance per machine.** Purple Memo runs as a single instance; a
  second launch is turned away. This is deliberate — two copies must never
  contend for the same encrypted database.

## License

MIT — see the LICENSE file in the repository.
