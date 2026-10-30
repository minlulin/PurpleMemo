// A recording in-memory driver for unit tests. It never touches
// Tauri or SQL — it records every call and returns canned responses, so
// repository tests can assert the exact SQL/params a feature generates.
//
// It also mirrors the Rust backend's refusal behaviour (J4, audit batch 9):
// the import exclusion window (`lifecycle.rs`), one-shot share consent and
// snapshot validation (`share.rs`), the manual-transaction flag
// (`commands.rs`), and content-addressed photo paths (`photos.rs`, D1-1).
// A caller that works against this mock works against those refusals —
// the mock is where they are unit-testable at all.

import { createHash } from "node:crypto";
import type {
  BatchStatement,
  DataDriver,
  ExecuteOutcome,
  Queryable,
  ShareInfo,
} from "./driver.ts";

/** `lifecycle.rs` IMPORT_BLOCKED — refused for anyone but the lease-holder. */
const IMPORT_BLOCKED =
  "an import is replacing this app's data — this write was refused; try again when it finishes";

/** `lifecycle.rs` `end_import` — a lease the window does not hold cannot close it. */
const NO_IMPORT_WINDOW = "no import window is open for that lease";

/** `share.rs` NO_CONSENT. */
const NO_CONSENT =
  "sharing must be confirmed first: call share_arm, then share_start with the token it returns";

/** `share.rs` MAX_SNAPSHOT_BYTES — the ceiling `parse_snapshot` enforces. */
const MAX_SNAPSHOT_BYTES = 512 * 1024;

export interface RecordedCall {
  method: keyof DataDriver;
  args: unknown[];
}

export interface MockScript {
  /** Returned by `query` when set (consumed in FIFO order). */
  results?: Queryable[][];
  /** Returned by `execute` when set. */
  outcome?: ExecuteOutcome;
  /**
   * Thrown by the next call that reads it — `query`, `execute`, and the file
   * writers (`saveDbKeyFile`, `saveBackupFile`, `saveExportFile`,
   * `safetyBackupCopy`) — when set; consumed once. A string is thrown as an
   * `Error` with that message, mirroring Tauri commands that reject with
   * plain strings.
   */
  error?: Error | string;
  /**
   * Thrown by the next `batch` when set — consumed once. A string is thrown
   * as an `Error` with that message.
   */
  batchError?: Error | string;
}

/**
 * `photos.rs` `thumb_rel_path`: the thumbnail of a stored photo is the
 * sibling `<hash>.thumb.jpg` — always JPEG (P3-16), never the source's
 * extension. The source is validated first (`validate_rel_path`), which is
 * what keeps the derived name out of reach of the frontend: a `.thumb.jpg`
 * path is not a valid SOURCE path, so a caller cannot address a thumbnail
 * directly. Malformed sources are refused, exactly like Rust.
 */
export function thumbPath(relPath: string): string {
  validateRelPath(relPath);
  const slash = relPath.lastIndexOf("/");
  const dir = relPath.slice(0, slash + 1);
  const file = relPath.slice(slash + 1);
  const dot = file.indexOf(".");
  return `${dir}${file.slice(0, dot)}.thumb.jpg`;
}

/** `photos.rs` `validate_rel_path`: strict grammar, the traversal defense. */
function validateRelPath(relPath: string): void {
  const invalid = () =>
    new Error(`invalid photo path ${JSON.stringify(relPath)}`);
  if (!relPath.startsWith("photos/")) throw invalid();
  const segments = relPath.slice("photos/".length).split("/");
  if (segments.length !== 3) throw invalid();
  const [year, month, file] = segments;
  if (year === undefined || month === undefined || file === undefined)
    throw invalid();
  if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month)) throw invalid();
  const monthNumber = Number(month);
  if (monthNumber < 1 || monthNumber > 12) throw invalid();
  const dot = file.indexOf(".");
  if (dot <= 0) throw invalid();
  const hash = file.slice(0, dot);
  const ext = file.slice(dot + 1);
  if (hash.length !== 64 || !/^[0-9a-fA-F]+$/.test(hash)) throw invalid();
  if (ext.length < 1 || ext.length > 8 || !/^[A-Za-z0-9]+$/.test(ext))
    throw invalid();
}

/**
 * `share.rs` `parse_snapshot`: the envelope a snapshot must have before it
 * is exposed on the LAN. Returns the `generatedAt` stamp a publish records.
 */
