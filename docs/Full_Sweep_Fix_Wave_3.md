# Full-Sweep Fix Wave 3 — Spec and document alignment

**Context.** Waves 1 and 2 land first; base this wave on Wave 2's tip.
The audit is PR #25; the findings below are verified real, and two of
them are the spec's fault, not the code's. The D-decisions are
settled — implement them, do not re-open them.

**Rules for every session.** One session, one commit. `npm run verify`
green before the commit. No emulator, no device, no APK build. If a
premise is wrong against the code, STOP and report.

---

## Session 1 — SW-05 + D-2 (Option C): the oversized-row promise is restated, and the refusal gets a name

**The defect.** §8.5 (via D4) promises a single aggregate larger than
the batch budget "still travels". Under §11.6's 64 KiB frame with hex
encoding and the phone's 30 KiB receipt cap, a row over ~30 KiB
cannot be framed at all: `batches()` emits it alone, the send fails
or the phone refuses, adoption retries forever with no actionable
message.

**The decision (D-2, Option C).** No protocol change. The promise is
restated and the failure becomes visible:

1. §8.5 is rewritten: a row whose snapshot JSON exceeds the servable
   budget does **not** travel; serving it is refused by name. §11.6
   and the receipt cap stay as they are.
2. One servable number: the batch cutter (`pairing_snapshot.rs`), the
   size estimator (`est_row_bytes` — it currently omits the ~110-byte
   batch wrapper, leaving in-budget batches knife-edge against the
   receipt check), and the phone's `MAX_PAIRING_SNAPSHOT_BYTES` must
   agree on a single budget that includes framing overhead. Derive it
   in one named place per side and cross-reference them.
3. A named, actionable refusal: when a snapshot read hits an
   unservable row, the serve fails with an error that identifies the
   record (table + uid, and its title/name where the row has one), the
   pairing panel surfaces it to the user as the reason adoption
   cannot proceed, and the phone's generic "malformed" is not what
   the user sees on its side either — the refusal kind travels and is
   rendered as "a record on the other device is too large to copy"
   (EN + MY strings).

**Tests.** A note just over the budget: the serve refuses by name
(Rust), the panel renders the reason (TS), and a note just under the
budget still adopts cleanly. The existing 30 KiB / 32 KiB framing
tests are updated to the restated contract, not deleted.

## Session 2 — SW-11, SW-12, and the upload-fold reconciliation

**SW-11.** `protocol.ts`'s `OPEN_DECISIONS` still presents
`reminder-definition-owner` as open. Move it to a settled record that
points at §13.1's resolution (Option A, as built), and change the
paired harness test to assert the settled state, not mere presence.

**SW-12 (the spec is wrong).** §5.2 lists "a task and its `reminders`"
among the verified cascades; reminders are standalone rows with no
task reference and no such cascade exists. Correct §5.2's list to the
cascades the schema actually has. Do not invent the cascade in code.

**Upload-fold reconciliation (D-6's sub-decision).** §8.4 says "a
natural key folds, it never collides" for any table, while
`uploadRowStatements`' comment deliberately refuses to fold in the
upload direction. Today the contradiction is unreachable (the
snapshot fold runs first), but the documents must agree before a flow
reaches it. The ruling: **§8.4 wins** — the upload apply folds by
natural key exactly as the snapshot apply does (the shared
`foldStatements`), and the comment is rewritten to say so. If wiring
the fold into `uploadRowStatements` proves reachable-but-hazardous
against the code as it stands, STOP and report rather than forcing
it — the comment alignment alone is not an acceptable outcome
without that report.

**Tests.** An upload whose rows include a natural-key collision
lands folded (the local row keeps its id, re-keys, fields merge) —
or the STOP report explains why not.
