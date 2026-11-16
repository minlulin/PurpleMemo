// Rendered-markdown links. A note is markdown the user — or the
// author of an imported backup — supplies, so a link can point anywhere. This
// component decides per click: real URLs go to the system browser through the
// opener plugin, in-document anchors scroll, everything else is inert. The
// Rust-side navigation guard cancels any navigation that still slips past.

import { openUrl } from "@tauri-apps/plugin-opener";
import type { AnchorHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import {
  createContext,
  createElement,
  useContext,
  useMemo,
  useRef,
} from "react";
import type { Components } from "react-markdown";
import { isAndroidPlatform } from "../lib/android-reminders.ts";
import { openExternalUrl } from "../lib/externalLinks.ts";
import type { HeadingIdScope } from "../lib/headingIds.ts";
import { createHeadingIdScope } from "../lib/headingIds.ts";
import { routeLink } from "../lib/links.ts";
import { useToast } from "./Toast.tsx";
import { useT } from "./useTranslation.ts";

interface MarkdownLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  children?: ReactNode;
}

export function MarkdownLink({ href, children, title }: MarkdownLinkProps) {
  const toast = useToast();
  const t = useT();
  const route = routeLink(href);
  // Hand a normalized URL to the opener: `new URL(href).href` lowercases the
  // scheme (and host) so an uppercase `HTTPS://…` matches the opener's
  // lowercase, case-sensitive scope glob. The schemes that reach here are
  // exactly the ones `opener:allow-default-urls` permits.
  const external =
    route === "external" && href !== undefined ? new URL(href).href : undefined;

  return (
    <a
      href={href}
      onClick={(event) => {
        // An in-document anchor may scroll — it cannot leave the app.
        if (route === "hash") return;
        event.preventDefault();
        if (external === undefined) return;
        // Android has no opener plugin (docs/ANDROID_IPC_SURFACE.md finding #3):
        // the phone hands the URL to its own VIEW-intent command instead.
        const opening = isAndroidPlatform()
          ? openExternalUrl(external)
          : openUrl(external);
        void opening.catch(() => {
          toast.error(t("markdown.linkFailed", { url: external }));
        });
      }}
      title={
        title ??
        (external === undefined
          ? undefined
          : `Opens in your default browser: ${external}`)
      }
      rel="noreferrer noopener"
    >
      {children}
    </a>
  );
}

// --- Heading ids (Decision 2) ---------------------------------------------
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
// The scope is per DOCUMENT, not per session (audit A4). One scope for the whole
// session meant the second note to contain `# Introduction` was rendered as
// `introduction-1`, so that note's own `[Jump](#introduction)` scrolled nowhere
// — and the map grew by one entry per distinct slug for the life of the process.
// Each preview wraps its markdown in `MarkdownDocument`, so every note starts
// its headings at `introduction` and owns the anchors that name them.

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

const HeadingScopeContext = createContext<HeadingIdScope | null>(null);

/**
 * The dedup scope of the markdown document rendered inside it.
 *
 * Pass something that identifies the document (a note id, a journal date) — a
 * new `documentKey` starts a fresh scope, which is what lets two notes each own
 * `#introduction`. Every `ReactMarkdown` in the app wraps itself in one of
 * these; `MarkdownLink.test.ts` fails if a new call site forgets to.
 */
export function MarkdownDocument({
  documentKey,
  children,
}: {
  documentKey: string;
  children: ReactNode;
}) {
  // Keyed on the document, not on the text: a keystroke must not restart the
  // ids (that is the drift the refs in `Heading` exist to prevent).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `documentKey` is the trigger, not an input — the factory must rebuild the scope only when the document changes.
  const scope = useMemo(() => createHeadingIdScope(), [documentKey]);
  return (
    <HeadingScopeContext.Provider value={scope}>
      {children}
    </HeadingScopeContext.Provider>
  );
}

/**
 * Session-wide scope, used only by a preview that is not wrapped in a
 * `MarkdownDocument` — the pre-A4 behaviour, kept so an unwrapped caller still
 * renders ids instead of crashing. It is the bug this file now fixes, which is
 * why the wrapper is enforced by a test rather than by a convention.
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

const h1 = makeHeading("h1");
const h2 = makeHeading("h2");
const h3 = makeHeading("h3");
const h4 = makeHeading("h4");
const h5 = makeHeading("h5");
const h6 = makeHeading("h6");

/**
 * Shared `components` for every `ReactMarkdown` in the app: a preview can no
 * longer render markdown without the link rule, because there is one object to
 * pass rather than one behaviour to remember.
 */
export const markdownComponents: Components = {
  a: MarkdownLink,
  h1,
  h2,
  h3,
  h4,
  h5,
  h6,
};

// Re-export the URL transform the app wires into every ReactMarkdown. A second
// name (`urlTransform`) had no caller at all and was removed — one name, one
// behaviour.
export { markdownUrlTransform } from "../lib/links.ts";
