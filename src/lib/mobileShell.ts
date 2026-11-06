// The mobile shell's rules, kept out of the React tree so they can be pinned by
// tests: which five tabs exist, what lives behind "More", what a back press
// means, which sections exist at all, the FAB's create-only actions, and how
// long a backgrounded session stays unlocked.
//
// Nothing here touches the DOM or Tauri. `MobileShell.tsx` is the wiring; this
// is the contract (docs/ANDROID_DESIGN.md §4 and decision 6).

import type { MessageKey } from "./i18n.ts";
import type { PageKey } from "./navigation.ts";

/** The five bottom tabs, in order. `dashboard` is the landing page. */
export type MobileTabKey =
  | "dashboard"
  | "tasks"
  | "budget"
  | "shopping"
  | "more";

export interface MobileTab {
  key: MobileTabKey;
  label: MessageKey;
}

export const MOBILE_TABS: readonly MobileTab[] = [
  { key: "dashboard", label: "nav.dashboard" },
  { key: "tasks", label: "nav.tasks" },
  { key: "budget", label: "nav.budget" },
  { key: "shopping", label: "nav.shopping" },
  { key: "more", label: "mobile.moreTab" },
];

/**
 * The sections behind the "More" sheet. Six items, in reading order — the eight
 * modules plus Settings, minus the four that already have a tab or are the
 * sheet itself.
 */
export const MORE_SHEET_ITEMS: readonly { page: PageKey; label: MessageKey }[] =
  [
    { page: "notes", label: "nav.notes" },
    { page: "business", label: "nav.business" },
    { page: "loans", label: "nav.loans" },
    { page: "habits", label: "nav.habits" },
    { page: "vault", label: "nav.vault" },
    { page: "settings", label: "nav.settings" },
  ];

/**
 * The ten sections the phone is allowed to show: 8 modules + Dashboard +
 * Settings (design §2). Gallery, Contacts, Journal, Memories, Inbox, Exports and
 * Trash are desktop-only and are *not* reachable from the shell — the list is
 * the allowlist, so a navigation path cannot smuggle one in.
 */
export const MOBILE_SECTIONS: readonly PageKey[] = [
  "dashboard",
  "tasks",
  "budget",
  "shopping",
  "notes",
  "business",
  "loans",
  "habits",
  "vault",
  "settings",
];

/** Section title keys. Every mobile section is named once, here. */
export const SECTION_LABELS: Record<string, MessageKey> = {
  dashboard: "nav.dashboard",
  tasks: "nav.tasks",
  budget: "nav.budget",
  shopping: "nav.shopping",
  notes: "nav.notes",
  business: "nav.business",
  loans: "nav.loans",
  habits: "nav.habits",
  vault: "nav.vault",
  settings: "nav.settings",
};

/** Which tab owns a section: the four tab sections keep their tab, the rest live under More. */
export function tabForPage(page: PageKey): MobileTabKey {
  if (page === "dashboard") return "dashboard";
  if (page === "tasks") return "tasks";
  if (page === "budget") return "budget";
  if (page === "shopping") return "shopping";
  return "more";
}

export function isMobileSection(page: PageKey): boolean {
  return MOBILE_SECTIONS.includes(page);
}

/**
 * The title key for a section. A page outside the mobile set still gets a
 * usable label — the shell never renders one, and a lookup that returned
 * `undefined` would reach `t()` as a missing key.
 */
export function sectionLabel(page: PageKey): MessageKey {
  return SECTION_LABELS[page] ?? "nav.more";
}

/**
 * One point in the shell's history. `page` is the section being viewed (null on
 * a tab's own screen); `compose` names the create form opened by the FAB — a
 * placeholder in this session, but part of the route so back returns to the
 * section it was opened from.
 */
export interface MobileRoute {
  tab: MobileTabKey;
  page: PageKey | null;
  compose: FabActionId | null;
  /**
   * The note the reader is showing, or null. It is a route (not local state)
   * so the Android back gesture closes the reader instead of leaving the app.
   */
  noteId: number | null;
}

export const MOBILE_LANDING: MobileRoute = {
  tab: "dashboard",
  page: null,
  compose: null,
  noteId: null,
};

/** The only state from which a back press leaves the app. */
export function isLanding(route: MobileRoute): boolean {
  return (
    route.tab === "dashboard" &&
    route.page === null &&
    route.compose === null &&
    route.noteId === null
  );
}

/** Pressing a tab shows that tab's own screen. */
export function routeForTab(tab: MobileTabKey): MobileRoute {
  return { tab, page: null, compose: null, noteId: null };
}

/** Opening a section keeps the tab that owns it, so the tab bar stays truthful. */
export function routeForPage(page: PageKey): MobileRoute {
  return { tab: tabForPage(page), page, compose: null, noteId: null };
}

