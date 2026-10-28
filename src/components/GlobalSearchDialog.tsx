import { useEffect, useRef, useState } from "react";
import { searchWorkspace } from "../data/app.ts";
import { errText } from "../lib/errors.ts";
import { formatBirthday, formatDate } from "../lib/format.ts";
import {
  resultCount,
  type SearchGroup,
  type SearchResult,
  type TotalCapReport,
} from "../lib/globalSearch.ts";
import type { MessageKey } from "../lib/i18n.ts";
import {
  isSearchable,
  SEARCH_CONTRACT,
  SEARCH_DEBOUNCE_MS,
  SEARCH_TOTAL_CAP,
  type SearchEntitySpec,
} from "../lib/searchContract.ts";
import { Dialog } from "./Dialog.tsx";
import { IconClose, IconSearch } from "./icons.tsx";
import { useLocale, usePlural, useT } from "./useTranslation.ts";

type SearchType = SearchEntitySpec["type"];

/** Contract types read as full nouns, not as the sidebar's section names. */
const SEARCH_TYPE_LABELS: Record<SearchType, MessageKey> = {
  note: "search.type.note",
  task: "search.type.task",
  contact: "search.type.contact",
  journal: "search.type.journal",
  memory: "search.type.memory",
  job: "search.type.job",
  payable: "search.type.payable",
  loan: "search.type.loan",
  shopping_item: "search.type.shoppingItem",
};

interface GlobalSearchDialogProps {
  onClose: () => void;
  onOpen: (result: SearchResult) => void;
}

