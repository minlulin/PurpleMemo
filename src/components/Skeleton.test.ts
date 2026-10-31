// Batch-11 L3/L4 (docs/Arena_Findings_Batch11.md), pinned by reading the
// component's source — the same trick the page suites use, since `node --test`
// cannot mount a component.
//
//   L3  the single-text branch must APPLY `className` like every other branch:
//       the prop was accepted by the signature and silently dropped by exactly
//       the branch the default arguments select;
//   L4  DECIDED (decoration): a lone bar carries no `aria-busy`. The module
//       header says the bars themselves are hidden from assistive tech, and a
//       busy flag with no live region announces nothing. The rejected option —
//       giving the lone bar `role="status"` — would make every single-line
//       placeholder announce "Loading…", so its absence is pinned too, along
//       with the block keeping the busy flag the lone bar gave up.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("./Skeleton.tsx", import.meta.url), "utf8");

/**
 * The source of the lone-text early return, by brace matching — so the
 * assertions below cannot drift onto the stack branch they are about.
 */
function singleTextBranch(): string {
  const start = src.search(/if \(count <= 1 && variant === "text"\)/);
  assert.notEqual(
    start,
    -1,
    "Skeleton: the single-text branch is gone — renamed?",
  );
  const open = src.indexOf("{", start);
  assert.notEqual(open, -1, "Skeleton: the single-text branch has no body");
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("the single-text branch is not brace-balanced");
}

test("a single-text skeleton applies className like every other branch (L3)", () => {
  const branch = singleTextBranch();

  assert.ok(
    /\$\{className \?\? ""\}/.test(branch),
    "Skeleton: the single-text branch must apply `className` — it was the one branch that took the prop and dropped it",
  );
  assert.ok(
    branch.includes("barClass(variant, width)"),
    "Skeleton: and keep the bar's own classes ahead of it",
  );
  assert.ok(
    branch.includes(".trim()"),
    "Skeleton: join them the way the stack branch joins them — base class, space, className, then .trim(), never a trailing space",
  );
});

test("a lone text bar is decoration: no aria-busy, and it never announces (L4)", () => {
  const branch = singleTextBranch();

  assert.ok(
    !branch.includes("aria-busy"),
    "Skeleton: a lone bar carries no busy flag — with no live region it announces nothing, and the module header calls it decoration",
  );
  assert.ok(
    !branch.includes('role="status"'),
    'Skeleton: the rejected option stays rejected — a lone bar must not announce "Loading…" (DECISION, option 1)',
  );

  // Decoration is the LONE bar's rule only: the stack/card block is still the
  // busy loading region the module header describes.
  assert.match(
    src,
    /aria-busy="true"/,
    "Skeleton: the block must keep aria-busy",
  );
  assert.equal(
    (src.match(/aria-busy=/g) ?? []).length,
    1,
    "Skeleton: aria-busy belongs to the block alone — exactly one attribute in the file",
  );
});
