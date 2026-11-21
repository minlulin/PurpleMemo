# Cutting a release — by hand

Purple Memo ships in-app updates through GitHub Releases. Verification and
artifact production are intentionally local: this project does not use hosted
CI or a GitHub Actions release workflow. The local gate (`npm run verify`)
must be green before a release is prepared.

The app polls:

```
https://github.com/minlulin/PurpleMemo/releases/latest/download/latest.json
```

`releases/latest` means the newest **published, non-draft, non-prerelease**
release — a draft or a pre-release is invisible to the updater.

## Supported platforms

Windows 10/11 (x64), for every published artifact. Linux and macOS build from
source as best-effort only: they are not release-tested and receive no signed
artifacts.

Since 0.3.0 a release also publishes the **Android APK** (`arm64-v8a`, Android
8.0 / API 26 and up). It is sideloaded and has no updater, so a new APK is a
manual reinstall over the old one — same signing key, higher `versionCode`;
`docs/ANDROID_DISTRIBUTION.md` §5 is the whole path.

## One-time setup

```bash
rustup component add clippy rustfmt
git config core.hooksPath .githooks       # the pre-push gate
```

The keypair is not part of this step: it already exists, and it is never
regenerated — see [Signing key custody](#signing-key-custody).

- The private key stays on this machine. `.keys/` is gitignored; it is never
  committed, never uploaded, and never put in a hosted secret store.
- The matching **public** key already sits in
  `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`, key id
  `1F508CEF1FD1C297`. Every installed copy verifies updates against the pubkey
  compiled into its own binary, which is why that value is not replaceable while
  installs in the field exist.

## Signing key custody

The updater accepts an update if and only if it is signed by the key whose
public half is in `tauri.conf.json` → `plugins.updater.pubkey`, with
`requireSignedVersion: true` binding the signature to the version. That one file
is the project's entire update supply chain: whoever can sign with it can ship a
build that every install accepts and runs.

The position, decided by the owner on 2026-11-16:

- **The trusted keypair is passwordless, and that is the accepted state.** It is
  key id `1F508CEF1FD1C297`. (The comment line in `tauri.conf.json` prints
  `1F508CEF1FD5C297`; a minisign comment is untrusted metadata and that one
  carries a one-nibble typo — the key bytes are what every install verifies.) No
  property of the app depends on this key having a password, and the gate does
  not ask for one.
- **A password is not an available option on this pair.** The pinned Tauri
  signer has only `generate` and `sign`: it cannot re-encrypt an existing key.
  Adding a password therefore means a *new pair*, and a new pair cannot sign for
  installs in the field, whose binaries verify against the pubkey they were built
  with. The choice is this passwordless pair or broken updates; the owner chose
  this pair.
- **Custody is the protection.** The private half stays on the owner's PC, in
  `.keys/` (gitignored). It is never committed, never copied to another machine,
  never placed in a synced or shared folder, never attached to a support bundle
  or a chat, and never regenerated. Because the pair cannot be replaced without
  breaking every installed copy, custody is the whole of the protection rather
  than a first layer of it.
- **The gate checks the property that matters.** `npm run check:signing-key`
  reads `plugins.updater.pubkey`, signs a throwaway file in a temp directory with
  an empty password, and **fails** when the key that signs is not that pair — or
  when `.keys/updater.key.pub` is present and names another key. A swapped or
  regenerated key at the release path would pass every other gate step and break
  only at install time, which is the failure this check exists for. It
  **reports** the password state — passwordless by decision, or refusing an empty
  password — and never blocks on it, and it skips cleanly where there is no key
  to check.

## Per release

1. **Dependency re-check**: confirm every pinned version is still the max
   stable one (`npm outdated`; `cargo info <crate>@<major>`).
2. **Green local gate** — run the complete check locally:

   ```bash
   npm run verify        # hook + signing-key + version + android checks, biome, token-lint, dead code, tsc, JS + Rust tests, clippy, fmt, build
   ```

3. **Bump the version in all three places** — they must agree:
   - `package.json` → `version`
   - `src-tauri/tauri.conf.json` → `version`
   - `src-tauri/Cargo.toml` → `[package] version`

   Tag the commit `v<version>` (the tag keeps the `v`; the manifest does not).
4. **Build and check the Android APK, then run the full gate** — the bump above
   makes the gate red until this step is done, by design: `check-android-apk`
   reads the artefact and the generated `app/tauri.properties` as well as
   `package.json` (`docs/ANDROID_DISTRIBUTION.md` §3). Build it in the
   environment `docs/ANDROID_TOOLCHAIN.md` pins, which also regenerates that
   properties file:

   ```bash
   npx tauri android build --apk --target aarch64
   npm run check:android-apk
   ```

   Its output is the APK's hand-off record: the signer DN, the certificate
   SHA-256, `arm64-v8a only`, `versionCode`/`versionName`, the undefined
   EVP/CRYPTO/OPENSSL symbol count and the APK's own SHA-256. Keep that block
   beside `git rev-parse HEAD` and paste it into the release body — it is the
   only evidence that the file handed over is the file checked.

   The gate also compiles the Android target and pins the manifest's
   permissions (`docs/ANDROID_DISTRIBUTION.md` §3), so a break only the Android
   target can see fails here rather than after the artefact is built.

   Then run the full gate, tag the commit and push — the pre-push hook runs it
   once more.
5. **Export the signing key** (a `.env` file does not work here):

   ```bash
   export TAURI_SIGNING_PRIVATE_KEY="$(cat .keys/updater.key)"
   ```

   The variable holds the **key itself, not its path**. Tauri base64-decodes
   whatever is in it, so passing `.keys/updater.key` fails with
   `failed to decode base64 secret key: ... Invalid symbol 46` — 46 is the
   `.` of the path. PowerShell:

   ```powershell
   $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content .keys/updater.key -Raw).Trim()
   ```

   No password variable is set or typed: the trusted pair is passwordless by the
   owner's decision (see [Signing key custody](#signing-key-custody)), so there is
   no password to remember — or to lose — on release day. What protects this step
   is the gate's proof that `.keys/updater.key` is the pair the shipped pubkey
   names.

   Without the key the build still produces both installers, then fails at the
   end with `A public key has been found, but no private key` and writes **no
   `.sig` files** — so check for `bundle/nsis/*.exe.sig` before publishing.

6. **Build** (`bundle.createUpdaterArtifacts` is already `true`):

   ```bash
   npm run tauri build
   ```

   Outputs, on Windows — `<productName>` is `Purple Memo` as configured in
   `tauri.conf.json`, so read the real file names off disk rather than
   assuming them (`bundle.targets` is `all`, so both formats are built):

   ```
   src-tauri/target/release/bundle/nsis/<productName>_<version>_x64-setup.exe
   src-tauri/target/release/bundle/nsis/<productName>_<version>_x64-setup.exe.sig
   src-tauri/target/release/bundle/msi/<productName>_<version>_x64_en-US.msi
   src-tauri/target/release/bundle/msi/<productName>_<version>_x64_en-US.msi.sig
   ```

   `scripts/make-latest-json.mjs` derives the asset name from the file you
   pass to `--asset` and rewrites the spaces GitHub rewrites, so the manifest
   URL matches the asset that is actually stored (see the space gotcha below).

   `tauri build` does **not** write `latest.json` — upstream only generates it
   inside the GitHub Action this project does not use.
7. **Generate the manifest** (validates the version, the signature and the
   asset URL before anything is uploaded):

   ```bash
   node scripts/make-latest-json.mjs \
     --version 0.2.0 \
     --asset "src-tauri/target/release/bundle/nsis/Purple Memo_0.2.0_x64-setup.exe" \
     --notes-file RELEASE_NOTES.md
   ```

   It writes `latest.json` **next to the installer** it describes — inside
   `target/`, which git ignores — and prints the path. The manifest is a release
   artifact, not source (audit A7): it carries a signature and a timestamp, and
   the repo used to hold a tracked copy, which was a second manifest with the
   same name as the one clients fetch and no check that the two agreed.
   `.gitignore` now covers `/latest.json`, so an accidental `--out latest.json`
   cannot be committed either.

   The `Purple Memo` space is handled for you: GitHub stores it as a dot, and
   the script builds the URL from that stored name.

   Pick **one** installer format and stay with it: the `url` in the manifest
   and the uploaded asset must be the same file, and the `signature` must be
   the contents of *that* file's `.sig`.
8. **Publish** — with the GitHub CLI, or the web UI:

   ```bash
   gh release create v0.2.0 \
     --title "Purple Memo 0.2.0" \
     --notes-file RELEASE_NOTES.md \
     "src-tauri/target/release/bundle/nsis/Purple Memo_0.2.0_x64-setup.exe" \
     "src-tauri/target/release/bundle/nsis/Purple Memo_0.2.0_x64-setup.exe.sig" \
     "src-tauri/target/release/bundle/nsis/latest.json" \
     "src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk"
   ```

   Upload four assets: the installer, its `.sig`, `latest.json`, and the APK.
   The APK's name has no spaces, so GitHub stores it as
   `app-universal-release.apk`, and no manifest points at it. Do not mark the
   release a draft or a pre-release.
9. **Verify the update path on a real install**: keep the previous release
   installed, open **Settings → Updates → Check for updates**, install, and
   confirm the version changes after restart. A `tauri dev` build cannot
   self-update — only an installed release build can.

   The phone has no updater, so its half is a reinstall over the old one. A
   build already on the phone that is signed by a **different** key (a debug
   build, for instance) must be uninstalled first — Android refuses the upgrade
   with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`:

   ```bash
   adb -s 4c61bf7a install -r app-universal-release.apk
   adb -s 4c61bf7a shell dumpsys package com.minlulin.purplememo | grep versionName
   ```

## Gotchas that have bitten this project

- **The signature is the file's *contents*.** A path or URL in the manifest's
  `signature` field is rejected; `scripts/make-latest-json.mjs` reads it for you.
- **The signature must carry the version.** `tauri.conf.json` sets the
  updater's `requireSignedVersion: true`, so every artifact's minisign
  trusted comment must carry the version it was signed for. `npm run tauri
  build` does that automatically with the pinned CLI — but `tauri signer
  sign` does **not** unless `--app-version` is passed (the CLI warns when it
  is omitted). Anyone signing by hand — or re-signing an artifact, which the
  updater plugin's own docs describe as the reason to re-publish rather than
  re-sign — will produce a build every client rejects with a
  signature-verification error. Use `tauri build`, or pass `--app-version`
  explicitly.
- **Version mismatch**: `latest.json` version, the tag and the app version must
  all agree, or the updater either ignores the release or loops offering an
  update the user already has.
- **A bumped version makes the APK check fail until the APK is rebuilt.** That
  is the check working, not a broken gate: `check-android-apk` reads
  `app/tauri.properties` and the artefact beside `package.json`, so an older APK
  beside a newer `package.json` is exactly the stale-file case it refuses, on
  every `npm run verify` run on this machine. Rebuild (step 4) instead of
  deleting the artefact or the check — with no APK at the default path the step
  skips, which proves nothing about what gets handed over.
- **Signature mismatch** (wrong keypair, or a manifest paired with another
  build's `.sig`) fails at install time with `signature verification failed`.
- **GitHub rewrites spaces in asset names, and the manifest must agree.**
  Uploading `Purple Memo_0.1.1_x64-setup.exe` stores it as
  `Purple.Memo_0.1.1_x64-setup.exe`; the API refuses to rename it back to the
  spaced form. A manifest URL built from the on-disk name therefore 404s, the
  updater has nothing to download, and the failure is silent from the app's
  side. v0.1.0 and v0.1.1 both shipped that broken URL before it was caught.
  Before trusting a release, probe the manifest's own `url`:

  ```bash
  curl -sSL https://github.com/minlulin/PurpleMemo/releases/latest/download/latest.json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).platforms["windows-x86_64"].url))'
  ```

  and then `curl -sIL "<that url>"` — it must be 200/206, never 404.
- **Replacing assets after publishing** invalidates anything already cached on
  a user's machine — publish a new version instead. (Correcting a wrong
  `latest.json` is the exception: it is the only way to fix a release whose
  manifest points at a URL that does not exist.)
- The `pubkey` in `tauri.conf.json` is the public half only; there is no
  signing secret in this repository and no hosted secret store.
- **Schema migrations are forward-only, and downgrading is unsupported.** The
  current schema is **v12**: 40 regular tables plus the `notes_fts` FTS5 table
  (its `_data`/`_idx`/`_docsize`/`_config` shadow tables are FTS internals and
  do not count), as `schema.rs`'s module header and `BASELINE_SQL` state. Nine
  of the 40 are device-local sync storage — `sync_state`, `sync_outbox`,
  `sync_outbox_delivery`, `sync_tombstones`, `sync_tombstone_acks`,
  `sync_peers`, `sync_row_stamps`, `sync_uid_aliases`,
  `sync_tombstone_gc_log`. The v9–v12 steps, all device-local except v10:
  v9 adds `sync_row_stamps` (the §4.2 stamp of the value each row currently
  holds, backfilled at `migration-8-9` with whatever counter the database has,
  since before v9 there is no per-row history); v10 **rebuilds** `trash_items`
  to widen its `entity_type` CHECK with `shopping_list`/`shopping_item`, so a
  Shopping conflict loser has somewhere to land (a rebuild, not an in-place
  change — SQLite cannot widen a CHECK — and nothing else about the row shape,
  ids or timestamps changes); v11 adds `sync_uid_aliases` (the uid a same-name
  fold retired, so an op queued under it still resolves to the winner); v12
  adds `sync_tombstone_gc_log` (the delete a GC pruned, so a stale create at or
  below that counter cannot resurrect a row the user deleted). Earlier steps:
  v8 the six original `sync_*` tables of docs/ANDROID_SYNC_PROTOCOL.md —
  outbox, tombstones, peers, cursors/device identity — plus a nullable
  `reminders.created_by_device_id`; v7 the cross-device `uid` columns; v6 the
  hot-path index set; v5 the `photo_refs`/`reminders` indexes; v4
  `inbox_items`, `links`, `trash_items`. An older binary opens a migrated
  database only to refuse it, by design. Every table added after v8 is one of
  the nine `sync_*` tables, so no migration past v8 has changed the backup
  payload (still v4). The `sync_*` tables are
  device-local and deliberately absent from `BACKUP_TABLES` (§10.3), so a
  schema bump there changes no backup payload version. Release notes must say so, and
  must not imply that reinstalling an older version rolls the data back — the
  database file is untouched, but nothing older than the schema version can open
  it. A user who wants to go back has to restore a backup taken before the
  upgrade. Adding a version means three edits in `src-tauri/src/schema.rs` plus
  `db::migration_step`: bump `SCHEMA_VERSION`, add `MIGRATION_N_N+1` (and the
  same change in `BASELINE_SQL`, since a fresh install lands on the current
  version in one step), then map it in `migration_step`. The step list is
  asserted to cover every gap, so a forgotten entry fails `cargo test`.
- **A new backed-up table is also a backup payload bump.** The current payload
  is v4; `BACKUP_FORMAT_VERSION` and `BACKUP_TABLES` in `src/lib/backup.ts` move
  together, and older formats normalize later tables to empty arrays. A v1–v3
  archive imported by v4 gains `trash_items: []` where it did not exist.
  Encryption is *not* a payload bump: that is the container version.
- **Trash is recoverable deletion, not forensic erasure.** Notes, tasks,
  contacts, memories, and journal entries move to Trash. Permanent deletion
  removes local app references and eligible unshared photo files, but OS backups
  may retain copies. Other delete flows remain separately confirmed and are not
  described as recoverable.
- **The database key is not part of a backup, and must never become one.** A
  backup restores rows and photos; the SQLCipher key stays in the OS
  credential store and is exported separately (Settings → Key export). Release
  notes should say so plainly, because "I have a backup" reads as "I can get
  back in" and it is only true when the matching key file exists too. Never add
  the key to the archive, to an export path, or to a diagnostic bundle.
- **Losing the credential-store entry is recoverable with the exported key
  file**. When the database file exists but the OS credential
  store holds no key — Windows profile migration, OS reinstall,
  credential-store corruption — boot refuses (it never mints a key over
  existing data) and the failure dialog offers **Restore exported key…**.
  Pick the `.txt` file from Settings → Key export (64 hex characters plus a
  newline). The app trims and validates the file, then *proves the key opens
  the database* (the SQLCipher `sqlite_master` probe) **before** writing it
  into the credential store; only after that does it record a
  `key-export.log` audit line (never the key itself) and continue into a
  normal boot. A cancelled picker, a malformed file, or a wrong key restores
  *nothing* — the credential store stays untouched and the dialog falls back
  to Retry/Quit, so another attempt (or Quit) always remains available.
  Release notes for any build containing this path should say the recovery
  exists, because the refusal message now names it.
- **Backups hold at most 112 MiB of photos (128 MiB archive cap)** — the photo
  budget is `MAX_EXPORT_PHOTO_BYTES` in `src/lib/backup.ts`: the 128 MiB
  `MAX_BACKUP_ARCHIVE_BYTES` less a 16 MiB allowance for the manifest and the
  zip's own overhead. That cap was lowered from 256 MiB when the
  password-protected container was added, because a whole-buffer AES-GCM
  export measured ~1.26 GB of process RSS at 256 MiB on the reference
  machine. Changing it means re-measuring with
  `node --expose-gc scripts/measure-backup-limits.mjs <MiB> --rows 100000` and
  re-recording the approved limits here.
- **The encrypted backup container is versioned separately from the backup
  payload.** `PURPLEBK` v1 is fixed (magic, container version, KDF id, cipher
  id, iterations, salt, IV, then AES-GCM with a 16-byte tag). Changing any of
  those fields — including the 600,000 iterations — requires a new container
  version; an unknown version fails closed. Do **not** bump
  `BACKUP_FORMAT_VERSION` for encryption: it versions the zip payload inside.
- **One instance per machine, and that guarantee is the plugin's.** The
  second-launch refusal in `lib.rs` is delegated wholly to
  `tauri-plugin-single-instance`, registered first so a second launch is turned
  away before `setup` and before `boot`. This is stated in the release notes on
  purpose (review P3-4): it is the only thing preventing two copies from racing
  for the database key and the keyring. If the plugin is ever removed or moved
  after `.setup(`, that guarantee is silently gone — nothing in the code would
  fail, and two copies would contend for the same encrypted database. If you
  reorder plugin registration, verify the ordering still holds (it is pinned
  by a source test in `lib.rs`).
- **Release builds abort on panic** (`panic = "abort"` in the release
  profile): the process dies instead of unwinding. The mutex poison-recovery
  paths in `commands.rs` and `photos.rs` therefore serve dev and
  test builds, where unwinding happens — in a release build a poisoned mutex
  cannot be observed, because the app has already aborted.

## Factory reset

Settings → Danger zone → Factory reset removes every piece of
PurpleMemo-owned local state on this machine. The engine (`src-tauri/src/reset.rs`)
stops the pairing listener, closes the database
connection (after which every DB command fails closed), deletes the
SQLCipher database with its `-wal`/`-shm` siblings, the `photos/` tree, the
app-made safety copies under `backups/`, the three logs (`key-export.log`,
`share.log` — the removed LAN share's leftover, `boot-error.log`), and the
database encryption key from the
Windows credential store last. The UI reports "reset complete" only when
every component was removed or already absent; a partial run lists exactly
what was left and offers a retry (the engine is safe to re-run).

- **Ordinary deletion, not forensic erasure.** The reset deletes files and a
  keyring entry; it does not wipe disk sectors, and file-recovery tools may
  still recover remnants of deleted photos and database pages.
- **OS-level backups may retain copies.** Windows backup, File History, or a
  disk image taken before the reset can keep copies of the database, photos,
  or an exported key file. Those copies are outside the app's reach — the
  reset deletes what Purple Memo owns and nothing else — so delete them
  separately if they must go too.
- **A blocked reset never restarts the app and never claims success.** Only a
  fully complete reset leads to the Restart button; after a partial reset the
  user retries, or closes the window and starts the app again — the next
  launch opens with whatever remains, or into first-run setup if the database
  is gone.
- The database key is deleted last and is never part of a backup (see the key
  note above), so a complete reset ends in a genuine first run: a fresh key,
  a fresh database, and a new PIN to set.

## Renderer trust boundary (accepted risk)

`db_key_save`, `backup_save_file`, `export_save_file` and the pre-import
`backup_safety_copy` all write files. The first three take the destination from
the webview; in normal use that string came from the native save dialog, but the
commands cannot prove it did. A renderer that could call `invoke` freely could
ask Rust to write the master key to a path of its choosing, or overwrite any
file the app's user can write.

That is **accepted**, and the acceptance rests on facts the release checklist
re-checks rather than on the dialog:

- The renderer is this repository's own bundle, served from `tauri://localhost`,
  under the CSP in `tauri.conf.json` (`script-src 'self'`, `object-src 'none'`,
  no remote script origin).
- The UI loads no remote content. Markdown renders to React elements, not HTML;
  `dangerouslySetInnerHTML` and `eval` do not appear in `src/`.
- The opener capability is scoped to `mailto`/`tel`/`http`/`https`.
- A renderer that is already executing arbitrary code can read every row the app
  can read — the data driver is the renderer's. The extra power a forged path
  buys is "write one file" and "exfiltrate the key through it", not "read the
  database".

The key export is the sharpest case: Rust reads the key and writes it, and the
key never crosses IPC, so the *bytes* cannot be read back. A forged destination
still puts the key file somewhere the attacker chose; that is the residual risk.

What would revoke this acceptance: any remote origin in `script-src`, any
`dangerouslySetInnerHTML`, a webview plugin, or a second renderer origin. If one
of those lands, these commands need dialog-issued path tokens (a single-use
token minted by a Rust-side dialog helper) instead. Comments in `db.rs`,
`file_write.rs` and `commands.rs` say the dialog "constrains" the path — read
that as "the dialog is where it comes from"; this section is the real guarantee.

The pre-import safety copy is deliberately *not* on this list in the same way: it
composes its own destination under app-data from a sanitized label, so there is
no caller-supplied path in it at all.
