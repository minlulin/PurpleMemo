// Every destructive action in the app is behind a two-step confirmation
// (review P2-10). Purple Memo has no Trash and no Undo, so a delete is final
// the instant it lands — a vault secret, a shopping list and its items, a
// habit's whole streak history, a loan with a balance, a note, a journal entry,
// a contact, a photo, a memory, a task, a reminder, a shop, a budget entry, a
// spending limit.
//
// The risk this file exists to catch is not a broken confirm button. It is the
// *next* destructive call someone adds and forgets to wrap: the rule is
// invisible, nothing in the type system objects, and the app quietly grows a
// control that deletes on one click among many that confirm.
//
// The mechanical form of the rule: **no destructive handler may be reachable
// from an `onClick`.** `onConfirm` is the only sanctioned way in. That is
// checkable, unlike "is it behind a dialog", and it is the exact shape the
// finding described — `onClick={() => void removeItem(item.id)}`.

import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const PAGES_DIR = new URL("./", import.meta.url);

/** Repository methods that destroy user data. `removeRef`/`removeTag` are exempt. */
const DESTRUCTIVE = /\b\w+Repo\.(delete\w*|remove\w*)\s*\(/g;

/**
 * The two exempt calls, and why. Both remove a *link* or a *label*, not data:
 * a photo and its note both survive `removeRef`, and `removeTag` deletes one
 * tag from one contact (`WHERE contact_id = ? AND tag = ?`) — re-addable with
 * the form sitting right beside the chip. A confirmation there is friction
 * without safety, and neither was on the finding's list of eight pages.
 */
const EXEMPT: [string, string][] = [
  [
    "galleryRepo.removeRef",
    "unlinks a note from a photo; both records survive",
  ],
  [
    "contactsRepo.removeTag",
    "removes one tag from one contact, beside the add-tag form",
  ],
];

const PAGES: [string, string][] = readdirSync(PAGES_DIR)
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => [f, readFileSync(new URL(f, PAGES_DIR), "utf8") as string]);

/** Marker for a call site that sits inside a callback prop, not a handler. */
const PROP_BOUNDARY = "<prop>";

/**
 * The name of the handler a call site sits in. Scans backwards for the nearest
 * `const x = (…)`, `function x(`, or callback prop (`onConfirm={`,
 * `onDelete={`) and returns whichever is closest.
 *
 * The props matter: a call written inline in `onConfirm={() => repo.delete(…)}`
 * is inside a JSX attribute, not inside a handler, and attributing it to
 * whatever handler was declared last produces a false positive against some
 * unrelated `onClick` many lines earlier. A prop boundary returns
 * {@link PROP_BOUNDARY} so the caller skips the onClick check — which is
 * correct, because `onConfirm` is the sanctioned entry point and has its own
 * test below.
 */
