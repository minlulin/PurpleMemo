# Purple Memo

Personal offline notebook and life/money manager — desktop-only (Tauri),
fully offline, encrypted local database.

One person, by design — no accounts, no sync, no cloud.

The full build plan lives in [`docs/PLAN.md`](docs/PLAN.md) — main plan plus
a phase-by-phase build log. The coding agent works one phase at a time from
that plan.

## Development

```
npm install        # once
npm run tauri dev  # desktop app (Vite dev server on :1420)
npm run dev        # web-only UI, no Tauri shell
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
`biome check --error-on-warnings .` → token lint → `tsc --noEmit` →
`node --test "src/**/*.test.ts"` →
`cargo test --manifest-path src-tauri/Cargo.toml` →
`cargo clippy --all-targets -- -D warnings` → `cargo fmt --check` →
`vite build`

Rules of the gate (see §7 of the plan for the full rationale):

- Never use `git push --no-verify`. If the gate is red, fix it or
  revert. Keep the Progress log's gate column in [`docs/PLAN.md`](docs/PLAN.md)
  current as the local evidence for the gate.
- Hosted CI is intentionally out of scope. Every clone must enable the hook
  with `git config core.hooksPath .githooks`; reviewers and release operators
  should request the local gate output when verifying a change.
- Rust side needs `rustup component add clippy rustfmt` once.
- Releases are built, signed and published **by hand** — there is no
  release workflow; see §9 of the plan and [`docs/RELEASE.md`](docs/RELEASE.md)
  for the exact procedure (`scripts/make-latest-json.mjs` builds the updater
  manifest, which `tauri build` does not emit).
