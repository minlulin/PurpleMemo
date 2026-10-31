# Purple Memo audit findings — Batch 12

- **Base:** `dev` at `61abbb4283409fef484409b187f09b59f8942a01` (after Batch 11).
- **Working branch:** `arena/7192c927-purplememo`.
- **Scoped files, read completely and in order:** `src/lib/settings.ts`, `src/pages/TrashPage.tsx`, `src/pages/MorePage.tsx`, `src/lib/dashboard.ts`, `src/lib/confirm.ts`, `src/lib/useReveal.ts`, `src/lib/links.ts`, and `src/main.tsx`.
- **Method:** Traced the scoped implementations through their imports and callers, including Settings, Dashboard, Trash, Gallery, `urgency.ts`, `ConfirmButton.tsx`, `MarkdownLink.tsx`, `App.tsx`, the translation catalogue, and relevant repository, native, and test seams. Compared candidates with the prior audit findings and honored the supplied exclusions. Findings below are anchored in the scoped files; supporting implementations explain the effect of their calls. No source fixes or refactoring are included.
- **Reproduction limits:** SQLite/Trash reproductions use the fixture from `trash.test.ts` and a controlled `DataDriver`; the file-race reproduction also uses real temporary files. React Markdown and Settings rendering were exercised with the installed dependencies. The invalid-theme case was additionally checked in a standalone headless Chromium harness rendering the actual `SettingsPage`. These are not full Tauri desktop or native-opener end-to-end tests.

## Findings

| ID | Severity | Scoped area | Summary |
| --- | --- | --- | --- |
| M1 | Med-high | `TrashPage.tsx` | Restore can silently attach a relationship to an unrelated item after SQLite reuses an ID. |
| M2 | Med-high | `TrashPage.tsx` | A photo-file deletion failure loses the only cleanup record; retry can report success while the original file remains. |
| M3 | Med-high | `TrashPage.tsx` | Trash photo cleanup can delete the file of a concurrent successful Gallery save. |
| M4 | Med | `settings.ts`, `main.tsx` | A parseable non-theme setting can crash Settings and unmount the root. |
| M5 | Low-med | `links.ts` | The advertised `tel:` route is stripped before the link component receives it. |
| M6 | Low-med | `links.ts` | URLs classified as external can be refused by the opener because the original scheme is not normalized. |

### M1 — Med-high — Restore can link to an unrelated replacement after ID reuse

**Evidence:** The scoped Restore control calls `trashRepo.restore(item.id)` and reports success (`src/pages/TrashPage.tsx:130–140`). Trash snapshots include relationship endpoints (`src/lib/trash.ts:144–151,443–475`). On restore, the other endpoint is looked up by its old numeric ID and, if any live row exists, the saved link is inserted immediately (`trash.ts:614–656`); the corresponding Trash snapshot is checked only if that live lookup found nothing (`:659–684`). Notes and tasks use `INTEGER PRIMARY KEY` without `AUTOINCREMENT` (`src-tauri/src/schema.rs:159–168,405–412`), and ordinary task creation lets SQLite assign the ID (`src/lib/tasks.ts:146–158`).

**Problem and reproduction:** In the SQLite fixture, link note 1 to task 1; trash the note, then the task; create an unrelated task, which reuses ID 1; restore the note and then the original task. The note is linked to the unrelated replacement task 1. The original task is restored under ID 2 because ID 1 is occupied, but its former relationship is not recovered. The Trash rows are consumed without an error. A live row with the old number is not proof that it is the snapshotted endpoint.

**Impact:** A successful-looking restore silently changes the meaning of user data and loses the original relationship. Related content may now appear under the wrong task, note, or contact.

**Fix direction:** Preserve endpoint identity across deletion and ID reuse, and resolve/remap relationships against that identity atomically. Possible designs include non-reusable stable IDs or an explicit snapshot-to-restored-ID mapping; merely testing whether an old numeric ID exists is insufficient. Add the combined two-endpoints-trashed-plus-ID-reused case, including both restore orders. Existing tests cover root-ID collision with the other endpoint still live (`src/lib/trash.test.ts:170–213`) and two-endpoint restore without ID reuse (`:272–289`), not this combination.

