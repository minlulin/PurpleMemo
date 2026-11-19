import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isOpenableUrl } from "./externalLinks.ts";
import { routeLink } from "./links.ts";

test("the four offered schemes are openable", () => {
  assert.equal(isOpenableUrl("https://example.com/a?b=1#c"), true);
  assert.equal(isOpenableUrl("http://localhost:1420"), true);
  assert.equal(isOpenableUrl("HTTPS://EXAMPLE.COM"), true);
  assert.equal(isOpenableUrl("mailto:someone@example.com"), true);
  assert.equal(isOpenableUrl("tel:+15550100"), true);
});

test("every other scheme is refused", () => {
  for (const value of [
    "javascript:alert(1)",
    "intent://scan/#Intent;scheme=zxing;end",
    "file:///etc/passwd",
    "content://com.android.contacts/contacts",
    "data:text/html,<script>alert(1)</script>",
  ]) {
    assert.equal(isOpenableUrl(value), false, `${value} must not open`);
  }
});

test("a scheme with no target is refused", () => {
  for (const value of ["tel:", "mailto:", "TEL:", "MAILTO:"]) {
    assert.equal(isOpenableUrl(value), false, value);
  }
});

test("relative and malformed values are refused", () => {
  for (const value of [
    "",
    "   ",
    "example.com",
    "/notes/1",
    " https://x.test",
    "tel:+15550100\n",
  ]) {
    assert.equal(isOpenableUrl(value), false, `${JSON.stringify(value)}`);
  }
});

test("routing and the phone opener agree on every scheme", () => {
  // The drift guard for the two layers: `routeLink` decides a link is external
  // on desktop, while the phone's opener decides it may start an intent. A
  // scheme that one accepts and the other refuses is a link that works on the
  // desktop and fails on the phone — exactly the bug this matrix prevents.
  const matrix: [string, boolean][] = [
    ["https://example.com", true],
    ["http://example.com", true],
    ["mailto:someone@example.com", true],
    ["tel:+15550100", true],
    ["javascript:alert(1)", false],
    ["file:///etc/passwd", false],
    ["ftp://example.com/x", false],
    ["example.com", false],
    ["#section", false],
  ];
  for (const [href, openable] of matrix) {
    assert.equal(
      routeLink(href) === "external",
      openable,
      `routeLink disagrees for ${href}`,
    );
    assert.equal(isOpenableUrl(href), openable, `isOpenableUrl for ${href}`);
  }
});
