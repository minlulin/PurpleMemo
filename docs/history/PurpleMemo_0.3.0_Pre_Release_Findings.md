# Purple Memo 0.3.0 — pre-release findings

Snapshot of the working record as of 2026-11-21, after the §4 checklist run on
the Redmi against the installed 0.2.0 build.

Analysis of the tree at `52f1b63` (branch `dev`, gate green) for the 0.3.0
release, whose change of shape is that the **Android APK ships beside the
desktop build**. This is a working record for fixing the items one at a time;
each finding carries its evidence and the smallest fix I would accept.

Status legend: **open** · **in progress** · **fixed (uncommitted)** · **fixed
(committed)** · **decision needed**

## How the findings were established

Verified on this machine, not inferred from the docs alone:

- `npm run verify` green at `52f1b63` (hook armed, `core.hooksPath=.githooks`);
  the new symbol check reports `0 undefined EVP/CRYPTO/OPENSSL symbols (193
  undefined symbols scanned)` for the 0.2.0 APK.
- The APK on disk, read with `aapt2 dump badging`, `apksigner verify
  --print-certs` and `llvm-readelf --dyn-syms`: `com.minlulin.purplememo`,
  `versionCode 2000`, `versionName 0.2.0`, `minSdkVersion 26`,
  `targetSdkVersion 37`, release-key DN `CN=Purple Memo, …`, certificate
  SHA-256 `D5F8786D…3F2089`, `arm64-v8a` only, not debuggable,
  `android:allowBackup="false"` + `data_extraction_rules`.
- `package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` all
  `0.2.0`; `app/tauri.properties` `versionCode 2000` / `versionName 0.2.0`.
- `npm outdated` (14 packages behind latest patch) and `grep` for
  `TODO|FIXME|todo!|panic!` in `src-tauri/src` (zero matches).
- Code reads: `src/components/MobilePairingCard.tsx`,
  `src/lib/sync/engine.ts`, `src/lib/sync/store.ts`,
  `src/components/MobileScreens.tsx`, `src-tauri/src/pairing_client.rs`,
  `proguard-rules.pro`, `AndroidManifest.xml`, `build.gradle.kts`.
- Docs read in full: `docs/RELEASE.md`, `RELEASE_NOTES.md`,
  `docs/ANDROID_DISTRIBUTION.md`, `docs/ANDROID_BUILD_TODO.md`,
  `docs/ANDROID_TOOLCHAIN.md` (pins + Session 5 release build).

Not checked: a 0.3.0 APK build, a two-device sync run, and a whole-codebase
security audit. The Redmi and the installed 0.2.0 build were exercised on
2026-11-21 — see F3 for what passed and F13 for the one check that fails.

---

# Blockers — the release is wrong or unprovable without these

## F1 — `docs/RELEASE.md` has no Android step at all · **fixed (committed)**

The runbook that gets followed on release day is desktop-only. Its only
"android" hit (line 242) is a schema note. It does not build the APK, does not
check it, and its `gh release create` uploads three assets and no APK.

Worse, its step order breaks with an APK present: step 3 bumps the version and
step 2 is the green gate. With an artefact on disk, `check-android-apk` calls
`expectedVersion()`, which compares `app/tauri.properties` (`versionName=0.2.0`)
with `package.json` (`0.3.0`) and fails — correctly, but the runbook says
nothing about it. Ordering must become: dep re-check → bump → **build and check
the APK** (regenerates `tauri.properties`) → full gate → tag/push → desktop
build → publish four assets.

Fix: one "Supported platforms" paragraph, a new per-release step, the APK in
the publish step, a phone line in the update-path step, and a gotcha bullet.

Landed: all five. Steps renumbered 1–9, `docs/RELEASE.md` only;
`node scripts/check-references.mjs` green (89 references). Commit `9f8ab3a`,
rewritten once in review to drop toolchain details that
`docs/ANDROID_TOOLCHAIN.md` already pins.

## F2 — `RELEASE_NOTES.md` contradicts the plan and promises what the phone cannot do · **fixed (committed)**

