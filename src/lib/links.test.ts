// Link routing (review L-01): only real URLs may leave the app, and they leave
// it through the system browser; everything else — including anything that
// would resolve against the app's own origin — is inert.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { opensExternally, routeLink } from "./links.ts";

test("routeLink: http/https/mailto/tel go to the system, never in-app", () => {
  for (const href of [
    "https://example.com",
    "https://example.com/a/b?c=1#d",
    "http://localhost:9999/",
    "mailto:someone@example.com",
    "tel:+15550100",
  ]) {
    assert.equal(routeLink(href), "external", href);
  }
});

test("routeLink: in-document anchors may scroll, and cannot navigate away", () => {
  assert.equal(routeLink("#section"), "hash");
  assert.equal(routeLink("  #top  "), "hash");
});

test("routeLink: dangerous schemes are blocked, not opened", () => {
  for (const href of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "ftp://example.com/x",
    "vbscript:msgbox(1)",
    "blob:https://example.com/uuid",
  ]) {
    assert.equal(routeLink(href), "blocked", href);
  }
});

test("routeLink: relative and empty hrefs are blocked", () => {
  for (const href of [
    "",
    "   ",
    "docs/page.html",
    "./note.md",
    "../other.html",
    "/index.html",
    "index.html",
    "//evil.example/x",
  ]) {
    assert.equal(routeLink(href), "blocked", JSON.stringify(href));
  }
  assert.equal(routeLink(null), "blocked");
  assert.equal(routeLink(undefined), "blocked");
});

test("opensExternally: only the external route calls the opener", () => {
  assert.equal(opensExternally("external"), true);
  assert.equal(opensExternally("hash"), false);
  assert.equal(opensExternally("blocked"), false);
});
