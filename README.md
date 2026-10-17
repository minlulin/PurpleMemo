# Purple Memo

Personal offline notebook and life/money manager — desktop-only (Tauri),
fully offline, encrypted local database.

One person, by design — no accounts, no sync, no cloud.

Built and released by hand: [Development](#development) below covers the local
toolchain, and [`docs/RELEASE.md`](docs/RELEASE.md) is the release procedure.

## Development

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
  with `git config core.hooksPath .githooks`; reviewers and release operators
  should request the local gate output when verifying a change.
- Rust side needs `rustup component add clippy rustfmt` once.
- Releases are built, signed and published **by hand** — there is no
  release workflow; see [`docs/RELEASE.md`](docs/RELEASE.md) for the exact
  procedure (`scripts/make-latest-json.mjs` builds the updater manifest, which
  `tauri build` does not emit).
