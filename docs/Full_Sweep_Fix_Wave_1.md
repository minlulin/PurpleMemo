# Full-Sweep Fix Wave 1 — Sync must never wedge permanently

**Context.** The pre-merge full-file audit (PR #25, findings
`SW-01…SW-12`) is verified: all 12 findings are real. This wave fixes
the four that can **permanently wedge sync under ordinary use**. The
owner delegated the audit's D-decisions; the decisions below are
settled — implement them, do not re-open them.

**Rules for every session.** One session, one commit. `npm run verify`
green before the commit. Base each session on the previous session's
commit. No emulator, no device, no APK build. If a session's premise
turns out wrong against the code, STOP and report instead of
improvising.

---

## Session 1 — D-1: the settle and the completion roll become legal (SW-01, SW-02)

**The defect.** The recorder and the authority matrix contradict each
other. `tasks.ts` records reminder settle ops (`update {fired}` /
`{remind_at, fired}`) and the repeating-task completion roll
(`update {due_date}`) from the phone; `updateFieldsAllowed` refuses
both for mobile origin; §7.7 refuses the whole push batch; the cursor
never moves; sync is wedged forever with no UI to drop an op.

**The decision (D-1).**

1. **Reminders: per-row creator authorization.** A mobile-origin
   `update` on `reminders` is allowed **iff** the row's
   `created_by_device_id` equals the op's `device_id` — a device may
   settle and re-arm only its own reminders (§13.1). A NULL creator
   never matches a mobile op (a NULL-creator row is the receiving
   device's own legacy-local row; only desktop-origin ops may update
   it). `updateFieldsAllowed` has no row context, so the check lives
   where the row is read during apply (`composeOp`); the matrix keeps
   refusing every other mobile reminder update. Desktop origin is
   unchanged.
2. **Tasks: classify the completion roll.** Mobile-origin `tasks`
   updates may carry `done`, `due_date`, or both — the roll is the
   completion of a repeating task, which §2.1's note classifies as a
   both-surfaces action. No other task fields open up. Record this in
   the spec (§2.1 note + §2.3 matrix wording) and in `protocol.ts`'s
   comments, so the matrix and the note stop contradicting each other.

**Tests.** The audit's two probe scenarios as real tests: a phone
reminder create + settle applies cleanly on the desktop and the
`fired` state converges; the phone settling a **desktop-created**
reminder is still refused; a phone completing a repeating task applies
and the rolled `due_date` converges; a phone `update` carrying any
other task field is still refused.

## Session 2 — SW-04: pull batches get a byte budget; encode failure is never an empty 200

**The defect.** `serve_sync_ops` cuts pull batches at 200 ops with no
byte budget; when the encoded body exceeds the frame,
`encode_frame(...).unwrap_or_default()` answers **200 with an empty
body**; the phone reads a malformed batch after its push already
committed, never polls the verdict, never prunes — a permanent
two-way wedge at ordinary data volume.

**The fix.**

1. Cut sync-pull batches with the snapshot's discipline: a plaintext
   byte budget per batch (reuse the 30 KiB figure the frame math
   dictates, or derive it in one named place shared by both paths),
   ops counted in seq order, a batch boundary before the op that
   would cross the budget. A single op larger than the budget travels
   alone (sync ops are field-level; a create op for one very large
   row is the same problem as SW-05's — if a single op cannot fit the
   frame either, refuse it **by name** on the serving side and surface
   it in the session result, never silently).
2. `encode_frame` failure must never produce an empty 2xx: the handler
   answers a named error status/body the client reports as a refusal.
   Audit the other `unwrap_or_default()` on that encode path for the
   same shape while you are there.

**Tests.** Rust loopback: a pull stream of many mid-size ops arrives
as multiple in-budget batches and the session converges; an encode
failure path returns the named error (drive it via the budget, not a
mock of the encoder). TS: `runSync` over the ferry with a fat outbox
converges and prunes.

## Session 3 — SW-07 + D-6: unresolvable parents can no longer poison a batch

**The defect.** `resolveValue` composes `(SELECT id … WHERE uid = ?)`
for a parent uid; an absent parent yields NULL into NOT NULL FK
columns, the batch fails its constraints, and every redelivery fails
identically — a permanent wedge. It is reachable because op payloads
are never rewritten: a pre-pairing op can name a parent uid that a
snapshot fold later retired, and the snapshot fold records **no
alias** (`uidAliasStatements` is called only from the engine).

**The decision (D-6, Option C + the guard).**

1. **Send-time resolution.** When the phone (any sender) builds the
   wire ops for a push or an upload, parent uids in payloads are
   resolved through the sender's own `sync_uid_aliases` first
   (`readUidAlias`); a uid with an alias travels under its winner.
   Aliases themselves never travel.
2. **The snapshot fold records aliases.** `snapshotRowStatements`'
   fold path emits `uidAliasStatements` like the engine's fold does,
   so a retired uid stays resolvable on the device that folded it.
3. **The engine guard.** During apply, a FK value whose uid resolves
   to nothing (after alias consultation) must not become a
   constraint-breaking statement: treat the op like the
   update-for-absent-row case — it writes nothing for that op and the
   batch proceeds — **except** the write is not silently lost: where
   the table is a §13.2 mutable entity, first emit the conflict copy
   of what the op names (the same machinery SW-03 uses in Wave 2; if
   Wave 2 has not landed yet, land the copy call here and let Wave 2
   reuse it). Name the behaviour in the spec (§7.7's neighbourhood):
   an op whose parent is gone is a dropped-with-trace op, never a
   batch failure.

**Tests.** The audit's path as a real test: standalone phone seeds,
a pre-pairing budget edit naming a seeded category, pairing +
adoption fold, upload, then sync — the session converges, nothing
wedges, and the edit's outcome matches the rule above (applied under
the winner uid via send-time resolution, or copied-and-dropped via
the guard — pin whichever the path takes and assert it). A create op
naming a deleted parent is copied-and-dropped, and the NEXT batch
still applies.
