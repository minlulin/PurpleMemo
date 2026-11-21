# Purple Memo — F13 evidence capture report

Device: Redmi Note 14 Pro+ (`4c61bf7a`, Android 16 / API 36)
Installed build: `com.minlulin.purplememo` versionCode 2000 / versionName 0.2.0
Session date: 2026-11-21
Tree read for interpretation: `044040d` (dev), with the installed build's own
behaviour taken from tag `v0.2.0`

This report is the output of the evidence-capture session requested by the F13
evidence-capture brief. It records what the phone's logs and screen actually
showed. **No fix is proposed and none was attempted.**

---

## Rules honoured

Read-only throughout. Nothing was cleared, uninstalled, installed over the
existing install, or edited in the app's data. No code was changed. The one
non-read action was the launch the brief itself specifies (`am start`), which
the app had been doing on every attempt anyway.

Two things were deliberately **not** done, and their absence bounds what this
report can prove:

- **"Try again" was never pressed.** It is an app interaction the brief did not
  authorise, and it is the one cheap experiment that would settle the remaining
  uncertainty (see *What remains unproven*).
- **`boot-error.log` was not read.** It sits in internal storage; on a release
  build `/data/user/0/com.minlulin.purplememo/` returns `Permission denied`, as
  expected.

---

## Method

```text
adb devices -l
adb shell dumpsys package com.minlulin.purplememo | grep -E "versionCode|versionName|firstInstallTime|lastUpdateTime"
adb shell pidof com.minlulin.purplememo          # no output: nothing running
adb logcat -c
adb shell am start -W -n com.minlulin.purplememo/.MainActivity
# wait 10 s
adb logcat -d > f13_logcat.txt
```

The app was confirmed dead before the clear (`pidof` empty), so the launch was
genuinely cold; `am start` reported `LaunchState: COLD`, `TotalTime: 268`.

Artefacts written beside this report's session:

| file | contents |
| --- | --- |
| `f13_logcat.txt` | 420,895 bytes, 2,739 lines — the capture |
| `f13_ui.xml` | `uiautomator` dump of the app's view hierarchy |
| `f13_screen.png` | first screenshot (obscured by an incoming call) |
| `f13_screen2.png` | second screenshot (black — see *Capture caveats*) |

### Capture integrity

The buffer was cleared immediately before the launch and dumped after it, so
everything in the file belongs to this one launch. Coverage is complete, not
truncated: the first line is `--------- beginning of main`, the last is the
`logcat -d` command itself at `13:32:54.150`, and the launch began at
`13:32:41.077`. Nothing rotated.

### Capture caveats

- An **incoming call** (`com.android.incallui.InCallActivity`, caller
  "Ko Chinn") was on screen during the first screenshot and blocked
  `uiautomator`'s idle wait. It was left untouched; it had cleared by the
  second check. It did not affect the log capture.
- `screencap` returns **black** for this app's WebView layer on this device
  (the call overlay captured fine, so the display path works — the WebView
  layer is not captured). The `uiautomator` dump is therefore the authoritative
  record of what the app was showing.

---

## 1. Build confirmation

```text
versionCode=2000 minSdk=26 targetSdk=37
versionName=0.2.0
lastUpdateTime=2026-11-20 15:47:04
firstInstallTime=2026-11-18 11:49:11
firstInstallTime=1970-01-01 06:30:00
```

The build is still the one the pre-release checklist ran against. The second
`firstInstallTime` (epoch zero) is a separate user/profile record; it is noted
for completeness and is not part of the evidence chain.

---

## 2. What the app was showing

From `f13_ui.xml` (`uiautomator`), the app's WebView contains:

```text
Could not read the encrypted database: state not managed for field `state` on
command `db_query`. You must call `.manage()` before using this command
```

with buttons `Try again` and `Lock workspace`. The activity is the top resumed
activity, the window is visible, and the process (pid 10325) is alive and
sleeping (`State: S`). There is no crash, no ANR, and no native dialog.

