// Shared modal shell (plan 12b.1). GalleryPage's photo inspector (11.4) and
// the shortcut overlay (12b.1) both need the same thing: a scrim, a keyboard-
// reachable way out, a focus trap, Escape, and focus returned to whatever
// opened it. Keeping that in one place means the second modal cannot ship a
// weaker version of the first.

import type { ReactNode } from "react";
import { useCallback, useEffect, useRef } from "react";

interface DialogProps {
  /** Id of the element naming the dialog. */
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
  /** Extra class on the `.modal-content` card. */
  className?: string;
}

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function Dialog({
  labelledBy,
  onClose,
  children,
  className,
}: DialogProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Whatever had focus when the dialog opened gets it back on close.
  const triggerRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    onClose();
    triggerRef.current?.focus();
  }, [onClose]);

  useEffect(() => {
    triggerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

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
      if (!first || !last) return;
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
        aria-label="Close dialog"
        onClick={close}
      />
      <div
        className={`modal-content${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        ref={contentRef}
      >
        {children}
      </div>
    </div>
  );
}
