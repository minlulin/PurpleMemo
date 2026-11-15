# Purple Memo — Full-file audit (pre-merge sweep)

**Date:** 2026-11-15
**Base:** all work is based on `dev` at `bb5647a83c9049148d98d4f3b7fc3b2e20e94b81`
(release train staging branch: the sync stack from PRs #20–#27 plus the branch
that fixes N1–N13 and the Android review batch of 2026-11-13).

## What was run

- **TypeScript tests — run here, passing.** `node --test "src/**/*.test.ts"`:
  **1146 tests, 1146 passing** (~67 s; node v22.22.3; `npm install` needs
  `--engine-strict=false` because the package declares `engines >= 24`).
- **Rust tests — NOT run.** `src-tauri` contains 313 tests (`cargo test` is the
  gate in CI), but this audit environment has **no Rust toolchain at all** — no
  `cargo`, no `rustc`, no `target/`, nothing under `~/.cargo` or `/usr/bin`
  (verified at the filesystem root). Every Rust line cited below was read by
  hand, not executed. Treat all Rust-side findings as code-reading evidence.
- **Three scratch probes** were executed against the *real* modules (node type
  stripping over `src/lib`, real `applyOps`/repositories over the test schema).
  Their outputs are quoted in SW-01, SW-02 and SW-07. The scratch files were
  deleted before this PR; this document is the only file it contains.

## Scope and non-goals

This sweep covers: (1) the sync/pairing surface (Rust `pairing_*`, `envelope`,
`src/lib/sync`); (2) `src/lib` outside sync (vault, backup, trash, the
repositories whose writes the recorder hooks); (3) Rust beyond pairing
(`db.rs`, `schema.rs`, `commands.rs`, `key_store/`, `share.rs` at
intersection level, `lib.rs`); (4) the app shell/UI (`MobileScreens.tsx`,
`PairingPanel.tsx`) and the IPC surface per platform; plus the Android release
surface (manifest, Gradle, ProGuard). Tests are in scope as evidence only.

Deliberately **not** re-reported (already fixed in N1–N13 / the Android review
batch, or parked): the pairing foundation items, the settled decisions (static
key per §11.6.1; `sync_row_stamps` side table; reminders Option A semantics;
§4 winner's-uid fold with `sync_uid_aliases`; restore-bumps-generation §10;
`DEVICE_LOCAL_SETTING_KEYS` policy; minSdk 26; 30 KiB snapshot budget), the
fixed Android batch items (ProGuard JNI keeps, signing, `allowBackup=false` +
extraction rules, keystore error taxonomy, reset clearing reminders, clipboard
clearing, monotonic lock clock, missed-reminder settling, notification intents,
platform-split capabilities), the items left deliberately open on purpose
(`icu_locale_core` opt-level stanza, Kotlin/R8 real-build behaviour, deep-sleep
lock on hardware), and PERF-11 / PERF-12 (parked). Where a closed item was
fixed wrongly the finding reopens it by name.

---

# Findings

Ordered by severity. Every finding names the concrete failure path and the
user-data impact. Fix directions only — no code.

---

## SW-01 — HIGH — The phone's reminder settle ops are refused wholesale: §13.1 convergence is impossible and every later sync on the pairing fails forever

**Evidence**

- `src/lib/tasks.ts:393-411` (`markReminderFired`), `:413-438`
  (`rescheduleReminder`), `:444-475` (`settleReminders`) — the settle paths
  record `update` ops on `reminders` with fields `{fired:1}` or
  `{remind_at, fired:0}`. The comment at `tasks.ts:447-450` states the intent
  verbatim: *"A settle is a definition write (§13.1 Option A …): the peer's
  copy must converge on the new `remind_at`/`fired`."*
- `src/lib/sync/protocol.ts:112-116` (`MOBILE_TOGGLE_FIELDS` has **no**
  `reminders` entry), `:190-215` (`updateFieldsAllowed` — a mobile `update` on
  `reminders` is therefore refused) and `:118-160` (`writeAllowed` — the
  `reminders` row says the phone "creates and deletes (§2.3)").
- `src/components/MobileScreens.tsx:300-312` — the Android reminder pass
  (`syncAndroidReminders`) calls `tasksRepo.settleReminders(outcomes)` on the
  phone; this is ordinary, intended mobile behaviour, not an edge case.
- Probe (real modules): a phone-recorded `reminders` batch
  (`create` + `settle → update {fired:1}`) applied with `origin: "mobile"` —
  *"RESULT: applyOps REFUSED the batch: op …#2 was refused: the phone never
  edits an existing reminders row; it creates and deletes (§2.3)."* The same
  ops with `origin: "desktop"` apply cleanly.

**Spec contradiction — the code side is wrong.** §13.1 says a reminder's
`fired` state *"converges from the creator's own settle ops (§6.1)"* and that
the creator is whichever device armed it. `protocol.ts`'s per-table authority
matrix cannot express this: `updateFieldsAllowed` has no uid/row context, so it
cannot distinguish "the phone settling its own reminder" (must converge) from
"the phone editing somebody else's reminder" (must be refused). The settle op
as recorded is exactly what §13.1 mandates; the engine's refusal of it is the
bug.

**Concrete failure path**

1. The phone creates a reminder (allowed; create op syncs fine) and arms it.
2. The reminder fires; the Android pass settles it
   (`MobileScreens.tsx:312`), recording `update {fired:1}` in the outbox.
