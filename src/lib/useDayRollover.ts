// One day-rollover tick for pages that stay mounted across midnight.
//
// The shell keeps every page mounted, so nothing re-renders a parked page when
// the local date changes: a page showing "today" would keep yesterday's date
// label, overdue badges and habit check-ins until the user happened to tap
// something. Five pages each carried their own `setInterval(…, 60_000)` for
// this, in two different styles (state compared, or a ref the page had to keep
// in sync) — docs/AUDIT.md DUP-03. The rule lives here once.
//
// The handler receives the new local date, so a page can re-anchor its state
// without reading the clock a second time and landing on a different day than
// the tick detected.

import { useEffect, useRef } from "react";
import { todayLocal } from "./dates.ts";

/** How often a parked page re-reads the local date. */
export const DAY_TICK_MS = 60_000;

/** Called with the new `yyyy-mm-dd` once the local day has changed. */
export type DayRolloverHandler = (newDay: string) => void;

/**
 * Call `onRollover(newDay)` the first tick after the local date changes.
 *
 * The last seen date is a ref, not state: the check must compare against the
 * day the page last acted on, and re-rendering to store it would restart the
 * interval on every render.
 */
export function useDayRollover(onRollover: DayRolloverHandler): void {
  // Latest handler without re-arming the interval — pages pass an inline
  // arrow, and a dependency on it would restart the countdown on every
  // render, which is the one thing that can stop midnight from ever being
  // noticed.
  const handlerRef = useRef(onRollover);
  handlerRef.current = onRollover;

  const dayRef = useRef(todayLocal());

  useEffect(() => {
    const timer = setInterval(() => {
      const now = todayLocal();
      if (now === dayRef.current) return;
      dayRef.current = now;
      handlerRef.current(now);
    }, DAY_TICK_MS);
    return () => clearInterval(timer);
  }, []);
}
