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
| Rust | **rustc / cargo 1.95.0** | Pinned by `rust-toolchain.toml` (repository root) with `clippy` + `rustfmt`. |
| Rust Android targets | `aarch64-linux-android`, `armv7-linux-androideabi`, `i686-linux-android`, `x86_64-linux-android` | The Phase 0 build uses `aarch64` (arm64-v8a) only. |
| Node / npm | 26.13.1 / 11.20.0 | Pinned by `.nvmrc` (repository root); only used for the Tauri CLI and frontend build. |
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
   **bare names with the NDK bin directory on PATH** avoids it for the debug
   build. The release build re-exports the absolute path and needs the
   `MAKEFLAGS` override in Session 5 below.

Concretely, with `NDKBIN=%ANDROID_NDK_HOME%\toolchains\llvm\prebuilt\windows-x86_64\bin`:

```
PATH             = <NDKBIN>;<make-shim>;<jdk17>\bin;%PATH%
CC_aarch64-linux-android = aarch64-linux-android24-clang
AR_aarch64-linux-android = llvm-ar
RANLIB_aarch64-linux-android = llvm-ranlib
PERL5LIB         = <local perl lib with the three modules>
```

`PERL5LIB` must be **a POSIX path**, and must be kept out of MSYS2's path
conversion (`MSYS2_ENV_CONV_EXCL`). Both halves were proven the hard way at the
first release build (2026-11-15): passing the Windows form
(`PERL5LIB='C:\Users\purpl\AppData\Local\Temp\android-perl\lib'`) reaches OpenSSL's
`Configure` as

```
@INC entries checked: … C \Users\purpl\AppData\Local\Temp\android-perl\lib …
Can't locate Locale/Maketext/Simple.pm in @INC
  … BEGIN failed--compilation aborted at ./Configure line 23.
```

— the drive colon and every backslash are eaten, so the directory is simply not
there. The form that works is the MSYS one:

```
export MSYS2_ENV_CONV_EXCL="PERL5LIB"
export PERL5LIB='/c/Users/purpl/AppData/Local/Temp/android-perl/lib'
```

Git-Bash's perl resolves that path, and `Configure` then runs to completion.
Sanity-check it before a build — this must print three `ok`s and no message
about a loadable library:

```
PERL5LIB="$PERL5LIB" perl -MExtUtils::MakeMaker -MPod::Usage \
  -MLocale::Maketext::Simple -e 'print "ok\n"'
```

Do **not** point `PERL5LIB` at Strawberry's own library tree instead of copying
the modules out. Its pure-Perl modules load, but the first XS module pulled in
fails with `loadable library and perl binaries are mismatched (got second hand
key … needed …)`, because Strawberry's perl is MSWin32 and Git-Bash's is
Cygwin. Copy the module directories (`ExtUtils`, `Pod`, `Locale`, `I18N`) and
delete every `*.so`/`*.dll`/`*.xs`/`*.bs` from the copy.

**Gradle also needs an `npm.bat`.** The generated `BuildTask.kt` invokes
`npm`, falling back to `npm.cmd` and then `npm.bat`; this Node installation
ships only `npm.cmd`, so the frontend step fails inside Gradle unless an
`npm.bat` exists earlier on PATH (a one-line forwarder to `npm.cmd` is enough).

**A stray `hs_err_pid*.log` in `src-tauri/` is a crashed Gradle daemon JVM**
(seen 2026-11-16: `EXCEPTION_ACCESS_VIOLATION` in `jvm.dll`, JDK 17, Gradle
9.6.1). It is gitignored and harmless — delete it; the build is unaffected.

These three shims live outside the repo (in `%TEMP%`), so a fresh machine needs
them recreated. The `make.exe` one is now built from `scripts/android-make-shim/`
by `npm run setup:android-make-shim`; the `npm.bat` and the `PERL5LIB` tree are
still assembled by hand. If the SQLCipher/OpenSSL step keeps costing time, MSYS2 is the
cleaner substitute: its perl has the modules and Unix paths, and it provides
`make` — items 1 and 2 stop being local hacks, and only item 3 remains.

