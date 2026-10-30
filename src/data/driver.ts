// The single Tauri data driver: every feature library talks to this
// driver, and the driver is the only place that calls Tauri IPC. The UI never
// touches the DB directly. `db_batch` is the multi-statement write path
// (committed as one transaction inside Rust); `begin`/`commit`/`rollback`
// exist only for short critical sections — but "short" is a discipline, not a
// property of this layer (D2(2)): each is an IPC round trip, and the webview
// can run unrelated code between them. A manual transaction is a
// single-owner critical section — at most one open at a time, awaiting
// nothing outside this driver while it is held.

import { invoke } from "@tauri-apps/api/core";

/**
 * Request-header names shared with `src-tauri/src/commands.rs`. The Rust side
 * reads them through `tauri::ipc::Request::headers`; `ipc.test.ts` pins the two
 * copies together, because nothing else can: a typo here would only surface as
 * a "missing header" error on a user's machine.
 */
export const PHOTO_EXT_HEADER = "x-photo-ext";
export const PHOTO_SOURCE_HEADER = "x-photo-source";
/**
 * Carries the import lease on the RAW photo writers (E5). A raw body IS the
 * whole request, so these commands have no argument channel for the lease —
 * same reason the metadata beside it rides in a header. Absent means "an
 * ordinary app write", which Rust refuses while an import or a factory reset
 * owns the data. Pinned against `commands.rs` by `ipc.test.ts`.
 */
export const PHOTO_LEASE_HEADER = "x-import-lease";
export const BACKUP_PATH_HEADER = "x-backup-path";
export const EXPORT_PATH_HEADER = "x-export-path";

/**
 * Percent-encode a path so it can travel as a header value (review P1-1).
 *
 * A raw request body IS the whole request, so the backup destination has no
 * argument channel and must ride in a header — but header values must be
 * visible ASCII, and a path the user picked in the native save dialog need not
 * be (`C:\Users\小明\backup.zip`). Every byte outside `0x21..=0x7e`
 * (printable ASCII minus the space), plus `%` itself, becomes `%XX`, which is
 * unambiguous because a literal `%` in the name is escaped too.
 *
 * Space is escaped deliberately, not merely tolerated (J2): Fetch's `Headers`
 * normalization strips leading and trailing whitespace from a value, so a
 * space travelling raw at either end of the path would be silently deleted —
 * the backup would land at a different path than the one the user picked, with
 * no error anywhere. `decode_header_path` in Rust is the only decoder;
 * `ipc.test.ts` pins the header name and this function against it, and decodes
 * through a real `Headers` instance to prove the value survives the transport.
 */
