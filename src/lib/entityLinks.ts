// Relationships between notes, tasks and contacts.
//
// Two properties do all the work here:
//
// 1. **A relationship is stored once, canonically ordered.** Related links are
//    conceptually mutual, so "A relates to B" and "B relates to A" are one fact.
//    Both ends sort into `(type, id)` order before storage and the table refuses
//    the reverse, so a duplicate cannot exist in either direction — without
//    this, each side would show one relationship and the other two.
//
// 2. **Endpoints are checked in the same statement that inserts.** A
//    polymorphic pair cannot carry a SQL foreign key, so `links` has none: a
//    ghost endpoint is prevented here, with one `INSERT ... SELECT` whose WHERE
//    clause requires BOTH rows to exist. A separate read-then-insert would let
//    a delete slip through between the two.
//
// Deleting an entity removes its link rows in the same batch as the entity
// (see `deleteEntityLinks`), so no relationship can outlive both of its ends.
// The Trash lifecycle: while an endpoint is trashed the
// relationship is invisible from both sides, and restore brings it back.

import type { BatchStatement, DataDriver } from "../data/driver.ts";
import { todayLocal } from "./dates.ts";
import { type MessageKey, type MessageParams, translate } from "./i18n.ts";
import type {
  LinkableEntity,
  LinkableEntityType,
  RelatedItem,
} from "./types.ts";

export const LINKABLE_TYPES: LinkableEntityType[] = ["note", "task", "contact"];

/**
 * The table each entity type lives in — a closed, code-owned map.
 *
 * Identifiers are only ever interpolated from this map, never from a value read
 * out of a row, which is what lets the endpoint checks below stay one
 * statement without becoming an injection point.
 */
const ENTITY_TABLES: Record<LinkableEntityType, string> = {
  note: "notes",
  task: "tasks",
  contact: "contacts",
};

/** `EXISTS (SELECT 1 FROM <table> WHERE id = ?)` for one endpoint. */
function endpointExistsSql(type: LinkableEntityType): string {
  return `EXISTS (SELECT 1 FROM ${ENTITY_TABLES[type]} WHERE id = ?)`;
}

export function isLinkableType(type: string): type is LinkableEntityType {
  return (LINKABLE_TYPES as string[]).includes(type);
}

/**
 * A link refused because an endpoint no longer exists (G8 / D11).
 *
 * Carries a translation key instead of a pre-rendered English sentence, the
 * same shape as `InboxError` and `CsvImportError`. The picker renders the key
 * through `isMessageKeyError`, so the message reaches the user in their active
 * locale rather than as raw English. `message` stays the readable English
 * fallback — pinned to `en` so it is deterministic for logs, `errText`, and
 * the tests that match on it.
 */
export class LinkTargetGoneError extends Error {
  readonly messageKey: MessageKey;
  readonly params: MessageParams;

  constructor(messageKey: MessageKey, params: MessageParams = {}) {
    super(translate("en", messageKey, params));
    this.name = "LinkTargetGoneError";
    this.messageKey = messageKey;
    this.params = params;
  }
}

/**
 * The order a pair is stored in: smaller `(type, id)` first.
 *
 * `type` compares as text, byte for byte, which is exactly what SQLite's
 * BINARY collation does for these three ASCII names — so this function and the
 * table's CHECK constraint always agree. `a === b` compares the string; `id`
 * values are validated as positive integers before they get here.
 */
