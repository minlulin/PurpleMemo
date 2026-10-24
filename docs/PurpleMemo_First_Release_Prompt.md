# Purple Memo — First Release (v0.1.0): fresh clone → signed GitHub Release

Execute this exactly, phase by phase. Each phase ends with a one-line status.
**Stop conditions are absolute**: if one triggers, stop, report the exact
error, and wait — do not improvise, do not fix unrelated code, do not retry
with guessed values.

The signing key is the **owner's** step: the owner copies `.keys/` from the
old clone himself. You never generate, regenerate, move, or print a key.

If a session ends mid-way, a fresh session resumes by checking disk state
(which phases are visibly done) before continuing — never redo a phase whose
outputs already exist and check out.

---

## Phase 0 — Workspace

1. The old clone at `E:\CodeSpace\PurpleMemo` holds the only full history
   copy and the signing key. **Do not delete or overwrite it.** If the owner
   has not already done so, rename it to `E:\CodeSpace\PurpleMemo-history`
   and report that you did.
2. Fresh clone into `E:\CodeSpace\PurpleMemo`:
   `git clone https://github.com/minlulin/PurpleMemo.git`
3. In the new clone: `git log --oneline` must show **exactly one** commit,
   `53fad792` ("Initial commit — Purple Memo v0.1.0"). Anything else → STOP.

## Phase 1 — Clone setup

Run in `E:\CodeSpace\PurpleMemo`:

1. `git config core.hooksPath .githooks`
2. `rustup component add clippy rustfmt` (idempotent; fine if already added)
3. `npm install`
4. **Key checkpoint:** confirm `.keys\updater.key` exists in the new clone
   (the owner copies it). Missing → STOP and report "waiting for owner to
   copy .keys". Never run `signer generate`.

## Phase 2 — Gate

1. `npm run verify` — must finish **fully green** (hook check, version check,
   biome, token-lint, tsc, JS tests, cargo tests, clippy, fmt, vite build).
2. Record the summary counts (JS test count — expect 622 — and cargo test
   count) for the final report. Red gate → STOP, report the failing step's
   output verbatim.

## Phase 3 — Version, notes, tag

1. Confirm the version is `0.1.0` in all three places (read-only check):
   `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`
   (`[package] version`). Any mismatch → STOP. **Do not bump anything.**
2. Create `RELEASE_NOTES.md` in the repo root with **exactly** the content
   between the `=== NOTES START ===` / `=== NOTES END ===` markers at the
   bottom of this prompt. No edits, no additions.
3. `git add RELEASE_NOTES.md && git commit -m "docs: add v0.1.0 release notes"`
   then `git push` (the pre-push hook re-runs the gate — it must pass).
4. `git tag v0.1.0 && git push origin v0.1.0`

## Phase 4 — Signed build (PowerShell, one session)

All in the **same** PowerShell window — the variables die with the session:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content .keys/updater.key -Raw).Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''   # if the key actually has a password, use it instead — if signing then fails, STOP and report; never guess twice
npm run tauri build
```

Post-build checks (any failure → STOP):
- `src-tauri\target\release\bundle\nsis\Purple Memo_0.1.0_x64-setup.exe` exists
- **`Purple Memo_0.1.0_x64-setup.exe.sig` exists next to it** — no `.sig`
  means the key env was wrong; do not proceed, report.
- Note the exact file names and sizes of both for the final report.

**Owner checkpoint:** STOP here and report. The owner installs the NSIS
installer, smoke-tests the installed app (unlock, Notes, Budget, Settings →
Updates), and gives the go before Phase 5.

## Phase 5 — Updater manifest

```powershell
node scripts/make-latest-json.mjs --version 0.1.0 --asset "src-tauri/target/release/bundle/nsis/Purple Memo_0.1.0_x64-setup.exe" --notes-file RELEASE_NOTES.md
```

- The script validates version, signature, and asset URL; any error → STOP.
- Confirm `latest.json` now exists in the repo root; quote its `version`,
  `url`, and whether `signature` is non-empty in your report (never print the
  signature itself).

## Phase 6 — Publish (owner, web UI) + verification (you)

Publishing is the owner in the GitHub web UI (`gh` is not authenticated):
release from tag `v0.1.0`, title `Purple Memo 0.1.0`, body = RELEASE_NOTES.md,
upload **exactly three** assets — the NSIS `.exe`, its `.exe.sig`, and
`latest.json` (not the MSI) — **not** a draft, **not** a pre-release.

After the owner confirms it is published, you verify:
1. `curl -sI https://github.com/minlulin/PurpleMemo/releases/latest/download/latest.json`
   → expect a redirect/200 chain ending at the real asset.
2. Fetch that `latest.json` and confirm: `version` is `0.1.0`, the `url`
   names the uploaded NSIS exe, `signature` is present.

## Final report

```
Clone: HEAD <sha> (single commit confirmed)
Setup: hooks armed / npm install OK / .keys present (owner-copied)
Gate: npm run verify green — JS <n> tests, cargo <n> tests
Tag: v0.1.0 pushed
Build: <exe name + size> / <.sig present yes-no>
Owner install smoke test: <go / not yet>
Manifest: latest.json — version, url, signature present
Publish: <published by owner / pending> + latest.json URL check <result>
Anything stopped or surprising: <or "none">
```

---

=== NOTES START ===
# Purple Memo 0.1.0

First public release.

Purple Memo is a personal offline notebook and life/money manager for one
person — notes, journal, tasks and reminders, budget and business tracking,
contacts, and a photo library, in a single encrypted local database.
Desktop-only (Tauri), fully offline: no accounts, no sync, no cloud.

**Platform:** Windows 10/11 (x64). Linux and macOS build from source as
best-effort only and receive no signed artifacts.

## Please read before installing

- **Your database key is not in your backup.** Backups (Settings → Backup)
  contain your data and photos, never the database key. The key lives in
  your operating system's credential store and is exported separately
  (Settings → Key export). Keep the exported key file somewhere safe and
  separate — a backup without its key cannot be opened.
- **If the key is ever lost from the credential store** (Windows profile
  migration, OS reinstall), the app refuses to start rather than overwrite
  your data, and the failure dialog offers **Restore exported key…** — pick
  the exported key file and the app proves it opens your database before
  saving it.
- **No downgrades.** The database schema is forward-only (currently v5).
  An older version of Purple Memo cannot open a database a newer version
  has migrated, and installing an older version does not roll your data
  back. To return to an older version, restore a backup taken before the
  upgrade.
- **One instance per machine.** Purple Memo runs as a single instance; a
  second launch is turned away. This is deliberate — two copies must never
  contend for the same encrypted database.
- **Trash is recoverable deletion, not secure erasure.** Deleted notes,
  tasks, contacts, memories and journal entries wait in Trash until you
  empty it; permanent deletion removes the app's references and eligible
  photo files, but copies in OS-level backups are outside the app's reach.
- **Password-protected backups (.pmbk) have no password recovery.** A lost
  backup password means that archive cannot be opened.
- **LAN share is off by default.** When you start it, it serves a read-only,
  encrypted snapshot to browsers on your own network — manual and local,
  never a sync and never a cloud.

## License

MIT — see the LICENSE file in the repository.
=== NOTES END ===
