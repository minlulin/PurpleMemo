// Sync protocol v1 — docs/ANDROID_SYNC_PROTOCOL.md (Phase C Session 1).
//
// The protocol's *pure* rules: the 17-table allowlist and the write authority
// each table grants, the clock-free version order that decides conflicts, the
// handshake, tombstone collection and the first-pair adoption plan.
//
// Nothing here reads a database, opens a socket or holds state. This module is
// what the failure-injection harness (./harness.ts) checks the spec against,
// and what Stage 1's engine must agree with — if the engine answers
// differently, the engine is wrong or the spec changed, and a spec change is a
// version bump (§14.6), not a quiet code choice.
//
// Clause numbers in comments point at the spec's headings. A test in
// ./harness.test.ts fails when a cited clause stops existing, so this file
// cannot drift away from the document it implements.

/** The only protocol version this build speaks (§8.2). */
export const PROTOCOL_VERSION = 1;

/**
 * Bounds for a single batch (§8.3). Small enough that an interrupted batch is
 * cheap to redo and a phone on a bad network can make progress, large enough
 * that a first-pair snapshot is not thousands of round trips.
 */
export const MAX_BATCH_OPS = 200;
export const MAX_BATCH_BYTES = 256 * 1024;

/**
 * What a table lets the *phone* write (§2.3). "desktop-owned" and
 * "desktop-to-mobile" mean the phone reads but never writes; the desktop's own
 * writes are always allowed.
 */
export type SyncAuthority =
  | "two-way"
  | "append-only"
  | "create-only"
  | "desktop-owned"
  | "desktop-to-mobile";

/** The narrow 17-table core (docs/ANDROID_DESIGN.md decision 1), §2.1.
 *
 * F-3 (2026-11-16, owner's call): `shops` is create-only, not desktop-owned.
 * A new shop walking in is exactly the quick-capture case — the phone could
 * add a job but had no shop to attach it to, so the job could not be
 * recorded at all. Creation opens to the phone; edits and deletes stay on
 * the desktop, like jobs and loans. */
export const SYNC_TABLES = {
  collections: "two-way",
  notes: "two-way",
  tasks: "two-way",
  reminders: "two-way",
  wallets: "desktop-owned",
  income_categories: "desktop-owned",
  expense_categories: "desktop-owned",
  income_entries: "append-only",
  expense_entries: "append-only",
  shops: "create-only",
  jobs: "create-only",
  loans: "create-only",
  habits: "desktop-owned",
  habit_logs: "two-way",
  shopping_lists: "two-way",
  shopping_items: "two-way",
  vault_items: "desktop-to-mobile",
} as const satisfies Record<string, SyncAuthority>;

export type SyncTable = keyof typeof SYNC_TABLES;

/**
 * Tables that exist in the shared schema and must never reach a peer, §2.2.
 *
 * `trash_items` is on this list for two reasons: it can hold snapshots of
 * excluded modules, and a conflict loser is device-local by decision (§13.2).
 */
export const DESKTOP_ONLY_TABLES = [
  "expense_limits",
  "recurring_payments",
  "payables",
  "settings",
  "links",
  "trash_items",
  "photos",
  "photo_refs",
  "notes_fts",
] as const;

/**
 * Excluded modules (§2.2). They are in the database, so a leak is always one
 * careless loop away; the leak test injects one on purpose and expects the
 * harness to see it.
 */
export const EXCLUDED_MODULE_TABLES = [
  "contacts",
  "contact_channels",
  "contact_tags",
  "journal_entries",
  "memories",
] as const;

export function isSyncTable(table: string): table is SyncTable {
  return Object.hasOwn(SYNC_TABLES, table);
}

export type OpKind = "create" | "update" | "toggle" | "delete";
export type Origin = "desktop" | "mobile";

export interface WriteVerdict {
  allowed: boolean;
  reason: string;
}

/**
 * The fields each two-way table allows the phone to update (§2.3).
 *
 * A table absent from this map has no mobile update at all: notes are
 * create/delete, a habit check-in is a `habit_logs` row, and a shopping list is
 * created or deleted rather than renamed from the phone.
 *
 * Two entries are wider than a single toggle flag, and both are settled
 * decisions rather than defaults:
 *
 *  - `tasks` carries `due_date` beside `done` because completing a repeating
 *    task rolls it (§2.1's note): the roll is the completion, and §2.1 records
 *    completion as an action both surfaces take. No other task field opens up.
 *  - `reminders` carries `fired` and `remind_at` — a settle and a re-arm —
 *    because §13.1 makes the creating device the one that arms and settles its
 *    own reminders. The field list cannot express "its own": this matrix has
 *    no row context, so it admits the settle fields and the per-row check
 *    (`reminderUpdateOwnedBy`) runs where the row is read during apply
 *    (`composeOp`). Every other mobile reminder update is still refused here.
 */
const MOBILE_TOGGLE_FIELDS: Partial<Record<SyncTable, readonly string[]>> = {
  tasks: ["done", "due_date"],
  shopping_items: ["done"],
  reminders: ["fired", "remind_at"],
};

