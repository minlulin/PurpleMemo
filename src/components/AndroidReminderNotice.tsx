// Android-only disclosure for reminders (design decision 9).
//
// Two facts the user has to be told, and one action:
//
// * on this phone reminders are scheduled with the OS, so they fire even when
//   Purple Memo is closed — unlike the desktop, where the poll needs the app
//   open and unlocked;
// * if the exact-alarm setting is not granted, delivery falls back to the
//   inexact path, which can be minutes late. The app must never imply an exact
//   reminder when it scheduled an inexact one.
//
// Nothing renders on desktop: the existing subtitle already tells that truth.

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { isAndroidPlatform } from "../lib/android-reminders.ts";

type ExactState = "exact" | "inexact" | "unknown";

export function AndroidReminderNotice() {
  const [state, setState] = useState<ExactState | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (!isAndroidPlatform()) return;
    let cancelled = false;
    invoke<string>("reminder_exact_state")
      .then((value) => {
        if (cancelled) return;
        setState(value === "exact" ? "exact" : "inexact");
      })
      .catch(() => {
        if (!cancelled) setState("unknown");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === null) return null;

  const openSettings = async () => {
    setOpening(true);
    try {
      await invoke("reminder_open_exact_alarm_settings");
    } catch {
      // The OS screen may refuse; the disclosure below still stands.
    } finally {
      setOpening(false);
    }
  };

  return (
    <p className="alert alert-note" role="status">
      {state === "exact" ? (
        <>
          Reminders are scheduled on this phone and fire even when Purple Memo
          is closed.
        </>
      ) : state === "inexact" ? (
        <>
          Exact alarms are not allowed on this phone, so reminders may arrive a
          few minutes late.{" "}
          <button
            type="button"
            className="btn btn-ghost"
            disabled={opening}
            onClick={() => void openSettings()}
          >
            Allow exact alarms
          </button>
        </>
      ) : (
        <>
          Reminders are scheduled on this phone; this device could not report
          whether they are exact.
        </>
      )}
    </p>
  );
}
