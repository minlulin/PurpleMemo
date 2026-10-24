// Terminal factory-reset screen.
//
// Once `factoryReset()` resolves OR throws, this screen replaces the whole
// workspace, the same way the boot and lock screens do — there is no path
// back into the app from here, because the engine has closed the database
// connection and every DB command fails closed from that moment. The shell
// holds the attempt in its top-level state (not in navigation state the user
// could reverse).
//
// The policy gate is `lib/reset.ts`, pure and unit-tested; this component is
// presentation plus exactly one action per branch:
//   - complete: true  → a single Restart button, behind `shouldRestart`;
//   - anything else   → the per-component report rendered verbatim, plus a
//     Retry reset that returns to the acknowledgement state (the engine is
//     re-runnable after a partial reset).
// A blocked reset NEVER restarts the app (owner decision): the only
// `appRestart()` call site in the UI sits inside the `done` branch below, and
// `src/reset-gate.test.ts` pins that from the source, since the gate is
// frontend-only by design.

import { useState } from "react";
import { appRestart } from "../data/driver.ts";
import { errText } from "../lib/errors.ts";
import {
  bodyKey,
  headingKey,
  outcomeRows,
  type ResetAttempt,
  shouldRestart,
} from "../lib/reset.ts";
import { useT } from "./useTranslation.ts";

/** Statuses that make a report row read as a problem (not a completion). */
const BLOCKED_STATUS_KEYS = new Set([
  "reset.status.failed",
  "reset.status.notAttempted",
]);

export function ResetResultScreen({
  attempt,
  onRetry,
}: {
  attempt: ResetAttempt;
  /** Back to the workspace's acknowledgement state; never a restart. */
  onRetry: () => void;
}) {
  const t = useT();
  const done = shouldRestart(attempt);
  const rows = outcomeRows(attempt);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);

  // The success branch's only action. It exists exactly once in this file and
  // the file renders this branch only when `done` — i.e. behind the
  // complete-check — is true; the source pins keep that honest.
  const restart = async () => {
    setRestarting(true);
    setRestartError(null);
    try {
      await appRestart();
    } catch (e) {
      // A restart that could not be requested leaves the user HERE, so the
      // failure must be visible rather than a button that silently did
      // nothing. No path reopens the workspace either way.
      setRestartError(errText(e));
      setRestarting(false);
    }
  };

  return (
    <div className="lock-wrap">
      <div className="entry-form vault-narrow">
        <div className="lock-brand-head">
          <img
            className="lock-brand-mark"
            src="/brand/purple-memo-mark.png"
            alt=""
            width={44}
            height={44}
          />
          <h2 className="editor-title">{t(headingKey(attempt))}</h2>
          <p className="page-subtitle">{t(bodyKey(attempt))}</p>
        </div>
        {attempt.kind === "ipc-error" && (
          <p className="alert alert-error" role="alert">
            {attempt.error}
          </p>
        )}
        {done ? (
          <>
            {restartError !== null && (
              <p className="alert alert-error" role="alert">
                {restartError}
              </p>
            )}
            <div className="editor-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={restarting}
                onClick={() => void restart()}
              >
                {restarting ? t("common.wait") : t("reset.restart")}
              </button>
            </div>
          </>
        ) : (
          <>
            {rows.length > 0 && (
              <ul
                className="reset-outcome"
                aria-label={t("reset.incompleteTitle")}
              >
                {rows.map((row) => (
                  <li key={row.componentKey}>
                    <span className="reset-outcome-component">
                      {t(row.componentKey)}
                    </span>{" "}
                    <span
                      className={
                        BLOCKED_STATUS_KEYS.has(row.statusKey)
                          ? "badge badge-danger"
                          : "badge"
                      }
                    >
                      {t(row.statusKey)}
                    </span>
                    {/* The engine's diagnostic text, verbatim — not
                        localized, not interpreted. */}
                    {row.detail !== null && (
                      <p className="muted reset-outcome-detail">{row.detail}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="editor-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={onRetry}
              >
                {t("reset.retry")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