So the brick is reproduced exactly as F13 describes it. The question this
session had to answer is *why*, and the log does not answer it the way the
brief expected.

---

## 3. The four required extractions

### 3.1 `Purple Memo failed to start` — **absent**

Zero matches, case-insensitive, in the whole capture.

This is the single most important result of the session, and it is a negative.
Section 4 explains why the absence is positive evidence rather than a gap.

### 3.2 The `purple-memo:` stderr channel — **absent**

Zero matches, case-insensitive.

### 3.3 Keystore / unwrap / reset lines

Every line in the capture matching Keystore, unwrap, factory reset or reset
marker:

```text
11-21 13:32:41.826 10325 16421 W BpBinder: PerfMonitor binderTransact: time=244ms interface=android.system.keystore2.IKeystoreSecurityLevel code=1
11-21 13:32:41.933 10325 16421 I PurpleMemo: unwrapped the database key with the Android Keystore
11-21 13:32:42.163 10325 16421 I PurpleMemo: unwrapped the pairing key with the Android Keystore
```

No line anywhere in the buffer mentions a factory reset, a reset marker, or
`reset_in_progress`.

### 3.4 Context around the last boot activity

There is no failure line to surround, so this is the tail of the boot sequence
verbatim, with unrelated system noise elided (line numbers refer to
`f13_logcat.txt`):

```text
2087: 11-21 13:32:41.932  1316  1316 I android.hardware.security.keymint-service.strongbox-thales: STATUS OF TRNSMIT: 0 Message:
2088: 11-21 13:32:41.933  1316  1316 I android.hardware.security.keymint-service.strongbox-thales: into keymint timer start.
2089: 11-21 13:32:41.933  1316  1316 I android.hardware.security.keymint-service.strongbox-thales: into keymint timer start2.
2090: 11-21 13:32:41.933 10325 16421 I PurpleMemo: unwrapped the database key with the Android Keystore
2091: 11-21 13:32:41.934  2398  4818 D MiuiInputManagerService: registerSrollToTopListener, windowId: 154558320, listener: miui.hardware.input.IScrollToTopListener$Stub$Proxy@e23ff87
2092: 11-21 13:32:41.940 10325 16505 I libEGL  : shader cache num entries: 191
```

```text
2156: 11-21 13:32:42.162  1316  1316 I android.hardware.security.keymint-service.strongbox-thales: STATUS OF TRNSMIT: 0 Message:
2157: 11-21 13:32:42.162  1316  1316 I android.hardware.security.keymint-service.strongbox-thales: into keymint timer start.
2158: 11-21 13:32:42.162  1316  1316 I android.hardware.security.keymint-service.strongbox-thales: into keymint timer start2.
2159: 11-21 13:32:42.163 10325 16421 I PurpleMemo: unwrapped the pairing key with the Android Keystore
2160: 11-21 13:32:42.166  2398  4126 D SchedBoostThread: thread tid=4842, priority is set to -4
```

The last app-side line in the entire buffer is:

```text
2521: 11-21 13:32:46.756 10325 16580 D ProfileInstaller: Skipping profile installation for com.minlulin.purplememo
```

Nothing further is emitted by pid 10325. The app is not hung in the sense of
retrying; it is idle, showing the error screen.

---

## 4. Why the missing failure line is evidence

The brief assumed boot's real error would be in the log, because
`report_boot_failure` writes `boot-error.log` and prints the same line to
stderr. The installed build does exactly that. From `git show v0.2.0:src-tauri/src/lib.rs`,
`report_boot_failure` (line 504):

```rust
    write_boot_error_log(&full);          // 512
    eprintln!("{full}");                  // 513
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();            // 515
    }
```

and `full` is either `format!("Purple Memo failed to start: {}.", failure.message())`
or `boot_failure_message(failure.message())` (lines 505–511).

Three independent facts show that path did not run:

