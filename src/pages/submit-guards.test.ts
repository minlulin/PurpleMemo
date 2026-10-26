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
  // `../App.tsx` is reachable on purpose: the shell's quick-capture dialog is a
  // second capture form, and an unpinned guard there would be the one a
  // double-click gets through.
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
  /**
   * What raises the flag, when the shape is not one of the two the table below
   * infers from `cleared`. A per-row flag keeps the row id, which neither
   * `setSaving` nor `setPayingId` describes.
   */
  raised?: string;
  /** The label the button swaps to while in flight, if any. */
  label?: string;
  /** For localized pages: the message key rendered through `t(...)`. */
  labelKey?: string;
}[] = [
  {
    page: "BusinessPage.tsx",
    handler: "addJob",
    busy: "savingRef.current",
    cleared: "setSaving(false)",
    label: "Saving…",
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
    label: "Saving…",
  },
  {
    page: "LoansPage.tsx",
    handler: "addLoan",
    busy: "savingRef.current",
    cleared: "setSaving(false)",
    label: "Saving…",
  },
  {
    page: "LoansPage.tsx",
    handler: "repay",
    busy: "payingId === id",
    cleared: "setPayingId(null)",
    label: "Saving…",
  },
  // Quick capture. Capture and conversion are the two writes here,
  // and the conversion guard is per row so one row's click does not lock the
  // list — the reason it needs an explicit `raised`.
  {
    page: "InboxPage.tsx",
    handler: "capture",
    busy: "savingRef.current",
    cleared: "setSaving(false)",
    labelKey: "inbox.capturing",
  },
  {
    page: "InboxPage.tsx",
    handler: "convert",
    busy: "convertingRef.current !== null",
    cleared: "setConvertingId(null)",
    raised: "setConvertingId(row.id)",
    labelKey: "inbox.converting",
  },
  // The shell's capture dialog — the path a user actually takes, since the
  // shortcut works from every page.
  {
    page: "../App.tsx",
    handler: "submitCapture",
    busy: "capturingRef.current",
    cleared: "setCapturing(false)",
    raised: "setCapturing(true)",
    labelKey: "capture.capturing",
  },
  // Today's actions. Not money, but the failure they guard against
  // is the same class: double-clicking Complete on a repeating task rolls its
  // due date two periods forward from one click pair. Every action shares one
  // per-row flag that is raised before the first await and cleared in finally.
  {
    page: "DashboardPage.tsx",
    handler: "completeTask",
    busy: "busyRow !== null",
    cleared: "setBusyRow(null)",
    raised: `setBusyRow(\`task:\${task.id}\`)`,
  },
  {
    page: "DashboardPage.tsx",
    handler: "rescheduleTask",
    busy: "busyRow !== null",
    cleared: "setBusyRow(null)",
    raised: `setBusyRow(\`task:\${task.id}\`)`,
  },
  {
    page: "DashboardPage.tsx",
    handler: "snoozeReminder",
    busy: "busyRow !== null",
    cleared: "setBusyRow(null)",
    raised: `setBusyRow(\`rem:\${r.id}\`)`,
  },
  {
    page: "DashboardPage.tsx",
    handler: "acknowledgeReminder",
    busy: "busyRow !== null",
    cleared: "setBusyRow(null)",
    raised: `setBusyRow(\`rem:\${r.id}\`)`,
  },
  // Tasks & reminders (review P2-3 / P3-6): the Tasks page mirrors Today's
  // per-row flag for Complete/Reopen/remove — a second Complete on a
  // repeating task rolls its due date two periods from one intent — and the
  // two create forms carry the pinned savingRef shape. `remove` resolves to
  // the task-row handler: it is declared first in the file, ahead of
  // RemindersSection's own `remove`.
  {
    page: "TasksPage.tsx",
    handler: "complete",
    busy: "busyRow !== null",
    cleared: "setBusyRow(null)",
    raised: `setBusyRow(\`task:\${t.id}\`)`,
  },
  {
    page: "TasksPage.tsx",
    handler: "reopen",
    busy: "busyRow !== null",
    cleared: "setBusyRow(null)",
    raised: `setBusyRow(\`task:\${t.id}\`)`,
  },
  {
    page: "TasksPage.tsx",
    handler: "remove",
    busy: "busyRow !== null",
    cleared: "setBusyRow(null)",
    raised: `setBusyRow(\`task:\${id}\`)`,
  },
  {
    page: "TasksPage.tsx",
    handler: "addTask",
    busy: "savingRef.current",
    cleared: "setSaving(false)",
  },
  {
    page: "TasksPage.tsx",
    handler: "add",
    busy: "savingRef.current",
    cleared: "setSaving(false)",
  },
  // Recurring rule form (review P2-4): a plain INSERT below, so a double
  // submit becomes a duplicate rule that double-books through `markPaid`.
  {
    page: "BudgetPage.tsx",
    handler: "createRule",
    busy: "savingRef.current",
    cleared: "setSaving(false)",
  },
  // Create/edit forms (review P3-6): same ref/state shape, same reason — a
  // double submit makes a duplicate row, and no layer below the UI can tell
  // a retry from a second click. `addItem` resolves to ShoppingPage's own
  // handler: it is declared first in that file.
  {
    page: "ContactsPage.tsx",
    handler: "addContact",
    busy: "savingRef.current",
    cleared: "setSaving(false)",
  },
  {
    page: "ShoppingPage.tsx",
    handler: "addList",
    busy: "savingRef.current",
    cleared: "setSaving(false)",
  },
  {
    page: "ShoppingPage.tsx",
    handler: "addItem",
    busy: "savingRef.current",
    cleared: "setSaving(false)",
  },
  {
    page: "HabitsPage.tsx",
    handler: "addHabit",
    busy: "savingRef.current",
    cleared: "setSaving(false)",
  },
  {
    page: "MemoriesPage.tsx",
    handler: "submitForm",
    busy: "savingRef.current",
    cleared: "setSaving(false)",
  },
  {
    page: "BusinessPage.tsx",
    handler: "addShop",
    busy: "savingRef.current",
    cleared: "setSaving(false)",
  },
  {
    page: "BusinessPage.tsx",
    handler: "saveEdit",
    busy: "savingRef.current",
    cleared: "setSaving(false)",
  },
  // Factory reset. A second engine run would race the first
  // one's file deletions mid-flight; the engine is safe to RE-RUN after a
  // partial reset but not to run concurrently. It calls no repo — it invokes
  // the reset engine through the driver — so this entry is also why the
  // ordering check above accepts a first `await` in place of `Repo.`.
  {
    page: "SettingsPage.tsx",
    handler: "runFactoryReset",
    busy: "resettingRef.current",
    cleared: "setResetting(false)",
    raised: "setResetting(true)",
  },
  // Settings' async actions: backup export, import,
  // key export, share start/stop, update check/install. One page-level
  // savingRef covers all seven — `shows(section)` mounts one section at a
  // time, so two of these can never be in flight together — and each keeps
  // its own busy state for the button. These handlers await a native
  // dialog or a repo call, so the ordering check has real teeth: a second
  // click while the save dialog is open would queue a second export or a
  // second listener bind.
  {
    page: "SettingsPage.tsx",
    handler: "doExport",
    busy: "savingRef.current",
    cleared: "savingRef.current = false",
    raised: "savingRef.current = true",
  },
  {
    page: "SettingsPage.tsx",
    handler: "confirmImport",
    busy: "savingRef.current",
    cleared: "savingRef.current = false",
    raised: "savingRef.current = true",
  },
  {
    page: "SettingsPage.tsx",
    handler: "exportKey",
    busy: "savingRef.current",
    cleared: "savingRef.current = false",
    raised: "savingRef.current = true",
  },
  {
    page: "SettingsPage.tsx",
    handler: "startShare",
    busy: "savingRef.current",
    cleared: "savingRef.current = false",
    raised: "savingRef.current = true",
  },
  {
    page: "SettingsPage.tsx",
    handler: "stopShare",
    busy: "savingRef.current",
    cleared: "savingRef.current = false",
    raised: "savingRef.current = true",
  },
  {
    page: "SettingsPage.tsx",
    handler: "checkUpdates",
    busy: "savingRef.current",
    cleared: "savingRef.current = false",
    raised: "savingRef.current = true",
  },
  {
    page: "SettingsPage.tsx",
    handler: "installNow",
    busy: "savingRef.current",
    cleared: "savingRef.current = false",
    raised: "savingRef.current = true",
  },
  // The readable-exports page: the build walks the whole database, so a
  // second click during the save dialog queues a second full export.
  {
    page: "ExportsPage.tsx",
    handler: "doExport",
    busy: "busyRef.current",
    cleared: "busyRef.current = false",
    raised: "busyRef.current = true",
  },
  // The very first-run form in the app: double-clicking Create PIN would
  // race the first write of the PIN hash, and the success path unmounts
  // this screen — a second submit in between has nowhere to report.
  {
    page: "../components/LockScreens.tsx",
    handler: "submit",
    busy: "submittingRef.current",
    cleared: "submittingRef.current = false",
    raised: "submittingRef.current = true",
  },
  // CSV import dialog: duplicate policy is "always insert as new", so a fast
  // second click on Confirm before React re-renders would insert the whole CSV
  // batch twice; and clicking Download template while the native save dialog is
  // open would queue a second dialog + write.
  {
    page: "../components/ImportDialog.tsx",
    handler: "confirm",
    busy: "runningRef.current",
    cleared: "runningRef.current = false",
    raised: "runningRef.current = true",
    labelKey: "import.importing",
  },
  {
    page: "../components/ImportDialog.tsx",
    handler: "downloadTemplate",
    busy: "downloadingRef.current",
    cleared: "downloadingRef.current = false",
    raised: "downloadingRef.current = true",
    labelKey: "import.savingTemplate",
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
    // Ordering against the data layer. Handlers that talk to a repo must
    // check the flag first; the factory-reset handler (below) talks to the
    // reset engine through the driver instead and has no `Repo.` call at
    // all — for those the same rule is checked against its first `await`.
    const dataTouch = body.indexOf("Repo.");
    if (dataTouch !== -1) {
      assert.ok(
        check < dataTouch,
        `${where}: check the flag before touching the repo`,
      );
    } else {
      assert.ok(
        check < firstAwaitIndex(body),
        `${where}: check the flag before the first await`,
      );
    }
  }
});

