import type { BatchStatement, DataDriver, Row } from "../data/driver.ts";
import { addDays, todayLocal } from "./dates.ts";
import {
  canonicalPair,
  LINK_ENTITY_TABLES,
  LINKABLE_TYPES,
} from "./entityLinks.ts";
import { createKeyedMutex } from "./mutex.ts";
import type { LinkRow, PhotoRefRow } from "./types.ts";

export const TRASH_RETENTION_DAYS = 30;
export const TRASH_MAX_ITEMS = 1_000;
export const TRASH_SNAPSHOT_VERSION = 1;

export type TrashEntityType =
  | "note"
  | "task"
  | "contact"
  | "memory"
  | "journal_entry";

export interface TrashItemRow {
  id: number;
  entity_type: TrashEntityType;
  entity_id: number;
  snapshot: string;
  deleted_at: string;
  created_at: string;
}

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
      const [other] = await driver.query<{ id: number }>(
        `SELECT id FROM ${otherTable} WHERE id = ?`,
        [otherId],
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
        const duplicate = otherSnapshot.links.some(
          (candidate) =>
            candidate.type_a === normalizedLink.type_a &&
            candidate.id_a === normalizedLink.id_a &&
            candidate.type_b === normalizedLink.type_b &&
            candidate.id_b === normalizedLink.id_b,
        );
        if (!duplicate) {
          statements.push({
            sql: "UPDATE trash_items SET snapshot = ? WHERE id = ?",
            params: [
              JSON.stringify({
                ...otherSnapshot,
                links: [...otherSnapshot.links, normalizedLink],
              }),
              otherTrash.id,
            ],
          });
        }
        continue;
      }
      throw new Error(
        "A related item is neither live nor in Trash, so this item cannot be restored safely.",
      );
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
    const snapshot = asSnapshot(item.snapshot);
    await removeTrashRows(
      [item],
      snapshot.photoRefs.map((ref) => ref.photo_id),
    );
  }

  async function removeTrashRows(
    items: TrashItemRow[],
    photoIds: number[],
  ): Promise<void> {
    const uniquePhotoIds = [...new Set(photoIds)];
    const trashIds = items.map((item) => item.id);
    const remainingItems = await driver.query<TrashItemRow>(
      `SELECT * FROM trash_items WHERE id NOT IN (${trashIds.map(() => "?").join(", ")})`,
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
    const photos = uniquePhotoIds.length
      ? await driver.query<{ id: number; rel_path: string }>(
          `SELECT id, rel_path FROM photos WHERE id IN (${uniquePhotoIds.map(() => "?").join(", ")})`,
          uniquePhotoIds,
        )
      : [];
    const statements: BatchStatement[] = [
      ...snapshotUpdates,
      ...items.map((item) => ({
        sql: "DELETE FROM trash_items WHERE id = ?",
        params: [item.id],
      })),
    ];
    if (uniquePhotoIds.length) {
      statements.push({
        sql: `DELETE FROM photos WHERE id IN (${uniquePhotoIds.map(() => "?").join(", ")}) AND NOT EXISTS (SELECT 1 FROM photo_refs WHERE photo_refs.photo_id = photos.id) AND NOT EXISTS (SELECT 1 FROM trash_items, json_each(trash_items.snapshot, '$.photoRefs') AS ref WHERE trash_items.id NOT IN (${trashIds.map(() => "?").join(", ")}) AND json_extract(ref.value, '$.photo_id') = photos.id)`,
        params: [...uniquePhotoIds, ...trashIds],
      });
    }
    if (statements.length) await driver.batch(statements);

    for (const photo of photos) {
      const [stillStored] = await driver.query<{ id: number }>(
        "SELECT id FROM photos WHERE id = ?",
        [photo.id],
      );
      if (!stillStored) await driver.deletePhoto(photo.rel_path);
    }
  }

  async function purgeUnlocked(today = todayLocal()): Promise<number> {
    const all = await driver.query<TrashItemRow>(
      "SELECT * FROM trash_items ORDER BY deleted_at DESC, id DESC",
    );
    const cutoff = addDays(today, -TRASH_RETENTION_DAYS);
    const expired = all.filter((item) => item.deleted_at <= cutoff);
    const overflow =
      all.slice(0, TRASH_MAX_ITEMS).length < all.length
        ? all.slice(TRASH_MAX_ITEMS)
        : [];
    const removed = new Map<number, TrashItemRow>();
    for (const item of [...expired, ...overflow]) removed.set(item.id, item);
    const items = [...removed.values()];
    if (!items.length) return 0;
    validateTrashPayload(items);
    const photoIds = items.flatMap((item) =>
      asSnapshot(item.snapshot).photoRefs.map((ref) => ref.photo_id),
    );
    await removeTrashRows(items, photoIds);
    return items.length;
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
