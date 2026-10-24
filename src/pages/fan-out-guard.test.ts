// First paint must not fan out.
//
// The finding had two halves: the share ticker's per-tick N+1 (pinned
// behaviourally by share.test.ts's query-count test) and the same per-row
// pattern on the three pages' first paint — one `walletBalanceCents` per
// wallet, two queries per habit for progress plus one more for its calendar
// dates. `node --test` cannot mount a page component, so this half is pinned
// by reading the page source: the pages must call the batch methods, and the
// per-row call forms must be gone from all three.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** The page source, normalized so call-form regexes ignore line breaks. */
function page(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf8").replace(
    /\s+/g,
    " ",
  );
}

const budget = page("BudgetPage.tsx");
const dashboard = page("DashboardPage.tsx");
const habits = page("HabitsPage.tsx");

test("BudgetPage: balances come from one grouped query, not one call per wallet", () => {
  assert.match(
    budget,
    /budgetRepo\.listWalletBalances\(/,
    "first paint should read every balance in a single query",
  );
  assert.doesNotMatch(
    budget,
    /budgetRepo\.walletBalanceCents\(/,
    "the per-wallet balance call must not return to a list render",
  );
});

test("DashboardPage: habit weeks come from the batch pass, not two queries per habit", () => {
  assert.match(
    dashboard,
    /habitsRepo\.habitProgressList\(/,
    "the week strip should cost two queries total",
  );
  assert.doesNotMatch(
    dashboard,
    /habitsRepo\.habitProgress\(/,
    "the per-habit progress call must not return to first paint",
  );
  assert.doesNotMatch(
    dashboard,
    /habitsRepo\.listHabits\(/,
    "the habit list now rides along in habitProgressList",
  );
});

test("HabitsPage: progress AND calendar dates come from the batch pass", () => {
  assert.match(
    habits,
    /habitsRepo\.habitProgressList\(/,
    "progress and dates should share one two-query pass",
  );
  assert.doesNotMatch(
    habits,
    /habitsRepo\.habitProgress\(/,
    "the per-habit progress call must not return",
  );
  assert.doesNotMatch(
    habits,
    /habitsRepo\.loggedDates\(/,
    "the per-habit date call must not return — dates ride along in the batch",
  );
  assert.doesNotMatch(
    habits,
    /habitsRepo\.listHabits\(/,
    "the habit list now rides along in habitProgressList",
  );
});
