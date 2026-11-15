# Full-Sweep Fix Wave 2 — Data loss and merge correctness

**Context.** Wave 1 (the wedges) lands first; base this wave on its
tip. The audit is PR #25; every finding below is verified real. The
D-decisions are settled by the owner-delegated ruling — implement
them, do not re-open them.

**Rules for every session.** One session, one commit. `npm run verify`
green before the commit. No emulator, no device, no APK build. If a
premise is wrong against the code, STOP and report.

---

## Session 1 — SW-06: wire §11.4's re-pair guard and build the discard act

**The defect.** `canRePair` implements §11.4 exactly and nothing
calls it: the panel's Trust re-pairs unconditionally
(`rePairStatements` zeroes cursors, drops acks) while the phone's
outbox may hold undelivered mutations, and the spec's deliberate
discard — "the button's own, explicit act" — has no UI at all.

**The fix.**

1. The Trust path consults the pending-outbox state for the pairing
   being re-paired: with undelivered mutations present, Trust does
   not proceed; the panel says so plainly (EN + MY strings) and names
   the count.
2. The discard act: a separate, explicit control (its own button, its
   own confirmation) that drops the pending outbox rows for that
   re-pair, after which Trust may proceed. Discarding is never a side
   effect of pressing Trust.
3. Tests: the existing `canRePair` unit tests stay; add one that
   drives the **panel** path — a non-empty outbox blocks Trust, the
   discard act empties it deliberately, Trust then proceeds. The
   phone-side card gets the same honesty where its flow re-pairs:
   if the card cannot block, it must at least surface the pending
   count before the user confirms — read the two flows and wire each
   where its re-pair actually happens.

## Session 2 — SW-09: snapshot application performs the §9.2 merge

**The defect.** `conflictLosers` (the §9.2 shared-uid merge with the
§13.2 loser copy) is dead code; `snapshotRowStatements` upserts
unconditionally, so at a (re-)pairing a held row's newer local value
can be silently overwritten by the snapshot's older one, stamps
reset, no trash copy.

**The fix.** In snapshot application, a row whose uid the receiver
already holds goes through the §4 stamp comparison, exactly as
`conflictLosers` specifies: the winner's values land; when the local
value loses and the table is a §13.2 mutable entity, the loser is
copied to local trash via `conflictCopyStatements` in the same batch.
Rows the receiver does not hold apply as today. The §9.4 re-adoption
path (after a generation bump) keeps wholesale replacement — but the
code must now distinguish the two paths by name (first pairing /
ordinary re-pair = §9.2 merge; re-adoption after a restore = §9.4),
not by accident. Wire `conflictLosers` in or replace it with the
equivalent in the apply path — dead code carrying a spec rule is
itself the smell; leave no second unimplemented copy of the rule.

**Tests.** The §10.5 scenario: both sides hold uid X with different
values, the phone's newer; re-pair; the phone keeps its value (or
wins per §4), the losing value exists as a trash copy on the losing
device; a re-adoption after a desktop restore still replaces
wholesale.

## Session 3 — SW-03 + D-3, SW-08, D-4: acknowledged writes, honest acks, and a GC that cannot erase evidence

**SW-03 / D-3 (Option A).** A non-create op for a row the receiver
does not hold currently writes nothing and is acked — a silent loss
contradicting §5.3. The ruling: where the table is a §13.2 mutable
entity, the op's named fields land as a **conflict copy** in local
trash (the machinery from Wave 1 Session 3 / Session 2 above), and
only then is the op acked — the user's data survives, in the place
the spec already reserves for losing values. Where the table is not
a §13.2 entity, the drop stands, and §5.3's text is amended in this
same commit to say exactly that (create-kind resurrects; a field
edit of an absent row lands as a conflict copy where the table
supports one). Tests: the restore-and-re-pair path — a phone edit to
a row the restored desktop lacks arrives, is acked, and the edited
fields are recoverable from the desktop's trash as a conflict copy.

**SW-08.** `ackStatements`' tombstone ack joins on
`(entity_table, entity_uid)`; key it on the tombstone's own `op_id`
(the delete it came from) so a peer is credited only for the delete
it actually received. Test: delete → ack → restore → delete again;
the second tombstone is NOT acked by the first ack.

**D-4 (Option B).** Even honest acks leave §5.4's GC able to prune a
tombstone a stale create still needs. Add a device-local **GC log**:
when a tombstone is pruned, its `(entity_table, entity_uid, counter,
device_id, op_id)` moves into a `sync_tombstone_gc_log` table
(schema **v12**, migration + populated-v11 fixture in the established
style, never in backups, cleared by the restore discipline with the
other bookkeeping). Resurrection checks (the create-vs-tombstone
comparison) consult the log when no live tombstone exists: a create
stamped at or below a logged tombstone stays dead. Log rows are
stamp-sized; do not prune the log in this wave. Tests: the SW-08
scenario extended — after GC, the stale create arrives and the row
stays dead.

## Session 4 — SW-10 + D-5: the tie-break everywhere, and "forgotten" means erase

**SW-10.** The snapshot tombstone upsert's conflict clause compares
counters only; give it the full §4 order (`counter`, then
`device_id`, then `op_id`) — the same guarded clause the engine's
`tombstoneStatement` uses. Test: two tombstones for one uid at equal
counters from different devices resolve identically via the snapshot
path and the op path.

**D-5.** §5.4 says only **explicitly forgotten** peers stop blocking
GC; the code currently stops counting **revoked** peers. The ruling:
revoke ≠ forget. Align the prune's peer set with the spec — a revoked
peer keeps blocking until it is forgotten; forgetting is an erase
act (peer row and its bookkeeping removed), which no UI performs yet,
so in practice every known peer blocks, the safe reading. Record the
ruling in §5.4's text. Test: a revoked peer's unacked tombstone is
not pruned.
