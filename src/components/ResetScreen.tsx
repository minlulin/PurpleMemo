// Terminal factory-reset screen.
//
// Once `factoryReset()` resolves OR throws, this screen replaces the whole
// workspace, the same way the boot and lock screens do. The shell holds the
// attempt in its top-level state (not navigation state the user could
// reverse) and gates every workspace effect — pollers, idle auto-lock, the
// global shortcuts — off while it holds it (H3), so nothing runs behind this
// screen.
//
// Two things it deliberately does NOT claim:
//
//   - **That the database connection is closed, unconditionally.** A throw can
//     be an abort from BEFORE the engine closed or deleted anything (H6), so
//     the shell probes the database and keeps the session when it is still
//     alive; by the time this screen renders, a closed connection is the case
//     that survived the probe (or an engine report, which always closed it).
//   - **That there is no way back.** "Retry reset" drops the attempt and
//     returns to the workspace's Settings → Danger zone (owner decision D1) —
//     deliberately not a second, ungated path to `factoryReset()` — and never
//     to a restart.
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

import { useRef, useState } from "react";
import { appRestart } from "../data/driver.ts";
import { errText } from "../lib/errors.ts";
import {
  bodyKey,
  headingKey,
  isBlockedStatusKey,
  outcomeRows,
  type ResetAttempt,
  shouldRestart,
} from "../lib/reset.ts";
import { useT } from "./useTranslation.ts";

export function ResetResultScreen({
  attempt,
  onRetry,
}: {
  attempt: ResetAttempt;
  /** Back to Settings → Danger zone (D1); never a restart. */
  onRetry: () => void;
}) {
  const t = useT();
  const done = shouldRestart(attempt);
  const rows = outcomeRows(attempt);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const restartingRef = useRef(false);

  // The success branch's only action. It exists exactly once in this file and
  // the file renders this branch only when `done` — i.e. behind the
  // complete-check — is true; the source pins keep that honest.
  const restart = async () => {
    // Synchronous re-entry guard first (H8): `disabled={restarting}` only
    // takes effect once React commits the next render, so a fast double-click
    // or double-Enter used to fire two concurrent `app_restart` requests
    // before the state caught up. The ref is read and written in the same
    // tick, so the second press never gets past this line.
    if (restartingRef.current) return;
    restartingRef.current = true;
    setRestarting(true);
    setRestartError(null);
    try {
      await appRestart();
      // Accepted — the process is on its way out, so `restarting` stays up
      // and the button keeps saying "Wait…": re-enabling it here would offer
      // a second restart in the window before the process actually goes down.
    } catch (e) {
      // A restart that could not be requested leaves the user HERE, so the
      // failure must be visible rather than a button that silently did
      // nothing. No path reopens the workspace either way.
      setRestartError(errText(e));
      setRestarting(false);
    } finally {
      // The synchronous guard always releases: it exists to stop a second
      // press while the first is in flight, and the state above is what keeps
      // the button disabled afterwards.
      restartingRef.current = false;
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
          <h1 className="editor-title">{t(headingKey(attempt))}</h1>
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
                        isBlockedStatusKey(row.statusKey)
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
