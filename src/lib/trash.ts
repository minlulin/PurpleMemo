import type { BatchStatement, DataDriver, Row } from "../data/driver.ts";
import { addDays, todayLocal } from "./dates.ts";
import {
  canonicalPair,
  LINK_ENTITY_TABLES,
  LINKABLE_TYPES,
} from "./entityLinks.ts";
import { createKeyedMutex } from "./mutex.ts";
import type {
  LinkRow,
  PhotoRefRow,
  TrashEntityType,
  TrashItemRow,
} from "./types.ts";

// The row types live in types.ts with every other table's (docs/AUDIT.md
// SCHEMA-02); these re-exports keep the call sites that already import them
// from here working.
export type { TrashEntityType, TrashItemRow };

export const TRASH_RETENTION_DAYS = 30;
export const TRASH_MAX_ITEMS = 1_000;
export const TRASH_SNAPSHOT_VERSION = 1;

interface InboxReference {
  id: number;
  converted_type: string;
  converted_id: number;
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
}

export interface TrashListItem extends TrashItemRow {
  title: string;
}

const TABLES: Record<TrashEntityType, string> = {
  note: "notes",
  task: "tasks",
  contact: "contacts",
  memory: "memories",
  journal_entry: "journal_entries",
};

const COLUMNS: Record<TrashEntityType, string[]> = {
  note: [
    "id",
    "title",
    "content",
    "tags",
    "collection_id",
    "pinned",
    "archived",
    "created_at",
    "updated_at",
  ],
  task: ["id", "title", "due_date", "done", "repeat", "note", "created_at"],
  contact: ["id", "name", "address", "birthday", "notes", "created_at"],
  memory: ["id", "title", "memory_date", "note", "created_at"],
  journal_entry: ["id", "entry_date", "content", "created_at", "updated_at"],
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
  return snapshot;
}

function snapshotTitle(type: TrashEntityType, snapshot: TrashSnapshot): string {
  const entity = snapshot.entity;
  if (type === "journal_entry")
    return `Journal entry · ${String(entity.entry_date ?? "unknown date")}`;
  const name = type === "contact" ? entity.name : entity.title;
  return typeof name === "string" && name.trim() ? name : `Untitled ${type}`;
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
  const allowed = new Set<TrashEntityType>([
    "note",
    "task",
    "contact",
    "memory",
    "journal_entry",
  ]);
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
      COLUMNS[type].some((column) => !(column in snapshot.entity))
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

  async function trashEntityUnlocked(
    type: TrashEntityType,
    id: number,
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
    return rows.map((row) => ({
      ...row,
      title: snapshotTitle(row.entity_type, asSnapshot(row.snapshot)),
    }));
  }

  async function restoreUnlocked(trashId: number): Promise<void> {
    const [item] = await driver.query<TrashItemRow>(
      "SELECT * FROM trash_items WHERE id = ?",
      [trashId],
    );
    if (!item) throw new Error("That Trash item no longer exists.");
    validateTrashPayload([item]);
    const snapshot = asSnapshot(item.snapshot);
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

    if (sourceId !== rootId) {
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
        `SELECT id FROM ${otherTable} WHERE id = ? AND NOT EXISTS (SELECT 1 FROM trash_items WHERE entity_type = ? AND entity_id = ?)`,
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
        "SELECT * FROM trash_items WHERE entity_type = ? AND entity_id = ? AND id <> ? ORDER BY id DESC LIMIT 1",
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
    if (rootId !== sourceId) {
      const otherClaims = await driver.query<{ id: number }>(
        "SELECT id FROM trash_items WHERE entity_type = ? AND entity_id = ? AND id <> ?",
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
    trashEntity: (type: TrashEntityType, id: number) =>
      mutex.withLock("trash", () => trashEntityUnlocked(type, id)),
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
