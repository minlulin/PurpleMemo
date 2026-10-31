# Purple Memo

Personal offline notebook and life/money manager — desktop-only (Tauri),
fully offline, encrypted local database.

One person, by design — no accounts, no sync, no cloud.

Built and released by hand: [Development](#development) below covers the local
toolchain, and [`docs/RELEASE.md`](docs/RELEASE.md) is the release procedure.

## Platforms

Windows 10/11 (x64) is the supported platform: it is what is built, signed,
released and validated. Linux and macOS are best-effort — the codebase keeps
its env fallbacks portable (`APPDATA`, `HOME`, `XDG_DATA_HOME`), but nothing
is release-tested there and no artifact is published for them.

## Backups

Settings → Backup exports every table and photo into one archive, saved
wherever you choose.

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

## Exports & LAN share

- The **Exports page** writes a readable ZIP of Markdown, CSV and vCard files
  — see [`docs/EXPORTS.md`](docs/EXPORTS.md) for the exact field mapping.
- The **LAN share** is off by default; when started it serves a read-only,
  encrypted snapshot to browsers on the same network. There is still no sync
  and no cloud — the share is manual, read-only and local.

## Development

Requires **Node.js ≥ 24** (the `engines` field in `package.json` is enforced by
`engine-strict=true` in `.npmrc`, so `npm install` refuses anything older) and,
for the Rust gates, a Rust toolchain with the `clippy` and `rustfmt`
components (`rustup component add clippy rustfmt`).

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
git config core.hooksPath .githooks   # once per clone
```

The first step of the gate, `scripts/check-hooks.mjs`, **fails** when the hook
is unarmed, so a clone cannot report a green gate it is not actually running.
It only warns and exits 0 where there is nothing to arm: outside a git checkout
(a source tarball, a packaged copy) or with no `git` on `PATH`.

`npm run verify` =
`node scripts/check-hooks.mjs` → `node scripts/check-versions.mjs` →
`biome check --error-on-warnings .` → token lint → `tsc --noEmit` →
`node --test "src/**/*.test.ts"` →
`cargo test --manifest-path src-tauri/Cargo.toml` →
`cargo clippy --all-targets -- -D warnings` → `cargo fmt --check` →
`vite build`

Rules of the gate:

- Never use `git push --no-verify`. If the gate is red, fix it or revert —
  the gate's own output on your machine is the evidence.
- Hosted CI is intentionally out of scope. Every clone must enable the hook
  with `git config core.hooksPath .githooks`; `npm run verify` refuses to run
  green until it is enabled. Reviewers and release operators should request the
  local gate output when verifying a change.
- Rust side needs `rustup component add clippy rustfmt` once.
- Releases are built, signed and published **by hand** — there is no
  release workflow; see [`docs/RELEASE.md`](docs/RELEASE.md) for the exact
  procedure (`scripts/make-latest-json.mjs` builds the updater manifest, which
  `tauri build` does not emit).

## License

MIT — see [`LICENSE`](LICENSE).
