// Two-step confirmation for destructive actions (review P2-10).
//
// Notes, tasks, contacts, memories, and journal entries move to Trash when
// deleted. Other destructive actions, plus permanent deletion from Trash, still
// need explicit confirmation because they cannot be recovered there.
//
// The confirmation is INLINE and two-step rather than a modal, matching the
// backup-restore pattern already in `SettingsPage`: arm, then confirm or
// cancel. The rule is small but it is the whole safety property, so it lives
// here as a pure transition rather than in the component's event handlers —
// where it would be unreachable from `node --test` and one early `return` away
// from silently re-arming.

/**
 * - `idle`   — resting; the button shows its ordinary label.
 * - `armed`  — the first click landed; the button now offers to confirm or cancel.
 * - `running` — confirmed, and the action is in flight.
 */
export type ConfirmState = "idle" | "armed" | "running";

export type ConfirmEvent = "arm" | "run" | "settle" | "cancel";

/**
 * The gate.
 *
 * Three properties matter, and each exists because of a specific way this goes
 * wrong when it is written inline:
 *
 * 1. **`arm` is a no-op while running.** A second click on the armed button is
 *    delivered as another activation, not as a fresh "arm". Without this, a
 *    user who clicks twice while a slow delete is in flight queues a second
 *    delete of whatever the first one created or revealed.
 * 2. **`settle` always returns to idle**, success or failure. Leaving the
 *    button armed after an error report puts the retry one misclick away — the
 *    exact accident this gate exists to prevent, arrived at by the honest path.
 * 3. **`cancel` is refused while running.** The delete has already been issued;
 *    pretending to call it off would be a lie. The button is disabled there
 *    anyway, so this only makes the invariant explicit.
 */
export function confirmTransition(
  state: ConfirmState,
  event: ConfirmEvent,
): ConfirmState {
  switch (event) {
    case "arm":
      return state === "running" ? "running" : "armed";
    case "run":
      return state === "armed" ? "running" : state;
    case "settle":
      return "idle";
    case "cancel":
      return state === "running" ? "running" : "idle";
  }
}

/** The label the armed button carries, naming what is about to be destroyed. */
export function confirmLabel(what: string): string {
  return `Delete ${what}`;
}
