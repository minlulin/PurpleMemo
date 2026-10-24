// Factory-reset policy. The Rust engine is not gated; the
// frontend is, and the decisions live in `lib/reset.ts` where they are pure
// and testable here. Three rules are the deliverable's proof:
//
//   1. restart is allowed ONLY on a `complete: true` outcome;
//   2. every component name and every status the engine can report maps to a
//      catalogue key, in both languages — the result screen renders the
//      outcome verbatim, so a gap here is a blank label on a terminal screen;
//   3. a throw-shaped attempt (IPC failure) never presents as success and
//      carries no fabricated per-component rows.
//
// The call-site pins — factoryReset behind checkbox + ConfirmButton,
// appRestart behind the complete-check — live in `src/reset-gate.test.ts`,
// because those rules are about source wiring that `node --test` cannot mount.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import type {
  FactoryResetOutcome,
  ResetComponentName,
  ResetComponentStatus,
} from "../data/driver.ts";
import { en, type MessageKey, my } from "./i18n.ts";
import {
  bodyKey,
  hasBlockedComponent,
  headingKey,
  outcomeRows,
  RESET_COMPONENT_LABEL_KEYS,
  RESET_STATUS_LABEL_KEYS,
  resetAttemptFromError,
  resetAttemptFromOutcome,
  shouldRestart,
} from "./reset.ts";

/** Every name/status the Rust engine can serialize (reset.rs pins the set). */
const ALL_NAMES: ResetComponentName[] = [
  "share_stop",
  "database",
  "photos",
  "backups",
  "logs",
  "keyring_key",
];
const ALL_STATUSES: ResetComponentStatus[] = [
  "removed",
  "already_absent",
  "failed",
  "not_attempted",
];

function outcome(
  complete: boolean,
  components: FactoryResetOutcome["components"] = [],
): FactoryResetOutcome {
  return { complete, components };
}

const completeOutcome = resetAttemptFromOutcome(
  outcome(
    true,
    ALL_NAMES.map((name) => ({ name, status: "removed", detail: null })),
  ),
);

test("restart is allowed only when the engine reported complete: true", () => {
  assert.equal(shouldRestart(completeOutcome), true);
  assert.equal(
    shouldRestart(
      resetAttemptFromOutcome(
        outcome(false, [
          { name: "database", status: "failed", detail: "file is locked" },
          { name: "photos", status: "not_attempted", detail: null },
        ]),
      ),
    ),
    false,
    "a blocked reset must never restart",
  );
  // An `already_absent`-only run still counts as complete (the engine's own
  // rule), so it may restart — the engine re-runs to completion that way.
  assert.equal(
    shouldRestart(
      resetAttemptFromOutcome(
        outcome(
          true,
          ALL_NAMES.map((name) => ({
            name,
            status: "already_absent",
            detail: null,
          })),
        ),
      ),
    ),
    true,
  );
});

test("a thrown reset is never a restart and never renders as success", () => {
  const thrown = resetAttemptFromError("IPC channel closed");
  assert.equal(shouldRestart(thrown), false);
  assert.equal(headingKey(thrown), "reset.errorTitle");
  assert.notEqual(headingKey(thrown), "reset.successTitle");
  assert.notEqual(bodyKey(thrown), "reset.successBody");
  // No fabricated rows: there is no report to render verbatim.
  assert.deepEqual(outcomeRows(thrown), []);
  // Even a `complete: true`-looking object can only arrive as an outcome —
  // the error constructor cannot be talked into success by shape.
  assert.equal(thrown.kind, "ipc-error");
});

test("the heading and body keys split three ways, never lying about success", () => {
  const incomplete = resetAttemptFromOutcome(
    outcome(false, [
      { name: "keyring_key", status: "failed", detail: "keyring unavailable" },
    ]),
  );
  assert.equal(headingKey(completeOutcome), "reset.successTitle");
  assert.equal(bodyKey(completeOutcome), "reset.successBody");
  assert.equal(headingKey(incomplete), "reset.incompleteTitle");
  assert.equal(bodyKey(incomplete), "reset.incompleteBody");
  assert.equal(headingKey(resetAttemptFromError("boom")), "reset.errorTitle");
});

