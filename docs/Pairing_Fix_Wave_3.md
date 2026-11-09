# Pairing Foundation Fix — Wave 3 (bootstrap + envelope polish)

**Source:** PR #24, Arena audit of the pairing foundation (`docs/Arena_Findings_Pairing_Foundation.md`, findings N1–N13 + decisions D1–D5). This document is self-contained: every finding in this wave is reproduced here in full, so the agent does not need the PR branch.

**Base:** `dev` HEAD `4adb79b` (Phase C Session 6 verified green, partial). **Branch:** `dev`. No commits to `main`, no version bumps, no new dependencies without justification.

**Ordering:** Wave 3 does not gate Session 7 (the sealed client). It follows Waves 1–2. N8 and D4 touch the same code region (`batchSnapshot`) — implement them together in one session, not as two passes.

## Decisions — settled by MinLulin 2026-11-09, do not re-decide

- **D3 — re-pairing and `data_generation`:** `rePairStatements` is authoritative — a re-pair does NOT bump desktop `data_generation` (bumping would unnecessarily invalidate other paired peers; `pairing_id` already isolates the re-paired peer's session, §11.4). Remove *"and by a re-pair"* from spec §10.1 and adjust `protocol.ts:302`'s message wording.
- **D4 — aggregate batch boundary:** **Option A (the flexible one):** pre-measure each grouped aggregate before appending so `batchSnapshot` flushes at 199 and places a 3-row list cleanly into batch 2 (`3 <= 200`); a batch exceeds `200` ops / `256 KiB` *only* when a single aggregate alone is larger than a whole batch, with a matching single-aggregate rule on the receiver. (Option B — a receiver slack margin above the bound — is rejected.)

## Working rules (standing)

- Work one session at a time (~2 tasks max), then **STOP and report back**: what changed, commit sha, gate result, what is left. Do not start the next session unprompted.
- `npm run verify` must be green before any commit or push. A red gate is a blocker, not a note.
- Touch only the files listed per task (plus their tests and the listed spec lines). If a fix needs a file outside the list, STOP and ask — do not expand scope silently.
- Do not re-break anything in the audit's "Checked and Found Clean" section (slot separation, envelope AEAD + cross-language parity, framing, unbiased code + constant-time compare, `reap()` port-closure proof, §7.1 admission order). The envelope fixtures (`envelope-from-ts.json` / `envelope-from-rust.json`) must keep passing byte-for-byte — N11 is parser strictness only, never a wire-format change.

---

## Session 1 — T1: N8 (Med) + D4 — bootstrap undercounts bytes, splits aggregates, keys by `uid` alone, compares fields key-order-sensitively

### N8 — evidence

- `src/lib/sync/bootstrap.ts:101-110` (`rowBytes`): `JSON.stringify({ table, uid, stamp, fields }).length + 64`. PurpleMemo is bilingual English/Burmese (`src/lib/i18n.ts`). Every Myanmar-script code point (U+1000–U+109F) is 1 UTF-16 code unit (`.length === 1`) in JS strings, **3 bytes in UTF-8**, and **6 bytes** once hex-encoded inside `EnvelopeWire.body` (`envelope.ts:242`). A "256 KiB" batch (§3.2) can approach ~768 KiB of UTF-8 JSON (~1.5 MiB on the wire).
- `src/lib/sync/bootstrap.ts:129-151` (`batchSnapshot`): `BatchLimits.aggregateOf` (`:93-95`) promises *"two rows that answer the same non-null value here land in the same batch"*. Yet `batchSnapshot` iterates `rows` in input order and clears `currentAggregates` on `flush()`. In a snapshot read table-by-table (`shopping_lists` → 200 `notes` → `shopping_items`, or `jobs` → `income_entries`), the parent row flushes in batch 1 and its child rows land in batch 2+, splitting the aggregate across transactions in violation of §8.3 (and risking FK failures on apply).
- `src/lib/sync/bootstrap.ts:67-71` (`planBootstrap`): `desktopByUid` and `mobileUids` are keyed by `row.uid` alone. Spec §1.1 (`docs/ANDROID_SYNC_PROTOCOL.md:45`) and §14.2 (line 725: *"Keyed by `(table, uid)`"*) scope record identity per table, matching SQLite's per-table `UNIQUE(uid)` indexes (`src-tauri/src/schema.rs:941`). A cross-table UID match silently overwrites earlier tables in the `Map` and misclassifies `alreadyKnown` vs `upload`.
- `src/lib/sync/bootstrap.ts:197-200` (`conflictLosers`): `JSON.stringify(item.desktop.fields) === JSON.stringify(item.mobile.fields)` returns `false` when both devices hold identical field values constructed with different JS property insertion orders, creating unnecessary Trash conflict copies (§9.5 / §13.2).

### D4 — evidence

Spec §3.2 (`docs/ANDROID_SYNC_PROTOCOL.md:191-192`) and §8.3 (lines 446-453): *"At most 200 ops or 256 KiB per batch, whichever binds first; an aggregate is never split across batches"* and *"200 ops / 256 KiB per batch (§3.2); the sender chooses the size, **the receiver enforces the bound**"*. Pinned by `src/lib/sync/bootstrap.test.ts:154-179` (`assert.ok(holder.length <= 202, "the aggregate exception may exceed the bound by the aggregate only")`): if batch 1 has 199 unrelated notes and row 200 starts a 3-row shopping list (`list-L`, `item-L1`, `item-L2`), `batchSnapshot` puts row 200 into batch 1 (`199 < 200`) and then forces rows 201 and 202 into batch 1 (`202` ops) — which a strict 200-op receiver validator in Stage 1 will **reject**.

### Fix (implement N8 + D4 together)

1. Measure `TextEncoder().encode(JSON.stringify(...)).byteLength` in `rowBytes` (UTF-8 wire bytes, not UTF-16 code units).
2. Pre-group rows sharing a non-null `aggregateOf(row)` key before cutting batches in `batchSnapshot`, so non-adjacent rows of one aggregate land in the same batch. Pre-measure each grouped aggregate before appending (D4): flush at 199 and place the 3-row list cleanly into batch 2; a batch exceeds `200` ops / `256 KiB` *only* when a single aggregate alone is larger than a whole batch. Document the matching single-aggregate rule on the receiver in §3.2/§8.3.
3. Key `planBootstrap` maps/sets by `` `${row.table}\0${row.uid}` ``.
4. Canonicalize object key order (recursive sorted-key serialization) before comparing `fields` in `conflictLosers`.

### Tests to add/update (`bootstrap.test.ts`)

- A Burmese-heavy snapshot stays within the byte cap measured in real UTF-8 bytes.
- Non-adjacent rows of one aggregate (`shopping_lists` → many `notes` → `shopping_items`) stay in one batch.
- A cross-table UID collision is classified correctly (`alreadyKnown` vs `upload` per table).
- Identical fields with reordered keys produce no conflict loser.
- The boundary case: 199 notes + a 3-row list → the list lands whole in batch 2; update the `<= 202` assertion to `<= 200` for multi-row aggregates, and add a new single-oversize-aggregate case (one aggregate alone larger than a batch travels whole).

**Files:** `src/lib/sync/bootstrap.ts`, `docs/ANDROID_SYNC_PROTOCOL.md` (§3.2/§8.3 receiver rule only), plus tests.

---

## Session 2 — T2: N11 (Low-med) + T3: D3 (spec wording)

### T2 — N11: Rust vs TypeScript envelope wire-parsing drift

**Evidence:**
- `src-tauri/src/envelope.rs:128-131` — `from_hex` uses `text.bytes().all(|b| b.is_ascii_hexdigit())`, which accepts `A-F`; `src/lib/sync/envelope.ts:96-98` — `fromHex` uses `/^[0-9a-f]*$/`, which rejects `A-F`. `envelope.rs:65-68` documents `nonce` and `eph` as `"lowercase hex"`.
- `src/lib/sync/envelope.ts:274-278, 339` — `parseWire` checks only `typeof header.counter === "number"`. A fractional float like `counter: 0.5` passes `0.5 <= 0` (`false`) in TypeScript while failing `u64` deserialization in Rust; conversely, `u64` counters above `Number.MAX_SAFE_INTEGER` (`2^53 - 1`) silently round in JS `JSON.parse`, so `headerBytes(header)` serializes a different integer than Rust signed.
- `src-tauri/src/envelope.rs:326-334, 369` and `src/lib/sync/envelope.ts:266-287, 374` — both `open` implementations parse `input.raw` via `serde_json` / `JSON.parse` (ignoring unknown JSON fields and wire key order) and recompute AAD by re-serializing `Header`. Extra JSON properties injected into the outer wire object or `header`, whitespace changes, or reordered `header` keys are not rejected and do not invalidate the AEAD tag (though the 7 canonical `Header` fields themselves remain authenticated).

**Fix (parser strictness only — the wire format and the fixtures do not change):**
1. Restrict `envelope::from_hex` in Rust to lowercase ASCII hex `0-9a-f` (matching `envelope.ts` and the `Header` docstrings).
2. Check `Number.isSafeInteger(header.v)` and `Number.isSafeInteger(header.counter) && header.counter >= 1` in `envelope.ts`.
3. Add `#[serde(deny_unknown_fields)]` on the Rust wire/header structs, with an exact key-count check in TypeScript `parseWire`.

**Tests to add/update:** uppercase hex in `body`/`nonce`/`eph` refused by Rust `open`; fractional and `> 2^53 - 1` counters refused by TS `open`; unknown wire/header fields refused on both sides. The cross-language fixtures (`envelope-from-ts.json`, `envelope-from-rust.json`) must keep passing byte-for-byte.

**Files:** `src-tauri/src/envelope.rs`, `src/lib/sync/envelope.ts`, plus tests.

### T3 — D3: re-pairing and `data_generation` (spec wording)

**Evidence:** spec §10.1 (`docs/ANDROID_SYNC_PROTOCOL.md:514-515`) states desktop `generation` is *"bumped by **any** restore (whatever the backup's age), by a factory reset, **and by a re-pair**"*. In code, `rePairStatements` (`src/lib/sync/store.ts:333-372`) resets `cursor_in = 0`, `cursor_out = 0`, `revoked_at = NULL`, clears acks, and assigns a fresh `pairing_id` (§11.4), WITHOUT bumping `sync_state.data_generation`. Keeping `data_generation` stable on a single peer's re-pair preserves compatibility with multiple paired devices (`store.test.ts` tests `UID_PEER_A` and `UID_PEER_B` concurrently); bumping it would unnecessarily invalidate other paired peers when `pairing_id` already isolates the re-paired peer's session. Pinned by `src/lib/sync/pairing.test.ts:452-472` and `src/lib/sync/pairingPanel.test.ts:253-260`.

**Fix (decision D3, settled):** `rePairStatements` is authoritative. Remove *"and by a re-pair"* from §10.1 and adjust `protocol.ts:302`'s message wording to match. Confirm the pinned tests above stand as the authoritative behavior — no code change to `rePairStatements` itself.

**Files:** `docs/ANDROID_SYNC_PROTOCOL.md` (§10.1 only), `src/lib/sync/protocol.ts` (`:302` wording only), plus a test read-through confirming the pinned tests still assert the settled behavior.

---

## Exit criteria (whole wave)

- N8, N11 fixed with the tests listed; D3/D4 recorded in code + spec as above.
- `npm run verify` green on the wave's final commit.
- No new findings introduced; nothing in "Checked and Found Clean" regressed; the envelope cross-language fixtures still pass byte-for-byte.
- After this wave, all 13 PR #24 findings are closed and the pairing foundation is ready for the Stage 1 sync engine to be built on it.
