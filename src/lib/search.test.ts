import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createMockDriver } from "../data/mock-driver.ts";
import { first } from "../test-utils.ts";
import { buildMatchQuery, searchNotes } from "./search.ts";

test("buildMatchQuery quotes each token and ANDs them with prefix matching", () => {
  assert.equal(buildMatchQuery("hello world"), '"hello"* "world"*');
  assert.equal(buildMatchQuery("  grocery   budget  "), '"grocery"* "budget"*');
});

test("buildMatchQuery escapes embedded double quotes", () => {
  // Token `"hi"` -> inner quotes doubled (`""hi""`) -> wrapped as a phrase.
  assert.equal(buildMatchQuery('say "hi"'), '"say"* """hi"""*');
});

test("buildMatchQuery returns empty for blank input", () => {
  assert.equal(buildMatchQuery(""), "");
  assert.equal(buildMatchQuery("   "), "");
});

test("searchNotes returns [] without querying when input is blank", async () => {
  const driver = createMockDriver();
  const rows = await searchNotes(driver, "   ");
  assert.deepEqual(rows, []);
  assert.equal(driver.calls.length, 0, "no IPC call for empty input");
});

test("searchNotes queries notes_fts with the MATCH expression, rank-ordered", async () => {
  const driver = createMockDriver({
    results: [[{ id: 1, title: "Grocery budget" }]],
  });
  const rows = await searchNotes(driver, "grocery");
  assert.equal(rows.length, 1);
  const call = first(driver.callsTo("query"), "query");
  assert.match(call.args[0] as string, /FROM notes_fts/);
  assert.match(call.args[0] as string, /notes_fts MATCH \?/);
  assert.match(call.args[0] as string, /ORDER BY rank/);
  assert.deepEqual(call.args[1], ['"grocery"*']);
});

test("searchNotes excludes archived notes unless asked", async () => {
  const driver = createMockDriver();
  await searchNotes(driver, "x");
  assert.match(
    first(driver.callsTo("query"), "query").args[0] as string,
    /n\.archived = 0/,
  );

  const withArchived = createMockDriver();
  await searchNotes(withArchived, "x", { includeArchived: true });
  assert.doesNotMatch(
    first(withArchived.callsTo("query"), "query").args[0] as string,
    /n\.archived = 0/,
  );
});