export function GlobalSearchDialog({
  onClose,
  onOpen,
}: GlobalSearchDialogProps) {
  const t = useT();
  const plural = usePlural();
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const [type, setType] = useState<SearchType | "all">("all");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether the total cap hid matches — a sliced trailing group or a wholly
  // dropped group (DECISION 1a). Reported beside the return value via
  // `TotalCapReport`, not derived from the groups: after the cap, trimmed and
  // naturally-small groups are indistinguishable, and a dropped group leaves
  // no trace at all.
  const [totalCapped, setTotalCapped] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const results = groups.flatMap((group) => group.results);
  const count = resultCount(groups);

  useEffect(() => {
    const term = query.trim();
    // A punctuation-only query is not searchable (G9): `globalSearch` would
    // return `[]` without touching the DB, but the UI still flashed
    // "Searching…" then "0 results". Stay in the idle state instead.
    if (term.length === 0 || !isSearchable(term)) {
      setGroups([]);
      setLoading(false);
      setError(null);
      setTotalCapped(false);
      setActiveIndex(0);
      return;
    }

    let cancelled = false;
    setGroups([]);
    setActiveIndex(0);
    setError(null);
    setTotalCapped(false);
    setLoading(true);
    // A reversed From/Through range matches nothing by definition and used to
    // ship impossible bounds (`col >= since AND col <= until` with since after
    // until) straight to SQL, reporting a silent "0 results" (G9). Treat it as
    // an empty query instead of a search that was destined to fail, so the UI
    // stays in its idle state rather than flashing a bogus "No matches."
    if (since && until && since > until) {
      setLoading(false);
      return;
    }
    const timer = window.setTimeout(() => {
      // Filled by `applyTotalCap` before the promise resolves (DECISION 1a).
      const totalCapReport: TotalCapReport = { truncated: false };
      void searchWorkspace(term, {
        types: type === "all" ? undefined : [type],
        since: since || undefined,
        until: until || undefined,
        includeInactive,
        totalCapReport,
      })
        .then((next) => {
          if (cancelled) return;
          setGroups(next);
          setTotalCapped(totalCapReport.truncated);
          setActiveIndex(0);
          setError(null);
        })
        .catch((reason: unknown) => {
          if (cancelled) return;
          setGroups([]);
          setTotalCapped(false);
          setError(errText(reason));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, type, since, until, includeInactive]);

  useEffect(() => {
    if (results.length === 0) return;
    document
      .getElementById(`global-search-result-${activeIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, results.length]);

  const moveSelection = (direction: -1 | 1) => {
    if (results.length === 0) return;
    setActiveIndex(
      (index) => (index + direction + results.length) % results.length,
    );
  };

  const selectActive = () => {
    const selected = results[activeIndex];
    if (selected) onOpen(selected);
  };

  return (
    <Dialog
      labelledBy="global-search-title"
      className="global-search-modal"
      onClose={onClose}
    >
      <div className="modal-head">
        <h2 className="side-heading" id="global-search-title">
          <IconSearch className="icon" /> {t("search.title")}
        </h2>
        <button
          type="button"
          className="btn btn-icon"
          aria-label={t("search.close")}
          title={t("common.close")}
          onClick={onClose}
        >
          <IconClose className="icon" />
        </button>
      </div>

      <label className="global-search-input-wrap">
        <span className="visually-hidden">{t("search.contentAria")}</span>
        <IconSearch className="icon" />
        <input
          ref={inputRef}
          className="input"
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={results.length > 0}
          value={query}
          placeholder={t("search.placeholder")}
          // Only while the listbox is rendered (G7), so the reference never
          // dangles on an empty query or a zero-match search.
          aria-controls={
            results.length > 0 ? "global-search-results" : undefined
          }
          aria-activedescendant={
            results.length > 0
              ? `global-search-result-${activeIndex}`
              : undefined
          }
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveSelection(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              moveSelection(-1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              selectActive();
            }
          }}
        />
      </label>

      <fieldset className="global-search-filters">
        <legend className="visually-hidden">{t("search.filters")}</legend>
        <label>
          {t("search.type")}
          <select
            className="select"
            value={type}
            onChange={(event) =>
              setType(event.target.value as SearchType | "all")
            }
          >
            <option value="all">{t("search.allTypes")}</option>
            {SEARCH_CONTRACT.map((spec) => (
              <option key={spec.type} value={spec.type}>
                {t(SEARCH_TYPE_LABELS[spec.type])}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("search.from")}
          <input
            className="input"
            type="date"
            value={since}
            onChange={(event) => setSince(event.target.value)}
          />
        </label>
        <label>
          {t("search.through")}
          <input
            className="input"
            type="date"
            value={until}
            onChange={(event) => setUntil(event.target.value)}
          />
        </label>
        <label className="global-search-inactive">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(event) => setIncludeInactive(event.target.checked)}
          />
          {t("search.includeInactive")}
        </label>
      </fieldset>

      <div className="global-search-status" aria-live="polite">
        {loading
          ? t("search.searching")
          : isSearchable(query) && !error
            ? plural("search.results", count)
            : ""}
      </div>
      {error ? (
        <p className="alert alert-error" role="alert">
          {t("search.failed", { error })}
        </p>
      ) : null}
      {/* Rendered only when it has options to own (G7): an empty listbox is
          invalid ARIA, and the zero-match sentence belongs OUTSIDE it — a `<p>`
          is not an `option` and several screen readers announce non-option
          content inside `role="listbox"` as part of the list. */}
      {results.length > 0 ? (
        <div
          className="global-search-results"
          id="global-search-results"
          role="listbox"
          aria-label={t("search.resultsAria")}
        >
          {groups.map((group) => {
            const headingId = `global-search-group-${group.type}`;
            return (
              // `role="group"` is what a listbox may own alongside its
              // options (G7): it labels the options grouped under it.
              // `<fieldset>`+`<legend>` — biome's suggested alternative —
              // is invalid ownership inside `role="listbox"`: the legend is
              // not an option, so assistive tech read the group names as
              // orphaned content instead of labelling the options.
              // biome-ignore lint/a11y/useSemanticElements: a fieldset here is precisely the G7 bug — noNoninteractiveElementToInteractiveRole rejects that alternative inside a listbox
              <div
                className="global-search-group"
                role="group"
                aria-labelledby={headingId}
                key={group.type}
              >
                <span className="global-search-group-legend" id={headingId}>
                  {t(SEARCH_TYPE_LABELS[group.type])}
                  {group.capped ? t("search.moreAvailable") : ""}
                </span>
                {group.results.map((result) => {
                  const index = results.indexOf(result);
                  // Contact birthdays may be stored as a yearless `MM-DD`
                  // (G8/G9), which `formatDate` would render raw — so that one
                  // group goes through the birthday-aware formatter.
                  const shownDate =
                    result.date === null
                      ? undefined
                      : result.type === "contact"
                        ? formatBirthday(locale, result.date)
                        : formatDate(locale, result.date);
                  const details = [result.state, shownDate]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <button
                      type="button"
                      role="option"
                      // Out of the Tab ring (G7): selection belongs to the
                      // combobox's arrow keys, and up to 40 option tab stops
                      // desynced DOM focus from `activeIndex` — Tab landed on
                      // row #k while `aria-activedescendant` still pointed at
                      // #0, and Enter activated a different row than the
                      // highlight.
                      tabIndex={-1}
                      aria-selected={index === activeIndex}
                      className={
                        index === activeIndex
                          ? "global-search-result is-active"
                          : "global-search-result"
                      }
                      id={`global-search-result-${index}`}
                      key={`${group.type}-${result.id ?? result.dateKey}`}
                      onMouseMove={() => setActiveIndex(index)}
                      onClick={() => onOpen(result)}
                    >
                      <span className="global-search-result-main">
                        <strong>{result.title}</strong>
                        {result.excerpt ? <span>{result.excerpt}</span> : null}
                      </span>
                      {details ? (
                        <span className="global-search-result-meta">
                          {details}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      ) : null}
      {!loading && !error && isSearchable(query) && count === 0 ? (
        <p className="muted">{t("search.noMatches")}</p>
      ) : null}
      {/* DECISION 1a: the per-group " · more available" marker only covers a
          group over its own cap — nothing said so when the TOTAL cap sliced a
          trailing group or dropped whole groups. Mutually exclusive with the
          "no matches" note above: a capped search always shows results. */}
      {!loading && !error && totalCapped ? (
        <p className="muted">
          {t("search.totalCapped", { cap: SEARCH_TOTAL_CAP })}
        </p>
      ) : null}
    </Dialog>
  );
}