1. **The stderr channel was live in this very capture.** Rust's `eprintln!`
   reaches logcat under tag `RustStdoutStderr`. Two lines in this launch prove
   it, forwarded from the embedded WebView:
   ```text
   11-21 13:32:41.465 10325 16420 I RustStdoutStderr: [INFO:android_webview/browser/variations/variations_seed_loader.cc:63] Failed to open file for reading.: No such file or directory (2)
   11-21 13:32:41.516 10325 16420 I RustStdoutStderr: [WARNING:net/dns/dns_config_service_android.cc:69] Failed to read DnsConfig.
   ```
   A boot-failure `eprintln!` would have appeared on the same tag.
2. **The main window was never hidden.** It is visible, top-resumed, and its
   WebView is rendering the error screen — `report_boot_failure` hides it
   before showing the dialog.
3. **No native dialog window exists** in `dumpsys window windows`; the only app
   window is `com.minlulin.purplememo/com.minlulin.purplememo.MainActivity`.

Conclusion: **in this launch, `boot()` did not fail.** The renderer's
"state not managed" message is not a masked boot failure; it is the literal,
complete truth about what happened.

---

## 5. How far boot actually got

The v0.2.0 boot order (`git show v0.2.0:src-tauri/src/lib.rs`) is:

| step | line |
| --- | --- |
| interrupted-reset recovery | 277 |
| `load_or_mint_db_key` | 299 |
| `open_encrypted_db` + `init_schema` | 311–314 |
| `surface_pairing_identity_loss(&conn)` | 349 |
| `app.manage(db::AppState { … })` | 350 |

The pairing-key unwrap at `42.163` comes from `surface_pairing_identity_loss`,
whose first act is a real SQL query (`commands.rs:881`):

```rust
pub(crate) fn pairing_history(conn: &Connection) -> CmdResult<PairingHistory> {
    let paired: bool = conn
        .query_row("SELECT EXISTS (SELECT 1 FROM sync_peers)", [], |row| {
            row.get(0)
        })
```

and whose second act is `pairing_key::inspect(history)` (line 229), which is
what logs `unwrapped the pairing key with the Android Keystore`
(`key_store/android.rs:104–107`).

Therefore, in this launch:

- the database key loaded and the Keystore unwrap succeeded;
- the encrypted database **opened** and its **schema initialized** — otherwise
  the `sync_peers` query would have errored and `inspect` would never have run;
- `surface_pairing_identity_loss` completed.

Between line 349 and `app.manage(AppState)` at line 350 there is **no fallible
call**. So boot reached the manage step. The three candidate causes the brief
listed — interrupted reset, key load, database open/schema — are all excluded,
because all three occur *before* the last step that demonstrably succeeded.

---

## 6. The error text's provenance

"state not managed for field `{}` on command `{}`. You must call `.manage()`
before using this command" is Tauri core's own message, emitted by the `State`
extractor (`tauri-2.12.7/src/state.rs:64`).

That matters twice over:

