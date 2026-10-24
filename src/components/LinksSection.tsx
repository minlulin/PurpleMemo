// The relationships of one entity.
//
// Rendered identically on the note, task and contact pages — the whole point of
// a relationship is that it is mutual, so it must not look like three features.
//
// Two rules this component keeps:
//   - a row that no longer exists is SHOWN as unavailable, not hidden: the
//     relationship is still stored, and silently dropping it would look like the
//     user's link had evaporated;
//   - unlinking never deletes anything. The button says Unlink, and only the
//     relationship goes.

import { useCallback, useEffect, useRef, useState } from "react";
import { entityLinksRepo } from "../data/app.ts";
import { errText } from "../lib/errors.ts";
import type { MessageKey } from "../lib/i18n.ts";
import type { LinkableEntity, RelatedItem } from "../lib/types.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { EntityPicker } from "./EntityPicker.tsx";
import { IconSpinner } from "./icons.tsx";
import { useT } from "./useTranslation.ts";

interface LinksSectionProps {
  entity: LinkableEntity;
  /** Handed up to the page, which hands it to the shell — the shell navigates. */
  onOpenEntity: (entity: LinkableEntity) => void;
}

const TYPE_LABELS = {
  note: "search.type.note",
  task: "search.type.task",
  contact: "search.type.contact",
} as const satisfies Record<LinkableEntity["type"], MessageKey>;

export function LinksSection(p: LinksSectionProps) {
  const t = useT();
  const [items, setItems] = useState<RelatedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  /** In-flight guards, so a double-click cannot link or unlink twice. */
  const busyRef = useRef(false);

  const reload = useCallback(async () => {
    try {
      setItems(await entityLinksRepo.listRelated(p.entity));
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [p.entity]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  /** Unlink. Never touches the entity at either end. */
  const unlink = async (item: RelatedItem) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await entityLinksRepo.removeLink(p.entity, item.entity);
      await reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  /** Link. A second click is refused here and is a no-op in the database. */
  const link = async (target: LinkableEntity) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await entityLinksRepo.createLink(p.entity, target);
      if (result.alreadyLinked) {
        setError(t("links.alreadyLinked"));
      }
      await reload();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <section className="settings-section" aria-label={t("links.relatedAria")}>
      <div className="dash-card-head">
        <h3 className="settings-heading">{t("links.related")}</h3>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || loading}
          onClick={() => setPicking(true)}
        >
          {t("links.linkTo")}
        </button>
      </div>
      {loading ? (
        <p className="muted" role="status">
          <IconSpinner className="icon" /> {t("links.loading")}
        </p>
      ) : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}
      {!loading && items.length === 0 ? (
        <p className="muted">{t("links.empty")}</p>
      ) : null}
      {items.length > 0 ? (
        <ul className="budget-list">
          {items.map((item) => (
            <li
              key={`${item.entity.type}-${item.entity.id}`}
              className="budget-row"
            >
              <div className="row-main">
                <span className="row-title">
                  {item.gone ? (
                    <span className="muted">
                      {t("links.unavailable", {
                        type: t(TYPE_LABELS[item.entity.type]),
                      })}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => p.onOpenEntity(item.entity)}
                    >
                      {t(TYPE_LABELS[item.entity.type])} · {item.label}
                    </button>
                  )}
                </span>
                {item.detail === null ? null : (
                  <span className="row-sub">{item.detail}</span>
                )}
              </div>
              <span className="row-actions">
                <ConfirmButton
                  className="btn btn-ghost"
                  what={t("links.unlinkWhat")}
                  onConfirm={() => unlink(item)}
                  disabled={busy}
                >
                  {t("links.unlink")}
                </ConfirmButton>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {picking ? (
        <EntityPicker
          from={p.entity}
          alreadyLinked={items.map((item) => item.entity)}
          onPick={link}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </section>
  );
}
