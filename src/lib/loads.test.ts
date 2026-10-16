import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createLoadGuard } from "./loads.ts";

test("the newest load is current and older ones are not", () => {
  const g = createLoadGuard();
  const first = g.begin();
  const second = g.begin();
  assert.equal(g.isCurrent(second), true, "the newest load may use its result");
  assert.equal(
    g.isCurrent(first),
    false,
    "a superseded load must not write its result",
  );
});

test("results are stale after a cancel", () => {
  const g = createLoadGuard();
  const token = g.begin();
  g.cancel();
  assert.equal(g.isCurrent(token), false, "cancel invalidates in-flight loads");
});

test("a cancel also makes the next begin fresh", () => {
  const g = createLoadGuard();
  g.begin();
  g.cancel();
  const next = g.begin();
  assert.equal(g.isCurrent(next), true);
});

test("tokens never repeat, so an old token cannot look current later", () => {
  // The bug this guards against is not just "writes the wrong value" — a
  // reused token would let a stale result pass the check it should fail.
  const g = createLoadGuard();
  const seen = new Set<number>();
  for (let i = 0; i < 100; i++) seen.add(g.begin());
  assert.equal(seen.size, 100, "every token is distinct");
});
