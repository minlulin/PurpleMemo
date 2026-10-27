// Where the app shell can go, and what "go there" can mean.
//
// Two levels, deliberately. `PageKey` answers "which screen"; a
// {@link NavigationTarget} answers "which screen, and which exact row in it" —
// the difference between a dashboard button that opens Tasks and a relationship
// click that opens the one task.
//
// The shell keeps ONE target in state and passes it down as props, because the
// page subtree is keyed by page and remounts on every navigation: any selection
// intent that lived inside a page would be destroyed before the page could read
// it.

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

/** A destination: a page, and optionally the exact row to select on arrival. */
export interface NavigationTarget {
  page: PageKey;
  /** Present only when the destination is one specific row. */
  entity?: LinkableEntity;
}

/** A destination with no row selected — what every plain page switch means. */
export function pageTarget(page: PageKey): NavigationTarget {
  return { page };
}

/**
 * A destination that is one exact row.
 *
 * An id of 0 or a negative id is refused: those rows cannot exist, and turning
 * one into a target would produce a navigation that reports "not found" for a
 * link the user could see.
 */
export function entityTarget(entity: LinkableEntity): NavigationTarget {
  if (!Number.isInteger(entity.id) || entity.id <= 0) {
    throw new Error(`Cannot navigate to ${entity.type} #${entity.id}.`);
  }
  return { page: ENTITY_PAGE[entity.type], entity };
}

/**
 * Are these the same destination? Used to decide whether arriving somewhere new
 * is worth acting on: re-selecting the row the page already shows would discard
 * whatever the user is typing.
 */
export function sameTarget(a: NavigationTarget, b: NavigationTarget): boolean {
  if (a.page !== b.page) return false;
  if (a.entity === undefined || b.entity === undefined) {
    return a.entity === b.entity;
  }
  return a.entity.type === b.entity.type && a.entity.id === b.entity.id;
}

/**
 * The row a page should select, or null.
 *
 * `type` is the page's own entity kind, so a target for a task never selects
 * note 7 — the two pages both take an `id`, and nothing else distinguishes
 * them.
 */
export function focusedRowFor(
  target: NavigationTarget,
  type: LinkableEntityType,
): number | null {
  return target.entity?.type === type ? target.entity.id : null;
}
