# Purple Memo — independent code review

**Date:** 2026-10-14
**Reviewed revision:** `76f4e8d865d7b78281a455af187b90c4a1f76181` (`polish: refine visual hierarchy`), branch `arena/30b42c1b-purplememo`, working tree clean
**Reviewer:** independent review pass over the whole tree (source, config, tests, docs, git/CI state, upstream dependency behaviour)
**Deliverable:** this document. It is a review artifact only — no source file was modified.

---

## 1. Verdict

Purple Memo is a **well-engineered, unusually disciplined personal desktop app**. The
layering is honest (UI → feature repo → single driver → Rust IPC → SQLCipher), the
TypeScript is genuinely strict, the Rust IPC surface is small and defensive, money and
dates follow one coherent discipline, and the test suite is meaningful rather than
decorative. No critical defect, no SQL-injection path, no at-rest encryption defect, and
no path-traversal escape was found.

**It is not release-ready yet**, but nothing blocks release *for architectural reasons*.
Three things must be closed first:

1. **Unsaved editor content is silently destroyed by the auto-lock and by page
   navigation** (M-01) — a data-loss bug in a note-taking app.
2. **The photo path (import/export, gallery) is a per-byte JSON IPC path held entirely in
   renderer memory** (M-02) — the first real photo library will hurt.
3. **File export (backup zip, key file) is a fire-and-forget webview download with an
   unconditional success toast** (M-03) — if it fails, the user believes they have a
   backup. Verify on the target OS before shipping.

Everything else found is Low or informational. The single most important *process* point
is I-01: the repository defines hosted CI, but there is no evidence it has ever run, so
the local pre-push hook is still the only proven gate.

### Finding summary

| ID | Severity | Area | Summary |
|---|---|---|---|
| M-01 | Medium | UX / data safety | Auto-lock and navigation discard unsaved editor content |
| M-02 | Medium | Performance / memory | Photo bytes cross IPC as JSON number arrays; gallery and export are fully in-memory |
| M-03 | Medium | Data safety / platform | Backup & key export rely on unverified webview downloads and always report success |
| L-01 | Low | Robustness / security | Webview navigation is unrestricted; markdown links can navigate the app away |
| L-02 | Low | Security posture | No throttling on PIN / security-answer attempts (LAN share has a 10-attempt cap) |
| L-03 | Low | Architecture | `db_begin`/`db_commit`/`db_rollback` are dead IPC surface (never used by the app) |
| L-04 | Low | Robustness | Boot failure is a silent panic; OS-keyring unavailability is unrecoverable |
| L-05 | Low | Release process | Version triplication across three files is not checked by any gate |
| L-06 | Low | Documentation | README, hook comment, session-memory template and the in-tree audit contradict the code |
| L-07 | Low | Release process | `requireSignedVersion: true` is enforced but undocumented; hand signing needs `--app-version` |
| I-01 | Info | Process | CI exists but has never demonstrably run; the local hook is the only evidence |
| I-02 | Info | Testing | No tests for the app shell or any of the 15 pages; A-01's recommended regression test is absent |
| I-03 | Info | Security | The renderer is a full-trust domain (arbitrary SQL + key export): keep the CSP/no-raw-HTML invariants |

---

## 2. Scope, method and evidence

### 2.1 What was executed (this machine, 2026-10-14)

All commands ran in a clean checkout on Linux with Node `v22.22.3` (the project pins
`node >= 24` in `package.json:6-8` and CI uses Node 24 — the local Node is older, so the
results below are a *floor*, not a ceiling).

| Command | Result |
|---|---|
| `npm ci` | 134 packages, **0 vulnerabilities**; one `EBADENGINE` warning (Node 22 vs `>=24`) |
| `npm run token-lint` | OK — 83 files scanned, no hex/rgb/px escapes from the token domain |
| `npm run lint` (biome) | OK — 95 files, no fixes needed |
| `npm run typecheck` (tsc) | Clean |
| `npm test` (`node --test "src/**/*.test.ts"`) | **193 passed / 0 failed**, ~6.9 s |
| `npm run build` (vite) | OK — `index.html` 1.08 kB, CSS 78.61 kB (13.57 kB gz), JS 583.21 kB (161.84 kB gz) |
| `npm audit` / `npm audit --omit=dev` | **0 vulnerabilities** (the prior audit recorded this as "inconclusive" — it is now answerable and clean) |
| `npm run verify` as a whole | **Not run** — it needs the Rust toolchain, so the three Rust steps (`cargo test`, `clippy`, `fmt`) are unavailable here; every non-Rust step passes individually |

