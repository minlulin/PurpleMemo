# Purple Memo Android — IPC surface

Session 5 probe, run against the debug APK on the Redmi Note 14 Pro+
(`4c61bf7a`, USB) with the app unlocked. Every command was invoked **from the
Android webview** through `window.__TAURI_INTERNALS__.invoke` and the answer
recorded. Mutating commands were probed with deliberately wrong argument types:
a serde type error proves the command is registered without running it.

## Verified on Android

| Surface | Probe | Result |
| --- | --- | --- |
| `db_query` | `SELECT 1 AS one` | `[{"one":1}]` |
| `db_execute` | wrong `params` type | registered (`invalid type: integer 123, expected a sequence`) |
| `db_batch` | wrong `statements` type | registered |
| `db_begin` / `db_commit` / `db_reset_txn` | no args | each ran (`null`) |
| `db_rollback` | no open transaction | reached the command (`no open transaction to roll back`) |
| `photo_read` / `photo_delete` | wrong `relPath` type | registered |
| `db_key_save` | wrong `path` type | registered |
| `backup_save_file` / `export_save_file` | no headers | reached the command (`missing x-…-path header`) |
| `backup_safety_copy` | wrong `label` type | registered |
| `backup_import_begin` / `backup_import_end` | no args / lease | window opened and closed cleanly (lease 1) |
| `share_arm` | during that import window | correctly refused (`an import is replacing this app's data`) |
| `share_status` / `share_publish` | read / wrong type | `{running:false,…}` / registered |
| `factory_reset`, `app_restart` | not invoked | destructive; **not** probed from the shell |
| `reminder_sync` | `rows: []` then real rows | `{exact, delivered, scheduled, inexact}` |
| `reminder_exact_state` | no args | `"exact"` / `"inexact"` both observed |
| `reminder_open_exact_alarm_settings` | not invoked in the probe | opens the OS grant screen |
| `clipboard_copy_sensitive` | test value | `30000` (delay ms) |
| `clipboard_probe_read` | no args | debug-only; returned the copied value |
| `plugin:notification|is_permission_granted` | no args | `true` |

Unknown commands behave as expected: `this_command_does_not_exist` →
`Command … not found`, which is what makes the absences below meaningful.

## Desktop-only, isolated by construction

| Surface | Mobile answer |
| --- | --- |
| `plugin:updater|check` | `plugin updater not found` |
| `plugin:opener|open_url` | `plugin opener not found` |
| Tray icon, Show/Quit menu, close-to-tray | `#[cfg(desktop)]` in `lib.rs`; absent |
| Single-instance guard | `#[cfg(desktop)]`; Android owns app lifetime |
| `unminimize`, window show/focus | `#[cfg(desktop)]` inside `focus_main_window` |

## Findings from this probe

1. **The updater and the opener were leaking into the mobile build.** Both were
   registered unconditionally, so the phone exposed `plugin:updater|check` and
   `plugin:opener|open_url`. They are now gated with `#[cfg(desktop)]`, and the
   probe above shows the surface is gone.
2. **Update checks on Android now fail with a sentence, not a plugin error.**
   `checkForUpdate()` refuses on Android with "updates are installed from the
   desktop build; this phone is updated by installing a new APK".
3. **External links in notes do not open on Android yet.** `MarkdownLink` calls
   `plugin-opener`, which the phone no longer has; the call is caught and
   ignored. Opening links through the system browser is Phase A platform work,
   recorded here rather than worked around.
4. **Two commands are reachable but not safe to probe from the shell**:
   `factory_reset` and `app_restart` act immediately with no argument that can
   be made invalid. Their registration is covered by the handler list, not by
   this probe.

## Reminder and clipboard surface, in one line each

* `reminder_sync(rows)` reconciles the phone's armed alarms with the pending
  rows and returns `{exact, delivered[], scheduled, inexact}`; `delivered` is
  the device-local delivery state the app settles rows from.
* `clipboard_copy_sensitive(text)` copies through the native bridge so the
  clip can be marked sensitive and cleared on a timer; `clipboard_probe_read()`
  exists only in debug builds.
