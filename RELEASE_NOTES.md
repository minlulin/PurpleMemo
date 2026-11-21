# Purple Memo 0.3.0

Purple Memo is a personal offline notebook and life/money manager for one
person — notes, journal, tasks and reminders, budget and business tracking,
contacts, and a photo library, in a single encrypted local database.

This release ships the Android companion beside the desktop build: the signed
APK is attached to this release, and the two devices sync directly over your
own local network.

## Install the phone app

`app-universal-release.apk` is for **arm64-v8a** phones running **Android 8.0
(API 26) or newer**. It is not on any app store: copy it to the phone and open
it, allowing "install unknown apps" for the file manager you use. Android
refuses an APK signed by a different key over an installed copy, so a phone
still carrying a debug build has to uninstall it first; installing over a
previous release keeps the phone's data.

The phone never contacts GitHub and has **no automatic updates** — a new
release is a new APK you install by hand. **Settings → Diagnostics** on the
phone names the version it is running.

## Sync with the desktop

To pair, open **Settings → Pairing** on the desktop, scan the QR code with the
phone (or paste the pairing string), and confirm the same short code on both
screens. The pairing key is per-install and stays on your machines.

The exchange itself is **manual and starts from the desktop**: the desktop
listens only while its Pairing panel is open with a live code, so a sync is
"open the panel, scan the code, tap *Sync now* on the phone". Both devices must
be on the same local network, and a VPN on the desktop's machine — Cloudflare
WARP, for instance — hides the address the phone dials, so pause it for pairing
and for syncing.

Notes and to-do lists (including task reminders), shopping lists and habits,
Budget, Business and Loans, and the Vault — the Vault arrives on the phone only
after you enter its password there. Deletes travel too, so a record removed on
one device is removed on the other, and conflicts are resolved field by field
rather than by overwriting a whole record. A record that loses a conflict is
kept in Trash on the device that held it rather than discarded silently —
visible on the desktop; the phone that ships with this release has no Trash
screen yet, so its sync result names how many of its edits were replaced.

Everything goes over your own local network: nothing is uploaded to a server,
there is no account, and no cloud is involved.

## Interface

The whole interface, desktop and phone, now reads from one catalogue in English
and Burmese. Budget, Business, Loans, Habits, Shopping, Gallery, Journal,
Memories and Exports were the last pages still showing English; the shared
month and weekday headings follow the language too.

## Fixes

- Converting a quick capture into a note or a task now gives the new record its
  uid and its sync operation, so it travels to the other device.
- Reloading the Vault no longer serves an item from a key cache a previous lock
  should have cleared.
- The Journal refuses an impossible date instead of storing it.
- A failure in the final sync acknowledgement reports the session's result
  instead of failing as a crash, so nothing already applied is reported lost.
- On Android, mail and phone links open in the matching app, and malformed
  input is refused with a reason rather than an exception.
- Indexes on the month-day, the wallet ledger and dated rows keep the Memories
  "On this day" list and the per-wallet figures from scanning whole tables.

## Scope and compatibility

- This release publishes the **Windows desktop build** and the **Android APK**.
  Linux and macOS build from source as best-effort only; no artifact is
  published for them.
- The desktop installs its own updates: **Settings → Updates → Check for
  updates**. The phone does not; see above.
- Database migrations are forward-only: this version upgrades your database to
  schema v12 and **older versions cannot open it afterwards**. Reinstalling an
  older build does not roll your data back; to go back you must restore a
  backup taken before the upgrade.
- Backups restore rows and photos. The database encryption key is never part of
  a backup — export it separately from **Settings → Key export** and keep it
  somewhere safe. If the operating system's credential store loses the key, the
  app refuses to open the database and offers **Restore exported key…**, which
  is why the exported file matters.
- The phone has no backup or export of its own: its records reach safety only
  by syncing to the desktop.
- Rolling the phone back is lossy. There is no in-app downgrade, so it means
  uninstalling — which removes the phone's records, its device-local reminders
  and its settings — then installing the older APK and pairing the fresh
  install to the desktop again. Take a desktop backup first.