### The release-profile ICU stanza — confirmed (2026-11-15)

`src-tauri/Cargo.toml` carries a package-level override:

```
[profile.release.package.icu_locale_core]
opt-level = 3
```

It answers a real failure: rustc 1.95.0 **ICEd** compiling `icu_locale_core`
under `opt-level = "s"` with `panic = "abort"` in the Android release build
(2026-11-07), and the override was added as the candidate workaround without a
build to prove it. The first signed release build (aarch64, 2026-11-15) is that
trial, and the verdict is **works**: `icu_locale_core` compiled under the
release profile with no ICE and no exit 101, and the build finished
(the log reads "Finished `release` profile [optimized] target(s) in 10m 37s",
then "Finished 1 APK"). No profile change, toolchain pin or nightly flag was
needed.

The stanza stays. If it is ever questioned, the evidence is cheap to re-read:
a fresh `src-tauri/target/aarch64-linux-android/release/.fingerprint/icu_locale_core-*`
directory dated to the build, and an absence of "internal compiler error" in
the build log. If a future rustc does ICE through it, the fallback is the
other lead recorded in the Cargo.toml comment — rust-lang/rust #157148 — and
the re-run uses `--message-format short` to get a readable error.

### Rebuilding the shims after a `%TEMP%` cleanup

Windows clears `%TEMP%`, which deletes the shims and with them the recipe above
(Session 4 hit exactly that). Recreate them before building:

1. `make.exe` — no longer hand-made: `npm run setup:android-make-shim` rebuilds
   it from `scripts/android-make-shim/`. It locates Strawberry's `gmake.exe`
   (`C:\Strawberry\c\bin\gmake.exe`, not under `perl\bin`), Git Bash's `sh.exe`
   and `rustc`, compiles the launcher, and then runs the result to prove it can
   start gmake — a shell-script `make` would die with OS error 216 instead.
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

### Session 5 (2026-11-18): what the bare-name recipe was still missing

The recipe above builds the debug APK but was not sufficient for the release
build from Git Bash. Two further failures showed up; only the first is still an
environment setting.

1. **The Windows compiler path comes back.** `npx tauri android build` exports
   the NDK toolchain itself, so `CC_aarch64-linux-android` and friends lose:
   OpenSSL's generated Makefile still read
   `CC=$(CROSS_COMPILE)C:\Users\…\windows-x86_64\bin\clang.exe`, and
   `/usr/bin/sh` turned that into `C:Userspurpl…clang.exe`. Overriding `SHELL`
   to an `sh.exe` does not help. What does work is passing the POSIX paths as
   make *command-line* variables, which beat the Makefile's own assignment and
   stay runnable by `sh`. The ` -- ` form is required: without it MSYS2 rewrites
   the value into something like `…/git/posix/clang`.

   ```
   export MSYS2_ENV_CONV_EXCL="PERL5LIB;MAKEFLAGS"
   export MAKEFLAGS=" -- CC=<NDKBIN>/clang AR=<NDKBIN>/llvm-ar RANLIB=<NDKBIN>/llvm-ranlib"
   ```

   `<NDKBIN>` is the MSYS form (`/c/Users/…`).