Two lines in the shipped 0.2.0 notes:

Landed as `7ca4d07`: the notes are written for 0.3.0 around the APK — install
steps for the signed arm64 build on Android 8.0+, no automatic updates with the
version named in Diagnostics, sync described as manual and started from a live
desktop code, the WARP/VPN block, the finished English/Burmese interface, the
fixes since 0.2.0, and a scope section carrying the phone's own limits (no
backup or export of its own, lossy rollback), the forward-only schema and the
exported-key recovery. The conflict sentence keeps the F5 wording verbatim, so
nothing in it claims the phone can open Trash.

- "This GitHub release ships the **Windows desktop** build only… there is no
  APK download here." — the opposite of the 0.3.0 decision.
- "A record that loses a conflict is kept in Trash on the losing side rather
  than discarded silently." — false on the phone (see F5).

The 0.3.0 rewrite must also state: arm64 + Android 8.0 only, sideloading, no
automatic updates on the phone, sync is manual and needs a live code from the
desktop's Pairing panel, a VPN such as CloudflareWARP on the desktop's machine
blocks the inbound LAN connection, reminders are device-local with an inexact
fallback when the exact-alarm grant is denied, the timezone caveat (restart
before new reminders read a new zone), no phone-side backup, and that a phone
rollback is uninstall + re-pair (lossy). Plus the schema note the doc already
requires.

## F3 — the signed release APK has never been installed on the Redmi · **verified on 2026-11-21 except launch-after-close, which fails (F13)**

Every device proof in `docs/ANDROID_BUILD_TODO.md` is a **debug** APK (Phase C
session 4, the 2026-11-12 retry). The signed artefact was only built and
statically checked (2026-11-15, 2026-11-18). Release-only failure classes live
exactly there: R8 stripping the JNI bridge (reminders and sensitive copy fail
silently — `proguard-rules.pro` keeps the two classes), `panic = "abort"`,
FLAG_SECURE, TEE backing, a reminder actually firing, and the release build's
own startup.

Also: installing the signed APK over a debug build fails with
`INSTALL_FAILED_UPDATE_INCOMPATIBLE`, so the checklist must start with an
uninstall when a debug build is present.