/**
 * Opening a note in the reader. Pinned notes are previewed on the Dashboard,
 * so the reader sits on that tab and back returns to it.
 */
export function routeForNote(id: number): MobileRoute {
  return { tab: "dashboard", page: null, compose: null, noteId: id };
}

/**
 * What the FAB can create. Creation only — habit check-ins are 1-tap toggles on
 * Dashboard/Habits (his correction, 2026-11-02), and jobs/loans are created on
 * their own pages.
 */
export type FabActionId = "note" | "task" | "income" | "expense" | "shopping";

export interface FabAction {
  id: FabActionId;
  label: MessageKey;
  page: PageKey;
  /** Budget groups both money actions on its tab. */
}

export const FAB_ACTIONS: readonly FabAction[] = [
  { id: "note", label: "mobile.fab.note", page: "notes" },
  { id: "task", label: "mobile.fab.task", page: "tasks" },
  { id: "income", label: "mobile.fab.income", page: "budget" },
  { id: "expense", label: "mobile.fab.expense", page: "budget" },
  { id: "shopping", label: "mobile.fab.shopping", page: "shopping" },
];

const FAB_IDS: readonly FabActionId[] = [
  "note",
  "task",
  "income",
  "expense",
  "shopping",
];

/** The route a FAB action lands on: the owning section, with its create form. */
export function routeForCompose(id: FabActionId): MobileRoute {
  const action = FAB_ACTIONS.find((candidate) => candidate.id === id);
  if (action === undefined) return MOBILE_LANDING;
  return {
    tab: tabForPage(action.page),
    page: action.page,
    compose: action.id,
    noteId: null,
  };
}

const MOBILE_TAB_KEYS: readonly string[] = MOBILE_TABS.map((tab) => tab.key);

/**
 * Read a route back out of `history.state`.
 *
 * Anything unrecognised — a foreign entry, a section that is not part of the
 * mobile allowlist, a compose id that does not exist — falls back to the
 * landing screen rather than rendering a page the shell was not meant to show.
 */
export function routeFromHistoryState(state: unknown): MobileRoute {
  if (typeof state !== "object" || state === null) return MOBILE_LANDING;
  const raw = state as {
    tab?: unknown;
    page?: unknown;
    compose?: unknown;
    noteId?: unknown;
  };
  if (typeof raw.tab !== "string" || !MOBILE_TAB_KEYS.includes(raw.tab)) {
    return MOBILE_LANDING;
  }
  const tab = raw.tab as MobileTabKey;
  // A page that is present but is not a mobile section means the entry belongs
  // to another surface: fall back to the landing screen rather than showing a
  // tab that would mislabel it.
  const pageValue = raw.page ?? null;
  if (pageValue !== null && !isMobileSection(pageValue as PageKey)) {
    return MOBILE_LANDING;
  }
  const page = pageValue as PageKey | null;
  const compose =
    typeof raw.compose === "string" &&
    FAB_IDS.includes(raw.compose as FabActionId)
      ? (raw.compose as FabActionId)
      : null;
  // A compose route without a page cannot be shown; a page that belongs to a
  // different tab would make the tab bar lie, so the tab is derived from it.
  if (compose !== null && page === null) return MOBILE_LANDING;
  if (page !== null)
    return { tab: tabForPage(page), page, compose, noteId: null };
  const noteId =
    typeof raw.noteId === "number" &&
    Number.isInteger(raw.noteId) &&
    raw.noteId > 0
      ? raw.noteId
      : null;
  if (noteId !== null) {
    return page === null && compose === null
      ? routeForNote(noteId)
      : { tab, page, compose, noteId };
  }
  return { tab, page: null, compose: null, noteId: null };
}

/** The value written to `history.state` for a route. */
export function historyStateFor(route: MobileRoute): Record<string, unknown> {
  return {
    purpleMemoMobile: true,
    tab: route.tab,
    page: route.page,
    compose: route.compose,
    noteId: route.noteId,
  };
}

/**
 * Background lock grace (decision 6): a session that was in the background for
 * less than a minute comes back unlocked; at or beyond a minute the PIN screen
 * is shown again.
 */
export const BACKGROUND_LOCK_GRACE_MS = 60_000;

/**
 * True when the app was away long enough to lock.
 *
 * `>=` rather than `>`: the boundary belongs to the safe side, so a session
 * hidden for exactly the grace period is locked rather than trusted. A negative
 * or non-finite duration (a clock that went backwards) also locks — failing
 * closed costs one PIN entry, failing open costs the session.
 */
export function shouldLockAfterBackground(hiddenMs: number): boolean {
  if (!Number.isFinite(hiddenMs) || hiddenMs < 0) return true;
  return hiddenMs >= BACKGROUND_LOCK_GRACE_MS;
}