test("the flag is raised before the first await, and cleared in finally", () => {
  for (const guard of GUARDS) {
    const body = handlerSource(readPage(guard.page), guard.handler);
    const where = `${guard.page} ${guard.handler}`;
    const raised =
      guard.raised ??
      (guard.cleared.startsWith("setSaving")
        ? "setSaving(true)"
        : guard.handler === "pay" && guard.page === "BusinessPage.tsx"
          ? "setPayingId(jobId)"
          : guard.handler === "repay"
            ? "setPayingId(id)"
            : "setSaving(true");
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
    4,
    "all four BusinessPage forms (job, payable, shop, shop edit) must disable while saving",
  );

  // Tasks (review P2-3): every row action's button reads the shared flag, and
  // both create forms read their saving state.
  const tasks = readPage("TasksPage.tsx");
  assert.ok(
    (tasks.match(/disabled=\{busyRow !== null\}/g) ?? []).length >= 3,
    "TasksPage Complete/Reopen/delete must all disable while a row action is in flight",
  );
  assert.equal(
    (tasks.match(/disabled=\{saving \|\|/g) ?? []).length,
    2,
    "both TasksPage forms (task, reminder) must disable while saving",
  );

  // Recurring rule form (review P2-4): submit reads the saving flag ahead of
  // the field-validity checks.
  assert.match(
    readPage("BudgetPage.tsx"),
    /disabled=\{\s*saving \|\|/,
    "BudgetPage's createRule submit must disable while in flight",
  );

  // The remaining create forms (review P3-6): each submit button reads its
  // page's saving flag. MemoriesPage reads it through the `saving` prop its
  // form component takes — the flag lives in the parent that owns submitForm.
  for (const page of ["ContactsPage.tsx", "HabitsPage.tsx", "BudgetPage.tsx"]) {
    assert.match(
      readPage(page),
      /disabled=\{\s*saving \|\|/,
      `${page} must disable its create submit while saving`,
    );
  }
  assert.equal(
    (readPage("ShoppingPage.tsx").match(/disabled=\{saving \|\|/g) ?? [])
      .length,
    2,
    "both ShoppingPage forms (list, item) must disable while saving",
  );
  assert.match(
    readPage("MemoriesPage.tsx"),
    /disabled=\{\s*p\.saving \|\|/,
    "MemoriesPage's form submit must disable while saving",
  );
  const importDialog = readPage("../components/ImportDialog.tsx");
  assert.match(
    importDialog,
    /disabled=\{\s*phase === "running" \|\| preview\.valid\.length === 0\s*\}/,
    "ImportDialog's confirm button must disable while running",
  );
  assert.match(
    importDialog,
    /disabled=\{\s*downloading \|\| phase === "running"\s*\}/,
    "ImportDialog's template button must disable while saving or running",
  );
});

test("an in-flight submit says so on the button, not just by going grey", () => {
  // Grey-only is ambiguous on a money form: the user cannot tell whether the
  // click registered. Every guarded button swaps its label — asserted against
  // the per-handler table above rather than a global string, so renaming one
  // form's label does not silently excuse another's.
  for (const guard of GUARDS) {
    if (guard.label !== undefined) {
      assert.ok(
        readPage(guard.page).includes(`"${guard.label}"`),
        `${guard.page} ${guard.handler} must say "${guard.label}" while in flight`,
      );
    } else if (guard.labelKey !== undefined) {
      // Localized pages say it through the catalogue, so the wording lives in
      // both languages instead of one hard-coded string.
      assert.ok(
        readPage(guard.page).includes(`t("${guard.labelKey}")`),
        `${guard.page} ${guard.handler} must say ${guard.labelKey} while in flight`,
      );
    }
  }
  // The per-row payment buttons all say the same thing, which is deliberate:
  // one wording for one kind of action.
  for (const page of ["LoansPage.tsx", "BusinessPage.tsx"]) {
    assert.ok(
      readPage(page).includes('"Saving…"'),
      `${page} must label its in-flight payment button`,
    );
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
      /title=(?:"Discard the unsaved draft[^"]*"|\{t\("notes\.discardTitle"\)\})\s*\n\s*disabled=\{(p\.)?saving\}/,
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
