# Purple Memo — Android sync protocol, version 1

**Status:** written, **awaiting MinLulin's approval** (Phase C Session 1,
2026-11-08). Nothing in this document is implemented: Phase C Session 1
produces the specification, the failure-injection harness
(`src/lib/sync/harness.ts`) and the rules module (`src/lib/sync/protocol.ts`)
that judge it. No sync engine, no pairing-key exchange and no network call
exists yet, and none was added in this session.

**Authority.** This document, together with `ANDROID_DESIGN_REVIEW.md` F1/F3, is
the contract every later Phase C session is measured against. It is versioned as
a whole: protocol version `1`.

---

## 0. Scope, supersession, change control

#### §0.1 What this document is

The protocol Phase C code will be built against, and the oracle it will be
tested with. It fixes identity, ordering, durability, apply semantics, pairing
obligations, stage boundaries and the definition of "converged" — in enough
detail that an implementer has no conflict rule left to invent and a reviewer
has nothing to take on trust.

#### §0.2 What it supersedes in `ANDROID_DESIGN.md` §5

§5 of the design says: per-record `updated_at`, a per-side last-successful-sync
watermark, field LWW, and the losing version written to trash before overwrite.
`ANDROID_DESIGN_REVIEW.md` F1 shows that combination cannot preserve offline
edits: date-only timestamps tie, clocks skew, retries repeat, deletes vanish, and
an interrupted apply can advance a cursor before its effects are durable.

**Where this document and §5 disagree, this document wins.** Explicitly:

| §5 says | Replaced by | Kept |
|---|---|---|
| per-record `updated_at` decides conflicts | §4.2 clock-free version stamps | `updated_at` stays a display/sort field (§4.7) |
| per-side "last successful sync" watermark | §6.4 per-peer cursors advanced in the same transaction as effects | — |
| "same field → LWW, no prompt" | §4.2/§4.3: LWW only as the last component of a deterministic total order, never by wall clock | "no prompt" survives: the user is never asked to resolve a conflict |
| losing version to trash before overwrite | §5.5/§13.2: a conflict loser copy is device-local, for Notes/Tasks/Shopping only, and `trash_items` never syncs | the user can recover a losing copy |
| manual sync, QR + numeric pairing, same network, no relay, 17-table allowlist | — | unchanged (design decisions 1–4, 8) |

#### §0.3 Out of scope for this session

No engine, no outbox/tombstone schema migration, no pairing keys, no transport
implementation, no Stage 1/2/3 code, no device run. This session produced three
documents' worth of decisions plus a harness that runs in memory.

#### §0.4 Change control

Every later Phase C session is judged against this document. A code choice that
contradicts a clause is a **spec change**, not an implementation detail: it needs
a clause edit, a version bump (§15.1) and MinLulin's approval. The harness
(`§14.4`) is the enforcement point.

---

## 1. Identity

#### §1.1 Record identity

Every synced record carries a UUID v4 `uid` minted by the device that creates
it, per the **cross-device UID contract** in `ANDROID_DESIGN.md` (Phase A,
Session 3, pull-forward commit `e498c68`). This document does not redefine it:
canonical lowercase UUID v4, `uid TEXT NOT NULL UNIQUE` on each synced table,
minted at creation on the creating client, never user-visible, never a cursor.
Existing desktop rows are backfilled by a schema migration; a peer never
observes a null `uid`.

Local integer primary keys **never** cross the wire (F1). Each peer keeps a
local mapping from `(table, uid)` to its own row id; foreign keys and link
endpoints are local ints resolved through that mapping on apply.

#### §1.2 Device identity

`device_id` is a UUID v4 minted at first run, stored in device-local state, and
bound to the device's pinned long-term key at pairing (§11.2). It is never
copied by a backup (§10.3) and never rendered in the UI. Two peers claiming the
same `device_id` is a handshake refusal, not a merge (§7.1).

#### §1.3 Operation identity

Every mutation emits exactly one operation carrying `(device_id, seq)`: `seq`
is a per-device, monotonically increasing, durable counter. That pair is the
operation's identity; an `op_id` UUID travels alongside it for logging only. A
retry re-sends the **same** pair and the same bytes — a receiver dedups by
`(device_id, seq)` (§7.2), so "did I already apply this?" is a lookup, never a
guess.

An operation is immutable once written to the outbox (§6.1). A device that
wanted to change an op writes a new one.

#### §1.4 Aggregate identity

An aggregate is the unit some tables must move as one (§4.4): a job with its
payment-derived counters, a loan with its repayments, the Vault projection with
its password generation. Aggregates are named so a batch never splits one
(§8.3).

#### §1.5 What identity is not

Not a cursor, not an ordering key, not an auth token, not a merge weight
(UID contract item 5). Ordering lives in §4; cursors live in §6.4.

---

## 2. Scope boundary: the 17-table allowlist

#### §2.1 The 17 tables and their authority

Design decision 1 (narrow 17-table core), with per-operation authority from
decisions 3, 4 and the interaction-model refinement. The phone's authority only:

| Module | Tables | Phone may |
|---|---|---|
| Notes | `collections`, `notes` | create, delete, view |
| Tasks | `tasks`, `reminders` | create; toggle `tasks.done`; delete; reminders per §13.1 |
| Budget | `income_entries`, `expense_entries` | **append** only — never edit or delete |
| Budget | `wallets`, `income_categories`, `expense_categories` | read only (desktop-owned) |
| Business | `shops` | read only |
| Business | `jobs` | create only — payment fields are desktop-only |
| Loans | `loans` | create only — repayments are desktop-only |
| Habits | `habits` | read only |
| Habits | `habit_logs` | create/delete (a check-in is a row) |
| Shopping | `shopping_lists`, `shopping_items` | create, delete; toggle `shopping_items.done` |
| Vault | `vault_items` | read only (one-way desktop→mobile) |

`src/lib/sync/protocol.ts` encodes this table as data (`SYNC_TABLES`,
`writeAllowed`, `updateFieldsAllowed`); the harness asserts the boundary.

#### §2.2 Desktop-only rows never leave the desktop

Hard boundary, not a convention. These never appear in an op, a batch, a
snapshot, a tombstone or an ack: `expense_limits`, `recurring_payments`,
`payables`, `settings`, `links`, `trash_items`, `photos`, `photo_refs`,
`notes_fts`.

So do the excluded modules' tables: `contacts`, `contact_channels`,
`contact_tags`, `journal_entries`, `memories`. They are in the same database, so
a leak is always one careless loop away — the harness injects a `contacts` row
on purpose and the leak oracle must name it (§14.4, `desktop-only-leak`).

`notes_fts` is derived: each peer rebuilds it locally and it is never
replicated.

#### §2.3 Operation allowlist

Only the operations above cross the wire, expressed as
`(table, op ∈ {create, update, toggle, delete}, fields)`. There is no SQL on the
wire, no `db_execute` over LAN, and the receiving side validates the table, the
op kind, the field set and the payload shape **before** any effect (§7.1). A
`toggle` names the single field it flips; it is not a general update.

#### §2.4 Which peer's data is authoritative

