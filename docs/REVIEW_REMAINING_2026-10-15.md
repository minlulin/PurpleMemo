# What remains from the 2026-10-14 code review

**As of:** 2026-10-15 · tree at `6897b55` plus the uncommitted work listed in §6
**Subject:** every finding in [`docs/CODE_REVIEW_2026-10-14.md`](CODE_REVIEW_2026-10-14.md)
(M-01…M-03, L-01…L-07, I-01…I-03), its §6 A-02 decision list, its §7 work
order, and the P5 gate items it leaves to the owner.

This document is the "what is left" companion to that review: the review is the
historical record and is not rewritten; this file is re-verified against the
code, so a status here beats a status there where they disagree.

## 1. Status at a glance

| ID | Severity | Status | Evidence (re-checked 2026-10-15) |
|---|---|---|---|
| M-01 | Medium | **Closed** | `2f9d67e`; `src/lib/drafts.ts` + `drafts.test.ts` (round-trip tests); `NotesPage.tsx` / `JournalPage.tsx` both use the drafts store |
| M-02 | Medium | **Closed in the working tree** (uncommitted) | `docs/M02_PHOTO_PIPELINE_PLAN.md`; raw-byte IPC (`tauri::ipc::Response` / raw body + headers), derived thumbnails, export cap + async zip |
| M-03 | Medium | **Closed in code; device verification open** | `278b462` (native Save As through the dialog + fs plugins, toast only after the write); **must be verified on Windows/macOS once** |
| L-01 | Low | **Closed in the working tree** (uncommitted) | `src-tauri/src/navigation.rs` — own-origin allowlist, `devUrl` origin only in a dev build — plus `src/components/MarkdownLink.tsx`, which sends external links to the system through opener 2.7.2; 4 Rust + 5 TS tests |
| L-02 | Low | **Closed** | `6897b55` (retry delay) + the acknowledgement gate on the PIN reset; throttle covers both paths |
| L-03 | Low | **Closed by decision** | `6897b55`: the three commands are documented as plan-mandated and covered by `manual_transaction_*` tests |
| L-04 | Low | **OPEN — implemented in the working tree, uncommitted and unverified** | see §2.2 |
| L-05 | Low | **Closed** | `2df4a18`; `scripts/check-versions.mjs` ran today → "all three manifests agree on 0.1.0" |
| L-06 | Low | **Closed** | audit carries a "historical" status note; README's `npm run dev` claim is gone; the hook comment and README both state local-only CI; `SESSION_MEMORY.md` no longer claims `gh` is absent |
| L-07 | Low | **Closed** | `2df4a18`: RELEASE.md documents that the signature must carry the version (`tauri build`, or `--app-version`) |
| I-01 | Info | **Decision recorded** | hosted CI is out of scope; `.github/workflows/` now holds no files |
| I-02 | Info | **OPEN** | no DOM/component harness; `App.tsx` and the 15 pages remain untested; the A-01 regression test ("locking ends sharing") still does not exist — no test file mentions `lockNow` |
| I-03 | Info | **Closed** | biome's recommended preset already fails on `dangerouslySetInnerHTML` and `eval` (probed 2026-10-15); `docs/PLAN.md` §5 item 5 now states the full-trust invariant |

## 2. Item detail

### 2.1 L-01 — unrestricted webview navigation — **closed in the working tree**

`src-tauri/src/lib.rs` now registers a plugin `on_navigation` hook
(`src-tauri/src/navigation.rs`): a navigation is allowed only when its origin is
the app's own — `tauri://localhost` (Linux/macOS) or `http(s)://tauri.localhost`
(Windows) — with a single exception, the frontend `devUrl` origin, and that
exception is gated on `tauri::is_dev()`, a property of the **build**, so a `devUrl`
left in a shipped config cannot become a route to a local server. It is a plugin
hook rather than `WebviewWindowBuilder::on_navigation` because that builder API is
creation-time only and the main window is declared in `tauri.conf.json`.

