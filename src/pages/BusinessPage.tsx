// P3c Business page (§2.2): shops, jobs, receivable, payables, history.
// Talks only to the business + budget repos (§4).

import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "../components/EmptyState.tsx";
import { IconBusiness, IconCalendar } from "../components/icons.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { budgetRepo, businessRepo } from "../data/app.ts";
import {
  inWarranty,
  payableDueStatus,
  type ReceivableJob,
  type ShopReceivableRow,
  shopReceivableRows,
  warrantyEndDate,
} from "../lib/business.ts";
import { todayLocal } from "../lib/dates.ts";
import { errText } from "../lib/errors.ts";
import {
  formatMMK,
  fromCents,
  isPartialAmount,
  parseMMK,
} from "../lib/money.ts";
import type {
  ExpenseCategoryRow,
  JobRow,
  PayableRow,
  ShopRow,
  WalletRow,
} from "../lib/types.ts";

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
      <header className="page-header">
        <div className="page-header-main">
          <div className="page-title-row">
            <span className="page-icon-badge">
              <IconBusiness className="icon" />
            </span>
            <div>
              <h2 className="editor-title">Business Tracker</h2>
              <p className="page-subtitle">
                Customer jobs, receivables, repair warranties &amp; supplier
                payables
              </p>
            </div>
          </div>
        </div>
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
      </header>

      {view === "shops" ? (
        <ShopsView />
      ) : view === "jobs" ? (
        <JobsView />
      ) : view === "receivable" ? (
        <ReceivableView />
      ) : view === "history" ? (
        <HistoryView />
      ) : view === "payables" ? (
        <PayablesView />
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
      {loading ? <Skeleton count={3} /> : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="dash-card-head">
        <h3 className="side-heading">Customer &amp; Supplier Directory</h3>
        <span className="badge">{rows.length}</span>
      </div>

      {rows.length === 0 ? (
        <EmptyState>No shops yet — add one below.</EmptyState>
      ) : (
        <ul className="budget-list">
          {rows.map((s) => (
            <li key={s.id} className="budget-row">
              {editingId === s.id ? (
                <>
                  <input
                    className="input"
                    aria-label="Shop name"
                    value={editDraft.name}
                    onChange={(e) =>
                      setEditDraft({ ...editDraft, name: e.target.value })
                    }
                  />
                  <input
                    className="input"
                    aria-label="Shop phone"
                    placeholder="Phone"
                    value={editDraft.phone}
                    onChange={(e) =>
                      setEditDraft({ ...editDraft, phone: e.target.value })
                    }
                  />
                  <input
                    className="input"
                    aria-label="Shop address"
                    placeholder="Address"
                    value={editDraft.address}
                    onChange={(e) =>
                      setEditDraft({ ...editDraft, address: e.target.value })
                    }
                  />
                  <input
                    className="input"
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
                  <div className="row-main">
                    <span className="row-title">
                      <b>{s.name}</b>
                      {s.phone ? <span className="chip">{s.phone}</span> : null}
                    </span>
                    {s.address || s.notes ? (
                      <span className="row-sub">
                        {s.address}
                        {s.address && s.notes ? " — " : ""}
                        {s.notes}
                      </span>
                    ) : null}
                  </div>
                  <div className="row-end">
                    {s.remaining_cents > 0 ? (
                      <span className="badge badge-warn figure">
                        owes {formatMMK(s.remaining_cents)}
                      </span>
                    ) : null}
                    <span className="row-actions">
                      {s.id !== 0 ? (
                        <>
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
                        </>
                      ) : null}
                    </span>
                  </div>
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
        <div className="form-grid">
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
              placeholder="Street / township"
              onChange={(e) => setDraft({ ...draft, address: e.target.value })}
            />
          </label>
          <label>
            Notes (optional)
            <input
              value={draft.notes}
              placeholder="Customer or supplier note"
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />
          </label>
        </div>
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
      {loading ? <Skeleton count={3} /> : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="dash-card-head">
        <h3 className="side-heading">Open Jobs &amp; Work Orders</h3>
        <span className="badge">{jobs.length}</span>
      </div>

      {jobs.length === 0 ? (
        <EmptyState>No open jobs — create one below.</EmptyState>
      ) : (
        <ul className="budget-list">
          {jobs.map((j) => (
            <li key={j.id} className="limit-row">
              <div className="row-main">
                <span className="row-title">
                  <b>{j.title}</b>
                  <span className="chip">{shopName(j.shop_id)}</span>
                  {warrantyEndDate(j) !== null ? (
                    <span
                      className={
                        inWarranty(j, todayLocal())
                          ? "badge badge-success"
                          : "badge"
                      }
                    >
                      {inWarranty(j, todayLocal())
                        ? `warranty until ${warrantyEndDate(j)}`
                        : `warranty ended ${warrantyEndDate(j)}`}
                    </span>
                  ) : null}
                </span>
                <span className="row-sub figure">
                  Paid {formatMMK(j.paid_cents)} / {formatMMK(j.total_cents)} ·{" "}
                  <b className="amount-expense">
                    {formatMMK(j.remaining_cents)} left
                  </b>
                  {j.note ? ` — ${j.note}` : ""}
                </span>
              </div>
              <span className="row-actions">
                {payFor === j.id ? (
                  <>
                    <input
                      className="input"
                      aria-label={`Payment amount for ${j.title}`}
                      inputMode="decimal"
                      placeholder="0.00"
                      value={payAmount}
                      onChange={(e) => setPayAmount(e.target.value)}
                      aria-invalid={
                        payAmount.trim() !== "" && !isPartialAmount(payAmount)
                          ? "true"
                          : undefined
                      }
                    />
                    <select
                      className="select"
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
                      setPayAmount(fromCents(j.remaining_cents).toFixed(2));
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
        <div className="form-grid">
          <label>
            Title
            <input
              value={title}
              placeholder="e.g. Fix inverter board"
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
            Total amount
            <span className="input-affix">
              <input
                inputMode="decimal"
                placeholder="0.00"
                value={amountRaw}
                onChange={(e) => setAmountRaw(e.target.value)}
                aria-invalid={
                  amountRaw.trim() !== "" && !isPartialAmount(amountRaw)
                    ? "true"
                    : undefined
                }
              />
              <span className="input-affix-prefix">MMK</span>
            </span>
          </label>
          <label>
            Job date
            <span className="input-icon-wrap">
              <input
                type="date"
                aria-label="Job date"
                value={jobDate}
                onChange={(e) => setJobDate(e.target.value)}
              />
              <IconCalendar className="icon input-icon is-end" />
            </span>
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
            <input
              value={note}
              placeholder="Serial or repair note"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        </div>
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

  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [voucherError, setVoucherError] = useState<string | null>(null);

  const copyVoucher = async (shopId: number) => {
    try {
      const text = await businessRepo.voucherText(shopId);
      await navigator.clipboard.writeText(text);
      setCopiedId(shopId);
      setVoucherError(null);
    } catch (e) {
      setVoucherError(errText(e));
    }
  };

  const total = rows.reduce((s, r) => s + r.remaining_cents, 0);

  return (
    <section className="budget-manage" aria-label="Receivable by customer">
      {loading ? <Skeleton count={3} /> : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}
      {voucherError ? (
        <p className="limit-warn" role="status">
          Could not copy voucher: {voucherError}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState>Nothing outstanding — no receivables.</EmptyState>
      ) : (
        <>
          <div className="summary-figures">
            <div>
              <span className="muted">Total outstanding</span>
              <span className="figure amount-expense">{formatMMK(total)}</span>
            </div>
            <div>
              <span className="muted">Customers owing</span>
              <span className="figure">{rows.length}</span>
            </div>
          </div>
          <ul className="budget-list">
            {rows.map((r) => (
              <li key={r.id} className="budget-row">
                <div className="row-main">
                  <span className="row-title">
                    <b>{r.name}</b>
                  </span>
                </div>
                <div className="row-end">
                  <span className="figure amount-expense">
                    {formatMMK(r.remaining_cents)}
                  </span>
                  <span className="row-actions">
                    {r.id !== 0 ? (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void copyVoucher(r.id)}
                      >
                        {copiedId === r.id ? "Copied ✓" : "Copy voucher"}
                      </button>
                    ) : null}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <p className="muted">
            Record partial payments from the Jobs view; a job joins History (and
            books Business income) when fully paid.
          </p>
        </>
      )}
    </section>
  );
}

/** Paid/closed jobs — read-only History (§2.2). */
function HistoryView() {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [shops, setShops] = useState<ShopRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [js, ss] = await Promise.all([
          businessRepo.listHistory(),
          businessRepo.listShops(),
        ]);
        if (cancelled) return;
        setJobs(js);
        setShops(ss);
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

  const shopName = (id: number | null): string =>
    shops.find((s) => s.id === id)?.name ?? "—";

  return (
    <section className="budget-manage" aria-label="Job history">
      {loading ? <Skeleton count={3} /> : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="dash-card-head">
        <h3 className="side-heading">Completed Jobs</h3>
        <span className="badge badge-success">{jobs.length}</span>
      </div>

      {jobs.length === 0 ? (
        <EmptyState>No completed jobs yet.</EmptyState>
      ) : (
        <ul className="budget-list">
          {jobs.map((j) => (
            <li key={j.id} className="budget-row">
              <div className="row-main">
                <span className="row-title">
                  <b>{j.title}</b>
                  <span className="chip">{shopName(j.shop_id)}</span>
                  <span className="badge figure">{j.job_date}</span>
                </span>
                {j.note ? <span className="row-sub">{j.note}</span> : null}
              </div>
              <span className="figure amount-income">
                {formatMMK(j.total_cents)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Payables we owe: list with due chips, mark paid -> expense entry (§2.2). */
function PayablesView() {
  const today = todayLocal();
  const [payables, setPayables] = useState<PayableRow[]>([]);
  const [shops, setShops] = useState<ShopRow[]>([]);
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [expenseCats, setExpenseCats] = useState<ExpenseCategoryRow[]>([]);
  const [showPaid, setShowPaid] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payFor, setPayFor] = useState<number | null>(null);
  const [payWallet, setPayWallet] = useState<number | "">("");
  const [payCategory, setPayCategory] = useState<number | "">("");

  const [title, setTitle] = useState("");
  const [amountRaw, setAmountRaw] = useState("");
  const [shopId, setShopId] = useState<number | "">("");
  const [dueDate, setDueDate] = useState("");
  const [note, setNote] = useState("");

  const reload = useCallback(async () => {
    try {
      const [ps, ss, ws, ec] = await Promise.all([
        businessRepo.listPayables(showPaid),
        businessRepo.listShops(),
        budgetRepo.listWallets(),
        budgetRepo.listExpenseCategories(),
      ]);
      setPayables(ps);
      setShops(ss);
      setWallets(ws);
      setExpenseCats(ec);
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [showPaid]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const shopName = (id: number | null): string =>
    shops.find((s) => s.id === id)?.name ?? "—";

  const amountCents = parseMMK(amountRaw);
  const titleOk = title.trim().length > 0;

  const addPayable = async () => {
    if (amountCents === null || amountCents <= 0 || !titleOk) return;
    try {
      await businessRepo.createPayable({
        title: title.trim(),
        amountCents,
        shopId: shopId === "" ? null : shopId,
        dueDate: dueDate === "" ? null : dueDate,
        note: note.trim(),
      });
      setTitle("");
      setAmountRaw("");
      setDueDate("");
      setNote("");
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  const pay = async (payableId: number) => {
    if (typeof payWallet !== "number" || typeof payCategory !== "number")
      return;
    try {
      await businessRepo.markPayablePaid({
        payableId,
        walletId: payWallet,
        categoryId: payCategory,
        date: today,
      });
      setPayFor(null);
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <section className="budget-manage" aria-label="Payables">
      {loading ? <Skeleton count={3} /> : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="dash-card-head">
        <h3 className="side-heading">Supplier Payables</h3>
        <label className="check-label">
          <input
            type="checkbox"
            checked={showPaid}
            onChange={(e) => setShowPaid(e.target.checked)}
          />{" "}
          Show paid
        </label>
      </div>

      {payables.length === 0 ? (
        <EmptyState>No payables — add one below.</EmptyState>
      ) : (
        <ul className="budget-list">
          {payables.map((p) => {
            const status =
              p.paid === 1 ? "none" : payableDueStatus(p.due_date, today);
            return (
              <li key={p.id} className="limit-row">
                <div className="row-main">
                  <span className="row-title">
                    <b>{p.title}</b>
                    <span className="chip">{shopName(p.shop_id)}</span>
                    {p.paid === 1 ? <span className="badge">Paid</span> : null}
                    {status === "overdue" ? (
                      <span className="badge badge-danger" role="status">
                        Overdue
                      </span>
                    ) : status === "due" ? (
                      <span className="badge badge-warn" role="status">
                        Due today
                      </span>
                    ) : null}
                  </span>
                  <span className="row-sub">
                    {p.due_date ? `due ${p.due_date}` : "No due date"}
                    {p.note ? ` — ${p.note}` : ""}
                  </span>
                </div>
                <div className="row-end">
                  <span className="figure amount-expense">
                    {formatMMK(p.amount_cents)}
                  </span>
                  {p.paid === 0 ? (
                    <span className="row-actions">
                      {payFor === p.id ? (
                        <>
                          <select
                            className="select"
                            aria-label="Expense category"
                            value={
                              payCategory === "" ? "" : String(payCategory)
                            }
                            onChange={(e) =>
                              setPayCategory(
                                e.target.value === ""
                                  ? ""
                                  : Number(e.target.value),
                              )
                            }
                          >
                            <option value="">Category…</option>
                            {expenseCats.map((c) => (
                              <option key={c.id} value={String(c.id)}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                          <select
                            className="select"
                            aria-label="Paid from wallet"
                            value={payWallet === "" ? "" : String(payWallet)}
                            onChange={(e) =>
                              setPayWallet(
                                e.target.value === ""
                                  ? ""
                                  : Number(e.target.value),
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
                            disabled={payCategory === "" || payWallet === ""}
                            onClick={() => void pay(p.id)}
                          >
                            Confirm paid
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
                            setPayFor(p.id);
                            setPayCategory("");
                            setPayWallet("");
                          }}
                        >
                          Mark paid
                        </button>
                      )}
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <form
        className="entry-form"
        onSubmit={(e) => {
          e.preventDefault();
          void addPayable();
        }}
      >
        <h2 className="side-heading">New payable</h2>
        <div className="form-grid">
          <label>
            Title
            <input
              value={title}
              placeholder="e.g. Parts supplier"
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            Amount
            <span className="input-affix">
              <input
                inputMode="decimal"
                placeholder="0.00"
                value={amountRaw}
                onChange={(e) => setAmountRaw(e.target.value)}
                aria-invalid={
                  amountRaw.trim() !== "" && !isPartialAmount(amountRaw)
                    ? "true"
                    : undefined
                }
              />
              <span className="input-affix-prefix">MMK</span>
            </span>
          </label>
          <label>
            Supplier shop (optional)
            <select
              aria-label="Supplier shop"
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
            Due date (optional)
            <span className="input-icon-wrap">
              <input
                type="date"
                aria-label="Due date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
              <IconCalendar className="icon input-icon is-end" />
            </span>
          </label>
        </div>
        <label>
          Note (optional)
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="row-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!titleOk || amountCents === null || amountCents <= 0}
          >
            Add payable
          </button>
        </div>
      </form>
    </section>
  );
}
