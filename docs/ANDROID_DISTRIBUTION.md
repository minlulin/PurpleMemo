# Purple Memo — Android distribution: sign, install, upgrade, roll back

Phase B, decision 12 in `docs/ANDROID_DESIGN.md`: the phone build ships as a
**signed APK, sideloaded, arm64-v8a only**. In-app updates stay desktop-only
(`docs/RELEASE.md`); the updater plugin is not linked into the mobile build, and
the phone never polls GitHub.

Everything here runs on the PurpleShade PC. Nothing in this document touches
the Redmi: the device steps are a checklist for its owner, and the x86_64
emulator cannot take the release APK at all (decision 11 — release is
arm64-v8a only).

## 1. One-time: create the signing key

The key is **not** in this repository and must never be. Keep it outside the
working tree (for example `%USERPROFILE%\android-keys\`), back up the `.jks`
*and* its passwords somewhere safe, and treat losing them as losing the upgrade
path: Android refuses to install an APK signed by a different key over an
existing one.

```bash
keytool -genkeypair -v \
  -keystore "$USERPROFILE/android-keys/purple-memo-release.jks" \
  -alias purple-memo \
  -keyalg RSA -keysize 4096 -validity 10000
```

Then point the Android project at it through the **gitignored**
`src-tauri/gen/android/key.properties` (the generated project's `.gitignore`
already excludes it):

```properties
storeFile=C:\\Users\\purpl\\android-keys\\purple-memo-release.jks
storePassword=<store password>
keyAlias=purple-memo
keyPassword=<key password>
```

Two facts about the generated project, so nobody hunts for them:

- `src-tauri/gen/android/app/build.gradle.kts` has **no `signingConfigs` block**
  of its own; the Tauri CLI's Android build wires release signing from
  `key.properties` when that file exists. With no `key.properties`, a release
  build is not release-signed — the CLI falls back to the debug keystore (or
  produces an unsigned APK, depending on the CLI version), which must never be
  handed to a user.
- `key.properties` and any `*.jks`/`*.keystore` are ignored by git; a
  `git status` that shows either is a bug to fix before committing.

## 2. Build the signed release APK

The environment preamble (NDK bin on `PATH`, `CC_/AR_/RANLIB_` for the target,
the perl and `make` shims) is in `docs/ANDROID_TOOLCHAIN.md` — the same recipe
the debug build uses, with the compiler variables named for `aarch64`:

```bash
env CC_aarch64-linux-android=aarch64-linux-android24-clang \
    AR_aarch64-linux-android=llvm-ar \
    RANLIB_aarch64-linux-android=llvm-ranlib \
    npx tauri android build --apk --target aarch64
```

`app/build.gradle.kts` refuses any release build whose ABI list is not exactly
`arm64-v8a`, so `--target x86_64` (and a bare release build, which would default
to all four ABIs) fails at configuration time rather than shipping an extra
ABI.

Output:

```
src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

## 3. Verify before anyone installs it

```bash
APK=src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk

# Which key signed it, and does the signature actually verify?
$ANDROID_HOME/build-tools/37.0.0/apksigner verify --print-certs "$APK"

# The bytes a user can compare against what they were told to download.
sha256sum "$APK"

# The APK is arm64 only, and carries the release Rust library.
unzip -l "$APK" | grep -E "lib/.*/libpurple_memo_lib\.so"
```

`apksigner verify` must print `Verifies` and the certificate's SHA-256 digest
must match the release key's. The `unzip` line must list
`lib/arm64-v8a/libpurple_memo_lib.so` and no other ABI.

**Reproducibility.** Two builds from the same commit use the same commands and
produce APKs with the same signing certificate and the same version code; the
file hashes may differ because AGP stamps build time into the archive. What is
reproducible, and what is checked here, is: the same source builds, the same key
signs, the signature verifies, and the ABI set is unchanged. Record the SHA-256
of the artefact you actually hand over, with its `git rev-parse HEAD`.

## 4. Install on the Redmi (owner's checklist)

Do these on the phone itself; the agent that wrote this document never touched
it.

- [ ] `adb -s 4c61bf7a install -r app-universal-release.apk` — or copy the APK to
      the phone and open it with the file manager, allowing "install unknown
      apps" for that file manager only.
- [ ] Launch **Purple Memo** once and complete first-run setup (PIN).
- [ ] Confirm **Settings → Diagnostics** shows the expected schema version and a
      non-zero database size.
- [ ] Confirm the phone's Keystore backing reads `TEE` (or `strongbox`), not
      `software` — the emulator is the software case.
- [ ] Create one reminder in the Tasks page, lock the phone, and confirm it
      notifies at the set time with the app closed.
- [ ] Turn the screen off and take a screenshot attempt from another app (or
      `adb shell screencap`) and confirm the app's content is blocked
      (`FLAG_SECURE`).

## 5. Upgrading an installed build

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml` (they must agree — `npm run verify` checks this), then
   commit.
2. `npx tauri android build --apk --target aarch64` **with the same
   `key.properties`**. The Android `versionCode` comes from
   `tauri.properties`, which the CLI regenerates from the version, so the new
   APK has a higher code automatically.
3. `adb -s 4c61bf7a install -r app-universal-release.apk` — `-r` reinstalls and
   keeps the app's data.
4. Open the app: the PIN still works, records are intact, and the database
   migrates forward on first open (schema migrations are forward-only; see
   `docs/RELEASE.md`).

An upgrade signed with a **different** key fails with
`INSTALL_FAILED_UPDATE_INCOMPATIBLE`. The only way out is uninstalling (which
deletes the app's data) and restoring a backup — so keep one key.

## 6. Rolling back

Rollback is a deliberate, lossy operation on the phone; there is no in-app
downgrade.

- [ ] Take a **backup** first if the data matters (the desktop's backup covers
      the shared tables; the phone's own reminders and settings are
      device-local and are not part of it).
- [ ] `adb -s 4c61bf7a uninstall com.minlulin.purplememo` (or Settings → Apps →
      Purple Memo → Uninstall). This removes the database, the wrapped key and
      the Keystore entry — the next launch is a genuine first run.
- [ ] Install the older APK: `adb -s 4c61bf7a install app-universal-release.apk`.
- [ ] Complete first-run setup again and re-pair/re-import from the desktop.

A database created by a newer schema **cannot** be opened by an older binary —
`db::migration_step` refuses it by design, and the app fails closed with the
wipe/re-pair message rather than corrupting rows. That is why the rollback path
above starts with an uninstall: reinstalling an older APK over the newer data
does not roll the data back.

## 7. What is not covered

- **Play Store distribution** — not planned; sideload only for now.
- **Automatic updates on the phone** — none. The updater is desktop-only; the
  phone's Settings page says sync is off and offers no updater control.
- **Split APKs / app bundles** — a single universal APK per ABI, one file to
  hand over.
- **Older Android than 8.0 (API 26)** — not supported. `minSdk` is **26**
  (`src-tauri/gen/android/app/build.gradle.kts`), so a device running Android
  7.x or older refuses the APK at install time (decision 11; the pin landed in
  the Phase C build session, 2026-11-12).
