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

## Building the debug APK on Windows

The command is:

```
npx tauri android build --debug --target aarch64 --apk
```

The Rust half of that build is **not** plain `cargo`: SQLCipher is compiled with
`bundled-sqlcipher-vendored-openssl`, so the OpenSSL C sources are cross-compiled
by the NDK during the build. On Windows that step needs three things that a
plain Git-Bash shell does not provide, which is why the raw command fails out of
the box. The recipe that works on this PC (Session 2, proven end to end):

1. **A perl that both emits Unix paths and has the modules OpenSSL's `Configure`
   needs** (`Locale::Maketext::Simple`, `ExtUtils::MakeMaker`, `Pod::Usage`).
   Git-Bash's perl is Unix-path-correct but stripped; Strawberry Perl has the
   modules but refuses (MSWin32 paths). Resolution used: keep Git-Bash's perl and
   expose the missing modules from Strawberry through `PERL5LIB`.
2. **A `make`.** OpenSSL builds with `make`, which Git-Bash does not ship;
   Strawberry provides `gmake`.
3. **Bare toolchain names, not paths.** `openssl-src` hands the compiler to a
   generated Makefile that `/usr/bin/sh` executes; a Windows path
   (`C:\...\bin\clang.exe`) loses its backslashes there and the build dies on
   `C:Userspurpl...binclang.exe`. Passing the NDK compiler, `ar` and `ranlib` as
   **bare names with the NDK bin directory on PATH** avoids it entirely.

Concretely, with `NDKBIN=%ANDROID_NDK_HOME%\toolchains\llvm\prebuilt\windows-x86_64\bin`:

```
PATH             = <NDKBIN>;<make-shim>;<jdk17>\bin;%PATH%
CC_aarch64-linux-android = aarch64-linux-android24-clang
AR_aarch64-linux-android = llvm-ar
RANLIB_aarch64-linux-android = llvm-ranlib
PERL5LIB         = <local perl lib with the three modules>
```

`PERL5LIB` must be kept out of MSYS2's path conversion
(`MSYS2_ENV_CONV_EXCL`), or the value is rewritten into a Windows path that
Git-Bash's perl cannot use.

**Gradle also needs an `npm.bat`.** The generated `BuildTask.kt` invokes
`npm`, falling back to `npm.cmd` and then `npm.bat`; this Node installation
ships only `npm.cmd`, so the frontend step fails inside Gradle unless an
`npm.bat` exists earlier on PATH (a one-line forwarder to `npm.cmd` is enough).

These three shims live outside the repo (in `%TEMP%`), so a fresh machine needs
them recreated. If the SQLCipher/OpenSSL step keeps costing time, MSYS2 is the
cleaner substitute: its perl has the modules and Unix paths, and it provides
`make` — items 1 and 2 stop being local hacks, and only item 3 remains.

### Rebuilding the shims after a `%TEMP%` cleanup

Windows clears `%TEMP%`, which deletes the shims and with them the recipe above
(Session 4 hit exactly that). Recreate them before building:

1. `make.exe` — copy Strawberry's `gmake.exe`; a shell-script `make` dies with
   OS error 216.
2. `npm.bat` — write it from a heredoc (`@echo off`, then
   `call "C:\Program Files\nodejs\npm.cmd" %*`). Do not build it with `printf`
   and escaped backslashes: a half-eaten `\n` splits the path across lines and
   Gradle then fails with `'"C:\Program Files' is not recognized`.
3. The `PERL5LIB` module tree — copy each module OpenSSL's `Configure` reports
   missing from Strawberry's `perl/lib`, `perl/site/lib` and `perl/vendor/lib`
   into the `PERL5LIB` directory, then re-run `./Configure` until it passes.
   Nineteen modules were needed: `ExtUtils::MakeMaker` with its `MM_*` family,
   `Pod::Usage`, `Pod::Text`, `Pod::Simple` and `Locale::Maketext::Simple`.
   Strawberry's perl cannot be used directly — `Configure` rejects it with
   *“does not produce Unix like paths”* (MSWin32).

`cc` also reports `Compiler family detection failed … "aarch64-linux-android24-clang":
program not found` on every build. That warning is expected here: the NDK ships
that name as a shell script (plus a `.cmd`) which a native Windows `cc` cannot
spawn, while `openssl-src` only writes the bare name into a Makefile that
`/usr/bin/sh` runs, where the script resolves normally.

### Reading the device key-store result

`adb logcat -s PurpleMemo` records which backing the phone actually used:

```
created the Keystore wrapping key purple_memo_db_key_wrap_v1:
  strongbox_requested=true, backing=TEE
```

StrongBox is requested first and refused on the Redmi Note 14 Pro+, so the key
ends up TEE-backed; `strongbox_requested=false` means the fallback path ran.
`adb logcat -s System.err` carries the Java exception whenever a Keystore call
is refused, and `run-as com.minlulin.purplememo cat boot-error.log` holds the
text of the last failed boot. For the WebView console, forward
`localabstract:webview_devtools_remote_<pid>` (underscore, not colon) to 9222.

## Mobile entry point

`run()` in `src-tauri/src/lib.rs` is annotated
`#[cfg_attr(mobile, tauri::mobile_entry_point)]`. Without it the CLI rejects the
built library with *"does not include required runtime symbols"* while
packaging the APK — the Rust build itself still succeeds, so the error only
appears at the app-assembly step.

Desktop-only plugins are target-gated with `#[cfg(desktop)]` (tray, menu,
single-instance, `unminimize`) and `start_session_chrome` has a no-op mobile
counterpart. Desktop behaviour is unchanged; `npm run verify` stays the proof.

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

## Known gaps (from the Session 2 device run)

1. **The app does not reach its first screen yet.** It builds, installs and
   launches, and the webview frontend runs, but `boot` fails at the first
   platform seam: `keyring` has no Android backend, so the app shows its own
   "Purple Memo can't start — keyring entry unavailable: No default store has
   been set" dialog with Quit/Retry. Replacing that key store with Android
   Keystore is the Phase 0/A item, not a Session 2 change; the dialog proving
   visible and answerable is the useful part of this feasibility build.
2. **`minSdk` is still Tauri's default 24.** Decision 11 in
   `docs/ANDROID_DESIGN.md` pins the support envelope at **min API 26**
   (Android 8.0) with arm64-v8a only. Left as generated so far — the debug
   build runs on the Redmi either way.
