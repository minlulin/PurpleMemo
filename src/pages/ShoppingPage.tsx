// P3d Shopping page: lists with checkable items and manual sort
// order. Reordering swaps an item one step and persists the full order
// (reorderItems batch).

import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { IconPlus, IconShopping } from "../components/icons.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { shoppingRepo } from "../data/app.ts";
import { errText } from "../lib/errors.ts";
import { moveItem } from "../lib/shopping.ts";
import type { ShoppingItemRow, ShoppingListRow } from "../lib/types.ts";

export default function ShoppingPage({
  focusItemId = null,
  focusListId = null,
  focusToken = 0,
}: {
  focusItemId?: number | null;
  focusListId?: number | null;
  focusToken?: number;
}) {
  const [lists, setLists] = useState<ShoppingListRow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [items, setItems] = useState<ShoppingItemRow[]>([]);
  const [itemsForListId, setItemsForListId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [listName, setListName] = useState("");
  const [itemName, setItemName] = useState("");
  /**
   * One shared submit guard for both create forms (review P3-6): the ref is
   * authoritative, the state is what the buttons read — the pinned
   * money-form shape. A double submit would make two lists or two items.
   */
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const itemLoadSeq = useRef(0);

  const reload = useCallback(async () => {
    try {
      const ls = await shoppingRepo.listLists();
      setLists(ls);
      setError(null);
      return ls;
    } catch (e) {
      setError(errText(e));
      return [];
    }
  }, []);

  const reloadItems = useCallback(async (listId: number | null) => {
    const seq = ++itemLoadSeq.current;
    setItemsForListId(null);
    if (listId === null) {
      setItems([]);
      return;
    }
    try {
      const next = await shoppingRepo.listItems(listId);
      if (seq !== itemLoadSeq.current) return;
      setItems(next);
      setItemsForListId(listId);
    } catch (e) {
      if (seq === itemLoadSeq.current) setError(errText(e));
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusToken reloads the target list on repeated jumps
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ls = await reload();
      if (cancelled) return;
      const first = ls[0]?.id ?? null;
      const requested =
        focusListId !== null && ls.some((list) => list.id === focusListId)
          ? focusListId
          : first;
      setSelectedId(requested);
      await reloadItems(requested);
      setLoading(false);
      if (focusItemId !== null && requested !== focusListId) {
        setError(
          "That shopping item no longer exists — it may have been deleted.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reload, reloadItems, focusItemId, focusListId, focusToken]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusToken scrolls to the same item after navigation
  useEffect(() => {
    if (
      focusItemId === null ||
      loading ||
      focusListId === null ||
      focusListId !== selectedId ||
      itemsForListId !== focusListId
    )
      return;
    if (!items.some((item) => item.id === focusItemId)) {
      setError(
        "That shopping item no longer exists — it may have been deleted.",
      );
      return;
    }
    document
      .getElementById(`search-target-shopping-${focusItemId}`)
      ?.scrollIntoView({ block: "nearest" });
    setError(null);
  }, [
    focusItemId,
    focusListId,
    focusToken,
    loading,
    selectedId,
    itemsForListId,
    items,
  ]);

  const select = async (id: number) => {
    setSelectedId(id);
    await reloadItems(id);
  };

  const addList = async () => {
    if (savingRef.current) return;
    const trimmed = listName.trim();
    if (trimmed.length === 0) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const id = await shoppingRepo.createList(trimmed);
      setListName("");
      await reload();
      await select(id);
    } catch (e) {
      setError(errText(e));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const removeList = async (id: number) => {
    try {
      await shoppingRepo.deleteList(id);
      if (selectedId === id) {
        const ls = await reload();
        const next = ls[0]?.id ?? null;
        setSelectedId(next);
        await reloadItems(next);
      } else {
        await reload();
      }
    } catch (e) {
      setError(errText(e));
    }
  };

  const commitRename = async (id: number) => {
    const trimmed = (renaming ?? "").trim();
    if (trimmed.length === 0) {
      setRenaming(null);
      return;
    }
    try {
      await shoppingRepo.renameList(id, trimmed);
      setRenaming(null);
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  const addItem = async () => {
    if (savingRef.current) return;
    const trimmed = itemName.trim();
    if (trimmed.length === 0 || selectedId === null) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await shoppingRepo.addItem(selectedId, trimmed);
      setItemName("");
      await reloadItems(selectedId);
    } catch (e) {
      setError(errText(e));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const toggle = async (item: ShoppingItemRow) => {
    try {
      await shoppingRepo.toggleItem(item.id, item.done === 0);
      await reloadItems(selectedId);
    } catch (e) {
      setError(errText(e));
    }
  };

  const removeItem = async (id: number) => {
    try {
      await shoppingRepo.deleteItem(id);
      await reloadItems(selectedId);
    } catch (e) {
      setError(errText(e));
    }
  };

  const move = async (index: number, direction: "up" | "down") => {
    const next = moveItem(
      items.map((i) => i.id),
      index,
      direction,
    );
    try {
      await shoppingRepo.reorderItems(next);
      await reloadItems(selectedId);
    } catch (e) {
      setError(errText(e));
    }
  };

  const doneCount = items.filter((i) => i.done === 1).length;

  return (
    <div className="budget-page">
      <header className="page-header">
        <div className="page-header-main">
          <div className="page-title-row">
            <span className="page-icon-badge">
              <IconShopping className="icon" />
            </span>
            <div>
              <h2 className="editor-title">Shopping Lists</h2>
              <p className="page-subtitle">
                Checkable shopping &amp; packing lists with manual priority
                ordering
              </p>
            </div>
          </div>
        </div>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void addList();
          }}
        >
          <input
            aria-label="New list name"
            placeholder="New list (e.g. Market)"
            value={listName}
            onChange={(e) => setListName(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || listName.trim().length === 0}
          >
            <IconPlus className="icon" /> Add list
          </button>
        </form>
      </header>

      {loading ? <Skeleton count={3} /> : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      {lists.length === 0 ? (
        <section className="settings-section">
          <EmptyState>No shopping lists yet — add one above.</EmptyState>
        </section>
      ) : (
        <>
          <div className="day-nav">
            {lists.map((l) => (
              <span
                key={l.id}
                className={
                  selectedId === l.id
                    ? "shopping-tab-group is-active"
                    : "shopping-tab-group"
                }
              >
                <button
                  type="button"
                  className={selectedId === l.id ? "btn is-on" : "btn"}
                  aria-pressed={selectedId === l.id}
                  onClick={() => void select(l.id)}
                >
                  {l.name}
                </button>
                {/* This `×` sits directly beside the list-selection tab, and it
                    takes every item in the list with it (review P2-10). */}
                <ConfirmButton
                  className="btn btn-ghost"
                  what={`list “${l.name}” and its items`}
                  aria-label={`Delete list ${l.name}`}
                  onConfirm={() => removeList(l.id)}
                >
                  ×
                </ConfirmButton>
              </span>
            ))}
          </div>

          {selectedId !== null ? (
            <section
              className="settings-section"
              aria-label="Selected list items"
            >
              <div className="dash-card-head">
                <div className="row-title">
                  <h3 className="settings-heading">
                    {lists.find((l) => l.id === selectedId)?.name ?? "List"}
                  </h3>
                  <span className="badge badge-accent figure">
                    {doneCount}/{items.length} checked
                  </span>
                </div>
                {renaming !== null ? (
                  <span className="inline-form">
                    <input
                      aria-label="List name"
                      value={renaming}
                      onChange={(e) => setRenaming(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={renaming.trim().length === 0}
                      onClick={() => void commitRename(selectedId)}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setRenaming(null)}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() =>
                      setRenaming(
                        lists.find((l) => l.id === selectedId)?.name ?? "",
                      )
                    }
                  >
                    Rename list
                  </button>
                )}
              </div>

              {items.length === 0 ? (
                <EmptyState>Empty list — add items below.</EmptyState>
              ) : (
                <ul className="budget-list">
                  {items.map((item, index) => (
                    <li
                      key={item.id}
                      id={
                        focusItemId === item.id
                          ? `search-target-shopping-${item.id}`
                          : undefined
                      }
                      className={
                        focusItemId === item.id
                          ? "budget-row is-search-target"
                          : "budget-row"
                      }
                    >
                      <label className="check-label">
                        <input
                          type="checkbox"
                          checked={item.done === 1}
                          onChange={() => void toggle(item)}
                        />{" "}
                        <span className={item.done === 1 ? "muted" : undefined}>
                          {item.text}
                        </span>
                      </label>
                      <span className="row-actions">
                        <button
                          type="button"
                          className="btn btn-ghost"
                          aria-label={`Move ${item.text} up`}
                          onClick={() => void move(index, "up")}
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          aria-label={`Move ${item.text} down`}
                          onClick={() => void move(index, "down")}
                        >
                          ▼
                        </button>
                        <ConfirmButton
                          className="btn btn-ghost"
                          what="item"
                          onConfirm={() => removeItem(item.id)}
                        >
                          Delete
                        </ConfirmButton>
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void addItem();
                }}
              >
                <input
                  aria-label="New item"
                  placeholder="Add item (e.g. Rice 5kg)"
                  value={itemName}
                  onChange={(e) => setItemName(e.target.value)}
                />
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={saving || itemName.trim().length === 0}
                >
                  Add item
                </button>
              </form>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
