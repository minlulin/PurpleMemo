# Purple Memo

Personal offline notebook and life/money manager — a desktop app (Tauri)
with an Android companion, fully offline, encrypted local database.

One person, by design — no accounts, no cloud. The phone and the desktop
sync directly with each other over the same local network; nothing transits
a server.

Built and released by hand: [Development](#development) below covers the local
toolchain, and [`docs/RELEASE.md`](docs/RELEASE.md) is the release procedure.

## Platforms

Windows 10/11 (x64) is the supported platform: it is what is built, signed,
released and validated. Linux and macOS are best-effort — the codebase keeps
its env fallbacks portable (`APPDATA`, `HOME`, `XDG_DATA_HOME`), but nothing
is release-tested there and no artifact is published for them. An Android
companion (arm64-v8a, Android 8.0 and up) is in development alongside the
desktop app — see `docs/ANDROID_DESIGN.md`.

## Backups

Settings → Backup exports every data table and the photo library into one
archive, saved wherever you choose. Not literally *every* table: the search
index is rebuilt from your notes on restore, and this installation's own
bookkeeping — the app PIN, its security question, and the sync state (device
identity, outbox, cursors, tombstones) — stays behind, because it describes
this machine rather than your data.

- **Unencrypted** (`.zip`) is the default and has not changed.
- **Password-protected** (`.pmbk`) seals that archive in a versioned
  container: PBKDF2-SHA256 at 600,000 iterations, AES-256-GCM, a fresh salt
  and IV per export, and an authenticated header. A `.pmbk` file cannot be read
  without its password, there is no password recovery, and a wrong password,
  a modified header or a damaged file is refused without touching your data.
- One archive holds at most 112 MiB of photos — the 128 MiB total includes a
  16 MiB allowance for the manifest and the zip's own overhead. A larger photo
  library is refused at export with the size it needs rather than attempting
  the export.

Two things the archive is not:

- **It is not the database key.** The key lives in your operating system's
  credential store and is exported separately (Settings → Key export). A backup
  restored onto a machine that has never held this database's key cannot be
  opened by that key — keep the key file somewhere safe and separate.
- **It is not protected from the machine it sits on.** A password protects the
  file; anything else that can read the drive, the sync folder, or the USB
  stick can still copy it. Encrypt the volume, and keep removable media
  physically safe.

## Exports

- The **Exports page** writes a readable ZIP of Markdown, CSV and vCard files
  — see [`docs/EXPORTS.md`](docs/EXPORTS.md) for the exact field mapping.

Device-to-device sync is **pairing**, not a share: the phone pairs with the
desktop over the local network and exchanges changes in both directions (see
[`docs/ANDROID_SYNC_PROTOCOL.md`](docs/ANDROID_SYNC_PROTOCOL.md)). The old
read-only LAN share was removed on 2026-11-16 — pairing supersedes it.

## Languages

The interface ships in English and Burmese (`my`). `src/lib/i18n.ts` holds one
typed catalogue: every key carries both translations, and a missing one is a
compile error rather than a blank label.

That coverage now spans the interface. The shell, lock screen, Settings, Tasks,
Notes, Contacts, Inbox, search, Trash, Vault, Budget, Business, Loans, Habits,
Shopping, Gallery, Journal, Memories, Exports, the pairing panel, the shared
month and weekday headings, the import/export dialogs and the phone UI read
from the catalogue. Budget (`budget.*`), Business (`business.*`), Loans
(`loans.*`), Habits (`habits.*`), Shopping (`shopping.*`), Gallery
(`gallery.*`), Journal (`journal.*`), Memories (`memories.*`), Exports
(`exports.*`) and the pairing panel (`pairing.*`) are the pages migrated this
way; `src/lib/i18n.test.ts` fails if a key in those namespaces
still reads English, and month/year headings come from `month.*`/`weekday.*`
so a Burmese page does not show English calendar chrome. The Exports field
mapping follows the same rule as the page: schema names, column names and
destination paths stay literal, while its Notes column and the archive's
`README.txt`/`EXPORT-FIELDS.md` prose are translated into the active locale.

## Development

Requires **Node.js 26.13.1** and **Rust 1.95.0**. Both are pinned so a fresh
clone runs the same gate as the release:

- `.nvmrc` selects the Node version (`nvm use`, `fnm use`, or the equivalent
  your version manager reads). `package.json` declares `>=26.13.1` and
  `engine-strict=true` in `.npmrc` enforces it, so any other Node fails at
  `npm install` instead of somewhere inside the gate.
- `rust-toolchain.toml` makes rustup install that toolchain and its `clippy`
  and `rustfmt` components on first use.
- `scripts/check-versions.mjs` (in the gate) fails when `engines.node` and
  `.nvmrc` name different Node versions, or when Cargo's `rust-version` and
  the toolchain's `channel` disagree — a stale pin would otherwise change what
  npm and clippy accept without anyone noticing.
- Android builds additionally need the targets and NDK in
  [`docs/ANDROID_TOOLCHAIN.md`](docs/ANDROID_TOOLCHAIN.md); `npm run
  check:android` uses `aarch64-linux-android`.

```
npm install        # once
npm run tauri dev  # desktop app (Vite dev server on :1420)
npm run build      # production frontend build (dist/)
npm run verify     # the full local gate (see below)
```

## Local gate

The pre-push hook runs the full local gate. This project deliberately does not
use GitHub Actions or any hosted CI: the repository owner cannot rely on paid
GitHub Actions minutes. **No change should be merged or released unless
`npm run verify` is green**:

```
git config core.hooksPath .githooks
```

The first step of the gate, `scripts/check-hooks.mjs`, **fails** when the hook
is unarmed, so a clone cannot report a green gate it is not actually running.
It only warns and exits 0 where there is nothing to arm: outside a git checkout
(a source tarball, a packaged copy) or with no `git` on `PATH`.

`npm run verify` =
`node scripts/check-hooks.mjs` → `node scripts/check-references.mjs` →
`node scripts/check-signing-key.mjs` →
`node scripts/check-android-apk.mjs` →
`node scripts/check-versions.mjs` →
`biome check --error-on-warnings .` → token lint → dead-code lint →
`tsc --noEmit` →
`node --test "src/**/*.test.ts"` →
`cargo test --manifest-path src-tauri/Cargo.toml` →
`cargo clippy --all-targets -- -D warnings` → `cargo fmt --check` →
`vite build`

Rules of the gate:

- A reference has to point somewhere. `scripts/check-references.mjs` fails the
  gate when a comment or a test title names a file under `docs/` that is not
  there, or when a link in a markdown file does not resolve. Comments are never
  executed and links are never followed by the build, so without this check a
  moved document leaves the source pointing at nothing for weeks.
- The Android release APK, when one is present, is checked by
  `node scripts/check-android-apk.mjs`: signed (and not with the debug key),
  arm64-only, carrying the `versionCode` of the version in `package.json`, and
  free of undefined `EVP_`/`CRYPTO_`/`OPENSSL_`/`SSL_` dynamic symbols in
  `lib/arm64-v8a/libpurple_memo_lib.so` — the second failure class that shipped
  once, read with the NDK's `llvm-readelf`, which the check requires rather
  than skipping. With no APK it skips with a line, so a desktop clone runs the
  gate unchanged.
- Never use `git push --no-verify`. If the gate is red, fix it or revert —
  the gate's own output on your machine is the evidence.
- Hosted CI is intentionally out of scope. Every clone must enable the hook
  with `git config core.hooksPath .githooks`; `npm run verify` refuses to run
  green until it is enabled. Reviewers and release operators should request the
  local gate output when verifying a change.
- Rust side: `rust-toolchain.toml` installs the pinned toolchain with `clippy`
  and `rustfmt`; no manual `rustup component add` step.
- Releases are built, signed and published **by hand** — there is no
  release workflow; see [`docs/RELEASE.md`](docs/RELEASE.md) for the exact
  procedure (`scripts/make-latest-json.mjs` builds the updater manifest, which
  `tauri build` does not emit, and writes it beside the installer — it is a
  release artifact and is never committed).

## License

MIT — see [`LICENSE`](LICENSE).
