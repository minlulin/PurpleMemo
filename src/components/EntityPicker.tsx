// Choosing what to relate something to.
//
// A dialog with a search box and a capped list. The rules live in
// `lib/entityPicker.ts` and are tested there; this is only the presentation.
//
// Keyboard: the search box keeps focus, Up/Down move the active row, Enter
// links it, Escape closes. That is the combobox pattern — focus in the field,
// `aria-activedescendant` pointing at the active option — so a screen reader
// reads the highlighted row as the user arrows through.

import { useEffect, useMemo, useRef, useState } from "react";
import { contactsRepo, notesRepo, tasksRepo } from "../data/app.ts";
import {
  type PickerHit,
  type PickerSource,
  pickerResults,
} from "../lib/entityPicker.ts";
import { errText } from "../lib/errors.ts";
import type {
  ContactRow,
  LinkableEntity,
  NoteRow,
  TaskRow,
} from "../lib/types.ts";
import { Dialog } from "./Dialog.tsx";
import { IconSpinner } from "./icons.tsx";
import { useT } from "./useTranslation.ts";

interface EntityPickerProps {
  /** The entity the relationship starts from; never offered. */
  from: LinkableEntity;
  alreadyLinked: LinkableEntity[];
  onPick: (entity: LinkableEntity) => Promise<void> | void;
  onClose: () => void;
}

export function EntityPicker(p: EntityPickerProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLUListElement | null>(null);

  // Loaded when the picker opens, not before: a page that never offers a link
  // never pays for three full table reads. Archived notes and completed tasks
  // are fetched too — the checkbox filters what is SHOWN, and a row that is
  // only loaded when the box is ticked would need a second round trip.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [noteRows, taskRows, contactRows] = await Promise.all([
          notesRepo.listNotes({ includeArchived: true }),
          tasksRepo.listTasks(true),
          contactsRepo.listContacts(),
        ]);
        if (cancelled) return;
        setNotes(noteRows);
        setTasks(taskRows);
        setContacts(contactRows);
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

  const source: PickerSource = useMemo(
    () => ({ notes, tasks, contacts, alreadyLinked: p.alreadyLinked }),
    [notes, tasks, contacts, p.alreadyLinked],
  );
  const result = useMemo(
    () => pickerResults(source, { from: p.from, query, includeInactive }),
    [source, p.from, query, includeInactive],
  );
  const hits = result.hits;

  // A shorter list must not leave the highlight pointing past its end.
  useEffect(() => {
    setActive((current) => (current < hits.length ? current : 0));
  }, [hits.length]);

  useEffect(() => {
    const activeEl = listRef.current?.children[active];
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = async (hit: PickerHit | undefined) => {
    if (!hit || busy) return;
    setBusy(true);
    setError(null);
    try {
      await p.onPick(hit.entity);
      p.onClose();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  return (
    <Dialog labelledBy="link-picker-title" onClose={p.onClose}>
      <div className="modal-head">
        <h2 className="side-heading" id="link-picker-title">
          Link to
        </h2>
        <button
          type="button"
          className="btn btn-icon"
          aria-label={t("linkPicker.close")}
          title={t("common.close")}
          // biome-ignore lint/a11y/noAutofocus: the dialog's first stop
          autoFocus
          onClick={p.onClose}
        >
          ×
        </button>
      </div>
      <div className="entry-form">
        <label>
          {t("linkPicker.searchLabel")}
          <input
            className="input"
            type="search"
            aria-label={t("linkPicker.searchAria")}
            aria-controls="link-picker-list"
            aria-activedescendant={
              hits[active] === undefined
                ? undefined
                : `link-option-${hits[active].entity.type}-${hits[active].entity.id}`
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((n) => Math.min(n + 1, hits.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((n) => Math.max(n - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                void choose(hits[active]);
              }
            }}
          />
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />{" "}
          {t("linkPicker.includeInactive")}
        </label>
        {error ? (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        ) : null}
        {loading ? (
          <SkeletonRows />
        ) : hits.length === 0 ? (
          <p className="muted">{t("linkPicker.empty")}</p>
        ) : (
          <>
            <ul
              className="budget-list"
              id="link-picker-list"
              aria-label={t("linkPicker.listAria")}
              ref={listRef}
            >
              {hits.map((hit, index) => (
                <li
                  key={`${hit.entity.type}-${hit.entity.id}`}
                  className="budget-row"
                >
                  {/* The option IS the button: `role="option"` on a focusable
                      element keeps the listbox pattern valid for both keyboard
                      and screen-reader users, and keeps `aria-selected`
                      meaningful. */}
                  <button
                    type="button"
                    role="option"
                    id={`link-option-${hit.entity.type}-${hit.entity.id}`}
                    aria-selected={index === active}
                    className={`btn btn-ghost${index === active ? " is-on" : ""}`}
                    disabled={busy}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => void choose(hit)}
                  >
                    {t(
                      hit.entity.type === "note"
                        ? "search.type.note"
                        : hit.entity.type === "task"
                          ? "search.type.task"
                          : "search.type.contact",
                    )}{" "}
                    · {hit.label}
                    {hit.state === null ? "" : ` (${hit.state})`}
                  </button>
                  {hit.detail === null ? null : (
                    <span className="row-sub">{hit.detail}</span>
                  )}
                </li>
              ))}
            </ul>
            {result.capped ? (
              <p className="limit-warn" role="status">
                {t("linkPicker.capped", {
                  shown: hits.length,
                  matched: result.matched,
                })}
              </p>
            ) : null}
          </>
        )}
        {busy ? (
          <p className="muted" role="status">
            <IconSpinner className="icon" /> {t("linkPicker.linking")}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function SkeletonRows() {
  const t = useT();
  return (
    <p className="muted" role="status">
      <IconSpinner className="icon" /> {t("linkPicker.loading")}
    </p>
  );
}