- The command `db_query` **exists and was routed** — otherwise the error would
  be an unknown-command error. So `tauri_plugin_sql` **is** registered. The
  hypothesis recorded in F13 ("the auto-unlock launch path building the app
  without `tauri_plugin_sql`") is disproved by the wording of the error itself.
- What was missing is specifically `db::AppState`, the app's own managed
  struct — exactly the value boot manages last.

---

## 7. The ordering, from timestamps

| time | event | line |
| --- | --- | --- |
| `41.077` | `am start` reaches the system | 141 |
| `41.181` | app process forked (pid 10325) | 286 |
| `41.404` | `VRI[MainActivity]: vri.reportDrawFinished` — first frame | 1084 |
| `41.465` | first `RustStdoutStderr` line — stderr live | 1209 |
| `41.826` | Keystore binder call, `time=244ms` | 2017 |
| `41.933` | **database key unwrapped** | 2090 |
| `42.163` | **pairing key unwrapped** (boot essentially complete) | 2159 |
| `46.756` | last app-side line | 2521 |

The WebView was already live — first frame at `41.404`, WebView machinery
logging by `41.465` — roughly **half a second before the database key existed**
at `41.933`. The failing read therefore had a wide window in which `AppState`
could not yet be managed. The frontend's first read is not gated on boot:
`src/App.tsx:606–608` calls `loadSecurity()` from a mount effect, and that
function issues five `db_query` reads (`App.tsx:531–553`). Its failure path
sets `boot.error` and renders the error screen (`App.tsx:960–967`).

## 8. Root cause, as the evidence indicates

**Inference, clearly labelled as such:** the frontend's first `db_query` runs
before `setup()`'s `boot()` reaches `.manage()`. It fails with the genuine
"state not managed" error, the error screen latches, and nothing re-reads once
boot finishes — so every launch shows the same screen even though boot
succeeds. The 244 ms Keystore call is enough delay for the WebView to win the
race.

What the log proves and what it only supports:

| claim | status |
| --- | --- |
| boot did not fail in this launch | **proven** (§4) |
| database opened and schema initialized | **proven** (§5) |
| the error is `db::AppState` not managed, plugin present | **proven** (§6) |
| the failing query preceded the manage step | **proven** (§7 timing) |
| boot reached `app.manage(...)` | **strong inference** — no fallible call remains, but not directly observable |
| the error screen never retries after boot completes | **inference** from `App.tsx` and the idle process |

This does not explain *why the reminder* is the trigger, and this report does
not claim to. What it does establish is that the trigger is not a damaged key,
an interrupted reset, or a corrupt database.

---

## 9. What remains unproven

- **Whether `AppState` is managed by the time the app is idle.** The ordering
  argument says it is. It was not confirmed empirically, because that requires
  pressing `Try again` and the brief forbade interaction. If it is managed, one
  press would open the workspace — which is a testable prediction for the next
  session, not a conclusion of this one.
- **Whether the 0.3.0 boot-failure surface helps here.** The surface added at
  `044040d` reports a *recorded* boot failure. Since no boot failure occurs,
  `boot_failure` would return `None` and the screen would still be the generic
  read-database message. That surface is correct for the class it targets; on
  this evidence it may not be the class F13 belongs to.
- **Whether the same race affects the 0.3.0 APK.** It follows from the frontend
  mount effect, which is unchanged, but it was not run on a 0.3.0 build.
- **Why a fired reminder makes the race lose.** Unexplained by this capture.

---

## 10. Reproduction for a future session

Read-only, in order:

```text
adb devices -l
adb shell dumpsys package com.minlulin.purplememo | grep -E "versionCode|versionName|firstInstallTime|lastUpdateTime"
adb shell pidof com.minlulin.purplememo
adb logcat -c
adb shell am start -W -n com.minlulin.purplememo/.MainActivity
adb logcat -d > f13_logcat.txt
adb shell uiautomator dump /sdcard/f13_ui.xml && adb shell cat /sdcard/f13_ui.xml
```

Then grep the capture for `RustStdoutStderr`, `PurpleMemo`, `failed to start`,
`purple-memo:`, `keystore`, `reset`. Note that the app's own log tag is
`PurpleMemo` and its stderr is `RustStdoutStderr` — **not** `System.err`, and
not the main thread id; grepping by tid alone misses both.

---

## 11. Effect on the F13 record

The F13 entry in `PurpleMemo_0.3.0_Pre_Release_Findings.md` carried a
hypothesis that this capture disproves: that the launch path built the app
without `tauri_plugin_sql`. The plugin is present; the missing state is
`db::AppState`. The entry has been updated to point here and to drop that
hypothesis. F13 remains **open** — the workspace is still unopenable — but its
root-cause class has changed from "damaged key / failed boot" to "startup
ordering between the webview's first read and Rust's boot".
