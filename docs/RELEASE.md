# Cutting a release — by hand

Purple Memo ships in-app updates through GitHub Releases. Verification and
artifact production are intentionally local: this project does not use hosted
CI or a GitHub Actions release workflow. The local gate (§7) must be green
before a release is prepared.

The app polls:

```
https://github.com/minlulin/PurpleMemo/releases/latest/download/latest.json
```

`releases/latest` means the newest **published, non-draft, non-prerelease**
release — a draft or a pre-release is invisible to the updater.

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

1. **Dependency re-check** (§3 rule 1): confirm every pinned version is still
   the max stable one (`npm outdated`; `cargo info <crate>@<major>`).
2. **Green local gate** — run the complete check locally:

   ```bash
   npm run verify        # biome, token-lint, tsc, JS + Rust tests, clippy, fmt, build
   ```

3. **Bump the version in all three places** — they must agree:
   - `package.json` → `version`
   - `src-tauri/tauri.conf.json` → `version`
   - `src-tauri/Cargo.toml` → `[package] version`

   Tag the commit `v<version>` (the tag keeps the `v`; the manifest does not).
4. **Export the signing key** (a `.env` file does not work here):

   ```bash
   export TAURI_SIGNING_PRIVATE_KEY=.keys/updater.key
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=''   # only if the key has one
   ```

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
- **Version mismatch**: `latest.json` version, the tag and the app version must
  all agree, or the updater either ignores the release or loops offering an
  update the user already has.
- **Signature mismatch** (wrong keypair, or a manifest paired with another
  build's `.sig`) fails at install time with `signature verification failed`.
- **Replacing assets after publishing** invalidates anything already cached on
  a user's machine — publish a new version instead.
- The `pubkey` in `tauri.conf.json` is the public half only; there is no
  signing secret in this repository and no hosted secret store.
