// Batch-11 L5 (docs/Arena_Findings_Batch11.md), pinned by reading the
// provider's source — the same trick the page suites use, because `node --test`
// cannot mount it: Toast.tsx is JSX and this project has no React testing
// library. What is asserted is the shape that keeps the registry bounded:
//
//   - every timer is created in ONE place, and that place drops its id from
//     `timers` at the moment the timer fires,
//   - both timer sites (auto-dismiss and the exit animation) go through it,
//   - the unmount cleanup still clears whatever is still pending — and empties
//     the registry, so a cleanup/remount cycle cannot inherit dead ids.
//
// The behaviour behind the shape: an id only sits in `timers` while its timer
// is pending, so once a toast has auto-dismissed and its exit timer has run,
// `timers.current` holds no stale ids — it used to grow by one entry per toast
// and one per dismiss, for the life of the provider.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("./Toast.tsx", import.meta.url), "utf8");

/**
 * The body of one `const name = … => {…}` / `const name = useCallback(…)`
 * binding, by brace matching — the first `{` after the binding is the function
 * body in both shapes this file meets.
 */
function hookSource(name: string): string {
  const start = src.search(new RegExp(`const ${name} = `));
  assert.notEqual(start, -1, `${name} not found — renamed or removed?`);
  const open = src.indexOf("{", start);
  assert.notEqual(open, -1, `${name} has no body`);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} body is not brace-balanced`);
}

test("a timer takes its id out of the registry as it fires (L5)", () => {
  // One creation site. A raw setTimeout anywhere else is an entry that
  // nothing ever removes — the exact shape this finding is about.
  assert.equal(
    (src.match(/window\.setTimeout\(/g) ?? []).length,
    1,
    "Toast: every timer must be created through schedule, so every timer is tracked",
  );

  const schedule = hookSource("schedule");

  // Booked when it is created…
  assert.match(
    schedule,
    /timers\.current\.push\(timer\);/,
    "Toast: schedule must register the timer it creates",
  );
  // …and dropped when it fires, BEFORE its work runs: after the last toast's
  // timers have fired, `timers.current` holds nothing.
  const pruneAt = schedule.indexOf("timers.current = timers.current.filter(");
  assert.notEqual(
    pruneAt,
    -1,
    "Toast: schedule must drop the id when the timer fires — pruning on unmount alone is what let the array grow for the whole session",
  );
  const runAt = schedule.indexOf("run();");
  assert.notEqual(
    runAt,
    -1,
    "Toast: schedule never runs the work it scheduled",
  );
  assert.ok(
    pruneAt < runAt,
    "Toast: the id must be gone from the registry before the timer's work runs",
  );
  assert.match(
    schedule,
    /pending !== timer/,
    "Toast: the id removed must be this timer's own — filtering on anything else drops a live timer",
  );
});

test("both toast timers are tracked, and unmount still clears them (L5)", () => {
  const dismiss = hookSource("dismiss");
  const push = hookSource("push");

  // The two sites: the auto-dismiss (TOAST_MS) and the exit animation
  // (TOAST_EXIT_MS) — each previously pushed an id nobody removed.
  assert.ok(
    dismiss.includes("schedule(() => remove(id), TOAST_EXIT_MS)"),
    "Toast: the exit timer must go through schedule",
  );
  assert.ok(
    push.includes("schedule(() => dismiss(id), TOAST_MS)"),
    "Toast: the auto-dismiss timer must go through schedule",
  );
  assert.ok(
    !dismiss.includes("window.setTimeout") &&
      !push.includes("window.setTimeout"),
    "Toast: no timer may be created outside schedule",
  );

  // The unmount cleanup keeps its contract: everything still pending is
  // cleared, and the registry is emptied with it — a cleanup that cleared the
  // timeouts but kept the ids would leave dead entries behind on remount.
  assert.match(
    src,
    /for \(const timer of timers\.current\) window\.clearTimeout\(timer\);/,
    "Toast: unmount must still clear the pending timers",
  );
  assert.match(
    src,
    /clearTimeout\(timer\);\n\s*timers\.current = \[\];/,
    "Toast: unmount must empty the registry along with the timers",
  );
});
