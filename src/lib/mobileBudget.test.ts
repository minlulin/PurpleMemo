import { strict as assert } from "node:assert";
import { test } from "node:test";
import { entryFormReady, recordedBalanceCents } from "./mobileBudget.ts";

test("recordedBalanceCents is the plain sum of the wallet balances", () => {
  assert.equal(
    recordedBalanceCents([
      { balanceCents: 120_000 },
      { balanceCents: -20_000 },
      { balanceCents: 0 },
    ]),
    100_000,
  );
  assert.equal(recordedBalanceCents([]), 0);
});

test("entryFormReady needs a positive amount and real wallet/category ids", () => {
  assert.equal(
    entryFormReady({ amountCents: 500, walletId: 1, categoryId: 2 }),
    true,
  );
  assert.equal(
    entryFormReady({ amountCents: 0, walletId: 1, categoryId: 2 }),
    false,
    "zero is not money",
  );
  assert.equal(
    entryFormReady({ amountCents: null, walletId: 1, categoryId: 2 }),
    false,
  );
  assert.equal(
    entryFormReady({ amountCents: 500, walletId: null, categoryId: 2 }),
    false,
    "a form cannot invent a wallet",
  );
  assert.equal(
    entryFormReady({ amountCents: 500, walletId: 1, categoryId: null }),
    false,
    "a form cannot invent a category",
  );
});
