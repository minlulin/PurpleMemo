# Purple Memo — Android Build, Sessions 1–2 (Tasks Plan)

Run on the PurpleShade PC (Windows), repo at `E:\CodeSpace\PurpleMemo`, branch **`dev`**.
Model: Mimo 2.6. You are the implementer; MinLulin verifies and commits between sessions.

## Read first (standing context — do not re-decide)

- `docs/ANDROID_DESIGN.md` — full product/design decisions (12 approved decisions + 4 corrections + F9).
- `docs/ANDROID_BUILD_TODO.md` — the phase plan. You are working **Phase 0** only.
- `PurpleMemo_Android_PC_Setup.md` — the environment checklist (Session 1 follows it).

Settled and off-limits for re-litigation: companion-not-port, Tauri mobile, 8 modules
+ Dashboard + Settings, bottom tabs Dashboard|Tasks|Budget|Shopping|More, FAB = creation
only, view + add + mark-done toggles, Keystore before real data, min API 26, arm64-v8a
only, sideload (no Play), manual sync, QR pairing, narrow 17-table sync core, Vault
lookup-only on mobile, first-pair adoption with client-generated UIDs, trash for mutable
entities only, Dashboard shows "recorded balance" (F9 decided: qualifier wording, no
opening-balance column).

Rules for both sessions:
- **Guard the working desktop code.** No behavior changes to the desktop app. If any
  step threatens desktop behavior, stop and report instead of pushing through.
- **Stop-and-report per session.** Finish the session's tasks, then STOP. Report what
  was done, exact versions/commands/outputs, and anything unexpected. Wait for the
  next session order. Do not start the next session's tasks on your own.
- MinLulin commits. Leave changes uncommitted; he verifies and commits before the
  next session.

---

## Session 1 — Build environment setup (one-time)

Goal: the PC can build Android. Follow `PurpleMemo_Android_PC_Setup.md` end to end.

**Task 1.1 — JDK 17 + Android SDK/NDK + environment variables**
- Install Temurin JDK 17 (NOT a newer Java — Gradle 9.6.1 in the Tauri 2.12 template
  breaks on newer). Check "Set JAVA_HOME" during setup.
- Install Android SDK via Android Studio (or standalone cmdline tools): Build-Tools
  (latest), Command-line Tools (latest, required), Platform-Tools, NDK r26+
  (r27.x recommended), one SDK Platform (API 35+).
- Set `ANDROID_HOME` and `ANDROID_NDK_HOME` as user environment variables; reopen
  the shell afterwards.

**Task 1.2 — Rust targets + full verification + test device**
- `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`
- Verify and record exact versions:
  `java -version` (must be 17.x.x), `echo $env:ANDROID_HOME`,
  `rustup target list --installed` (all 4 android targets),
  SDK/Build-Tools and NDK exact versions from SDK Manager.
- Redmi Note 14 Pro+: enable Developer options (tap MIUI version 7×), enable USB
  debugging, connect via USB, accept the RSA prompt, `adb devices` must list it.

**STOP — report back:** every installed version (JDK, Build-Tools, NDK, SDK platform),
`adb devices` output, and any step that deviated from the checklist. Wait for Session 2.

---

## Session 2 — Toolchain pin + project scaffold + debug APK

Prerequisite: Session 1's report was reviewed and committed.

**Task 2.1 — Pin the toolchain + generate the Android project**
- Record the exact pinned versions (JDK, SDK Build-Tools, NDK, Rust targets) from
  Session 1 — these are the project's pinned toolchain going forward.
- Run `npm run tauri android init` in the repo. Curate `src-tauri/gen/android` in git
  **despite** the default `gen/` ignore: commit the generated project, but exclude
  build outputs, local SDK paths, and any signing material.
- Confirm the desktop app still builds: `npm run verify` must be **green**
  (this is the standing pre-push gate; nothing in this task may break it).

**Task 2.2 — Debug APK on the Redmi**
- Build the Android debug APK and install it on the Redmi via USB.
- Launch it: the app must start and show its first screen without crashing.
  (No features are expected to work yet — this is a feasibility build only.)
- Re-run `npm run verify` for the desktop side; still green.

**STOP — report back:** pinned versions, `android init` output summary, what was
curated in git vs excluded, debug APK install/launch result, `npm run verify`
result. Wait for the next session order (Phase 0 contract work: UID contract,
sync/restore/key contracts, raw-IPC probe — NOT this session).

---

## Explicitly NOT in these two sessions

- Keystore / real data / any personal-data builds (Phase A).
- UID contract, sync protocol, pairing UI, backup/restore rules (later Phase 0 sessions).
- Any Phase A/B/C implementation.
- Play Store, release signing, `gen/android` build outputs in git.
