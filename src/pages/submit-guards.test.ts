// Money-submit guards (review P2-11). These handlers live in page components,
// which `node --test` cannot mount, so the guard is pinned by reading the page
// source — the same trick `ipc.test.ts` uses on the IPC boundary and
// `thumbs.test.ts` on the thumbnail decode.
//
// What is being asserted is the *shape* of each guard, not React's behaviour:
//
//   1. the handler returns early when its own busy flag is set,
//   2. the flag is raised BEFORE the first `await` — a guard set after the
//      write has started is a guard that arrives too late,
//   3. the flag is cleared in `finally`, so a rejected write cannot wedge the
//      form shut for the rest of the session,
//   4. the button that triggers it reads the flag in `disabled`, which is the
//      half that actually stops the second click.
//
// Why it matters here specifically: `recordJobPayment` and `recordRepayment`
// serialize per row behind a keyed mutex and re-read the row INSIDE it, so a
// duplicate FULL payment is clamped to zero and skipped (pinned in
// business.test.ts). A duplicate PARTIAL payment is legitimately applicable a
// second time and books a second receipt. No layer below the UI can tell a
// retry from a second click — the guard has to be here.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function readPage(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
}

/**
 * The source of one handler, by brace matching. Handles both
 * `const name = (…) =>` and `function name(…)` forms, and does not care how the
 * body is wrapped or formatted — which a regex over the whole file would.
 */
