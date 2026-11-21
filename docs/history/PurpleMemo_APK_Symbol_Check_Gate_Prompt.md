# Prompt — Add the .so symbol check to the Android APK gate

Give this prompt to the PC agent (OpenCode / Codebuff). It runs on the PC,
where the signed release APK lives — the VM clone has no APK, so the pass-path
proof cannot be done there. One session, one commit on `dev`, then STOP and
report. Do not merge to `main`, do not bump any version, do not touch release
artefacts.

## Why this exists

On 2026-11-18 a release APK passed the APK gate, installed, and failed only
on the phone with `dlopen: cannot locate symbol "EVP_MAC_fetch"`. Cause
(commit `97d9398`): the make shim named one response file per archive, but
OpenSSL archives `libcrypto.a` in three chunked `ar` lines, so all three read
the last chunk and the archive shipped without crypto/evp. The Rust cdylib
links happily with undefined symbols, so nothing failed until the phone tried
to load it. The hand check afterwards found **42 undefined
EVP/CRYPTO/OPENSSL symbols**; the rebuilt `.so` has **0**.

The gate (`scripts/check-android-apk.mjs`, run inside `npm run verify`)
proves signature, ABI and version — it never looks inside the `.so`. That is
the one gap left from that batch. The owner has now decided 0.3.0 ships the
Android APK alongside the desktop build, so this check must be in the gate
before the 0.3.0 release APK is handed over.

## Goal

Extend `scripts/check-android-apk.mjs` so that, whenever a release APK is
present, the gate also fails when `lib/arm64-v8a/libpurple_memo_lib.so`
carries undefined dynamic symbols from the OpenSSL family — the exact failure
class that shipped once already.

## Scope — these files only

- `scripts/check-android-apk.mjs` (the check itself)
- `scripts/check-android-apk.test.mjs` (new — the fail-path proof, see §4)
- `README.md` — the one gate line describing what the APK step checks
- `docs/ANDROID_DISTRIBUTION.md` §3 — the fail-list and the hand-off record

Out of scope: the Rust code, the make shim, the Gradle guard, `key.properties`
/ the keystore, version numbers, any hosted CI. Do not read
`key.properties` — the existing rule in the script header stands (a gate
that prints its own output must never handle store/key passwords).

## Requirements

### 1. Extract the `.so` with Node stdlib only

The script already parses the APK zip central directory. Extend that to
locate `lib/arm64-v8a/libpurple_memo_lib.so` and extract it (parse the local
file header, `zlib.inflateRawSync` for deflated entries, stored entries as-is)
into a temp file. No new dependency and no `unzip` binary — this must work on
the Windows release machine.

### 2. Find the symbol tool, NDK first

Look for `llvm-readelf` in this order: `ANDROID_NDK_HOME`, then the newest
`ndk/*` under `ANDROID_HOME` (and `ANDROID_SDK_ROOT`), then a system
`readelf` on the `PATH` (Linux). Handle the Windows `.exe` name. Print which
tool was used. If an APK is present but no tool is found, **fail closed**
with a remedy naming how to get one (NDK via the SDK manager) — an APK that
cannot be verified must not be handed over. This matches the existing
`SDK_REMEDY` philosophy.

### 3. The check itself

Run `<tool> --dyn-syms <extracted .so>` and parse the undefined (`UND`)
dynamic symbols. **Fail** when any undefined symbol matches
`^(EVP|CRYPTO|OPENSSL|SSL)_` — print every offending name (or the first 20
plus the count) in the failure message.

Do NOT fail on other undefined symbols: a Rust cdylib legitimately leaves
libc/libm/liblog/libandroid symbols undefined for the loader to resolve.
The scope is exactly the proven failure class.

On success, add one line to the existing OK block, e.g.
`0 undefined EVP/CRYPTO/OPENSSL symbols in libpurple_memo_lib.so`, so the
hand-off record beside `git rev-parse HEAD` shows the check ran.

Keep the existing behaviour unchanged: skip with a line when no APK exists,
and keep every existing check (signature, debug key, single signer,
arm64-only, versionCode/versionName) exactly as it is.

### 4. Prove the fail path with a test

The broken APK from `97d9398` no longer exists, so the fail path cannot be
proven against a real artefact. Prove it with a test instead:
`scripts/check-android-apk.test.mjs` using `node:test`, runnable with
`node --test scripts/check-android-apk.test.mjs`. Structure the symbol
parsing as a pure function the test can import (or otherwise make the parser
directly testable) and cover at least:

- (a) clean `llvm-readelf --dyn-syms` output → 0 offending symbols;
- (b) output containing `UND EVP_MAC_fetch` and another `UND CRYPTO_*`
  symbol → both reported;
- (c) output containing only `UND` libc-style symbols (e.g. `__cxa_*`,
  `memcpy`) → 0 offending symbols, i.e. not a false positive.

### 5. Docs

- `README.md`: extend the APK gate line to include the symbol check.
- `docs/ANDROID_DISTRIBUTION.md` §3: add the symbol failure to the
  fail-list, and add the symbol count to the hand-off record paragraph.
  Do not rewrite anything else in either file.

## Verify and report — then STOP

1. Full `npm run verify` green on the PC clone.
2. `npm run check:android-apk` (or
   `node scripts/check-android-apk.mjs --apk <path>`) against the actual
   signed release APK on the PC — the OK output, including the
   `0 undefined EVP/CRYPTO/OPENSSL symbols` line, is the pass-path proof.
3. `node --test scripts/check-android-apk.test.mjs` green — the fail-path
   proof.

Commit as one commit on `dev`, push to `dev` only after the full gate is
green, then STOP and report: the commit hash, the full-gate result, and the
APK check output pasted verbatim. Do not fix anything else found along the
way — report it instead. Muus will audit the commit afterwards.