2. **`libcrypto.a` is archived in one 18 kB command line**, which make's recipe
   shell truncates; `llvm-ar` reports the truncated tail as its first argument
   (`llvm-ar.exe: error: cry: No such file or directory`, from `crypto/…`) and
   the build dies at `makefile:4427: libcrypto.a`. Running the identical command
   by hand from `sh` succeeds (`libcrypto.a` written, 13.8 MB), so the fix keeps
   it off that command line. The shim now lives in the repo, not in `%TEMP%`:
   `scripts/android-make-shim/` holds the launcher source (`make-launcher.rs`),
   the rewriter (`make-wrap.sh`) and `setup.mjs`, which builds and installs
   both:

   ```
   npm run setup:android-make-shim
   export PATH="<shim dir>:$PATH"      # printed by the installer
   ```

   The launcher has to be a real `.exe`: the CLI spawns `make` through
   `std::process::Command`, which resolves only `.exe` on Windows, and a shell
   script named `make` dies with OS error 216. It runs `sh.exe` on the wrapper
   with make's own arguments and exit code; the wrapper rewrites every
   `\t$(AR) $(ARFLAGS) <archive> <more than 5000 characters of objects>` recipe
   into `$(AR) $(ARFLAGS) <archive> @.objs-<archive>.txt` and then execs
   Strawberry's `gmake`. `llvm-ar` accepts `@file` response files, so the
   archive is byte-identical. The rewrite is idempotent and sanitises the
   response-file name: archives live in subdirectories too
   (`providers/libdefault.a`), and a name containing `/` aborts the write-back.

With both in place the release build finished in 7m 39s from the same shell
(`Finished 1 APK …/apk/universal/release/app-universal-release.apk`), and
`npm run check:android-apk` accepted the artefact: release-key DN
`CN=Purple Memo, OU=Release, O=Purple Memo, L=Local, ST=Local, C=US`,
certificate SHA-256
`D5F8786DE30C3E81CE3819EE0A69858C30DF487434F46BC19779DCD4D63F2089`, `versionCode
2000`, `versionName 0.2.0`, `arm64-v8a only`. The same step run against the debug
APK exits 1 on `signed with the Android DEBUG key (CN=Android Debug, O=Android,
C=US)`, and `aapt2 dump badging` independently reports the same
`versionCode='2000' versionName='0.2.0'` — the signature and version paths are
now proven on real artefacts rather than synthetic zips.

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

### Testing reminders and the clipboard on the phone

- Exact alarms are **denied by default** on this phone, which is how the
  inexact fallback gets exercised; grant it to test the exact path:
  `adb -s <serial> shell appops set com.minlulin.purplememo SCHEDULE_EXACT_ALARM allow`
  (`ignore` revokes it again). `appops get … SCHEDULE_EXACT_ALARM` reports the
  current mode, and `reminder_exact_state` in the webview reports what the app
  sees.
- `dumpsys alarm | grep purplememo` shows whether an alarm is still armed, and
  `dumpsys notification --noredact | grep pkg=com.minlulin.purplememo` shows a
  posted reminder — both without touching the phone's screen.
- The debug build exposes `clipboard_probe_read`, so the auto-clear can be
  measured without installing a second clipboard app.
- After a reboot the WebView devtools socket has a **new pid**: re-run
  `adb forward` before the next CDP call, and expect the app to start locked.

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

## Emulator for UI testing (no Android Studio)

Command-line tools only: the emulator lives in the same SDK
(`%LOCALAPPDATA%\Android\Sdk`) beside the pinned build toolchain. Nothing
pinned above was changed, reinstalled or re-pinned.

| Item | Version |
|---|---|
| Emulator | **37.2.13.0** (build `16740729`) |
| System image | `system-images;android-36;google_apis;x86_64` rev **7** — Android 16, API 36 |
| Hypervisor driver | AEHD **2.2** (`extras;google;Android_Emulator_Hypervisor_Driver`), service `aehd` running |

AVD **`purple_memo_test`** — Pixel 7 profile, portrait, 1080x2400 @ 420 dpi,
4 cores, 2560 MB RAM, 10 GB data partition, `x86_64`.

Boot headless (agent runs) and wait for the boot to finish:

```
%LOCALAPPDATA%\Android\Sdk\emulator\emulator.exe -avd purple_memo_test ^
  -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot
adb -s emulator-5554 wait-for-device shell
  'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 2; done'
```