function handlerSource(src: string, name: string): string {
  const declaration = new RegExp(
    `(const ${name} = (async )?\\(|function ${name}\\()`,
  );
  const start = src.search(declaration);
  assert.notEqual(start, -1, `${name} not found — renamed or removed?`);
  const open = src.indexOf("{", start);
  assert.notEqual(open, -1, `${name} has no body`);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} body is not brace-balanced`);
}

/** Every `await` in a handler body, in source order. */
function firstAwaitIndex(body: string): number {
  return body.search(/\bawait\b/);
}

const GUARDS: {
  page: string;
  handler: string;
  /** The busy expression the handler checks and the button renders. */
  busy: string;
  /** How the flag is released. */
  cleared: string;
  /** The label the button swaps to while in flight, if any. */
  label?: string;
}[] = [
  {
    page: "BusinessPage.tsx",
    handler: "addJob",
    busy: "savingRef.current",
    cleared: "setSaving(false)",
    label: "Adding…",
  },
  {
    page: "BusinessPage.tsx",
    handler: "pay",
    busy: "payingId === jobId",
    cleared: "setPayingId(null)",
    label: "Saving…",
  },
  {
    page: "BusinessPage.tsx",
    handler: "addPayable",
    busy: "savingRef.current",
    cleared: "setSaving(false)",
    label: "Adding…",
  },
  {
    page: "LoansPage.tsx",
    handler: "addLoan",
    busy: "savingRef.current",
    cleared: "setSaving(false)",
    label: "Adding…",
  },
  {
    page: "LoansPage.tsx",
    handler: "repay",
    busy: "payingId === id",
    cleared: "setPayingId(null)",
    label: "Saving…",
  },
];

test("every money-submit handler refuses a second submit while one is in flight", () => {
  for (const guard of GUARDS) {
    const body = handlerSource(readPage(guard.page), guard.handler);
    const where = `${guard.page} ${guard.handler}`;

    // 1. The early return, before any validation or write.
    const check = body.indexOf(guard.busy);
    assert.notEqual(check, -1, `${where}: no busy check`);
    assert.match(
      body,
      new RegExp(`if \\(${guard.busy.replace(/[.()]/g, "\\$&")}\\)\\s*return;`),
      `${where}: the busy check must be an early return, not a condition on the write`,
    );
    assert.ok(
      check < body.indexOf("Repo."),
      `${where}: check the flag before touching the repo`,
    );
  }
});

test("the flag is raised before the first await, and cleared in finally", () => {
  for (const guard of GUARDS) {
    const body = handlerSource(readPage(guard.page), guard.handler);
    const where = `${guard.page} ${guard.handler}`;
    const raised = guard.cleared.startsWith("setSaving")
      ? "setSaving(true)"
      : guard.handler === "pay" && guard.page === "BusinessPage.tsx"
        ? "setPayingId(jobId)"
        : guard.handler === "repay"
          ? "setPayingId(id)"
          : "setSaving(true)";
    const raiseAt = body.indexOf(raised);
    assert.notEqual(raiseAt, -1, `${where}: never raises ${raised}`);
    const awaitAt = firstAwaitIndex(body);
    assert.notEqual(awaitAt, -1, `${where}: has no await to guard`);
    assert.ok(
      raiseAt < awaitAt,
      `${where}: raises the flag after the first await — too late to stop the second click`,
    );

    // 3. Cleared in `finally`, so a rejected write does not wedge the form.
    const finallyAt = body.indexOf("} finally {");
    assert.notEqual(finallyAt, -1, `${where}: no finally block`);
    const tail = body.slice(finallyAt);
    assert.ok(
      tail.includes(guard.cleared),
      `${where}: ${guard.cleared} must be in the finally block`,
    );
    assert.ok(
      !body.slice(0, finallyAt).includes(guard.cleared),
      `${where}: ${guard.cleared} outside finally — a rejected write would leave it stuck`,
    );
  }
});

test("the button that triggers each guarded handler reads the flag", () => {
  // The half that actually stops the click. A guard with no `disabled` still
  // lets a fast second click through, because the closure that would reject it
  // is only replaced once React has re-rendered.
  const src = readPage("LoansPage.tsx");
  assert.match(
    src,
    /disabled=\{\s*payingId === l\.id \|\|/,
    "LoansPage's repayment button must disable while its row is paying",
  );
  assert.match(src, /disabled=\{\s*saving \|\|/);

  const business = readPage("BusinessPage.tsx");
  assert.match(
    business,
    /disabled=\{\s*payingId === j\.id \|\|/,
    "the job payment button must disable while its row is paying",
  );
  assert.match(
    business,
    /disabled=\{\s*payingId === p\.id \|\|/,
    "the payable button must disable while its row is paying",
  );
  assert.equal(
    (business.match(/disabled=\{\s*saving \|\|/g) ?? []).length,
    2,
    "both BusinessPage forms (job, payable) must disable while saving",
  );
});

test("an in-flight submit says so on the button, not just by going grey", () => {
  // Grey-only is ambiguous on a money form: the user cannot tell whether the
  // click registered. Every guarded button swaps its label.
  const pages = {
    loans: readPage("LoansPage.tsx"),
    business: readPage("BusinessPage.tsx"),
  };
  for (const src of Object.values(pages)) {
    assert.match(src, /"Saving…"/);
    assert.match(src, /"Adding…"/);
  }
});

// -- The draft discard path (review P2-6) ------------------------------------------
// Same source-reading approach, for the same reason: the discard handlers live
// in page components. This one is a *real* interleaving, not a style rule.

test("a draft can never be discarded while a save is in flight", () => {
  // Both editors snapshot the editor, await, then decide whether to KEEP a
  // draft by comparing the CURRENT editor against that snapshot. A discard in
  // between puts the pre-save row text into the editor, so that comparison
  // reads "the editor moved on" and the save re-persists the draft the user
  // had just thrown away — and the editor sits there showing it as unsaved
  // work, restored again on the next visit.
  //
  // Refusing the two actions from overlapping is the fix. It is asserted in two
  // places on purpose: the guard is the invariant, the `disabled` is what stops
  // the click, and a guard alone still lets a fast click through because the
  // rejecting closure only exists after a re-render.
  for (const page of ["NotesPage.tsx", "JournalPage.tsx"]) {
    const src = readPage(page);
    const body = handlerSource(src, "handleDiscardDraft");
    assert.match(
      body,
      /if \(saving/,
      `${page}: handleDiscardDraft must refuse while a save is in flight`,
    );
    // ...and the refusal must come before any state is touched or any write is
    // issued, or the discard has already half-happened.
    assert.ok(
      body.indexOf("if (saving") < body.search(/\bset[A-Z]/),
      `${page}: check saving before touching editor state`,
    );
    assert.match(
      src,
      /title="Discard the unsaved draft[^"]*"\s*\n\s*disabled=\{(p\.)?saving\}/,
      `${page}: the Discard button must be disabled while saving`,
    );
  }
});

test("the discard reloads the stored row through the tested helper", () => {
  // NotesPage used to rebuild the editor inline, which is why the destructive
  // step had no reachable coverage at all.
  const src = readPage("NotesPage.tsx");
  assert.match(
    handlerSource(src, "handleDiscardDraft"),
    /const rowFields = noteRowToEditor\(selected\)/,
    "the discard must go through noteRowToEditor",
  );
});
