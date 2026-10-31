// Rendered-markdown links. A note is markdown the user — or the
// author of an imported backup — supplies, so a link can point anywhere. This
// component decides per click: real URLs go to the system browser through the
// opener plugin, in-document anchors scroll, everything else is inert. The
// Rust-side navigation guard cancels any navigation that still slips past.

import { openUrl } from "@tauri-apps/plugin-opener";
import type { AnchorHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { createElement, useEffect, useRef } from "react";
import type { Components } from "react-markdown";
import { routeLink } from "../lib/links.ts";
import { useToast } from "./Toast.tsx";

interface MarkdownLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  children?: ReactNode;
}

export function MarkdownLink({ href, children, title }: MarkdownLinkProps) {
  const toast = useToast();
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
        void openUrl(external).catch(() => {
          toast.error(
            `Could not open ${external} — this system has no handler for it.`,
          );
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
// so `[Jump](#introduction)` scrolls to `# Introduction`. Scoped per rendered
// document; raw HTML stays disabled.

function slugifyHeading(text: string): string {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "heading";
}

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

// Per-document dedup state. Reset when a new render pass begins (detected by
// an offset that moves backwards) or when all headings have unmounted.
const seenSlugs = new Map<string, number>();
let lastOffset = -1;
let mountCount = 0;

function allocHeadingId(text: string, offset: number): string {
  // Reset per-document state when a new render pass begins. Within one
  // document offsets strictly increase, so an offset that does not advance
  // (or an empty state) signals a fresh document — including a re-render of
  // a single-heading document.
  if (seenSlugs.size > 0 && offset <= lastOffset) {
    seenSlugs.clear();
    lastOffset = -1;
  }
  lastOffset = Math.max(lastOffset, offset);

  const base = slugifyHeading(text);
  const count = seenSlugs.get(base) ?? 0;
  seenSlugs.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function makeHeading(tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
  function Heading(
    props: HTMLAttributes<HTMLHeadingElement> & {
      node?: { position?: { start?: { offset?: number } } };
      children?: ReactNode;
    },
  ) {
    const { children, node, ...rest } = props;
    const offset = node?.position?.start?.offset ?? 0;
    const text = textFromChildren(children);

    // Allocate the id once per mounted heading so it stays stable across
    // re-renders (typing in the editor re-renders the preview). Module-level
    // dedup still runs at allocation time for mount-time uniqueness.
    const idRef = useRef<string | null>(null);
    const textRef = useRef<string | null>(null);
    if (idRef.current === null || textRef.current !== text) {
      idRef.current = allocHeadingId(text, offset);
      textRef.current = text;
    }
    const id = idRef.current as string;

    // Track mounts so the per-document state can be released for client renders.
    const mounted = useRef(false);
    useEffect(() => {
      if (!mounted.current) {
        if (mountCount === 0) seenSlugs.clear();
        mountCount += 1;
        mounted.current = true;
      }
      return () => {
        if (mounted.current) {
          mountCount = Math.max(0, mountCount - 1);
          mounted.current = false;
          if (mountCount === 0) {
            seenSlugs.clear();
            lastOffset = -1;
          }
        }
      };
    }, []);

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

// Re-export the URL transform under the names callers/tests may use.
export { markdownUrlTransform, urlTransform } from "../lib/links.ts";