function enclosingHandler(src: string, at: number): string | null {
  const before = src.slice(0, at);
  const candidates: [number, string][] = [
    ...[
      ...before.matchAll(
        /(?:const (\w+) = (?:async )?\(|function (\w+)\s*\()/g,
      ),
    ].map((m) => [m.index, (m[1] ?? m[2] ?? "") as string] as [number, string]),
    ...[...before.matchAll(/on(?:Confirm|Delete)=\{/g)].map(
      (m) => [m.index, PROP_BOUNDARY] as [number, string],
    ),
  ];
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b[0] - a[0]);
  return candidates[0]?.[1] ?? null;
}

/** A handler's own source, by brace matching. */
function handlerSource(src: string, name: string): string {
  const start = src.search(
    new RegExp(`(?:const ${name} = (?:async )?\\(|function ${name}\\s*\\()`),
  );
  if (start === -1) return "";
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

/** Every handler in a page that calls a destructive repo method. */
function destructiveHandlers(): {
  file: string;
  handler: string;
  call: string;
}[] {
  const found: { file: string; handler: string; call: string }[] = [];
  for (const [file, src] of PAGES) {
    for (const match of src.matchAll(DESTRUCTIVE)) {
      const method = match[1] ?? "";
      if (EXEMPT.some(([exempt]) => exempt.endsWith(`.${method}`))) continue;
      const handler = enclosingHandler(src, match.index ?? 0);
      if (handler !== null && handler !== PROP_BOUNDARY) {
        found.push({ file, handler, call: method });
      }
    }
  }
  return found;
}

test("no destructive handler is reachable from an onClick", () => {
  const handlers = destructiveHandlers();
  assert.ok(
    handlers.length >= 23,
    `expected the full set of destructive handlers, found ${handlers.length}`,
  );
  const offenders: string[] = [];
  for (const { file, handler } of handlers) {
    const src = PAGES.find(([f]) => f === file)?.[1] ?? "";
    // Any direct click wiring: `onClick={... handler(...)}` in any shape.
    if (new RegExp(`onClick=\\{[^}]*\\b${handler}\\s*\\(`).test(src)) {
      offenders.push(`${file}: onClick reaches ${handler}`);
    }
  }
  assert.deepEqual(offenders, [], "destructive handlers wired to onClick");
});

test("every page that deletes something also renders a ConfirmButton", () => {
  // The coarse half of the same rule. If a destructive call appears in a file
  // with no confirm control at all, something was added and not wired.
  for (const [file, src] of PAGES) {
    DESTRUCTIVE.lastIndex = 0;
    const deletes = /Repo\.(delete\w*)\s*\(/.test(src);
    DESTRUCTIVE.lastIndex = 0;
    if (
      deletes &&
      !src.includes("Repo.removeRef") &&
      !src.includes("Repo.removeTag")
    ) {
      assert.ok(
        src.includes("<ConfirmButton"),
        `${file} deletes rows but renders no ConfirmButton`,
      );
    }
  }
});

test("the app has enough confirm controls for the destructive actions it has", () => {
  // A count, so "someone removed the confirms" fails even if every handler is
  // still referenced somewhere. 22 sites as of P2-9 (17 from P2-10, plus the
  // job/payable/recurring/wallet/category deletes P2-9 added).
  const wired = PAGES.reduce(
    (n, [, src]) => n + (src.match(/<ConfirmButton/g) ?? []).length,
    0,
  );
  assert.ok(wired >= 22, `expected >= 22 confirm controls, found ${wired}`);
});

test("the exempt calls are exempt on purpose, with a stated reason", () => {
  for (const [call, reason] of EXEMPT) {
    assert.match(call, /Repo\.\w+$/, `${call} is not a repository method`);
    assert.ok(reason.length > 20, `${call} needs a stated reason`);
  }
  // Each exempt method is still called, so the list cannot rot into a stale
  // exemption: if one is replaced by a real delete, or removed, this fails and
  // the decision gets made again instead of lingering.
  for (const [exempt] of EXEMPT) {
    const method = exempt.split(".")[1] ?? "";
    const called = PAGES.some(([, src]) =>
      new RegExp(`Repo\\.${method}\\s*\\(`).test(src),
    );
    assert.ok(called, `${exempt} is on the exempt list but nothing calls it`);
  }
});

test("a ConfirmButton's onConfirm always runs a handler, never an inline write", () => {
  // Keeps the confirm controls honest: `onConfirm` is a gate, not a place to
  // smuggle a second destructive statement past the arm step.
  for (const [file, src] of PAGES) {
    for (const match of src.matchAll(/onConfirm=\{([^}]*)\}/g)) {
      const body = match[1] ?? "";
      assert.doesNotMatch(
        body,
        DESTRUCTIVE,
        `${file}: onConfirm body calls a destructive repo method directly — route it through a named handler`,
      );
      DESTRUCTIVE.lastIndex = 0;
    }
  }
});

test("handlerSource is not silently returning nothing", () => {
  // Guards the guard: if the brace matcher broke, every `offenders` list above
  // would be empty and the whole file would pass vacuously.
  const src = PAGES.find(([f]) => f === "VaultPage.tsx")?.[1] ?? "";
  assert.ok(
    handlerSource(src, "removeItem").includes("vaultRepo.deleteItem"),
    "handlerSource must resolve a real handler",
  );
});

test("the handler scan attributes each destructive call to a real handler", () => {
  // The scan is how the onClick rule is enforced, so a scan that returns
  // `null` or a prop boundary for everything would pass the file vacuously.
  // Both of these are real handler call sites and must resolve as such.
  const vault = PAGES.find(([f]) => f === "VaultPage.tsx")?.[1] ?? "";
  const habits = PAGES.find(([f]) => f === "HabitsPage.tsx")?.[1] ?? "";
  const journal = PAGES.find(([f]) => f === "JournalPage.tsx")?.[1] ?? "";
  assert.equal(
    enclosingHandler(vault, vault.search(/vaultRepo\.deleteItem\(/)),
    "removeItem",
  );
  assert.equal(
    enclosingHandler(habits, habits.search(/habitsRepo\.deleteHabit\(/)),
    "removeHabit",
  );
  // `async function handleDelete()` — the `function` declaration form.
  assert.equal(
    enclosingHandler(journal, journal.search(/journalRepo\.deleteEntry\(/)),
    "handleDelete",
  );
});
