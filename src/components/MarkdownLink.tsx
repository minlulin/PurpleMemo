// Rendered-markdown links (review L-01). A note is markdown the user — or the
// author of an imported backup — supplies, so a link can point anywhere. This
// component decides per click: real URLs go to the system browser through the
// opener plugin, in-document anchors scroll, everything else is inert. The
// Rust-side navigation guard cancels any navigation that still slips past.

import { openUrl } from "@tauri-apps/plugin-opener";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import type { Components } from "react-markdown";
import { routeLink } from "../lib/links.ts";
import { useToast } from "./Toast.tsx";

interface MarkdownLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  children?: ReactNode;
}

export function MarkdownLink({ href, children, title }: MarkdownLinkProps) {
  const toast = useToast();
  const route = routeLink(href);
  // Only this value is ever handed to the opener — never a raw `href`. The
  // schemes that reach here are exactly the ones `opener:allow-default-urls`
  // permits (http, https, mailto, tel), so the capability and the UI agree.
  const external =
    route === "external" && href !== undefined ? href : undefined;

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

/**
 * Shared `components` for every `ReactMarkdown` in the app: a preview can no
 * longer render markdown without the link rule, because there is one object to
 * pass rather than one behaviour to remember.
 */
export const markdownComponents: Components = { a: MarkdownLink };