function parseSnapshot(json: string): { generatedAt: string } {
  if (json.length > MAX_SNAPSHOT_BYTES) {
    throw new Error(
      `snapshot is larger than the ${MAX_SNAPSHOT_BYTES} byte limit`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(
      `snapshot is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("snapshot must be a JSON object");
  }
  const object = parsed as Record<string, unknown>;
  if (typeof object.version !== "number" || !Number.isInteger(object.version)) {
    throw new Error("snapshot is missing its numeric version");
  }
  if (object.version !== 1) {
    throw new Error("unsupported encrypted snapshot version");
  }
  if (typeof object.generatedAt !== "string") {
    throw new Error("snapshot is missing its generatedAt string");
  }
  for (const field of ["nonce", "ciphertext"]) {
    const value = object[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`encrypted snapshot is missing ${field}`);
    }
  }
  return { generatedAt: object.generatedAt };
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
  // Share state for tests: off until start is called, exactly like Rust
  let share: ShareInfo = {
    running: false,
    url: null,
    key: null,
    port: null,
    publishedAt: null,
    note: null,
  };

  const record = (method: keyof DataDriver, args: unknown[]) => {
    calls.push({ method, args });
  };

  /**
   * Recorded args, with the lease appended only when the caller sent one —
   * tests that deep-equal a two-element arg array keep meaning what they say.
   */
  const leaseArgs = (args: unknown[], lease: number | undefined): unknown[] =>
    lease === undefined ? args : [...args, lease];

  /** Consume the one-shot scripted query/execute error (a string becomes an Error). */
  const takeError = (): Error | undefined => {
    const e = script.error;
    if (e === undefined) return undefined;
    script.error = undefined;
    return typeof e === "string" ? new Error(e) : e;
  };

  /** Consume the one-shot scripted batch error (a string becomes an Error). */
  const takeBatchError = (): Error | undefined => {
    const e = script.batchError;
    if (e === undefined) return undefined;
    script.batchError = undefined;
    return typeof e === "string" ? new Error(e) : e;
  };

  // -- Import exclusion window (E5 / lifecycle.rs) --------------------------
  // 0 = closed. `safetyBackupCopy` opens it (that is when Rust calls
  // `begin_import`), `beginImportLease` attaches to or opens the same
  // window, `endImportLease` closes it with the exact lease. While open,
  // every writer is refused unless it carries the window's lease.
  let importLease = 0;
  let lastLease = 0;

  const admit = (lease: number | undefined): void => {
    if (importLease !== 0 && lease !== importLease) {
      throw new Error(IMPORT_BLOCKED);
    }
  };

  // -- Manual transaction flag (commands.rs txn_open) -----------------------
  let txnOpen = false;

  // -- One-shot share consent (share.rs take_consent) ----------------------
  // Armed stores the token; EVERY start attempt burns it — matched or not,
  // so probing for a valid token costs an arming per guess instead of
  // yielding an oracle. An ordinary stop leaves an armed token alive; a
  // lock's stop revokes it (D2a).
  let armedToken: string | null = null;
  // Distinct per arming, so a test can tell a fresh consent from a spent one.
  let armCounter = 0;

  // -- Thumbnails keyed by SOURCE path (J4) --------------------------------
  // Per-key, so one photo's delete cannot clear another photo's thumbnail.
  const thumbs = new Map<string, Uint8Array>();

  const nextRowid = () => ++lastRowid;

  const mock: MockDriver = {
    calls,
    async query<T extends Queryable>(
      sql: string,
      params?: unknown[],
    ): Promise<T[]> {
      record("query", [sql, params]);
      const error = takeError();
      if (error) throw error;
      if (script.results && script.results.length > 0) {
        return script.results.shift() as T[];
      }
      return [];
    },
    async execute(
      sql: string,
      params?: unknown[],
      lease?: number,
    ): Promise<ExecuteOutcome> {
      record("execute", leaseArgs([sql, params], lease));
      admit(lease);
      const error = takeError();
      if (error) throw error;
      if (script.outcome) {
        const outcome = script.outcome;
        script.outcome = undefined;
        lastRowid = Math.max(lastRowid, outcome.lastInsertRowid);
        return outcome;
      }
      return { rowsAffected: 1, lastInsertRowid: nextRowid() };
    },
    async batch(statements: BatchStatement[], lease?: number): Promise<void> {
      record("batch", leaseArgs([statements], lease));
      admit(lease);
      // `db_batch` refuses over an open manual transaction: the flag is the
      // only thing keeping a half-committed `commit`/`rollback` pair from
      // interleaving with the batch's own transaction.
      if (txnOpen) {
        throw new Error(
          "db_batch is not allowed while a manual transaction is open",
        );
      }
      const error = takeBatchError();
      if (error) throw error;
    },
    async begin(): Promise<void> {
      record("begin", []);
      if (txnOpen) throw new Error("a transaction is already open");
      txnOpen = true;
    },
    async commit(): Promise<void> {
      record("commit", []);
      if (!txnOpen) throw new Error("no open transaction to commit");
      txnOpen = false;
    },
    async rollback(): Promise<void> {
      record("rollback", []);
      if (!txnOpen) throw new Error("no open transaction to roll back");
      txnOpen = false;
    },
    async resetTxn(): Promise<void> {
      record("resetTxn", []);
      // Break-glass and idempotent (`db_reset_txn`): clearing a flag that is
      // already clear is the same no-op in Rust.
      txnOpen = false;
    },
    async savePhoto(
      bytes: Uint8Array,
      ext: string,
      lease?: number,
    ): Promise<string> {
      record("savePhoto", leaseArgs([bytes, ext], lease));
      admit(lease);
      // `photos.rs` `save_photo`: lowercase, validate, then content-address —
      // the same bytes always land at the same path, which is what lets an
      // import dedupe and what makes a mock path mean something in a test.
      const lowered = ext.toLowerCase();
      if (
        lowered.length < 1 ||
        lowered.length > 8 ||
        !/^[a-z0-9]+$/.test(lowered)
      ) {
        throw new Error(
          `invalid photo extension ${JSON.stringify(lowered)}: 1-8 lowercase letters/digits expected`,
        );
      }
      const hash = createHash("sha256").update(bytes).digest("hex");
      return `photos/2026/10/${hash}.${lowered}`;
    },
    async readPhoto(relPath: string): Promise<Uint8Array> {
      record("readPhoto", [relPath]);
      return Uint8Array.from([1, 2, 3]);
    },
    async readPhotoThumb(sourceRelPath: string): Promise<Uint8Array> {
      record("readPhotoThumb", [sourceRelPath]);
      thumbPath(sourceRelPath);
      // Same contract as Rust: no stored thumbnail is an error the caller
      // answers by generating one.
      const bytes = thumbs.get(sourceRelPath);
      if (!bytes) throw new Error(`no thumbnail for ${sourceRelPath}`);
      return bytes;
    },
    async savePhotoThumb(
      sourceRelPath: string,
      bytes: Uint8Array,
      lease?: number,
    ): Promise<string> {
      record("savePhotoThumb", leaseArgs([sourceRelPath, bytes], lease));
      admit(lease);
      const path = thumbPath(sourceRelPath);
      thumbs.set(sourceRelPath, bytes);
      return path;
    },
    async deletePhoto(relPath: string, lease?: number): Promise<void> {
      record("deletePhoto", leaseArgs([relPath], lease));
      admit(lease);
      // Only THIS photo's thumbnail goes: the delete of one file must not
      // clear the cache of its siblings.
      thumbs.delete(relPath);
    },
    async saveDbKeyFile(path: string): Promise<void> {
      record("saveDbKeyFile", [path]);
      const error = takeError();
      if (error) throw error;
    },
    async saveBackupFile(path: string, bytes: Uint8Array): Promise<void> {
      record("saveBackupFile", [path, bytes]);
      const error = takeError();
      if (error) throw error;
    },
    async saveExportFile(path: string, bytes: Uint8Array): Promise<void> {
      record("saveExportFile", [path, bytes]);
      const error = takeError();
      if (error) throw error;
    },
    async safetyBackupCopy(label: string): Promise<string> {
      record("safetyBackupCopy", [label]);
      const error = takeError();
      if (error) throw error;
      // Rust `backup_safety_copy` calls `begin_import`: the exclusion window
      // opens HERE, at the snapshot boundary — before any replacement write.
      lastLease += 1;
      importLease = lastLease;
      return `/app-data/backups/pre-import-${label}`;
    },
    async beginImportLease(): Promise<number> {
      record("beginImportLease", []);
      // Attach to the window the safety copy opened, or open one: the two
      // calls must be the SAME window, not two.
      if (importLease === 0) {
        lastLease += 1;
        importLease = lastLease;
      }
      return importLease;
    },
    async endImportLease(lease: number): Promise<void> {
      record("endImportLease", [lease]);
      // A late or foreign release can never open the door for someone else's
      // write (`lifecycle.rs` `end_import`).
      if (importLease !== lease) throw new Error(NO_IMPORT_WINDOW);
      importLease = 0;
    },
    async shareStart(consentToken: string): Promise<ShareInfo> {
      record("shareStart", [consentToken]);
      // Mirrors Rust `take_consent`: the armed token is burned on EVERY
      // attempt, matched or not, and a start without a matching fresh token
      // binds nothing.
      const armed = armedToken;
      armedToken = null;
      if (armed === null || armed !== consentToken) throw new Error(NO_CONSENT);
      share = {
        running: true,
        url: `http://192.168.1.5:8765/#key=${"ab".repeat(32)}`,
        key: "ab".repeat(32),
        port: 8765,
        publishedAt: share.publishedAt,
        note: null,
      };
      return { ...share };
    },
    async shareArm(): Promise<string> {
      record("shareArm", []);
      armCounter += 1;
      armedToken = `consent-${armCounter}`;
      return armedToken;
    },
    async shareStop(forLock?: boolean): Promise<ShareInfo> {
      // Recorded as the flag the caller actually meant, so a test can tell a
      // lock's stop from an ordinary one without knowing about `undefined`.
      record("shareStop", [forLock === true]);
      // `stop_for_lock` (D2a) revokes the armed token; an ordinary stop
      // retires the listener and leaves consent alone.
      if (forLock === true) armedToken = null;
      share = {
        running: false,
        url: null,
        key: null,
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
      // Validated even when not running (`share.rs` `publish`): a malformed
      // envelope is a refusal, not the off-sharing no-op.
      const snapshot = parseSnapshot(snapshotJson);
      if (!share.running) {
        // Stopped: nothing is stored and nothing is stamped.
        return {
          running: false,
          url: null,
          key: null,
          port: null,
          publishedAt: null,
          note: null,
        };
      }
      share = { ...share, publishedAt: snapshot.generatedAt };
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
