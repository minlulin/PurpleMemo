// The phone's Business screen (jobs and shops) and the two create-only
// forms, one per kind.

import { useCallback, useState } from "react";
import { businessRepo } from "../../data/app.ts";
import { todayLocal } from "../../lib/dates.ts";
import { jobFormReady, shopFormReady } from "../../lib/mobileCreate.ts";
import { formatMMK, parseMMK } from "../../lib/money.ts";
import { EmptyState } from "../EmptyState.tsx";
import { useLocale, useT } from "../useTranslation.ts";
import { LoadMessage, useLoad } from "./common.tsx";

/**
 * The Business screen: the shop's jobs with shop, total and status.
 *
 * Create-only (decision 4): the only control here is "New job". There is no
 * amount-paid field and no mark-paid action anywhere on this surface — job
 * payments are recorded on the desktop, and a job created on the phone stays
 * open with its full total outstanding.
 */
export function BusinessScreen({
  onCompose,
}: {
  onCompose: (id: "job" | "shop") => void;
}) {
  const t = useT();
  const locale = useLocale();
  const load = useCallback(async () => {
    const [jobs, shops] = await Promise.all([
      businessRepo.listJobs(),
      businessRepo.listShops(),
    ]);
    return { jobs, shops };
  }, []);
  const { data, failed, reload } = useLoad(load);

  const jobs = data?.jobs ?? [];
  const shopNames = new Map(
    (data?.shops ?? []).map((shop) => [shop.id, shop.name]),
  );

  return (
    <section className="mobile-page">
      <p className="mobile-section-kicker">{t("nav.business")}</p>
      <div className="mobile-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onCompose("job")}
        >
          {t("mobile.job.new")}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => onCompose("shop")}
        >
          {t("mobile.shop.new")}
        </button>
      </div>
      <p className="muted">{t("mobile.job.noPayment")}</p>
      <LoadMessage failed={failed} />
      {data !== null && jobs.length === 0 ? (
        <EmptyState>{t("mobile.job.empty")}</EmptyState>
      ) : null}
      <ul className="mobile-list" aria-label={t("mobile.job.listAria")}>
        {jobs.map((job) => (
          <li key={job.id} className="mobile-card">
            <span className="mobile-wallet-line">
              <span className="mobile-card-title">{job.title}</span>
              <span className="mobile-card-title">
                {formatMMK(job.total_cents, locale)}
              </span>
            </span>
            <span className="mobile-card-meta">
              {job.shop_id === null
                ? t("mobile.job.noShop")
                : (shopNames.get(job.shop_id) ?? t("mobile.job.deletedShop"))}
              {" · "}
              {job.job_date}
              {" · "}
              {job.status === "open"
                ? t("mobile.job.statusOpen")
                : t("mobile.job.statusPaid")}
            </span>
            {job.status === "open" ? (
              <span className="mobile-card-meta">
                {t("mobile.job.outstanding", {
                  amount: formatMMK(job.total_cents - job.paid_cents, locale),
                })}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="mobile-link-btn"
        onClick={reload}
        hidden={!failed}
      >
        {t("common.tryAgain")}
      </button>
    </section>
  );
}

/**
 * The job create form, opened from the FAB speed-dial or the Business screen.
 * It has no payment field: a saved job is open, unpaid, and worth its total.
 */
export function JobCompose({ onDone }: { onDone: () => void }) {
  const t = useT();
  const load = useCallback(() => businessRepo.listShops(), []);
  const { data, failed } = useLoad(load);
  const [title, setTitle] = useState("");
  const [shopId, setShopId] = useState<number | null>(null);
  const [total, setTotal] = useState("");
  const [jobDate, setJobDate] = useState(() => todayLocal());
  const [busy, setBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const shops = data ?? [];
  const totalCents = parseMMK(total);
  const ready = jobFormReady({ title, totalCents });
  const amountProblem =
    total.trim() !== "" && (totalCents === null || totalCents <= 0);

  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setSaveFailed(false);
    try {
      await businessRepo.createJob({
        title: title.trim(),
        shopId,
        totalCents: totalCents ?? 0,
        jobDate: jobDate === "" ? todayLocal() : jobDate,
      });
      onDone();
    } catch {
      setSaveFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mobile-page">
      <p className="muted">{t("mobile.job.noPayment")}</p>
      <LoadMessage failed={failed} />
      <form
        className="mobile-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="mobile-field">
          <span>{t("mobile.job.titleLabel")}</span>
          <input
            className="input"
            type="text"
            value={title}
            placeholder={t("mobile.job.titlePlaceholder")}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
        </label>
        <label className="mobile-field">
          <span>{t("mobile.job.totalLabel")}</span>
          <input
            className="input"
            type="text"
            inputMode="decimal"
            value={total}
            placeholder={t("mobile.job.totalPlaceholder")}
            aria-invalid={amountProblem}
            onChange={(event) => setTotal(event.currentTarget.value)}
          />
        </label>
        {amountProblem ? (
          <p className="mobile-error" role="alert">
            {t("mobile.entry.invalidAmount")}
          </p>
        ) : null}
        <label className="mobile-field">
          <span>{t("mobile.job.shopLabel")}</span>
          <select
            className="input"
            value={String(shopId ?? "")}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setShopId(value === "" ? null : Number(value));
            }}
          >
            <option value="">{t("mobile.job.shopNone")}</option>
            {shops.map((shop) => (
              <option key={shop.id} value={shop.id}>
                {shop.name}
              </option>
            ))}
          </select>
        </label>
        <label className="mobile-field">
          <span>{t("mobile.job.dateLabel")}</span>
          <input
            className="input"
            type="date"
            value={jobDate}
            onChange={(event) => setJobDate(event.currentTarget.value)}
          />
        </label>
        <LoadMessage failed={saveFailed} />
        <div className="mobile-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !ready}
          >
            {busy ? t("notes.saving") : t("mobile.job.save")}
          </button>
        </div>
      </form>
    </section>
  );
}

/**
 * The shop create form (F-3), opened from the Business screen. A name is
 * the whole requirement — a new shop walking in is the quick-capture case,
 * and a job for it could not be recorded until the shop existed. Editing
 * and deleting shops stay on the desktop (create-only, §2.3).
 */
export function ShopCompose({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const ready = shopFormReady({ name });

  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setSaveFailed(false);
    try {
      await businessRepo.createShop({
        name: name.trim(),
        phone: phone.trim() === "" ? undefined : phone.trim(),
      });
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
          <span>{t("mobile.shop.nameLabel")}</span>
          <input
            className="input"
            type="text"
            value={name}
            placeholder={t("mobile.shop.namePlaceholder")}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label className="mobile-field">
          <span>{t("mobile.shop.phoneLabel")}</span>
          <input
            className="input"
            type="tel"
            value={phone}
            placeholder={t("mobile.shop.phonePlaceholder")}
            onChange={(event) => setPhone(event.currentTarget.value)}
          />
        </label>
        <LoadMessage failed={saveFailed} />
        <div className="mobile-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !ready}
          >
            {busy ? t("notes.saving") : t("mobile.shop.save")}
          </button>
        </div>
      </form>
    </section>
  );
}
