import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isOpenableUrl } from "./externalLinks.ts";

test("http and https links are openable", () => {
  assert.equal(isOpenableUrl("https://example.com/a?b=1#c"), true);
  assert.equal(isOpenableUrl("http://localhost:1420"), true);
  assert.equal(isOpenableUrl("HTTPS://EXAMPLE.COM"), true);
});

test("every other scheme is refused", () => {
  for (const value of [
    "javascript:alert(1)",
    "intent://scan/#Intent;scheme=zxing;end",
    "file:///etc/passwd",
    "content://com.android.contacts/contacts",
    "data:text/html,<script>alert(1)</script>",
    "mailto:someone@example.com",
    "tel:+15550100",
  ]) {
    assert.equal(isOpenableUrl(value), false, `${value} must not open`);
  }
});

test("relative and malformed values are refused", () => {
  for (const value of [
    "",
    "   ",
    "example.com",
    "/notes/1",
    " https://x.test",
  ]) {
    assert.equal(isOpenableUrl(value), false, `${JSON.stringify(value)}`);
  }
});
