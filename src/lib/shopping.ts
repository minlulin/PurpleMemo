// Shopping List repository (§2.6): lists with checkable items, manual sort
// order.

import type { DataDriver } from "../data/driver.ts";
import { todayLocal } from "./dates.ts";
import type { ShoppingItemRow, ShoppingListRow } from "./types.ts";

/**
 * Move an item one step up/down in the manual order (§2.6). Returns the
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
      const r = await driver.execute(
        "INSERT INTO shopping_lists (name, created_at) VALUES (?, ?)",
        [name, todayLocal()],
      );
      return r.lastInsertRowid;
    },

    async renameList(id: number, name: string): Promise<void> {
      await driver.execute("UPDATE shopping_lists SET name = ? WHERE id = ?", [
        name,
        id,
      ]);
    },

    async deleteList(id: number): Promise<void> {
      await driver.execute("DELETE FROM shopping_lists WHERE id = ?", [id]);
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
      const r = await driver.execute(
        "INSERT INTO shopping_items (list_id, text, done, sort_order) VALUES (?, ?, 0, ?)",
        [listId, text, nextOrder],
      );
      return r.lastInsertRowid;
    },

    async updateItemText(id: number, text: string): Promise<void> {
      await driver.execute("UPDATE shopping_items SET text = ? WHERE id = ?", [
        text,
        id,
      ]);
    },

    async toggleItem(id: number, done: boolean): Promise<void> {
      await driver.execute("UPDATE shopping_items SET done = ? WHERE id = ?", [
        done ? 1 : 0,
        id,
      ]);
    },

    async deleteItem(id: number): Promise<void> {
      await driver.execute("DELETE FROM shopping_items WHERE id = ?", [id]);
    },

    /** Persist a manual reorder: `orderedIds` is the new top-to-bottom order. */
    async reorderItems(orderedIds: number[]): Promise<void> {
      await driver.batch(
        orderedIds.map((id, index) => ({
          sql: "UPDATE shopping_items SET sort_order = ? WHERE id = ?",
          params: [index, id],
        })),
      );
    },

    /** A list with its items — the list view (§2.6). */
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

export type ShoppingRepo = ReturnType<typeof createShoppingRepo>;
