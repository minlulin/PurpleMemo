# Codebase audit — 2026-10-14

> **Status note (2026-10-15): this audit is historical — it describes the
> tree as it was on 2026-10-14. Its findings A-01, A-03, A-04 and A-05 are
> all fixed (see the status table in `docs/CODE_REVIEW_2026-10-14.md` §5),
> and its "Recommended release order" is superseded by that review's §7.
> Read this document for the original reasoning; read the code review for
> what remains to do.**

## Executive summary

> **A-05 decision:** hosted CI is intentionally not used because GitHub Actions
> billing is unavailable for this project. The local pre-push hook and
> `npm run verify` are the documented quality gate; this is an explicit
> operating constraint, not an unfinished CI setup.

Purple Memo has a solid local-first foundation. The audited working tree was
clean, the TypeScript and Rust code is strongly checked, database writes are
parameterized, and the encryption/key-management design is thoughtfully
implemented. No critical code-execution, SQL-injection, path-traversal, or
at-rest-encryption defect was found in this audit.

Three release-relevant findings remain:

1. **Important — LAN sharing remains readable after the desktop locks.**
2. **Important — LAN sharing is plain HTTP, so its pairing code and snapshot
   are exposed to a network observer.**
3. **Moderate — the advertised full verification gate does not run the Rust
   test suite.**

One additional hardening item is recommended before a public release:
unbounded backup parsing. Independent hosted CI is intentionally out of scope.

## Scope and method

Reviewed the React/TypeScript application, Tauri/Rust backend, SQLite schema,
crypto, backup/import, LAN sharing, updater configuration, permissions, build
configuration, tests, documentation, and recent Git history. The audit used
static review plus the commands recorded below. It did not include a manual
device test, a signed update installation, penetration testing on a real LAN,
or a successful live dependency-advisory query.

## Verification evidence

| Check | Result |
| --- | --- |
| Working tree | Clean before the report was added |
| `npm.cmd run verify` | Passed: Biome, token lint, strict TypeScript, 189 JS/TS tests, Clippy with warnings denied, Rust format check, production Vite build |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Passed: 34 tests |
| Runtime dependency advisory check | Inconclusive: `npm audit --omit=dev --json` could not reach the npm advisory endpoint in this environment |

`cargo test` emitted Windows linker warnings about unavailable OpenSSL debug
PDB files (`LNK4099`). The executable linked and all tests passed; this is a
debug-symbol diagnostic, not a functional failure.

## Findings

### A-01 — Important: locking does not revoke an active LAN share

**Evidence:** `src/App.tsx:216` stops only the periodic publisher when
`unlocked` becomes false. `lockNow` at `src/App.tsx:329` clears vault keys and
changes UI state, but does not call `shareRepo.stop()`. The Rust listener keeps
its last valid snapshot in memory and continues serving it while the desktop is
locked. The shared snapshot includes wallet balances, tasks, reminders,
birthdays, warranty data, and note excerpts (`src/lib/share.ts:75`).

**Impact:** Anyone who already possesses the pairing link can continue reading
the last shared personal-data snapshot after the user locks Purple Memo. This
conflicts with the intuitive expectation that locking ends active access to
personal data.

**Recommendation:** Stop sharing as part of `lockNow` (best-effort and without
blocking the lock UI), clear the in-memory snapshot, and clearly state in the
UI that locking ends the sharing session. Add a regression test for lock →
share status.

### A-02 — Important: LAN share transfers sensitive data over unauthenticated HTTP

**Evidence:** The server intentionally binds on all interfaces through
`Server::http` (`src-tauri/src/share.rs:150`) and publishes an `http://` URL.
The six-character code (about 30 bits) is carried in the query string
(`src-tauri/src/share.rs:27`, `src-tauri/src/share.rs:278`). The code and every
snapshot response are therefore plaintext on the local network.

**Impact:** A party able to observe or control the LAN can capture the pairing
URL and read the snapshot, or alter traffic. The ten-failed-attempt cutoff
protects against online guessing, but not passive capture or an active
network attacker. This is particularly relevant on shared Wi-Fi.