**Not executed, and why:** the sandbox has no Rust toolchain and no access to
`static.rust-lang.org` / `crates.io`, so `cargo test`, `cargo clippy -D warnings`,
`cargo fmt --check` and `npm run tauri build` **could not be run here**. All Rust
conclusions below are from careful source reading plus the project's own recorded
results. Likewise there is no device/E2E testing available: no native window can be
driven from here, so nothing in this review proves runtime behaviour of the packaged app.

### 2.2 What was read

- **Rust, all of it:** `src-tauri/src/{lib,main,commands,db,photos,schema,share}.rs`
  (2,411 lines incl. tests), `Cargo.toml`, `tauri.conf.json`, `capabilities/default.json`,
  `share/share.html`.
- **TypeScript core:** every file in `src/lib/` and `src/data/` (driver, mock driver,
  composition root), plus `src/App.tsx` and `src/main.tsx` in full.
- **UI:** `pages/SettingsPage.tsx` (886 lines) in full; `pages/VaultPage.tsx`,
  `pages/GalleryPage.tsx`, `pages/NotesPage.tsx`, `pages/JournalPage.tsx` read in the
  risky regions (state lifecycles, byte handling, markdown, save paths);
  the remaining pages were surveyed by pattern (see §2.3) rather than read line by line —
  an explicit limitation of this review.
- **Config/build:** `package.json`, `tsconfig.json`, `biome.json`, `vite.config.ts`,
  `index.html`, `.gitattributes`, `.editorconfig`, `.githooks/pre-push`,
  `.github/workflows/verify.yml`, all four `scripts/*.mjs`.
- **Docs:** `README.md`, `docs/PLAN.md`, `docs/RELEASE.md`,
  `docs/CODEBASE_AUDIT_2026-10-14.md`, `docs/SESSION_MEMORY.md`, `docs/UI_POLISH_PLAN.md`
  (surveyed).
- **Repository/CI state via `gh`:** releases, pull requests, check rollups.
- **Upstream sources via the GitHub API** (to check claims the docs make about pinned
  dependencies): `tauri-plugin-updater` `config.rs` at tag `updater-v2.13.3`,
  `tauri-cli` `updater_signature.rs` / `bundle.rs` at `tauri-cli-v2.12.2`,
  `tauri-runtime` / `tauri-runtime-wry` at `tauri-v2.12.3`, `wry` at `wry-v0.57.0`.

### 2.3 Automated sweeps used to target the manual read

Across `src/` and `src-tauri/`:

- `innerHTML` / `dangerouslySetInnerHTML` / `outerHTML` / `eval(` → **none**.
- `: any` / `as any` / `@ts-ignore` / `@ts-expect-error` → **none**.
- Non-null assertions (`!.`) → **none**.
- `console.*` outside tests → **none**.
- Every `${...}` inside a SQL template literal → **fixed identifier lists or
  `?`-placeholder sets only**; all values are parameter-bound (see §3.2).
- Timers, object URLs, listeners → enumerated and traced to their cleanup.

---

## 3. What is strong (verified, not assumed)

### 3.1 Architecture and layering

- One data path, honoured in practice: `src/data/driver.ts` is the only file that imports
  `@tauri-apps/api/core`, `src/data/app.ts` is the only composition root, and the feature
  pages take their repositories from it (`MorePage.tsx` is navigation-only). The mock
  driver implements the same interface for tests (`src/data/mock-driver.ts`). Outside the
  data path only the shell's plugin use appears: `App.tsx:5` imports the notification
  plugin and `src/lib/update.ts:67` dynamically imports the updater plugin.
- Money discipline is real: integer cents in the schema (`CHECK (amount_cents > 0)`),
  `parseMMK`/`formatMMK` at the display edges only, `outstandingCents` clamped at zero,
  `applyPayment` refusing to overpay (`src/lib/money.ts`).
- Date discipline is real: everything user-facing is local `yyyy-mm-dd`/`yyyy-mm-ddTHH:mm`
  (`src/lib/dates.ts`); the only UTC values are interchange formats (`backup.exportedAt`,
  `latest.json.pub_date`), exactly as the plan requires.
