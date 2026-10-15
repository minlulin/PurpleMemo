# M-02 phase plan — the photo pipeline

**Finding:** `docs/CODE_REVIEW_2026-10-14.md` §4 M-02 — photo bytes cross IPC as
JSON number arrays, the gallery holds full-resolution bytes for every photo, and
backup export builds the whole archive synchronously on the UI thread with no
cap. **Severity:** Medium (performance, memory, UI freeze).

**Status:** implemented (see the commit and `npm run verify` output for this
phase). This document is the plan the implementation follows; the code is the
authority where the two disagree.

## What is actually wrong

1. `photo_read` returns `Vec<u8>`, which serde/Tauri serialises as a JSON array
   of byte numbers — ≈ 5–10 characters per byte on the wire, then a JS number
   array, then a `Blob`. `photo_save` takes the same shape back.
2. `GalleryPage.loadThumbnails` fetches **full-resolution** bytes for every
   photo, sequentially, and keeps every resulting blob URL alive: a 3 MB photo
   costs 3 MB of live blob, 300 photos ≈ 900 MB.
3. `readBackupData` holds every table plus every photo as a `number[]`, then
   `zipSync` deflates the whole archive synchronously on the UI thread. The
   import path is capped; the export path is not capped at all.

## Decisions (rulings)

- **Raw bytes both ways, no `asset:` protocol.** Tauri 2.12.3 (the pinned
  version) supports `tauri::ipc::Response` for raw responses and a raw request
  body for commands. JS receives an `ArrayBuffer`; the payload is never JSON.
  The `asset:` protocol would avoid IPC entirely, but it needs a filesystem
  scope over the whole app-data dir (the SQLCipher DB lives there), which is a
  wider grant than a traversal-guarded read command. Cost if wrong: photos
  still cross IPC, but as bytes rather than digits — the review's own first
  recommendation.
- **Raw body + `x-photo-ext` header for `photo_save`.** A raw payload *is* the
  whole request body, so the extension cannot ride along as a JSON field; the
  documented metadata channel for a raw body is a request header.
- **Thumbnails as sibling files, derived from the photo's own `rel_path`**, not
  a new database column: `photos/<y>/<m>/<sha256>.<ext>` →
  `photos/<y>/<m>/<sha256>.thumb.jpg`. The schema policy is "no SQL migrations,
  ever", so a stored `thumb_path` column would strand existing databases. The
  derivation lives in Rust only (`photo_read_thumb` / `photo_save_thumb` take
  the *source* path and derive internally), so the TypeScript layer never
  builds a photos path and the JS-facing path grammar stays exactly as strict
  as it is today.
- **Thumbnails are generated in the renderer** (canvas downscale at import, and
  lazily on first read for photos saved before this phase) rather than in Rust:
  no new crate, no second decoder, and the webview is already the component
  that has to decode these files to display them.
- **Thumbnails are not backed up.** A backup stays "the manifest plus the
  photos tree"; thumbs are derived data and are regenerated on demand after an
  import. That keeps backups honest and smaller.
- **Export is capped, with the limit checked before a single byte is read**
  (`photos.size_bytes` is already stored), and the zip moves to fflate's async
  API so deflate runs in a worker. If the worker is unavailable (CSP or
  platform), the build falls back to the blocking path rather than failing the
  export — the cap is what bounds memory; the worker only buys responsiveness.
- **Zipping does not move into Rust.** That would duplicate the backup format
  and its limits in a second language while the import path stays in
  TypeScript; a split authority over a data-safety format is a worse trade than
  the blocked-thread risk the worker already removes.

## Tasks

**Task 1 — raw bytes over IPC.**
`photo_read` returns `tauri::ipc::Response::new(bytes)`; `photo_save` becomes
`fn photo_save(request: tauri::ipc::Request)` reading `InvokeBody::Raw` plus the
`x-photo-ext` header (rejecting anything else). Driver types become
`Uint8Array` (`savePhoto`, `readPhoto`), the mock driver mirrors them, and
`gallery.ts` / `backup.ts` stop converting to and from `number[]`.
*Verification:* `cargo test`; `node --test` for the driver, gallery and backup
suites; the byte-for-byte round trip is asserted in both languages.

**Task 2 — thumbnails.**
`photos.rs` grows `thumb_rel_path` (pure, derives from a validated path) and
`write_atomic` (shared with `save_photo`); `delete_photo` also removes the
sibling thumb, so a deleted photo leaves no orphan. New commands
`photo_read_thumb(source)` and `photo_save_thumb(source, bytes)`. The gallery
grid reads thumbs, the inspector reads full bytes on demand and releases the
previous object URL; thumb generation uses `createImageBitmap` +
`<canvas>` with the target box computed by a pure, tested `thumbBox`.
*Verification:* Rust tests for derivation, sibling delete and idempotence;
`thumbBox` unit tests; a real-browser pass over the gallery grid.

**Task 3 — export.**
`exportBudget(photoRows)` is a pure, tested helper returning the total photo
bytes and a refusal above the cap; `buildBackupZip` becomes async with the
documented sync fallback; `readBackupData` reads raw bytes; the Settings export
surfaces the cap message instead of starting a doomed export.
*Verification:* unit tests for the budget arithmetic and for the async zip
round trip (including a payload the async path must reject and the fallback
must still produce).

## Known limits

- `InvokeBody::Raw` is unsupported on Android; this app is desktop-only
  (`bundle.targets` has no mobile target). The command documents the boundary.
- fflate's async build creates its worker from a blob URL, so the CSP now
  allows `worker-src 'self' blob:` — without that the async path would be
  blocked and every export would take the synchronous fallback.
- The worker path cannot be exercised from this environment (no native
  webview), so the fallback is what makes the export correct regardless; the
  release checklist should confirm the worker is used on the target OS.
- Formats the webview cannot decode produce no thumbnail (placeholder tile);
  those files were already undisplayable in the inspector before this phase.
- `photos.size_bytes` is the cap's input; a photo row whose file is missing
  still counts toward the budget (rows and files are kept consistent by
  `applyBackup`, so this is a corrupt-install edge, not a normal state).
