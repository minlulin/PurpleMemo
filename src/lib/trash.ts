import type { BatchStatement, DataDriver, Row } from "../data/driver.ts";
import { addDays, todayLocal } from "./dates.ts";
import {
  canonicalPair,
  LINK_ENTITY_TABLES,
  LINKABLE_TYPES,
} from "./entityLinks.ts";
import { createKeyedMutex } from "./mutex.ts";
import { isSyncTable, type SyncTable } from "./sync/protocol.ts";
import { LOCAL_FOREIGN_KEYS, outboxStatements } from "./sync/store.ts";
import type {
  LinkRow,
  PhotoRefRow,
  TrashEntityType,
  TrashItemRow,
} from "./types.ts";
import { newUid } from "./uid.ts";

// The row types live in types.ts with every other table's (docs/AUDIT.md
// SCHEMA-02); these re-exports keep the call sites that already import them
// from here working.
export type { TrashEntityType, TrashItemRow };

export const TRASH_RETENTION_DAYS = 30;
export const TRASH_MAX_ITEMS = 1_000;
export const TRASH_SNAPSHOT_VERSION = 1;

/**
 * §13.2's conflict marker: the `snapshot.conflict.kind` a conflict copy carries
 * and an ordinary Trash item does not.
 *
 * It is what the restore path branches on. An ordinary Trash item comes back as
 * the same record under the same uid; a conflict copy comes back as a NEW
 * record under a NEW uid, because the losing value never resurrects the uid the
 * winner now owns.
 */
export const TRASH_CONFLICT_KIND = "conflict_loser";

/** Every type the `trash_items.entity_type` CHECK names (schema v10). */
const TRASH_ENTITY_TYPES: readonly TrashEntityType[] = [
  "note",
  "task",
  "contact",
  "memory",
  "journal_entry",
  "shopping_list",
  "shopping_item",
];

interface InboxReference {
  id: number;
  converted_type: string;
  converted_id: number;
}

/**
 * The §13.2 marker a conflict copy carries inside its snapshot.
 *
 * `won` is the winning record's field values, stored so the Trash page can show
 * the copy beside what actually won — the user's decision to keep the copy is
 * informed, not blind. Nothing here is a live link: the copy is device-local
 * and never syncs (§2.2, §13.2).
 */
export interface TrashConflictCopy {
  kind: "conflict_loser";
  /** §13.2's sentence, shown verbatim beside the copy. */
  label: string;
  /** The sync table the losing value came from. */
  table: string;
  /** The uid the loser held. A restore never reuses it. */
  uid: string;
  /** The winning record's field values. */
  won: Row;
}

interface TrashSnapshot {
  version: 1;
  snapshotId: string;
  entity: Row;
  channels: Row[];
  tags: Row[];
  photoRefs: PhotoRefRow[];
  links: LinkRow[];
  inboxRefs: InboxReference[];
  /** Set only on a conflict copy; absent on every ordinary Trash item. */
  conflict?: TrashConflictCopy;
}

export interface TrashListItem extends TrashItemRow {
  title: string;
  /**
   * §13.2: for a conflict copy, its label and the winning value's title; null
   * for an ordinary Trash item.
   */
  conflict: { label: string; won: string } | null;
}

const TABLES: Record<TrashEntityType, string> = {
  note: "notes",
  task: "tasks",
  contact: "contacts",
  memory: "memories",
  journal_entry: "journal_entries",
  shopping_list: "shopping_lists",
  shopping_item: "shopping_items",
};

const COLUMNS: Record<TrashEntityType, string[]> = {
  note: [
    "id",
    // Identity travels with the snapshot, so a restore brings the record back
    // as the same record instead of a copy (UID contract). Snapshots written
    // before schema v7 have no `uid`; restore mints one for those instead of
    // rejecting a Trash item the user can see on screen.
    "uid",
    "title",
    "content",
    "tags",
    "collection_id",
    "pinned",
    "archived",
    "created_at",
    "updated_at",
  ],
  task: [
    "id",
    "uid",
    "title",
    "due_date",
    "done",
    "repeat",
    "note",
    "created_at",
  ],
  contact: ["id", "name", "address", "birthday", "notes", "created_at"],
  memory: ["id", "title", "memory_date", "note", "created_at"],
  journal_entry: ["id", "entry_date", "content", "created_at", "updated_at"],
  // §13.2's two: a conflict copy stores the row whole, uid included, so the
  // ordinary restore path could rebuild it — the copy's own restore mints a
  // new uid on purpose (see `restoreUnlocked`).
  shopping_list: ["id", "uid", "name", "created_at"],
  shopping_item: ["id", "uid", "list_id", "text", "done", "sort_order"],
};