- Pure helpers are separated from I/O (`dashboard.ts`, `search.ts`, `release.ts`,
  `business.ts` calculators), which is why the test suite can pin behaviour without a DOM.

### 3.2 Security posture

- **SQLCipher**: key minted once from the OS random source, stored in the OS credential
  store, hex-validated on read, and the DB is *verified before use* by reading
  `sqlite_master` after `PRAGMA key` (`src-tauri/src/db.rs`), then WAL + `foreign_keys=ON`.
  `db_key_export` is a read-only keyring read that never mints.
- **Parameter binding everywhere.** The only string interpolation into SQL is identifiers:
  structural column sets chosen in code, and backup-supplied table/column names gated by
  `requireIdentifier` (`/^[A-Za-z_][A-Za-z0-9_]*$/`) (`src/lib/backup.ts:304-322`).
  `notes_fts` MATCH expressions are built by double-quoting every token with inner quotes
  doubled (`src/lib/search.ts`), so FTS operators cannot be injected.
- **Transaction integrity**: `reject_txn_control` refuses `BEGIN/COMMIT/END/ROLLBACK/
  SAVEPOINT/RELEASE` (first token) on both `execute` and every `batch` statement
  (`src-tauri/src/db.rs:282,297,314`), so no smuggled commit can break atomicity;
  `db_batch` is refused while a manual transaction is open
  (`src-tauri/src/commands.rs:56-61`).
- **Photos**: content-addressed `photos/<yyyy>/<mm>/<sha256>.<ext>`, temp-file + rename
  writes, existing-file hash verification before reuse, and a strict relative-path grammar
  for read/delete (`src-tauri/src/photos.rs`) — the file name cannot steer the path.
- **Vault**: AES-256-GCM with per-item salt + IV, PBKDF2-SHA256 at 600 000 iterations
  (`src/lib/crypto.ts:6`), key cache bound to a password hash, and a **sealed verifier**
  so an empty vault still rejects a wrong password (`src/lib/vault.ts:29-90,151-176`).
  `changePassword` re-encrypts in memory first, then commits all rows in one batch.
- **LAN share** is the most interesting design in the tree and it holds up: opt-in per
  session, one listener, random 6-character pairing code from a 32-character alphabet,
  constant-time comparison, `Host` allowlist (IP literal / `localhost`) checked *before*
  the code so a rebound name cannot burn attempts, GET only, 512 KiB snapshot cap, ten
  wrong codes shut the server down, `reap()` clears the snapshot before signalling the
  listener, and the network path has **no** database, keyring or filesystem access.
- **Locking**: `lockNow` drops the vault keys **and** stops the share listener
  (`src/App.tsx:329-334`), the publisher and reminder polls pause while locked
  (`src/App.tsx:370-371`), and the boot gate is deliberately fail-closed
  (`src/lib/appLock.ts:28-45`) — the prior audit's A-01 is genuinely fixed.
- **Front end**: strict CSP (`default-src 'self'; script-src 'self'; object-src 'none'`)
  (`tauri.conf.json:24`), a small capability set (`core:default`, `updater:default`,
  `notification:default`), markdown rendered through `react-markdown` with **no**
  `rehype-raw` and no `dangerouslySetInnerHTML` anywhere, and the phone page renders with
  `textContent` only behind its own restrictive CSP.

### 3.3 Upstream claims checked rather than trusted

Two release-critical claims in the docs were verified against the pinned upstream sources:

- **`requireSignedVersion: true` is a real, supported flag** in the pinned plugin
  (`plugins/updater/src/config.rs` at tag `updater-v2.13.3`; also present in 2.13.0–2.13.2).
  Its doc comment confirms the purpose: without it, an attacker controlling the unsigned
  endpoint response can pair an inflated `version` with the `url`/`signature` of a genuine
  older build and force a downgrade. Enabling it is the right call.
- **The pinned CLI records the version in the signature.** `tauri-cli-v2.12.2`
  `crates/tauri-cli/src/helpers/updater_signature.rs` appends `\tversion:<v>` to the
  minisign trusted comment (rejecting tab/newline in the file name or version), and
  `crates/tauri-cli/src/bundle.rs` calls it as
  `sign_file(&secret_key, path, Some(settings.version_string()))`. So `npm run tauri build`
  produces the signature this config demands; a hand-signed artifact would not (see L-07).
