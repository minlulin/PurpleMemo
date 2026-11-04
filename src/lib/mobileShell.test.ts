import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  BACKGROUND_LOCK_GRACE_MS,
  FAB_ACTIONS,
  isLanding,
  MOBILE_LANDING,
  MOBILE_SECTIONS,
  MOBILE_TABS,
  MORE_SHEET_ITEMS,
  routeForCompose,
  routeForPage,
  routeForTab,
  routeFromHistoryState,
  shouldLockAfterBackground,
  tabForPage,
} from "./mobileShell.ts";

test("the bottom bar is exactly the five agreed tabs, in order", () => {
  assert.deepEqual(
    MOBILE_TABS.map((tab) => tab.key),
    ["dashboard", "tasks", "budget", "shopping", "more"],
  );
  assert.equal(
    MOBILE_TABS[0]?.key,
    "dashboard",
    "Dashboard is the landing page",
  );
});

test("More holds the remaining sections and nothing desktop-only", () => {
  assert.deepEqual(
    MORE_SHEET_ITEMS.map((item) => item.page),
    ["notes", "business", "loans", "habits", "vault", "settings"],
  );
});

test("the mobile surface is the ten agreed sections", () => {
  assert.equal(MOBILE_SECTIONS.length, 10);
  for (const excluded of [
    "gallery",
    "contacts",
    "journal",
    "memories",
    "inbox",
    "exports",
    "trash",
  ]) {
    assert.ok(
      !MOBILE_SECTIONS.includes(excluded as never),
      `${excluded} must stay desktop-only`,
    );
  }
});

test("each section opens on the tab that owns it", () => {
  assert.equal(tabForPage("dashboard"), "dashboard");
  assert.equal(tabForPage("tasks"), "tasks");
  assert.equal(tabForPage("budget"), "budget");
  assert.equal(tabForPage("shopping"), "shopping");
  assert.equal(tabForPage("notes"), "more");
  assert.equal(tabForPage("settings"), "more");
  assert.equal(tabForPage("gallery"), "more");
});

test("only the landing state may leave the app on back", () => {
  assert.equal(isLanding(MOBILE_LANDING), true);
  assert.equal(isLanding(routeForTab("tasks")), false);
  assert.equal(isLanding(routeForPage("notes")), false);
  assert.equal(isLanding(routeForCompose("note")), false);
});

test("the FAB creates five things and never checks a habit in", () => {
  assert.deepEqual(
    FAB_ACTIONS.map((action) => action.id),
    ["note", "task", "income", "expense", "shopping"],
  );
  assert.ok(
    FAB_ACTIONS.every((action) => action.page !== "habits"),
    "habit check-ins are 1-tap toggles, not FAB entries",
  );
  assert.deepEqual(
    FAB_ACTIONS.filter((action) => action.page === "budget").map((a) => a.id),
    ["income", "expense"],
  );
});

test("a compose action lands on its module with the create form open", () => {
  const route = routeForCompose("shopping");
  assert.equal(route.page, "shopping");
  assert.equal(route.compose, "shopping");
  assert.equal(route.tab, "shopping");
  const income = routeForCompose("income");
  assert.equal(income.page, "budget");
  assert.equal(income.compose, "income");
});

test("routes survive a round trip through history state", () => {
  const route = routeForPage("vault");
  assert.deepEqual(routeFromHistoryState({ ...route }), route);
  assert.deepEqual(routeFromHistoryState(null), MOBILE_LANDING);
  assert.deepEqual(routeFromHistoryState({ tab: "gallery" }), MOBILE_LANDING);
  assert.deepEqual(
    routeFromHistoryState({ tab: "more", page: "gallery" }),
    MOBILE_LANDING,
    "a desktop-only section is not a mobile route",
  );
  assert.deepEqual(
    routeFromHistoryState({ tab: "more", compose: "note" }),
    MOBILE_LANDING,
    "a create form needs the section it belongs to",
  );
});

test("a section's tab is derived, never taken from a stale entry", () => {
  const route = routeFromHistoryState({ tab: "shopping", page: "notes" });
  assert.equal(route.tab, "more");
});

test("the background grace is one minute and fails closed", () => {
  assert.equal(BACKGROUND_LOCK_GRACE_MS, 60_000);
  assert.equal(shouldLockAfterBackground(45_000), false);
  assert.equal(shouldLockAfterBackground(75_000), true);
  assert.equal(shouldLockAfterBackground(0), false);
  assert.equal(shouldLockAfterBackground(BACKGROUND_LOCK_GRACE_MS), true);
  assert.equal(shouldLockAfterBackground(Number.NaN), true);
  assert.equal(shouldLockAfterBackground(-1), true);
});
