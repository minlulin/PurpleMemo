// Factory-reset policy.
//
// The Rust engine (`src-tauri/src/reset.rs`) is not gated: it runs and reports
// per-component outcomes. The frontend is the POLICY layer, and this module is
// where that policy lives in pure, testable form:
//
//   - restart is allowed ONLY on a `complete: true` outcome — a blocked reset
//     never restarts the app (owner decision, Wave 2 brief);
//   - every engine component name and status maps to a catalogue key, so the
//     result screen renders the outcome verbatim in both languages;
//   - a throw-shaped attempt (IPC failure) can never present as success.
//
// The screens and the Settings handler are wiring; the decision rules are
// here, and `reset.test.ts` pins them. The gate is frontend-only by design
// (the Rust engine deliberately has no acknowledgement check), so the source
// pins in `src/reset-gate.test.ts` — not any backend enforcement — are what
// keep the checkbox + ConfirmButton + complete-check chain true.

import type {
  FactoryResetOutcome,
  ResetComponentName,
  ResetComponentStatus,
} from "../data/driver.ts";
import type { MessageKey } from "./i18n.ts";

/**
 * One factory-reset attempt as the UI models it.
 *
 * `outcome` is a resolved engine report (complete or not). `ipc-error` is a
 * THROWN `factoryReset()` — an IPC failure that produced no report at all. It
 * is modelled as its own kind rather than as a `FactoryResetOutcome`, because
 * inventing component rows for it would claim knowledge of what the engine
 * did; nothing may be assumed after a throw (the engine may have removed half
 * the state before the reply was lost).
 */
export type ResetAttempt =
  | { kind: "outcome"; outcome: FactoryResetOutcome }
  | { kind: "ipc-error"; error: string };

/** Wrap a resolved outcome as an attempt. */
export function resetAttemptFromOutcome(
  outcome: FactoryResetOutcome,
): ResetAttempt {
  return { kind: "outcome", outcome };
}

/**
 * Wrap a thrown reset as an attempt. Never success, by construction.
 *
 * Not necessarily terminal either (H6): the engine throws both BEFORE it has
 * closed the database — it could not record the reset marker, so nothing was
 * deleted — and after, from a worker panic with the connection already gone,
 * and the two are indistinguishable from here. The shell probes which case it
 * is before holding the attempt (see `App.tsx`'s `handleResetFinished`),
 * because this screen's copy asserts a closed connection that only the second
 * case actually has.
 */
export function resetAttemptFromError(error: string): ResetAttempt {
  return { kind: "ipc-error", error };
}

/**
 * The restart gate (owner decision, Wave 2): only a complete outcome may lead
 * to `appRestart()`. A blocked reset and a thrown reset both answer false —
 * the session ends without a restart either way, and the user restarts by
 * hand after retrying or closing the window.
 */
export function shouldRestart(attempt: ResetAttempt): boolean {
  return attempt.kind === "outcome" && attempt.outcome.complete === true;
}

/** The heading the result screen shows for an attempt. */
export function headingKey(attempt: ResetAttempt): MessageKey {
  if (attempt.kind === "ipc-error") return "reset.errorTitle";
  return attempt.outcome.complete
    ? "reset.successTitle"
    : "reset.incompleteTitle";
}

/** The body copy under the heading. */
export function bodyKey(attempt: ResetAttempt): MessageKey {
  if (attempt.kind === "ipc-error") return "reset.errorBody";
  return attempt.outcome.complete
    ? "reset.successBody"
    : "reset.incompleteBody";
}

/**
 * Component name → catalogue key. `Record`-typed so adding a component to the
 * Rust contract without a label here is a compile error, and
 * `reset.test.ts` re-checks the keys exist in both catalogues at runtime.
 */
export const RESET_COMPONENT_LABEL_KEYS: Record<
  ResetComponentName,
  MessageKey
> = {
  share_stop: "reset.component.shareStop",
  database: "reset.component.database",
  photos: "reset.component.photos",
  backups: "reset.component.backups",
  logs: "reset.component.logs",
  keyring_key: "reset.component.keyringKey",
};

/** Status → catalogue key, with the same compile-time coverage. */
export const RESET_STATUS_LABEL_KEYS: Record<ResetComponentStatus, MessageKey> =
  {
    removed: "reset.status.removed",
    already_absent: "reset.status.alreadyAbsent",
    failed: "reset.status.failed",
    not_attempted: "reset.status.notAttempted",
  };

/** One display row of the per-component report. */
export interface ResetDisplayRow {
  componentKey: MessageKey;
  statusKey: MessageKey;
  /**
   * The engine's diagnostic string, verbatim, or null. It is not localized
   * and not interpreted — it is what the engine said and belongs on screen
   * exactly as reported.
   */
  detail: string | null;
}

/**
 * The rows the result screen renders, in engine order.
 *
 * A thrown attempt has NO rows: there is no report to render verbatim, and
 * fabricated rows would claim per-component knowledge an IPC failure does not
 * provide. The screen shows the error text instead (see `src/reset-gate`).
 */
export function outcomeRows(attempt: ResetAttempt): ResetDisplayRow[] {
  if (attempt.kind !== "outcome") return [];
  return attempt.outcome.components.map((component) => ({
    componentKey: RESET_COMPONENT_LABEL_KEYS[component.name],
    statusKey: RESET_STATUS_LABEL_KEYS[component.status],
    detail: component.detail,
  }));
}

/**
 * The statuses that make a report row read as a problem rather than a
 * completion — the ONE definition of "blocked" (H10). The result list styles
 * each badge with this and {@link hasBlockedComponent} aggregates it, so the
 * per-row colour and the overall verdict cannot drift apart the way a copy of
 * the set inside the screen could.
 */
export function isBlockedStatusKey(statusKey: MessageKey): boolean {
  return (
    statusKey === "reset.status.failed" ||
    statusKey === "reset.status.notAttempted"
  );
}

/**
 * Whether the report lists any component the user must act on — i.e. the
 * engine said something failed or never ran. The aggregate form of
 * {@link isBlockedStatusKey}; it never drives a restart (see
 * {@link shouldRestart}).
 */
export function hasBlockedComponent(attempt: ResetAttempt): boolean {
  return outcomeRows(attempt).some((row) => isBlockedStatusKey(row.statusKey));
}