The front end no longer leans on the guard: `src/components/MarkdownLink.tsx`
(used by `NotesPage.tsx` and `JournalPage.tsx`) routes external links
(`http`/`https`/`mailto`/`tel`) to the system through the opener plugin —
`tauri-plugin-opener` / `@tauri-apps/plugin-opener` 2.7.2, max stable 2.x on both
sides, with the capability entries `opener:allow-open-url` and
`opener:allow-default-urls` (`src-tauri/capabilities/default.json`) — lets
in-document anchors scroll, and makes everything else — relative paths,
`javascript:`, `data:`, `file:` — inert.

Evidence: 4 Rust tests in `navigation.rs` and 5 TS tests in `src/lib/links.test.ts`
pin the two pure rules; in `tauri dev` the hook was observed allowing the app's own
startup navigation with zero blocked navigations. Plan §3 and §4 carry the
dependency and the rule, and §5 item 5 states the renderer invariant (I-03).
Not observed here: the OS handler the opener delegates to (the click path was driven
against a stubbed opener, which proves the *right URL* is handed over and that
`javascript:`/relative links never are, but not that a browser window opens on this
machine), and a real navigation being *blocked* — nothing but the pure predicate can
be exercised without a WebDriver session for the webview.

Still to do: commit it, and re-check the window's own origin on Windows/macOS,
which this environment cannot observe.

### 2.2 L-04 — boot failure was a silent exit

The working tree already contains an implementation (`report_boot_failure`,
`looks_like_keyring_failure`, `dirs_next_to_db`, two tests in
`src-tauri/src/lib.rs`) that replaces `.expect("error while running Purple
Memo")`: it writes `boot-error.log` next to the DB, prints the message to
stderr and exits non-zero, adding the credential-store hint when the message
looks like a keyring failure. It compiles and its tests pass on today's tree.

Three things still stand between that and "closed":

1. **It is uncommitted** and is not part of any reviewed change — see §6.
2. **The review asked for something the user sees.** A log file next to the DB
   is better than a silent exit, but on a headless Linux box or a locked
   keyring the user still gets no window and no explanation. The dialog plugin
   and its `dialog:default` capability are already in place (added for the
   backup export), so a native error dialog is a small addition.
3. **It has never run against the failure it exists for.** The trigger is
   environmental (no OS credential store), which cannot be produced here; the
   path is covered only by unit tests of the message heuristic.

### 2.3 I-02 — no test harness for the shell or the pages

The suite is deliberately pure-logic (`node --test "src/**/*.test.ts"`), and
that is still where the value is. What it cannot reach:

- the A-01 fix: `App.tsx:329-335` (`lockNow` → `vaultRepo.lockVault()` +
  `shareRepo.stop()`) has no test, and the previous audit asked for one;
- the M-02 gallery lifecycle (thumbnails, one full-resolution image at a time,
  object-URL release) — verified by hand in a browser during that phase, but
  nothing prevents a regression;
- every page-level rule that is not a pure helper.

Either add a harness (jsdom/vitest, a new dependency and a plan decision) or
extract the lock/share/poll coordination out of `AppShell` into a testable hook
— the review's own cheaper suggestion, still unclaimed.

### 2.4 I-03 — the full-trust invariant — **closed**

The renderer can run arbitrary SQL and export the database key, so the front end
must never execute foreign code. Both halves now hold: biome's recommended preset
fails the build on `dangerouslySetInnerHTML` and `eval` (both probed on 2026-10-15,
both error under `npm run lint`), and `docs/PLAN.md` §5 item 5 states the
invariant as design — strict CSP, no remote content, those two linter errors,
markdown rendered without raw HTML, and no navigation away from the app's own
origin (the L-01 fix above).

### 2.5 M-03 — the Windows/macOS export verification