The desktop is the authority for every table (`§2.1` read-only rows); the phone
is the authority only for the rows it created, until the desktop edits them, at
which point §4 decides. "Both devices hold identical data" was true of the
Oct 26 design; with a subset app it means **identical over the 17 tables**, and
nothing else.

---

## 3. Wire format and transport requirements

#### §3.1 Envelope

A batch is `{ protocol_version, schema_version, generation, from_device, pairing_id, ops[] }`.
Each op is `{ device_id, seq, op_id, table, uid, kind, fields?, field_stamps?, base_counter? }`.
`base_counter` is diagnostic only — a receiver never trusts the sender's claim
about what it built on (§4.5).

#### §3.2 Batches are bounded and never split an aggregate

At most 200 ops or 256 KiB per batch, whichever binds first; an aggregate is
never split across batches (§8.3). The sender cuts between whole aggregates, so
a batch exceeds the bound **only** when one aggregate alone is larger than a
whole batch — and that aggregate then travels whole, in a batch of its own. The
receiver applies the same rule: an over-bound batch is accepted only as that one
whole aggregate, and refused otherwise.

#### §3.3 Transport is authenticated, encrypted and replay-proof

Requirements, not implementation: authenticated encryption under the pinned
peer key; the one-time pairing secret is single-use; replayed or reordered
batches cannot take effect twice (§7.2) or out of order (§7.6). No homemade
cryptography (F7); the library choice is a pairing task, not a protocol change.

#### §3.4 Nothing is applied before it validates

A batch is validated as a whole (tables, ops, fields, schema) before its first
effect. An invalid batch is rejected with a reason (§7.7) and leaves no trace.

---

## 4. Causality and conflict ordering — the core decision

#### §4.1 Wall-clock time is not the order

`updated_at` in this codebase is a local calendar date (`todayLocal()`), often
identical on two devices; clocks skew (the phone's auto-time can be minutes or
days off); retries re-send; a delete leaves no row to compare; and an apply
interrupted after the cursor advance would lose the effects while claiming
success. Ordering by "newer timestamp" is therefore not merely imprecise — it
cannot even represent two of those five cases. §4.2 replaces it.

#### §4.2 Record version stamp — a Lamport counter, tie-broken by device id

Each record carries `(counter, device_id, op_id)`:

1. Every device keeps one durable Lamport counter. A local write stamps
   `counter = ++local` (§4.2's only clock).
2. Applying an inbound op sets `local = max(local, incoming.counter)`, so the
   next local write outranks everything merged before it.
3. Conflicts are decided by `compare(a, b)`: higher `counter` wins; equal
   counters tie-break on `device_id` (lexicographic, canonical lowercase);
   equal device ids tie-break on `op_id`. This is a **total order**, identical
   on every device, independent of arrival order (§4.5) and of any wall clock
   (§4.7).

A record's `counter` is the counter of the write that produced its current
value: applying a winning op moves the record's stamp to that op's stamp,
including the winning device's id, so a third peer recomputing the merge reaches
the same answer.

#### §4.3 Field versions

For genuinely independent fields the protocol carries per-field stamps
(`field_stamps`): a write bumps only the fields it changes. Two devices editing
a note's title and body respectively both keep their edit — the merge is
per-field, decided by the same §4.2 order on each field's stamp. A field a peer
did not change is not compared at all.

On the phone the writable field set is one toggle (§2.1), so field versions exist
mainly for desktop↔desktop and for later stages; they are specified now because
adding them later would change the wire format, not just the engine.

#### §4.4 Aggregate-atomic tables

`jobs` (with payment-derived counters), `loans` (repayments) and the Vault
projection (§12.3) are versioned **as aggregates**: their stamp covers the whole
group, an op carries the whole group, and no per-field merge happens inside
them. F3 is the reason: `paid_cents` and an income entry are one business fact,
and merging them independently can keep one counter while both entries survive,
or lose one of two repayments.

#### §4.5 Determinism is a requirement, not a nicety

For the same set of ops, every peer must reach the same state regardless of
delivery order, retries or which side asks. `base_counter` from the sender is
advisory: a receiver that cannot verify lineage must still produce the same
answer as one that can. This is what makes "apply the same batch again" and
"apply batches in another order" both testable.

#### §4.6 Decision record

- **Chosen:** per-record (and per-field, and per-aggregate) Lamport counter with
  a device-id tie-break, carried on every op.
- **Rejected — hybrid logical clock (HLC).** It reintroduces physical-clock
  proximity into the tie-break: a peer whose clock is ahead wins ties for a
  reason that has nothing to do with causality, which is F1's failure with extra
  steps. It also makes deterministic tests depend on fake clocks, and it buys
  nothing at this write matrix, where the phone does not edit existing rows
  except single toggles.
- **Rejected — vector clocks per record.** Correct, but costs per-peer state on
  every row of 17 tables, and its value (detecting concurrency) is exactly what
  this design does not need: conflicts are resolved deterministically with no
  prompt, so concurrency only has to be *ordered*, not *detected*.
- **Rejected — a timestamp column** (design §5). See §4.1.

#### §4.7 `updated_at` keeps its day job

`updated_at` stays in the schema for display and sorting. It is never an
ordering key, never a cursor and never a tie-break. A future migration may make
it a real instant for UI purposes; sync will not care either way.

---

## 5. Deletes: tombstones, cascades, collection

#### §5.1 Tombstone shape

A delete becomes a tombstone: `{ table, uid, stamp, device_id, op_id }` —
identity and order, no user content. The row's physical delete and the
tombstone insert are one transaction, as is the outbox append (§6.1).

#### §5.2 Cascades travel as tombstones

A delete that cascades locally must emit a tombstone for **each** row it
removed. The cascades that matter (verified against `src-tauri/src/schema.rs`):

- `collections` → `notes` (a note's `collection_id`);
- `shopping_lists` → `shopping_items` (`ON DELETE CASCADE` in the schema);
- `habits` → `habit_logs` (`ON DELETE CASCADE`);
- a task and its `reminders`, where the desktop deletes them together;
- a note's `photo_refs` are **local only** and never tombstoned — they are not
  in the allowlist (§2.2).

A delete that relied on the FK cascade without emitting child tombstones is a
data-loss bug, not an optimisation: the peer keeps the child and resurrects it
into a parent-less state. This is why `cascaded-child-delete` is a required
injection (§14.4).

#### §5.3 A tombstone beats a concurrent edit

If a record is deleted at stamp `(5, desktop)` and edited at `(5, phone)`, the
§4.2 total order decides — and the delete wins over any edit whose stamp is
lower. An edit with a **higher** stamp than the tombstone resurrects the record
as a new live record (a deliberate, visible act: the user edited a record they
could still see). A tombstone is never removed by an edit of equal or lower
stamp, and never by a retry.

#### §5.4 Tombstone collection

A tombstone may be collected only after **every known peer has acknowledged
it** (`tombstoneGcEligible`): `acked_by ⊇ peers`. Consequences, all deliberate:

- An empty peer list collects nothing — a device that has never paired keeps
  its tombstones.
- A peer that is revoked or removed from the allowlist stops blocking
  collection only when it is explicitly forgotten (which is a user act with a
  stated consequence: that device must re-pair and re-snapshot).
- Collection is a maintenance pass, never part of apply.

#### §5.5 Trash never syncs, and a loser copy is not an op

`trash_items` is device-local (§2.2). A conflict loser (§13.2) is copied into the
**local** trash of the device that held the losing value, in the same
transaction as the winning apply (F3's rule). The other device never sees that
copy and nothing about trash travels.

---

## 6. Durable outbox, cursors, acknowledgements

#### §6.1 The outbox row is written with the mutation

Every domain mutation writes its outbox row **in the same transaction** as the
row change. The invariant: *no acknowledged write can exist without its sync
record*. A crash between the two is impossible by construction, and a
transaction that fails rolls both back.

#### §6.2 Outbox shape and order

`{ device_id, seq, op_id, table, uid, kind, fields, created_at }`, read in
`seq` order. `seq` is the operation identity (§1.3) and the retry key. Rows are
pruned only on acknowledgement (§6.5).

#### §6.3 Delivery is at-least-once

The sender may re-send any unacknowledged batch at any time: after a lost
connection, a lost ack, a crash, or a pairing retry. Duplicates are normal and
must be harmless (§7.2). "Exactly once" is never assumed anywhere.

#### §6.4 A cursor advances only inside the apply transaction

Each peer stores, per peer device, the last `seq` it has applied **contiguously**
and committed. The cursor is written in the same transaction as the effects, so:

- an interrupted apply leaves the cursor where it was;
- a cursor can never point past an effect that did not commit;
- re-sending from the cursor replays only what was genuinely lost.

This clause is the direct replacement for §5's "last successful sync" watermark
(F1's fifth failure).

#### §6.5 Acknowledgements and pruning

The receiver acknowledges `(peer_device, up_to_seq)` after the commit. The
sender prunes outbox rows `seq ≤ up_to_seq` and only those. Tombstones are
collected on the same evidence (§5.4). An ack that never arrives costs a resend,
never correctness.

#### §6.6 Crash recovery

On boot: cursor = the committed value, outbox = whatever survived its
transactions, tombstone set = whatever survived. Nothing is inferred from
timestamps, "last sync" labels or in-memory state. Recovery is *resume and
re-send*, not *reconcile by guessing*.

---

## 7. Apply semantics

#### §7.1 Preconditions

Before the first effect of a batch: handshake accepted (§8.2), peer pinned and
not revoked (§11.3), generation matched (§10.2), every op's table and kind
allowed (§2.3), every payload schema-valid (§3.4). Any failure is a refusal
with a reason and **zero effects** — a refusal is a wall, not a warning.

#### §7.2 Idempotency

Applying the same op twice changes nothing and still returns the same ack: the
receiver keeps applied `(device_id, seq)` identities (at least until the
tombstone/outbox horizon allows pruning them), and an op whose effects already
exist is a no-op. Duplicate delivery is therefore a transport detail, never a
data event.

#### §7.3 Determinism

Applying a batch to two identical starting states produces identical states, and
applying `[A, B]` or `[B, A]` produces the same merged records. The engine is
allowed to be slow; it is not allowed to be order-dependent.

#### §7.4 Atomicity per batch

All ops in a batch commit or none do. A crash mid-batch loses the whole batch
and the sender re-sends it. There is no half-applied batch and no partially
advanced cursor.

#### §7.5 Resumability

After a crash the sender re-sends from its outbox from the last acknowledged
`seq`. Re-applied ops are no-ops (§7.2); nothing acknowledged is lost, and
nothing is applied twice.

#### §7.6 Ordering

Ops are applied in the order given and merged per §4. Cross-batch order does not
matter (§4.5), which is what allows the sender to batch freely and a peer to
resume anywhere.

#### §7.7 Rejections are explicit

An invalid op, disallowed table/op, bad field set, schema mismatch or revision
mismatch produces a stated refusal naming the op. Silent drops are forbidden:
they are indistinguishable from a lost batch and would hide a protocol bug
forever.

---

## 8. Negotiation, batching, initial snapshot

#### §8.1 Hello

Both sides exchange `{ device_id, protocol_version, schema_version, generation,
pairing_id, last_acked }` before any op. The hello is authenticated by the
pinned key (§11.2).

#### §8.2 Version rule

- `protocol_version` must match exactly in v1 (both apps ship together). A peer
  that speaks another version is refused with an actionable message, never
  silently down-merged.
- `schema_version` must match: the two builds hold the same 17 tables with the
  same columns.
- `generation` must match, else re-pair (§10.2).
- A future bump keeps the same major only while the older side can still refuse
  safely; a change in merge semantics is always a major bump (§15.1).

#### §8.3 Bounds

200 ops / 256 KiB per batch (§3.2); the sender chooses the size, the receiver
enforces the bound. An aggregate is never split (§1.4) — not even when a snapshot
is read table by table and its rows arrive far apart.

**The bound counts aggregates, not rows (D4).** The sender flushes before an
aggregate would cross the bound: 199 unrelated notes followed by a 3-row shopping
list is a 199-op batch and then a 3-op batch, never 202 ops. A batch is therefore
over 200 ops or 256 KiB only when one aggregate alone is larger than a whole
batch, and that aggregate travels whole in a batch of its own. The receiver
enforces the same rule — a single whole aggregate is the only over-bound batch it
accepts — so a sender and a receiver cannot disagree about whether a batch is
legal.

**The pairing frame is tighter than §3.2.** A pairing message is capped at
64 KiB (§11.6.1), and the sealed envelope **hex**-encodes its ciphertext — the
body is 2× the plaintext, not base64's 4/3 — so one snapshot batch carries at
most **30 KiB of rows (30,720 bytes)** and 200 ops. That is ~62 KiB sealed,
leaving ~3.5 KiB of the frame for the envelope's own header and the frame's
length prefix. 32 KiB of rows would be ~66 KiB and is refused before it leaves
the desktop; 48 KiB would be ~98 KiB. A test seals a max-size batch and asserts
the framed envelope fits, and seals 32 KiB of plaintext and asserts it does not.
The §3.2 bound still governs the ordinary operation path, which does not use the
pairing frame.

#### §8.4 Initial snapshot

The snapshot is a consistent point-in-time read of the 17 tables **plus** their
tombstones, taken in one transaction on the desktop, applied in one transaction
on the phone, and then acknowledged as a whole. A snapshot is not a cursor and
carries no `seq`, and it moves no cursor: the **adopted row stamps are the merge
baseline** for every record the snapshot carried (§8.5), and `cursor_in`
advances only through §6.4's operation path. If the snapshot is interrupted,
nothing is applied and it is re-taken — the phone never holds half a snapshot.

**A natural key folds, it never collides.** Four synced tables declare `name`
unique — `collections`, `wallets`, `income_categories`,
`expense_categories` — and the baseline seeds three of them on every fresh
install under *random* uids, so the same seed is two records, one per device.
When an adopted row's natural key matches a local row that carries a different
uid, the row **folds** onto it: the local row keeps its `id` (its children stay
attached), its `uid` is re-keyed to the incoming one, and the incoming fields
and stamp then land through the ordinary upsert. A row whose name is unknown
locally, or whose uid is already present, is written exactly as before. This is
the rule the Stage 1 op-apply inherits (`foldStatements`, shared by both
borders): there the folded create lands through §4's field-by-field merge
rather than this border's upsert, because an op is a versioned write and a
create must not outrank a newer local value; a create that outranks nothing
still carries the row's own stamp across to its new key (§4.2). Deterministic
seed uids were rejected, because they cannot repair a database that already
exists.

#### §8.5 The snapshot transport (`/pair/snapshot`)

Phase C Session 3. All four messages are sealed envelopes (§11.6.1) POSTed to
`/pair/snapshot`, framed like every pairing message and bounded by the same 5 s
budgets. Admission is the hello's, in §7.1 order — revoked → unpinned → key
mismatch → pairing id → protocol → schema → generation → replay — so a revoked
peer's request is refused before the snapshot is even read: not one batch byte
leaves the desktop.

1. phone → sealed `{kind:"snapshot-request", pairingId, protocolVersion,
   schemaVersion, generation, batch}` — asks for batch N (0-based).
2. desktop → sealed `{kind:"snapshot", pairingId, batch, total,
   ops:[{table, uid, stamp, fields}], tombstones:[{table, uid, stamp}]}` — one
   batch: ≤ 200 ops and ≤ 30 KiB of rows (§8.3). A single row larger than the
   budget still travels: a record that cannot be sent is worse than a frame over
   the target.
3. phone validates the batch (op count, plaintext budget, every `uid`
   well-formed, every table in §2.1's 17, every stamp well-formed) and stages it
   **unapplied**.
4. phone → sealed `{kind:"applied", pairingId, batch}`. The desktop records it;
   asking for the same batch again re-serves it, and acknowledging it twice in
   one pull is `replayed`.
5. after the last batch is staged, the phone applies the whole snapshot in
   **one** transaction (§8.4), records the checkpoint
   (`appliedBatches == totalBatches`), and sends sealed
   `{kind:"adopted", pairingId, counts:{rows, tombstones}}`. The desktop accepts
   that only once every batch was acknowledged: "applied the last one" is not
   "applied all of them".
6. foreign keys travel as `<column>_uid` — the parent's uid, never a local rowid
   — and the phone resolves them to its own ids while applying, parents first.
   §2.1's table order already puts every parent before its children
   (`collections` before `notes`, categories and `wallets` before entries,
   `shops` before `jobs`, `shopping_lists` before `shopping_items`, `habits`
   before `habit_logs`), so one ordered pass suffices.
7. refusals, named and effectless: `not-allowed` (a kind this route does not
   serve, a table outside the 17), `pairing-mismatch`, `malformed`,
   `needs-re-pair` (canonical, never `generation-mismatch`), `unauthenticated`,
   `schema-mismatch`, `replayed` (an envelope counter already accepted, a batch
   already acknowledged in this pull), `revoked`, and `snapshot-busy` (a second
   stream in one window: a request that skips past the batch the phone has not
   acknowledged yet).

**A snapshot moves no cursor.** Its adopted row stamps are the merge baseline
for every record it carried — which value the row holds, and which write it
came from — while `cursor_in` advances only through §6.4's operation path. A
snapshot carries no `seq` (§8.4), so there is no number it could advance a
cursor to; inventing one would make the next op batch look already applied. The
adoption's checkpoint (`appliedBatches == totalBatches`) is what remembers that
the snapshot finished.

The desktop reads the snapshot **once**, on the first request in a window, and
holds it for the life of the window; a new window re-takes it (§11.4). Nothing
it serves is applied on its side, so an interrupted pull costs it nothing and
the phone re-takes from batch 0 — precisely §8.4's "nothing is applied and it is
re-taken".

---

## 9. First pairing between two populated devices

#### §9.1 Adoption, never a wipe

Design decision 3 and the UID contract item 4: the phone pulls the desktop
snapshot, keeps every record it created offline, and uploads those whose `uid`
the desktop does not hold, as new records under their existing UIDs. The
desktop accepts each new UID idempotently; a repeated upload of the same UID is
a no-op (§7.2). **No side is wiped.** `planAdoption` returns `deletions: []`
and a test asserts it (the field exists precisely so a "bootstrap by wiping"
implementation is visible).

#### §9.2 What happens to each side's records

- Desktop-only records: arrive on the phone in the snapshot.
- Phone-only records: offered as new records; the desktop inserts them.
- A UID both sides hold with different values: the same record, merged by §4,
  with the loser copied to local trash if it is a mutable entity (§13.2).
- A UID both sides hold with identical values: nothing to do.
- A coincidental UID collision (different records, same UID): treated as the
  same record, resolved by §4. The probability is negligible (122 random bits),
  and the outcome is a merge, not a crash.

#### §9.3 What the user sees

One summary at the end of pairing: how many records moved each way, how many
were kept on both sides, and — plainly — that nothing was deleted. Per-record
prompts do not exist (design: no prompt). The pending-change count on the
Dashboard comes from the outbox row count, never from a timestamp (§F7).

#### §9.4 An interrupted first pairing is retryable

Cursors are not advanced by a partial upload; the outbox still owes the ops; the
snapshot is re-applied transactionally (§8.4). A second pairing attempt against
an already-adopted phone skips `alreadyKnown` UIDs and re-takes the snapshot.

#### §9.5 Conflict losers during adoption

Possible only where the phone may write at all: Notes/Tasks/Shopping (§13.2),
plus `habit_logs` toggles, where the loser is simply not applied and leaves no
copy (a check-in is not content worth archiving). Append-only and create-only
records cannot conflict: the phone never changes an existing row there.

#### §9.6 The upload transport (built 2026-11-12)

§9.1's direction runs on a third route, `POST /pair/upload`, following the
§8.5 snapshot pattern: the same `admit` path (§7.1 order, the route's own
kind allowlist), the same envelope, and a revoked peer refused before
admission. Three kinds:

- `upload` — one batch of row operations, at most 200 ops per batch and 64
  batches per upload, each op carrying its `table`, `uid`, §4.2 stamp and
  fields. The desktop **stages** the batch and applies nothing. Batches land
  in order; re-sending an already-staged batch with identical ops is
  acknowledged again (the lost-ack case), while different ops at a staged
  index, a skipped index, or a batch after the commit is refused
  `upload-busy`. The batch total is declared by batch 0 and may not change.
- `upload-commit` — every batch was sent. A commit before the last batch is
  `malformed`; a second commit is `replayed`.
- `upload-status` — the verdict, and the one reply the phone acts on, so it
  is **sealed** (unlike §8.5's plain `applied`/`adopted` receipts):
  `pending`, or `uploaded` with the inserted and already-known counts, or
  `failed` with the apply's own reason.

The apply is the desktop panel's, not the listener's — the same split as the
pin. When the panel's settle tick first sees the committed staging, it takes
the ops exactly once and decides:

1. **Every op is validated first** (§3.4: allowlisted table, canonical uid,
   complete stamp, fields a record, no local row id). One invalid op fails
   the whole upload before anything is written.
2. **Ops the desktop already holds are §7.2 no-ops** — counted as already
   known, never rewritten, whatever stamp they carry. Stage 1's op-apply
   inherits §4 merges for genuinely diverged rows; adoption has none,
   because §9.2's plan only offers uids the snapshot did not contain.
3. **The rest insert plainly, in one transaction**, parents first, foreign
   keys resolved by uid, each row's stamp recorded with it. There is **no
   natural-key fold** here — adoption already folded every same-name pair
   onto the desktop's uids on the phone's side at snapshot time (§8.4), so a
   natural-key collision means a same-name record was created on the desktop
   after the snapshot was read; the insert refuses, the transaction rolls
   back, and the failure is reported to the phone with the database's own
   reason. The upload is retried against a fresh snapshot, never silently
   merged.

The staging lives and dies with the pairing window: closing the panel
discards an unapplied upload whole, and nothing on the desktop changes
before the commit. The phone writes nothing locally and marks nothing, so
§9.4's retry is the same plan recomputed against a fresh snapshot. An
upload whose plan is empty — the desktop already holds every record —
sends nothing and is reported as such, grounded in the snapshot the same
pairing just took.

#### §9.7 The ongoing exchange (built 2026-11-13)

After the first pairing, the two devices have operations for each other
rather than records: §6's outbox rows, merged by §4 rather than adopted.
They travel on a fourth route, `POST /pair/sync`, again following §8.5's
pattern — the same `admit` order, its own kind allowlist, the revoked peer
refused before anything else, and every phone message carrying
`pairingId`, `protocolVersion`, `schemaVersion` and `generation`. Five
kinds, both directions on one route because a sync is one exchange:

- `sync-push` — one batch of the phone's operations, at most 200 per batch
  and 64 batches, each op being §6.2's outbox document (`device_id`,
  `seq`, `op_id`, `entity_table`, `entity_uid`, `op`, `base_counter`,
  `counter`, `field_stamps`, `payload`). The desktop **stages** the batch;
  a re-sent identical batch is acknowledged again, a different batch at a
  staged index or a skipped index is refused `sync-busy`.
- `sync-commit` — every batch was sent. A commit before the last batch is
  `malformed`; a second commit is `replayed`.
- `sync-pull` — `{ batch, afterSeq }`: the desktop serves its own outbox
  rows with `seq > afterSeq`, read **once** on the first pull of the
  window and held for the window's life (the §8.5 rule), in batches, each
  reply **sealed**: `{ kind: "sync-ops", pairingId, batch, total, ops }`.
  Asking for a batch twice re-serves the same rows; asking from another
  position is `sync-mismatch`. The end of a pull is a batch with nothing
  after it.
- `sync-applied` — `{ throughSeq }`: the phone applied the desktop's ops
  through that seq. Recorded on the listener for the panel, which turns it
  into a §6.5 acknowledgement.
- `sync-status` — the push verdict, **sealed** like §9.6's: `pending`, or
  `applied` with the highest seq the desktop's engine applied, or `failed`
  with the engine's own reason.

The apply is the panel's, at the same seam as the upload: the settle tick
that first sees `staged` takes the ops exactly once and runs `applyOps`
over them in one batch — validation first (§7.7), so a refused operation
refuses the batch with nothing written, and the cursor advance is that
same batch's last statement (§6.4). The outcome it reports is what
`sync-status` seals.

**Only Stage 1's eight tables travel.** The sender filters its own outbox
before batching, because an operation for a later stage can exist on
either device (a Trash restore records for any synced table) and the
engine would only refuse it; the filter is the sender keeping the wire
honest, not a second safety net.

**The cursors are the only memory.** `cursor_in` moves inside each apply
batch, `cursor_out` moves when the phone believes the sealed `applied`
verdict — never when a batch was merely sent. An interrupted session
resumes from those two numbers: the phone re-offers nothing the desktop
acknowledged, and asks for nothing it already applied. Silence is not
success: a verdict that never arrives leaves every operation where it
was, and the next session sends it again.

---

## 10. Restore, reset and the data generation

#### §10.1 The generation names the data line

The desktop database carries a `generation` integer, bumped by **any** restore
(whatever the backup's age) and by a factory reset. It is not a clock and it
does not order data: it says "this is a different line of history from the one
you knew".

A re-pair does **not** bump it (D3). `rePairStatements` gives the re-paired peer
a fresh `pairing_id` (§11.4), which already isolates its new session; bumping the
generation as well would invalidate every *other* paired peer's session for a
change that touched none of their data.

#### §10.2 A generation mismatch refuses to sync

The phone stores the generation it paired with. On hello, a mismatch refuses
with "re-pair this phone" (§8.2) before a single op moves. This is what stops a
restored desktop from ruling on a newer mobile edit using a stale cursor, and
what stops an old backup from replaying stale authority (F8).

#### §10.3 Device-local state is never in a backup

Never in a backup payload: pairing keys and pinned peer keys, per-peer cursors,
acknowledgements, pending outbox rows, conflict copies, delivery state, the
device id, the generation (the desktop's own generation is restored with its
data line), the wrapped DEK, the app PIN, mobile-local settings. The desktop
backup keeps user data and whichever replication identities are stored with the
rows (UIDs, stamps, tombstones).

#### §10.4 Reset revokes and forgets

A desktop reset bumps the generation, drops the outbox, tombstones and peer
allowlist, and revokes every paired device. A phone wipe takes its keys, cursors
and outbox with it; its records are gone with the wipe, and that is the phone's
own local-data decision, not a sync event.

#### §10.5 An old backup cannot replay stale authority

Restoring an old backup restores old rows and old tombstones under a **new**
generation. The phone refuses (§10.2) and re-pairs, re-taking the snapshot from
the restored desktop. Two consequences are accepted and stated in the release
notes: a phone that had not yet pushed its outbox loses those ops unless the
user pairs before restoring on the desktop, and records created on the phone
after the backup was taken that are not in the backup's line are re-offered as
new records at the next pairing (they are not in the desktop's UID set).

---

## 11. Pairing and revocation — what the protocol requires

#### §11.1 QR primary, numeric fallback

The QR carries the LAN endpoint, the **desktop's** long-term public key and its
fingerprint, the single-use pairing secret and the data line it is pairing for.
It cannot carry the phone's key: the desktop does not know it yet. The
`POST /pair/request` of §11.6.1 exchanges that key, and only then do both
screens show **both** fingerprints — the pair the person compares before
pressing Trust (§11.2). The numeric fallback is the same rendezvous with the
code typed instead of scanned: short-lived, rate-limited, single-use, and
confirmed by the same pair of fingerprints — a low-entropy code must never
become a bearer password (F7). Camera permission is the QR path only; manual
entry must remain first-class.

#### §11.2 Pinned long-term keys

Each device has a long-term keypair. Pairing pins the peer's public key; every
later session is authenticated under the pinned key, with no trust-on-first-use
after the first pairing. A changed key is not "a new phone with the same name":
it is a re-pair, confirmed by fingerprint, or a refusal.

#### §11.3 A revoked peer is refused before anything flows

Revocation removes the peer from the local allowlist. The next hello from that
device is refused before the first op, with a reason the user can act on
("re-pair this phone"), and **no batch is applied or acknowledged**. Revocation
is local and immediate; it does not need the other device's agreement.

#### §11.4 Re-pairing

Re-pair mints a new pairing id, resets cursors, and re-takes a snapshot. Because
unacknowledged phone writes are device-local (§10.3), re-pair **refuses while
the outbox is non-empty** unless the user explicitly discards those changes —
the design's flagged assumption is promoted to a rule here, because "your
offline edits vanished silently" is exactly the failure this phase exists to
prevent.

#### §11.5 Listener lifetime

A writable listener lives only for a manual sync, and stops on lock, on reset
and on app background. There is no always-on port, no hosted relay and no
auto-sync (design: manual only).

#### §11.6 Security requirements, not a crypto design

Authenticated encryption under the pinned key; single-use pairing secret;
replay protection; no homemade cryptography; table/operation allowlists enforced
server-side. The library and framing are chosen in the pairing session and must
satisfy these properties; the properties are not negotiable.

#### §11.6.1 The choice (Phase C Session 4)

Chosen here, as §11.6 requires. **Framing:** length-prefixed UTF-8 JSON
messages over HTTP/1.1 on the LAN — `std::net` on **both** sides,
`src-tauri/src/pairing_listener.rs` on the desktop and
`src-tauri/src/pairing_client.rs` on the phone, bound to the pairing window only
(§11.5). Session 7's deferred correction: the phone does **not** use a webview
`fetch`, because the long-term key lives behind the platform keystore and a
webview that could seal a message could also read the secret; the listener was
never `tiny_http` either — it owns its accept loop so a stalled client cannot
hold the window open. After pairing, every message
is a sealed envelope: a fresh ephemeral X25519 keypair per message, combined
with the pinned long-term agreement through HKDF-SHA256, then
XChaCha20-Poly1305 with a per-message 24-byte nonce and the message header as
associated data. **Libraries:** `@noble/curves` (X25519) and
`@noble/ciphers` 2.4.0 (XChaCha20-Poly1305, already a dependency and already
vendored for the share page) in the webviews; `x25519-dalek` and
`chacha20poly1305` on the desktop listener’s Rust side; `qrcode` 1.5.4 to render
the offer and `jsqr` 1.4.0 to scan it.

**The construction, as built (Session 5b).** The envelope is not static-static
and carries no recorded deviation from this section:

- The sender mints a **fresh X25519 keypair per message**. Its public key rides
  in the authenticated header as `eph` (32 bytes, lowercase hex), so a forged
  one is refused with the envelope rather than used.
- Two agreements against the receiver’s long-term public key:
  `dh_eph = X25519(ephemeral_secret, receiver_public)` and
  `dh_static = X25519(sender_secret, receiver_public)`. The receiver computes
  the same pair from its own secret — `X25519(receiver_secret, eph)` and
  `X25519(receiver_secret, sender_public)`.
- `IKM = dh_eph || dh_static` — 64 bytes, ephemeral first, fixed order.
- `salt` = the pairing id’s UTF-8 bytes. **32 zero bytes only when the flow has
  no pairing id**; a window with no pairing id refuses every hello, so that
  branch seals nothing in practice.
- `info` = `purple-memo-envelope-v1`, then `0x00` + the sender id, `0x00` + the
  receiver id, `0x00` + the pairing id (empty when absent). NUL separators, so
  the four fields cannot be re-split ambiguously.
- `key = HKDF-SHA256(IKM, salt, info, 32)`; the header (with `eph`) is the AEAD
  associated data.
- A low-order point yields an all-zero agreement and is refused as malformed.

`eph` is a **sender** ephemeral, and the claim it supports is narrower than
symmetric forward secrecy. It gives per-message key separation and resistance
to a later compromise of the *sender's* long-term key: a recorded envelope
cannot be opened from the sender's key alone once the ephemeral secret is gone.
It does not protect the receiver. The receiver's long-term secret plus the
public `eph` reproduce both agreements — `X25519(receiver_secret, eph)` and
`X25519(receiver_secret, sender_public)` — so a later compromise of the
**receiver's** long-term key opens every envelope that was sent to it. True
ephemeral–ephemeral forward secrecy is **deferred**, not claimed; what bounds
the exposure today is §11.5's short-lived LAN window together with the
per-message nonce and counter (a replayed envelope is undecryptable or a
no-op). No wire change is implied by this paragraph (decision D2).

**Endpoints, kinds and refusals (as built).** `POST /pair/request` (plaintext,
code-gated), `POST /pair/hello` (sealed, `hello`), and `POST /pair/snapshot`
(sealed, `snapshot-request` / `applied` / `adopted`; §8.5 — Phase C Session 3).
Each route has its own kind allowlist and all three share one admission path, so
no route can lose a check the others have. The refusal codes are `revoked`,
`unpaired`, `unauthenticated`, `wrong-sender`, `wrong-recipient`,
`wrong-version`, `replayed`, `pairing-mismatch`, `protocol-unsupported`,
`schema-mismatch`, `needs-re-pair`, `not-allowed`, `snapshot-busy`,
`same-device`, `malformed`, and on the rendezvous only `wrong-code`, `expired`,
`used`, `locked`. Every one is named, actionable and effectless.

How each property is met:

- **Authenticated encryption under the pinned key** — the envelope’s X25519
  exchange is signed/confirmed against the pin from §11.2, so a peer without the
  pinned private key cannot produce an openable envelope.
- **Single-use pairing secret** — the 120 s / 5-attempt code of §11.1 gates the
  *rendezvous only*. It is never the encryption key; the human confirms the
  pinned key by fingerprint, which is what keeps a 6-digit code from becoming a
  bearer password (F7). No PAKE is required because the code authenticates no
  data.
- **Replay protection** — XChaCha20-Poly1305 with a fresh nonce per message plus
the `(device_id, seq)` operation identity and per-peer cursors of §1.3/§6.4; a
replayed envelope is either undecryptable (nonce reuse is refused) or a
no-op (§7.2).
- **No homemade cryptography** — every primitive is a published library; this
document fixes *what* is encrypted and *which* key authenticates it, never how
any primitive is built.
- **Server-side allowlists** — the desktop validates table, op kind and field set
  (§2.2/§2.3) before any effect, so a phone cannot talk its way past the
  boundary by sending a shape the app never produces.

**First pairing: the two endpoints, as built (wave 1).** A window that was
opened with an offer serves two paths, both framed as above and both alive only
while pairing is on screen (§11.5):

- `POST /pair/hello` — every message after a pin exists. Framed, sealed under
the pinned key, with the fields and check order of §9; a pairing window accepts
`hello` as its only payload kind, and a hello from a device this desktop has
not pinned is refused `unpaired` (a revoked peer is refused `revoked` before
anything else, §11.3).
- `POST /pair/request` — the code-confirmed rendezvous of §11.1, sent once and
in **plaintext**. It cannot be sealed: the desktop does not know the phone's
key yet. It proves possession of the single-use code and nothing about the key
it carries. Accepting it **stages** the presented key as this window's
candidate; the pin is written only when the person presses Trust after a sealed
hello has proved possession and both fingerprints were compared (§11.2).

A request is one JSON object (camelCase, framed like every message):

| Field | Type | Rule |
|---|---|---|
| `deviceId` | string | canonical lowercase UUID v4 (§1.2) |
| `publicKey` | string | 64 lowercase hex characters naming a usable X25519 point |
| `pairingId` | string | required; must equal this window's pairing id (§11.4) |
| `code` | string | the six digits from the desktop's screen; separators ignored |
| `protocolVersion` | number | must equal the desktop's |
| `schemaVersion` | number | must equal the desktop's (§8.2) |

The request carries **no** `generation` (Option A, below). A field of that name
sent by an older client is parsed and ignored, so both shapes stay
wire-compatible.

The check order matters, and every refusal has zero effect except that a wrong
code spends one of the five attempts:

1. framing, JSON shape or field types → `malformed` (400), **no attempt spent**;
2. the window has no code → `unpaired`;
3. `pairingId` missing or foreign → `pairing-mismatch`;
4. `deviceId` not canonical, or `publicKey` not a usable point → `malformed`;
5. protocol → `protocol-unsupported`; schema → `schema-mismatch`;
6. code already redeemed → `used`; past its 120 s → `expired`; five failures → `locked`;
7. `code` not six digits → `malformed` (no attempt); otherwise wrong → `wrong-code` with `attemptsLeft`;
8. `deviceId` is this desktop → `same-device`.

The phone's own idea of the data line is never checked here: it cannot be the
reason a pairing fails, or a phone whose stored generation predates a desktop
restore could never pair again.

Steps 1–5 come **before** the code is compared, so a malformed request can
neither spend an attempt nor learn whether a guessed code was right (wave 1
N5). A refusal is `{"ok": false, "reason": <code>, "message": <what to do>}`,
with `attemptsLeft` added on a code refusal.

An accepted request spends the code before the reply leaves, replaces any
earlier candidate for this window, resets the replay counter for the newly
staged peer, and answers with `{"ok": true, "reason": "paired", "envelope":
<wire>}` — an ordinary sealed envelope from the desktop to the phone under this
pairing id, whose payload is

```json
{"kind":"paired","pairingId":"…","deviceId":"<desktop>","generation":1,
 "schemaVersion":8,"protocolVersion":1}
```

Those values are authoritative. Generation **Option A**, as decision D1 settles
it: a request carries **no** generation — the desktop owns the number — and the
sealed ack delivers the authoritative `local_generation`, which the phone stores
as the data line it paired with (§10.2). A phone that still believes in an
older line therefore pairs normally and learns the new one from the ack,
instead of being refused for echoing a stale value. The staged pin records the
desktop's generation, so every later hello is checked against the line the
pairing was actually made on (§10.2). No wire change beyond that: a sender that
still includes `generation` parses and is ignored.

**Implementation status (wave 1, as built).** The offer and its QR are
implemented and tested (`src/lib/sync/qr.ts`, `pairing.ts`: render → decode →
`parseOffer`), and so is the listener (`src-tauri/src/pairing_listener.rs`):
both endpoints above, on a window that exists only while pairing is on screen
(§11.5), with read/write timeouts, no CORS grant, and validation before effect.
The envelope has both halves, proved against each other's bytes
(`envelope.rs`, `envelope.ts`, `src/lib/sync/__fixtures__/`). The long-term key
lives in the platform key store, never in the database or a backup
(`pairing_key.rs`, `key_store/`); a key that is missing over an existing
pairing fails closed, records `re_pair_required` and needs the person's
confirmed re-pair (§11.2, §11.4). Not built yet, and tracked in
`ANDROID_BUILD_TODO.md` under “Pairing & bootstrap”: the phone's sealed client,
the snapshot and operation transport built on these envelopes, and the real
two-device pairing proof (Session 7).

---

## 12. Stage boundaries

#### §12.1 Stage 1 — Notes / Tasks / Shopping / Habits

`collections`, `notes`, `tasks`, `reminders` (subject to §13.1), `shopping_lists`,
`shopping_items`, `habits`, `habit_logs`, under §2.1's authority. The first
stage that may run end-to-end, and the first the harness judges with a real
engine.

#### §12.2 Stage 2 — Budget append-only + Business/Loans create-only

`income_entries` and `expense_entries` append from the phone; `jobs` and `loans`
are created there and then owned by the desktop. **F3 consequence, recorded not
solved here:** job `paid_cents` and loan `repaid_cents` are derived counters that
reconcile as **aggregates** — idempotent payment events on the aggregate, never
independent-field LWW. Two devices that each record a repayment must end with
*both* income entries *and* a counter that reflects both, which field-LWW cannot
guarantee. Mobile never writes those counters, so Stage 2 cannot produce the
failure; the rule is written down before Stage 2 can be widened.

#### §12.3 Stage 3 — Vault one-way, generation-aware

Desktop→mobile only, ciphertext as stored. The Vault has a **password
generation** identifier; the phone holds the generation its verifier belongs to
and refuses items from another generation, because mixing an old item with a new
verifier makes data undecryptable even though every field individually "won"
(F3). A conflict archive keeps ciphertext only, never plaintext, and never mixes
generations. Vault rows are aggregate-atomic (§4.4).

#### §12.4 Each stage earns its own tests

Passing Stage 1 does not authorise broad two-way financial or Vault editing. Every
expansion needs its own invariant tests against §14's oracle, and the graduation
criterion is the harness, not a successful demo.

#### §12.5 Reminders: see §13.1

Decided (Option A) and built in Stage 1's Session 4 — see §13.1.

---

## 13. Open tensions — recorded, not silently settled

#### §13.1 Who owns a reminder definition? (`reminder-definition-owner`) *(decided — Option A, 2026-11-10)*

The design has two statements that point different ways: the sync contract says
"wallets/categories and reminder definitions desktop-owned", while decision 9
says "the creating device notifies; delivery state is device-local". Phase B
already lets the phone create reminders, and the phone's `reminder_sync` arms
alarms from the rows it reads — so if desktop-created reminders sync down, the
phone would arm them too and both devices would fire.

| Option | What it means | Cost |
|---|---|---|
| **A (recommended)** | Definitions are two-way. Both devices hold every reminder; a device arms and notifies **only** the reminders whose `created_by_device_id` is its own. | A `created_by_device_id` column on `reminders`; a delivery filter on both sides. Keeps decision 9 literally true and keeps `reminders` inside the 17-table core. |
| B | Definitions stay desktop-owned (desktop→phone read-only). A phone-created reminder never syncs; it lives and notifies on the phone only. | The phone shows desktop reminders but must not arm them — the same column or an equivalent marker is still needed. A reminder set on the phone is invisible on the desktop, which the user may not expect. |

**Decided: A (2026-11-10, MinLulin's call — "2 way လုပ်လို့ရရင် လုပ်မယ်").** Definitions are two-way: both devices hold every reminder, and a device arms and notifies only the reminders whose `created_by_device_id` is its own.

**Built 2026-11-13 (Stage 1, Session 4), so the tension is closed:**

- The predicate lives once, in `src/lib/sync/reminderDelivery.ts`: own id, or
  NULL. Both delivery surfaces call it — the desktop ticker's due-selection
  and the Android pass's rows for arming, notifying and settling. A device
  never settles a peer's reminder either: its `fired` state converges from the
  creator's own settle ops (§6.1).
- Three borders stamp a creator, so a synced reminder never lands without one:
  the engine writes the create op's **author** (the payload's claim is
  ignored), while the snapshot apply and the upload apply stamp the **sender**
  when the payload carries none. A real creator id is never overwritten.
- After that stamping a NULL can only be a row this device wrote before the
  column existed, so NULL reads as "mine". Rows adopted before this session
  shipped are pre-Stage-1 test data; a reset and re-pair is their migration.

#### §13.2 Conflict losers go to per-device local trash *(confirmed)*

Confirmed as the design states it, with the mechanics spelled out:

- **Which tables.** Notes, Tasks, Shopping — the mutable entities. Append-only
  Budget and read-only Vault produce no losers in v1. Habit check-in toggles are
  not archived (§9.5). Reminder definition edits are not archived either: the
  loser is an overwritten definition, not content.
- **Where.** The device holding the losing value copies it into its **own**
  trash, in the same transaction as the winning apply. `trash_items` never
  syncs, so the other device never learns it existed.
- **What the user sees.** The winning value on both devices, no prompt, no
  badge. On the device that lost, the trash shows the copy labelled
  "Conflict copy — kept on this device only", with the winning value beside it
  so the user can compare. On the other device, nothing.
- **Restoring a conflict copy** creates a **new** record with a new UID, which
  then syncs as a new record. It never resurrects the old UID and never
  overwrites the winner.
- **Trash retention applies unchanged** (30 days / 1,000 items): a conflict copy
  can expire like any other trashed row.
- The Trash UI's entity types need extending for shopping lists/items and
  reminders where they do not already exist — Phase C's "trash extended for
  conflict losers" work item, not this session's.

---

## 14. The test oracle and the harness

#### §14.1 The oracle statement

> **Both devices converge without losing acknowledged operations.**

Not "the newest date won", not "the library round-tripped". Every harness test
in every later Phase C session asserts this sentence, and a test that cannot
express it is testing something else.

#### §14.2 Convergence, defined

For the two peers, after quiescence:

1. the same set of `(table, uid)` live records;
2. for each, identical merged field values and identical version stamps —
   including whose stamp won;
3. the same tombstone set, minus tombstones every known peer has acknowledged
   and collected (§5.4);
4. no record outside the 17-table allowlist anywhere (§2.2).

Local row ids, cursors, trash contents and wall-clock columns are **not**
compared: they are device-local by design (§10.3), and comparing them would fail
correct syncs.

#### §14.3 No acknowledged loss, defined

Every operation acknowledged to its origin is either visible in the merged state
on both peers, or superseded by an operation with a strictly higher §4.2 stamp on
the same record/field whose lineage the harness records. An op that was
acknowledged and simply vanished is loss, however tidy the replica looks.

#### §14.4 Harness obligations — injection → clause map

The harness must be able to inject each fault below, and each maps to the clause
that decides the right answer. `src/lib/sync/harness.ts` holds the same list; a
test fails if the two disagree.

<!-- harness-obligations:start -->

| Injection | Clauses | What it proves |
|---|---|---|
| `mid-apply-kill` | §6.4, §7.4, §7.5 | a crash mid-batch loses nothing acknowledged and advances no cursor |
| `duplicate-delivery` | §6.3, §7.2 | retries are idempotent per `(device_id, seq)` |
| `clock-skew` | §4.2, §4.7 | ordering never reads a wall clock |
| `conflicting-offline-edits` | §4.2, §4.3 | both offline edits survive on independent fields; same-field conflicts order deterministically |
| `delete-vs-edit` | §5.3 | a tombstone beats a concurrent lower-stamped edit |
| `cascaded-child-delete` | §5.2 | cascaded children travel as their own tombstones |
| `revoked-peer` | §11.3 | a revoked peer is refused before any effect |
| `old-backup-restore` | §10.2, §10.5 | a generation bump forces re-pair, no stale authority |
| `desktop-only-leak` | §2.2 | an excluded table on the wire is caught, not tolerated |

<!-- harness-obligations:end -->

#### §14.5 Harness rules

- **No verdicts from stubs.** A test passes only on two real replicas compared
  by §14.2/§14.3, never on a `synced` flag, a mock counter or a stubbed
  transport that reports success. The harness carries a `claimedSynced` field
  that the oracles ignore, and a test proves it is ignored.
- **Pending, never falsely passing.** A test that cannot run until the engine
  exists is marked skipped with the reason and the clause it will enforce. It is
  never deleted, never marked passing, and never replaced by a stub that returns
  the expected answer.
- **The harness may not merge.** Deciding conflicts is the engine's job; a
  harness that merged would be testing itself. This is why the convergence tests
  are pending while the injection and oracle tests are green: the harness's
  teeth are proven, its judgement is not yet exercised against real code.

#### §14.6 Deviation is a spec change

If the engine needs to answer a question this document does not, the answer goes
in as a clause first. If the harness argues with a clause, the clause wins until
MinLulin changes it. A quiet code choice that contradicts §4, §5, §6 or §7 is a
protocol bug even when the tests happen to pass.

---

## 15. Version history and bump rules

#### §15.1 History

| Version | Date | Change |
|---|---|---|
| 1 | 2026-11-08 | First version. Supersedes `ANDROID_DESIGN.md` §5's `updated_at` + watermark scheme (F1). Written in Phase C Session 1; awaiting approval. |

#### §15.2 When to bump

- **Major** — anything that changes the meaning of the wire or the merge: new
  ordering rule, changed tombstone semantics, changed allowlist semantics,
  changed first-pair or generation rules.
- **Minor** — additive and backward-refusable: a new op kind, a new field, a new
  table in the allowlist (each of which the older side must refuse rather than
  mis-apply, §8.2).

A bump requires a new row here, a matching `PROTOCOL_VERSION` in
`src/lib/sync/protocol.ts`, and the harness's clause citations updated in the
same change.

---

## Appendix A — What Phase C Session 1 delivered

| Deliverable | Where |
|---|---|
| This specification, protocol v1 | `docs/ANDROID_SYNC_PROTOCOL.md` |
| Pure protocol rules (allowlist, authority, ordering, handshake, GC, adoption) | `src/lib/sync/protocol.ts` |
| Two-peer failure-injection harness and oracles | `src/lib/sync/harness.ts` |
| Harness self-tests (green) and Stage 1 invariant tests (pending, with reasons) | `src/lib/sync/harness.test.ts` |

Nothing in Phase C beyond this was started: no engine, no migration, no pairing
key, no network call, no emulator run.
