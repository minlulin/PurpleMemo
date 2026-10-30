// Where the app shell can go, and what "go there" can mean.
//
// Two levels, deliberately. `PageKey` answers "which screen"; a focused
// row answers "which screen, and which exact row in it" — the difference
// between a dashboard button that opens Tasks and a relationship click
// that opens the one task.
//
// The shell holds these as separate state (J8): `page` plus a `focus`
// entity, where a plain page switch clears the focus and opening an entity
// sets both. `<main>` is keyed by page and remounts the whole subtree on
// every navigation, so the focus lives in the shell, not in a page — an
// intent kept inside a page would be gone before the page could read it.

import type { LinkableEntity, LinkableEntityType } from "./types.ts";

/** Pages addressable by the app shell and cross-feature links. */
export type PageKey =
  | "dashboard"
  | "inbox"
  | "notes"
  | "journal"
  | "budget"
  | "business"
  | "loans"
  | "habits"
  | "tasks"
  | "shopping"
  | "contacts"
  | "memories"
  | "trash"
  | "gallery"
  | "vault"
  | "exports"
  | "more"
  | "settings";

/** Which page shows which kind of entity. The whole map, in one place. */
export const ENTITY_PAGE: Record<LinkableEntityType, PageKey> = {
  note: "notes",
  task: "tasks",
  contact: "contacts",
};

/**
 * The row a page should select, or null.
 *
 * `type` is the page's own entity kind, so a focus for a task never
 * selects note 7 — the two pages both take an `id`, and nothing else
 * distinguishes them. An id that could not name a real row (0, negative,
 * fractional, `NaN`) selects nothing rather than handing the page a target
 * its list cannot contain.
 */
export function focusedRowFor(
  focus: LinkableEntity | null,
  type: LinkableEntityType,
): number | null {
  if (focus === null || focus.type !== type) return null;
  return Number.isSafeInteger(focus.id) && focus.id > 0 ? focus.id : null;
}
