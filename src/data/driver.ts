// The single Tauri data driver (§4): every feature library talks to this
// driver, and the driver is the only place that calls Tauri IPC. The UI never
// touches the DB directly. `db_batch` is the multi-statement write path
// (committed as one transaction inside Rust); `begin`/`commit`/`rollback`
// exist only for short critical sections and are never held across UI awaits.

import { invoke } from "@tauri-apps/api/core";

/**
 * Request-header names shared with `src-tauri/src/commands.rs`. The Rust side
 * reads them through `tauri::ipc::Request::headers`; `ipc.test.ts` pins the two
 * copies together, because nothing else can: a typo here would only surface as
 * a "missing header" error on a user's machine.
 */
export const PHOTO_EXT_HEADER = "x-photo-ext";
export const PHOTO_SOURCE_HEADER = "x-photo-source";

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
 * State of the read-only LAN share (§8, P5). `url` is the full link the
 * phone opens — it carries the pairing code, and is null whenever sharing
 * is off. `publishedAt` is the `generatedAt` of the last published snapshot.
 */
export interface ShareInfo {
  running: boolean;
  url: string | null;
  code: string | null;
  /** Bound TCP port (shown so the user can allow it through a firewall). */
  port: number | null;
  publishedAt: string | null;
  /** Set only when sharing stopped on its own, e.g. repeated wrong codes. */
  note: string | null;
}

/** The full driver surface — implemented by Tauri IPC and by test mocks. */
export interface DataDriver {
  query<T extends Queryable>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<ExecuteOutcome>;
  batch(statements: BatchStatement[]): Promise<void>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /**
   * Clear the manual-transaction flag without touching the DB — break-glass
   * for when `commit` AND `rollback` both failed (e.g., the connection died)
   * and the stuck flag would block every future `batch` (FIX-10). The
   * uncommitted rows are lost; the caller re-reads and reconciles state.
   */
  resetTxn(): Promise<void>;
  /**
   * Photo bytes cross the IPC boundary as RAW payloads (review M-02): the
   * request body IS the bytes, so the metadata the Rust side needs travels in
   * request headers, and a read resolves to an `ArrayBuffer` — never a JSON
   * array of byte numbers. Headers must be ASCII, which photo paths are
   * (strict `photos/<yyyy>/<mm>/<sha256>.<ext>` grammar).
   */
  savePhoto(bytes: Uint8Array, ext: string): Promise<string>;
  readPhoto(relPath: string): Promise<Uint8Array>;
  /**
   * The thumbnail of a photo, addressed by the SOURCE photo's path — the
   * thumbnail path itself is derived in Rust and never built here. Rejects
   * when no thumbnail is stored yet, which the caller treats as "generate
   * one and `savePhotoThumb` it".
   */
  readPhotoThumb(sourceRelPath: string): Promise<Uint8Array>;
  savePhotoThumb(sourceRelPath: string, bytes: Uint8Array): Promise<string>;
  deletePhoto(relPath: string): Promise<void>;
  /**
   * Write the DB encryption key to a file the user chose (§5.4).
   *
   * Deliberately takes a path and returns nothing: Rust reads the key from the
   * credential store, writes it, and drops it, so the plaintext master key
   * never crosses into the webview. The driver used to have an `exportDbKey`
   * that returned it, where it lived in React state and could be pushed onto
   * the system clipboard — which outlives the app and is readable by every
   * other program on the machine (review H-7).
   */
  saveDbKeyFile(path: string): Promise<void>;
  /** Start the LAN snapshot server (§8). Idempotent while running. */
  shareStart(consentToken: string): Promise<ShareInfo>;
  shareStop(): Promise<ShareInfo>;
  shareStatus(): Promise<ShareInfo>;
  /** Publish a freshly built snapshot payload for the LAN server to serve. */
  sharePublish(snapshotJson: string): Promise<ShareInfo>;
  /**
   * Record that the user confirmed the LAN-share prompt and return a one-shot
   * token for `shareStart` (§8). Issuing is not consent — only starting the
   * listener consumes the token, and only once (review H-8).
   */
  shareArm(): Promise<string>;
}

/** The one production driver: Tauri IPC commands (§4, §8). */
export function createTauriDriver(): DataDriver {
  return {
    query: (sql, params) => invoke("db_query", { sql, params }),
    execute: (sql, params) => invoke("db_execute", { sql, params }),
    batch: (statements) => invoke("db_batch", { statements }),
    begin: () => invoke("db_begin"),
    commit: () => invoke("db_commit"),
    rollback: () => invoke("db_rollback"),
    resetTxn: () => invoke("db_reset_txn"),
    savePhoto: (bytes, ext) =>
      invoke("photo_save", bytes, { headers: { [PHOTO_EXT_HEADER]: ext } }),
    readPhoto: async (relPath) =>
      new Uint8Array(await invoke<ArrayBuffer>("photo_read", { relPath })),
    readPhotoThumb: async (sourceRelPath) =>
      new Uint8Array(
        await invoke<ArrayBuffer>("photo_read_thumb", { sourceRelPath }),
      ),
    savePhotoThumb: (sourceRelPath, bytes) =>
      invoke("photo_save_thumb", bytes, {
        headers: { [PHOTO_SOURCE_HEADER]: sourceRelPath },
      }),
    deletePhoto: (relPath) => invoke("photo_delete", { relPath }),
    saveDbKeyFile: (path) => invoke("db_key_save", { path }),
    // P5 share controls (§8) — 18 commands total now, still one driver.
    shareStart: (consentToken) => invoke("share_start", { consentToken }),
    shareArm: () => invoke("share_arm"),
    shareStop: () => invoke("share_stop"),
    shareStatus: () => invoke("share_status"),
    sharePublish: (snapshotJson) => invoke("share_publish", { snapshotJson }),
  };
}
