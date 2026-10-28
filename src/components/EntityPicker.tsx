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
  /** Synchronous re-entry guard for `choose` — declared with its use (G3). */
  const choosingRef = useRef(false);

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

  // The listbox is rendered only when it has options to own; `aria-expanded`
  // and `aria-controls` track exactly that condition, so the combobox never
  // claims a listbox that is not in the DOM (G2) — during loading, on a
  // zero-match query, or after a load error.
  const listOpen = !loading && hits.length > 0;

  // A shorter list must not leave the highlight pointing past its end — and
  // `active` is never allowed to go negative (G2): ArrowDown while the list
  // was empty or loading evaluated `Math.min(1, hits.length - 1) = -1`, which
  // this effect then KEPT (`-1 < hits.length` is true), leaving the picker
  // with no active row even after matches appeared — Enter silently no-op.
  useEffect(() => {
    setActive((current) =>
      current >= 0 && current < hits.length ? current : 0,
    );
  }, [hits.length]);

  useEffect(() => {
    const activeEl = listRef.current?.children[active];
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = async (hit: PickerHit | undefined) => {
    if (!hit) return;
    // The synchronous submit guard (G3): `busy` is React state and does not
    // commit until after the current task, so a fast double-Enter (or a
    // double-click before the first commit) invoked `onPick` twice — and
    // across the `LinksSection.link` seam its OWN ref guard made the second
    // call resolve instantly, so `p.onClose()` ran while the first call's
    // `createLink` write was still in flight: the picker unmounted early and
    // a rejection was dropped with no error shown anywhere. A ref is read and
    // written synchronously, so the second press is refused before any work
    // starts.
    if (choosingRef.current) return;
    choosingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await p.onPick(hit.entity);
      // The one close a locked dialog still allows (see `<Dialog locked>`):
      // success means "finished", not "abandoned".
      p.onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      choosingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog labelledBy="link-picker-title" onClose={p.onClose} locked={busy}>
      <div className="modal-head">
        <h2 className="side-heading" id="link-picker-title">
          Link to
        </h2>
        <button
          type="button"
          className="btn btn-icon"
          aria-label={t("linkPicker.close")}
          title={t("common.close")}
          // No `autoFocus` (G2): it used to be the dialog's first stop, so
          // typing a query went nowhere and Enter CLOSED the picker instead
          // of linking the highlighted row. The search box owns focus now.
          // Disabled while linking (G3): an early dismissal would drop any
          // rejection the in-flight `onPick` still throws.
          disabled={busy}
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
            // The combobox owns focus from open (G2) — the documented
            // contract at the top of this file is "the search box keeps
            // focus", and this is the field the arrow keys drive.
            autoFocus
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={listOpen}
            aria-label={t("linkPicker.searchAria")}
            // Only while the listbox is actually rendered, so the reference
            // never dangles during loading or on a zero-match query (G2).
            aria-controls={listOpen ? "link-picker-list" : undefined}
            aria-activedescendant={
              !listOpen || hits[active] === undefined
                ? undefined
                : `link-option-${hits[active].entity.type}-${hits[active].entity.id}`
            }
            disabled={busy}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                // Nothing to move to on an empty list, and the arithmetic
                // would pin `active` at -1 (G2) — see the clamp effect above.
                if (hits.length === 0) return;
                setActive((n) => Math.min(n + 1, hits.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                if (hits.length === 0) return;
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
            disabled={busy}
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
              // The listbox role belongs here (G2): the option buttons
              // declare `role="option"` and need an owning `listbox` to be
              // valid — without it assistive tech saw orphaned options.
              // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ARIA in HTML permits role=listbox on <ul>; the options own to it
              role="listbox"
              aria-label={t("linkPicker.listAria")}
              ref={listRef}
            >
              {hits.map((hit, index) => (
                <li
                  key={`${hit.entity.type}-${hit.entity.id}`}
                  className="budget-row"
                  // `role="listbox"` may own options (or groups) only; the
                  // `li` here is layout around the option, not semantics (G2).
                  role="presentation"
                >
                  {/* The option IS the button: `role="option"` on a focusable
                      element keeps the listbox pattern valid for both keyboard
                      and screen-reader users, and keeps `aria-selected`
                      meaningful. `tabIndex={-1}` keeps it OUT of the Tab ring
                      (G2): selection belongs to the combobox's arrow keys,
                      and up to 50 option tab stops desynced DOM focus from
                      `active` — Tab highlighted row #k while
                      `aria-activedescendant` still pointed at #0. */}
                  <button
                    type="button"
                    role="option"
                    tabIndex={-1}
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
