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

test("searchNotes scopes to a collection when one is selected (P2-13)", async () => {
  // The regression: the sidebar filter reached `listNotes` but not the search,
  // so clicking a collection during a search highlighted it and then returned
  // matches from every collection.
  const driver = createMockDriver({
    results: [[{ id: 1, title: "Grocery budget", collection_id: 4 }]],
  });
  const rows = await searchNotes(driver, "grocery", { collectionId: 4 });
  assert.equal(rows.length, 1);
  const call = first(driver.callsTo("query"), "query");
  const sql = call.args[0] as string;
  assert.match(sql, /n\.collection_id = \?/);
  // Bound, never interpolated — and in the MATCH-then-filters order so the
  // existing params assertion keeps its meaning.
  assert.deepEqual(call.args[1], ['"grocery"*', 4]);
  assert.ok(
    sql.indexOf("notes_fts MATCH ?") < sql.indexOf("n.collection_id = ?"),
    "the MATCH clause comes first and its param stays first",
  );
});

test("searchNotes: no collectionId means no collection clause at all", async () => {
  // Not `AND n.collection_id = NULL`, which would match nothing.
  const driver = createMockDriver();
  await searchNotes(driver, "x");
  const sql = first(driver.callsTo("query"), "query").args[0] as string;
  assert.doesNotMatch(sql, /collection_id =/);
  assert.deepEqual(first(driver.callsTo("query"), "query").args[1], ['"x"*']);
});

test("searchNotes: collection, archived and rank clauses combine", async () => {
  const driver = createMockDriver();
  await searchNotes(driver, "x y", { collectionId: 7, includeArchived: true });
  const call = first(driver.callsTo("query"), "query");
  const sql = call.args[0] as string;
  assert.match(sql, /notes_fts MATCH \? AND n\.collection_id = \?/);
  // includeArchived was asked for, so that clause must be absent.
  assert.doesNotMatch(sql, /n\.archived = 0/);
  assert.match(sql, /ORDER BY rank/);
  assert.deepEqual(call.args[1], ['"x"* "y"*', 7]);
});
