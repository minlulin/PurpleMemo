// Batch-3 stale-state gates (findings C2/C3/C4/C6 in
// docs/Arena_Findings_Batch3.md), plus K9 from Batch10 — same defect class
// (a read that lands after the human has already chosen), same file.
//
// `node --test` cannot mount a page component, so each rule is pinned by
// reading the page source — the same trick submit-guards.test.ts uses on the
// busy flags. What is asserted is the shape that keeps a parked or mid-flight
// page honest:
//
//   C2  a date-derived read takes its day when the reload RUNS, not when the
//       component rendered, and a page left mounted past midnight reloads on
//       the rollover (nothing else re-renders it) — the four pages that keep
//       a day-derived view: Memories, Loans, Dashboard, Habits;
//   C3  a create/delete refreshes the month the screen shows *now*, through a
//       load that a newer month-navigation load can supersede;
//   C4  the search-focus effect is keyed on arrival, not on the data — with
//       the list in its dependencies every reload snapped the user back to
//       the "all" view for the rest of the session;
//   C6  the gallery re-reads the link-picker's labels when the inspector opens;
//   K9  (Batch10) the Notes page's mount-time preference read yields to a
//       writer that already chose — one ref per preference, raised by every
//       writer (buttons and Ctrl+E), checked by the read.
//   L1/L2 (Batch11) the relationships panel loads on a primitive entity
//       identity instead of the caller's inline object literal — a re-render
//       with an equal-but-new entity re-fires nothing — and only the newest
//       load may write.
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
  for (const page of [
    "MemoriesPage.tsx",
    "LoansPage.tsx",
    // Dashboard and Habits also derive display from the day — same defect,
    // same fix, same shape of the rollover tick.
    "DashboardPage.tsx",
    "HabitsPage.tsx",
  ]) {
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
    // The tick now lives in ONE hook (docs/AUDIT.md DUP-03): each page used to
    // carry its own copy, in two different staleness styles. The page only has
    // to use the hook — the next test pins the hook's own shape.
    assert.match(
      src,
      /useDayRollover\(/,
      `${page}: a page parked across midnight must re-anchor on a day change`,
    );
  }
});

test("the shared day-rollover hook compares the local date and cleans up", () => {
  // The five pages above delegate here, so this is now the single place the
  // midnight rule can break: it must compare against the day it last acted
  // on, fire once per change, and clear its interval.
  const hook = readFileSync(
    new URL("../lib/useDayRollover.ts", import.meta.url),
    "utf8",
  );
  assert.match(hook, /export const DAY_TICK_MS = 60_000;/);
  assert.match(hook, /const now = todayLocal\(\);/);
  assert.match(hook, /if \(now === dayRef\.current\) return;/);
  assert.match(hook, /handlerRef\.current\(now\);/);
  assert.match(hook, /clearInterval\(timer\)/);
  // The interval must not depend on the handler identity, or an inline arrow
  // would restart the countdown on every render and never reach midnight.
  assert.match(hook, /\}, \[\]\);/);
});