Fix: run `docs/ANDROID_DISTRIBUTION.md` §4 (and §5's upgrade) against the 0.3.0
file, then tick the open item in `docs/ANDROID_BUILD_TODO.md`.

Read-only check on 2026-11-21, with the phone on adb (`4c61bf7a`, Redmi Note
14 Pro+, Android 16 / API 36): the installed package is
`com.minlulin.purplememo`, versionCode 2000 / versionName 0.2.0, first installed
2026-11-18 and last updated 2026-11-20 15:47, **not debuggable**, and the pulled
`base.apk` is byte-identical to the built artefact (SHA-256
`A3FA54A3…05A1B2`). So the signed release APK is already on this phone and the
`INSTALL_FAILED_UPDATE_INCOMPATIBLE` trap is behind it; what has never run is
§4's behaviour checklist (launch, pair, sync, reminders) against that build, and
the 0.3.0 artefact is still to be built and proven (F4).

### §4 behaviour checklist, run 2026-11-21 against the installed 0.2.0 build

Passed:

- **Install** — already present and byte-identical to the signed artefact (above),
  so there was nothing to install and the update-incompatible trap is behind it.
- **Launch** — `am start -W` reported `LaunchState: COLD`,
  `TotalTime: 240`; the crash buffer holds no entry for 2026-11-21.
- **FLAG_SECURE** — the app's focused window carries `SECURE`, and `screencap`
  with the app in front returns 24,530 bytes against 2,965,293 for the
  launcher: the content is blacked out.
- **Runtime grants** — `POST_NOTIFICATIONS`, `CAMERA` and
  `RECEIVE_BOOT_COMPLETED` are `granted=true`, and
  `cmd appops get … SCHEDULE_EXACT_ALARM` is `allow`, so the exact-alarm path
  is live rather than the inexact fallback.
- **Diagnostics** — schema version 14, database size 496.0 KB, Keystore backing
  `TEE`. No app-version row, which is correct: 0.2.0 predates F6.
- **A reminder fires while the app is closed** — created `Checklist` for 11:53;
  the log shows `armed reminder 1 at 1795238580000 (exact)`, the process was
  killed at 11:51:59, and at 11:53:00.031 the system started a new process for
  `com.minlulin.purplememo/.ReminderReceiver`, the app logged
  `delivered reminder 1`, and a notification appeared (channel
  `purple_memo_reminders_v2`, importance HIGH, `AUTO_CANCEL`) titled
  `Reminder due` with `Open Purple Memo to see the reminder.` — delivery works
  with no process alive.

Failed: **reopening the app after that reminder**. Instead of the PIN prompt
it auto-unwrapped its keys from the Keystore and showed a database error, and
the workspace stayed unopenable through every restart — F13.

Two smaller things seen on the way, neither a §4 item:

- the `When` control renders the chosen local time as a bare
  `2026-11-21T11:53`, with no zone and no readable date — the same timezone
  blur the notes already carry a caveat for;
- the reminder form does not fit above the bottom bar: with the page unscrolled
  the `When` and `Repeat` controls sit under the navigation bar and
  `Add reminder` reports zero bounds, and once scrolled the FAB overlaps its
  right end. Reachable after scrolling, so not blocking, but the form hides its
  own submit button on arrival.

## F4 — the 0.3.0 artefact proof must be redone · **open**

The numbers now in the docs (versionCode 2000, `0.2.0`, APK SHA-256
`A3FA54A3…05A1B2`) describe 0.2.0. The release needs its own: a fresh
`npx tauri android build --apk --target aarch64`, a fresh
`npm run check:android-apk`, `versionCode 3000`, and the new APK SHA-256 — the
only evidence that the file handed over is the file checked. Publish that block
in the release body.

## F13 — a reminder that fires with the app closed leaves the workspace unable to open its database · **root cause found (startup race, not database damage); fix landed on dev, device proof pending with F3/F4**

Found by the §4 run above, on 0.2.0. After the reminder fired while no process
existed, every launch showed:

```text
Could not read the encrypted database: state not managed for field `state` on
command `db_query`. You must call `.manage()` before using this command
```

together with `Try again` and `Lock workspace`. `Try again` repeats the error;
`Lock workspace` does nothing visible; relaunching with `am kill` and then with
`am force-stop` (both `LaunchState: COLD`) reproduced it, so the workspace was
still unopenable at the end of the run, five relaunches in.

What the log says, from the read-only capture on 2026-11-21 (recorded in
`docs/history/PurpleMemo_F13_Evidence_Report.md`): the process unpacks the
database key and the pairing key with the Android Keystore (`unwrapped the
database key with the Android Keystore`, then `unwrapped the pairing key with
the Android Keystore`) — it is auto-unlocking, never asking for the PIN — and
the frontend's `db_query` then finds no managed state.

The earlier reading of this — that the launch path built the app without
`tauri_plugin_sql` — is disproved by the error text itself. "state not managed
for field `state` on command `db_query`" is Tauri core's `State` extractor
message (`tauri/src/state.rs:64`), so the command was routed and the plugin was
registered; only the app's own `db::AppState` was missing. The same capture
logs no `Purple Memo failed to start` line and no `purple-memo:` line at all,
while the `RustStdoutStderr` channel is demonstrably live and the main window
is never hidden — so boot did not fail. It reached the pairing check, which
runs only after the database is opened and its schema initialized, and the one
step left is `.manage()`. That points at a startup ordering race between the
webview's first read and Rust's boot — not a damaged key, an interrupted reset,
or a corrupt database.

Why it blocks 0.3.0: it is exactly the scenario the checklist asks for — close
the app, let a reminder fire, come back — and it ends with the workspace
unusable until the app data is cleared or the app reinstalled. Unconfirmed
whether the encrypted database and its contents survive (nothing was cleared:
the phone's data was left as found apart from the test reminder).

Next step, not started: design the fix from the evidence report — the
`db_query` / `manage` ordering is where it has to go — reproduce on a debug
build, then re-run this checklist item on the 0.3.0 APK before treating F3 as
closed. One cheap experiment first: if boot does reach `.manage()`, a single
`Try again` on the idle app should open the workspace. That was deliberately
not pressed during the capture, so the evidence stayed intact.

**Resolution (2026-11-21, evidence capture on the still-bricked install —
see the F13 evidence report).** The logcat capture disproved the boot-failure
framing: in a reproduced launch, `report_boot_failure` never ran, both keys
unwrapped, the database opened, the schema initialized, and
`surface_pairing_identity_loss` completed a real SQL query — boot reached the
step before `app.manage(AppState)` with no fallible call remaining. The
actual cause is a startup race: the WebView was live (first frame at
41.404 s) roughly half a second before the database key existed (41.933 s;
the Keystore binder call alone took 244 ms), the renderer's mount-effect
read ran in that window, failed with the genuine "state not managed" error,
and the error screen latched it for the session — nothing re-reads after
boot settles. The database and its contents were never damaged. Two fixes
landed on dev: `044040d` (Rust records a failed boot's cause and the error
screen shows it and retries through Rust's boot retry) and the boot-status
handshake (Rust records the boot phase — pending / ready / failed — behind
`boot_status`; the renderer's first read waits for the phase to settle, so
the race window no longer produces a latched error). Still to prove on the
0.3.0 APK: this checklist item re-run (F3/F4).

---

# Functional, because the release is about the phone

## F5 — a phone-lost sync conflict is written to a Trash screen the phone does not have · **fixed (committed), disclose-only**

`src/lib/sync/engine.ts:1324` and `mergeSnapshotRow` in
`src/lib/sync/store.ts:1896` archive the losing value into `trash_items` on the
device that applies the winner. The phone applies remote ops, so when a desktop
edit beats a phone edit the phone writes a copy into its own `trash_items` —
and `src/components/MobileScreens.tsx` has no Trash surface (zero matches), and
`trash_items` is in `DESKTOP_ONLY_TABLES`, so the copy never travels to the
desktop either. Net: the phone user's edit disappears from the list, the copy is
unreachable, and the 30-day purge deletes it.

Options, cheapest first:

1. **Disclose** — say in the sync result and the notes that replaced edits are
   kept in Trash, and that the phone has no Trash yet. Honest, one commit.
2. **Minimal phone Trash** — read-only list (label, winning value, date) with
   restore-as-new. Matches §13.2 and removes the data-loss surprise.

Decided by the owner: option 1. Landed as `34d5b03` — `applyOps` reports how
many of this device's values it archived (a `replaced` out-property, read only after the commit), `SyncOutcome.replaced`
carries the count through every return path, the pairing card shows
`mobile.settings.syncReplaced` (EN + MY), and `RELEASE_NOTES.md` now says the
copy lives on the device that held it and that the phone cannot open it yet. A
session test seeds a desktop edit that outranks the phone's note and asserts
`replaced === 1` plus the archived copy. A phone-side Trash screen stays open
as future work, and the pull/adoption surface still reports no such count —
this covers the sync result only. The count is added only after the apply
batch commits, pinned by a second session test whose phone-side transaction
fails: a rolled-back batch reports no replacement and leaves no copy behind.

## F6 — the phone cannot show which build it is running · **fixed (committed)**

Mobile Settings reports schema version, database size and Keystore backing, but
no app version (`mobile.settings.*` has no version key; the desktop shows one at
`src/pages/SettingsPage.tsx:1220` via `getVersion()`). For a sideloaded APK with
no updater, "which file did you install?" is the first support question.

Fix: one Diagnostics row + one EN/MY key pair + the existing `getVersion` call.

Landed as `579374a`: `facts.appVersion` read through
`import("@tauri-apps/api/app")` in `SettingsScreen`'s one-shot facts effect,
rendered as the first Diagnostics row, and `mobile.settings.appVersion` in both
catalogues (`App version` / `အက်ပ် ဗားရှင်း`). `npm run verify` green. The
review trimmed both new comments to one line each.

## F7 — sync needs a fresh scan and an open panel every time · **in progress (owner-approved 2026-11-27, uncommitted)**

`syncNow` in `src/components/MobilePairingCard.tsx` reads `offer?.endpoint`;
without a newly scanned/pasted pairing string the card shows
`mobile.settings.syncNeedsCode`. The desktop listener only lives while
Settings → Pairing is open and the app is unlocked. That is a coherent design
(the pin carries no endpoint), but heavy for a "your phone now syncs" release.

Options: disclose plainly (cheap), or remember the last endpoint per peer
locally — device-local, no wire change, and the pinned key is still what
authenticates a peer, so a wrong address can only fail, not impersonate.

Owner approved the second option on 2026-11-27, Bluetooth-style: the remembered
endpoint is kept per peer (device-local, `settings` under
`sync_endpoints`-style keys), and the desktop keeps a pinned-only listener
window alive while the app runs — so a remembered phone syncs without a fresh
scan. Both are now in the tree, uncommitted, with no version bump; the Rust
half (envelope counter floors, `pairing_counter.rs`) is written but NOT
compiled — no Rust toolchain on the working machine — so this cannot ship
until `npm run verify` (including the Rust suite) is green elsewhere.

Known gaps to close before this can be called done:

- The phone's INBOUND acceptance floor (`ReplyCounter` in
  `pairing_client.rs`, §7.2 for desktop→phone envelopes) is in-memory only,
  reset on phone restart and per pull. The desktop→phone direction therefore
  has no durable anti-replay guarantee across phone restarts, unlike the
  phone→desktop floors this work adds. The desktop cannot raise its
  `send_counter` floor across windows either — it restarts at 1 per window
  by design (§11.4) — so a durable floor here needs a protocol decision, not
  just a settings row.
- `gallery.pendingPhotoFile.*` cleanup records (see F14) also travel in
  backups today; decide that before the release notes describe what a restore
  carries.
- Burmese (my) copy for every new paired-phone string is in place but has had
  no native-speaker read-through.


## F8 — the phone has no backup or export of its own · **done 2026-11-23**

Its only path to safety is the desktop. A phone factory reset or rollback loses
device-local reminders and settings outright (`docs/ANDROID_DISTRIBUTION.md` §6
is honest about this). Needs a plain sentence in the notes; code change out of
scope for 0.3.0.

The sentence landed in `RELEASE_NOTES.md` ("The phone has no backup or export
of its own — its safety net is the desktop…") on 2026-11-23.

---

# Before release day, cheap and concrete

## F9 — the gate does not compile the Android Rust target, and nothing pins the manifest permissions · **fixed (committed)**

`npm run check:android` (`cargo check --target aarch64-linux-android`) is not in
`npm run verify`, so a break in `cfg(target_os = "android")` code passes the
whole gate; only an APK build catches it. And the missing
`android.permission.CAMERA` shipped once (2026-11-11) and no check would catch
it again.

Fixes, both small: add `check:android` to the gate with the skip-when-target-
missing pattern the APK gate uses, and a source check that
`AndroidManifest.xml` still declares INTERNET, CAMERA, POST_NOTIFICATIONS,
SCHEDULE_EXACT_ALARM, RECEIVE_BOOT_COMPLETED.

Landed as `4c1579e`. `scripts/check-android-target.mjs` is now `check:android`: it
probes the target's std, the NDK, the cross-compiler on PATH, a make and perl's
OpenSSL modules, names whichever is missing and skips, and otherwise runs
`cargo check --target aarch64-linux-android` and fails the gate on a compile
error. `scripts/check-android-manifest.mjs` pins the five permissions and fails
on a missing or unexpected one — proved by deleting CAMERA and reading the
failure before restoring the file. Both run in `npm run verify`.

The compile step first skipped here: the perl module tree and the make shim the
toolchain doc puts in `%TEMP%` were gone, and the script only read the shell it
inherited. The toolchain was rebuilt from `docs/ANDROID_TOOLCHAIN.md` (the four
module directories copied from Strawberry with their binaries pruned, `npm run
setup:android-make-shim` for `make.exe`), and the script now discovers those
pieces itself — NDK bin and shim on PATH, `%TEMP%\android-perl\lib` as a POSIX
`PERL5LIB` with `MSYS2_ENV_CONV_EXCL`, bare `CC`/`AR`/`RANLIB` — each only when
the caller has not set it (`03c50c9`). It then compiled libcrypto and the crate
for `aarch64-linux-android`, and `npm run verify` reports `check-android: OK —
cargo check --target aarch64-linux-android compiles the Android target`. A first
attempt died mid-OpenSSL with Windows `0xC0000142` on one `clang` invocation; the
incremental rerun completed, so the passing gate is a real compile, not a skip.
The two steps are now described in `docs/ANDROID_DISTRIBUTION.md` §3 and
`docs/RELEASE.md` (`71797a2`). A fresh-eyes pass then dropped the cross-compiler
`PATH` probe (the script prepends the NDK's bin itself, so that check could
never fail on its own) and merged the two functions that resolved one NDK path
into one, leaving three skip reasons instead of five; with cargo and OpenSSL
compiled the step costs 2 s. Hiding `%TEMP%\android-shim` and
`%TEMP%\android-perl` still produces the skip with those two reasons named.

## F10 — the dependency re-check `docs/RELEASE.md` step 1 requires is outstanding · **done (committed), four holds**

`npm outdated` today: `@biomejs/biome` 2.5.15 → 2.6.8, `@tailwindcss/vite` and
`tailwindcss` 4.3.3 → 4.3.5, `@tauri-apps/api` 2.12.3 → 2.12.5,
`@tauri-apps/cli` 2.12.2 → 2.12.6, `@tauri-apps/plugin-dialog` 2.8.2 → 2.8.4,
`@tauri-apps/plugin-notification` 2.6.0 → **2.8.1**,
`@tauri-apps/plugin-opener` 2.7.2 → 2.7.3, `@tauri-apps/plugin-updater` 2.13.3
→ 2.14.1, `@types/node` 24.19.2 → 26.6.6, `@vitejs/plugin-react` 6.1.2 → 6.3.0,
`react`/`react-dom` 19.3.0 → 19.3.1, `vite` 8.3.4 → 8.3.8.

The notification plugin is on the Android reminder path, so that one is a
decision, not a shrug: take it now and re-run the phone's reminder check, or
record it as deliberately deferred. The rest are patch bumps.

Decided and landed as `47a1179`. **Taken:** Tauri JS API 2.12.5, CLI 2.12.6,
plugin-notification 2.8.1, plugin-opener 2.7.3, React 19.3.1, Vite 8.3.8,
`@vitejs/plugin-react` 6.3.0, Tailwind 4.3.5 (both packages), plus Rust-side
tauri 2.12.7, tauri-plugin-notification 2.8.1, -opener 2.7.3 and
-single-instance 2.5.5. **The notification move is worth it:** 2.8.1 fixes
permission requests never resolving on Android 13+ when the grant is already
held, and `askNotifications` in `MobileScreens.tsx` calls `requestPermission()`
unconditionally, so that button could stay busy forever; 2.7.0 was Linux-only
and 2.8.0 adds chronometer options nothing uses.

**Held, each with the check that would clear it:** tauri-plugin-dialog 2.8.4
(rfd 0.16.1 → 0.17.2, the native file dialog behind export/restore — clear it by
opening both dialogs by hand), tauri-plugin-updater 2.14.1 (zip 4.6.1 → 9.8.1,
inside the updater's archive path — clear it with one real update rehearsal),
`@biomejs/biome` 2.6.8 (new `noUselessFragments`/`useMathMinMax`/
`noComponentHookFactories` rules flag six existing sites — its own commit),
`@types/node` 26.6.6 (`assert.match`'s message argument stops accepting
`undefined`; one helper in `pairing.test.ts` fixes it).

## F11 — the reset → re-pair → re-adoption path has never run on hardware · **open**

`docs/ANDROID_BUILD_TODO.md` says it in its own words: the §9.4 re-adoption
after a desktop restore (generation bump → needs-re-pair → re-pair) and the
fold's two-device run are proven in tests only. It is the most data-loss-
adjacent untested path in the release, and it is cheap to run once the 0.3.0
APK is installed.

---

# Hygiene

## F12 — small leftovers · **done 2026-11-23**

Closed 2026-11-23: the `hs_err_pid` gotcha line landed in
`docs/ANDROID_TOOLCHAIN.md`. The one `ANDROID_BUILD_TODO.md` item still
unticked stays unticked on purpose — its remaining part is the owner's
Redmi checklist and the upgrade/rollback drills, hardware work tracked
with F11; the "WAVE 3 wording" remark is a historical session note, and
the upload it concerned shipped and was proved on hardware on 2026-11-12.

- The APK symbol-gate prompt was untracked; it was moved into
  `docs/history/` on 2026-11-21, where the other prompts already live.
- `src-tauri/hs_err_pid14240.log` records a Gradle daemon JVM crash
  (2026-11-16, `EXCEPTION_ACCESS_VIOLATION` in `jvm.dll`, JDK 17, Gradle
  9.6.1). Gitignored and harmless, but one gotcha line in
  `docs/ANDROID_TOOLCHAIN.md` would save a confused hour if it recurs during the
  release build.
- `docs/ANDROID_BUILD_TODO.md` still has the signed-APK item unticked (F3) and
  an open "upload's own WAVE 3 wording" item to close or drop.

---

## F14 — `gallery.pendingPhotoFile.*` cleanup records travel in backups · **open**

Pending photo-file cleanup lives in `settings` under
`gallery.pendingPhotoFile.<id>.<rel_path>` (the row is deleted, the unlink is
still owed — see `src/lib/gallery.ts`). Per the module's own comment these
rows are "exported with every backup". Two consequences on a restore onto a
different machine or into a different gallery folder:

- the sweeper can try to delete `rel_path` there — a path that may now belong
  to a live photo or another app's data;
- nothing restores the bytes the record was owed for, so the record is stale
  by construction (the pending file is not in the zip).

Smallest fix I would accept: treat `gallery.pendingPhotoFile.` as a
device-local prefix in `backup.ts` (same border as `sync_endpoints` and
`paired_phone_reachable`) — one entry in `DEVICE_LOCAL_SETTING_PREFIXES` plus
a test pinning the exclusion, exactly the `pairing_counter.` treatment — or,
if byte-portable cleanup is wanted, carry the photo bytes in the archive.
Either is a decision, not a default.

# Working order

- [x] F1 — release runbook: Android step, ordering, assets, gotcha — `9f8ab3a`
- [x] F2 — release notes rewritten for 0.3.0 — `7ca4d07`
- [x] F5 — disclose-only: sync result names replaced edits — `34d5b03`
- [x] F6 — phone app version in Diagnostics — `579374a`
- [ ] F3 + F4 — 0.3.0 APK build, check, Redmi checklist (0.2.0 run 2026-11-21 passed all but F13), upgrade drill
- [ ] F11 — hardware run of reset → re-pair → re-adoption
- [x] F10 — dependency decision (notification plugin), then patches
- [x] F9 — gate: `check:android` + manifest permissions
- [ ] F7 — remember endpoint + durable resting window (owner-approved 2026-11-27, uncommitted, uncompiled Rust)
- [ ] F14 — decide backup travel of `gallery.pendingPhotoFile.*`
- [x] F8 — no-phone-backup sentence in the release notes — 2026-11-23
- [x] F12 — hygiene — 2026-11-23
