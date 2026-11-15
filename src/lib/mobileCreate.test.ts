import { strict as assert } from "node:assert";
import { test } from "node:test";
import { jobFormReady, loanFormReady, loanStateKey } from "./mobileCreate.ts";

test("a job needs a title and a total above zero", () => {
  assert.equal(
    jobFormReady({ title: "Toaster repair", totalCents: 5000 }),
    true,
  );
  assert.equal(jobFormReady({ title: "   ", totalCents: 5000 }), false);
  assert.equal(jobFormReady({ title: "Toaster repair", totalCents: 0 }), false);
  assert.equal(
    jobFormReady({ title: "Toaster repair", totalCents: -1 }),
    false,
  );
  assert.equal(
    jobFormReady({ title: "Toaster repair", totalCents: null }),
    false,
  );
});

test("a loan needs a counterparty and an amount above zero", () => {
  assert.equal(
    loanFormReady({ counterparty: "Daw Hla", amountCents: 20000 }),
    true,
  );
  assert.equal(loanFormReady({ counterparty: " ", amountCents: 20000 }), false);
  assert.equal(
    loanFormReady({ counterparty: "Daw Hla", amountCents: 0 }),
    false,
  );
  assert.equal(
    loanFormReady({ counterparty: "Daw Hla", amountCents: null }),
    false,
  );
});

test("every derived loan state has a label", () => {
  assert.equal(loanStateKey("open"), "mobile.loan.stateOpen");
  assert.equal(loanStateKey("partial"), "mobile.loan.statePartial");
  assert.equal(loanStateKey("overdue"), "mobile.loan.stateOverdue");
  assert.equal(loanStateKey("closed"), "mobile.loan.stateClosed");
});
