// Batch-3 stale-state gates (findings C2/C3/C4/C6 in
// docs/Arena_Findings_Batch3.md).
//
// `node --test` cannot mount a page component, so each rule is pinned by
// reading the page source — the same trick submit-guards.test.ts uses on the
// busy flags. What is asserted is the shape that keeps a parked or mid-flight
// page honest:
//
//   C2  a date-derived read takes its day when the reload RUNS, not when the
//       component rendered, and a page left mounted past midnight reloads on
//       the rollover (nothing else re-renders it);
//   C3  a create/delete refreshes the month the screen shows *now*, through a
//       load that a newer month-navigation load can supersede;
//   C4  the search-focus effect is keyed on arrival, not on the data — with
//       the list in its dependencies every reload snapped the user back to
//       the "all" view for the rest of the session;
//   C6  the gallery re-reads the link-picker's labels when the inspector opens.
//
// C5 (ShoppingPage's reorder guard) is pinned in submit-guards.test.ts, which
// owns the guard shape.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function readPage(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
}

/**
 * The body of one `const name = … => {…}` / `const name = useCallback(…)`
 * binding, by brace matching. The first `{` after the binding is the function
 * body in both shapes this file meets.
 */
function handlerSource(src: string, name: string): string {
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

test("date-derived reloads take their day at call time (C2)", () => {
  for (const page of ["MemoriesPage.tsx", "LoansPage.tsx"]) {
    const src = readPage(page);
    const body = handlerSource(src, "reload");
    assert.ok(
      body.includes("todayLocal()"),
      `${page}: reload must read todayLocal() itself — a date captured in the component body is what goes stale`,
    );
    assert.doesNotMatch(
      src,
      /\}, \[today\]\);/,
      `${page}: reload must not be keyed on a render-captured \`today\` — that only refreshes when something re-renders the page`,
    );
    // Nothing re-renders a parked page, so the rollover needs its own tick.
    assert.match(
      src,
      /if \(todayLocal\(\) !== todayRef\.current\) void reload\(\);/,
      `${page}: a page parked across midnight must reload when the local date changes`,
    );
    assert.ok(
      src.includes("clearInterval(timer)"),
      `${page}: the date-rollover interval must be cleaned up on unmount`,
    );
  }
});

test("the month feed only installs the month that is current now (C3)", () => {
  const src = readPage("MemoriesPage.tsx");

  // The create/delete paths read the month AFTER their awaits: the render's
  // `feedMonth` is the month the user tapped in, not necessarily the one on
  // screen when the write lands.
  for (const handler of ["submitForm", "remove"]) {
    const body = handlerSource(src, handler);
    assert.ok(
      body.includes("loadMonth(feedMonthRef.current)"),
      `MemoriesPage ${handler}: must refresh the month shown NOW, not its captured feedMonth`,
    );
    assert.doesNotMatch(
      body,
      /monthFeed\(feedMonth\)/,
      `MemoriesPage ${handler}: monthFeed(feedMonth) is the stale capture this finding is about`,
    );
  }

  // A load that has been superseded may not write, so flipping months while a
  // create is in flight cannot install the old month under the new heading.
  const loader = handlerSource(src, "loadMonth");
  assert.match(loader, /const seq = \+\+monthSeqRef\.current;/);
  assert.match(
    loader,
    /if \(seq === monthSeqRef\.current\) setMonth\(feed\)/,
    "MemoriesPage: only the newest month load may install its rows",
  );

  // ...and `showMonth` must be the only writer of `feedMonth`, or the ref the
  // write paths read drifts away from the state the nav buttons set.
  assert.equal(
    (src.match(/setFeedMonth\(/g) ?? []).length,
    1,
    "MemoriesPage: every change to feedMonth must go through showMonth so feedMonthRef tracks it",
  );
});

test("the search-focus effect is keyed on arrival, not on the data (C4)", () => {
  const src = readPage("MemoriesPage.tsx");
  assert.doesNotMatch(
    src,
    /\[focusId, focusToken, loading, all\]/,
    'MemoriesPage: `all` in the focus effect’s dependencies re-runs it on every reload and snaps the user back to the "all" view',
  );
  assert.match(
    src,
    /\}, \[focusId, focusToken, loading\]\);/,
    "MemoriesPage: the focus effect must react to arrival signals only",
  );
  // The existence check still reads the live list — through the mirror effect.
  assert.match(
    src,
    /allRef\.current\.some\(/,
    "MemoriesPage: the focus effect's existence check must read allRef, since `all` is deliberately not a dependency",
  );
});

test("the gallery's link-picker labels refresh when the inspector opens (C6)", () => {
  const src = readPage("GalleryPage.tsx");
  assert.ok(
    handlerSource(src, "select").includes("loadPickerLists"),
    "GalleryPage: opening the inspector must re-read notes/memories/jobs — their titles are changed by other pages",
  );
  assert.match(
    handlerSource(src, "loadPickerLists"),
    /notesRepo\.listNoteTitles\(\)/,
    "GalleryPage: loadPickerLists must read the three picker lists",
  );
  assert.ok(
    src.includes("loadPickerLists(() => cancelled)"),
    "GalleryPage: the mount effect must load them too, with its cancellation check",
  );
});