3. The next `runSync` pushes the outbox batch (`syncSession.ts:284-296` — the
   `movable` filter is a no-op over all 17 tables, so the settle op always
   travels).
4. The desktop's push apply (`applyOps`, `origin: "mobile"`) validates the
   whole batch first and **refuses it by name** (§7.7 whole-batch refusal).
   Verdict `failed`.
5. `cursor_out` does not move; every future session re-sends the same rows and
   fails the same way. There is **no UI anywhere to drop or quarantine outbox
   rows**, so the pairing is wedged permanently — and the reminder's `fired` /
   `remind_at` never converge on the desktop, breaking §13.1 outright.

**User-data impact** — Permanent sync outage on any pairing where a reminder
fired on the phone (i.e. any real use of phone reminders); the desktop's
reminder copy silently diverges (it may re-notify or never notify); the only
escape is a backup restore or factory reset, both of which discard sync state.

**Fix direction** — Make the settle path legal for the row's creator and keep
refusing edits to other devices' reminders. The enforcement point has to carry
row ownership (`reminders.created_by_device_id`, §13.1) or the settle must
travel as its own op kind; per-table `updateFieldsAllowed` alone cannot express
the rule. Whatever shape is chosen must also make the *receiving* side converge
(see D-1). The recorder's and the protocol's opinions of the same op must stop
contradicting each other.

---

## SW-02 — HIGH — Completing a repeating task on the phone emits a refused `due_date` update — same permanent wedge

**Evidence**

- `src/lib/tasks.ts:303-308` — `completeTask` for a repeating task rolls the
  date via `updateTask(id, { dueDate: rolled })`; `tasks.ts:225-267`
  (`updateTask`) records an `update` op carrying the changed fields
  (`{due_date}`).
