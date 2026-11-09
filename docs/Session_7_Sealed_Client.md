# Session 7 — the sealed client, the snapshot transport, and a real pairing proof

**Source:** `docs/Pairing_Fix_Wave_1.md` exit criteria — *"After this wave, Session 7
(sealed client + snapshot transport + real pairing proof) can be built on the
documented, confirmed-gated wire"* — and the implementation-status paragraph of
`docs/ANDROID_SYNC_PROTOCOL.md` §11.6.1. No earlier document defines Session 7;
this one does. It is a work order, not a decision record: the two items in
**Approvals** must be settled before the session that needs them starts.

**Base:** `dev` HEAD `d9ef794` (Wave 1 complete plus the Option A correction;
`npm run verify` green). **Branch:** `dev`. No commits to `main`, no version
bumps, no new dependencies without justification.

**Ordering:** do not run this alongside Wave 2 or Wave 3 — all three touch
`pairingListener.rs`, `pairingPanel.ts`, `PairingPanel.tsx` and
`MobilePairingCard.tsx`. Waves 2–3 are written orders that can run before or
after; this one is not gated by them.

## What exists, and what is missing

Exists today (verified against the tree at `d9ef794`):

- **The wire, both halves.** `src-tauri/src/pairing_listener.rs` serves
  `POST /pair/request` (plaintext, code-gated) and `POST /pair/hello` (sealed),
  with a 4-byte big-endian frame, a 64 KiB cap, 5 s connection/read/write
  budgets, no CORS header, and validation before effect. `src/lib/sync/frame.ts`
  and `envelope.ts` are the TypeScript halves, cross-tested on each other's
  bytes.
- **Trust, as a human step.** The request only *stages* a candidate; the pin is
  written by the desktop's panel on Trust, after a sealed hello proves key
  possession (Wave 1 N1). `sync_peers` writes exist in `store.ts`
  (`registerPeerStatements` is a pure `INSERT`; re-pairs go through
  `rePairStatements`).
- **The snapshot planner.** `src/lib/sync/bootstrap.ts` has `planBootstrap`,
  `batchSnapshot` (200 ops / 256 KiB, aggregates never split),
  `conflictLosers`, `adoptionSummary` and `resumeAdoption` — pure values, fully
  tested.
- **The phone's entry.** `mobilePairing.ts` decodes camera frames and typed
  codes against the same `parseOffer`/`redeemCode` the desktop uses, and
  `MobilePairingCard.tsx` renders it.

Missing, and this session's whole job:

- **No client.** There is no `src-tauri/src/pairing_client.rs`; `grep -rn
  "pair/request" src` finds only the listener. `mobilePairing.ts` says it
  outright: *"The phone's wire step … is deliberately absent."* The client
  cannot live in the webview: `PairingIdentity` is deliberately neither
  `Clone` nor `Serialize`, and the key sits behind the platform keystore.
- **No phone pin.** Nothing on the phone writes the desktop's key into
  `sync_peers`; the desktop's `pinAdmittedPeer` is the only pairing write in
  the app.
- **No transport for data.** `ACCEPTED_KINDS` is `["hello"]`; anything else is
  refused `not-allowed`. No snapshot reader exists in Rust (`grep snapshot
  src-tauri/src` finds only share/backup prose), and no `SyncedRow` ↔ SQL
  mapping exists in `store.ts`.
- **No two-device proof.** The Android TODO records that the emulator booted
  but no pairing could complete.

## Working rules (standing)

- Work one session at a time (~2 tasks max), then **STOP and report back**:
  what changed, commit sha, gate result, what is left. Do not start the next
  session unprompted.
- `npm run verify` must be green before any commit or push. A red gate is a
  blocker, not a note.
- Touch only the files listed per session (plus their tests and the listed spec
  lines). If a fix needs a file outside the list, STOP and ask.
- Do not re-break: the staging/confirmation contract (N1), the validation order
  (N5), the Option A generation rule (D1), the envelope construction and its
  fixtures, the framing bytes, or Wave 1's fail-closed key handling (N2).
- No new dependencies. The client speaks HTTP/1.1 with `std::net`, exactly as
  the listener's own tests already do (the server requires `Content-Length`,
  refuses chunked bodies and always answers `Connection: close`).

---

## Session 1 — T1: the phone's sealed client (request + hello)

**Deliverable:** `src-tauri/src/pairing_client.rs` — the phone's half of the two
documented endpoints, holding the key in Rust and never in the webview.

**What it does**

