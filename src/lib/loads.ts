// Out-of-order load protection (§4 data flow). Every page loads through
// async repos, and two loads can be in flight at once: a slow FTS query for
// "a" can resolve after a fast one for "abc", leaving the list showing the old
// result set; clicking photo A then photo B can leave A's links rendered under
// B.
//
// `JournalPage` had the right answer (a monotonic ref) inline while the other
// pages had none, so the rule lived in one component and nowhere else. It is
// here instead — pure, so `node --test` can reach it, which is the whole point
// of the module split described in `lib/session.ts`.

/** Guards against a superseded async load overwriting a newer result. */
export interface LoadGuard {
  /** Call at the start of a load. Returns the token to check results against. */
  begin(): number;
  /** True when `token` belongs to the newest load, i.e. its result may be used. */
  isCurrent(token: number): boolean;
  /** Invalidate every in-flight load — used when the selection is cleared. */
  cancel(): void;
}

export function createLoadGuard(): LoadGuard {
  let current = 0;
  return {
    begin: () => ++current,
    isCurrent: (token) => token === current,
    cancel: () => {
      current += 1;
    },
  };
}
