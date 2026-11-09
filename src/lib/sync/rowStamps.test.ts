/**
 * The row stamp — schema v9's `sync_row_stamps` (Session 7, option A).
 *
 * §8.4's snapshot must carry the §4.2 stamp of every row it sends, and §9.5
 * merges a shared UID by comparing those stamps. The outbox cannot supply it:
 * it is pruned once every live peer acks (§6.5). So the stamp is written with
 * the mutation, in the same batch, and this pins that it is.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type OutboxEntry, outboxStatements } from "./store.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const FIELD_STAMPS = {
  title: { counter: 3, deviceId: "dev-1", opId: "op-1" },
};

test("a mutation records the stamp a snapshot will carry, in the same batch", () => {
  const entry: OutboxEntry = {
    table: "notes",
    uid: "uid-1",
    kind: "update",
    fields: { title: "x" },
    fieldStamps: FIELD_STAMPS,
  };
  const statements = outboxStatements([entry], NOW);

  const stamp = statements.find((statement) =>
    statement.sql.includes("INTO sync_row_stamps"),
  );
  assert.ok(stamp, "the mutation also records the row's stamp (§4.2)");
  assert.match(stamp.sql, /ON CONFLICT\(entity_table, entity_uid\) DO UPDATE/);
  assert.match(
    stamp.sql,
    /\(SELECT lamport FROM sync_state WHERE id = 1\)/,
    "the counter comes from the transaction's own row, never a caller's claim",
  );
  const params = stamp.params ?? [];
  assert.deepEqual(params.slice(0, 2), ["notes", "uid-1"]);
  assert.equal(
    params[3],
    JSON.stringify(FIELD_STAMPS),
    "the per-field stamps of §4.3 travel with the row stamp",
  );
  assert.equal(params[4], NOW.toISOString());
});

test("a delete drops the row's stamp; the tombstone carries the delete's stamp", () => {
  const statements = outboxStatements(
    [{ table: "notes", uid: "uid-1", kind: "delete" }],
    NOW,
  );

  const drop = statements.find((statement) =>
    statement.sql.startsWith("DELETE FROM sync_row_stamps"),
  );
  assert.ok(drop, "a deleted row must not keep a stamp a snapshot could send");
  assert.deepEqual(drop.params, ["notes", "uid-1"]);

  assert.ok(
    statements.some((statement) =>
      statement.sql.includes("INTO sync_tombstones"),
    ),
    "the delete's own stamp lives on the tombstone (§5.1)",
  );
  assert.ok(
    !statements.some((statement) =>
      statement.sql.includes("INTO sync_row_stamps"),
    ),
    "a delete never writes a row stamp",
  );
});

test("every mutation still writes exactly one outbox row", () => {
  for (const kind of ["create", "update", "toggle", "delete"] as const) {
    const statements = outboxStatements(
      [{ table: "tasks", uid: `uid-${kind}`, kind }],
      NOW,
    );
    assert.equal(
      statements.filter((statement) =>
        statement.sql.includes("INTO sync_outbox "),
      ).length,
      1,
      kind,
    );
  }
});
