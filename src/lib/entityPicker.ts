// Choosing an entity to relate something to.
//
// Pure and capped, because the picker runs over rows the user already has in
// memory. Two rules that are easy to get wrong and expensive to notice:
//
// - Archived notes and completed tasks are HIDDEN by default. A relationship to
//   a finished note is usually a mistake, and a list of 400 completed tasks is
//   not a list anyone can choose from. The user can still ask for them.
// - Results are capped per type and overall, and the cap is reported rather than
//   silently applied, so "no match" and "capped" never look the same.
//
// Nothing here touches the database: the pages pass in the rows they already
// loaded, and the search is a plain case-insensitive substring match over a few
// hundred strings. A relationship picker is not the global search.

import type {
  ContactRow,
  LinkableEntity,
  LinkableEntityType,
  NoteRow,
  TaskRow,
} from "./types.ts";

/** How many results one type may contribute. */
export const PICKER_PER_TYPE_CAP = 20;

/** How many results in total, across all three types. */
export const PICKER_TOTAL_CAP = 30;

/** A hit from one type, with the fields a list row needs. */
export interface PickerHit {
  entity: LinkableEntity;
  label: string;
  /** Second line: a date, a note's first words, a count. Never required. */
  detail: string | null;
  /** "Archived" or "Done", or null — the word that separates two same-named rows. */
  state: string | null;
  /** Higher sorts first. Ties break by label then id, so order is stable. */
  sortKey: string;
}

export interface PickerSource {
  notes: NoteRow[];
  tasks: TaskRow[];
  contacts: ContactRow[];
  /** Existing relationships: never offered, because a link is one row. */
  alreadyLinked?: LinkableEntity[];
}

export interface PickerOptions {
  /** The entity the relationship starts from; never offered as a target. */
  from: LinkableEntity;
  query?: string;
  /** Offer archived notes and completed tasks. Off by default. */
  includeInactive?: boolean;
  perTypeCap?: number;
  totalCap?: number;
}

export interface PickerResult {
  hits: PickerHit[];
  /** True when a cap stopped the results short of what matched. */
  capped: boolean;
  /** How many matched before capping, for the honest "showing 30 of 96" line. */
  matched: number;
}

function normalize(value: string): string {
  // Lowercase, and strip the combining marks Myanmar vowels are written
  // separately, so "မြန်မာ" and "မြန်မာ" are one search term rather than two.
  return value.normalize("NFC").toLowerCase().replace(/\p{M}/gu, "").trim();
}

function matches(query: string, ...fields: string[]): boolean {
  if (query.length === 0) return true;
  return fields.some((field) => normalize(field).includes(query));
}

function key(entity: LinkableEntity): string {
  return `${entity.type}:${entity.id}`;
}

function excerpt(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

/**
 * What the picker offers, in a stable order.
 *
 * Live rows first, then archived/completed ones when they were asked for: an
 * inactive row is a worse answer than a live one, so it never crowds one out
 * just by existing.
 */
export function pickerResults(
  source: PickerSource,
  options: PickerOptions,
): PickerResult {
  const query = normalize(options.query ?? "");
  const perType = options.perTypeCap ?? PICKER_PER_TYPE_CAP;
  const total = options.totalCap ?? PICKER_TOTAL_CAP;
  const taken = new Set<string>([key(options.from)]);
  for (const entity of source.alreadyLinked ?? []) taken.add(key(entity));

  const live: PickerHit[] = [];
  const inactive: PickerHit[] = [];

  for (const note of source.notes) {
    if (taken.has(key({ type: "note", id: note.id }))) continue;
    const archived = note.archived === 1;
    if (archived && !options.includeInactive) continue;
    if (!matches(query, note.title, note.content, note.tags)) continue;
    const label =
      note.title.trim().length > 0 ? note.title.trim() : "Untitled note";
    const hit: PickerHit = {
      entity: { type: "note", id: note.id },
      label,
      detail: note.content.length > 0 ? excerpt(note.content) : null,
      state: archived ? "Archived" : null,
      // "0" so a live row outranks an inactive one with the same name.
      sortKey: `${archived ? 1 : 0}\u0000${label.toLowerCase()}\u0000${String(note.id).padStart(12, "0")}`,
    };
    (archived ? inactive : live).push(hit);
  }

  for (const task of source.tasks) {
    if (taken.has(key({ type: "task", id: task.id }))) continue;
    const done = task.done === 1;
    if (done && !options.includeInactive) continue;
    if (!matches(query, task.title, task.note)) continue;
    const label =
      task.title.trim().length > 0 ? task.title.trim() : "Untitled task";
    const hit: PickerHit = {
      entity: { type: "task", id: task.id },
      label,
      detail: task.due_date === null ? null : `Due ${task.due_date}`,
      state: done ? "Done" : null,
      sortKey: `${done ? 1 : 0}\u0000${label.toLowerCase()}\u0000${String(task.id).padStart(12, "0")}`,
    };
    (done ? inactive : live).push(hit);
  }

  for (const contact of source.contacts) {
    if (taken.has(key({ type: "contact", id: contact.id }))) continue;
    if (!matches(query, contact.name, contact.address, contact.notes)) continue;
    const label =
      contact.name.trim().length > 0 ? contact.name.trim() : "Unnamed contact";
    live.push({
      entity: { type: "contact", id: contact.id },
      label,
      detail: contact.birthday === null ? null : `Birthday ${contact.birthday}`,
      state: null,
      sortKey: `0\u0000${label.toLowerCase()}\u0000${String(contact.id).padStart(12, "0")}`,
    });
  }

  const bySort = (a: PickerHit, b: PickerHit): number =>
    a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0;
  live.sort(bySort);
  inactive.sort(bySort);
  const offered = options.includeInactive
    ? [...live, ...inactive]
    : [...live, ...inactive];

  const matched = offered.length;
  // Per-type cap first, then the total, so one type cannot crowd out the others.
  const perTypeCount = new Map<LinkableEntityType, number>();
  const cappedHits: PickerHit[] = [];
  for (const hit of offered) {
    const used = perTypeCount.get(hit.entity.type) ?? 0;
    if (used >= perType || cappedHits.length >= total) continue;
    perTypeCount.set(hit.entity.type, used + 1);
    cappedHits.push(hit);
  }
  return { hits: cappedHits, capped: cappedHits.length < matched, matched };
}

/** One row's wording for the shared picker list. */
export function pickerRowLabel(hit: PickerHit): string {
  const kind =
    hit.entity.type === "note"
      ? "Note"
      : hit.entity.type === "task"
        ? "Task"
        : "Contact";
  const parts = [kind, hit.label];
  if (hit.state !== null) parts.push(`(${hit.state})`);
  return parts.join(" · ");
}
