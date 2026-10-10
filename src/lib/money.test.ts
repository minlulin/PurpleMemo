import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  applyPayment,
  formatMMK,
  fromCents,
  outstandingCents,
  toCents,
} from "./money.ts";

test("toCents converts major units to integer cents (§4)", () => {
  assert.equal(toCents(12.5), 1250);
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents(0.29), 29);
  assert.equal(toCents(125000), 12_500_000);
  assert.equal(toCents(0), 0);
});

test("fromCents converts cents back to major units", () => {
  assert.equal(fromCents(1250), 12.5);
  assert.equal(fromCents(1999), 19.99);
});

test("formatMMK shows major units with separators + 2 decimals", () => {
  assert.equal(formatMMK(1_250_000), "12,500.00");
  assert.equal(formatMMK(12_500_000), "125,000.00");
  assert.equal(formatMMK(5), "0.05");
  assert.equal(formatMMK(0), "0.00");
});

test("outstandingCents is never negative (cash basis, §4)", () => {
  assert.equal(outstandingCents(10_000, 3_000), 7_000);
  assert.equal(
    outstandingCents(3_000, 5_000),
    0,
    "overpayment must not go negative",
  );
  assert.equal(outstandingCents(3_000, 0), 3_000);
});

test("applyPayment never overpays and reports what counted (§2.1)", () => {
  assert.deepEqual(applyPayment(10_000, 3_000, 4_000), {
    newPaidCents: 7_000,
    appliedCents: 4_000,
  });
  assert.deepEqual(applyPayment(10_000, 9_000, 5_000), {
    newPaidCents: 10_000,
    appliedCents: 1_000,
    // The extra 4,000 never counts — promises/unpaid are never income.
  });
  assert.deepEqual(applyPayment(10_000, 10_000, 1_000), {
    newPaidCents: 10_000,
    appliedCents: 0,
  });
});
