import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { IconSpinner, IconTrash } from "../components/icons.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { useToast } from "../components/Toast.tsx";
import { useLocale, useT } from "../components/useTranslation.ts";
import { trashRepo } from "../data/app.ts";
import { errText } from "../lib/errors.ts";
import { formatDateTime, formatNumber } from "../lib/format.ts";
import type { MessageKey } from "../lib/i18n.ts";
import {
  TRASH_MAX_ITEMS,
  TRASH_RETENTION_DAYS,
  type TrashListItem,
} from "../lib/trash.ts";

const TYPE_LABELS: Record<TrashListItem["entity_type"], MessageKey> = {
  note: "trash.type.note",
  task: "trash.type.task",
  contact: "trash.type.contact",
  memory: "trash.type.memory",
  journal_entry: "trash.type.journalEntry",
};

export default function TrashPage() {
  const toast = useToast();
  const t = useT();
  const locale = useLocale();
  const [items, setItems] = useState<TrashListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const reload = useCallback(async () => {
    try {
      setItems(await trashRepo.list());
      setError(null);
    } catch (cause) {
      setError(errText(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (
    id: number,
    action: () => Promise<void>,
    message: string,
  ) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyId(id);
    setError(null);
    try {
      await action();
      await reload();
      toast.success(message);
    } catch (cause) {
      const message = errText(cause);
      setError(message);
      toast.error(message);
    } finally {
      busyRef.current = false;
      setBusyId(null);
    }
  };

  const permanentlyDelete = (id: number) =>
    run(
      id,
      () => trashRepo.removePermanently(id),
      t("trash.permanentlyDeleted"),
    );

  return (
    <div className="budget-page">
      <header className="page-header">
        <div className="page-header-main">
          <div className="page-title-row">
            <span className="page-icon-badge">
              <IconTrash className="icon" />
            </span>
            <div>
              <h2 className="editor-title">{t("trash.title")}</h2>
              <p className="page-subtitle">
                {t("trash.subtitle", {
                  days: TRASH_RETENTION_DAYS,
                  max: formatNumber(locale, TRASH_MAX_ITEMS),
                })}
              </p>
            </div>
          </div>
        </div>
      </header>

      <p className="muted">{t("trash.notice")}</p>
      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <div className="dashboard-grid">
          <Skeleton variant="card" />
          <Skeleton variant="card" />
        </div>
      ) : items.length === 0 ? (
        <section className="settings-section">
          <EmptyState>{t("trash.empty")}</EmptyState>
        </section>
      ) : (
        <ul className="budget-list">
          {items.map((item) => (
            <li key={item.id} className="budget-row">
              <div className="row-main">
                <p className="row-title">{item.title}</p>
                <span className="row-sub">
                  {t("trash.deletedAt", {
                    type: t(TYPE_LABELS[item.entity_type]),
                    date: formatDateTime(locale, item.deleted_at),
                  })}
                </span>
              </div>
              <span className="row-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busyId !== null}
                  onClick={() =>
                    void run(
                      item.id,
                      () => trashRepo.restore(item.id),
                      t("trash.restored"),
                    )
                  }
                >
                  {busyId === item.id && <IconSpinner className="icon" />}
                  {t("trash.restore")}
                </button>
                <ConfirmButton
                  className="btn btn-ghost"
                  what={t("trash.deleteWhat")}
                  disabled={busyId !== null}
                  onConfirm={() => permanentlyDelete(item.id)}
                >
                  {t("trash.deletePermanently")}
                </ConfirmButton>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
