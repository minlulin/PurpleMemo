# Purple Memo 0.1.0

First public release.

Purple Memo is a personal offline notebook and life/money manager for one
person — notes, journal, tasks and reminders, budget and business tracking,
contacts, and a photo library, in a single encrypted local database.
Desktop-only (Tauri), fully offline: no accounts, no sync, no cloud.

**Platform:** Windows 10/11 (x64). Linux and macOS build from source as
best-effort only and receive no signed artifacts.

## Please read before installing

- **Your database key is not in your backup.** Backups (Settings → Backup)
  contain your data and photos, never the database key. The key lives in
  your operating system's credential store and is exported separately
  (Settings → Key export). Keep the exported key file somewhere safe and
  separate — a backup without its key cannot be opened.
- **If the key is ever lost from the credential store** (Windows profile
  migration, OS reinstall), the app refuses to start rather than overwrite
  your data, and the failure dialog offers **Restore exported key…** — pick
  the exported key file and the app proves it opens your database before
  saving it.
- **No downgrades.** The database schema is forward-only (currently v5).
  An older version of Purple Memo cannot open a database a newer version
  has migrated, and installing an older version does not roll your data
  back. To return to an older version, restore a backup taken before the
  upgrade.
- **One instance per machine.** Purple Memo runs as a single instance; a
  second launch is turned away. This is deliberate — two copies must never
  contend for the same encrypted database.
- **Trash is recoverable deletion, not secure erasure.** Deleted notes,
  tasks, contacts, memories and journal entries wait in Trash until you
  empty it; permanent deletion removes the app's references and eligible
  photo files, but copies in OS-level backups are outside the app's reach.
- **Password-protected backups (.pmbk) have no password recovery.** A lost
  backup password means that archive cannot be opened.
- **LAN share is off by default.** When you start it, it serves a read-only,
  encrypted snapshot to browsers on your own network — manual and local,
  never a sync and never a cloud.

## License

MIT — see the LICENSE file in the repository.