### M2 — Med-high — Failed photo cleanup is not retryable after Trash and photo rows commit

**Evidence:** Permanent delete is initiated from `TrashPage.tsx:51–78,146–150`. The repository removes Trash rows and unreferenced `photos` rows in a committed database batch, then calls `deletePhoto` for files whose rows are gone (`src/lib/trash.ts:703–714,717–779`). Native deletion can reject on a real filesystem error such as permission denial (`src-tauri/src/photos.rs:206–225`). If the Trash ID is missing, a later permanent-delete call returns without doing anything (`trash.ts:703–708`). Maintenance invoked after another Trash operation catches purge errors after the user operation has committed (`:475–480,695–700`).

**Problem and reproduction:** With one trashed note and one otherwise-unreferenced photo, a SQLite fixture whose `deletePhoto` throws produces an error *after* both the Trash row and photo row have disappeared. Retrying the same Trash ID returns successfully without a second file-delete attempt; a later purge also makes no attempt. In the page, the first failure is shown without reloading the stale list (`TrashPage.tsx:60–67`), so confirming that stale row again can show “Permanently deleted” after the no-op (`:62–63,74–78`). If a batch contains several files, a failure also stops the loop before later files are attempted (`trash.ts:774–780`).

**Impact:** The original photo file can remain in the app's photo directory, no longer represented by a Gallery or Trash row and no longer reachable by ordinary cleanup. The error/retry sequence can give a false impression that the remaining file was removed. This concerns an orphaned original, not the already-disclosed possibility of operating-system backups or forensic remnants (`src/lib/i18n.ts:265–269`).

**Fix direction:** Keep a durable, retryable cleanup record until each physical deletion succeeds, and make the UI distinguish a committed item deletion with pending file cleanup from complete success. Cover a thrown first file delete, multiple files, retry, and restart/purge. The existing test pins successful cleanup of an unreferenced file (`src/lib/trash.test.ts:457–488`), not failure after the DB commit.

### M3 — Med-high — Trash cleanup can unlink a concurrently saved Gallery photo

**Evidence:** The same Trash action and automatic retention purge reach `removeTrashRows` (`src/pages/TrashPage.tsx:74–78`; `src/lib/trash.ts:783–802`). After deleting photo rows, cleanup checks whether the *old ID* is still stored and then separately deletes the old path (`trash.ts:753–779`). Gallery saves a content-addressed file first and inserts or reuses its database row afterward (`src/lib/gallery.ts:197–245`); Gallery's Add photos control uses that path (`src/pages/GalleryPage.tsx:211–226,384–397`). Rust's photo mutex covers each file save/delete, not the subsequent Gallery database insertion (`src-tauri/src/photos.rs:25–31,43–55,206–214`). The unlock purge is detached from the workspace (`src/App.tsx:653–658`).

**Problem and reproduction:** In a SQLite fixture with a gated filesystem driver, pause Trash after its old-row check but before its physical unlink. Save the same bytes and extension to Gallery in the same year/month, so the content-addressed path is the same (`src-tauri/src/commands.rs:358–369`; `photos.rs:62–75`). The Gallery save returns a live photo ID and the real temporary file exists. Resume Trash: it unlinks that path. The new Gallery row remains, but a subsequent read returns `ENOENT`. This models the interleaving; it was not run through native Tauri IPC.

**Impact:** An import reported as successful can leave a live Gallery entry with missing original bytes. The individual Rust file-operation lock does not protect the combined file-and-row lifecycle, and serializing only Trash's own mutators does not serialize Gallery saves.

**Fix direction:** Coordinate save and garbage collection by photo path across both the DB and filesystem operations, or provide an equivalent atomic native lifecycle that cannot delete a newly adopted path. A second unprotected existence check alone still leaves a check/unlink race. Add a gated interleaving test with the same content-addressed path, including the background-purge route; retain the existing Trash-mutator serialization (`trash.ts:392–405,809–819`).

### M4 — Med — A parseable invalid theme can crash Settings and unmount the app root

