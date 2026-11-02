# Purple Memo — Android build environment setup (Windows PC)

One-time setup on the PurpleShade PC. Do this **before** giving the Android build
order — nothing here starts the build itself. Estimated: 30–45 min + downloads
(~10–15 GB disk for SDK/NDK).

Verified against Tauri 2.12.3 (the project's version) on 2026-11-01.

## 1. JDK 17 (not newer)

Tauri Android requires Java 17. The Tauri 2.12 Android template ships Gradle 9.6.1,
and the CLI explicitly warns when the active Java is too new for it (e.g. Java 25/27
breaks the build) — so install **JDK 17 LTS**, nothing newer.

1. Download: https://adoptium.net/temurin/releases/ → Version 17, OS Windows, Arch x64, Package JDK
2. Install, and check **"Set JAVA_HOME variable"** during setup
3. Verify in PowerShell:
   ```powershell
   java -version   # must show 17.x.x
   echo $env:JAVA_HOME
   ```

## 2. Android SDK + NDK

Install **Android Studio** (https://developer.android.com/studio) — or the
standalone SDK Command-line Tools if you prefer no IDE. In SDK Manager → SDK Tools,
check:

- Android SDK Build-Tools (latest)
- Android SDK Command-line Tools (latest) — **required**, the Tauri CLI uses these
- Android SDK Platform-Tools
- NDK (Side by side) — r26 or newer (r27.x recommended)
- An SDK Platform (API 35+; the template targets recent SDK)

Set the environment variables (System → Environment Variables, then reopen PowerShell):

```powershell
# Example paths — adjust to your install location
[Environment]::SetEnvironmentVariable("ANDROID_HOME", "$env:LOCALAPPDATA\Android\Sdk", "User")
[Environment]::SetEnvironmentVariable("ANDROID_NDK_HOME", "$env:LOCALAPPDATA\Android\Sdk\ndk\<version>", "User")
```

Note: Tauri CLI 2.12 tries to auto-detect `ANDROID_HOME`/`NDK_HOME` from default
locations and install missing pieces via the command-line tools — setting them
explicitly just removes the guesswork.

## 3. Rust Android targets

```powershell
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

## 4. Verify everything

```powershell
java -version                          # 17.x.x
echo $env:ANDROID_HOME                 # path to SDK
rustup target list --installed         # the 4 android targets listed
```

## 5. Test device (your Redmi Note 14 Pro+)

No emulator needed — you own the test device:

1. Phone: Settings → About phone → tap **MIUI version** 7× → Developer options on
2. Developer options → enable **USB debugging**
3. Connect via USB, accept the RSA prompt on the phone
4. On PC: `adb devices` should list the phone

`tauri android dev` serves the frontend over the network, so the phone and the PC
must be on the **same Wi-Fi** — which matches how you work anyway (one person, one
place).

## Notes for later (not now)

- `npm run tauri android init` creates `src-tauri/gen/android` — Tauri gitignores it
  by default. Your call whether to commit it or regenerate per clone.
- Release APK signing needs a **new Android keystore** later (Phase B/C decision).
  The desktop updater key is unrelated to Android — and for the record, its password
  is empty (confirmed during the 0.1.1 signed build).
- minSdk for Tauri apps is Android 7.0 (API 24); your Redmi is far above that.
- No Play Store / Play Console needed — you sideload the APK yourself.