Measured on this PC: **81 s** from launch to `sys.boot_completed=1` headless.
Drop `-no-window` for a visible window. Stop it with
`adb -s emulator-5554 emu kill` — the process is not a service and does not
survive a reboot.

### Acceleration without Hyper-V

`emulator -accel-check` reports *Android Emulator hypervisor driver is not
installed*, and Windows Hypervisor Platform is **disabled** on this PC. Turning
WHPX on needs a Windows feature change plus a reboot, so the emulator instead
uses Google's AEHD 2.2 kernel driver: installed as administrator from
`extras\google\Android_Emulator_Hypervisor_Driver\silent_install.bat`, and
`sc query aehd` then reports `RUNNING` — no reboot required. Do not enable WHPX
while AEHD is installed; if Hyper-V is ever enabled, remove AEHD with
`silent_install.bat -u` first.

### adb targeting rule

With two devices attached a bare `adb` fails loudly with *more than one
device/emulator*, so **every** emulator call passes `-s`:

- Emulator serials are `emulator-5554`, `emulator-5556`, … (a second instance
  needs `-port 5556`).
- The guest `ro.serialno` is the same generic `EMULATOR37X2X13X0` on every
  instance — target by the **adb serial**, never by that property.
- The Redmi keeps its own serial `4c61bf7a`; when it is not plugged in,
  `adb -s 4c61bf7a …` answers *device '4c61bf7a' not found* rather than falling
  through to an emulator.

### x86_64 debug variant (emulator only)

The release APK is **arm64-v8a only** (decision 11) and will not install on this
x86_64 emulator, so there is a debug-only x86_64 build for `purple_memo_test`:

```
npx tauri android build --debug --target x86_64 --apk
```

The environment preamble is the one above, with the compiler variables named for
this target. They must be passed through `env`, never `export`: bash rejects a
hyphenated identifier, so `export CC_x86_64-linux-android=…` fails and leaves the
variable unset — openssl-src then falls back to the NDK's `.cmd` wrapper, whose
Windows path `/usr/bin/sh` mangles into `C:Userspurpl…clang.exe`:

```
env CC_x86_64-linux-android=x86_64-linux-android24-clang \
    AR_x86_64-linux-android=llvm-ar \
    RANLIB_x86_64-linux-android=llvm-ranlib \
    npx tauri android build --debug --target x86_64 --apk
```

The APK lands beside the arm64 one
(`app/build/outputs/apk/universal/debug/app-universal-debug.apk`) and contains
`lib/x86_64/libpurple_memo_lib.so` only. Install it with an explicit serial:
`adb -s emulator-5554 install -r <apk>`.

**It never ships.** `app/build.gradle.kts` checks the ABI set at configuration
time and fails any release build that is not exactly `arm64-v8a`: `--release
--target x86_64` and a release build with no `--target` (which would default to
all four ABIs) both stop with an explicit error instead of packaging an extra
ABI. The per-ABI flavors themselves come from the generated `RustPlugin`, which
builds one Rust target per ABI; nothing in the release path is changed by the
debug variant.

### When sdkmanager stalls (worked around here)

`sdkmanager` hung on the 1.7 GB system-image download — zero bytes and no
progress after seven minutes — while `curl` from the same host pulled the same
URL at 2.4–4 MB/s. To recover: take the URL sdkmanager prints, `curl -L` the
archive, and unzip it into the matching `system-images/<api>/<tag>/<abi>`
directory; `sdkmanager --list_installed` then lists it as installed (that is how
rev 7 got here). Also note that `sdkmanager` and `avdmanager` split package ids
containing `;` when they are passed inline — use `--package_file=` instead.

## Known gaps (from the Session 2 device run)

1. **`minSdk` — closed in the Phase C build session (2026-11-12).** It was
   Tauri's default 24; decision 11 in `docs/ANDROID_DESIGN.md` pins the support
   envelope at **min API 26** (Android 8.0) with arm64-v8a only. The pin in
   `app/build.gradle.kts` is now 26, and an aarch64 debug APK built with it.
