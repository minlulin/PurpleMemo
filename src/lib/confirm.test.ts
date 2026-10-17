// The inline delete-confirmation gate (review P2-10). The component that uses
// it is a page-level React component with no test surface here; the rule — that
// arming, confirming, cancelling and settling can only move the gate one way —
// is pure, and these tests are what keep a destructive button two clicks deep.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  type ConfirmEvent,
  type ConfirmState,
  confirmLabel,
  confirmTransition,
} from "./confirm.ts";

/** Apply a sequence of events, as the component would. */
function run(
  events: ConfirmEvent[],
  from: ConfirmState = "idle",
): ConfirmState {
  return events.reduce<ConfirmState>(confirmTransition, from);
}

test("one click arms, and the confirm button names what it destroys", () => {
  // The second click has to say what it does. "Delete" repeated under a list of
  // tabs is not a confirmation of anything.
  assert.equal(confirmTransition("idle", "arm"), "armed");
  assert.equal(confirmLabel("shopping list"), "Delete shopping list");
  assert.equal(confirmLabel("habit"), "Delete habit");
});

test("confirming runs the action exactly once", () => {
  assert.equal(run(["arm", "run"]), "running");
});

test("cancelling returns to rest and never ran anything", () => {
  assert.equal(run(["arm", "cancel"]), "idle");
  assert.equal(run(["arm", "cancel", "arm", "run"]), "running");
});

test("arming again while a delete is in flight is ignored", () => {
  // A second click delivered during a slow delete must not queue another one.
  // This is the case that makes an inline arm button dangerous rather than
  // merely impatient: nothing about the second click looks different to the
  // component, and the row it acts on may have changed underneath it.
  assert.equal(confirmTransition("running", "arm"), "running");
  assert.equal(run(["arm", "run", "arm"]), "running");
  assert.equal(run(["arm", "run", "arm", "run"]), "running");
});

test("running without arming first does nothing", () => {
  // Defence in depth: if the confirm button were ever rendered while idle, or
  // an event replayed `run` from a stale state, the action must not fire on a
  // click that never went through the arm step.
  assert.equal(confirmTransition("idle", "run"), "idle");
  assert.equal(confirmTransition("running", "run"), "running");
});

test("settling always returns to rest, success or failure", () => {
  // A delete that reported an error must not leave the button armed — that
  // puts the retry one misclick away, which is the accident this gate exists
  // to prevent, reached by the honest path instead of the accidental one.
  assert.equal(run(["arm", "run", "settle"]), "idle");
  assert.equal(run(["arm", "run", "settle"], "running"), "idle");
  assert.equal(confirmTransition("idle", "settle"), "idle");
});

test("cancelling cannot call off a delete that was already issued", () => {
  // The Cancel button is disabled while running, so this is only the invariant
  // made explicit: `cancel` must not report "idle" for an action in flight.
  assert.equal(confirmTransition("running", "cancel"), "running");
  assert.equal(run(["arm", "run", "cancel", "settle"]), "idle");
});

test("a full arm/confirm/settle cycle can be repeated", () => {
  // The gate is per-button and per-row, and a page can delete several rows in
  // one session. Nothing latches.
  let state = run(["arm", "run", "settle"]);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(state, "idle");
    state = run(["arm", "run", "settle"], state);
  }
  assert.equal(state, "idle");
});