/**
 * §13.1's per-row half of the reminder rule: a device may settle and re-arm
 * only a reminder it created. A NULL creator never matches a mobile op — a
 * NULL-creator row is the receiving device's own legacy-local row, and only a
 * desktop-origin op may update it.
 */
export function reminderUpdateOwnedBy(
  createdBy: unknown,
  deviceId: string,
): boolean {
  return (
    typeof createdBy === "string" &&
    createdBy.length > 0 &&
    createdBy === deviceId
  );
}

/** May this device write this kind of operation to this table? (§2.3) */
export function writeAllowed(
  table: string,
  kind: OpKind,
  origin: Origin,
): WriteVerdict {
  if (!isSyncTable(table)) {
    return {
      allowed: false,
      reason: `${table} is not on the 17-table allowlist and never leaves a device (§2.1, §2.2).`,
    };
  }
  if (origin === "desktop") {
    return {
      allowed: true,
      reason: "the desktop is the authority for every synced table (§2.3).",
    };
  }

  const authority = SYNC_TABLES[table];
  switch (authority) {
    case "two-way": {
      if (kind !== "update") {
        return {
          allowed: true,
          reason: `${table} is two-way; the phone may ${kind} (§2.3).`,
        };
      }
      const fields = MOBILE_TOGGLE_FIELDS[table] ?? [];
      return fields.length > 0
        ? {
            allowed: true,
            reason: `${table} accepts a mobile update only of ${fields.join(", ")} (§2.3).`,
          }
        : {
            allowed: false,
            reason: `the phone never edits an existing ${table} row; it creates and deletes (§2.3).`,
          };
    }
    case "append-only":
      return kind === "create"
        ? {
            allowed: true,
            reason: `${table} is append-only from the phone (§2.3, §12.2).`,
          }
        : {
            allowed: false,
            reason: `the phone never edits or deletes ${table}; corrections happen on the desktop (§2.3, §12.2).`,
          };
    case "create-only":
      return kind === "create"
        ? {
            allowed: true,
            reason: `${table} is create-only from the phone (§2.3, §12.2).`,
          }
        : {
            allowed: false,
            reason: `the phone never updates or deletes ${table}; payment and repayment fields are desktop-only (§2.3, §12.2).`,
          };
    case "desktop-owned":
      return {
        allowed: false,
        reason: `${table} is desktop-owned; the phone reads it and never writes it (§2.3).`,
      };
    case "desktop-to-mobile":
      return {
        allowed: false,
        reason: `${table} is one-way desktop-to-mobile; the phone never writes it (§2.3, §12.3).`,
      };
  }
}

/** Field-level half of the same rule, for update ops (§2.3, §4.3). */
export function updateFieldsAllowed(
  table: string,
  fields: readonly string[],
  origin: Origin,
): WriteVerdict {
  if (fields.length === 0) {
    return {
      allowed: false,
      reason: "an update op must name at least one field (§3.1).",
    };
  }
  const verdict = writeAllowed(table, "update", origin);
  if (!verdict.allowed || origin === "desktop") return verdict;
  const allowed = MOBILE_TOGGLE_FIELDS[table as SyncTable] ?? [];
  const refused = fields.filter((field) => !allowed.includes(field));
  return refused.length > 0
    ? {
        allowed: false,
        reason: `the phone cannot change ${refused.join(", ")} on ${table} (§2.3).`,
      }
    : verdict;
}

/**
 * A version stamp (§4.2): a Lamport counter, the device that wrote it, and the
 * operation that carried it. There is no timestamp in it on purpose — this is
 * the value conflicts are decided by, and a wall clock is exactly what F1
 * showed cannot decide them.
 */
export interface VersionStamp {
  counter: number;
  deviceId: string;
  opId: string;
}

/**
 * Total order over stamps (§4.2, §4.5). Counter first, then device id as the
 * deterministic tie-break, then the operation id so two writes from one device
 * still order. Every device computes the same answer for the same pair, no
 * matter which of them asks and in what order the ops arrived, which is what
 * makes the merge reproducible after an interrupted apply.
 */
export function compareStamps(a: VersionStamp, b: VersionStamp): number {
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  if (a.opId !== b.opId) return a.opId < b.opId ? -1 : 1;
  return 0;
}

/** The Lamport rule: one past everything this device has seen (§4.2). */
export function nextCounter(seen: readonly number[]): number {
  return seen.reduce((max, value) => (value > max ? value : max), 0) + 1;
}

/**
 * Operation identity (§1.3): the pair a receiver dedups on. Retries re-send the
 * same pair, so "have I applied this already?" is a lookup, not a guess.
 */
export function opKey(op: { deviceId: string; seq: number }): string {
  return `${op.deviceId}#${op.seq}`;
}

export type HandshakeRefusal =
  | "same-device"
  | "protocol-unsupported"
  | "schema-mismatch"
  | "generation-mismatch";

export interface Hello {
  deviceId: string;
  protocolVersion: number;
  dataSchemaVersion: number;
  generation: number;
}

export type Handshake =
  | { ok: true; protocolVersion: number }
  | { ok: false; code: HandshakeRefusal; message: string };