**Recommendation:** At minimum, present a prominent session-only warning and
recommend trusted/private networks. For stronger confidentiality, replace the
HTTP transport with an authenticated encrypted channel (for example, a
per-session self-signed TLS certificate whose fingerprint/QR code is verified
on the phone), or omit sharing from the first public release.

### A-03 — Moderate: the mandatory verification gate skips Rust test execution

**Evidence:** `package.json:14` runs Clippy and `cargo fmt --check`, but not
`cargo test`. The README describes this command as the full local gate
(`README.md:24-35`), while the release instructions separately run `cargo test`
(`docs/RELEASE.md:39-40`). Critical backend behavior—including SQLCipher setup,
filesystem traversal controls, and the network listener—is covered by Rust
tests that the normal pre-push gate never executes.

**Impact:** A backend regression may be compiled and linted successfully yet
be pushed without its behavior being tested.

**Recommendation:** Add a `test:rust` script and invoke it in `verify` before
the build. Keep the dedicated release command as a redundant check, not the
first time Rust tests run.

### A-04 — Moderate: backup import has no size, entry-count, or expansion limits

**Evidence:** The Settings UI reads the entire selected file into memory
(`src/pages/SettingsPage.tsx:204`) and `parseBackupZip` immediately expands it
with `unzipSync` (`src/lib/backup.ts:197-204`). The parser validates the
post-expansion structure but does not cap compressed size, expanded size,
number of entries, or individual entry size.

**Impact:** An accidentally oversized or deliberately compressed backup can
freeze or exhaust memory in the renderer before validation. Import is a local,
user-initiated action, so this is an availability issue rather than remote
code execution, but it is material for a data-management feature.

**Recommendation:** Check `File.size` before `arrayBuffer`, use a bounded or
streaming ZIP parser where possible, and enforce explicit limits for archive
size, expanded bytes, entries, manifest size, photo count, and per-photo size.
Add rejection tests for each limit.

### A-05 — Low: quality enforcement is local and opt-in per clone

**Evidence:** There is no hosted CI; the README explicitly identifies the
pre-push hook as the only enforcement. Git hooks require a one-time
`core.hooksPath` configuration and can be bypassed.

**Impact:** The project relies on each contributor correctly enabling and
honoring the hook. A malformed or untested change can reach the release branch
outside the intended quality gate.

**Resolution:** Do not add hosted CI. GitHub Actions billing is unavailable for
this project, so the local pre-push hook and `npm run verify` remain the only
quality gate. Every clone must configure `core.hooksPath` as documented in the
README, and release verification must include the local gate output.

## Strengths confirmed

- SQLCipher keys are randomly minted, stored in the OS credential store, and
  verified before schema work. The database uses WAL and foreign keys.
- SQL values are parameter-bound. Backup-controlled identifiers are checked
  against a strict grammar before interpolation.
- Photo read/delete use a strict relative-path grammar; the tests cover common
  traversal attempts.
- Vault records use AES-256-GCM with fresh per-item salt and IV, and PIN/vault
  derivation uses PBKDF2-SHA-256 at 600,000 iterations.
- The app capability set is small: core, updater, and notification only. The
  application CSP is restrictive, and the share page renders user values as
  text rather than injecting HTML.
- The share listener exposes only GET endpoints, validates Host headers,
  accepts a bounded snapshot, and has no database, keyring, or filesystem
  access.
- Backup restore uses a database batch, restores foreign-key enforcement in a
  `finally` path, and cleans newly written files on a failed restore.
- TypeScript is strict (`noUncheckedIndexedAccess`, unused-code checks) and
  the project has meaningful unit coverage around money, date, lock, backup,
  vault, share, and data consistency behavior.

## Recommended release order

1. Resolve A-01 and decide whether A-02's LAN-sharing risk is acceptable for
   the first public release.
2. Add Rust test execution to `npm run verify` (A-03).
3. Add backup resource limits (A-04).
4. Keep the local-only quality gate enabled and record its output for releases (A-05).
5. Re-run the full gate, Rust tests, a live dependency advisory scan, a real
   phone-on-LAN test, and a signed-update installation rehearsal.

## Audit conclusion

The codebase is not blocked by a critical static-review finding. It should not
be treated as release-ready until the active-share-after-lock behavior and the
plain-LAN-transport decision are explicitly addressed, and the ordinary gate
runs the Rust tests it is intended to protect.
