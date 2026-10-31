// Heading ids for rendered Markdown (Decision 2, Batch 12).
//
// Pure, UI-free logic so `node --test` can exercise it directly: the
// component in `src/components/MarkdownLink.tsx` owns the React side
// (one allocation per mounted heading) and calls into this module.

/**
 * A heading's text as a URL-fragment-safe slug.
 *
 * Unicode-aware (`\p{L}\p{M}\p{N}`): a Burmese heading keeps its script
 * instead of degrading to `heading-N` — HTML5 ids may hold any
 * characters except whitespace, and his notes are in Burmese.
 * The `\p{M}` (marks) matter: Burmese vowel signs are combining marks,
 * and stripping them mangles the word (`နိဒါန်း` → `နဒန`).
 * Empty or punctuation-only text falls back to `"heading"` so every
 * heading still gets an id.
 */
export function slugifyHeading(text: string): string {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/\s+/gu, "-")
    .replace(/[^\p{L}\p{M}\p{N}_-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "heading";
}

/** Per-document dedup scope: `alloc` hands out stable, unique ids. */
export interface HeadingIdScope {
  alloc(text: string): string;
}

/**
 * A fresh scope. The scope only grows — allocations are never released
 * back — so an id handed out can never be handed out again, even if a
 * heading's text is edited twice. The map holds one small entry per
 * distinct slug; the component owns one module-level scope for the
 * session.
 */
export function createHeadingIdScope(): HeadingIdScope {
  const seen = new Map<string, number>();
  return {
    alloc(text: string): string {
      const base = slugifyHeading(text);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return count === 0 ? base : `${base}-${count}`;
    },
  };
}
