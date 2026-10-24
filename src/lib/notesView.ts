// Notes editor view modes (Edit | Split | Read) and the Collections collapse
// flag: pure decision logic, no dependencies, so `node --test` can reach it —
// the same module split described in `lib/loads.ts`. The page owns the state
// and the settings store owns the persistence; this module owns what a stored
// value MEANS and where Ctrl+E takes you.

/** How the editor pane shows the note: writing, both panes, or reading. */
export type NotesViewMode = "edit" | "split" | "read";

/**
 * Side-by-side, exactly as the editor shipped before view modes existed —
 * a fresh install and an unreadable settings row both land on today's
 * behaviour, never on a mode the writer did not choose.
 */
export const DEFAULT_VIEW_MODE: NotesViewMode = "split";

/** Validate an unknown stored value; anything malformed falls back. */
export function parseViewMode(raw: unknown): NotesViewMode {
  return raw === "edit" || raw === "split" || raw === "read"
    ? raw
    : DEFAULT_VIEW_MODE;
}

/**
 * Ctrl+E / Cmd+E on the Notes page: Read → Edit, Edit → Read,
 * Split → Read (so a second press returns to Edit).
 *
 * Every mode has exactly one destination — never a no-op — so the shortcut
 * always does something visible, and "get me out of the way of my text"
 * (Split → Read) follows the same read/write axis as the other two.
 */
export function toggleViewMode(mode: NotesViewMode): NotesViewMode {
  switch (mode) {
    case "read":
      return "edit";
    case "edit":
      return "read";
    case "split":
      return "read";
  }
}

/**
 * The Collections sidebar starts expanded. Only a stored `true` collapses
 * it — the same shape as `getNotificationPreview`: absent, corrupt, and
 * unexpected values all answer "expanded", the sidebar a fresh install sees.
 */
export function parseCollectionsCollapsed(raw: unknown): boolean {
  return raw === true;
}