- `src/lib/sync/protocol.ts:190-215` — `updateFieldsAllowed("tasks", …,
  "mobile")` allows **only** `done`; a `due_date` field is refused ("the phone
  cannot change due_date on tasks (§2.3)").
- `src/components/MobileScreens.tsx:2159-2163, 2256` — the mobile task list's
  checkbox calls `tasksRepo.completeTask(task.id)`; `DashboardPage.tsx:231-242`
  documents that both surfaces share this exact function.
- Probe (real modules): a repeating task completed on the phone produced
  `update {"due_date":"2026-11-21"}`; applying with `origin: "mobile"` —
  *"RESULT: repeating-task completion ops REFUSED: op …#2 was refused: the
  phone cannot change due_date on tasks (§2.3)."*

**Spec contradiction — the spec's matrix is the wrong side.** §2.1's own note
says an action the UI exposes on both surfaces *"must be classified on both
(e.g. **completing a repeating task rolls its `due_date` on both surfaces**)"*
— and then the matrix classifies the phone's task power as only "toggle
`tasks.done`", never the roll. The shared `completeTask` semantics follow the
note; the engine follows the matrix and refuses the op.

**Concrete failure path** — Identical to SW-01 steps 2–5 with `completeTask`
on any repeating task: the whole push batch is refused, `cursor_out` sticks,
every subsequent sync fails forever.

**User-data impact** — A user who checks off a single daily/weekly task on the
phone permanently wedges sync; the rolled `due_date` never reaches the desktop
(divergent replicas: the phone shows the next occurrence, the desktop the old
one).

**Fix direction** — Classify the completion roll in the matrix (a `done`
completion may move `due_date`) or record the roll as a completion-kind op;
either way the receiving side must accept it. Note the sibling hazard: any
other mobile path that would emit a task/note/collection/shopping `update`
(these exist in shared repository code — `updateTask`, `updateNote`,
`updateList`, `deleteCollection`'s relink updates at `notes.ts:277-320`)
reaches the same wedge; the mobile UI currently exposes none of them
(`MobileScreens.tsx` is view+add+toggles only), but the repository layer
offers no protection.

---

## SW-03 — HIGH — A higher-stamped edit for a record the receiver lacks is silently dropped and acknowledged — acknowledged write loss, against §5.3's resurrection rule

**Evidence**

- `src/lib/sync/engine.ts:996-1005` — for an absent row, only `op === "create"`
  may resurrect; any `update` returns `EMPTY_OUTCOME` (nothing written, op
  still acked). The comment admits the row cannot be rebuilt from a partial
  edit — a real constraint, but the outcome contradicts the spec.
- Spec §5.3: *"A **higher-stamped later edit wins outright and brings the row
  back to life**."* §5.3 also defines the resurrected-row case as create-kind
  ≤ tombstone, but the quoted sentence is unqualified.
- `src/lib/sync/engine.test.ts` exercises create-kind resurrection and the
  tombstone-outranks-drop, but no test applies a higher-stamped `update` to an
  absent row and asserts the §5.3 outcome — the contradiction is untested.

**Concrete failure path**

1. The phone edits a note (its local counter is higher than anything the
   desktop holds — e.g. the desktop restored an older backup and re-paired,
   §10.5; or the desktop's row was deleted while the phone was away).
2. The phone's `update` op arrives; the desktop's `composeOp` finds no row →
   `EMPTY_OUTCOME` → the op is acked as applied.
3. `ackStatements` prunes the phone's outbox row on the sealed `applied`
   verdict (`syncSession.ts:421-425`). The edit is gone from the only durable
   queue it ever had.
4. Replicas diverge silently and permanently: the phone shows the edited note;
   the desktop shows nothing (or the older row's successor state), with no
   trace and no §13.2 conflict copy.

**User-data impact** — Silent loss of a write the protocol acknowledged;
divergent replicas. This is the classic "lost acknowledged write" class.

**Fix direction** — Decide D-3 (full resurrect is impossible from a partial
edit; the options are a §13.2-style conflict copy of what the op names, a
protocol-level refusal that keeps the op unacked, or a documented §5.3
amendment). What must stop is the *silent acknowledgement* of a write that
provably did not land.

---

## SW-04 — HIGH — Sync-pull batches have no byte budget and encoding failures return an empty 200: one oversized batch wedges both directions of sync forever

**Evidence**

- `src-tauri/src/pairing_listener.rs:2404-2413` — `serve_sync_ops` cuts the
  pull stream only at `MAX_UPLOAD_BATCH_OPS` (200 ops). No byte budget.
- `src-tauri/src/pairing_listener.rs:1398-1400` — `encode_frame(&body.to_string())
  .unwrap_or_default()`: when the JSON body exceeds `MAX_FRAME_BYTES`
  (64 KiB, `pairing_listener.rs:119`), the encoder errors and the handler
  **swallows it and writes an empty body with the original status** (200).
- `src-tauri/src/commands.rs:986-1017` — the `sync_source` closure reads
  `sync_outbox WHERE seq > ?` with no byte cap; the size problem is created
  upstream and never cut.
- The snapshot path proves the team knows the right shape: the 30 KiB batch
  cutter (`pairing_snapshot.rs:144-160`) exists precisely because the 64 KiB
  frame is hex-doubled on the wire. The pull path never got the same treatment.
- Spec §8.5: wire batches are budgeted at 200 ops **and 256 KiB**. The code
  enforces only the op count.

**Concrete failure path**

1. A peer's outbox holds an ordinary run of ops whose encoded batch exceeds
   ~31 KiB plaintext (the hex frame limit ÷ 2) — e.g. several rich notes'
   creates in one session, or one ~30 KiB note plus anything else. 200 ops of
   ordinary size can exceed 31 KiB easily.
2. The phone pulls: the desktop assembles one huge batch, `encode_frame`
   fails, the handler answers `200` with an **empty body**.
3. The phone's `readSyncBatch` sees a malformed/empty batch → `runSync`
   returns `pull-refused` **after the push already committed** — so the push's
   verdict is never polled, `ackStatements` never runs, and `cursor_out` never
   advances.
4. Next session re-pushes the same rows (idempotent on the desktop, fine) and
   re-pulls the same unsendable batch. The desktop's ops **never reach the
   phone**; the phone's outbox is never acked or pruned. Permanent two-way
   wedge, with no user-visible cause.

**User-data impact** — Total sync outage triggered by nothing more than
ordinary data volume; the "N changes to sync" counter grows forever; replicas
diverge from that moment.

**Fix direction** — Cut pull batches with the same byte-budget discipline the
snapshot uses (count hex-doubled sizes against the frame cap), and never answer
an encode failure with an empty 2xx body: fail the response by name so the
client can shrink/retry rather than treat it as end-of-stream.

---

## SW-05 — MED-HIGH — §8.5's "an oversized row still travels" is unsatisfiable in the snapshot path; a single fat note bricks snapshot adoption forever

**Evidence**

- `src-tauri/src/pairing_snapshot.rs:144-160` (`batches`) and `:201`
  (`est_row_bytes`): a row larger than the per-batch budget is emitted as a
  batch of its own (spec §8.5: it "still travels"). But the transport is a
  64 KiB hex frame (`pairing_listener.rs:119, 187-192`): a row whose JSON
  exceeds ~31 KiB **cannot be framed at all**.
- The receiving side refuses even before framing: `mobilePairing.ts:459` /
  `bootstrap.ts:34` — `MAX_PAIRING_SNAPSHOT_BYTES = 30 * 1024`, and
  `readSnapshotBatch` refuses any batch JSON over it.
- The tests pin the impossibility instead of the promise:
  `pairing_snapshot.rs:1037-1050` (`a_thirty_two_kib_batch_does_not_fit`) and
  `:985-1036` (`a_max_size_batch_seals_and_frames_inside_the_cap`) assert that
  32 KiB cannot travel and 30 KiB can — while `batches()` still emits
  unservable batches and the spec still promises they travel.

**Spec contradiction — the spec's sentence is the wrong side** as written:
"still travels" is unsatisfiable under §11.6's 64 KiB frame + hex wire format
and the phone's 30 KiB receipt cap. Either the framing must change (D-2) or
the promise must be restated (a row over the frame cannot be served; adoption
must fail by name).

**Concrete failure path** — A note (or vault item, or any row) whose snapshot
JSON exceeds ~30 KiB (long text plus tags/links is enough): the desktop
re-takes the snapshot for every pairing attempt, batches the fat row alone,
the send fails (or the phone refuses the batch), the phone reports
"malformed", adoption never completes (`hello_received = false`), and the loop
repeats forever. `est_row_bytes` also omits the ~110-byte batch wrapper, so
even "in-budget" batches are knife-edge against the 30 KiB receipt check.

**User-data impact** — Pairing/adoption permanently impossible for any
database containing one fat row; no workaround except deleting the record.

**Fix direction** — Decide D-2. Minimum regardless of shape: make `batches()`
and the receipt cap agree on one number that includes framing overhead, and
turn an unservable row into a named, actionable refusal instead of a silent
re-take loop.

---

## SW-06 — MED-HIGH — §11.4's re-pair outbox guard is dead code; re-pairing silently proceeds with undelivered mutations and there is no discard act at all

**Evidence**

- `src/lib/sync/pairing.ts:529-545` — `canRePair(pendingOutbox, discardPending)`
  implements §11.4 exactly ("Sync first, or discard them deliberately").
  **Nothing calls it.** The only references in the tree are its own unit tests
  (`pairing.test.ts:458-467`), which assert the helper's behaviour — a test
  that claims the property while the product enforces nothing.
- `src/lib/sync/pairingPanel.ts:683-713` (`pinAdmittedPeer`) — the Trust
  action re-pairs an existing peer through `rePairStatements`
  (`store.ts:434-474`: cursors zeroed, acks dropped) **unconditionally**;
  no outbox check anywhere in the panel or the card UI (`PairingPanel.tsx`
  contains no `discard` affordance at all).
- Spec §11.4: *"while the phone's outbox holds undelivered mutations,
  re-pairing must not proceed … the user must be able to discard the pending
  outbox deliberately — and that discard must be the button's own, explicit
  act."*

**Concrete failure path** — The phone holds offline edits (its outbox is
non-empty). The desktop is reset/lost; the user re-pairs (Trust). The cursors
reset to 0 and the whole outbox is re-offered into the new pairing, where the
snapshot first **clobbers the phone's rows** (SW-09's unconditional upsert) and
the surviving ops then hit refusals/merges against a data line that never saw
their base state. Silent loss of the very edits §11.4 exists to protect — and
the "discard" half of the spec's contract has no UI representation at all.

**User-data impact** — Silent loss of a phone's offline mutations at re-pair,
exactly the scenario the guard was written for.

**Fix direction** — Wire `canRePair` (or equivalent) into the Trust path and
implement the explicit discard act the spec demands. The unit test should be
joined by one that drives the *panel* and proves a non-empty outbox blocks
Trust.

---

## SW-07 — MED — An op whose parent uid cannot be resolved composes a NULL into a NOT NULL foreign key and fails the whole batch — a permanent wedge the engine guards elsewhere

**Evidence**

- `src/lib/sync/engine.ts:254-260` (`resolveValue`): a FK field becomes
  `(SELECT id FROM "parent" WHERE uid = ?)` — an absent parent yields NULL.
- `src/lib/sync/engine.ts:437-494` (`insertStatements`) and the update path
  (`mergeOp`) write that value unguarded. The engine's own comment for the
  sibling case (`engine.ts:1000-1005`) shows the danger is known: inserting
  fields that *"break the table's constraints (**wedging every later batch on
  the same op**)"* is exactly why the update-for-absent-row case is dropped —
  but the create/update-with-unresolvable-parent case is not.
- `store.ts:979-989` (`snapshotColumns`' comment) documents the same NULL →
  NOT NULL failure and calls it unreachable *"from a well-formed payload"* —
  true for snapshot/upload rows read under one transaction, **not** true for
  ops recorded before a natural-key fold re-keyed their parents.
- The snapshot fold re-keys rows but records **no alias**: `store.ts:1080-1100`
  (`snapshotRowStatements` → `foldStatements`, `store.ts:948-971`) updates
  the row's uid by natural key and drops old stamps, while
  `sync_uid_aliases` is written only by the engine's fold
  (`engine.ts:604-611`). Pre-fold uids therefore resolve nowhere — not on the
  phone (no alias row), not on the desktop (never learned; alias tables are
  device-local and never sync).
- Probe (real modules): a `habit_logs` create whose `habit_uid` names a
  deleted parent composed fine but the batch ran the earlier tombstone drop
  path; a direct `expense_entries` create naming independently-seeded
  wallet/category uids ran the batch and failed it —
  *"RESULT 1: batch FAILED: NOT NULL constraint failed:
  expense_entries.category_id"*. Every re-delivery of that batch fails the
  same way.

**Concrete failure path** (narrow but real)

1. Standalone phone (not yet paired): user logs a budget entry against the
   baseline-seeded "Cash"/"Food" (per-install uids, `schema.rs:1080-1099`),
   then edits it changing the wallet or category — `updateEntry` records
   `update {wallet_uid: P}` in the outbox (`budget.ts`, `updateEntry`).
2. The phone pairs. Adoption folds the phone's seeded rows onto the desktop's
   uids (`foldStatements`), and the upload lands the entry row itself.
3. `runSync` pushes the outbox. The `update` op still names `wallet_uid: P`
   (op payloads are never rewritten). The desktop's `resolveValue` finds no
   `P`, composes `wallet_id = NULL`, the NOT NULL constraint fails, the whole
   batch rolls back, the verdict is `failed`, `cursor_out` sticks — same
   permanent wedge as SW-01/02, with no UI to drop the op. (A pre-pairing
   `create` op is usually saved by the §7.2 held-dedupe because the upload
   landed the row first; the `update` variant is not.)

**User-data impact** — Permanent sync wedge from ordinary pre-pairing budget
use; the wedged op's user-visible edit never arrives.

**Fix direction** — Guard the composed write: an op whose parent uid resolves
to nothing should be handled like the update-for-absent-row case (named
refusal or deliberate drop with a §13.2-style trace), never a
constraint-breaking statement that poisons the batch forever. Secondarily:
make the snapshot fold record `sync_uid_aliases` like the engine fold does, so
pre-fold op uids remain resolvable.

---

## SW-08 — MED — `ackStatements` marks tombstones acked by uid, not by op id — peers get credited for deletes they never received, and §5.4's GC invariant is breakable

**Evidence**

- `src/lib/sync/store.ts:325-386` (`ackStatements`), second statement: the
  tombstone ack is joined **on `(entity_table, entity_uid)` + any outbox
  `delete` row with `seq <= throughSeq`** — it never compares
  `t.op_id = o.op_id`. A tombstone created by a *later* delete of the same uid
  is marked acked by a peer that only confirmed an *earlier* delete.
- §5.4: tombstones may be pruned only after **all known peers have
  acknowledged the tombstone** — i.e. that delete. The join implements
  "acknowledged *a* delete of this uid".

**Concrete failure path** — The desktop deletes X (delete #1), restores it,
deletes again (delete #2 updates the same `sync_tombstones` row — the table is
keyed `(entity_table, entity_uid)`). The phone applies only through delete #1's
seq and reports `syncApplied`; `ackStatements` joins delete #1 to the current
tombstone (which now describes delete #2) and marks it acked-by-phone. The GC
prunes it. A stale create-kind op for X stamped ≤ delete #2's counter that
still sits in a peer's outbox (restore-created ops are create-kind under the
same uid, §5.3) now arrives at a desktop with **no tombstone to outrank it** —
`composeOp` resurrects the row although §5.3 says it must stay dead. The peers
diverge silently.

**User-data impact** — Divergent replicas via resurrection of records the
protocol considers deleted; the tombstone's destruction also removes the
evidence any corrected merge would need. (Ordinary cases still converge because
the delete op itself keeps travelling — the damage needs the stale-create
interplay, which is why this is MED and not HIGH.)

**Fix direction** — Key the ack join on the tombstone's own `op_id` (the
delete row it came from), not on the uid. Pair with D-4: even honest acks
leave the §5.4 GC able to destroy evidence a stale create still needs.

---

## SW-09 — MED — The §9.2 shared-uid merge (with the §13.2 loser copy) is not wired into snapshot application — `conflictLosers` is dead code and a held row can be silently clobbered

**Evidence**

- `src/lib/sync/bootstrap.ts:281-333` — `conflictLosers` implements §9.2's
  "merged by §4, with the loser copied to local trash" and is exercised by
  `bootstrap.test.ts:340-460`. **No product code calls it** (verified across
  `src/`).
- `src/lib/sync/store.ts:1080-1124` (`snapshotRowStatements`): the row lands
  as an unconditional `INSERT … ON CONFLICT(uid) DO UPDATE` of every column;
  the stamp row is overwritten with the snapshot's. There is no §4 stamp
  comparison and no §13.2 conflict copy on the losing side.
- Spec §9.2, third bullet: *"A UID both sides hold with different values: the
  same record, merged by §4, with the loser copied to local trash if it is a
  mutable entity (§13.2)."* (§9.4's wholesale replacement is sanctioned only
  for re-adoption; §9.2's first-pairing case is not.)

**Concrete failure path** — Two devices that once shared a data line (e.g. the
desktop restored an older backup and re-paired, §10.5) hold uid X with
different values; the phone's value is the newer edit. The re-pair's snapshot
apply overwrites the phone's row with the older value and resets its stamps to
the snapshot's (counter 0/"unstamped" after a restore). The phone's version is
gone with no trash copy, contrary to §9.2/§13.2 — and the same clobber applies
to any first pairing where a uid genuinely collides.

**User-data impact** — Silent loss of one replica's version of a record with
no §13.2 copy to recover from; the merge rule the spec guarantees is simply
not performed.

**Fix direction** — Route shared-uid snapshot rows through the §4 comparison
and emit the §13.2 copy for the losing side (the `conflictLosers` +
`conflictCopyStatements` machinery already exists — the snapshot apply just
doesn't use it). Where wholesale replacement is genuinely wanted (§9.4
re-adoption), keep it but name it.

---

## SW-10 — LOW — The snapshot tombstone upsert drops §4's tie-break: equal counters resolve by recency of arrival, not by `(device_id, op_id)`

**Evidence**

- `src/lib/sync/store.ts:1385-1400` — `snapshotStatements`' tombstone upsert
  ends `WHERE excluded.counter > sync_tombstones.counter` — counter only.
- The engine's own `tombstoneStatement` (`engine.ts:305-330`) and
  `tombstoneOutranksRow` use the full order: counter, then `device_id`, then
  `op_id`. §4.2 defines that total order.

**Concrete failure path** — Two deletes of the same uid at the same counter
from different devices (possible once counters interleave across a fold or a
restore): whichever tombstone the snapshot delivers *last* wins the upsert,
wherever §4 says the `(device_id, op_id)` tie-break decides. The surviving
tombstone's stamp then disagrees with what a peer computed — a narrow, latent
divergence in the merge baseline.

**User-data impact** — Low: wrong merge baseline in a rare tie case; possible
later divergence of delete/edit outcomes between peers.

**Fix direction** — Use the same guarded conflict clause as
`tombstoneStatement` (the full §4 order) in the snapshot upsert.

---

## SW-11 — LOW — `OPEN_DECISIONS` still presents the settled reminder-ownership decision as open

**Evidence**

- `src/lib/sync/protocol.ts:381-405` — `OPEN_DECISIONS` lists
  `reminder-definition-owner` with "recommended: A", as if undecided.
- The spec's §13.1 records the resolution ("Resolved path: Option A …
  `created_by_device_id` … the creator is the device that notifies") and the
  code implements Option A (`schema.rs` migration 7→8 adds the column;
  `reminderDelivery.ts` filters; `engine.ts:455-493` stamps the creator from
  `op.device_id`).

**Concrete failure path** — A later session (or reviewer) reads
`OPEN_DECISIONS` / `docs/ANDROID_BUILD_TODO.md` and treats settled territory
as open, re-litigating or "deciding" it differently. The harness test
(`harness.test.ts:154-166`) proves co-presence of the id in the docs — it does
not prove the decision is still open.

**User-data impact** — Process risk, not data risk.

**Fix direction** — Move the entry to a "settled" record (or delete it and
point at §13.1's resolution). The paired test should assert the settled state,
not just presence.

---

## SW-12 — LOW — Spec drift: §5.2's "a task and its `reminders`" cascade does not exist

**Evidence**

- Spec §5.2 lists "`tasks` → `reminders` (a task and its `reminders`, where
  the desktop deletes them together)" among verified cascades.
- `src-tauri/src/schema.rs:807-815` — `reminders` has **no** task reference
  (columns: `id, uid, title, remind_at, repeat, note, fired, created_at`);
  reminders are standalone rows. `tasks.ts:310-320` (`deleteTask`) trashes and
  tombstones only the task.

**Which side is wrong: the spec.** The schema and both repositories treat
reminders as independent entities (§13.1's reminder lifecycle never mentions a
task parent either). The sentence is stale prose, probably from a design where
reminders hung off tasks.

**User-data impact** — None today (no cascade, so no missing tombstones); the
risk is a future reader "fixing" the code to match the spec and inventing a
cascade the data model never had.

**Fix direction** — Correct §5.2's list.

---

# DECISIONS

Genuine judgment calls surfaced by the sweep. Options and trade-offs only —
this audit takes no side.

---

## D-1 — How should §13.1's per-row creator ownership cross the per-table authority matrix? (the fix shape for SW-01, and part of SW-02)

- **Option A — a dedicated settle/re-arm op kind.** The recorder emits
  `kind: "settle"` and the matrix authorizes that kind per table+origin.
  *Trade-off:* cleanest authority story; wire/protocol version churn; every
  merge/dedupe path must learn the new kind.
- **Option B — per-row authorization at apply time** (`reminders.update`
  allowed iff `created_by_device_id = op.device_id`). *Trade-off:* no wire
  change; `updateFieldsAllowed` currently has no row/uid context, so the check
  must move up to `composeOp`; a reminder whose creator column is legacy-NULL
  (Option A's "NULL = mine" reading) needs an explicit rule on the receiving
  side.
- **Option C — widen the matrix** (mobile may `update` `reminders`
  transitions). *Trade-off:* smallest change; §2.3's "the phone never edits an
  existing reminders row" is abandoned wholesale — any phone edit becomes
  legal, contradicting the spec's authority story.

## D-2 — The snapshot size protocol (the fix shape for SW-05)

- **Option A — chunk large rows below the frame** (value-level streaming).
  *Trade-off:* honours "still travels"; real complexity in the batch/adopt
  state machine; per-chunk integrity needed.
- **Option B — raise the frame / drop hex for snapshot bodies.**
  *Trade-off:* changes §11.6's transport rules and the security review's
  assumptions; simplest way to make §8.5 literally true.
- **Option C — restated promise**: rows over the budget are refused by name and
  the user is told which record blocks pairing. *Trade-off:* no protocol
  change; the spec must stop promising "still travels"; one fat note still
  blocks adoption, but visibly and with an actionable message instead of an
  endless re-take loop.

## D-3 — What should happen to a higher-stamped edit for an absent row? (SW-03)

- **Option A — §13.2-style conflict copy** of the fields the op names, then
  drop. *Trade-off:* preserves the user's data; creates rows the spec's model
  doesn't have a name for.
- **Option B — refuse by name and keep the op unacked.** *Trade-off:* no
  silent loss; but the outbox can then never drain (the row cannot be
  rebuilt), so this needs D-6's discard/quarantine act to be survivable.
- **Option C — amend §5.3** so field-level edits of absent rows are genuinely
  droppable, and fix the spec text. *Trade-off:* smallest code change; makes
  "brings the row back to life" create-kind-only doctrine — the acknowledged
  write is still lost, so this needs the loss to become visible (a trace, a
  trash entry) to be honest.

## D-4 — Tombstone GC versus stale create ops (the spec hole behind SW-08)

§5.4 lets a tombstone be pruned once every peer acked it, but a peer can hold
an *older, unpushed* create-kind op for the same uid; after GC nothing
outranks it (composeOp resurrects — proven by reading). Even with SW-08's ack
bug fixed, the honest-ack case keeps this window.

- **Option A — delay GC until peers' outboxes are drained** of ops that
  predate the tombstone. *Trade-off:* closes the window; requires cross-peer
  outbox visibility the protocol deliberately doesn't have.
- **Option B — keep a GC log** (pruned tombstones' stamps) that resurrection
  checks consult. *Trade-off:* bounded storage; a second merge source of
  truth.
- **Option C — bound create-op replay** (creates older than a peer's
  last-ack window are refused). *Trade-off:* simple; refuses legitimate
  offline creates after long absences.

## D-5 — What is an "explicitly forgotten" peer? (the §5.4 wording vs the code)

`collectTombstonesStatements` / the ack prune (`store.ts:354-381`) exclude
`revoked_at IS NOT NULL` peers from blocking GC, while §5.4 says *"only
EXPLICITLY forgotten peers stop blocking"*. No revoke/forget UI exists
(`revokePeerStatements` is exported, `store.ts:476-483`, and called by
nothing in `src/components` or `src/pages`), so today every peer blocks — the
safe reading. The decision is what a future removal act should mean:
revoke-as-unreachable (stops blocking) versus forget-as-erase (the spec's
word). The code currently assumes the former; the spec words the latter.

## D-6 — Pre-pairing outbox policy (SW-07's parent question)

Ops recorded before pairing can carry pre-fold parent uids (or pre-restore
stamps). §11.4 gives re-pairing a discard act (unimplemented, SW-06) but says
nothing about first pairing.

- **Option A — discard/queue-isolate pre-pairing ops at adoption** (explicit
  act, per §11.4's spirit). *Trade-off:* loses or pauses the phone's offline
  history by policy.
- **Option B — ship `sync_uid_aliases` with the ops** (or resolve parents by
  natural key at apply). *Trade-off:* keeps every write; makes the fold
  durable across devices, which is new protocol surface.
- **Option C — resolve parent uids at send time** through the sender's own
  aliases (rewrite `wireOp`). *Trade-off:* keeps the wire clean; only fixes
  uids the sender itself folded.

Related sub-decision: `uploadRowStatements`' comment (`store.ts:1127-1148`)
deliberately refuses to fold natural-key collisions in the upload direction
("the insert refuses on the unique name … the failure is reported by name"),
while §8.4 says *"a natural key folds, it never collides"* — for any table.
Today the contradiction is unreachable (only seeds fold, and the snapshot fold
runs first), but the two documents should be reconciled before a flow exists
that reaches it.

---

# Checked and found clean

Auditable coverage, by name. (Spec-drift exceptions found above are marked
SW-…; these entries are the areas with no findings.)

**Sync/pairing Rust (read in full except tests):**

- `pairing_listener.rs` request handling: Content-Length cap
  (`MAX_FRAME_BYTES + header + 1`), Transfer-Encoding refused, single bounded
  read, deadlines reset around `answer` (N5), OPTIONS → 204 with **no** CORS
  headers, 405 for non-POST; `admit()` shared by every route with per-route
  kinds and unconditional pairing-id pinning (N9); protocol/schema/generation
  refusals before any write.
- Rendezvous (`rendezvous.rs`): metadata validated **before** the code is
  minted, strict UUID/hex parsing, low-order-point rejection, constant-time
  code comparison, single-use codes, attempt cap, hash-tagged public-key
  binding.
- Verdicts are sealed and report `"pending"` until the panel records a
  resolution; `hello_received` only stages a candidate; Trust requires the
  sealed hello (N7) and is the only `sync_peers` write; scan state is
  single-use from the scan instant.
- `serve_sync_ops` in-order per session, re-serves dropped batches, serves
  empty end-of-stream batches by design (the SW-04 defect is the missing byte
  budget + swallowed encode error, not the cursor logic); upload/push staging
  caps (≤64 batches, ≤200 ops) with identical-resend idempotency and
  commit-once guards; `apply_staged_upload` distinguishes create from update
  and resolves FK uids parents-first within one transaction.
- `envelope.rs` + `envelope.ts`: HKDF IKM `dh_eph||dh_static` salted with the
  pairing id, XChaCha20-Poly1305 at nonce 0 with pairing-id + opener-id custom
  AD; open order (find key → open → anti-replay slot → strip inner header →
  strict `parseWire`), safe-integer counter/seq guards (N11), cross-language
  fixtures pinning both codecs byte-for-byte.
- `pairing_key.rs`: `PairingIdentity` is non-`Clone`, non-`Serialize`,
  `Debug` prints fingerprints only; all failure paths fail closed.
- `key_store/`: desktop (DPAPI) and Android (Keystore) slots are separate from
  the DB key; overwrites zero the previous secret; factory reset deletes the
  pairing identity slot.
- `pairing_client.rs`: IP-literal endpoints only (no DNS/SSRF surface),
  explicit timeouts at every stage, kind + pairing-id checks before believing
  any reply, per-request counters.
- Capability segmentation: `share_*` and key material are desktop-only
  (`refuse_mobile_role` in `commands.rs` gates the mobile role at the IPC
  boundary); the manifest's permission set matches the features that exist.

**Rust beyond pairing:**

- `db.rs`: the SQL guard refuses transaction control, ATTACH/DETACH, key/rekey
  and *unparseable PRAGMA* fail-closed; `query_rows`/`execute`/`batch` all pass
  through it; batch pre-validates then runs BEGIN/COMMIT with honest
  rollback-status reporting.
- `schema.rs` + `db.rs` migrations: 1→11 applied as discrete, transactional
  steps with the user_version stamped inside the same transaction;
  `init_schema` fail-closed on newer or skipped-step databases; UID_TABLES
  ordered parents-before-children and pinned by tests.
- `reset.rs`: ordered components with a durable marker and an
  interrupted-reset finisher; every component reports independently and no
  failure below is masked as success; the DB (and with it outbox, tombstones,
  peers) and the key slot are deleted.
- `commands.rs` / `lib.rs`: single-instance plugin first, opener/updater
  desktop-only; every IPC route in the handler list accounted for against
  §2.2/§2.3's surface.

**TS sync engine / protocol (read in full):**

- `protocol.ts`: authority matrix incl. per-field mobile toggle rules (P1
  clean — every engine validate rule traces to it); safe-int/counter rules;
  envelope helpers pure and fixture-pinned.
- `engine.ts`: validate-all-first with zero effects on refusal (§7.1/§7.7);
  cursor advance as the last statement of the apply batch (§6.4);
  in-batch overlay (§7.6); `tombstoneStatement` under the full §4 order;
  fold ruling 1 (the §4 winner's uid survives, loser persisted in
  `sync_uid_aliases` v11, child ops resolve through it); vault ops
  aggregate-atomic (missing triple refused by name) with per-batch generation
  tracking and §12.3's adopt exception only after a wipe.
- `store.ts`: recording discipline — mutation + outbox + row stamp + tombstone
  in one batch (§6.1) across every repository hooked by the recorder
  (`budget, business, habits, loans, notes, shopping, tasks, trash, vault`);
  `applyStatements` cursor-last; outbox pruning requires delivery rows from
  every non-revoked peer (§6.5).
- `syncSession.ts`: push-then-pull ordering, batch cuts at `MAX_BATCH_OPS`,
  verdict polling with bounded attempts, `cursor_out` moved only on the sealed
  `applied` (the SW-01/02/04 wedge mechanics are in the findings; the cursor
  rules themselves are correct).
- `pairing.ts` / `pairingPanel.ts` / `mobilePairing.ts`: redeem/mint/parse
  offer hygiene (N7), `rePairStatements`' cursor-zero + ack-drop shape,
  take-once adoption, `readSnapshotBatch`'s strict wire validation (structural
  checks, budget check per SW-05), `helloReceived` gating of Trust.

**src/lib outside sync:**

- `trash.ts`: the snapshot-guard trick keeps the trash row and the domain
  delete consistent in one batch; restore records a `create`-kind op under the
  same uid (exactly the §5.3 resurrect shape) and is origin-gated per §2.3;
  §13.2 conflict copies are validated on the way in; purge rules (30-day and
  reset) audited.
- Cascades with child tombstones: `habits.ts:83-104` (`habit_logs`),
  `shopping.ts:100-125` (`shopping_items`), `notes.ts:277-320`
  (collection delete unlinks notes with per-note update ops + the FTS
  trigger fix and the collection's own tombstone).
- `backup.ts`: complete-or-nothing table set; `DEVICE_LOCAL_SETTING_KEYS`
  excluded on export **and** filtered on import (old backups cannot re-inject
  a PIN); vault verifier + generation travel with the backup (§12.3);
  `restoreStatements` (generation bump + old line's bookkeeping cleared,
  §10.1/§10.2) commits in the same transaction as the rows; the FK canary
  rolls the whole import back with a user-readable failure; photo files are
  content-addressed and orphan handling is documented honestly.
- `vault.ts`: mutations record desktop-origin only; sealed triple carried
  atomically; no plaintext or key material in ops, logs or payloads (envelope
  metadata lives in this device's own settings, never in rows).

**App shell / UI / platform:**

- `MobileScreens.tsx` is view + add + toggles only (the two shared-code
  exceptions are SW-01/SW-02); `remindableHere` (the §13.1 delivery filter) is
  wired on **both** delivery surfaces (`App.tsx:241-315` desktop ticker,
  `MobileScreens.tsx:300` Android pass) and both call the shared settle path.
- `PairingPanel.tsx` + `pairingPanel.ts`: the fingerprint-comparison UX per
  §11.2, Trust is the only pin write, adoption is take-once with an explicit
  summary.
- Android release surface (`src-tauri/gen/android`): `allowBackup="false"` +
  `dataExtractionRules`, `usesCleartextTraffic=false` on release
  (debug-true is build-type-scoped), `minSdk 26`, keystore-driven signing
  config (unsigned release configures but is documented as unshippable),
  ProGuard keeps for `ReminderBridge` and `SensitiveClipboard` (the JNI
  names), `leanback`/camera features optional. Not re-verified beyond reading:
  Kotlin/R8 real-build behaviour and the `icu_locale_core` opt-level stanza
  (both deliberately open from the Android batch).

**Test-suite evidence quality (as evidence, not as scope):** the §14.5 Stage-1
invariants in `harness.test.ts` run over the real stack (two stores,
repositories, engine, ferry) and are not skipped; `engine.test.ts`'s
authority, fold, idempotency and conflict-copy coverage matches its claims;
envelope cross-language fixtures pin both codecs. The three claims that do
**not** hold up are named in SW-01 (settle recording tested, settle apply
refused), SW-06 (`canRePair` tested, never called) and SW-09
(`conflictLosers` tested, never called).
