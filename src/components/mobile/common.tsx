// The pieces more than one phone screen uses: the reload-once loader
// (`useLoad`) and the shared failure line it renders.

import { useCallback, useEffect, useState } from "react";
import { useT } from "../useTranslation.ts";

/**
 * Loads a list once per mount and again after a reload.
 *
 * The reload counter is folded into the loader's identity rather than into the
 * effect's dependency list: that way the effect depends on ONE function whose
 * identity changes exactly when a re-read is wanted, and the counter is
 * genuinely used (a bare extra dependency is a lint error here).
 */
export function useLoad<T>(loader: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  const load = useCallback(() => {
    void version; // the counter is the reason this identity changes
    return loader();
  }, [loader, version]);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    load()
      .then((value) => {
        if (!cancelled) setData(value);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);
  return { data, failed, reload };
}

export function LoadMessage({ failed }: { failed: boolean }) {
  const t = useT();
  if (!failed) return null;
  return (
    <p className="mobile-error" role="alert">
      {t("mobile.loadFailed")}
    </p>
  );
}
