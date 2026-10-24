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

## One-time setup

```bash
rustup component add clippy rustfmt
git config core.hooksPath .githooks       # the pre-push gate
npm run tauri -- signer generate -w .keys/updater.key
```

- The private key stays on this machine. `.keys/` is gitignored; it is never
  committed, never uploaded, and never put in a hosted secret store.
- The matching **public** key already sits in
  `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`. Replacing the keypair
  means replacing that value too — a mismatched pair fails signature
  verification on every user's machine.

## Per release

1. **Dependency re-check**: confirm every pinned version is still the max
   stable one (`npm outdated`; `cargo info <crate>@<major>`).
2. **Green local gate** — run the complete check locally:

   ```bash
   npm run verify        # hook + version checks, biome, token-lint, tsc, JS + Rust tests, clippy, fmt, build
   ```

3. **Bump the version in all three places** — they must agree:
   - `package.json` → `version`
   - `src-tauri/tauri.conf.json` → `version`
   - `src-tauri/Cargo.toml` → `[package] version`

   Tag the commit `v<version>` (the tag keeps the `v`; the manifest does not).
4. **Export the signing key** (a `.env` file does not work here):

   ```bash
   export TAURI_SIGNING_PRIVATE_KEY="$(cat .keys/updater.key)"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=''   # only if the key has one
   ```

   The variable holds the **key itself, not its path**. Tauri base64-decodes
   whatever is in it, so passing `.keys/updater.key` fails with
   `failed to decode base64 secret key: ... Invalid symbol 46` — 46 is the
   `.` of the path. PowerShell:

   ```powershell
   $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content .keys/updater.key -Raw).Trim()
   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
   ```

   Without the key the build still produces both installers, then fails at the
   end with `A public key has been found, but no private key` and writes **no
   `.sig` files** — so check for `bundle/nsis/*.exe.sig` before publishing.

5. **Build** (`bundle.createUpdaterArtifacts` is already `true`):

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
   pass to `--asset`, so the manifest URL always matches the uploaded asset.

   `tauri build` does **not** write `latest.json` — upstream only generates it
   inside the GitHub Action this project does not use.
6. **Generate the manifest** (validates the version, the signature and the
   asset URL before anything is uploaded):

   ```bash
   node scripts/make-latest-json.mjs \
     --version 0.2.0 \
     --asset "src-tauri/target/release/bundle/nsis/Purple Memo_0.2.0_x64-setup.exe" \
     --notes-file RELEASE_NOTES.md
   ```

   (The script URL-encodes the asset name, so a space in `Purple Memo` is fine.)

   Pick **one** installer format and stay with it: the `url` in the manifest
   and the uploaded asset must be the same file, and the `signature` must be
   the contents of *that* file's `.sig`.
7. **Publish** — with the GitHub CLI, or the web UI:

   ```bash
   gh release create v0.2.0 \
     --title "Purple Memo 0.2.0" \
     --notes-file RELEASE_NOTES.md \
     "src-tauri/target/release/bundle/nsis/Purple Memo_0.2.0_x64-setup.exe" \
     "src-tauri/target/release/bundle/nsis/Purple Memo_0.2.0_x64-setup.exe.sig" \
     latest.json
   ```

   Upload three assets: the installer, its `.sig`, and `latest.json`. Do not
   mark it a draft or a pre-release.
8. **Verify the update path on a real install**: keep the previous release
   installed, open **Settings → Updates → Check for updates**, install, and
   confirm the version changes after restart. A `tauri dev` build cannot
   self-update — only an installed release build can.

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
- **Signature mismatch** (wrong keypair, or a manifest paired with another
  build's `.sig`) fails at install time with `signature verification failed`.
- **Replacing assets after publishing** invalidates anything already cached on
  a user's machine — publish a new version instead.
- The `pubkey` in `tauri.conf.json` is the public half only; there is no
  signing secret in this repository and no hosted secret store.
- **Schema migrations are forward-only, and downgrading is unsupported.** The
  current schema is v5 (`inbox_items`, `links`, `trash_items`, and the v5
  unique `photo_refs` index plus the `reminders` due-index); an older
  binary opens a migrated database only to refuse it, by design. Release notes must say so, and
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
  paths in `commands.rs`, `share.rs` and `photos.rs` therefore serve dev and
  test builds, where unwinding happens — in a release build a poisoned mutex
  cannot be observed, because the app has already aborted.

## Factory reset

Settings → Danger zone → Factory reset removes every piece of
PurpleMemo-owned local state on this machine. The engine (`src-tauri/src/reset.rs`)
stops the LAN share and burns its consent token, closes the database
connection (after which every DB command fails closed), deletes the
SQLCipher database with its `-wal`/`-shm` siblings, the `photos/` tree, the
app-made safety copies under `backups/`, the three logs (`key-export.log`,
`share.log`, `boot-error.log`), and the database encryption key from the
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
