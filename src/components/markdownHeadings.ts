// Heading ids for rendered markdown (Decision 2, audit A4).
//
// These live apart from `MarkdownLink.tsx` for one reason: this file has no
// JSX, so `node --test` can import it and render a real document with
// `renderToString` — see `MarkdownLink.test.ts`. The A4 bug (the second note
// with an `# Introduction` rendering `introduction-1`, leaving its own
// `[Jump](#introduction)` pointing at nothing) was invisible to a source
// grep: the code looked right and the output was wrong.
//
// Shared markdown components render every h1-h6 with a stable, deduplicated id
// so `[Jump](#introduction)` scrolls to `# Introduction`. Raw HTML stays
// disabled.
//
// The id is allocated ONCE per mounted heading (the refs below) so it stays
// stable across re-renders — typing in the editor re-renders the preview, and
// the old render-phase allocation drifted (`introduction` → `introduction-1`
// → … on every keystroke). Dedup runs at allocation time, against the scope of
// the document being rendered: within that document an id handed out is never
// handed out again, so editing two headings to the same text cannot collide.
//
// The scope is per DOCUMENT, not per session. One scope for the whole session
// meant the second note to contain `# Introduction` was rendered as
// `introduction-1`, so that note's own `[Jump](#introduction)` scrolled nowhere
// — and the map grew by one entry per distinct slug for the life of the process.
// Each preview wraps its markdown in `MarkdownDocument`, so every note starts
// its headings at `introduction` and owns the anchors that name them.

import type { HTMLAttributes, ReactNode } from "react";
import {
  createContext,
  createElement,
  useContext,
  useMemo,
  useRef,
} from "react";
import type { Components } from "react-markdown";
import type { HeadingIdScope } from "../lib/headingIds.ts";
import { createHeadingIdScope } from "../lib/headingIds.ts";

function textFromChildren(children: ReactNode): string {
  if (children == null || typeof children === "boolean") return "";
  if (typeof children === "string" || typeof children === "number")
    return String(children);
  if (Array.isArray(children)) return children.map(textFromChildren).join("");
  if (typeof children === "object" && "props" in children) {
    return textFromChildren(
      (children as { props?: { children?: ReactNode } }).props?.children,
    );
  }
  return "";
}

export const HeadingScopeContext = createContext<HeadingIdScope | null>(null);

/**
 * The dedup scope of the markdown document rendered inside it.
 *
 * Pass something that identifies the document (a note id, a journal date) — a
 * new `documentKey` starts a fresh scope, which is what lets two notes each own
 * `#introduction`. Every `ReactMarkdown` in the app wraps itself in one of
 * these; `MarkdownLink.test.ts` renders two of them and fails unless each
 * document keeps its own `introduction`.
 */
export function MarkdownDocument({
  documentKey,
  children,
}: {
  documentKey: string;
  // Optional so `createElement(MarkdownDocument, { documentKey }, …children)`
  // type-checks: the element's children arrive as variadic arguments.
  children?: ReactNode;
}) {
  // Keyed on the document, not on the text: a keystroke must not restart the
  // ids (that is the drift the refs in `Heading` exist to prevent).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `documentKey` is the trigger, not an input — the factory must rebuild the scope only when the document changes.
  const scope = useMemo(() => createHeadingIdScope(), [documentKey]);
  return createElement(
    HeadingScopeContext.Provider,
    { value: scope },
    children,
  );
}

/**
 * Session-wide scope, used only by a preview that is not wrapped in a
 * `MarkdownDocument` — the pre-A4 behaviour, kept so an unwrapped caller still
 * renders ids instead of crashing. It is the bug this module exists to prevent,
 * which is why the wrapper is enforced by a test rather than by a convention.
 */
const unwrappedScope = createHeadingIdScope();

function makeHeading(tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
  function Heading(
    props: HTMLAttributes<HTMLHeadingElement> & {
      children?: ReactNode;
    },
  ) {
    const { children, ...rest } = props;
    const text = textFromChildren(children);
    const scope = useContext(HeadingScopeContext) ?? unwrappedScope;

    // Allocate once per mounted heading; re-allocate only when the text
    // itself changes (an edited heading is a new heading for id purposes).
    const idRef = useRef<string | null>(null);
    const textRef = useRef<string | null>(null);
    const scopeRef = useRef(scope);
    // Another document means a new scope, and the id in `idRef` belongs to the
    // old one. Dropping it makes this heading allocate from the new scope on
    // this render, in document order with its siblings — without this, a
    // heading whose text did not change kept the previous note's id and the
    // fresh scope never saw it, so the next duplicate heading reused that id.
    if (scopeRef.current !== scope) {
      scopeRef.current = scope;
      idRef.current = null;
    }
    if (idRef.current === null || textRef.current !== text) {
      idRef.current = scope.alloc(text);
      textRef.current = text;
    }
    const id = idRef.current as string;

    return createElement(tag, { ...rest, id }, children);
  }
  Heading.displayName = tag;
  return Heading;
}

export const headingComponents = {
  h1: makeHeading("h1"),
  h2: makeHeading("h2"),
  h3: makeHeading("h3"),
  h4: makeHeading("h4"),
  h5: makeHeading("h5"),
  h6: makeHeading("h6"),
} satisfies Components;
