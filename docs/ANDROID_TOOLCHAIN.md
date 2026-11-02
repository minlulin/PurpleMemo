# Purple Memo — Android toolchain (pinned)

Pinned in Phase 0, Session 2 (2026-11-02) from the machine verified in Session 1.
These are the versions the Android build is expected to work with; changing any
of them re-opens the native build and `npm run verify`.

## Pins

| Item | Pinned version | Notes |
|---|---|---|
| JDK | Eclipse Temurin **17.0.20.1+1** | `JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot`. Microsoft JDK 25 is still installed on the PC and breaks the template's Gradle 9.6.1, so the build must run on 17. |
| Gradle | **9.6.1** (wrapper) | Shipped by the Tauri 2.12.2 Android template. |
| Android Gradle Plugin | **9.3.1** | From the generated project (`build.gradle.kts`). |
| Android SDK Build-Tools | **37.0.0** | |
| Android SDK Platform | **android-37.0** (Android 17, rev 2) | The generated project sets `compileSdk = 37`, `targetSdk = 37`. |
| Command-line Tools | **23.0.0** (`latest`) | `sdkmanager` is deprecated in this release — installs work through it, but `android sdk install` is the replacement. |
| Platform-Tools | **37.0.1** (`adb` 1.0.41, `37.0.1-15733141`) | |
| NDK | **27.3.13750724** (r27d) | `ANDROID_NDK_HOME`. The Gradle build reads the NDK through this variable. |
| Rust | **rustc / cargo 1.95.0** | |
| Rust Android targets | `aarch64-linux-android`, `armv7-linux-androideabi`, `i686-linux-android`, `x86_64-linux-android` | The Phase 0 build uses `aarch64` (arm64-v8a) only. |
| Node / npm | 26.13.0 / 11.20.0 | Only used for the Tauri CLI and frontend build. |
| Test device | Redmi Note 14 Pro+ `24115RA8EG` (`amethyst`), Android 16 / API 36 | `adb` serial recorded in the Session 2 report. |

## Environment variables

User scope (`ANDROID_HOME`, `ANDROID_NDK_HOME`); `JAVA_HOME` is machine scope,
set by the JDK 17 installer:

```
JAVA_HOME        = C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot
ANDROID_HOME     = %LOCALAPPDATA%\Android\Sdk
ANDROID_NDK_HOME = %LOCALAPPDATA%\Android\Sdk\ndk\27.3.13750724
```

A shell started before the install keeps the old environment; open a new one.

## Generated Android project

`src-tauri/gen/android` is committed to git despite the general `src-tauri/gen/`
rule (which now covers `gen/schemas/` and `gen/apple/` only):

- **Committed:** the Gradle project — `build.gradle.kts`, `app/build.gradle.kts`,
  `settings.gradle`, wrapper, `gradle.properties`, `buildSrc/` (the Rust plugin),
  the manifest, `MainActivity.kt`, resources and icons. 40 files in total.
- **Excluded by the project's own `.gitignore`** (`src-tauri/gen/android/.gitignore`
  and `app/.gitignore`): `build/`, `.gradle/`, `local.properties`,
  `key.properties`, `keystore.properties`, `.idea/`, `*.iml`, `.tauri/`,
  `tauri.settings.gradle`, `app/src/main/assets/tauri.conf.json`,
  `app/src/main/jniLibs/**/*.so` and the per-build `tauri.*` glue files.
- **Never committed:** signing material of any kind. The debug build uses the
  debug keystore in `%USERPROFILE%\.android\`; release signing is Phase B.

## Open item

The generated `app/build.gradle.kts` still has Tauri's default `minSdk = 24`.
Decision 11 in `docs/ANDROID_DESIGN.md` pins the support envelope at **min API 26**
(Android 8.0) with arm64-v8a only. Not changed in Session 2 — the Phase 0
feasibility build runs on the generated default.
