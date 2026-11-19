// Rendered-markdown links. A note is markdown the user — or the
// author of an imported backup — supplies, so a link can point anywhere. This
// component decides per click: real URLs go to the system browser through the
// opener plugin, in-document anchors scroll, everything else is inert. The
// Rust-side navigation guard cancels any navigation that still slips past.

import { openUrl } from "@tauri-apps/plugin-opener";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import type { Components } from "react-markdown";
import { isAndroidPlatform } from "../lib/android-reminders.ts";
import { openExternalUrl } from "../lib/externalLinks.ts";
import { routeLink } from "../lib/links.ts";
import { headingComponents } from "./markdownHeadings.ts";
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
          : `Opens in your default app: ${external}`)
      }
      rel="noreferrer noopener"
    >
      {children}
    </a>
  );
}

// The heading ids (and the per-document scope behind them) live in
// `markdownHeadings.ts`: a module with no JSX, so `node --test` can render real
// documents through it instead of asserting on this file's text. `MarkdownDocument`
// is re-exported because that is the name every preview imports from here.
export { MarkdownDocument } from "./markdownHeadings.ts";

/**
 * Shared `components` for every `ReactMarkdown` in the app: a preview can no
 * longer render markdown without the link rule, because there is one object to
 * pass rather than one behaviour to remember. The heading components carry the
 * ids that in-document anchors target.
 */
export const markdownComponents: Components = {
  a: MarkdownLink,
  ...headingComponents,
};

// Re-export the URL transform the app wires into every ReactMarkdown. A second
// name (`urlTransform`) had no caller at all and was removed — one name, one
// behaviour.
export { markdownUrlTransform } from "../lib/links.ts";
