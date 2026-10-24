// The app shell's global keyboard shortcuts.
//
// These live in a React effect that `node --test` cannot mount, so the bindings
// are pinned by reading the shell source — the same trick `ipc.test.ts` uses on
// the IPC boundary.
//
// Why bother: the shortcut that failed in the installed app was invisible to
// every other check. `Ctrl+Shift+M` was labelled as such in the help overlay,
// and the handler asked for `ctrlKey && metaKey && shiftKey` — a chord no
// desktop keyboard sends, so the branch was dead on the one platform this app
// ships for. Nothing in the suite failed; the button beside it worked fine.
// The rules below are the ones that class of bug breaks.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const APP = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

/** The body of the shell's keydown handler, by brace matching. */
function shortcutHandler(): string {
  const start = APP.search(/const onKey = \(e: KeyboardEvent\) => \{/);
  assert.notEqual(start, -1, "the shell's onKey handler is gone");
  const open = APP.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < APP.length; i += 1) {
    if (APP[i] === "{") depth += 1;
    else if (APP[i] === "}") {
      depth -= 1;
      if (depth === 0) return APP.slice(start, i + 1);
    }
  }
  throw new Error("onKey body is not brace-balanced");
}

const HANDLER = shortcutHandler();

test("the capture shortcut fires on Ctrl+Shift+M alone, not a chord", () => {
  const branch = HANDLER.slice(HANDLER.indexOf('=== "m"'));
  assert.ok(branch.length > 0, "no capture shortcut in the handler");
  // The regression: `&&` between the two modifier flags. Ctrl+Meta is Cmd+Ctrl,
  // which nothing sends together on Windows or macOS.
  assert.doesNotMatch(
    branch,
    /e\.ctrlKey\s*&&\s*e\.metaKey/,
    "the capture shortcut demands Ctrl AND Meta, so it never fires on desktop",
  );
  assert.match(
    branch,
    /\(e\.ctrlKey \|\| e\.metaKey\)\s*&&\s*e\.shiftKey/,
    "capture must be (Ctrl or Cmd) + Shift",
  );
});

test("the lock shortcut accepts Ctrl OR Cmd", () => {
  const start = HANDLER.indexOf('=== "l"');
  assert.ok(start > -1, "no lock shortcut in the handler");
  const branch = HANDLER.slice(start, start + 220);
  assert.match(
    branch,
    /e\.ctrlKey \|\| e\.metaKey/,
    "locking must work with Cmd on macOS as well as Ctrl",
  );
});

test("Ctrl+K opens the global search dialog", () => {
  const start = HANDLER.indexOf('=== "k"');
  assert.ok(start > -1, "no global search shortcut in the handler");
  const branch = HANDLER.slice(start, start + 260);
  assert.match(branch, /e\.ctrlKey \|\| e\.metaKey/);
  assert.match(branch, /setSearchOpen\(true\)/);
  assert.match(APP, /data-shortcut="Ctrl\+K"[\s\S]{0,250}Search/);
  assert.match(APP, /<GlobalSearchDialog/);
});

test("every shortcut the help overlay lists is handled, and vice versa", () => {
  // `data-shortcut` is what the overlay scrapes, so a label with no handler is
  // a promise the app does not keep, and a handler with no label is a shortcut
  // nobody can find.
  const labels = [...APP.matchAll(/data-shortcut="([^"]+)"/g)].map(
    (m) => m[1] ?? "",
  );
  assert.ok(
    labels.length >= 4,
    `expected the four shell shortcuts, got ${labels.length}`,
  );
  const handled: { label: string; key: string; ctrl: boolean }[] = [
    { label: "Ctrl+L", key: "l", ctrl: true },
    { label: "Ctrl+K", key: "k", ctrl: true },
    { label: "Ctrl+Shift+M", key: "m", ctrl: true },
    { label: "?", key: "?", ctrl: false },
  ];
  for (const shortcut of handled) {
    assert.ok(
      labels.includes(shortcut.label),
      `${shortcut.label} is handled but nothing carries data-shortcut, so the help overlay cannot list it`,
    );
  }
  for (const label of labels) {
    const shortcut = handled.find((h) => h.label === label);
    assert.ok(
      shortcut,
      `${label} is advertised in the overlay but this test knows no handler for it — add both together`,
    );
    // A plain substring, not a regex: `?` is the literal key the handler
    // compares, and building a pattern from it would escape away its meaning.
    assert.ok(
      HANDLER.includes(`=== "${shortcut.key}"`),
      `the overlay lists ${label} but the handler never compares that key`,
    );
    if (shortcut.ctrl) {
      assert.match(
        HANDLER,
        /e\.ctrlKey \|\| e\.metaKey/,
        `${label} is labelled with Ctrl but no branch tests a modifier`,
      );
    }
  }
});

test("a shortcut never fires while the user is typing", () => {
  // Checked before any branch, so a capture shortcut cannot eat a keystroke
  // typed into the capture box itself.
  const typing = HANDLER.indexOf("const typing =");
  const firstBranch = HANDLER.indexOf("if (");
  const typingReturn = HANDLER.indexOf("if (typing) return;");
  assert.ok(typing > -1 && typingReturn > -1, "the typing guard is gone");
  assert.ok(
    typing < firstBranch && typingReturn < HANDLER.length,
    "the typing guard must come before the branches",
  );
});

test("a modal shortcut refuses to stack a second dialog", () => {
  assert.match(
    HANDLER,
    /document\.querySelector\("\[role=dialog\]"\) === null/,
    "the ?-overlay branch must not open on top of an open dialog; the capture dialog is one",
  );
});
