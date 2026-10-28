// Shared modal shell. GalleryPage's photo inspector and
// the shortcut overlay both need the same thing: a scrim, a keyboard-
// reachable way out, a focus trap, Escape, and focus returned to whatever
// opened it. Keeping that in one place means the second modal cannot ship a
// weaker version of the first.

import type { ReactNode } from "react";
import { useCallback, useEffect, useRef } from "react";
import { useT } from "./useTranslation.ts";

interface DialogProps {
  /** Id of the element naming the dialog. */
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
  /** Extra class on the `.modal-content` card. */
  className?: string;
  /**
   * While true, every close path the dialog owns — Escape, the backdrop
   * button, anything routed through `close` — returns early (G3). A caller
   * with a write in flight cannot be dismissed out from under it; the
   * caller's own SUCCESS path may still call `onClose` directly, because
   * that close means "finished", not "abandoned".
   */
  locked?: boolean;
}

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function Dialog({
  labelledBy,
  onClose,
  children,
  className,
  locked = false,
}: DialogProps) {
  const t = useT();
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Whatever had focus when the dialog opened gets it back on close.
  const triggerRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    // A locked dialog ignores its own close controls (G3): Escape and the
    // backdrop must not unmount a dialog while its write is in flight.
    if (locked) return;
    onClose();
  }, [locked, onClose]);

  // The opener is captured ONCE, on mount (G5). It used to live in the
  // `[close]` effect below, and `close` depends on `onClose` — which every
  // caller passes as a fresh inline closure. Each re-render (picking a file,
  // stepping to the next note, any AppShell re-render) re-ran the capture and
  // overwrote the stored opener with an element INSIDE the dialog, so focus
  // restoration pointed at the wrong thing or at nothing.
  //
  // Restored in the CLEANUP, not in `close` (G5): unmount is the one moment
  // every close path shares — Escape, backdrop, `×`, Cancel, Done — including
  // the explicit buttons that call `onClose` directly and never went through
  // `close` at all, which used to leave `document.activeElement` on `<body>`.
  useEffect(() => {
    triggerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    return () => {
      triggerRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const dialog = contentRef.current;
      if (!dialog) return;
      const stops = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => !el.hasAttribute("disabled"));
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (!first || !last) {
        // Nothing focusable left INSIDE the dialog (G5): every control may be
        // disabled — CSV Import does exactly that while its batch runs.
        // `aria-modal` promises focus cannot leave, so hold it on the
        // container itself rather than letting Tab walk out into the page
        // behind. (`el.hasAttribute("disabled")` above already ignores the
        // container's own `tabIndex={-1}`.)
        e.preventDefault();
        if (!dialog.contains(document.activeElement)) {
          dialog.focus();
        }
        return;
      }
      // Focus that has left the dialog entirely comes back before anything is
      // allowed to wrap (review P3-33). Clicking non-focusable text inside the
      // modal moves `activeElement` to `body`, so neither of the wraps below
      // matched and Tab walked straight out into the page behind — which is
      // the one thing `aria-modal` promises cannot happen. Check containment
      // FIRST rather than only comparing against the two ends.
      if (!dialog.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <div className="modal-backdrop">
      {/* A real button, so "click outside to close" is keyboard reachable. */}
      <button
        type="button"
        className="modal-dismiss"
        aria-label={t("common.closeDialog")}
        onClick={close}
      />
      <div
        className={`modal-content animate-scale-in${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        // Focusable only programmatically (never a Tab stop), so the trap
        // above can hold focus here when the dialog has no enabled control
        // left (G5).
        tabIndex={-1}
        ref={contentRef}
      >
        {children}
      </div>
    </div>
  );
}
