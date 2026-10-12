// The single Tauri data driver (§4): every feature library talks to this
// driver, and the driver is the only place that calls Tauri IPC. The UI never
// touches the DB directly. `db_batch` is the multi-statement write path
// (committed as one transaction inside Rust); `begin`/`commit`/`rollback`
// exist only for short critical sections and are never held across UI awaits.

import { invoke } from "@tauri-apps/api/core";

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
  savePhoto(bytes: number[], ext: string): Promise<string>;
  readPhoto(relPath: string): Promise<number[]>;
  deletePhoto(relPath: string): Promise<void>;
  /** Read-only keyring read for the Settings key-export step (§5.4). */
  exportDbKey(): Promise<string>;
  /** Start the LAN snapshot server (§8). Idempotent while running. */
  shareStart(): Promise<ShareInfo>;
  shareStop(): Promise<ShareInfo>;
  shareStatus(): Promise<ShareInfo>;
  /** Publish a freshly built snapshot payload for the LAN server to serve. */
  sharePublish(snapshotJson: string): Promise<ShareInfo>;
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
    savePhoto: (bytes, ext) => invoke("photo_save", { bytes, ext }),
    readPhoto: (relPath) => invoke("photo_read", { relPath }),
    deletePhoto: (relPath) => invoke("photo_delete", { relPath }),
    exportDbKey: () => invoke("db_key_export"),
    // P5 share controls (§8) — 14 commands total now, still one driver.
    shareStart: () => invoke("share_start"),
    shareStop: () => invoke("share_stop"),
    shareStatus: () => invoke("share_status"),
    sharePublish: (snapshotJson) => invoke("share_publish", { snapshotJson }),
  };
}