- The FTS5 approach in the schema is sound: plain `INSERT`/`UPDATE`/`DELETE` on an fts5
  table maintains the index correctly (verified independently against a local SQLite
  build: after `UPDATE … SET a='new'`, the old token stops matching and the new one
  matches). The unusual-looking trigger body in `src-tauri/src/schema.rs` is not a bug.

---

## 4. Findings

### M-01 — Auto-lock and navigation silently discard unsaved editor content

**Severity:** Medium (data loss) · **Evidence:** `src/App.tsx:438` (`if (!unlocked) { return <LockScreen …> }`),
`src/pages/NotesPage.tsx:265-277,579-582`, `src/pages/JournalPage.tsx:43-64,66-82,273`,
`src/lib/appLock.ts:7`

The editor state lives in page component state and is only persisted by an explicit *Save*
button (Notes: `onSave` → `handleSave`, `src/pages/NotesPage.tsx:170,582`; Journal:
`handleSave`, `src/pages/JournalPage.tsx:66`). There is no dirty flag, no autosave, no
draft persistence, and no confirmation:

- When the idle auto-lock fires (`DEFAULT_AUTO_LOCK_MINUTES = 10`,
  `src/lib/appLock.ts:7`), `AppShell` returns the lock screen **instead of** the shell, so
  the whole page subtree unmounts. Unlocking re-mounts a fresh empty editor.
- The same happens when the user switches selected note or clicks a different day
  (`src/pages/JournalPage.tsx:43-64` reloads the entry over the draft), or navigates to
  another section after typing without saving.

A user who writes a paragraph, is interrupted for ten minutes, unlocks, and finds an empty
editor has lost work with no warning. Note that the code deliberately protects drafts
against *list refreshes* (`populatedIdRef`, `src/pages/NotesPage.tsx:224-233`) — the
remaining holes are the lock and the navigation paths.

**Recommendation (cheap → thorough):** (a) track a dirty flag and confirm before
discarding on note/day switch; (b) persist a draft (settings key or `localStorage`) so a
lock/unmount/reload restores unsaved text; (c) or debounce-autosave after N seconds of
typing, which also makes the explicit Save button a no-op convenience. Whichever is
chosen, add a test for the draft round-trip — this is pure logic and testable under
`node --test` today.

### M-02 — Photo bytes travel as JSON number arrays and are held entirely in renderer memory

**Severity:** Medium (performance, memory, UX freeze) · **Evidence:** `src/data/driver.ts:49-50,71-72`,
`src/lib/backup.ts:99-137`, `src/pages/GalleryPage.tsx:40,74-95`

`photo_read` returns `Vec<u8>`, which serde/Tauri serialises as a JSON array of byte
numbers; `photo_save` accepts the same shape. Consequences:

- **Scale of the overhead.** A 3 MB JPEG becomes ≈ 11–12 million characters of JSON
  (`"0,255,17,…"`), then a ≈ 24 MB JS number array, then a `Blob`. A 25 MB photo (the
  import cap) is an order of magnitude worse. This is not hypothetical: it is the shape of
  every photo operation in the app.
- **Gallery.** `loadThumbnails` fetches **full-resolution bytes for every photo in the
  library**, sequentially, and keeps every resulting blob URL alive
  (`src/pages/GalleryPage.tsx:74-95`). 300 photos at 3 MB ≈ 300 IPC round-trips and
  ~900 MB of live blobs — on a page whose only job is a grid.
- **Backup export.** `readBackupData` holds every table in memory, then reads **every
  photo as a `number[]`**, then `zipSync` (synchronous, on the UI thread) builds the whole
  archive (`src/lib/backup.ts:99-137`). The import path is capped (256 MB archive / 512 MB
  expanded / 5 000 photos / 25 MB per photo, `src/lib/backup.ts:27-32`) but **the export
  path has no cap and no chunking**, so exporting a library near those same numbers can
  freeze the window for minutes or exhaust memory.

**Recommendation:** (a) for `photo_read`, return raw bytes rather than JSON — Tauri 2's
`ipc::Response` carries a `Vec<u8>` body untouched (`InvokeResponseBody::Raw`), which the
JS side receives as a `Uint8Array`; (b) generate real thumbnails once at save time (or downscale on read) and
use them in the grid, loading full bytes only in the inspector; (c) move zipping into
Rust or a worker, and/or cap export volume with a clear message; (d) consider an
`asset:`/custom protocol for reads instead of IPC. This is a plan-level decision (§3/§4),
not a spot fix.

