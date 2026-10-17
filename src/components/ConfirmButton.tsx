// Inline two-step confirmation for a destructive button (review P2-10).
//
// Renders its ordinary button until clicked; then, in place, it offers
// `Delete <what>` and `Cancel`. Same shape as the backup-restore confirmation
// in `SettingsPage`, so the app has exactly one way to ask for a deletion.
//
// The state machine is `lib/confirm.ts` — pure, and unit-tested there, because
// this component's event handlers are not reachable from `node --test`.

import { type ReactNode, useState } from "react";
import {
  type ConfirmEvent,
  type ConfirmState,
  confirmLabel,
  confirmTransition,
} from "../lib/confirm.ts";

interface ConfirmButtonProps {
  /**
   * What is about to be destroyed, as a noun: "note", "shopping list", "habit".
   * It appears in the confirm button, so the second click names its own
   * consequence — "Delete shopping list" reads differently from "Delete"
   * sitting under a list of tabs.
   */
  what: string;
  /**
   * The destructive action. Awaited, so the button reads "Deleting…" and
   * refuses further clicks for as long as the write takes — which is the other
   * half of the double-click problem (P2-11), and the reason a delete cannot
   * be fired twice by an impatient hand.
   */
  onConfirm: () => void | Promise<void>;
  /** The resting button's content — an icon, a label, or both. */
  children: ReactNode;
  /** Class for the resting button; the armed pair are styled by this module. */
  className?: string;
  disabled?: boolean;
  /** Accessible name for an icon-only resting button. */
  "aria-label"?: string;
  title?: string;
}

export function ConfirmButton(p: ConfirmButtonProps) {
  const [state, setState] = useState<ConfirmState>("idle");
  const send = (event: ConfirmEvent) =>
    setState((current) => confirmTransition(current, event));

  if (state === "armed") {
    return (
      <>
        <button
          type="button"
          className="btn btn-danger"
          onClick={async () => {
            send("run");
            try {
              await p.onConfirm();
            } finally {
              // Always, including a throw: an action that failed must not leave
              // the button armed with the destructive one click away.
              send("settle");
            }
          }}
        >
          {confirmLabel(p.what)}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => send("cancel")}
        >
          Cancel
        </button>
      </>
    );
  }

  return (
    <button
      type="button"
      className={p.className}
      disabled={p.disabled}
      aria-label={p["aria-label"]}
      title={p.title}
      onClick={() => send("arm")}
    >
      {p.children}
    </button>
  );
}
