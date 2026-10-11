// P3c Business page (§2.2): shops, jobs, receivable, payables, history.
// Talks only to the business + budget repos (§4). Views land progressively:
// this file starts with the shell + Shops view and gains one view per task.

import { useCallback, useEffect, useState } from "react";
import { businessRepo } from "../data/app.ts";
import { shopReceivableRows } from "../lib/business.ts";
import { formatMMK } from "../lib/money.ts";
import type { ShopRow } from "../lib/types.ts";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type BusinessView = "jobs" | "receivable" | "payables" | "history" | "shops";

const VIEWS: { key: BusinessView; label: string }[] = [
  { key: "jobs", label: "Jobs" },
  { key: "receivable", label: "Receivable" },
  { key: "payables", label: "Payables" },
  { key: "history", label: "History" },
  { key: "shops", label: "Shops" },
];

export default function BusinessPage() {
  const [view, setView] = useState<BusinessView>("jobs");

  return (
    <div className="budget-page">
      <nav className="budget-viewnav" aria-label="Business views">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            className={view === v.key ? "nav-tab is-active" : "nav-tab"}
            aria-current={view === v.key ? "page" : undefined}
            onClick={() => setView(v.key)}
          >
            {v.label}
          </button>
        ))}
      </nav>
      {view === "shops" ? (
        <ShopsView />
      ) : (
        <p className="muted">
          The {VIEWS.find((v) => v.key === view)?.label} view lands in a later
          P3c task.
        </p>
      )}
    </div>
  );
}

/** Shops directory with per-customer receivable totals (§2.2). */
function ShopsView() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    name: "",
    phone: "",
    address: "",
    notes: "",
  });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState({
    name: "",
    phone: "",
    address: "",
    notes: "",
  });

  const [rows, setRows] = useState<ReturnType<typeof shopReceivableRows>>([]);

  const reload = useCallback(async () => {
    try {
      const [ws, totals] = await Promise.all([
        businessRepo.listShops(),
        businessRepo.shopReceivableTotals(),
      ]);
      setRows(shopReceivableRows(ws, totals));
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const nameOk = draft.name.trim().length > 0;

  const addShop = async () => {
    if (!nameOk) return;
    try {
      await businessRepo.createShop({
        name: draft.name.trim(),
        phone: draft.phone.trim(),
        address: draft.address.trim(),
        notes: draft.notes.trim(),
      });
      setDraft({ name: "", phone: "", address: "", notes: "" });
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  const startEdit = (s: ShopRow) => {
    setEditingId(s.id);
    setEditDraft({
      name: s.name,
      phone: s.phone,
      address: s.address,
      notes: s.notes,
    });
  };

  const saveEdit = async () => {
    if (editingId === null || editDraft.name.trim().length === 0) return;
    try {
      await businessRepo.updateShop(editingId, {
        name: editDraft.name.trim(),
        phone: editDraft.phone.trim(),
        address: editDraft.address.trim(),
        notes: editDraft.notes.trim(),
      });
      setEditingId(null);
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  const removeShop = async (id: number) => {
    try {
      await businessRepo.deleteShop(id);
      if (editingId === id) setEditingId(null);
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <section className="budget-manage" aria-label="Shops">
      {loading ? <p className="muted">Loading…</p> : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="muted">No shops yet — add one below.</p>
      ) : (
        <ul className="budget-list">
          {rows.map((s) => (
            <li key={s.id} className="budget-row">
              {editingId === s.id ? (
                <>
                  <input
                    aria-label="Shop name"
                    value={editDraft.name}
                    onChange={(e) =>
                      setEditDraft({ ...editDraft, name: e.target.value })
                    }
                  />
                  <input
                    aria-label="Shop phone"
                    placeholder="Phone"
                    value={editDraft.phone}
                    onChange={(e) =>
                      setEditDraft({ ...editDraft, phone: e.target.value })
                    }
                  />
                  <input
                    aria-label="Shop address"
                    placeholder="Address"
                    value={editDraft.address}
                    onChange={(e) =>
                      setEditDraft({ ...editDraft, address: e.target.value })
                    }
                  />
                  <input
                    aria-label="Shop notes"
                    placeholder="Notes"
                    value={editDraft.notes}
                    onChange={(e) =>
                      setEditDraft({ ...editDraft, notes: e.target.value })
                    }
                  />
                  <span className="row-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={editDraft.name.trim().length === 0}
                      onClick={() => void saveEdit()}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setEditingId(null)}
                    >
                      Cancel
                    </button>
                  </span>
                </>
              ) : (
                <>
                  <span>
                    {s.name}
                    {s.phone ? (
                      <span className="muted"> · {s.phone}</span>
                    ) : null}
                    {s.address ? (
                      <span className="muted"> · {s.address}</span>
                    ) : null}
                    {s.notes ? (
                      <span className="muted"> — {s.notes}</span>
                    ) : null}
                  </span>
                  <span className="muted figure">
                    {s.remaining_cents > 0
                      ? `owes ${formatMMK(s.remaining_cents)}`
                      : ""}
                  </span>
                  <span className="row-actions">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => startEdit(s)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => void removeShop(s.id)}
                    >
                      Delete
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <form
        className="entry-form"
        onSubmit={(e) => {
          e.preventDefault();
          void addShop();
        }}
      >
        <h2 className="side-heading">New shop</h2>
        <label>
          Name
          <input
            value={draft.name}
            placeholder="e.g. Aung Electronics"
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label>
          Phone (optional)
          <input
            value={draft.phone}
            placeholder="09…"
            onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
          />
        </label>
        <label>
          Address (optional)
          <input
            value={draft.address}
            onChange={(e) => setDraft({ ...draft, address: e.target.value })}
          />
        </label>
        <label>
          Notes (optional)
          <input
            value={draft.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          />
        </label>
        <div className="row-actions">
          <button type="submit" className="btn btn-primary" disabled={!nameOk}>
            Add shop
          </button>
        </div>
      </form>
    </section>
  );
}