### M-03 — File export is a fire-and-forget webview download with an unconditional success toast

**Severity:** Medium (data safety) · **Evidence:** `src/pages/SettingsPage.tsx:180-189` and `:272-277`;
`src-tauri/src/lib.rs` (no `on_download` registered anywhere)

Both export paths create a blob URL, click a synthetic `<a download>`, revoke the URL
immediately, and then show *"Backup saved — N rows, M photos"* /
*"Encryption key download started"* regardless of what actually happened.

Verified in the runtime sources (not guessed): `tauri-runtime`'s `WebviewAttributes`
defaults `download_handler` to `None`; `tauri-runtime-wry` only attaches wry's download
callbacks `if let Some(download_handler) = pending.download_handler`; and `wry 0.57.0`
registers WebView2's `DownloadStarting` handler and the macOS `WryDownloadDelegate` only
when `download_started_handler`/`download_completed_handler` are set. Purple Memo never
sets them, so the app relies entirely on each platform webview's default download
behaviour — which differs per OS and is not something the app can observe or report.

**Impact:** on a platform whose default behaviour is to drop the download (or to require
an unhandled delegate), the user is told a backup exists when it does not. For a
single-copy, offline, encrypted database, that is the worst failure mode the app has.

**Recommendation:** ship exports through a mechanism the app controls — the dialog/fs
plugins (with capability entries) to write the file and report the real path, or register
`on_download` and toast only on `DownloadEvent::Finished { success: true }`. Independently
of the mechanism, **verify both exports on every target OS before the first release** and
say in the UI where the file went.

### L-01 — Webview navigation is unrestricted; a markdown link can navigate the app away

**Severity:** Low · **Evidence:** `src-tauri/src/lib.rs` (no `on_navigation`),
`src/pages/NotesPage.tsx:160`, `src/pages/JournalPage.tsx:273`