test("the day a page displays is the day its rows were loaded for (C2)", () => {
  // The TasksPage B8 rule: badge and rows come from one load, so the page
  // never grades yesterday's rows against today's date (or the reverse).
  for (const page of ["DashboardPage.tsx", "HabitsPage.tsx"]) {
    const body = handlerSource(readPage(page), "reload");
    assert.match(
      body,
      /setToday\(/,
      `${page}: reload must publish the day it loaded for, with the rows`,
    );
    const dayAt = body.indexOf("const day = todayLocal();");
    assert.notEqual(dayAt, -1, `${page}: reload must read the day itself`);
    assert.ok(
      dayAt < body.search(/\bset[A-Z]/),
      `${page}: read the day before any state is written`,
    );
  }
});

test("the two write paths book the real day, not the loaded one (C2)", () => {
  // `today` state is the day the LIST was loaded for; these writes must use
  // the clock, or a click inside the rollover tick's window books yesterday.
  assert.match(
    handlerSource(readPage("DashboardPage.tsx"), "completeTask"),
    /completeTask\(task\.id, todayLocal\(\)\)/,
    "DashboardPage: completeTask re-anchors a repeating task off this date — it must take the real day",
  );
  const habits = readPage("HabitsPage.tsx");
  assert.match(
    habits,
    /toggle\(h\.id, todayLocal\(\)\)/,
    'HabitsPage: "Mark done today" must log the real day',
  );
  assert.match(
    habits,
    /toggle\(h\.id, cell\.date\)/,
    "HabitsPage: the calendar cells must still log the date they show",
  );
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

test("the mount-time preference read yields to the writer (K9)", () => {
  // NotesPage reads view mode + collapse once on mount; the click can land
  // while that read is in flight (an IPC round trip that can queue behind a
  // write), and the read resolving afterwards reverted the click — while the
  // store already held the new value, so UI and repository disagreed and the
  // choice was lost on the next launch. `cancelled` alone does not close it:
  // it fires on UNMOUNT, and the losing page stays mounted.
  const src = readPage("NotesPage.tsx");

  // One ref per preference — a choice of one must not freeze the other,
  // which the read still owns.
  assert.match(
    src,
    /const viewModeChosenRef = useRef\(false\)/,
    "NotesPage: the yield needs a ref (survives re-renders), not state",
  );
  assert.match(
    src,
    /const collectionsChosenRef = useRef\(false\)/,
    "NotesPage: the collapse flag needs its own ref, so the two writers do not block each other",
  );

  // EVERY writer marks the choice the moment it makes it — the button
  // handlers and the Ctrl+E shortcut, both view-mode writers.
  assert.equal(
    (src.match(/viewModeChosenRef\.current = true/g) ?? []).length,
    2,
    "NotesPage: both view-mode writers (changeViewMode and the Ctrl+E handler) must mark the choice",
  );
  assert.equal(
    (src.match(/collectionsChosenRef\.current = true/g) ?? []).length,
    1,
    "NotesPage: the collapse writer must mark its choice too",
  );

  // …and the read installs a value only while its ref is still false — the
  // guard that was missing when the read could overwrite the writer.
  assert.match(
    src,
    /if \(!viewModeChosenRef\.current\) setViewMode\(mode\)/,
    "NotesPage: the mount read must skip a view mode the writer already chose",
  );
  assert.match(
    src,
    /if \(!collectionsChosenRef\.current\) setCollectionsCollapsed\(collapsed\)/,
    "NotesPage: the mount read must skip a collapse flag the writer already chose",
  );
});

// -- The relationships panel (batch-11, L1/L2) --------------------------------
// Same defect class, one seam down: the load was keyed on something every
// parent render rebuilds, with no token to stop a superseded response from
// installing itself. `node --test` still cannot mount the component, so both
// rules are pinned by reading it — and by reading that the callers keep
// handing it an inline literal, which is the condition the component must
// survive rather than the thing to fix.

test("the relationships list re-queries on the entity, not on every parent render (L1)", () => {
  const src = readPage("../components/LinksSection.tsx");

  // A primitive identity: `type` + `id` is the whole of LinkableEntity, so an
  // equal-but-new object from a caller's inline literal leaves the key alone
  // — the re-render that fires nothing.
  assert.match(
    src,
    /const entityKey = `\$\{p\.entity\.type\}-\$\{p\.entity\.id\}`;/,
    "LinksSection: key the load on a primitive the inline literal cannot change",
  );

  // `reload` changes identity only when that key changes…
  assert.match(
    src,
    /const reload = useCallback\(async \(\) => \{[\s\S]*?\}, \[entityKey\]\);/,
    "LinksSection: reload must be keyed on entityKey, not on the p.entity reference",
  );
  // …and the effect hangs off `reload`, so it re-fires on an entity change
  // and on nothing else.
  assert.match(
    src,
    /useEffect\(\(\) => \{\s+setLoading\(true\);\s+void reload\(\);\s+\}, \[reload\]\);/,
    "LinksSection: the load effect must fire through reload",
  );
  assert.doesNotMatch(
    src,
    /\}, \[p\.entity\]\);/,
    "LinksSection: a dependency on p.entity is exactly the every-keystroke reload L1 is about",
  );

  // The three pages keep their inline literal — deliberately unchanged: the
  // component, not each caller, owns the stability.
  const callers: [page: string, type: string][] = [
    ["NotesPage.tsx", "note"],
    ["ContactsPage.tsx", "contact"],
    ["TasksPage.tsx", "task"],
  ];
  for (const [page, type] of callers) {
    assert.match(
      readPage(page),
      new RegExp(`entity=\\{\\{ type: "${type}", id: [\\w.]+ \\}\\}`),
      `${page}: LinksSection is fed an inline object literal — its entityKey is what keeps that from re-firing the load`,
    );
  }
});

test("a superseded relationships load may not install its rows (L2)", () => {
  const src = readPage("../components/LinksSection.tsx");
  const reload = handlerSource(src, "reload");
  // Comments off: the prose below the code talks about awaits and writes too,
  // and a position check that reads it would pass or fail on wording.
  const code = reload.replace(/\/\/[^\n]*/g, "");

  // The token is taken inside `reload`, before its await — so the load
  // effect, `link` and `unlink` all take a fresh one, and a response for a
  // previously selected entity is stale the moment a newer load starts.
  const takenAt = code.indexOf("const seq = ++reloadSeqRef.current;");
  assert.notEqual(
    takenAt,
    -1,
    "LinksSection: reload must take a sequence token of its own",
  );
  const awaitAt = code.search(/\bawait\b/);
  assert.notEqual(awaitAt, -1, "LinksSection: reload has no await to guard");
  assert.ok(
    takenAt < awaitAt,
    "LinksSection: take the token before the await, or the older load still wins the race it just lost",
  );

  // The rows go in only while the token is still the newest one — never
  // straight from the await, which is the shape that let a stale response
  // overwrite the list of the entity now on screen.
  const guardAt = code.indexOf("if (seq !== reloadSeqRef.current) return;");
  assert.notEqual(
    guardAt,
    -1,
    "LinksSection: a superseded load must return before it writes",
  );
  const rowsAt = code.indexOf("setItems(");
  assert.notEqual(rowsAt, -1, "LinksSection: reload installs no rows?");
  assert.ok(
    guardAt < rowsAt,
    "LinksSection: the newest-wins check must come before the rows are installed",
  );
  assert.equal(
    (code.match(/setItems\(/g) ?? []).length,
    1,
    "LinksSection: rows have exactly one writer, behind the token",
  );
  assert.doesNotMatch(
    code,
    /setItems\(await/,
    "LinksSection: rows must not be installed straight from the await",
  );

  // The other two writes are behind it as well: a stale load may change
  // nothing at all — not the error, not the spinner.
  assert.match(
    code,
    /if \(seq === reloadSeqRef\.current\) setError\(errText\(e\)\);/,
    "LinksSection: a stale rejection may not post its error under the current entity",
  );
  assert.match(
    code,
    /if \(seq === reloadSeqRef\.current\) setLoading\(false\);/,
    "LinksSection: a stale load may not clear the spinner the newest one is still filling",
  );
});