const CONTACT_CHANNEL_COLUMNS = [
  "id",
  "contact_id",
  "kind",
  "value",
  "is_primary",
  "sort_order",
];
const CONTACT_TAG_COLUMNS = ["id", "contact_id", "tag"];
const PHOTO_REF_COLUMNS = ["id", "photo_id", "entity_type", "entity_id"];
const LINK_COLUMNS = [
  "id",
  "kind",
  "type_a",
  "id_a",
  "type_b",
  "id_b",
  "created_at",
];
const INBOX_REF_COLUMNS = ["id", "converted_type", "converted_id"];

/**
 * The snapshot column lists, exported so a test can compare them to the DDL
 * in `schema.rs` (docs/AUDIT.md SCHEMA-01).
 *
 * They are hand-maintained on purpose — a snapshot is a historical record and
 * an explicit list keeps its shape readable — but "hand-maintained" is exactly
 * why a migration that adds a column would silently drop it on the next
 * restore. The test is the thing that keeps them honest.
 */
export const TRASH_SNAPSHOT_COLUMNS: Record<TrashEntityType, string[]> =
  COLUMNS;

/** Child-table projections a snapshot stores, for the same test. */
export const TRASH_CHILD_COLUMNS = {
  contact_channels: CONTACT_CHANNEL_COLUMNS,
  contact_tags: CONTACT_TAG_COLUMNS,
  photo_refs: PHOTO_REF_COLUMNS,
  links: LINK_COLUMNS,
} as const;

/**
 * A Trash row that is not a §13.2 conflict copy — the only kind that owns an
 * entity id in the ordinary sense.
 *
 * A conflict copy is stamped with the id of the row it lost to, and that row is
 * still live. Every query that asks "is this id claimed by Trash?" has to skip
 * those copies, or a live row would read as trashed.
 */
const NOT_A_CONFLICT_COPY = "json_extract(snapshot, '$.conflict') IS NULL";

function jsonObjectSql(alias: string, columns: string[]): string {
  return `json_object(${columns.map((column) => `'${column}', ${alias}.${column}`).join(", ")})`;
}

function jsonArraySql(
  table: string,
  alias: string,
  columns: string[],
  predicate: string,
): string {
  return `json(COALESCE((SELECT json_group_array(${jsonObjectSql(alias, columns)}) FROM ${table} ${alias} WHERE ${predicate}), '[]'))`;
}

function snapshotJsonSql(
  type: TrashEntityType,
  snapshotId: string,
): { sql: string; params: unknown[] } {
  const entity = jsonObjectSql("source", COLUMNS[type]);
  const channels =
    type === "contact"
      ? jsonArraySql(
          "contact_channels",
          "child",
          CONTACT_CHANNEL_COLUMNS,
          "child.contact_id = source.id",
        )
      : "json('[]')";
  const tags =
    type === "contact"
      ? jsonArraySql(
          "contact_tags",
          "child",
          CONTACT_TAG_COLUMNS,
          "child.contact_id = source.id",
        )
      : "json('[]')";
  const photoRefs =
    type === "note" || type === "memory"
      ? jsonArraySql(
          "photo_refs",
          "child",
          PHOTO_REF_COLUMNS,
          "child.entity_type = ? AND child.entity_id = source.id",
        )
      : "json('[]')";
  const links = linkType(type)
    ? jsonArraySql(
        "links",
        "child",
        LINK_COLUMNS,
        "(child.type_a = ? AND child.id_a = source.id) OR (child.type_b = ? AND child.id_b = source.id)",
      )
    : "json('[]')";
  const inboxRefs = jsonArraySql(
    "inbox_items",
    "child",
    INBOX_REF_COLUMNS,
    "child.converted_id = source.id AND child.converted_type = ?",
  );
  const params: unknown[] = [snapshotId];
  if (type === "note" || type === "memory") params.push(type);
  if (linkType(type)) params.push(type, type);
  params.push(type === "journal_entry" ? "journal" : type);
  return {
    sql: `json_object(
    'version', ${TRASH_SNAPSHOT_VERSION},
    'snapshotId', ?,
    'entity', ${entity},
    'channels', ${channels},
    'tags', ${tags},
    'photoRefs', ${photoRefs},
    'links', ${links},
    'inboxRefs', ${inboxRefs}
  )`,
    params,
  };
}

function asSnapshot(raw: string): TrashSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(
      "This Trash item has a corrupt snapshot and cannot be restored.",
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Record<string, unknown>).version !== TRASH_SNAPSHOT_VERSION ||
    typeof (value as Record<string, unknown>).snapshotId !== "string" ||
    typeof (value as Record<string, unknown>).entity !== "object" ||
    (value as Record<string, unknown>).entity === null
  ) {
    throw new Error("This Trash item uses an unsupported snapshot format.");
  }
  const snapshot = value as TrashSnapshot;
  for (const key of [
    "channels",
    "tags",
    "photoRefs",
    "links",
    "inboxRefs",
  ] as const) {
    if (!Array.isArray(snapshot[key])) {
      throw new Error("This Trash item is incomplete and cannot be restored.");
    }
  }
  const conflict = (value as { conflict?: unknown }).conflict;
  if (conflict !== undefined && !isConflictCopy(conflict)) {
    throw new Error(
      "This Trash item has a corrupt conflict marker and cannot be restored.",
    );
  }
  return snapshot;
}

