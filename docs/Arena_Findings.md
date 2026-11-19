# Arena review — Purple Memo

**Date:** 2026-11-19
**Base:** `fcd7c8451236f85d70a62e29986b1f5cf0f1deb8` on `dev`
**Branch:** `arena/f4055414-purplememo`
**Scope:** concrete improvements — bugs, risky code, missing tests, documentation gaps and developer-experience fixes, highest value first.

This document is a review record. It changes no application code, schema, configuration or test.

## What was checked

- `npm test` — 1,154 tests passed.
- `npm run typecheck` and `npm run lint` — clean.
- `scripts/check-references.mjs`, `check-versions.mjs`, `token-lint.mjs`, `dead-code.mjs`, `check-signing-key.mjs`, `check-android-apk.mjs` — pass or skip as designed.
- Rust tests, clippy and `cargo fmt --check` were **not run**: no Rust toolchain was available in the review environment. Rust-side statements below are code-reading evidence unless marked otherwise.
- The previously recorded SW-01…SW-12 sync findings were checked against this tree and are addressed in code; they are not repeated here.

A few findings below were confirmed with small scratch probes against the real modules (no scratch files were left in the repository):

- `parseMMK("1,,2")` returns `120000`, while `isPartialAmount("1,,2")` is `false`.
- `VaultRepo.unlock()` with `vault_verify = "{}"` throws `TypeError`; with `{"salt":"!!!"}` it throws `InvalidCharacterError`.
- `buildMatchQuery`, `addDays` and `datesInMonth` behave as described in the lower-priority date note.

---

## 1. HIGH — `mailto:` and `tel:` links are broken on Android

**Files:** `src/lib/links.ts:47`, `src/components/MarkdownLink.tsx:44-54`, `src/lib/externalLinks.ts:21-39`, `src-tauri/src/external_links.rs:30-43`

`routeLink()` classifies `http`, `https`, `mailto` and `tel` as external. On Android, `MarkdownLink` sends **every** external URL through `openExternalUrl()`. That validator, and the Rust command behind it, accept only absolute `http(s)` URLs. A phone number or email link in a note therefore always ends in a “link failed” toast on the phone, while the same link opens on the desktop through the opener plugin.

**Why it matters:** notes and journal entries are the app's primary content, and contact-related markdown links are a normal use case. The two layers currently pin contradictory contracts: `src/lib/links.test.ts` asserts `mailto`/`tel` route externally, and `src-tauri/src/external_links.rs` tests assert they are refused.

**Improvement:** make routing platform-aware, or implement the appropriate Android intents (`ACTION_DIAL` for `tel:`, `ACTION_SENDTO` for `mailto:`) behind the same validated boundary. Add a platform × scheme test matrix so the two layers cannot drift again.

## 2. HIGH — A malformed stored vault verifier throws raw runtime errors

**File:** `src/lib/vault.ts:162-182`

`verifyStored()` casts `JSON.parse(raw)` to `VaultVerifier` without checking its shape, unlike the item-row path hardened through `src/lib/crypto.ts`. Confirmed with the real repository over a mock driver:

- `vault_verify = "{}"` → `TypeError: Cannot read properties of undefined (reading 'length')`
- `vault_verify = "null"` → `TypeError: Cannot read properties of null (reading 'salt')`
- `vault_verify = "{\"salt\":\"!!!\"}"` → `InvalidCharacterError`

The intended refusal is a named corruption error, not an exception from WebCrypto or base64 decoding. A damaged or crafted backup can put the vault into an opaque broken state, and the UI has no useful message to show.

**Why it matters:** backups are user-selected files, and `settings` rows travel in them. The import path validates its table set, cents, links and Trash snapshots, but not this verifier, so a bad one reaches unlock unchallenged.

**Improvement:** validate the verifier's fields with the same byte-length/base64 rules used for vault items, at both unlock and backup import. Add tests for absent, null, non-object, wrong-type and malformed-base64 verifiers.

## 3. HIGH — Money input accepts misplaced thousands separators

**Files:** `src/lib/money.ts:43-66`, `src/pages/BudgetPage.tsx:865-876,949-958`

`parseMMK()` removes every comma before validating, so `"1,,2"` becomes cents for **1,200.00**. `isPartialAmount()` rejects the same string, so the form renders “Enter a valid amount” while the Save button stays enabled because the submit guard only checks `parseMMK(amountRaw) === null`. A pasted or mistyped separator can silently change a financial amount by orders of magnitude.

**Why it matters:** this is a money-recording app; the parser's result is what crosses IPC into SQLite. The UI's own validation already says the input is wrong, so the disagreement is visible to users as well as to tests.

**Improvement:** validate grouping (or reject any comma not between digits) and derive both predicates from one accepted grammar. Add cases for `1,,2`, `,5`, `1,2,3` and trailing commas to `src/lib/money.test.ts`.

## 4. MEDIUM-HIGH — The final sync acknowledgement write can escape as an exception

**File:** `src/lib/sync/syncSession.ts:491-499`

Every push, pull, apply, report and status failure in `runSync()` is converted into a `SyncOutcome`. The final `await transport.batch(ackStatements(input.desktopDeviceId, status.throughSeq))` is the one write that is not wrapped. A local database error there throws into `MobilePairingCard` as a raw message, losing the structured result including `pulled` and `appliedThrough`.

**Why it matters:** the acknowledgement is the step that makes pushed rows prunable. A failure there needs the same honest, structured outcome as every earlier failure; the current path makes diagnosis harder and drops information the caller had already gathered.

