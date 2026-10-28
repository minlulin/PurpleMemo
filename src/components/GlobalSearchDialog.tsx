import { useEffect, useRef, useState } from "react";
import { searchWorkspace } from "../data/app.ts";
import { formatDate } from "../lib/format.ts";
import {
  resultCount,
  type SearchGroup,
  type SearchResult,
} from "../lib/globalSearch.ts";
import type { MessageKey } from "../lib/i18n.ts";
import {
  SEARCH_CONTRACT,
  SEARCH_DEBOUNCE_MS,
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
    if (term.length === 0) {
      setGroups([]);
      setLoading(false);
      setError(null);
      setActiveIndex(0);
      return;
    }

    let cancelled = false;
    setGroups([]);
    setActiveIndex(0);
    setError(null);
    setLoading(true);
    const timer = window.setTimeout(() => {
      void searchWorkspace(term, {
        types: type === "all" ? undefined : [type],
        since: since || undefined,
        until: until || undefined,
        includeInactive,
      })
        .then((next) => {
          if (cancelled) return;
          setGroups(next);
          setActiveIndex(0);
          setError(null);
        })
        .catch((reason: unknown) => {
          if (cancelled) return;
          setGroups([]);
          setError(reason instanceof Error ? reason.message : String(reason));
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
          : query.trim() && !error
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
                  const details = [
                    result.state,
                    result.date ? formatDate(locale, result.date) : undefined,
                  ]
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
      {!loading && !error && query.trim() && count === 0 ? (
        <p className="muted">{t("search.noMatches")}</p>
      ) : null}
    </Dialog>
  );
}
