// Shopping List repository: lists with checkable items, manual sort
// order.

import type { DataDriver } from "../data/driver.ts";
import { todayLocal } from "./dates.ts";
import {
  deleteStatements,
  outboxStatements,
  readRowId,
  readRowUid,
} from "./sync/store.ts";
import type { ShoppingItemRow, ShoppingListRow } from "./types.ts";
import { newUid } from "./uid.ts";

/**
 * The uids of the rows a query returned, dropping the pre-v7 rows that have
 * none: an op cannot name a record without an identity (§1.1), and such a row
 * is invisible to sync until a backfill or an edit gives it one.
 */
function uidsOf(rows: readonly { uid: string | null }[]): string[] {
  return rows
    .map((row) => row.uid)
    .filter((uid: string | null): uid is string =>
      Boolean(uid && uid.length > 0),
    );
}

/**
 * Move an item one step up/down in the manual order. Returns the
 * new id order; moving past either end is a no-op (same array semantics,
 * new copy). The caller persists via `reorderItems`.
 */
export function moveItem(
  orderedIds: number[],
  index: number,
  direction: "up" | "down",
): number[] {
  const swap = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || index >= orderedIds.length) return [...orderedIds];
  if (swap < 0 || swap >= orderedIds.length) return [...orderedIds];
  const out = [...orderedIds];
  const a = out[index];
  const b = out[swap];
  if (a === undefined || b === undefined) return out;
  out[index] = b;
  out[swap] = a;
  return out;
}

