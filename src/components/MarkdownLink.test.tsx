import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { markdownComponents, markdownUrlTransform } from "./MarkdownLink.tsx";

function render(md: string): string {
  return renderToStaticMarkup(
    h(
      ReactMarkdown,
      { components: markdownComponents, urlTransform: markdownUrlTransform },
      md,
    ),
  );
}

test("rendered tel: link is not stripped and routes external", () => {
  const html = render("[phone](tel:+15550100)");
  assert.match(html, /href="tel:\+15550100"/);
});

test("rendered javascript:/data:/relative links are blocked", () => {
  for (const md of [
    "[x](javascript:alert(1))",
    "[x](data:text/html,hi)",
    "[x](relative/path)",
  ]) {
    const html = render(md);
    assert.doesNotMatch(html, /href="javascript:/);
    assert.match(html, /href=""/);
  }
});

test("rendered uppercase HTTPS:// link keeps a normalized href", () => {
  const html = render("[x](HTTPS://example.com)");
  assert.match(html, /href="https:\/\/example\.com\/?"/);
});

test("duplicate headings get deduplicated ids", () => {
  const html = render("# Introduction\n\n# Introduction");
  assert.match(html, /<h1[^>]*id="introduction"/);
  assert.match(html, /<h1[^>]*id="introduction-1"/);
});

test("single-heading id is stable across re-renders", () => {
  const html1 = render("# Introduction");
  const html2 = render("# Introduction");
  assert.equal(html1, html2);
  assert.match(html1, /<h1[^>]*id="introduction"/);
});
