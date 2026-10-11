// P3c Business page (§2.2): shops, jobs, receivable, payables, history.
// Talks only to the business + budget repos (§4). Views land progressively:
// this file starts with the shell + Shops view and gains one view per task.

import { useCallback, useEffect, useState } from "react";
import { budgetRepo, businessRepo } from "../data/app.ts";
import {
  inWarranty,
  type ReceivableJob,
  type ShopReceivableRow,
  shopReceivableRows,
  warrantyEndDate,
} from "../lib/business.ts";
import { todayLocal } from "../lib/dates.ts";
import { formatMMK, parseMMK } from "../lib/money.ts";
import type { ShopRow, WalletRow } from "../lib/types.ts";

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
      </nav>{" "}
      {view === "shops" ? (
        <ShopsView />
      ) : view === "jobs" ? (
        <JobsView />
      ) : view === "receivable" ? (
        <ReceivableView />
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

/** Open jobs with remaining balance + inline payment (§2.2 Receivable). */
function JobsView() {
  const [jobs, setJobs] = useState<ReceivableJob[]>([]);
  const [shops, setShops] = useState<ShopRow[]>([]);
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payFor, setPayFor] = useState<number | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payWallet, setPayWallet] = useState<number | "">("");

  const [title, setTitle] = useState("");
  const [amountRaw, setAmountRaw] = useState("");
  const [shopId, setShopId] = useState<number | "">("");
  const [jobDate, setJobDate] = useState(todayLocal());
  const [warrantyDays, setWarrantyDays] = useState("");
  const [note, setNote] = useState("");

  const reload = useCallback(async () => {
    try {
      const [js, ss, ws] = await Promise.all([
        businessRepo.listReceivable(),
        businessRepo.listShops(),
        budgetRepo.listWallets(),
      ]);
      setJobs(js);
      setShops(ss);
      setWallets(ws);
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

  const shopName = (id: number | null): string =>
    shops.find((s) => s.id === id)?.name ?? "—";

  const amountCents = parseMMK(amountRaw);
  const warranty = Number(warrantyDays);
  const titleOk = title.trim().length > 0;

  const addJob = async () => {
    if (amountCents === null || amountCents <= 0 || !titleOk || !jobDate)
      return;
    try {
      await businessRepo.createJob({
        title: title.trim(),
        shopId: shopId === "" ? null : shopId,
        totalCents: amountCents,
        jobDate,
        warrantyDays:
          warrantyDays.trim() !== "" &&
          Number.isInteger(warranty) &&
          warranty > 0
            ? warranty
            : null,
        note: note.trim(),
      });
      setTitle("");
      setAmountRaw("");
      setWarrantyDays("");
      setNote("");
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  const pay = async (jobId: number) => {
    const cents = parseMMK(payAmount);
    if (cents === null || cents <= 0 || typeof payWallet !== "number") return;
    try {
      await businessRepo.recordJobPayment({
        jobId,
        amountCents: cents,
        walletId: payWallet,
        date: todayLocal(),
      });
      setPayFor(null);
      setPayAmount("");
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <section className="budget-manage" aria-label="Open jobs">
      {loading ? <p className="muted">Loading…</p> : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      {jobs.length === 0 ? (
        <p className="muted">No open jobs — create one below.</p>
      ) : (
        <ul className="budget-list">
          {jobs.map((j) => (
            <li key={j.id} className="budget-row">
              <span>
                {j.title}
                <span className="muted"> · {shopName(j.shop_id)}</span>
                {j.note ? <span className="muted"> — {j.note}</span> : null}
              </span>
              <span className="muted figure">
                {formatMMK(j.paid_cents)} / {formatMMK(j.total_cents)}
              </span>
              <span className="muted figure">
                {formatMMK(j.remaining_cents)} left
              </span>
              {warrantyEndDate(j) !== null ? (
                <span className="muted">
                  {inWarranty(j, todayLocal())
                    ? `warranty until ${warrantyEndDate(j)}`
                    : `warranty ended ${warrantyEndDate(j)}`}
                </span>
              ) : null}
              <span className="row-actions">
                {payFor === j.id ? (
                  <>
                    <input
                      aria-label={`Payment amount for ${j.title}`}
                      inputMode="decimal"
                      placeholder="0.00"
                      value={payAmount}
                      onChange={(e) => setPayAmount(e.target.value)}
                    />
                    <select
                      aria-label="Payment wallet"
                      value={payWallet === "" ? "" : String(payWallet)}
                      onChange={(e) =>
                        setPayWallet(
                          e.target.value === "" ? "" : Number(e.target.value),
                        )
                      }
                    >
                      <option value="">Wallet…</option>
                      {wallets.map((w) => (
                        <option key={w.id} value={String(w.id)}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={
                        parseMMK(payAmount) === null ||
                        (parseMMK(payAmount) ?? 0) <= 0 ||
                        payWallet === ""
                      }
                      onClick={() => void pay(j.id)}
                    >
                      Save payment
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setPayFor(null)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      setPayFor(j.id);
                      setPayAmount((j.remaining_cents / 100).toFixed(2));
                      setPayWallet("");
                    }}
                  >
                    Record payment
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <form
        className="entry-form"
        onSubmit={(e) => {
          e.preventDefault();
          void addJob();
        }}
      >
        <h2 className="side-heading">New job</h2>
        <label>
          Title
          <input
            value={title}
            placeholder="e.g. Fix fan"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          Customer shop (optional)
          <select
            aria-label="Customer shop"
            value={shopId === "" ? "" : String(shopId)}
            onChange={(e) =>
              setShopId(e.target.value === "" ? "" : Number(e.target.value))
            }
          >
            <option value="">None</option>
            {shops.map((s) => (
              <option key={s.id} value={String(s.id)}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Total amount (MMK)
          <input
            inputMode="decimal"
            placeholder="0.00"
            value={amountRaw}
            onChange={(e) => setAmountRaw(e.target.value)}
          />
        </label>
        <label>
          Job date
          <input
            type="date"
            aria-label="Job date"
            value={jobDate}
            onChange={(e) => setJobDate(e.target.value)}
          />
        </label>
        <label>
          Warranty days (optional — repair jobs)
          <input
            inputMode="numeric"
            placeholder="e.g. 30"
            value={warrantyDays}
            onChange={(e) => setWarrantyDays(e.target.value)}
          />
        </label>
        <label>
          Note (optional)
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="row-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={
              !titleOk || amountCents === null || amountCents <= 0 || !jobDate
            }
          >
            Add job
          </button>
        </div>
      </form>
    </section>
  );
}

/** Receivable grouped per customer with totals (§2.2). */
function ReceivableView() {
  const [rows, setRows] = useState<ShopReceivableRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [shops, totals] = await Promise.all([
          businessRepo.listShops(),
          businessRepo.shopReceivableTotals(),
        ]);
        if (!cancelled)
          setRows(
            shopReceivableRows(shops, totals).filter(
              (r) => r.remaining_cents > 0,
            ),
          );
        setError(null);
      } catch (e) {
        if (!cancelled) setError(errText(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const total = rows.reduce((s, r) => s + r.remaining_cents, 0);

  return (
    <section className="budget-manage" aria-label="Receivable by customer">
      {loading ? <p className="muted">Loading…</p> : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="muted">Nothing outstanding — no receivables.</p>
      ) : (
        <>
          <ul className="budget-list">
            {rows.map((r) => (
              <li key={r.id} className="budget-row">
                <span>{r.name}</span>
                <span className="figure amount-expense">
                  {formatMMK(r.remaining_cents)}
                </span>
              </li>
            ))}
          </ul>
          <p className="budget-row">
            <strong>Total outstanding</strong>
            <strong className="figure amount-expense">
              {formatMMK(total)}
            </strong>
          </p>
          <p className="muted">
            Record partial payments from the Jobs view; a job joins History (and
            books Business income) when fully paid.
          </p>
        </>
      )}
    </section>
  );
}