**Evidence:** `getJSON` casts parsed JSON without validating its runtime type (`src/lib/settings.ts:32–39`), and `getTheme` returns that value as `Theme` (`:28,86–88`). The shell applies only a nullish fallback and passes the value to Settings (`src/App.tsx:458–474,487–497,1005–1014`), where it is rendered directly as a React child (`src/pages/SettingsPage.tsx:830–838`). The root is rendered without an error boundary (`src/main.tsx:7–15`; `App.tsx:1190–1199`). Backup parsing checks table arrays and specific relationships/Trash data, but not the allowed theme values (`src/lib/backup.ts:517–603`).

**Problem and reproduction:** A current-format backup with a settings row `{ key: "theme", value: "{}" }` was accepted by `parseBackupZip`; a separate mocked settings read of that value made `getTheme` return an object rather than `null`. Rendering the actual Settings page with that value throws “Objects are not valid as a React child.” In a standalone Chromium harness with the actual page and toast provider, switching from `"dark"` to `{}` removed the root's children. An unsupported string likewise bypasses the intended `"dark"` fallback, although it does not cause that object-child exception.

**Impact:** A damaged or foreign/crafted settings row can make opening Settings blank the application rather than presenting a recoverable appearance choice. The user cannot correct the theme through the page that crashes.

**Fix direction:** Validate the parsed theme as exactly `"dark"` or `"light"` before it reaches shell state, with a documented fallback for all other JSON values. Consider an error boundary as containment, not as a substitute for validation. Add tests for objects, arrays, booleans, and unknown strings as well as the two valid values. `settings.test.ts:33–45` pins missing/unparseable JSON behavior, not acceptance of a parseable non-theme value.

### M5 — Low-med — `tel:` is allowed by the router but removed by Markdown before routing

