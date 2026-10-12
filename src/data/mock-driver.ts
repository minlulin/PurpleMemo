// A recording in-memory driver for unit tests (plan §7). It never touches
// Tauri or SQL — it records every call and returns canned responses, so
// repository tests can assert the exact SQL/params a feature generates.

import type {
  BatchStatement,
  DataDriver,
  ExecuteOutcome,
  Queryable,
  ShareInfo,
} from "./driver.ts";

export interface RecordedCall {
  method: keyof DataDriver;
  args: unknown[];
}

export interface MockScript {
  /** Returned by `query` when set (consumed in FIFO order). */
  results?: Queryable[][];
  /** Returned by `execute` when set. */
  outcome?: ExecuteOutcome;
  /** Thrown by the next `query`/`execute` when set — consumed once. */
  error?: Error;
  /** Thrown by the next `batch` when set — consumed once. */
  batchError?: Error;
}

export interface MockDriver extends DataDriver {
  calls: RecordedCall[];
  callsTo(method: keyof DataDriver): RecordedCall[];
  lastCall(): RecordedCall | undefined;
  /** Append canned `query` results (for rows only known after earlier calls). */
  pushResults(rows: Queryable[][]): void;
}

export function createMockDriver(script: MockScript = {}): MockDriver {
  const calls: RecordedCall[] = [];
  let lastRowid = 0;
  // Share state for tests: off until start is called, exactly like Rust (§8).
  let share: ShareInfo = {
    running: false,
    url: null,
    code: null,
    port: null,
    publishedAt: null,
    note: null,
  };

  const record = (method: keyof DataDriver, args: unknown[]) => {
    calls.push({ method, args });
  };

  const nextRowid = () => ++lastRowid;

  const mock: MockDriver = {
    calls,
    async query<T extends Queryable>(
      sql: string,
      params?: unknown[],
    ): Promise<T[]> {
      record("query", [sql, params]);
      if (script.error) {
        const e = script.error;
        script.error = undefined;
        throw e;
      }
      if (script.results && script.results.length > 0) {
        return script.results.shift() as T[];
      }
      return [];
    },
    async execute(sql: string, params?: unknown[]): Promise<ExecuteOutcome> {
      record("execute", [sql, params]);
      if (script.error) {
        const e = script.error;
        script.error = undefined;
        throw e;
      }
      if (script.outcome) {
        const outcome = script.outcome;
        script.outcome = undefined;
        lastRowid = Math.max(lastRowid, outcome.lastInsertRowid);
        return outcome;
      }
      return { rowsAffected: 1, lastInsertRowid: nextRowid() };
    },
    async batch(statements: BatchStatement[]): Promise<void> {
      record("batch", [statements]);
      if (script.batchError) {
        const e = script.batchError;
        script.batchError = undefined;
        throw e;
      }
    },
    async begin(): Promise<void> {
      record("begin", []);
    },
    async commit(): Promise<void> {
      record("commit", []);
    },
    async rollback(): Promise<void> {
      record("rollback", []);
    },
    async savePhoto(bytes: number[], ext: string): Promise<string> {
      record("savePhoto", [bytes, ext]);
      return `photos/2026/10/${ext}.${bytes.length}`;
    },
    async readPhoto(relPath: string): Promise<number[]> {
      record("readPhoto", [relPath]);
      return [1, 2, 3];
    },
    async deletePhoto(relPath: string): Promise<void> {
      record("deletePhoto", [relPath]);
    },
    async exportDbKey(): Promise<string> {
      record("exportDbKey", []);
      return "00".repeat(32);
    },
    async shareStart(): Promise<ShareInfo> {
      record("shareStart", []);
      share = {
        running: true,
        url: "http://192.168.1.5:8765/?k=TESTCODE",
        code: "TESTCODE",
        port: 8765,
        publishedAt: share.publishedAt,
        note: null,
      };
      return { ...share };
    },
    async shareStop(): Promise<ShareInfo> {
      record("shareStop", []);
      share = {
        running: false,
        url: null,
        code: null,
        port: null,
        publishedAt: null,
        note: null,
      };
      return { ...share };
    },
    async shareStatus(): Promise<ShareInfo> {
      record("shareStatus", []);
      return { ...share };
    },
    async sharePublish(snapshotJson: string): Promise<ShareInfo> {
      record("sharePublish", [snapshotJson]);
      const parsed = JSON.parse(snapshotJson) as { generatedAt?: string };
      share = { ...share, publishedAt: parsed.generatedAt ?? null };
      return { ...share };
    },
    callsTo(method: keyof DataDriver): RecordedCall[] {
      return calls.filter((c) => c.method === method);
    },
    lastCall(): RecordedCall | undefined {
      return calls[calls.length - 1];
    },
    pushResults(rows: Queryable[][]): void {
      script.results = [...(script.results ?? []), ...rows];
    },
  };
  return mock;
}