**Improvement:** wrap the ack batch like the other steps, return a refusal (or a distinctly reported partial outcome), and add a test that forces the ack batch to fail.

## 5. MEDIUM — Journal dates are validated by pattern, not as real dates

**Files:** `src/lib/journal.ts:94-104`, `src/lib/dates.ts:39`, `src/lib/exports.ts:292-298`

`upsertEntry()` checks only `/^\d{4}-\d{2}-\d{2}$/`, so an impossible date such as `2026-13-45` or `2026-02-31` is accepted. `datesInMonth()` then never shows the entry in the calendar, and `journalExportPath()` exports it under an impossible date path. Imported backups can carry such rows because the column has no `CHECK` constraint.

**Why it matters:** the entry is effectively invisible in the UI but still exported and backed up. The repository already owns `isValidISODate()` for exactly this rule; task and contact imports use it, so journal is the inconsistency.

**Improvement:** call `isValidISODate()` in `upsertEntry()` and add month-end/rollover cases to `src/lib/journal.test.ts`.

## 6. MEDIUM — The Android release compiler workaround is still unverified

**Files:** `src-tauri/Cargo.toml` (`[profile.release.package.icu_locale_core]`), `docs/ANDROID_BUILD_TODO.md:336-343`

The per-package `opt-level = 3` override is annotated “UNVERIFIED (no release build has completed yet)” and is a candidate workaround for a rustc ICE in `icu_locale_core`. The signed release APK is still parked as a release-time item.

**Why it matters:** this changes the optimisation profile of a dependency in the shipped Android binary. Leaving an unverified workaround on the release path means either an unexplained binary difference or a release that still fails at the same ICE.

**Improvement:** reproduce the release build with the current toolchain, then keep the stanza with evidence or remove it. Record the result in `docs/ANDROID_BUILD_TODO.md`.

## 7. MEDIUM — Neither language toolchain is pinned

**Files:** repository root (no `.nvmrc`, `.node-version` or `rust-toolchain.toml`), `package.json`, `README.md`

The package declares `engines.node >= 24` and `.npmrc` sets `engine-strict=true`, but there is no version file; a fresh clone on Node 22 cannot run `npm ci` without an override (this review had to use `--engine-strict=false`). Rust declares `rust-version = "1.77.2"` but requires clippy and rustfmt through manual `rustup` steps, while the release profile depends on compiler-specific behaviour.

**Why it matters:** gate results are not reproducible across machines, and a contributor can spend a long time diagnosing a toolchain mismatch that a pin file would prevent.

**Improvement:** add a Node version file and a `rust-toolchain.toml` with the required components, and point the README setup steps at them.

## 8. MEDIUM — No automated signal on pull requests

**Files:** `README.md` (“Local gate”), `.githooks/pre-push`, `scripts/check-hooks.mjs`

Verification is entirely local: the pre-push hook runs `npm run verify`, and `check-hooks.mjs` deliberately fails while `core.hooksPath` is unset. There is no hosted CI. Reviewers therefore cannot see whether a PR passes even its cheap checks; recent audit PRs explicitly reported that Rust tests were unexecuted.

**Why it matters:** a green gate on one developer's machine is the only evidence for a change, and it is not attached to the review artifact. This is an explicit owner decision, so it is a trade-off to revisit rather than a defect: a minimal PR workflow running lint, typecheck and JS tests would give reviewers a signal without changing the hand-built release process.

## 9. LOW-MEDIUM — The Android progress record is stale on settled decisions

**File:** `docs/ANDROID_BUILD_TODO.md:24,351,394,1077`

The document still says the §13.1 reminder-owner decision is open, the restore-generation bump is unimplemented, “nothing calls the store”, and the harness invariants are pending. All four are false at this commit; `src/lib/sync/protocol.ts` even carries a `SETTLED_DECISIONS` entry to stop the decision being reopened. `scripts/check-references.mjs` checks that paths exist, not that prose is still true, so this does not fail any gate.

**Why it matters:** a reader following the TODO can re-open settled design work or assume safety machinery is absent when it is present. Mark historical entries as superseded, or add a current-status summary at the top.

## 10. LOW — Schema module header describes an older schema

**File:** `src-tauri/src/schema.rs:3-11`

The header says “39 tables at `PRAGMA user_version = 10`” and seven sync tables. At this commit `SCHEMA_VERSION = 12`, `src-tauri/src/db.rs:2191` describes a 41-table baseline, and migrations v11 and v12 added `sync_uid_aliases` and `sync_tombstone_gc_log`.

**Why it matters:** this header is the first thing a reader sees before adding a migration. A one-paragraph correction prevents the next change from being planned against a stale table count.

## 11. LOW — Targeted tests for the findings above are missing

**Files:** `src/lib/externalLinks.test.ts`, `src/lib/vault.test.ts`, `src/lib/money.test.ts`, `src/lib/journal.test.ts`, `src/lib/sync/syncSession.test.ts`

Coverage is high overall, but these suites do not exercise: platform × URL-scheme routing, malformed verifier shapes, malformed comma placement, calendar-invalid journal dates, or a failing final ack batch. Each is a small, deterministic test that would have caught a user-visible regression in its corresponding module.

---

## Bottom line

The repository is in good shape: the JS suite, typecheck and lint are green, and the major sync bugs from the previous audit have been fixed. The most valuable next work is the Android link-scheme mismatch, verifier/amount input validation, and the unguarded sync ack write. The remaining items are straightforward hardening and record-keeping improvements.