**Evidence:** The scoped link contract explicitly offers `tel:` and its allowlist classifies it as external (`src/lib/links.ts:11–18,27–43`); `src/lib/links.test.ts:9–18` pins that intended policy. Notes, Journal, and the note reader render `ReactMarkdown` with the shared anchor component but no custom URL transform (`src/pages/NotesPage.tsx:243–249`, `src/pages/JournalPage.tsx:481–487`, `src/components/NoteReaderDialog.tsx:208–214`). The pinned `react-markdown` 10.1.0 dependency (`package.json:32–34`) uses a [default protocol allowlist](https://github.com/remarkjs/react-markdown/blob/10.1.0/lib/index.js#L124) that omits `tel:` and [returns an empty URL](https://github.com/remarkjs/react-markdown/blob/10.1.0/lib/index.js#L421-L444) for it (upstream `lib/index.js:124,315–320,421–444`). `MarkdownLink` routes the resulting `href` (`src/components/MarkdownLink.tsx:17–24,29–35`).

**Problem and reproduction:** Rendering `[phone](tel:+15550100)` with the installed Markdown renderer passed `href=""` to the anchor component; `routeLink("")` returned `"blocked"`. The same number passed directly to `routeLink` returns `"external"`. Thus the test verifies the intended router policy, not the actual rendered-link path; no test pins the stripping behavior.

**Impact:** Telephone links in all three Markdown views are inert even on a system with a phone handler, despite being advertised as supported.

**Fix direction:** Supply a narrowly scoped Markdown URL transform that preserves valid `tel:` URLs while continuing to reject dangerous protocols, or deliberately change and document the policy. Exercise rendered links end to end, including `tel:`, `javascript:`, `data:`, and relative URLs; do not weaken the existing Batch 11 XSS boundary.

### M6 — Low-med — The router validates a normalized scheme but sends the unnormalized URL to a case-sensitive opener scope

**Evidence:** `routeLink` trims and parses with `new URL` and checks its normalized `protocol` (`src/lib/links.ts:30–43`), while `MarkdownLink` passes the original `href` to `openUrl` (`src/components/MarkdownLink.tsx:17–24,29–36`). The app enables `opener:allow-default-urls` (`src-tauri/capabilities/default.json:5–11`) and pins opener 2.7.2 and `glob` 0.3.4 (`src-tauri/Cargo.lock:1521–1524,4366–4373`). The pinned opener's [default scopes](https://github.com/tauri-apps/plugins-workspace/blob/opener-v2.7.2/plugins/opener/permissions/allow-default-urls.toml#L7-L17) are lowercase globs such as `https://*`; its [scope matcher](https://github.com/tauri-apps/plugins-workspace/blob/opener-v2.7.2/plugins/opener/src/scope.rs#L38-L42) calls `glob::Pattern::matches` ([`scope.rs:80–83`](https://github.com/tauri-apps/plugins-workspace/blob/opener-v2.7.2/plugins/opener/src/scope.rs#L80-L83)), whose default is case-sensitive ([glob `src/lib.rs:770–772,1083–1107`](https://github.com/rust-lang/glob/blob/v0.3.4/src/lib.rs#L1083-L1107)).

**Problem and reproduction:** `routeLink("HTTPS://example.com")` returns `"external"`, and the installed Markdown renderer preserves that uppercase `href`. The original value does not match the lowercase opener glob, so the native scope rejects it before any system handler is invoked. The page reports that the system has no handler (`MarkdownLink.tsx:34–37`), which is not the cause. This last native rejection follows from the pinned scope implementation; it was not exercised in a Tauri desktop runtime. Existing link tests use lowercase external schemes (`links.test.ts:9–18`).

**Impact:** Valid links with mixed/uppercase schemes appear openable but fail, with a misleading explanation. This is a functional mismatch, not a claim that dangerous schemes bypass the XSS defense.

**Fix direction:** Pass a normalized, still-allowlisted URL to the opener, or otherwise align the classifier and opener scope without widening allowed schemes. Test uppercase/mixed-case HTTP(S) and mail schemes through the renderer and opener seam, plus blocked-scheme cases.

## DECISION

### DECISION 1 — Does Gallery own a photo independently of its last linked Trash item?

**Observed, test-pinned behavior:** The page offers permanent deletion of an item and displays a general deletion notice (`src/pages/TrashPage.tsx:102,146–153`; `src/lib/i18n.ts:265–269`). When the item's last live or Trash reference is removed, its photo row and file are also deleted (`src/lib/trash.ts:753–779,783–802`); the successful deletion is explicitly asserted by `src/lib/trash.test.ts:457–488`. Yet Gallery can import photos independently (`src/pages/GalleryPage.tsx:211–226,384–397`), lists all photo rows (`src/lib/gallery.ts:249–252`), and has a “Not linked to anything yet” state (`GalleryPage.tsx:529–532`). A Gallery-imported photo can therefore disappear when its only linked note or memory is permanently deleted or automatically expires, even though the notice names the item rather than Gallery files.

**Decision needed:** Should a Gallery import remain independently owned after its last link is removed, or should last-reference garbage collection remain the rule? If Gallery ownership wins, represent ownership independently and update the test-pinned cleanup policy. If current cleanup is intentional, disclose the affected Gallery photos before permanent deletion and in retention guidance, including the automatic-purge case. This is a behavior choice, not an assertion that the existing successful-cleanup test is wrong.

### DECISION 2 — Are Markdown headings intended to be hash-link targets?

**Observed behavior, with hash routing test-pinned:** `links.ts:19–20,30–33` treats `#section` as an in-document link, and `links.test.ts:21–23` pins the hash route. However, the current Markdown views supply only `markdownComponents` (`NotesPage.tsx:247–249`, `JournalPage.tsx:485–487`, `NoteReaderDialog.tsx:212–214`); the shared object overrides only anchors (`MarkdownLink.tsx:53–58`). Rendering `# Introduction` followed by `[Jump](#introduction)` produced `<h1>Introduction</h1>` with no `id`, and a raw `<a id="custom">` was rendered as text. A hash targeting that Markdown heading therefore has no corresponding Markdown-generated target.

**Decision needed:** If heading navigation is intended, define stable, deduplicated, safely scoped heading IDs and test actual fragment navigation without enabling raw HTML. Otherwise, keep the tested hash-routing policy and document that it only works when a matching target exists elsewhere in the document; do not imply ordinary Markdown headings automatically provide targets.

## Checked and found clean within the inspected paths

- **Settings defaults:** Locale is validated (`settings.ts:94–101`); notification previews require JSON `true` (`:126–141`); close-to-tray requires explicit JSON `false` to turn off (`:144–161`), matching the native key/default for absent or malformed values (`src-tauri/src/lib.rs:543–545,627–665`). The corresponding settings tests cover missing, malformed, and explicit boolean values (`src/lib/settings.test.ts:99–168`).
- **Trash guards and dates:** The page raises a synchronous `busyRef` before invoking an action (`TrashPage.tsx:51–71`). Date-only deletion dates use `formatDateTime` (`:123–127`), whose date-only branch does not invent a time (`src/lib/format.ts:61–71`; `format.test.ts:40–49`). These checks do not resolve M1–M3.
- **More navigation:** Each of the nine declared secondary cards dispatches its own typed `PageKey` through `onNavigate` (`src/pages/MorePage.tsx:18–49,75–94`); no incorrect card-to-page mapping was found in those entries.
- **Dashboard and urgency:** Recurring bills include overdue and the inclusive 14-day horizon without mutating the input (`src/lib/dashboard.ts:8–35`; `dashboard.test.ts:76–107`). Warranty selection excludes lapsed/out-of-horizon entries (`dashboard.ts:57–81`). The separate three-day urgency threshold (`src/lib/urgency.ts:9–27`) grades due dates rather than defining the coming-up horizon; its boundary tests passed. The caller intentionally supplies open jobs (`src/pages/DashboardPage.tsx:165–175`), so no caller-only policy is reported as a helper defect.
- **Confirmation transitions:** The pure machine refuses `run` from idle/running and refuses cancel while running (`src/lib/confirm.ts:40–54`; `confirm.test.ts:41–72`). These tests check state transitions, not the component's side effects. Trash's separate synchronous action guard is noted above.
- **Reveal:** This is a Dashboard scroll-animation hook, not a secret-reveal mechanism. It attaches after loading, releases targets when reduced motion is requested or `IntersectionObserver` is absent, and disconnects the observer (`src/lib/useReveal.ts:22–53`; `src/pages/DashboardPage.tsx:146–147,309–310,353–354`). CSS also makes targets visible under reduced motion (`src/styles/app.css:995–1013`). A standalone Chromium observer probe at normal and short viewport heights produced intersecting entries; this was not a full Dashboard UI test.
- **Link security and boot/provider wiring:** Dangerous and relative schemes remain classified as blocked (`links.ts:21–23,30–43`; `links.test.ts:26–55`), non-hash clicks are prevented in the component (`MarkdownLink.tsx:29–35`), and the Rust navigation guard independently rejects non-app origins (`src-tauri/src/navigation.rs:66–87`). `main.tsx:7–15` checks for `#root` and mounts `App` in `StrictMode`; `App.tsx:1190–1199` supplies the toast provider. No separate StrictMode/provider failure was verified. M4–M6 and the decisions above do not claim a regression of the Batch 11 XSS fix.

## Tests run

Node `v24.22.2`; dependencies were installed transiently. These are the exact test invocations, excluding shell output redirection. Only the scoped modules and their examined support seams are listed.

| Command | Result |
| --- | --- |
| `npm exec --yes --package=node@24 -- node --test src/lib/settings.test.ts src/lib/dashboard.test.ts src/lib/confirm.test.ts src/lib/links.test.ts src/lib/notesView.test.ts src/lib/urgency.test.ts` | 44 passed, 0 failed |
| `npm exec --yes --package=node@24 -- node --test src/lib/trash.test.ts` | 19 passed, 0 failed |
| `npm exec --yes --package=node@24 -- node --test src/lib/appLock.test.ts src/lib/i18n.test.ts src/lib/format.test.ts src/lib/gallery.test.ts` | 74 passed, 0 failed |

The targeted SQLite/file interleavings, Markdown server-render checks, invalid-theme browser harness, and observer probe described above are additional reproductions, not committed automated tests. No native Tauri desktop suite or full application UI suite was run.