`react-markdown` renders `[x](https://…)` as a real anchor. Nothing restricts navigation,
so clicking it replaces the app UI with a remote page inside the app window — with no
browser chrome and no way back except restarting. Imported backups (someone else's notes)
can carry such links too.

No IPC exposure results: Tauri v2 requires a per-run `Tauri-Invoke-Key` header on every
IPC request (`crates/tauri/src/ipc/protocol.rs`), and the key is injected only into
initialized local frames (the upstream issue about `__TAURI_INVOKE_KEY__` missing after
navigating to a remote URL documents this as intentional). So this is robustness/UX, not a
key-read oracle.

**Recommendation:** register `on_navigation` allowing only the app's own origin (the
pattern Tauri's own docs show for `WebviewBuilder::on_navigation`), and route external
links to the system browser via the opener plugin (add the plugin *and* its capability
entry, per the project's own rule).

### L-02 — No throttling on lock-screen attempts

**Severity:** Low · **Evidence:** `src/components/LockScreens.tsx:225-275`

`unlockWithPin` and the security-question fallback (`resetPin`) accept unlimited attempts.
The only cost per attempt is the 600k-iteration PBKDF2 hash — which is a real cost
(hundreds of ms) but not a policy. Compare with the LAN share, which deliberately shuts
itself down after ten wrong codes (`src-tauri/src/share.rs:34,479-489`).

The stated threat model ("casual-eyes protection", §2.9) makes this acceptable, but the
asymmetry is worth a decision: the cheap fix is a growing delay (or a forced short pause)
after N consecutive failures, or a note in the UI that the PIN is the only barrier. Note
also that the fallback allows *replacing* the PIN once the answer is known — an attacker
with the answer can lock the real user out by changing it. Consider requiring the old PIN
(or at least warning) when the reset is triggered.

### L-03 — Three of the fourteen IPC commands are dead surface

**Severity:** Low · **Evidence:** `src-tauri/src/commands.rs:67,82,94`; `src/data/driver.ts`

`db_begin` / `db_commit` / `db_rollback` are implemented, exposed, mapped by the driver —
and **called by nothing** in the app (`mock-driver.test.ts:54-55` exercises `begin`/`commit`;
`rollback` is called by nothing at all, not even a test). Every multi-statement write already goes through `db_batch`. The plan
mandates them ("short critical sections"), but no code has needed one in five phases.

Two consequences worth deciding on: the surface (and the `txn_open` state machine) is
untested in the app's real paths, and an abandoned manual transaction would make
`db_batch` fail until the app restarts or something rolls it back. Either delete them
(fewer commands, less state) or keep them with an explicit comment plus a test that a
`db_batch` during an open manual transaction is refused (that behaviour exists at
`src-tauri/src/commands.rs:56-61` and is currently unverified by any test).

### L-04 — A boot failure is a silent crash

**Severity:** Low · **Evidence:** `src-tauri/src/lib.rs:20-52`

`load_or_mint_db_key()` and `open_encrypted_db()` failures propagate out of `setup`, and
`run()` is terminated with `.expect("error while running Purple Memo")`. With
`panic = "abort"` in the release profile, the user gets no window, no dialog and no log —
just a process that exits. The most plausible trigger is environmental: a desktop where
the OS credential store is unavailable (headless Linux, some remoting sessions) can never
create a keyring entry, so the app is permanently unlaunchable.

**Recommendation:** catch the setup error before `.expect`, show a native error dialog
(`tauri-plugin-dialog` needs a capability entry) or write a diagnostic file next to the
DB, and include the keyring hint ("your OS credential store is unavailable") in the
message. The frontend already has a good failure screen for settings-read errors — this is
the one hole before the frontend exists.

### L-05 — Version triplication is unguarded

**Severity:** Low · **Evidence:** `docs/RELEASE.md` step 3; `package.json:4`,
`src-tauri/tauri.conf.json:4`, `src-tauri/Cargo.toml:3`

Release requires `package.json`, `tauri.conf.json` and `Cargo.toml` to agree, and
`latest.json` (built by `scripts/make-latest-json.mjs`) must agree with the tag. Nothing
in `npm run verify` checks any of that, and a mismatch is exactly the class of mistake
that produces "the updater silently ignores my release" or an update loop. A ~20-line
`scripts/check-versions.mjs` (like `check-hooks.mjs`) wired into `verify` closes it; the
manifest script already validates everything it can see.

### L-06 — Documents that contradict the code

**Severity:** Low (process hygiene) · Evidence: several

- `docs/CODEBASE_AUDIT_2026-10-14.md` describes a tree that no longer exists: A-01, A-03,
  A-04 and A-05 are all **fixed** in this revision (see §5), yet the document is written
  in the present tense and its "Recommended release order" is stale. Either annotate it
  with a resolution status per finding or mark it superseded by this review.
- `.githooks/pre-push:3` says *"No hosted CI is used; this hook is the enforcement"* while
  `.github/workflows/verify.yml` exists and `README.md:24` says CI repeats the gate.
- `scripts/reset-session-memory.mjs:32` writes *"The Progress log's gate column is the
  only CI evidence this project has"* into every new `SESSION_MEMORY.md` — also stale now.
- `docs/SESSION_MEMORY.md` states *"`gh` is not installed here"* — it is installed and
  authenticated (`gh auth status` → `minlulin`), so the two open P5 gate items can be
  actioned today.
- `README.md:17` advertises `npm run dev` as a "web-only UI, no Tauri shell". In a plain
  browser every IPC call fails and the app shows the boot-error screen
  ("Could not read the encrypted database…"), because `src/data/app.ts` always builds the
  Tauri driver and the mock driver exists only for tests. Either wire a mock fallback for
  `import.meta.env.DEV` when `window.__TAURI_INTERNALS__` is absent, or delete the claim.

### L-07 — `requireSignedVersion` is enforced but undocumented

**Severity:** Low (release-affecting) · **Evidence:** `src-tauri/tauri.conf.json:45`;
`docs/RELEASE.md` (no mention); upstream sources cited in §3.3

The config demands that every updater artifact's minisign trusted comment carry the
version it was signed for. `npm run tauri build` does that automatically with the pinned
CLI — but `tauri signer sign` does **not** unless `--app-version` is passed (the CLI warns
when it is omitted). Anyone signing by hand (or re-signing an artifact, which the plugin's
own docs describe as the reason to re-publish rather than re-sign) will produce a build
every client rejects with a signature-verification error, and `docs/RELEASE.md` gives no
hint. Add a line to the release doc's gotchas: *the signature must carry the version; use
`tauri build`, or pass `--app-version` explicitly*.

### I-01 — CI is defined, but nothing proves it has ever run

**Severity:** Info · **Evidence:** `.github/workflows/verify.yml` (26 lines);
`gh pr view 1 -R minlulin/PurpleMemo --json statusCheckRollup` → `[]`;
`gh api repos/…/actions/*` → 403 with the available token

The only merged pull request shows **no status checks**, and the Actions API is not
readable with the current token, so this review cannot confirm a single successful CI run.
The workflow itself is correct in shape (Node 24, `npm ci`, `npm run verify`, clippy +
rustfmt components, `permissions: contents: read`). Two improvements: pin the third-party
actions (`dtolnay/rust-toolchain@stable` is a moving ref) to commit SHAs, and *require* the
workflow on `main` so the gate is not bypassable by a clone that never ran
`git config core.hooksPath .githooks`. Until then, keep treating the local gate as the only
evidence — and note that `check-hooks.mjs` deliberately only warns.

### I-02 — Test coverage shape

**Severity:** Info · **Evidence:** 26 test files, 193 TS tests, 15 `#[test]` in `db.rs`,
5 in `photos.rs`, 15 in `share.rs`, 2,411 Rust lines total

Coverage is strong where bugs hurt (money, dates, backup validation, vault, share,
settings, lock gates, contrast) and the Rust tests drive the real TCP listener rather than
a mock. Two gaps are structural rather than accidental: there is no DOM/component test
harness, so `src/App.tsx` and all 15 pages are untested — which means the A-01 fix
("locking ends sharing") has no regression test even though the prior audit asked for one,
and M-01/L-01-class bugs cannot be caught by tests at all. If a component harness is out of
scope, extracting the lock/share/poll coordination from `AppShell` into a testable hook
would buy most of the value for little cost.

### I-03 — The renderer is a full-trust domain; keep the invariants

**Severity:** Info

Any code that executes in the renderer can run arbitrary SQL (`db_query`/`db_execute`
accept any statement) and read the database key (`db_key_export`). The app's security
therefore rests on the front end never executing foreign code. Today that holds: strict
CSP with `script-src 'self'`, no remote content, no `innerHTML`, no `eval`, markdown
without raw HTML. This is worth an explicit invariant — a lint rule banning
`dangerouslySetInnerHTML` and `eval`, and a line in the plan — because it is the kind of
property that erodes silently.

---

## 5. Status of the previous audit (`docs/CODEBASE_AUDIT_2026-10-14.md`)

| Prior finding | Status in this revision | Evidence |
|---|---|---|
| **A-01** Locking does not revoke an active LAN share | **Fixed** | `src/App.tsx:329-334` calls `shareRepo.stop()`; `reap()` clears the snapshot before the listener is signalled (`src-tauri/src/share.rs`); Settings states that locking ends sharing |
| **A-02** LAN share is plain HTTP with the code in the URL | **Unchanged, now disclosed in the UI** | `src/pages/SettingsPage.tsx` shows an explicit unencrypted-HTTP warning; transport design unchanged (see §6) |
| **A-03** The verification gate skips Rust tests | **Fixed** | `package.json:14` and `:20` — `verify` runs `test:rust` before clippy/fmt |
| **A-04** Backup import has no size/entry/expansion limits | **Fixed** | `src/lib/backup.ts:27-32,208-260` (256 MB / 512 MB / 10 000 entries / 16 MB manifest / 5 000 photos / 25 MB per photo) enforced in the `unzipSync` filter before bytes are allocated, plus a `File.size` pre-check in the UI |
| **A-05** Quality enforcement is local and opt-in | **Partially fixed** | `.github/workflows/verify.yml` exists; there is no evidence it is required on `main`, and no demonstrable run (I-01) |

The audit's "Strengths confirmed" list still reads accurately. Its remaining
recommendations map to M-03 (verify exports on device), L-07 (document the signature
version requirement) and I-01 (make CI real).

---

## 6. Considerations for the A-02 decision (LAN sharing)

The transport is unchanged: `Server::http`, code in the query string, plaintext on the
wire, `0.0.0.0` bind. The mitigations in place are good (per-session opt-in that never
survives a restart, ~30-bit code, constant-time compare, ten-attempt shutdown, Host
allowlist, GET only, 512 KiB cap, no DB/keyring/FS access, no-store/nosniff/referrer
headers, a phone page with a tight CSP, and now an explicit warning in Settings plus a
statement that locking ends the session).

What remains is a product decision, not a defect: anyone who can observe the Wi-Fi (or who
is on the same subnet and guesses within ten tries) can read the snapshot — wallets,
tasks, reminders, birthdays, warranty dates and note excerpts. If sharing stays in the
first release, the honest framing is "trusted private network only, treat the link as a
password", which the UI now says. If it is to be hardened, the cheapest meaningful step is
a QR code (typing a 40-character URL on a phone is the weak link, already noted in
`SESSION_MEMORY.md`) and, beyond that, a per-session self-signed TLS certificate whose
fingerprint the phone verifies. Dropping sharing from 0.1.0 is also defensible and costs
nothing structurally.

---

## 7. Recommended order of work

1. **M-03 verification** — before any release: prove export writes a file on the target OS,
   or replace the mechanism. Everything else is recoverable; a phantom backup is not.
2. **M-01** — draft persistence or a discard guard in Notes/Journal (plus the regression
   test the prior audit asked for).
3. **L-07 + L-05** — document the signature-version rule; add a version-consistency check
   to the gate. Both are small and both protect the first release.
4. **L-06** — reconcile the documents with the code (audit status, hook comment, session
   template, README's `npm run dev` claim).
5. **I-01** — enable/require CI on `main` and pin the third-party actions.
6. **M-02** — plan the raw-bytes/thumbnail work as its own phase; it is the only item here
   that is architecture rather than a fix.
7. **L-01, L-02, L-03, L-04** — cheap hardening (navigation allowlist, lock-screen delay,
   remove or document the transaction commands, boot-error dialog).
8. Re-run the **full** gate including `cargo test`, `cargo clippy`, `cargo fmt --check`
   and `npm run tauri build` on the release machine — this review could not run the Rust
   half, and the release checklist should record that evidence.

---

## 8. Appendix — metrics observed

| Metric | Value |
|---|---|
| Repository size | 171 tracked files (119 excluding the icon set) |
| TypeScript + TSX | 19 198 lines across `src/` (of which 3 288 are tests) |
| TypeScript tests | 3 288 lines, 26 files, **193 tests passing** |
| Rust | 2 411 lines; 35 `#[test]` (15 `db`, 15 `share`, 5 `photos`) — not executed in this review |
| Docs | 2 490 lines across `README.md` + `docs/*.md` |
| IPC commands | 14 registered (11 used by the app; 3 dead — L-03) |
| Schema | 29 tables at `user_version = 1` (28 regular + `notes_fts`), 3 FTS triggers, 8 indexes, seeded wallets/categories |
| Front-end bundle | 583.21 kB JS (161.84 kB gzip) + 78.61 kB CSS (13.57 kB gzip), single chunk |
| Dependencies | 0 known vulnerabilities (`npm audit`, full tree); no Rust advisory scan run (no crates.io access here) |
| Releases published | **0**; 1 merged PR (#1), no status checks recorded |
| Working tree at review time | Clean at `76f4e8d` |

### Evidence commands, in the order they were run

```bash
npm ci
npm run token-lint && npm run lint && npm run typecheck
npm test
npm run build
npm audit && npm audit --omit=dev
gh release list -R minlulin/PurpleMemo
gh pr list -R minlulin/PurpleMemo --state all
gh pr view 1 -R minlulin/PurpleMemo --json statusCheckRollup
gh auth status
# upstream verification (GitHub API, contents endpoints)
#  tauri-apps/plugins-workspace  plugins/updater/src/config.rs        @ updater-v2.13.3
#  tauri-apps/plugins-workspace  plugins/updater/CHANGELOG.md
#  tauri-apps/tauri              crates/tauri-cli/src/helpers/updater_signature.rs @ tauri-cli-v2.12.2
#  tauri-apps/tauri              crates/tauri-cli/src/bundle.rs       @ tauri-cli-v2.12.2
#  tauri-apps/tauri              crates/tauri-runtime/src/webview.rs  @ tauri-v2.12.3
#  tauri-apps/tauri              crates/tauri-runtime-wry/src/lib.rs  @ tauri-v2.12.3
#  tauri-apps/tauri              crates/tauri/src/ipc/protocol.rs     @ tauri-v2.12.3
#  tauri-apps/wry                src/webview2/mod.rs                  @ wry-v0.57.0
#  tauri-apps/wry                src/wkwebview/{mod.rs,download.rs}   @ wry-v0.57.0
# FTS5 assignment behaviour checked locally with Python's sqlite3 (3.40.1)
```