export function createShoppingRepo(driver: DataDriver) {
  return {
    async listLists(): Promise<ShoppingListRow[]> {
      return driver.query<ShoppingListRow>(
        "SELECT * FROM shopping_lists ORDER BY id",
      );
    },

    async createList(name: string): Promise<number> {
      const created = todayLocal();
      const uid = newUid();
      await driver.batch([
        {
          sql: "INSERT INTO shopping_lists (name, created_at, uid) VALUES (?, ?, ?)",
          params: [name, created, uid],
        },
        ...outboxStatements([
          {
            table: "shopping_lists",
            uid,
            kind: "create",
            fields: { name, created_at: created },
          },
        ]),
      ]);
      return readRowId(driver, "shopping_lists", uid);
    },

    async renameList(id: number, name: string): Promise<void> {
      const uid = await readRowUid(driver, "shopping_lists", id);
      await driver.batch([
        {
          sql: "UPDATE shopping_lists SET name = ? WHERE id = ?",
          params: [name, id],
        },
        ...outboxStatements(
          uid
            ? [
                {
                  table: "shopping_lists" as const,
                  uid,
                  kind: "update",
                  fields: { name },
                },
              ]
            : [],
        ),
      ]);
    },

    async deleteList(id: number): Promise<void> {
      const uid = await readRowUid(driver, "shopping_lists", id);
      // §5.2: the FK cascade removes the items, but the cascade is NOT the
      // record — each child needs its own tombstone, read here before the
      // delete makes the rows unreachable.
      const items = uidsOf(
        await driver.query<{ uid: string | null }>(
          "SELECT uid FROM shopping_items WHERE list_id = ? ORDER BY id",
          [id],
        ),
      );
      await driver.batch([
        { sql: "DELETE FROM shopping_lists WHERE id = ?", params: [id] },
        ...deleteStatements([
          ...(uid ? [{ table: "shopping_lists" as const, uid }] : []),
          ...items.map((item) => ({
            table: "shopping_items" as const,
            uid: item,
          })),
        ]),
      ]);
    },

    async listItems(listId: number): Promise<ShoppingItemRow[]> {
      return driver.query<ShoppingItemRow>(
        "SELECT * FROM shopping_items WHERE list_id = ? ORDER BY sort_order, id",
        [listId],
      );
    },

    /** Add an item at the end of the manual order. */
    async addItem(listId: number, text: string): Promise<number> {
      const maxRows = await driver.query<{ max_order: number | null }>(
        "SELECT MAX(sort_order) AS max_order FROM shopping_items WHERE list_id = ?",
        [listId],
      );
      const nextOrder = (maxRows[0]?.max_order ?? -1) + 1;
      const uid = newUid();
      await driver.batch([
        {
          sql: "INSERT INTO shopping_items (list_id, text, done, sort_order, uid) VALUES (?, ?, 0, ?, ?)",
          params: [listId, text, nextOrder, uid],
        },
        ...outboxStatements([
          {
            table: "shopping_items",
            uid,
            // The parent is named by its uid at the wire (§8.4's mapping) —
            // this op carries the row's own `list_id`, as it stands here.
            kind: "create",
            fields: { list_id: listId, text, done: 0, sort_order: nextOrder },
          },
        ]),
      ]);
      return readRowId(driver, "shopping_items", uid);
    },

    async updateItemText(id: number, text: string): Promise<void> {
      const uid = await readRowUid(driver, "shopping_items", id);
      await driver.batch([
        {
          sql: "UPDATE shopping_items SET text = ? WHERE id = ?",
          params: [text, id],
        },
        ...outboxStatements(
          uid
            ? [
                {
                  table: "shopping_items" as const,
                  uid,
                  kind: "update",
                  fields: { text },
                },
              ]
            : [],
        ),
      ]);
    },

    async toggleItem(id: number, done: boolean): Promise<void> {
      const value = done ? 1 : 0;
      const uid = await readRowUid(driver, "shopping_items", id);
      await driver.batch([
        {
          sql: "UPDATE shopping_items SET done = ? WHERE id = ?",
          params: [value, id],
        },
        ...outboxStatements(
          uid
            ? [
                {
                  table: "shopping_items" as const,
                  uid,
                  kind: "toggle",
                  fields: { done: value },
                },
              ]
            : [],
        ),
      ]);
    },

    async deleteItem(id: number): Promise<void> {
      const uid = await readRowUid(driver, "shopping_items", id);
      await driver.batch([
        { sql: "DELETE FROM shopping_items WHERE id = ?", params: [id] },
        ...deleteStatements(uid ? [{ table: "shopping_items", uid }] : []),
      ]);
    },

    /** Persist a manual reorder: `orderedIds` is the new top-to-bottom order. */
    async reorderItems(orderedIds: number[]): Promise<void> {
      // A reorder is one write per moved item, so it is one op per item too:
      // §4.3's per-field stamps are how two devices reordering different ends
      // of a list both keep their order instead of one overwriting the other.
      const uids = new Map<number, string>();
      if (orderedIds.length > 0) {
        const rows = await driver.query<{ id: number; uid: string | null }>(
          `SELECT id, uid FROM shopping_items WHERE id IN (${orderedIds.map(() => "?").join(", ")})`,
          orderedIds,
        );
        for (const row of rows) {
          if (row.uid && row.uid.length > 0) uids.set(row.id, row.uid);
        }
      }
      const moved = orderedIds
        .map((id, index) => ({ uid: uids.get(id), sort_order: index }))
        .filter((entry): entry is { uid: string; sort_order: number } =>
          Boolean(entry.uid),
        );
      await driver.batch([
        ...orderedIds.map((id, index) => ({
          sql: "UPDATE shopping_items SET sort_order = ? WHERE id = ?",
          params: [index, id],
        })),
        ...outboxStatements(
          moved.map((entry) => ({
            table: "shopping_items" as const,
            uid: entry.uid,
            kind: "update" as const,
            fields: { sort_order: entry.sort_order },
          })),
        ),
      ]);
    },

    /** A list with its items — the list view. */
    async getListWithItems(listId: number): Promise<{
      list: ShoppingListRow | undefined;
      items: ShoppingItemRow[];
    }> {
      const [list, items] = await Promise.all([
        driver.query<ShoppingListRow>(
          "SELECT * FROM shopping_lists WHERE id = ?",
          [listId],
        ),
        this.listItems(listId),
      ]);
      return { list: list[0], items };
    },
  };
}