export function encodeHeaderPath(path: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(path)) {
    if (byte >= 0x21 && byte <= 0x7e && byte !== 0x25) {
      out += String.fromCharCode(byte);
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/**
 * Validate the photo extension before it is put in a request header (J2).
 *
 * The photo headers are the two that Rust reads RAW — `header_str` in
 * `commands.rs`, no percent-decoding — so they cannot ride percent-encoded the
 * way a path does; the value must already be exactly what Rust should see.
 * Fetch's `Headers` would otherwise act first: it stringifies a non-string and
 * strips leading/trailing whitespace, so a sloppy caller would silently write
 * `photo.png` for an extension it asked to be ` png ` — and a non-Latin-1
 * value would surface as a `TypeError` thrown from inside the platform, not
 * from here. Mirrors Rust's `is_valid_ext` (`photos.rs`): 1..=8 ASCII
 * alphanumeric bytes; lowercased, because `save_photo` lowercases before it
 * composes the path.
 */
function photoExtHeader(ext: string): string {
  if (typeof ext !== "string" || !/^[A-Za-z0-9]{1,8}$/.test(ext)) {
    throw new Error(`invalid photo extension: ${JSON.stringify(ext)}`);
  }
  return ext.toLowerCase();
}

/**
 * Validate the source photo's relative path before it is put in a request
 * header (J2). Same reasoning as [`photoExtHeader`]: Rust reads this header
 * raw and validates the path itself against the strict
 * `photos/<yyyy>/<mm>/<hash>.<ext>` grammar (`validate_rel_path`), so the
 * header's job here is narrower — every byte must be printable ASCII with no
 * whitespace anywhere, which is exactly what `Headers` would otherwise strip
 * or reject. A path that passes here can still be refused by Rust; it cannot
 * be silently altered in transport.
 */
function photoSourceHeader(sourceRelPath: string): string {
  if (
    typeof sourceRelPath !== "string" ||
    !/^[\x21-\x7e]+$/.test(sourceRelPath)
  ) {
    throw new Error(
      `invalid photo source path: ${JSON.stringify(sourceRelPath)}`,
    );
  }
  return sourceRelPath;
}

/** One result row: column name -> JSON value (blob -> array of byte numbers). */
export type Row = Record<string, unknown>;

/** Rows are plain interfaces — no index signature required. */
export type Queryable = object;

export interface ExecuteOutcome {
  rowsAffected: number;
  lastInsertRowid: number;
}

export interface BatchStatement {
  sql: string;
  params?: unknown[];
}

/**
 * State of the read-only LAN share (P5). `url` is the full link the
 * phone opens — it carries the encryption key in its fragment, and is null whenever sharing
 * is off. `publishedAt` is the `generatedAt` of the last published snapshot.
 */
export interface ShareInfo {
  running: boolean;
  url: string | null;
  /** AES-256-GCM key, also carried only in the URL fragment. */
  key: string | null;
  /** Bound TCP port (shown so the user can allow it through a firewall). */
  port: number | null;
  publishedAt: string | null;
  /** Set only when sharing stopped on its own. */
  note: string | null;
}

/** The full driver surface — implemented by Tauri IPC and by test mocks. */
export interface DataDriver {
  query<T extends Queryable>(sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * One write. `lease` is the import exclusion window's lease (E5): while a
   * window is open only calls carrying it reach the database — ordinary
   * callers, quick capture above all, are refused in Rust. It is `undefined`
   * in ordinary operation, which is what every non-import call passes.
   */
  execute(
    sql: string,
    params?: unknown[],
    lease?: number,
  ): Promise<ExecuteOutcome>;
  /** Multi-statement write; `lease` as in [`DataDriver.execute`]. */
  batch(statements: BatchStatement[], lease?: number): Promise<void>;
  /**
   * Open a manual transaction on the one session-wide connection flag; at
   * most one caller may hold it (D2(2)).
   *
   * Each of `begin`/`commit`/`rollback` is a separate IPC round trip, and IPC
   * interleaves: the webview can — in React, routinely will — run unrelated
   * code between them, including another write that lands inside this
   * transaction by accident, or a second `begin` that fails in Rust while the
   * first caller still believes it owns the flag. "Never held across awaits"
   * cannot be enforced from this layer, so it is stated here as a contract on
   * callers instead: while a transaction is open, await nothing but this
   * driver. [`DataDriver.resetTxn`] is the break-glass escape.
   */
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /**
   * Break-glass for when `commit` AND `rollback` both failed (e.g., the
   * connection died) and the stuck flag would block every future `batch`.
   *
   * Since E12 this is NOT "clear the flag without touching the DB": Rust runs
   * `db::reconcile_open_txn` under the connection lock — a real ROLLBACK of
   * whatever the dead transaction left open — and only clears `txn_open` once
   * that succeeds. If the rollback fails the call REFUSES and the flag stays
   * set: clearing it while a transaction may still be open would let the next
   * `db_batch` commit over a half-dead one. When it succeeds the uncommitted
   * rows are gone; the caller re-reads and reconciles state.
   */
  resetTxn(): Promise<void>;
  /**
   * Photo bytes cross the IPC boundary as RAW payloads: the
   * request body IS the bytes, so the metadata the Rust side needs travels in
   * request headers, and a read resolves to an `ArrayBuffer` — never a JSON
   * array of byte numbers. Those two headers are validated here (J2) before
   * `Headers` can coerce or strip them — Rust reads them raw, so what the
   * platform silently changed could never be undone downstream.
   */
  /**
   * Save photo bytes; `lease` as in [`DataDriver.execute`] — the lease rides
   * in a header because a raw body is the whole request (E5).
   *
   * Rejects when `ext` is not 1..=8 ASCII alphanumeric characters (the exact
   * shape Rust's `is_valid_ext` accepts), rather than letting `Headers`
   * stringify or trim it first.
   */
  savePhoto(bytes: Uint8Array, ext: string, lease?: number): Promise<string>;
  readPhoto(relPath: string): Promise<Uint8Array>;
  /**
   * The thumbnail of a photo, addressed by the SOURCE photo's path — the
   * thumbnail path itself is derived in Rust and never built here. Rejects
   * when no thumbnail is stored yet, which the caller treats as "generate
   * one and `savePhotoThumb` it".
   */
  readPhotoThumb(sourceRelPath: string): Promise<Uint8Array>;
  /**
   * Save a thumbnail, addressed by the SOURCE photo's relative path.
   *
   * Rejects when `sourceRelPath` is not a whitespace-free printable-ASCII
   * string (J2) — Rust re-validates the path itself against the full
   * `photos/...` grammar, but nothing downstream could repair a value `Headers`
   * had already stripped in transit.
   */
  savePhotoThumb(
    sourceRelPath: string,
    bytes: Uint8Array,
    lease?: number,
  ): Promise<string>;
  /** Delete a photo; `lease` as in [`DataDriver.execute`] (E5). */
  deletePhoto(relPath: string, lease?: number): Promise<void>;
  /**
   * Write the DB encryption key to a file the user chose
   *
   * Deliberately takes a path and returns nothing: Rust reads the key from the
   * credential store, writes it, and drops it, so the plaintext master key
   * never crosses into the webview. The driver used to have an `exportDbKey`
   * that returned it, where it lived in React state and could be pushed onto
   * the system clipboard — which outlives the app and is readable by every
   * other program on the machine.
   */
  saveDbKeyFile(path: string): Promise<void>;
  /**
   * Write the backup archive to a file the user chose (review P1-1).
   *
   * Deliberately *not* a plugin-fs write. `fs:write-files` grants every write
   * command on every path with no accessible-path scope configured, which made
   * the webview's file-write privilege far wider than this one operation needs
   * — and, with no `allow` entry in the capability, actually made every call
   * fail, so backup export never worked. Rust does the write here instead; the
   * bytes go as a raw body and the (ASCII-encoded) destination in a header.
   */
  saveBackupFile(path: string, bytes: Uint8Array): Promise<void>;
  saveExportFile(path: string, bytes: Uint8Array): Promise<void>;
  /**
   * Copy the encrypted database and the photo library into a new folder under
   * app-data, and return that folder.
   *
   * The destination is composed in Rust from `label` (a timestamp, sanitized
   * there) — not passed in as a path — because this copy must not be
   * redirectable. A copy is not an archive: the database file is already
   * encrypted, so this needs no password and cannot leak plaintext.
   *
   * Side effect the name hides (J7): this OPENS THE IMPORT EXCLUSION WINDOW.
   * The copy runs under `Phase::Importing`, and for its whole duration every
   * ordinary writer — quick capture, a reminder ticking over, anything not
   * carrying the window's lease — is refused in Rust, session-wide. That is
   * deliberate: the undo copy must not race a write. But a caller must know
   * the lock exists before it awaits this, and must release the lease on every
   * path out, including failure.
   */
  safetyBackupCopy(label: string): Promise<string>;
  /**
   * Claim (or attach to) the import exclusion window and return its lease
   * (E5). The window opens at the safety copy; this returns the SAME lease
   * when it is already open, so one window spans the snapshot boundary
   * through FK restore.
   *
   * Optional on the interface deliberately: only the import flow needs it,
   * so the test drivers that never import leave it out and the call site
   * uses `?.()`. The production driver always implements it; the returned
   * lease is threaded into the write calls and handed to `endImportLease`
   * when the import finishes or fails.
   */
  beginImportLease?(): Promise<number>;
  /**
   * Release the import window. A late or foreign lease is refused in Rust —
   * it can never open the door for someone else's write.
   */
  endImportLease?(lease: number): Promise<void>;
  /** Start the LAN snapshot server. Idempotent while running. */
  shareStart(consentToken: string): Promise<ShareInfo>;
  /**
   * Stop the LAN listener. Idempotent.
   *
   * `forLock` is the lock path (D2a): it additionally revokes an armed
   * consent token and supersedes one that an in-flight `shareStart` has
   * already spent, so no listener can bind behind the lock screen. Ordinary
   * callers omit it and keep the ordinary semantics — a stop is not a reason
   * to make the user confirm a prompt they may still have on screen.
   */
  shareStop(forLock?: boolean): Promise<ShareInfo>;
  shareStatus(): Promise<ShareInfo>;
  /** Publish a freshly built snapshot payload for the LAN server to serve. */
  sharePublish(snapshotJson: string): Promise<ShareInfo>;
  /**
   * Record that the user confirmed the LAN-share prompt and return a one-shot
   * token for `shareStart`. Issuing is not consent — only starting the
   * listener consumes the token, and only once.
   */
  shareArm(): Promise<string>;
}

/** The one production driver: Tauri IPC commands. */
export function createTauriDriver(): DataDriver {
  return {
    query: (sql, params) => invoke("db_query", { sql, params }),
    execute: (sql, params, lease) =>
      invoke("db_execute", { sql, params, lease }),
    batch: (statements, lease) => invoke("db_batch", { statements, lease }),
    begin: () => invoke("db_begin"),
    commit: () => invoke("db_commit"),
    rollback: () => invoke("db_rollback"),
    resetTxn: () => invoke("db_reset_txn"),
    // Async so a validation failure REJECTS the returned promise (J2) rather
    // than throwing synchronously out of a call every caller already awaits.
    savePhoto: async (bytes, ext, lease) => {
      const extHeader = photoExtHeader(ext);
      return invoke("photo_save", bytes, {
        headers: {
          [PHOTO_EXT_HEADER]: extHeader,
          ...(lease === undefined
            ? {}
            : { [PHOTO_LEASE_HEADER]: String(lease) }),
        },
      });
    },
    readPhoto: async (relPath) =>
      new Uint8Array(await invoke<ArrayBuffer>("photo_read", { relPath })),
    readPhotoThumb: async (sourceRelPath) =>
      new Uint8Array(
        await invoke<ArrayBuffer>("photo_read_thumb", { sourceRelPath }),
      ),
    savePhotoThumb: async (sourceRelPath, bytes, lease) => {
      const sourceHeader = photoSourceHeader(sourceRelPath);
      return invoke("photo_save_thumb", bytes, {
        headers: {
          [PHOTO_SOURCE_HEADER]: sourceHeader,
          ...(lease === undefined
            ? {}
            : { [PHOTO_LEASE_HEADER]: String(lease) }),
        },
      });
    },
    deletePhoto: (relPath, lease) => invoke("photo_delete", { relPath, lease }),
    saveDbKeyFile: (path) => invoke("db_key_save", { path }),
    saveBackupFile: (path, bytes) =>
      invoke("backup_save_file", bytes, {
        headers: { [BACKUP_PATH_HEADER]: encodeHeaderPath(path) },
      }),
    saveExportFile: (path, bytes) =>
      invoke("export_save_file", bytes, {
        headers: { [EXPORT_PATH_HEADER]: encodeHeaderPath(path) },
      }),
    // Pre-import safety copy — opens the import exclusion window (E5).
    safetyBackupCopy: (label) => invoke("backup_safety_copy", { label }),
    beginImportLease: () => invoke("backup_import_begin"),
    endImportLease: (lease) => invoke("backup_import_end", { lease }),
    // P5 share controls — 25 commands total now, still one driver.
    shareStart: (consentToken) => invoke("share_start", { consentToken }),
    shareArm: () => invoke("share_arm"),
    // One `invoke` site, so the command surface this file is pinned against
    // still lists `share_stop` once.
    shareStop: (forLock) => invoke("share_stop", { forLock: forLock === true }),
    shareStatus: () => invoke("share_status"),
    sharePublish: (snapshotJson) => invoke("share_publish", { snapshotJson }),
  };
}

/**
 * Component names in the factory-reset outcome — Rust serialises
 * `ResetComponent` snake_case, so these literals are the IPC contract
 * (`src-tauri/src/reset.rs` pins the same shape from the Rust side).
 */
export type ResetComponentName =
  | "share_stop"
  | "database"
  | "photos"
  | "backups"
  | "logs"
  | "keyring_key";

/**
 * Per-component reset statuses. `already_absent` counts as success for
 * `complete`; `not_attempted` only ever follows an aborting failure (share
 * stop or database) and blocks `complete` like `failed` does.
 */
export type ResetComponentStatus =
  | "removed"
  | "already_absent"
  | "failed"
  | "not_attempted";

/** One row of the factory-reset report, rendered verbatim by the UI. */
export interface ResetComponentOutcome {
  name: ResetComponentName;
  status: ResetComponentStatus;
  /** Why it failed, or why it was skipped; null on a clean component. */
  detail: string | null;
}

/** The factory-reset outcome. */
export interface FactoryResetOutcome {
  /** True only when every component was removed or already absent. */
  complete: boolean;
  components: ResetComponentOutcome[];
}

/**
 * Run the factory-reset engine.
 *
 * Removes every piece of PurpleMemo-owned local state — the LAN share and its
 * consent token, the database and its WAL/SHM siblings, the photo tree, the
 * safety-copy tree, the three logs, and the credential-store key LAST — and
 * reports each component individually. The engine is not the policy: the UI
 * must gate it behind the permanent-destruction acknowledgement and must only
 * restart into first run when `complete` is true (then `appRestart()`).
 *
 * A blocked reset is safe to re-run; every DB command fails closed with a
 * "database is closed — restart the app" error once the connection has been
 * taken.
 */
export function factoryReset(): Promise<FactoryResetOutcome> {
  return invoke("factory_reset");
}

/**
 * Restart the app into the existing first-run boot path. Call this
 * ONLY after `factoryReset()` reports `complete` — a restart on a blocked
 * reset would boot into the still-present database while its state is half
 * removed.
 */
export function appRestart(): Promise<void> {
  return invoke("app_restart");
}
