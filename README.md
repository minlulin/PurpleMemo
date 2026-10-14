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

The pre-push hook runs the full local gate, and hosted CI repeats it for pull
requests and protected-branch pushes. **No change should merge unless
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
  current as local evidence alongside hosted CI.
- Rust side needs `rustup component add clippy rustfmt` once.
- Releases are built, signed and published **by hand** — there is no
  release workflow; see §9 of the plan and [`docs/RELEASE.md`](docs/RELEASE.md)
  for the exact procedure (`scripts/make-latest-json.mjs` builds the updater
  manifest, which `tauri build` does not emit).