/** The §13.2 marker's shape, checked once so both read paths agree. */
function isConflictCopy(value: unknown): value is TrashConflictCopy {
  if (typeof value !== "object" || value === null) return false;
  const copy = value as Record<string, unknown>;
  return (
    copy.kind === TRASH_CONFLICT_KIND &&
    typeof copy.label === "string" &&
    typeof copy.table === "string" &&
    typeof copy.uid === "string" &&
    typeof copy.won === "object" &&
    copy.won !== null &&
    !Array.isArray(copy.won)
  );
}

/**
 * The one text a row shows for an entity of this type: a title, a contact's or
 * list's name, an item's text, or a journal entry's date.
 */
function entityLabel(type: TrashEntityType, entity: Row): string {
  if (type === "journal_entry") {
    return `Journal entry · ${String(entity.entry_date ?? "unknown date")}`;
  }
  const name =
    type === "contact" || type === "shopping_list"
      ? entity.name
      : type === "shopping_item"
        ? entity.text
        : entity.title;
  return typeof name === "string" && name.trim() ? name : `Untitled ${type}`;
}

function snapshotTitle(type: TrashEntityType, snapshot: TrashSnapshot): string {
  return entityLabel(type, snapshot.entity);
}

function linkType(type: TrashEntityType): type is "note" | "task" | "contact" {
  return (LINKABLE_TYPES as string[]).includes(type);
}

export interface TrashPayloadContext {
  photoIds?: Set<number>;
  liveEntities?: Map<string, Set<number>>;
  inboxRows?: Row[];
}

export function validateTrashPayload(
  rows: unknown[],
  context: TrashPayloadContext = {},
): void {
  const allowed = new Set<TrashEntityType>(TRASH_ENTITY_TYPES);
  const trashEntities = new Set<string>();
  for (const candidate of rows) {
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      !Array.isArray(candidate)
    ) {
      const row = candidate as Row;
      if (
        typeof row.entity_type === "string" &&
        Number.isSafeInteger(row.entity_id)
      ) {
        trashEntities.add(`${row.entity_type}:${row.entity_id}`);
      }
    }
  }
  for (const candidate of rows) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      throw new Error("Backup contains an invalid Trash row.");
    }
    const row = candidate as Row;
    if (
      typeof row.entity_type !== "string" ||
      !allowed.has(row.entity_type as TrashEntityType) ||
      !Number.isSafeInteger(row.entity_id) ||
      Number(row.entity_id) <= 0 ||
      typeof row.snapshot !== "string" ||
      typeof row.deleted_at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.deleted_at)
    ) {
      throw new Error("Backup contains an invalid Trash row.");
    }
    const type = row.entity_type as TrashEntityType;
    const entityId = Number(row.entity_id);
    const snapshot = asSnapshot(row.snapshot);
    if (
      Number(snapshot.entity.id) !== entityId ||
      COLUMNS[type].some(
        (column) => column !== "uid" && !(column in snapshot.entity),
      )
    ) {
      throw new Error("Backup contains an incomplete Trash snapshot.");
    }
    if (
      type !== "contact" &&
      (snapshot.channels.length || snapshot.tags.length)
    ) {
      throw new Error(
        "Backup contains contact data on a non-contact Trash item.",
      );
    }
    if (type !== "note" && type !== "memory" && snapshot.photoRefs.length) {
      throw new Error(
        "Backup contains photo references on an unsupported Trash item.",
      );
    }
    for (const ref of snapshot.photoRefs) {
      if (
        !Number.isSafeInteger(ref.photo_id) ||
        ref.photo_id <= 0 ||
        ref.entity_type !== type ||
        ref.entity_id !== entityId
      ) {
        throw new Error("Backup contains an invalid Trash photo reference.");
      }
      if (context.photoIds && !context.photoIds.has(ref.photo_id)) {
        throw new Error(
          "Backup contains a Trash reference to a missing photo.",
        );
      }
    }
    if (!linkType(type) && snapshot.links.length) {
      throw new Error(
        "Backup contains relationships on a non-linkable Trash item.",
      );
    }
    for (const link of snapshot.links) {
      const ownsA = link.type_a === type && link.id_a === entityId;
      const ownsB = link.type_b === type && link.id_b === entityId;
      const canonical =
        link.type_a < link.type_b ||
        (link.type_a === link.type_b && link.id_a < link.id_b);
      if (
        (!ownsA && !ownsB) ||
        !canonical ||
        (link.type_a === link.type_b && link.id_a === link.id_b) ||
        !LINKABLE_TYPES.includes(link.type_a) ||
        !LINKABLE_TYPES.includes(link.type_b)
      ) {
        throw new Error("Backup contains an invalid Trash relationship.");
      }
      const otherType = ownsA ? link.type_b : link.type_a;
      const otherId = ownsA ? link.id_b : link.id_a;
      const otherIsLive =
        context.liveEntities?.get(otherType)?.has(otherId) ?? false;
      if (
        context.liveEntities &&
        !otherIsLive &&
        !trashEntities.has(`${otherType}:${otherId}`)
      ) {
        throw new Error(
          "Backup contains a Trash relationship to an entity that is neither live nor trashed.",
        );
      }
    }
    for (const ref of snapshot.inboxRefs) {
      const expectedType = type === "journal_entry" ? "journal" : type;
      if (
        !Number.isSafeInteger(ref.id) ||
        ref.id <= 0 ||
        ref.converted_type !== expectedType ||
        ref.converted_id !== entityId
      ) {
        throw new Error("Backup contains an invalid Inbox reference in Trash.");
      }
      if (
        context.inboxRows &&
        !context.inboxRows.some(
          (inbox) =>
            inbox.id === ref.id &&
            inbox.converted_type === ref.converted_type &&
            inbox.converted_id === ref.converted_id,
        )
      ) {
        throw new Error(
          "Backup contains a Trash reference to a missing Inbox item.",
        );
      }
    }
    if (type === "contact") {
      for (const child of [...snapshot.channels, ...snapshot.tags]) {
        if (child.contact_id !== entityId || !Number.isSafeInteger(child.id)) {
          throw new Error("Backup contains an invalid contact child in Trash.");
        }
      }
    }
  }
}