/**
 * What a peer must prove before a single op crosses (§7.1, §8.2, §10.2).
 *
 * The generation check is the restore guard: an old backup restores the
 * *data*, bumps the generation, and everything the phone held about the old
 * data line — cursors, acks — becomes meaningless. Refusing is the only safe
 * answer; reconciling stale cursors is how a restored desktop decides a newer
 * mobile edit is already synced.
 */
export function handshake(local: Hello, remote: Hello): Handshake {
  if (remote.deviceId === local.deviceId) {
    return {
      ok: false,
      code: "same-device",
      message: "both endpoints claim the same device identity (§1.2).",
    };
  }
  if (
    remote.protocolVersion < PROTOCOL_VERSION ||
    remote.protocolVersion > PROTOCOL_VERSION
  ) {
    return {
      ok: false,
      code: "protocol-unsupported",
      message: `this build speaks sync protocol v${PROTOCOL_VERSION}; the peer speaks v${remote.protocolVersion} — update both to the same version (§8.2).`,
    };
  }
  if (remote.dataSchemaVersion !== local.dataSchemaVersion) {
    return {
      ok: false,
      code: "schema-mismatch",
      message: `the peers hold schema v${local.dataSchemaVersion} and v${remote.dataSchemaVersion} — sync only between identical builds (§8.2).`,
    };
  }
  if (remote.generation !== local.generation) {
    return {
      ok: false,
      code: "generation-mismatch",
      message:
        "the desktop's data line changed (a restore or a reset, not a re-pair); re-pair this phone before syncing (§10.2, §10.5).",
    };
  }
  return { ok: true, protocolVersion: PROTOCOL_VERSION };
}

/**
 * May a tombstone be collected? Only when every peer we know about has
 * acknowledged it (§5.4). A peer that has never synced is not in `peers`, and
 * an empty list therefore never collects — an abandoned pairing would
 * otherwise delete the only proof the record ever existed.
 */
export function tombstoneGcEligible(
  ackedBy: readonly string[],
  peers: readonly string[],
): boolean {
  return peers.length > 0 && peers.every((peer) => ackedBy.includes(peer));
}

export interface AdoptionPlan {
  /** Phone records the desktop has never seen: uploaded as new records. */
  upload: readonly string[];
  /** Shared UIDs: same record on both sides, merged by §4, not duplicated. */
  alreadyKnown: readonly string[];
  /** Always empty — first pairing never wipes (§9.1). */
  deletions: readonly string[];
}

/**
 * First pairing between two populated devices (§9.1, §9.4).
 *
 * The phone keeps everything it created offline and offers it as new records;
 * the desktop takes each one whose UID it does not already hold. `deletions` is
 * part of the shape, not an omission: it is the field a "bootstrap by wiping
 * the phone" implementation would fill in, and every test asserts it stays
 * empty.
 */
export function planAdoption(
  desktopUids: readonly string[],
  mobileUids: readonly string[],
): AdoptionPlan {
  const known = new Set(desktopUids);
  return {
    upload: mobileUids.filter((uid) => !known.has(uid)),
    alreadyKnown: mobileUids.filter((uid) => known.has(uid)),
    deletions: [],
  };
}

/** A decision the spec records instead of making (§13). */
export interface OpenDecision {
  id: string;
  clause: string;
  question: string;
  options: readonly string[];
  recommendation: string;
}

/**
 * A decision the spec HAS made, and where the ruling lives.
 *
 * These stay in code beside the open list for the same reason: a settled ruling
 * that falls out of the documents every later session reads is how it gets
 * re-opened by accident.
 */
export interface SettledDecision {
  id: string;
  clause: string;
  /** What was decided, in one line. */
  ruling: string;
  /** Where the built form is, so the ruling is not just prose. */
  built: string;
}

/**
 * Open decisions carried into MinLulin's review of the spec (§13.1).
 *
 * They live in code so a test can prove they are still recorded in both the
 * spec and the todo — an open question that quietly disappears from the
 * documents every later session reads is how it gets decided by accident.
 * Empty is a state worth asserting: a decision that has been made belongs in
 * `SETTLED_DECISIONS` instead, not left here to look pending.
 */
export const OPEN_DECISIONS: readonly OpenDecision[] = [];

/**
 * Decisions that are closed, with the clause that closed them.
 *
 * §13.1's `reminder-definition-owner` was Option A, and Option A is what the
 * code does: `created_by_device_id` travels, the engine refuses a mobile
 * reminder update on a row another device created (`reminderUpdateOwnedBy`),
 * and each device notifies only for its own reminders. Keeping it "open" in
 * this list made every later session re-read a question that had an answer.
 */
export const SETTLED_DECISIONS: readonly SettledDecision[] = [
  {
    id: "reminder-definition-owner",
    clause: "§13.1",
    ruling:
      "Option A: reminder definitions are two-way, and each device arms and settles only the reminders it created.",
    built:
      "schema v8's created_by_device_id column, engine.ts's reminderUpdateOwnedBy guard, and the snapshot/upload border stamp in store.ts.",
  },
];
