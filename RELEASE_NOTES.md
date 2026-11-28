# Purple Memo 0.4.0

Purple Memo is a personal offline notebook and life/money manager for one
person — notes, journal, tasks and reminders, budget and business tracking,
contacts, and a photo library, in a single encrypted local database.

This release adds five more themes, fingerprint or face unlock on the phone, a
pairing that survives the panel closing, and a line in Settings that tells you
when you last backed up. Nothing about your data changes: this build runs **no
database migration**.

## Install the phone app

`app-universal-release.apk` is for **arm64-v8a** phones running **Android 8.0
(API 26) or newer**. It is not on any app store: copy it to the phone and open
it, allowing "install unknown apps" for the file manager you use. It is signed
with the same key as 0.3.0, so installing it over a previous release keeps the
phone's data. A phone still carrying a debug build has to uninstall it first —
Android refuses an APK signed by a different key.

The phone never contacts GitHub and has **no automatic updates** — a new
release is a new APK you install by hand. **Settings → Diagnostics** on the
phone names the version it is running.

The phone has **no backup or export of its own** — its safety net is the
desktop. Sync with the desktop before a factory reset: a reset loses the
phone's device-local reminders and settings outright.

## Five new themes

The appearance picker now offers seven: the **Dark** and **Light** you had,
plus **OLED** (true black for OLED panels), **Midnight**, **Forest**, **Sepia**
and **Clean**. Both the phone and the desktop offer all seven, and each machine
remembers its own choice.

Every text pair in all seven themes is checked against WCAG AA, and focus rings
against 3:1, by a test that fails the build — a new palette cannot ship with a
label you cannot read, and a later tweak to a colour cannot quietly dim one.

## Fingerprint or face unlock on the phone

A phone with an enrolled fingerprint or face can now open Purple Memo without
typing the PIN.

- **Off by default.** Turn it on in the phone's Settings → *Fingerprint or face
  unlock*, which asks for your current PIN first. If the phone has no sensor,
  nothing enrolled, or no PIN set, the row says which of those it is rather
  than offering a switch that cannot work.
- **The PIN is still the root unlock.** The prompt sits beside the PIN on the
  lock screen; "Use PIN" is always there, cancelling it is silent (you chose
  the PIN, and that is a valid choice), and the forgot-PIN screen never offers
  it. A lockout or a refused fingerprint says so and leaves the PIN in charge.
- It is a setting about *this handset's sensor*, so it never travels in a
  backup and a restore cannot switch it on for another phone.

## Sync: a pairing that lasts

In 0.3.0 every sync needed a fresh code from the desktop. Now the phone
remembers the address of the desktop it paired with, and the desktop keeps a
window up that only that pinned phone can use — tap **Sync now** on the phone
and it connects. Nothing about the trust changes: the pairing key, not the
address, is what proves the desktop, so a wrong or moved address can only fail
to connect.

### What stays listening, and what that means

**While Purple Memo is running, the desktop keeps its pairing port bound on
your local network.** That is how the phone syncs without a code, and it is
on by default — the setting is **Settings → Paired phone → Let my paired phone
stay connected**.

- The port answers only envelopes sealed under your pairing key. A desktop with
  no paired phone refuses everything; the standing window has no code to hand
  out; a phone you removed is refused before its key is looked at.
- It stays bound while the notebook is **locked**, while the app is in the
  background, and while the window is hidden in the tray — a locked notebook is
  still a radio. Anything else on the network can see that a port is open, and
  nothing else can read or write.
- Turn the switch **off** and the desktop goes back to listening only while a
  pairing code is on screen. A factory reset closes the port either way.

**If you are upgrading, this arrives switched on.** The setting did not exist
in 0.3.0, and a missing setting means on, so 0.4.0 starts holding the port open
as soon as it runs. If you would rather the desktop listen only while you are
pairing, open Settings → Paired phone and turn it off — it takes effect
immediately, with no restart.

Also in this section:

- **One phone at a time.** Pairing a second phone is refused until you
  **Forget this phone**; the phone's own **Forget this desktop** does the same
  from the other side. Both remove the pin, the remembered address and the
  replay records in one step, and tell you how many undelivered changes they
  would drop before they drop them.
- **The desktop's replay floor survives a restart.** The highest counter it has
  accepted from your phone is kept on disk per pairing, so a restart neither
  re-opens an older envelope nor refuses the phone's next one — a second sync
  used to fail on exactly that. This is the desktop's side of the check: the
  phone's own guard for incoming envelopes lives in memory and starts fresh
  when the phone app restarts.
- **Still local.** No relay, no account, no cloud, and every exchange still
  starts with a tap on the phone — this changes how long the desktop listens,
  not who starts a sync.

## Backups: knowing when you last made one

**Settings → Backup** now records the last successful export this machine made
and shows how long ago it was, with the rows and photos it holds. Until the
first one it says so plainly, and once a backup is more than 30 days old the
line turns into a warning — the point of a backup is that it is recent.

The record describes files on *this* machine, so it is not carried in an
archive and a restore never inherits another computer's timestamp.

The archive itself is unchanged: every data table and photo into one `.zip`,
or a password-protected `.pmbk` (PBKDF2-SHA256 600,000 iterations,
AES-256-GCM). The 112 MiB photo allowance and the 128 MiB archive cap still
apply, and the database key is still **not** in the archive — export it
separately from **Settings → Key export**.

## Upgrades tested against real old databases

The test suite now carries three databases written by released versions —
0.1.0, 0.1.1 and 0.2.0 — and migrates a copy of each on every run of the local
gate. So the upgrade path from those releases is exercised against the file
that release actually produced, not a hand-built approximation, and a test
fails if the committed fixtures are ever modified instead of copied.

## Fixes

- A second sync no longer fails after Purple Memo restarts: the desktop keeps
  its accepted-counter floor on disk, so it does not refuse the phone's next
  envelope.
- Sync and pairing failures report the reason instead of a bare
  `[object Object]`, and a refusal names the setting or the screen that fixes
  it.
- Two Burmese theme labels corrected.
- Pairing codes and key fingerprints are grouped for reading aloud and for
  comparing two screens.

## Scope and compatibility

- This release publishes the **Windows desktop build** and the **Android APK**.
  Linux and macOS build from source as best-effort only; no artifact is
  published for them.
- The desktop installs its own updates: **Settings → Updates → Check for
  updates**. The phone does not; see above.
- **This release keeps schema v14.** 0.4.0 runs no migration, so a database
  0.3.0 already upgraded opens exactly as it is. Migrations remain
  forward-only: a build older than the database's version refuses to open it,
  and reinstalling an older version does not roll your data back. To go back,
  restore a backup taken before the upgrade.
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