1. `POST http://<offer.endpoint>/pair/request` with a framed JSON body
   `{deviceId, publicKey, pairingId, code, protocolVersion, schemaVersion}` —
   **no `generation`** (Option A, D1). Sends `Content-Length` and
   `Connection: close`; never chunked; bounded read.
2. Opens the framed reply's `envelope` with `envelope::open` (peer =
   `offer.publicKey`, pairing id = the offer's, counter 0) and returns a typed
   `PairingAck { pairingId, desktopDeviceId, generation, schemaVersion,
   protocolVersion }` — the desktop's values, which the phone stores.
3. `POST http://<offer.endpoint>/pair/hello` with a sealed
   `{kind:"hello", deviceId, pairingId, protocolVersion, schemaVersion,
   generation}` whose `generation` is the ack's, then opens the sealed
   `{kind:"ack", accepted, generation, schemaVersion}` reply. Only after this
   step is the pairing *proven*.

**Safety rules, all testable**

- The endpoint is parsed as `host:port`: numeric port, no scheme, userinfo,
  query or path. The client dials that address and nothing else — the offer is
  its only source of an address, so a phone cannot be pointed at a third party.
- Connect, read and write timeouts plus one overall budget; a stopped listener
  is an error, never a hang.
- No redirect following; a status other than the documented ones is a typed
  refusal; a body that is not a valid frame is refused before any unwrap.
- The identity is borrowed from `pairing_key::load_or_mint` (the same
  fail-closed path `pairing_local` uses); no `Clone`, no `Debug`, no secret in
  any error text, and `PairingClientError` carries the wire's `reason` code so
  the UI shows the protocol's own words.
- Response frames stay under `MAX_FRAME_BYTES` (64 KiB).

