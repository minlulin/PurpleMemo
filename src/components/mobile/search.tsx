import { useEffect, useState } from "react";
import { searchMobileWorkspace } from "../../data/app.ts";
import type { SearchGroup } from "../../lib/globalSearch.ts";
import { SEARCH_DEBOUNCE_MS } from "../../lib/searchContract.ts";
import { useT } from "../useTranslation.ts";

/** Search scoped to the two entities the phone may see. */
export function MobileSearch() {
  const t = useT();
  const [term, setTerm] = useState("");
  const [groups, setGroups] = useState<SearchGroup[]>([]);

  useEffect(() => {
    const input = term.trim();
    if (input === "") {
      setGroups([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchMobileWorkspace(input)
        .then((found) => {
          if (!cancelled) setGroups(found);
        })
        .catch(() => {
          if (!cancelled) setGroups([]);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term]);

  const results = groups.flatMap((group) => group.results);

  return (
    <div className="mobile-quick">
      <label className="mobile-quick-label" htmlFor="mobile-search">
        {t("mobile.searchLabel")}
      </label>
      <input
        id="mobile-search"
        className="input"
        type="search"
        value={term}
        placeholder={t("mobile.searchPlaceholder")}
        onChange={(event) => setTerm(event.currentTarget.value)}
      />
      {term.trim() === "" ? (
        <p className="muted">{t("mobile.searchHint")}</p>
      ) : results.length === 0 ? (
        <p className="muted">{t("mobile.searchNoResults")}</p>
      ) : (
        <ul className="mobile-list" aria-label={t("mobile.searchResultsAria")}>
          {results.map((result) => (
            <li key={`${result.type}-${result.id}`} className="mobile-card">
              <p className="mobile-card-title">{result.title}</p>
              {result.excerpt !== null ? (
                <p className="mobile-card-body">{result.excerpt}</p>
              ) : null}
              <p className="mobile-card-meta">
                {t(
                  result.type === "task"
                    ? "search.type.task"
                    : "search.type.note",
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
