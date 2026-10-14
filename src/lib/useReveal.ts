// Scroll-in reveal (plan 13.9). Elements carrying `.reveal-on-scroll` start
// hidden and are released as they intersect the viewport.
//
// Deliberately fail-safe, twice over:
//   * no IntersectionObserver, or reduced motion requested → reveal at once;
//   * pass `ready` (e.g. `!loading`) so the observer attaches *after* the
//     cards exist. Observing an empty container would leave the cards that
//     arrive later stuck at opacity 0.
// Content is never allowed to stay invisible because of a missing browser API
// or a race with loading data.

import { useEffect, useRef } from "react";

const REVEAL_CLASS = "is-revealed";
const REVEAL_ANIMATION = "animate-slide-up";

/** Adds the revealed state plus the entrance animation class. */
function release(el: Element): void {
  el.classList.add(REVEAL_CLASS, REVEAL_ANIMATION);
}

export function useRevealWithin<T extends HTMLElement>(ready = true) {
  const ref = useRef<T>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root || !ready) return;

    const targets = Array.from(
      root.querySelectorAll<HTMLElement>(".reveal-on-scroll"),
    );
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || typeof IntersectionObserver === "undefined") {
      for (const el of targets) release(el);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          release(entry.target);
          observer.unobserve(entry.target);
        }
      },
      // Start revealing slightly before the element is fully on screen.
      { rootMargin: "0% 0% -8% 0%", threshold: 0.05 },
    );
    for (const el of targets) observer.observe(el);
    return () => observer.disconnect();
  }, [ready]);

  return ref;
}