The code path is right (native Save As → `writeFile`/`writeTextFile` → toast
naming the real path; failures land in the error banner). What remains is the
review's own gate: **prove on each target OS that the file exists where the
toast says it does.** Not runnable in this environment.

### 2.6 §6 — the A-02 product decision (LAN sharing)

The transport is unchanged (plain HTTP, code in the query string, `0.0.0.0`),
now with an explicit warning in Settings and "locking ends sharing". The
decision the review put to the owner is still open: ship as-is with the
"trusted network only" framing, add a QR code (typing a 40-character URL on a
phone is the weak link), add a self-signed TLS certificate the phone verifies,
or drop sharing from 0.1.0.

### 2.7 P5 gate items (owner actions, now unblocked)

`gh 2.102.0` is installed and authenticated as `minlulin` on this machine, so
both remaining items are actionable today:

1. open a share link from a real phone on the LAN against a release build;
2. publish a signed release and install it from an older build — `tauri build`
   + `scripts/make-latest-json.mjs` + `gh release create`, per RELEASE.md.

### 2.8 §7 item 8 — the release-machine gate

The review could not run Rust at all; today `cargo test` (41), clippy and
`cargo fmt --check` all run and pass, and `npm run verify` is green end to end
(225 TS tests). What has still never run is `npm run tauri build` plus a real
install/upgrade, which needs the release machine and the signing key.

## 3. Accepted — no action

- **I-01** hosted CI: intentionally out of scope (billing); the local pre-push
  hook plus `npm run verify` is the gate, and the README/session template say so.
- **L-03** the three transaction commands: retained deliberately, documented,
  and covered by tests, because §4 of the plan mandates the surface.
- **A-02** the LAN share's plaintext transport is disclosed in the UI; only the
  product decision in §2.6 is outstanding.
- **The "casual-eyes protection" model** for the PIN lock stands as designed.

## 4. What blocks 0.1.0, in the review's own order

1. **M-03 device verification** — a phantom backup is the worst failure mode
   this app has; the code is fixed, the proof is missing.
2. **P5 gate** — a real phone on the LAN, and one hand-published signed release
   installed over an older build.
3. **Release-machine gate** — full `verify` + `tauri build` on the target OS.
4. **Then decide L-04 explicitly.** L-01 is closed in the working tree (I-03
   with it) and needs only a commit; L-04 is small and still *open* rather than
   *accepted*, which is the only reason it would hold a release.

## 5. Not verifiable in this environment

Native webview behaviour (Windows WebView2, macOS WKWebView), device/E2E tests,
`tauri build` and signing, the export worker path in the shipped CSP, and the
`asset:`-protocol alternative to IPC. Anything asserted about those in this
document is read from source, not observed.

## 6. Uncommitted work in the tree (needs a commit/handoff decision)

- **The M-02 phase** (photo pipeline): `src-tauri/src/photos.rs`,
  `commands.rs`, `lib.rs` (two command registrations), `tauri.conf.json` (CSP
  `worker-src`), `src/data/driver.ts`, `mock-driver.ts`, `src/lib/gallery.ts`,
  `backup.ts`, `thumbs.ts`, `GalleryPage.tsx`, their tests, `ipc.test.ts`,
  and `docs/M02_PHOTO_PIPELINE_PLAN.md`.
- **The L-04 boot-failure work** in `src-tauri/src/lib.rs`: present and passing,
  authored outside this change, and not reviewed here.
- **The L-01 navigation work**: `src-tauri/src/navigation.rs`,
  `src-tauri/src/lib.rs` (plugin registration + the hook), `Cargo.toml`,
  `package.json` + lockfile (opener 2.7.2), `capabilities/default.json`,
  `src/lib/links.ts` + `links.test.ts`, `src/components/MarkdownLink.tsx`,
  `NotesPage.tsx`, `JournalPage.tsx`, and the `PLAN.md` / review documentation
  edits.
