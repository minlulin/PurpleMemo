import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isUid, newUid } from "./uid.ts";

const V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("newUid: canonical lowercase UUID v4, every time", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i += 1) {
    const uid = newUid();
    assert.match(uid, V4, `${uid} is not a UUID v4`);
    assert.equal(uid, uid.toLowerCase(), "the contract stores lowercase");
    assert.equal(uid.length, 36);
    assert.ok(!seen.has(uid), `collision after ${i} draws: ${uid}`);
    seen.add(uid);
  }
});

test("newUid: the fallback path (no crypto.randomUUID) is the same recipe", () => {
  // A webview without `randomUUID` must not lose the user's record, so the
  // helper falls back to `getRandomValues` instead of throwing. Pinned by
  // removing the method for the duration of the call.
  const original = crypto.randomUUID;
  try {
    // @ts-expect-error — deleting a method to simulate an older webview.
    delete crypto.randomUUID;
    for (let i = 0; i < 50; i += 1) assert.match(newUid(), V4);
  } finally {
    crypto.randomUUID = original;
  }
});

test("isUid: accepts what newUid mints and refuses everything else", () => {
  assert.equal(isUid(newUid()), true);
  assert.equal(isUid("not-a-uid"), false);
  assert.equal(isUid(""), false);
  assert.equal(isUid(null), false);
  assert.equal(isUid(undefined), false);
  assert.equal(isUid(42), false);
  // Uppercase and non-v4 versions are not the stored shape.
  assert.equal(isUid("3F2504E0-4F89-41D3-9A0C-0305E82C3301"), false);
  assert.equal(isUid("3f2504e0-4f89-11d3-9a0c-0305e82c3301"), false);
});