function insertStatement(
  table: string,
  columns: string[],
  row: Row,
): BatchStatement {
  return {
    sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    params: columns.map((column) => row[column] ?? null),
  };
}

export function createTrashRepo(driver: DataDriver) {
  // One repository-level mutex for the whole trash lifecycle (J3). Every
  // multi-await mutation shares the key "trash" because they share
  // invariants, not rows: `App.tsx` fires a detached `purge()` the moment
  // the user unlocks while `TrashPage` can be mid-`restore`, and
  // `restore`/`removePermanently` read `trash_items` (and photo files)
  // across many awaits before writing — interleave them and `allocateIds`
  // can hand out colliding IDs, sibling `trash_items.snapshot` link arrays
  // can be overwritten, or a purge can delete rows a restore already
  // validated. The internals below stay callable from inside the lock
  // (`trashEntity` and `restore` both finish with a maintenance purge) —
  // `mutex.ts` forbids nesting the same key, so they are the `*Unlocked`
  // variants and only the exported wrappers take the lock.
  const mutex = createKeyedMutex();

  async function allocateIds(
    table: string,
    requested: number[],
  ): Promise<number[]> {
    const distinct = [...new Set(requested)];
    const occupiedRows = distinct.length
      ? await driver.query<{ id: number }>(
          `SELECT id FROM ${table} WHERE id IN (${distinct.map(() => "?").join(", ")})`,
          distinct,
        )
      : [];
    const occupied = new Set(occupiedRows.map((row) => row.id));
    const [maximum] = await driver.query<{ id: number }>(
      `SELECT COALESCE(MAX(id), 0) AS id FROM ${table}`,
    );
    let next = (maximum?.id ?? 0) + 1;
    const reserved = new Set<number>();
    return requested.map((id) => {
      if (
        Number.isSafeInteger(id) &&
        id > 0 &&
        !occupied.has(id) &&
        !reserved.has(id)
      ) {
        reserved.add(id);
        return id;
      }
      while (occupied.has(next) || reserved.has(next)) next += 1;
      if (!Number.isSafeInteger(next) || next <= 0) {
        throw new Error(`Could not allocate a restore ID for ${table}.`);
      }
      reserved.add(next);
      return next++;
    });
  }

  /**
   * Move a row into Trash.
   *
   * `extraStatements` are appended to the SAME batch, last: sync's delete op
   * and its tombstone (§5.1) have to commit with the row's removal (§6.1), and
   * a caller that wrote them in a second transaction would break that promise
   * the moment a batch failed in between. The caller reads the uid first; the
   * trash statements here address the row by its local id, as ever.
   */
  async function trashEntityUnlocked(
    type: TrashEntityType,
    id: number,
    extraStatements: readonly BatchStatement[] = [],
  ): Promise<void> {
    const table = TABLES[type];
    const snapshotId = crypto.randomUUID();
    const today = todayLocal();
    const snapshotGuard =
      "EXISTS (SELECT 1 FROM trash_items WHERE json_extract(snapshot, '$.snapshotId') = ?)";
    const snapshot = snapshotJsonSql(type, snapshotId);
    const statements: BatchStatement[] = [
      {
        sql: `INSERT INTO trash_items (entity_type, entity_id, snapshot, deleted_at, created_at) SELECT ?, source.id, ${snapshot.sql}, ?, ? FROM ${table} source WHERE source.id = ?`,
        params: [type, ...snapshot.params, today, today, id],
      },
    ];
    if (linkType(type)) {
      statements.push({
        sql: `DELETE FROM links WHERE ((type_a = ? AND id_a = ?) OR (type_b = ? AND id_b = ?)) AND ${snapshotGuard}`,
        params: [type, id, type, id, snapshotId],
      });
    }
    if (type === "note" || type === "memory") {
      statements.push({
        sql: `DELETE FROM photo_refs WHERE entity_type = ? AND entity_id = ? AND ${snapshotGuard}`,
        params: [type, id, snapshotId],
      });
    }
    statements.push({
      sql: `DELETE FROM ${table} WHERE id = ? AND ${snapshotGuard}`,
      params: [id, snapshotId],
    });
    statements.push(...extraStatements);
    await driver.batch(statements);
    try {
      await purgeUnlocked();
    } catch {
      // The user deletion is already committed; maintenance must not mask it.
    }
  }

  async function list(): Promise<TrashListItem[]> {
    const rows = await driver.query<TrashItemRow>(
      "SELECT * FROM trash_items ORDER BY deleted_at DESC, id DESC",
    );
    validateTrashPayload(rows);
    return rows.map((row) => {
      const snapshot = asSnapshot(row.snapshot);
      return {
        ...row,
        title: snapshotTitle(row.entity_type, snapshot),
        // §13.2: the copy is shown with its label and the value that won, so
        // the user compares them instead of guessing which one is live.
        conflict: snapshot.conflict
          ? {
              label: snapshot.conflict.label,
              won: entityLabel(row.entity_type, snapshot.conflict.won),
            }
          : null,
      };
    });
  }

  /**
   * §6.2's payload for a restored row: its columns, with every foreign key
   * named by uid instead of by this device's row number (§3.4, §8.4).
   *
   * A Trash type that is not a sync table (a contact, a memory, a journal
   * entry) produces nothing: those tables never leave this device (§2.2).
   */
  async function restoreOpStatements(
    type: TrashEntityType,
    restored: Row,
  ): Promise<BatchStatement[]> {
    const table = TABLES[type];
    if (!isSyncTable(table)) return [];
    const uid = restored.uid;
    if (typeof uid !== "string" || uid.length === 0) return [];
    const foreignKeys = LOCAL_FOREIGN_KEYS[table as SyncTable] ?? {};
    const fields: Record<string, unknown> = {};
    for (const column of COLUMNS[type]) {
      if (column === "id" || column === "uid") continue;
      const parent = foreignKeys[column];
      const value = restored[column];
      if (parent !== undefined) {
        fields[`${column.slice(0, -"_id".length)}_uid`] =
          value === null || value === undefined
            ? null
            : ((
                await driver.query<{ uid: string | null }>(
                  `SELECT uid FROM "${parent}" WHERE id = ?`,
                  [value],
                )
              )[0]?.uid ?? null);
        continue;
      }
      fields[column] = value ?? null;
    }
    return outboxStatements([
      { table: table as SyncTable, uid, kind: "create", fields },
    ]);
  }

  async function restoreUnlocked(trashId: number): Promise<void> {
    const [item] = await driver.query<TrashItemRow>(
      "SELECT * FROM trash_items WHERE id = ?",
      [trashId],
    );
    if (!item) throw new Error("That Trash item no longer exists.");
    validateTrashPayload([item]);
    const snapshot = asSnapshot(item.snapshot);
    // §13.2: a conflict copy is restored differently from an ordinary Trash
    // item, and the marker is the only thing that says which one this is.
    const conflict = snapshot.conflict !== undefined;
    const type = item.entity_type;
    const columns = COLUMNS[type];
    const sourceId = item.entity_id;
    if (Number(snapshot.entity.id) !== sourceId) {
      throw new Error("This Trash item does not match its saved snapshot.");
    }

    const [rootId] = await allocateIds(TABLES[type], [sourceId]);
    if (rootId === undefined)
      throw new Error("Could not allocate a restore ID.");
    const restored: Row = { ...snapshot.entity, id: rootId };
    if (conflict) {
      // §13.2: restoring a conflict copy creates a NEW record with a NEW uid.
      // The loser's snapshot still names the uid the winner now owns, so
      // reusing it would collide with the winner and resurrect a value the
      // merge already decided against. From here on it is an ordinary record
      // that syncs as new.
      restored.uid = newUid();
    } else if (columns.includes("uid") && restored.uid === undefined) {
      restored.uid = newUid();
    }
    if (type === "note" && restored.collection_id !== null) {
      const collections = await driver.query<{ id: number }>(
        "SELECT id FROM collections WHERE id = ?",
        [restored.collection_id],
      );
      if (!collections.length) {
        throw new Error(
          "The note's collection no longer exists, so this item cannot be restored safely.",
        );
      }
    }
    if (type === "journal_entry") {
      const dateRows = await driver.query<{ id: number }>(
        "SELECT id FROM journal_entries WHERE entry_date = ?",
        [restored.entry_date],
      );
      if (dateRows.length) {
        throw new Error(
          "A journal entry already exists for that date. Remove or move it before restoring this item.",
        );
      }
    }

    const statements: BatchStatement[] = [
      insertStatement(TABLES[type], columns, restored),
    ];

    if (type === "contact") {
      const channelIds = await allocateIds(
        "contact_channels",
        snapshot.channels.map((channel) => Number(channel.id)),
      );
      for (const [index, channel] of snapshot.channels.entries()) {
        const channelId = channelIds[index];
        if (channelId === undefined)
          throw new Error("A contact channel could not be mapped.");
        statements.push(
          insertStatement(
            "contact_channels",
            ["id", "contact_id", "kind", "value", "is_primary", "sort_order"],
            {
              ...channel,
              id: channelId,
              contact_id: rootId,
            },
          ),
        );
      }
      const tagIds = await allocateIds(
        "contact_tags",
        snapshot.tags.map((tag) => Number(tag.id)),
      );
      for (const [index, tag] of snapshot.tags.entries()) {
        const tagId = tagIds[index];
        if (tagId === undefined)
          throw new Error("A contact tag could not be mapped.");
        statements.push(
          insertStatement("contact_tags", ["id", "contact_id", "tag"], {
            ...tag,
            id: tagId,
            contact_id: rootId,
          }),
        );
      }
    }

    if (type === "note" || type === "memory") {
      for (const ref of snapshot.photoRefs) {
        const photos = await driver.query<{ id: number; rel_path: string }>(
          "SELECT id, rel_path FROM photos WHERE id = ?",
          [ref.photo_id],
        );
        const photo = photos[0];
        if (!photo) {
          throw new Error(
            "A photo used by this item no longer exists, so it cannot be restored safely.",
          );
        }
        try {
          await driver.readPhoto(photo.rel_path);
        } catch {
          throw new Error(
            "A photo file used by this item is missing, so it cannot be restored safely.",
          );
        }
        statements.push({
          sql: "INSERT INTO photo_refs (photo_id, entity_type, entity_id) VALUES (?, ?, ?)",
          params: [ref.photo_id, type, rootId],
        });
      }
    }

    // A conflict copy carries no Inbox references (its snapshot is built with
    // empty child arrays), and nothing it holds may be re-pointed.
    if (!conflict && sourceId !== rootId) {
      for (const ref of snapshot.inboxRefs) {
        statements.push({
          sql: "UPDATE inbox_items SET converted_id = ? WHERE id = ? AND converted_type = ? AND converted_id = ?",
          params: [rootId, ref.id, ref.converted_type, sourceId],
        });
      }
    }

    for (const link of snapshot.links) {
      const endpointA =
        link.type_a === type && link.id_a === sourceId ? rootId : link.id_a;
      const endpointB =
        link.type_b === type && link.id_b === sourceId ? rootId : link.id_b;
      const [first, second] = canonicalPair(
        { type: link.type_a, id: endpointA },
        { type: link.type_b, id: endpointB },
      );
      const normalizedLink = {
        ...link,
        type_a: first.type,
        id_a: first.id,
        type_b: second.type,
        id_b: second.id,
      };
      // Determine the other endpoint by identity (not type alone): for a
      // same-type link, `type_a === type` can be true for BOTH endpoints, so
      // type-only matching would select the trashed entity itself when it is
      // endpoint B. Mirror validateTrashPayload's ownsA/ownsB check.
      const ownsA = link.type_a === type && link.id_a === sourceId;
      const otherType = ownsA ? link.type_b : link.type_a;
      const otherId = ownsA ? link.id_b : link.id_a;
      const otherTable = LINK_ENTITY_TABLES[otherType];
      // M1: notes and tasks use INTEGER PRIMARY KEY without AUTOINCREMENT, so
      // SQLite recycles a freed number. A live row carrying the other
      // endpoint's old number therefore only proves the endpoint is back
      // while no Trash snapshot still claims that number — a claim means the
      // id was reused and the live row is an unrelated item that must not
      // receive this relationship.
      const [other] = await driver.query<{ id: number }>(
        `SELECT id FROM ${otherTable} WHERE id = ? AND NOT EXISTS (SELECT 1 FROM trash_items WHERE entity_type = ? AND entity_id = ? AND ${NOT_A_CONFLICT_COPY})`,
        [otherId, otherType, otherId],
      );
      if (other) {
        statements.push({
          sql: `INSERT OR IGNORE INTO links (kind, type_a, id_a, type_b, id_b, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM ${LINK_ENTITY_TABLES[link.type_a]} WHERE id = ?) AND EXISTS (SELECT 1 FROM ${LINK_ENTITY_TABLES[link.type_b]} WHERE id = ?)`,
          params: [
            normalizedLink.kind,
            normalizedLink.type_a,
            normalizedLink.id_a,
            normalizedLink.type_b,
            normalizedLink.id_b,
            link.created_at,
            endpointA,
            endpointB,
          ],
        });
        continue;
      }

      const [otherTrash] = await driver.query<TrashItemRow>(
        `SELECT * FROM trash_items WHERE entity_type = ? AND entity_id = ? AND id <> ? AND ${NOT_A_CONFLICT_COPY} ORDER BY id DESC LIMIT 1`,
        [otherType, otherId, trashId],
      );
      if (otherTrash) {
        const otherSnapshot = asSnapshot(otherTrash.snapshot);
        // M1: the endpoint still in Trash holds this relationship snapshotted
        // under OUR old number. Remap it to the restored id, replacing the
        // stale entry: when this endpoint is restored later it would otherwise
        // rebuild the link against whatever reused that number — or fail, if
        // the number now belongs to no row at all.
        const theirs = `${otherType}:${otherId}`;
        const ours = new Set([`${type}:${sourceId}`, `${type}:${rootId}`]);
        const stalePair = (candidate: LinkRow) => {
          if (candidate.kind !== normalizedLink.kind) return false;
          const a = `${candidate.type_a}:${candidate.id_a}`;
          const b = `${candidate.type_b}:${candidate.id_b}`;
          return (ours.has(a) && b === theirs) || (ours.has(b) && a === theirs);
        };
        const links = otherSnapshot.links.filter(
          (candidate) => !stalePair(candidate),
        );
        const recorded = links.some(
          (candidate) =>
            candidate.kind === normalizedLink.kind &&
            candidate.type_a === normalizedLink.type_a &&
            candidate.id_a === normalizedLink.id_a &&
            candidate.type_b === normalizedLink.type_b &&
            candidate.id_b === normalizedLink.id_b,
        );
        if (!recorded) links.push(normalizedLink);
        const snapshot = JSON.stringify({ ...otherSnapshot, links });
        if (snapshot !== otherTrash.snapshot) {
          statements.push({
            sql: "UPDATE trash_items SET snapshot = ? WHERE id = ?",
            params: [snapshot, otherTrash.id],
          });
        }
        continue;
      }
      throw new Error(
        "A related item is neither live nor in Trash, so this item cannot be restored safely.",
      );
    }

    // M1: this item came back under a NEW number, and snapshots taken BEFORE
    // it was trashed still pair it with the old one. A trash row is only
    // created while its entity is live, so `id < trashId` snapshots could only
    // have captured that number while it belonged to THIS row — the newer
    // snapshots (higher trash id) describe whatever reused the number and are
    // left alone. Rewrite the old pairings to the restored id, or the later
    // restore of that endpoint would attach the relationship to the reuse.
    // M1's remapping is about the entity that MOVED: it rewrites older
    // snapshots that still pair the old id with the restored one. A conflict
    // copy never moved — `sourceId` still belongs to the winner, which was not
    // restored — so rewriting those pairings would point them at a new record
    // the relationship never described.
    if (!conflict && rootId !== sourceId) {
      const otherClaims = await driver.query<{ id: number }>(
        `SELECT id FROM trash_items WHERE entity_type = ? AND entity_id = ? AND id <> ? AND ${NOT_A_CONFLICT_COPY}`,
        [type, sourceId, trashId],
      );
      if (!otherClaims.length) {
        const referencing = await driver.query<TrashItemRow>(
          `SELECT * FROM trash_items WHERE id < ? AND EXISTS (SELECT 1 FROM json_each(trash_items.snapshot, '$.links') AS ref WHERE (json_extract(ref.value, '$.type_a') = ? AND json_extract(ref.value, '$.id_a') = ?) OR (json_extract(ref.value, '$.type_b') = ? AND json_extract(ref.value, '$.id_b') = ?))`,
          [trashId, type, sourceId, type, sourceId],
        );
        for (const row of referencing) {
          const older = asSnapshot(row.snapshot);
          let remapped = false;
          const links = older.links.map((candidate) => {
            const ownsA =
              candidate.type_a === type && candidate.id_a === sourceId;
            const ownsB =
              candidate.type_b === type && candidate.id_b === sourceId;
            if (!ownsA && !ownsB) return candidate;
            remapped = true;
            const [first, second] = canonicalPair(
              { type: candidate.type_a, id: ownsA ? rootId : candidate.id_a },
              { type: candidate.type_b, id: ownsB ? rootId : candidate.id_b },
            );
            return {
              ...candidate,
              type_a: first.type,
              id_a: first.id,
              type_b: second.type,
              id_b: second.id,
            };
          });
          if (remapped) {
            statements.push({
              sql: "UPDATE trash_items SET snapshot = ? WHERE id = ?",
              params: [JSON.stringify({ ...older, links }), row.id],
            });
          }
        }
      }
    }

    // §5.3/§6.1: a restore is a resurrection, and it records as one — a
    // create-kind op under the SAME uid whose fresh stamp outranks the
    // tombstone the delete left, so a peer that applied the delete brings the
    // record back instead of keeping it dead. A conflict copy came back under
    // a NEW uid above, so it records that new record's create (§13.2).
    // Purge records nothing: the delete was recorded when the row was trashed.
    statements.push(...(await restoreOpStatements(type, restored)));

    statements.push({
      sql: "DELETE FROM trash_items WHERE id = ?",
      params: [trashId],
    });
    await driver.batch(statements);
    try {
      await purgeUnlocked();
    } catch {
      // Restore is committed; a failed maintenance pass is retried on next load.
    }
  }

  async function removePermanentlyUnlocked(trashId: number): Promise<void> {
    const [item] = await driver.query<TrashItemRow>(
      "SELECT * FROM trash_items WHERE id = ?",
      [trashId],
    );
    if (!item) return;
    validateTrashPayload([item]);
    await removeTrashRows([item]);
  }

  /**
   * D1 (Batch 12): Gallery owns its photos. Dropping a Trash row — permanent
   * delete or retention purge — never touches photo rows or files: the photo
   * survives as "Not linked to anything yet", which the Gallery UI already
   * treats as a legitimate state. With no photo GC on this path there is no
   * check-then-unlink race against a concurrent Gallery save (M3), so this
   * deliberately does NOT coordinate a save: the GC it would coordinate no
   * longer exists. Deleting a photo remains an explicit Gallery action, and
   * gallery.ts deletePhoto keeps its guard for snapshots that still name it.
   */
  async function removeTrashRows(items: TrashItemRow[]): Promise<void> {
    const trashIds = items.map((item) => item.id);
    // Narrow projection on purpose: the link bookkeeping below needs the
    // entity key and the snapshot, and nothing else in the row.
    const remainingItems = await driver.query<{
      id: number;
      entity_type: TrashEntityType;
      entity_id: number;
      snapshot: string;
    }>(
      `SELECT id, entity_type, entity_id, snapshot FROM trash_items WHERE id NOT IN (${trashIds.map(() => "?").join(", ")})`,
      trashIds,
    );
    const remainingByEntity = new Set(
      remainingItems.map((item) => `${item.entity_type}:${item.entity_id}`),
    );
    const permanentlyRemoved = new Set(
      items
        .filter(
          (item) =>
            !remainingByEntity.has(`${item.entity_type}:${item.entity_id}`),
        )
        .map((item) => `${item.entity_type}:${item.entity_id}`),
    );
    const snapshotUpdates: BatchStatement[] = [];
    for (const item of remainingItems) {
      const snapshot = asSnapshot(item.snapshot);
      const links = snapshot.links.filter(
        (link) =>
          !permanentlyRemoved.has(`${link.type_a}:${link.id_a}`) &&
          !permanentlyRemoved.has(`${link.type_b}:${link.id_b}`),
      );
      if (links.length !== snapshot.links.length) {
        snapshotUpdates.push({
          sql: "UPDATE trash_items SET snapshot = ? WHERE id = ?",
          params: [JSON.stringify({ ...snapshot, links }), item.id],
        });
      }
    }
    const statements: BatchStatement[] = [
      ...snapshotUpdates,
      ...items.map((item) => ({
        sql: "DELETE FROM trash_items WHERE id = ?",
        params: [item.id],
      })),
    ];
    if (statements.length) await driver.batch(statements);
  }

  async function purgeUnlocked(today = todayLocal()): Promise<number> {
    // Decide the policy from the small columns only. This runs on every
    // workspace load (and after every restore), and it used to pull every
    // snapshot through IPC and JSON-parse each one just to discover that
    // nothing had expired (docs/AUDIT.md PERF-14). The usual answer is "no
    // rows to purge", which now touches no snapshot at all.
    const policy = await driver.query<{ id: number; deleted_at: string }>(
      "SELECT id, deleted_at FROM trash_items ORDER BY deleted_at DESC, id DESC",
    );
    const cutoff = addDays(today, -TRASH_RETENTION_DAYS);
    const expired = policy.filter((item) => item.deleted_at <= cutoff);
    const overflow = policy.slice(TRASH_MAX_ITEMS);
    const ids = [...new Set([...expired, ...overflow].map((item) => item.id))];
    if (!ids.length) return 0;
    const placeholders = ids.map(() => "?").join(", ");
    const rows = await driver.query<TrashItemRow>(
      `SELECT * FROM trash_items WHERE id IN (${placeholders})`,
      ids,
    );
    if (!rows.length) return 0;
    validateTrashPayload(rows);
    await removeTrashRows(rows);
    return rows.length;
  }

  async function purgeForReset(): Promise<void> {
    await driver.execute("DELETE FROM trash_items");
  }

  // The exported surface takes the lock; see the mutex's comment above.
  return {
    trashEntity: (
      type: TrashEntityType,
      id: number,
      extraStatements: readonly BatchStatement[] = [],
    ) =>
      mutex.withLock("trash", () =>
        trashEntityUnlocked(type, id, extraStatements),
      ),
    list,
    restore: (trashId: number) =>
      mutex.withLock("trash", () => restoreUnlocked(trashId)),
    removePermanently: (trashId: number) =>
      mutex.withLock("trash", () => removePermanentlyUnlocked(trashId)),
    purge: (today?: string) =>
      mutex.withLock("trash", () => purgeUnlocked(today)),
    purgeForReset,
  };
}