**IPC:** one command, `pairing_phone_pair(input)`, returning
`PhonePairResult { desktopDeviceId, desktopPublicKey, desktopFingerprint,
pairingId, generation, schemaVersion, protocolVersion }`. It writes **nothing**
(the pin is Session 2's TS write). Register it in `lib.rs`; add the driver and
mock method; bump the deliberate count in `src/data/ipc.test.ts`.

**Tests (Rust, loopback):** a real `PairingListenerState` window on `127.0.0.1`
proves request → ack → hello and ends with `peer_hello_received` true and the
phone's key staged; a wrong code surfaces as `wrong-code` with `attemptsLeft`
and stages nothing; a window with no offer is `unpaired`; a reply that is not a
frame is refused; an endpoint with a path or a scheme is refused before any
socket is opened; a listener stopped mid-call is a timeout error. **TS:** the
IPC pins (`pairing-ipc.test.ts`, `ipc.test.ts`).

**Files:** `src-tauri/src/pairing_client.rs` (new), `src-tauri/src/commands.rs`,
`src-tauri/src/lib.rs`, `src/data/driver.ts`, `src/data/mock-driver.ts`,
`src/data/ipc.test.ts`, `src/data/pairing-ipc.test.ts`, plus the module's tests.

---

## Session 2 — T2: the phone writes its pin, once, after the hello

**Deliverable:** the phone stores what the ack said — and only after the hello
proved possession (N1, mirrored).

- `pairing.ts`: `pinFromDesktop(ack, offer)` builds the pin the phone holds
  (`deviceId` = ack's desktop id, `publicKey` = the offer's key — the key the
  ack was opened with — `pairingId` = the ack's, `generation` = the ack's).
  A first pairing goes through `pinStatements`; a desktop already in
  `sync_peers` goes through `rePairStatements` (§11.4: new pairing id, cursors
  zeroed, old acks dropped), decided by `readPeers` exactly as the desktop's
  panel decides it.
- `mobilePairing.ts`: `pairWithDesktop(transport, offer, code)` over a narrow
  `PairingPhoneTransport { pair(input), peers(), batch(statements) }`. A pure
  state value (`idle | contacting | awaiting-hello | paired | refused`) and the
  rule in one place: **no write happens on the ack**, because the ack is sealed
  *to* the key and proves nothing about who holds it. A refused or failed hello
  leaves `sync_peers` untouched.
- `MobilePairingCard.tsx`: the real action after a scan or a typed code, with
  both fingerprints shown before the person confirms (the same pair the
  desktop's panel shows) and no claim of success before the hello.

**Tests:** success writes exactly one `sync_peers` row naming the desktop's key
and the ack's generation; a re-pair zeroes both cursors and drops acks; a
refusal writes nothing; a hello failure after a successful request writes
nothing; the state value never reports `paired` before the hello.

**Files:** `src/lib/sync/pairing.ts`, `src/lib/sync/mobilePairing.ts`,
`src/components/MobilePairingCard.tsx`, plus tests.

---

## Session 3 — T3: the snapshot transport (approval-gated)

This session needs the first item in **Approvals**. Do not start it until it is
answered; the shape below is the proposal the approval covers.

**Proposal**

- `POST /pair/snapshot`, sealed, one message per batch:
  `{kind:"snapshot", pairingId, batch, total, ops:[{table, uid, stamp, fields}],
  tombstones:[…]}`, answered with a sealed `{kind:"applied", pairingId, batch}`;
  the last batch answers `{kind:"adopted", counts}`.
- **Batching under the existing cap.** Re-cut with
  `batchSnapshot(rows, { maxBytes: 48 * 1024 })` so every body fits today's
  64 KiB frame limit. No protocol bound changes; the cost is more round trips.
  (The alternative — raising `MAX_FRAME_BYTES` for this path — is the other
  approval question.)
- **Desktop:** read the 17 tables plus tombstones in **one transaction**
  (§8.4), seal per batch, hold the snapshot for the life of the window, and
  re-take it on a new pairing id (§11.4).
- **Phone:** validate before applying (`isSyncTable`, `writeAllowed`, schema),
  apply each batch through `applyStatements` (one transaction per batch,
  §7.4), record an `AdoptionCheckpoint`, and finish with `adoptionSummary`.
  Interruption restarts the snapshot — `resumeAdoption` already decides that.
- **Refusals, named and effectless:** `not-allowed`, `pairing-mismatch`,
  `malformed`, `needs-re-pair`, `unauthenticated`, `schema-mismatch`,
  `replayed`, plus `snapshot-busy` when a second pairing asks while one
  snapshot streams.

**Tests:** batches respect the limits and never split an aggregate; a table
outside the 17 is refused `not-allowed` with zero effects; a replayed batch is
a no-op; an interrupted batch applies nothing and the checkpoint restarts; the
desktop's read is one transaction; a snapshot under a foreign pairing id is
refused.

**Files:** `src-tauri/src/pairing_snapshot.rs` (new),
`src-tauri/src/pairing_listener.rs` (kind + route),
`src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`,
`src/lib/sync/store.ts` (`SyncedRow` → statements, and the reader helpers),
`src/lib/sync/bootstrap.ts` (limits for the frame cap),
`src/lib/sync/mobilePairing.ts`,
`docs/ANDROID_SYNC_PROTOCOL.md` (§8.4 and §11.6.1: endpoint, kinds, refusal
codes), plus tests.

---

## Session 4 — T4: the proof

Two proofs, and the difference between them is stated, not blurred:

1. **Automated, in-process, real crypto.** A test that runs the client from
   Session 1 against a real listener and the apply path from Session 3 over a
   real SQLite database built from `schema.rs`'s DDL, then asserts the harness
   oracle (`src/lib/sync/harness.ts`) converges on the two stores and that
   `adoptionSummary`'s counts match the rows both sides hold. This is the
   regression proof and it runs in `npm run verify`.
2. **Manual, two devices.** Build the Android APK, pair against the desktop
   listener on `emulator-5554` (`purple_memo_test`), and record the row counts
   and the adoption summary in `ANDROID_BUILD_TODO.md`'s “Pairing & bootstrap”
   item, with the date. This needs an emulator or a real device and is **not**
   part of `npm run verify`; if it was not run, say so and do not claim it.

Then update the spec's implementation-status paragraph to match what is
actually true after the run.

**Files:** `src-tauri/src/pairing_client.rs` (tests),
`src/lib/sync/bootstrap.test.ts`, `src/lib/sync/mobilePairing.test.ts`,
`docs/ANDROID_BUILD_TODO.md`, `docs/ANDROID_SYNC_PROTOCOL.md` (status paragraph
only).

---

## Approvals and open decisions

1. **New wire surface (Session 3).** `/pair/snapshot` with kinds `snapshot`,
   `applied`, `adopted` is new protocol, and the frame-cap choice is a bound
   change if the 48 KiB re-cut is rejected. Wave 1 recorded the rule: new wire
   surface needs MinLulin's approval. Until it is given, Sessions 1–2 are the
   whole of Session 7 that may be implemented.
2. **Snapshot read path.** The proposal reads in Rust (`pairing_snapshot.rs`)
   because §8.4 requires one transaction; the alternative is a TS reader over
   `db_query`, which cannot hold a transaction across the read. State the
   choice in the report when Session 3 starts.
3. **Snapshot row stamps (blocks Session 3).** The current schema has no stamp
   to put on a snapshot row. See **Status** below: this one cannot be worked
   around in code, because it decides which value survives a shared UID at
   first pairing (§9.2, §9.5).

Settled and not to be re-decided here: N1 (no pin without a proved hello and a
human Trust), N2 (a missing key fails closed), D1 Option A (the request carries
no generation), D5 (`needs-re-pair` is canonical), the envelope construction,
and the one-write-path rule for `sync_peers`.

## Status (2026-11-09)

**Session 1 — done** (`1581b3a`): `pairing_client.rs`, the request → ack → hello
handshake, the loopback proof, one IPC command.

**Session 2 — done** (`f063c21`, corrected in `44a45a6`): the phone's pin write,
written only after the hello, through the desktop's pin/re-pair path, wired
through `MobilePairingCard` and checked in a browser.

**Session 3 — blocked, before a line of it was written.**

#### The snapshot cannot be stamped from this schema

§8.4 requires the snapshot to be a consistent read of the 17 tables plus their
tombstones, and `src/lib/sync/bootstrap.ts` states the row it must produce:

```ts
export interface SyncedRow {
  table: SyncTable;
  uid: string;
  stamp: VersionStamp;   // { counter, deviceId, opId }
  fields: Record<string, unknown>;
}
```

`conflictLosers` compares those stamps (§9.5), so a snapshot without a real
stamp cannot participate in §4's merge at all. But the schema has nowhere to
read one from:

- the 17 entity tables carry `uid` and ordinary timestamps, no stamp — see
the DDL for `notes`, `tasks`, `habit_logs` and `shopping_items` in
`src-tauri/src/schema.rs`;
- the only stamp storage is `sync_outbox` (`counter`, `device_id`, `op_id`,
`field_stamps`) and `sync_tombstones` (one `counter`/`device_id`/`op_id`);
- `sync_outbox` is pruned once every live peer has acknowledged it (§6.5), so it
cannot act as a durable per-row stamp store: a row the desktop wrote and
delivered last month would arrive in a snapshot with no stamp at all.

So the question Session 3 opens with is not a wire question but a data one:
**where does a snapshot row's stamp come from?**

#### The options

- **A (recommended).** Add a side table, e.g.
  `sync_row_stamps(entity_table, entity_uid, counter, device_id, op_id,
  field_stamps)`, written with every mutation and backfilled once at adoption
  time from the desktop's current Lamport counter and device id. Costs a schema
  v9 migration and a change in every writer; in exchange §4.3's per-field merge
  works over a snapshot, and the consequence is stated plainly: at adoption the
  desktop's stored value outranks phone edits stamped below it, which is what
  §2.3's "the desktop is the authority" already implies.
- **B.** The snapshot carries a synthetic pre-history stamp (`counter: 0`), and
the phone treats it as older than any local write. Costs no migration; makes
every phone edit win a shared-UID adoption merge, and gives §4.3 no per-field
input at all.
- **C.** No stamps in the snapshot; adoption inserts desktop-only rows and
leaves shared UIDs to the merge engine without per-row stamps. Smallest change,
but §9.5's conflict-copy path cannot be evaluated during adoption and it
contradicts the `SyncedRow` type the adoption module is written against.

This one is the owner's call, not the implementer's: it decides which device's
value survives when both hold the same `uid` at first pairing. Everything else
in Session 3 — the `/pair/snapshot` route, the sealed batches, the refusal list,
the busy guard — is ready to write the moment the row shape is fixed, and the
48 KiB re-cut in the proposal keeps today's 64 KiB frame cap untouched.

## Out of scope

The ordinary operation/outbox sync loop, conflict merging on the wire, Stage 1
engines, Vault, revocation UI and share. Session 7 ends when adoption does: a
phone pairs, proves possession, pins the desktop, adopts the snapshot and
uploads its own new records.

## Exit criteria

- `POST /pair/request` → sealed ack → sealed hello, proven by a test and by a
  real two-device run, ending with `peer_hello_received` true.
- The phone holds exactly one `sync_peers` row naming the desktop's key and the
  ack's generation, written only after the hello; a re-pair goes through
  `rePairStatements`.
- The snapshot applies batch-by-batch in transactions, resumes by restarting,
  and never splits an aggregate; every refusal names its reason with zero
  effect.
- `npm run verify` green on the final commit; no new dependencies; the
  two-device run recorded or explicitly reported as not run.