export function compareEntities(a: LinkableEntity, b: LinkableEntity): number {
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** The same pair with `(type, id)` ascending. Idempotent. */
export function canonicalPair(
  a: LinkableEntity,
  b: LinkableEntity,
): [LinkableEntity, LinkableEntity] {
  return compareEntities(a, b) <= 0 ? [a, b] : [b, a];
}

export function isSelfLink(a: LinkableEntity, b: LinkableEntity): boolean {
  return a.type === b.type && a.id === b.id;
}

/** A real row id: a positive integer. `0`, `-1`, `1.5` and NaN are refused. */
function isValidId(id: number): boolean {
  return Number.isInteger(id) && id > 0;
}

export function assertLinkableEntity(entity: LinkableEntity): void {
  if (!isLinkableType(entity.type)) {
    throw new Error(`Cannot link a ${String(entity.type)}.`);
  }
  if (!isValidId(entity.id)) {
    throw new Error("Cannot link an entity without a row.");
  }
}

/**
 * The single insert statement that both links and verifies.
 *
 * `INSERT OR IGNORE` rather than a plain insert: a duplicate pair is a no-op
 * the caller reports as "already linked", not an exception the user has to
 * interpret. It cannot mask anything else — the only constraints in play are
 * the UNIQUE pair and CHECKs this function's own validation already enforces.
 */
export function createLinkStatement(
  a: LinkableEntity,
  b: LinkableEntity,
): BatchStatement {
  const [first, second] = canonicalPair(a, b);
  return {
    sql: `INSERT OR IGNORE INTO links (kind, type_a, id_a, type_b, id_b, created_at)
          SELECT 'related', ?, ?, ?, ?, ?
          WHERE ${endpointExistsSql(first.type)} AND ${endpointExistsSql(second.type)}`,
    params: [
      first.type,
      first.id,
      second.type,
      second.id,
      todayLocal(),
      first.id,
      second.id,
    ],
  };
}

/**
 * Delete every relationship touching one entity, for a hard-delete batch.
 *
 * Both directions, because the pair is stored in canonical order and the entity
 * may be either end. Called from the same `driver.batch` that deletes the row,
 * so a relationship never outlives both of its ends.
 */
export function deleteEntityLinks(entity: LinkableEntity): BatchStatement[] {
  return [
    {
      sql: "DELETE FROM links WHERE (type_a = ? AND id_a = ?) OR (type_b = ? AND id_b = ?)",
      params: [entity.type, entity.id, entity.type, entity.id],
    },
  ];
}

/** A relationship that names itself is not a relationship (backup import). */
export function linkIsSelfReferential(row: {
  type_a: LinkableEntityType;
  id_a: number;
  type_b: LinkableEntityType;
  id_b: number;
}): boolean {
  return row.type_a === row.type_b && row.id_a === row.id_b;
}

/**
 * Whether a stored row is in canonical order. Backups carry rows straight from
 * a foreign machine, so this is checked before anything is written.
 */
export function linkIsCanonical(row: {
  type_a: LinkableEntityType;
  id_a: number;
  type_b: LinkableEntityType;
  id_b: number;
}): boolean {
  const [a, b] = [
    { type: row.type_a, id: row.id_a },
    { type: row.type_b, id: row.id_b },
  ];
  return compareEntities(a, b) < 0;
}

/**
 * What to show for one end: a label and one disambiguating word.
 *
 * Notes can have an empty title (the quick-capture path derives one, but a note
 * may be saved with none), so the fallback is part of the contract rather than
 * an empty row in the list.
 */
function displayFor(
  type: LinkableEntityType,
  row: Record<string, unknown>,
): {
  label: string;
  detail: string | null;
} {
  if (type === "note") {
    const title = typeof row.title === "string" ? row.title.trim() : "";
    return {
      label: title.length > 0 ? title : "Untitled note",
      detail: Number(row.archived) === 1 ? "Archived" : null,
    };
  }
  if (type === "task") {
    const title = typeof row.title === "string" ? row.title.trim() : "";
    return {
      label: title.length > 0 ? title : "Untitled task",
      detail: Number(row.done) === 1 ? "Done" : null,
    };
  }
  const name = typeof row.name === "string" ? row.name.trim() : "";
  return { label: name.length > 0 ? name : "Unnamed contact", detail: null };
}

export function createEntityLinksRepo(driver: DataDriver) {
  /**
   * Link two entities. Returns what happened, because "nothing happened" has
   * two very different reasons and the user needs to be told which.
   */
  async function createLink(
    a: LinkableEntity,
    b: LinkableEntity,
  ): Promise<{ linked: boolean; alreadyLinked: boolean }> {
    assertLinkableEntity(a);
    assertLinkableEntity(b);
    if (isSelfLink(a, b)) {
      throw new Error("An item cannot be linked to itself.");
    }
    const statement = createLinkStatement(a, b);
    const outcome = await driver.execute(statement.sql, statement.params);
    if (outcome.rowsAffected > 0) return { linked: true, alreadyLinked: false };
    // Zero rows means either the pair existed or an endpoint does not. One
    // read tells them apart, and only on this path.
    const [first, second] = canonicalPair(a, b);
    const existing = await driver.query<{ id: number }>(
      "SELECT id FROM links WHERE type_a = ? AND id_a = ? AND type_b = ? AND id_b = ?",
      [first.type, first.id, second.type, second.id],
    );
    if (existing.length > 0) return { linked: false, alreadyLinked: true };
    // A missing endpoint, as a keyed refusal (G8): the raw English sentence
    // used to surface inside the localized picker in Burmese mode.
    throw new LinkTargetGoneError("search.unavailable");
  }

  /** Unlink. Never deletes an entity — only the relationship. */
  async function removeLink(
    a: LinkableEntity,
    b: LinkableEntity,
  ): Promise<void> {
    assertLinkableEntity(a);
    assertLinkableEntity(b);
    const [first, second] = canonicalPair(a, b);
    await driver.execute(
      "DELETE FROM links WHERE type_a = ? AND id_a = ? AND type_b = ? AND id_b = ?",
      [first.type, first.id, second.type, second.id],
    );
  }

  /**
   * Everything `entity` is related to, from both directions of the table.
   *
   * Three label queries regardless of how many ends come back, and a row that
   * is missing from all three is reported as `gone` rather than dropped: the
   * relationship is still stored, and showing nothing would look like the
   * user's link had vanished.
   */
  async function listRelated(entity: LinkableEntity): Promise<RelatedItem[]> {
    assertLinkableEntity(entity);
    const rows = await driver.query<{ type: LinkableEntityType; id: number }>(
      `SELECT type_b AS type, id_b AS id FROM links WHERE type_a = ? AND id_a = ?
       UNION ALL
       SELECT type_a AS type, id_a AS id FROM links WHERE type_b = ? AND id_b = ?`,
      [entity.type, entity.id, entity.type, entity.id],
    );
    const items: RelatedItem[] = [];
    for (const type of LINKABLE_TYPES) {
      const ids = rows.filter((row) => row.type === type).map((row) => row.id);
      if (ids.length === 0) continue;
      const placeholders = ids.map(() => "?").join(", ");
      const found = await driver.query<Record<string, unknown>>(
        `SELECT * FROM ${ENTITY_TABLES[type]} WHERE id IN (${placeholders})`,
        ids,
      );
      const byId = new Map(
        found.map((row) => [(row.id as number) | 0, row] as const),
      );
      for (const id of ids) {
        const row = byId.get(id);
        if (!row) {
          items.push({
            entity: { type, id },
            label: "Unavailable",
            detail: null,
            gone: true,
          });
          continue;
        }
        const { label, detail } = displayFor(type, row);
        items.push({ entity: { type, id }, label, detail, gone: false });
      }
    }
    return items;
  }

  return { createLink, removeLink, listRelated };
}

/** Exported for the delete paths that compose their batches. */
export { ENTITY_TABLES as LINK_ENTITY_TABLES };
