# Purple Memo 0.2.0

Purple Memo is a personal offline notebook and life/money manager for one
person — notes, journal, tasks and reminders, budget and business tracking,
contacts, and a photo library, in a single encrypted local database.

This release adds the Android companion and the local-network sync that ties it
to this desktop app. Pair once, and your records stay together.

## Upgrading

Existing installs update themselves: **Settings → Updates → Check for
updates**. Your data, photos and settings are carried over untouched — but read
*Scope and compatibility* below before you update, because the database upgrade
is one-way.

## Pair your phone

Open **Settings → Pairing** and show the QR code; the phone scans it and you
confirm the same short code on both screens. The two devices then find each
other on your local network and exchange a first copy of everything they hold.
The pairing key is per-install and stays on your machines.

## What moves between them

Notes and to-do lists (including task reminders), shopping lists and habits,
Budget, Business and Loans, and the Vault — the Vault arrives on the phone only
after you enter its password there. Deletes travel too, so a record removed on
one device is removed on the other, and conflicts are resolved field by field
rather than by overwriting a whole record. A record that loses a conflict is
kept in Trash on the losing side rather than discarded silently.

Everything goes over your own local network: nothing is uploaded to a server,
there is no account, and no cloud is involved.

## Reliability

Under the hood this release is mostly sync correctness and data-safety work:
byte-bounded pulls that never split a record, a refused oversized record named
instead of failing obscurely, tombstone and delete ordering that survives
interruption, honest acknowledgement of what a device actually applied, and a
new data line whenever a backup is restored so old writes are not replayed into
the restored database. Backups also no longer carry the app PIN.

## Scope and compatibility

- This GitHub release ships the **Windows desktop** build only. The Android
  companion app is distributed separately — there is no APK download here.
- Database migrations are forward-only: this version upgrades your database to
  schema v12 and **older versions cannot open it afterwards**. Reinstalling an
  older build does not roll your data back; to go back you must restore a
  backup taken before the upgrade.
- Backups restore rows and photos. The database encryption key is never part of
  a backup — export it separately from **Settings → Key export** and keep it
  somewhere safe.