test("every engine component name and status maps to a real catalogue key", () => {
  // Compile time: the Record types require full coverage. Runtime: the keys
  // must exist in BOTH catalogues — a missing key throws in dev and silently
  // falls back in release, and on a terminal screen either is a defect.
  for (const name of ALL_NAMES) {
    const key = RESET_COMPONENT_LABEL_KEYS[name];
    assert.ok(key in en, `${name}: ${key} missing from the English catalogue`);
    assert.ok(key in my, `${name}: ${key} missing from the Burmese catalogue`);
  }
  for (const status of ALL_STATUSES) {
    const key = RESET_STATUS_LABEL_KEYS[status];
    assert.ok(
      key in en,
      `${status}: ${key} missing from the English catalogue`,
    );
    assert.ok(
      key in my,
      `${status}: ${key} missing from the Burmese catalogue`,
    );
  }
  // And the maps may not smuggle in extras: a key that no engine value can
  // produce is dead copy that will drift.
  assert.deepEqual(
    Object.keys(RESET_COMPONENT_LABEL_KEYS).sort(),
    [...ALL_NAMES].sort(),
  );
  assert.deepEqual(
    Object.keys(RESET_STATUS_LABEL_KEYS).sort(),
    [...ALL_STATUSES].sort(),
  );
});

test("outcome rows are rendered verbatim, in engine order, detail as-is", () => {
  const attempt = resetAttemptFromOutcome(
    outcome(false, [
      {
        name: "share_stop",
        status: "already_absent",
        detail: null,
      },
      {
        name: "database",
        status: "failed",
        detail: " SQLITE_BUSY: database is locked (0x5)",
      },
      {
        name: "photos",
        status: "not_attempted",
        detail: null,
      },
    ]),
  );
  const rows = outcomeRows(attempt);
  assert.deepEqual(
    rows.map((r) => r.componentKey),
    [
      "reset.component.shareStop",
      "reset.component.database",
      "reset.component.photos",
    ],
  );
  assert.deepEqual(
    rows.map((r) => r.statusKey),
    [
      "reset.status.alreadyAbsent",
      "reset.status.failed",
      "reset.status.notAttempted",
    ],
  );
  // Diagnostic text travels exactly as the engine wrote it — trimmed nothing,
  // localized nothing.
  assert.equal(rows[1]?.detail, " SQLITE_BUSY: database is locked (0x5)");
  assert.equal(rows[0]?.detail, null);
});

test("hasBlockedComponent sees failed and not_attempted, never drives success", () => {
  const failed = resetAttemptFromOutcome(
    outcome(false, [
      { name: "logs", status: "failed", detail: "permission denied" },
    ]),
  );
  assert.equal(hasBlockedComponent(failed), true);
  assert.equal(shouldRestart(failed), false);
  const skipped = resetAttemptFromOutcome(
    outcome(false, [{ name: "photos", status: "not_attempted", detail: null }]),
  );
  assert.equal(hasBlockedComponent(skipped), true);
  const clean = resetAttemptFromOutcome(
    outcome(
      true,
      ALL_NAMES.map((name) => ({
        name,
        status: "already_absent" as const,
        detail: null,
      })),
    ),
  );
  assert.equal(hasBlockedComponent(clean), false);
  assert.equal(hasBlockedComponent(resetAttemptFromError("nope")), false);
});

test("the catalogue keys this module hands out exist in the typed catalogue", () => {
  // Belt and braces on the heading/body keys: they are MessageKeys, but the
  // mapping functions are what the screen trusts, so pin their outputs too.
  for (const attempt of [
    completeOutcome,
    resetAttemptFromOutcome(outcome(false)),
    resetAttemptFromError("x"),
  ]) {
    assert.ok(headingKey(attempt) in en);
    assert.ok(bodyKey(attempt) in en);
    const asKey: MessageKey = headingKey(attempt);
    assert.ok(asKey.length > 0);
  }
});
