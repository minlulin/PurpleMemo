// The phone's Shopping screen and its item form.

import { useCallback, useEffect, useState } from "react";
import { shoppingRepo } from "../../data/app.ts";
import type { ShoppingItemRow, ShoppingListRow } from "../../lib/types.ts";
import { EmptyState } from "../EmptyState.tsx";
import { useT } from "../useTranslation.ts";
import { LoadMessage, useLoad } from "./common.tsx";

// -- Shopping ----------------------------------------------------------------

export function ShoppingScreen({ onCompose }: { onCompose: () => void }) {
  const t = useT();
  const load = useCallback(() => shoppingRepo.listLists(), []);
  const { data: lists, failed, reload } = useLoad(load);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newList, setNewList] = useState("");
  const [creating, setCreating] = useState(false);
  const [items, setItems] = useState<ShoppingItemRow[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);

  const all = lists ?? [];
  const selected = all.find((list) => list.id === selectedId) ?? all[0];

  // The item list follows the selected list; `reloadIfEmpty` re-reads the
  // lists after the create form adds one.
  useEffect(() => {
    if (selected === undefined) {
      setItems([]);
      return;
    }
    let cancelled = false;
    shoppingRepo
      .listItems(selected.id)
      .then((rows) => {
        if (!cancelled) setItems(rows);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const toggleItem = async (item: ShoppingItemRow) => {
    setBusyId(item.id);
    try {
      await shoppingRepo.toggleItem(item.id, item.done === 0);
      const rows = await shoppingRepo.listItems(item.list_id);
      setItems(rows);
    } finally {
      setBusyId(null);
    }
  };

  const createList = async () => {
    const name = newList.trim();
    if (name === "" || creating) return;
    setCreating(true);
    try {
      const id = await shoppingRepo.createList(name);
      setNewList("");
      setSelectedId(id);
      reload();
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="mobile-page">
      <p className="mobile-section-kicker">{t("nav.shopping")}</p>
      <div className="mobile-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={onCompose}
          disabled={all.length === 0}
        >
          {t("mobile.addItem")}
        </button>
      </div>
      <LoadMessage failed={failed} />
      {all.length === 0 ? (
        <EmptyState>{t("mobile.shoppingNoLists")}</EmptyState>
      ) : (
        <div
          className="mobile-chips"
          role="tablist"
          aria-label={t("nav.shopping")}
        >
          {all.map((list) => (
            <button
              key={list.id}
              type="button"
              role="tab"
              aria-selected={(selected?.id ?? null) === list.id}
              className={
                (selected?.id ?? null) === list.id
                  ? "mobile-chip is-active"
                  : "mobile-chip"
              }
              onClick={() => setSelectedId(list.id)}
            >
              {list.name}
            </button>
          ))}
        </div>
      )}
      {all.length > 0 && items.length === 0 ? (
        <EmptyState>{t("mobile.shoppingEmpty")}</EmptyState>
      ) : null}
      <ul className="mobile-list" aria-label={t("mobile.shoppingItemsAria")}>
        {items.map((item) => (
          <li key={item.id}>
            <label
              className={item.done === 0 ? "mobile-row" : "mobile-row is-done"}
            >
              <input
                type="checkbox"
                checked={item.done === 1}
                disabled={busyId === item.id}
                aria-label={
                  item.done === 1
                    ? t("mobile.markNotBoughtOf", { title: item.text })
                    : t("mobile.markBoughtOf", { title: item.text })
                }
                onChange={() => void toggleItem(item)}
              />
              <span className="mobile-row-text">{item.text}</span>
            </label>
          </li>
        ))}
      </ul>
      <form
        className="mobile-actions"
        onSubmit={(event) => {
          event.preventDefault();
          void createList();
        }}
      >
        <input
          className="input"
          type="text"
          value={newList}
          placeholder={t("mobile.shoppingNewList")}
          aria-label={t("mobile.shoppingNewList")}
          onChange={(event) => setNewList(event.currentTarget.value)}
        />
        <button
          type="submit"
          className="btn"
          disabled={creating || newList.trim() === ""}
        >
          {t("mobile.shoppingCreateList")}
        </button>
      </form>
    </section>
  );
}

export function ShoppingItemCompose({ onDone }: { onDone: () => void }) {
  const t = useT();
  const load = useCallback(() => shoppingRepo.listLists(), []);
  const { data: lists, failed } = useLoad(load);
  const [text, setText] = useState("");
  const [listId, setListId] = useState<number | null>(null);
  const [newListName, setNewListName] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const all: ShoppingListRow[] = lists ?? [];
  const targetId = listId ?? all[0]?.id ?? null;

  const save = async () => {
    if (text.trim() === "" || busy) return;
    setBusy(true);
    setSaveFailed(false);
    try {
      let destination = targetId;
      if (destination === null) {
        const name = newListName.trim();
        if (name === "") {
          setBusy(false);
          return;
        }
        destination = await shoppingRepo.createList(name);
      }
      await shoppingRepo.addItem(destination, text.trim());
      onDone();
    } catch {
      setSaveFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mobile-page">
      <form
        className="mobile-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="mobile-field">
          <span>{t("mobile.shoppingItemLabel")}</span>
          <input
            className="input"
            type="text"
            value={text}
            placeholder={t("mobile.shoppingItemPlaceholder")}
            onChange={(event) => setText(event.currentTarget.value)}
          />
        </label>
        {all.length > 0 ? (
          <label className="mobile-field">
            <span>{t("mobile.shoppingListLabel")}</span>
            <select
              className="input"
              value={String(targetId ?? "")}
              onChange={(event) => setListId(Number(event.currentTarget.value))}
            >
              {all.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="mobile-field">
            <span>{t("mobile.shoppingListName")}</span>
            <input
              className="input"
              type="text"
              value={newListName}
              placeholder={t("mobile.shoppingNewList")}
              onChange={(event) => setNewListName(event.currentTarget.value)}
            />
          </label>
        )}
        <LoadMessage failed={failed || saveFailed} />
        <div className="mobile-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || text.trim() === ""}
          >
            {busy ? t("notes.saving") : t("mobile.addItem")}
          </button>
        </div>
      </form>
    </section>
  );
}
