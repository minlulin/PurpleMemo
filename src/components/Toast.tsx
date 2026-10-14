// Toasts (plan 12a.4-12a.10): transient confirmations that stack in the
// bottom-right corner and dismiss themselves. The host is the live region —
// one polite announcement per toast, mounted once in `App.tsx`.
//
// Toasts are for confirmations ("PIN updated", "Backup exported"). Anything
// the user must act on stays an inline `.alert`, which does not disappear.

import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { IconAlert, IconCheck, IconClose, IconInfo } from "./icons.tsx";

export type ToastTone = "success" | "error" | "info";

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
  /** Animating out — the row stays mounted until the exit finishes. */
  leaving: boolean;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  dismiss: (id: number) => void;
}

/** Visible time before a toast starts leaving. */
const TOAST_MS = 4000;
/** Leave animation length; the row is unmounted after it. */
const TOAST_EXIT_MS = 200;
/** Never let transient messages stack into a wall. */
const MAX_TOASTS = 4;

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef<number[]>([]);

  const remove = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      setToasts((list) =>
        list.map((t) => (t.id === id ? { ...t, leaving: true } : t)),
      );
      // Timer-driven rather than `animationend`: under reduced motion there is
      // no animation to end, and a toast must never get stuck on screen.
      timers.current.push(window.setTimeout(() => remove(id), TOAST_EXIT_MS));
    },
    [remove],
  );

  const push = useCallback(
    (tone: ToastTone, message: string) => {
      const id = nextId.current;
      nextId.current += 1;
      setToasts((list) =>
        [...list, { id, tone, message, leaving: false }].slice(-MAX_TOASTS),
      );
      timers.current.push(window.setTimeout(() => dismiss(id), TOAST_MS));
    },
    [dismiss],
  );

  useEffect(
    () => () => {
      for (const timer of timers.current) window.clearTimeout(timer);
    },
    [],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (message: string) => push("success", message),
      error: (message: string) => push("error", message),
      info: (message: string) => push("info", message),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.tone}${t.leaving ? " is-leaving" : ""}`}
          >
            {t.tone === "success" ? (
              <IconCheck className="icon" />
            ) : t.tone === "error" ? (
              <IconAlert className="icon" />
            ) : (
              <IconInfo className="icon" />
            )}
            <span className="toast-message">{t.message}</span>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label="Dismiss notification"
              title="Dismiss"
              onClick={() => dismiss(t.id)}
            >
              <IconClose className="icon" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Throws outside a provider so a missing provider fails loudly in dev. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return ctx;
}
