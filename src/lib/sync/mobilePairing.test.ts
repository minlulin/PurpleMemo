/**
 * The phone's pairing entry (Q.2), proven through the same paths the app uses.
 *
 * The camera path is proven against a QR this codebase rendered: pixels →
 * `jsqr` → `parseOffer` → the offer that went in. The camera itself is not a
 * fixture, so "built and proven on a rendered image" is the honest claim; the
 * device proof waits for a real camera.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type {
  PhonePairResult,
  SnapshotBatchResult,
} from "../../data/driver.ts";
import { resumeAdoption } from "./bootstrap.ts";
import { generateKeyPair, open, seal } from "./envelope.ts";
import {
  confirmTypedCode,
  desktopPin,
  isBareCode,
  isCompleteCode,
  offerFromFrame,
  type PairingPhoneTransport,
  pairWithDesktop,
  pullSnapshot,
  readSnapshotBatch,
  SNAPSHOT_PULL_MISSING,
  type SnapshotPullTransport,
  scannedSession,
  snapshotSummary,
} from "./mobilePairing.ts";
import {
  createPairingSession,
  encodeOffer,
  PAIRING_CODE_LIFETIME_MS,
  type PairingOffer,
  type PairingSession,
  parseOffer,
  pinFromDesktop,
} from "./pairing.ts";
import { qrMatrix, qrPixels } from "./qr.ts";
import type { PeerRow } from "./store.ts";
import { type SnapshotOp, snapshotStatements } from "./store.ts";

const DESKTOP_KEY =
  "7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13";

function fixedCode(code: string): () => Uint8Array {
  const digits = Number(code);
  return () =>
    new Uint8Array([
      (digits >>> 24) & 0xff,
      (digits >>> 16) & 0xff,
      (digits >>> 8) & 0xff,
      digits & 0xff,
    ]);
}

function offer(code = "123456") {
  return createPairingSession({
    deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    endpoint: "192.168.1.20:47820",
    publicKey: DESKTOP_KEY,
    generation: 1,
    schemaVersion: 8,
    now: Date.now(),
    random: fixedCode(code),
  }).offer;
}

test("a rendered QR decodes back to the same offer through the phone's path", () => {
  const source = offer();
  const pixels = qrPixels(qrMatrix(encodeOffer(source)));
  const scanned = offerFromFrame(pixels);
  assert.ok(scanned.ok);
  assert.deepEqual(scanned.offer, source);
});

test("a frame with no code is a named refusal, not a partial pairing", () => {
  const blank = {
    data: new Uint8ClampedArray(64 * 64 * 4).fill(255),
    width: 64,
    height: 64,
  };
  const scanned = offerFromFrame(blank);
  assert.equal(scanned.ok, false);
  if (!scanned.ok) assert.match(scanned.reason, /no pairing code/);
});

// ---------------------------------------------------------------------------
// N6: the phone entry is honest about refusals, works without a camera, and
// judges expiry on its own clock.
// ---------------------------------------------------------------------------

test("an empty frame and a refused QR are different answers", () => {
  const blank = {
    data: new Uint8ClampedArray(64 * 64 * 4).fill(255),
    width: 64,
    height: 64,
  };
  const empty = offerFromFrame(blank);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.kind, "empty-frame");

  // A readable QR this build refuses must stop the scan, not loop forever.
  const wrongVersion = qrPixels(
    qrMatrix(encodeOffer({ ...offer(), version: 2 })),
  );
  const refused = offerFromFrame(wrongVersion);
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.kind, "invalid-qr");
    assert.match(refused.reason, /format v2/);
  }
});

test("the six digits alone are named, not called a foreign code", () => {
  // A camera-less phone has one field. Handing it the digits it can read off
  // the desktop must not answer "not a Purple Memo pairing code": the digits
  // are ours, they just name a window and not a desktop (§11.1).
  assert.equal(isBareCode("144866"), true);
  assert.equal(isBareCode("14 48 66"), true, "a spaced code is still ours");
  assert.equal(isBareCode("123 - 456"), true, "so is a dashed one");
  assert.equal(isBareCode("14486"), false, "five digits are not a code");
  assert.equal(
    isBareCode("purplememo-pair://v1?code=144866"),
    false,
    "the whole offer is not a bare code",
  );
});

test("a pasted offer pairs without a camera", () => {
  const source = offer();
  const pasted = parseOffer(encodeOffer(source));
  assert.ok(pasted.ok, "the desktop's own string is what a person pastes");
  const session = scannedSession(pasted.offer);
  assert.equal(session.usedAt, null);
  assert.ok(
    confirmTypedCode(session, "12 34 56", session.offer.createdAt + 1_000)
      .verdict.ok,
    "the typed code works with an offer that never touched a camera",
  );
});

test("a phone whose clock is minutes fast still accepts a fresh scan", () => {
  const source = offer();
  // The phone is five minutes ahead of the desktop at the moment it scans.
  const scannedAt = source.createdAt + 5 * 60_000;
  const session = scannedSession(source, scannedAt);
  assert.equal(
    session.offer.expiresAt - session.offer.createdAt,
    PAIRING_CODE_LIFETIME_MS,
    "the code keeps its lifetime, measured from the scan",
  );
  assert.ok(
    confirmTypedCode(session, source.code, scannedAt + 1_000).verdict.ok,
    "a phone clock ahead of the desktop's no longer rejects a fresh code",
  );
});

test("the card fits a spaced code and releases a late camera", () => {
  const card = readFileSync(
    new URL("../../components/MobilePairingCard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(card, /maxLength=\{12\}/, "a spaced code is not truncated");
  assert.match(
    card,
    /if \(!mountedRef\.current \|\| document\.visibilityState === "hidden"\)/,
    "a camera that arrives after unmount or a hidden screen is stopped",
  );
  assert.match(card, /getTracks\(\)\) track\.stop\(\)/);
  assert.match(
    card,
    /mobile\.settings\.pairPasteAction/,
    "manual entry is wired",
  );
});

test("the typed code uses redeemCode's own attempts and refusals", () => {
  const source = offer();
  const session: PairingSession = {
    offer: source,
    failedAttempts: [],
    usedAt: null,
  };

  const malformed = confirmTypedCode(session, "12ab", source.createdAt + 1_000);
  assert.equal(malformed.verdict.refusal, "malformed");
  assert.equal(
    malformed.session.failedAttempts.length,
    0,
    "a typo costs no attempt",
  );

  const wrong = confirmTypedCode(
    malformed.session,
    "654321",
    source.createdAt + 2_000,
  );
  assert.equal(wrong.verdict.refusal, "wrong-code");
  assert.equal(wrong.verdict.attemptsLeft, 4);

  const right = confirmTypedCode(
    wrong.session,
    "123456",
    source.createdAt + 3_000,
  );
  assert.ok(right.verdict.ok);

  const again = confirmTypedCode(
    right.session,
    "123456",
    source.createdAt + 4_000,
  );
  assert.equal(again.verdict.refusal, "used");

  const late = confirmTypedCode(session, "123456", source.expiresAt);
  assert.equal(late.verdict.refusal, "expired");
});

test("the desktop pin is the key the QR carried, not a new one", () => {
  const source = offer();
  assert.deepEqual(desktopPin(source), {
    deviceId: source.deviceId,
    publicKey: DESKTOP_KEY,
    generation: 1,
    pairingId: source.pairingId,
  });
  assert.equal(isCompleteCode("12 34 56"), true);
  assert.equal(isCompleteCode("12345"), false);
});

// ---------------------------------------------------------------------------
// The wire step (Session 7 T2): redeem, then the sealed handshake, then the
// pin — in exactly that order, and nothing at all when any step refuses.
// ---------------------------------------------------------------------------

const DESKTOP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = 1_760_000_000_000;

function scenario(): { session: PairingSession; offer: PairingOffer } {
  const source = offer();
  return {
    session: { offer: source, failedAttempts: [], usedAt: null },
    offer: source,
  };
}

/** The facts the Rust command returns once the desktop opened our hello. */
function desktopOf(
  source: PairingOffer,
  overrides: Partial<PhonePairResult> = {},
): PhonePairResult {
  return {
    desktopDeviceId: DESKTOP_ID,
    desktopPublicKey: source.publicKey,
    desktopFingerprint: "7B4E 909B BE7F FE44 C465 A220",
    pairingId: source.pairingId,
    // Deliberately not the offer's generation: the pin must take the ack's.
    generation: 7,
    schemaVersion: source.schemaVersion,
    protocolVersion: source.protocolVersion,
    ...overrides,
  };
}

function peerRow(): PeerRow {
  return {
    device_id: DESKTOP_ID,
    pairing_id: "old-pairing",
    display_name: "Desk",
    public_key: DESKTOP_KEY,
    generation: 1,
    cursor_in: 12,
    cursor_out: 7,
    revoked_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function transportOf(options: {
  desktop?: PhonePairResult;
  peers?: PeerRow[];
  calls?: string[];
  fail?: string;
  failPin?: string;
}): PairingPhoneTransport {
  const calls = options.calls ?? [];
  return {
    async pair(input) {
      calls.push(`pair:${input.code}`);
      if (options.fail !== undefined) throw new Error(options.fail);
      if (options.desktop === undefined) {
        throw new Error("the test described no desktop");
      }
      return options.desktop;
    },
    async peers() {
      calls.push("peers");
      return options.peers ?? [];
    },
    async batch(statements) {
      calls.push(`batch:${statements.length}`);
      if (options.failPin !== undefined) throw new Error(options.failPin);
    },
  };
}

test("a pairing pins the desktop only after the hello, with the ack's generation", async () => {
  const { session: start, offer: source } = scenario();
  const calls: string[] = [];
  const outcome = await pairWithDesktop(
    transportOf({ calls, desktop: desktopOf(source) }),
    start,
    "123456",
    NOW,
  );
  assert.equal(outcome.paired, true);
  assert.equal(outcome.refusal, null);
  assert.deepEqual(
    calls,
    ["pair:123456", "peers", "batch:1"],
    "the sealed handshake resolves before anything is written (N1)",
  );
  assert.equal(outcome.statements.length, 1);
  const [pin] = outcome.statements;
  assert.ok(pin, "exactly one pin statement");
  assert.match(pin.sql, /INSERT INTO sync_peers/);
  assert.deepEqual((pin.params ?? []).slice(0, 5), [
    DESKTOP_ID,
    source.pairingId,
    "",
    DESKTOP_KEY,
    7,
  ]);
  assert.equal(outcome.session.usedAt, NOW, "the code is spent by the pairing");
});

test("a desktop already pinned is re-paired, keeping its name and zeroing cursors", async () => {
  const { session: start, offer: source } = scenario();
  const outcome = await pairWithDesktop(
    transportOf({ desktop: desktopOf(source), peers: [peerRow()] }),
    start,
    "123456",
    NOW,
  );
  assert.equal(outcome.paired, true);
  assert.equal(outcome.statements.length, 4);
  const [repin, ...rest] = outcome.statements;
  assert.ok(repin, "the re-pair starts with the UPDATE");
  assert.match(repin.sql, /UPDATE sync_peers/);
  assert.match(
    repin.sql,
    /cursor_in = 0, cursor_out = 0/,
    "§11.4: the new pairing starts at sequence 0 on both sides",
  );
  assert.deepEqual((repin.params ?? []).slice(0, 4), [
    source.pairingId,
    "Desk",
    DESKTOP_KEY,
    7,
  ]);
  assert.match(rest[0]?.sql ?? "", /DELETE FROM sync_outbox_delivery/);
});

test("a wrong code never reaches the wire and writes nothing", async () => {
  const { session: start } = scenario();
  const calls: string[] = [];
  const outcome = await pairWithDesktop(
    transportOf({ calls }),
    start,
    "000000",
    NOW,
  );
  assert.equal(outcome.paired, false);
  assert.equal(outcome.verdict.refusal, "wrong-code");
  assert.equal(outcome.verdict.attemptsLeft, 4);
  assert.deepEqual(
    calls,
    [],
    "no socket is opened for a code that is wrong here",
  );
  assert.deepEqual(outcome.statements, []);
});

test("a desktop's refusal keeps its own code and message, and writes nothing", async () => {
  const { session: start } = scenario();
  const calls: string[] = [];
  const outcome = await pairWithDesktop(
    transportOf({
      calls,
      fail: "unauthenticated: that envelope failed authentication.",
    }),
    start,
    "123456",
    NOW,
  );
  assert.equal(outcome.paired, false);
  assert.deepEqual(outcome.refusal, {
    code: "unauthenticated",
    message: "that envelope failed authentication.",
  });
  assert.deepEqual(
    calls,
    ["pair:123456"],
    "nothing is read or written after a refusal",
  );
  assert.deepEqual(outcome.statements, []);
});

test("a used code is refused before the wire runs again", async () => {
  const { session: start, offer: source } = scenario();
  const first = await pairWithDesktop(
    transportOf({ desktop: desktopOf(source) }),
    start,
    "123456",
    NOW,
  );
  const calls: string[] = [];
  const second = await pairWithDesktop(
    transportOf({ calls }),
    first.session,
    "123456",
    NOW + 1_000,
  );
  assert.equal(second.verdict.refusal, "used");
  assert.deepEqual(calls, []);
  assert.deepEqual(second.statements, []);
});

test("a pin that cannot be stored is a refusal, never a claim of pairing", async () => {
  const { session: start, offer: source } = scenario();
  const outcome = await pairWithDesktop(
    transportOf({
      desktop: desktopOf(source),
      failPin: "UNIQUE constraint failed: sync_peers.device_id",
    }),
    start,
    "123456",
    NOW,
  );
  assert.equal(outcome.paired, false);
  assert.equal(outcome.refusal?.code, "pin-failed");
  assert.match(outcome.refusal?.message ?? "", /UNIQUE constraint failed/);
});

test("an acknowledgement from another pairing is never pinned", () => {
  const { offer: source } = scenario();
  assert.throws(
    () => pinFromDesktop({ ...desktopOf(source), pairingId: "pair-2" }, source),
    /different pairing/,
  );
});

// ---------------------------------------------------------------------------
// §8.4's pull (Session 7.3, Task 2). The transport below seals and opens REAL
// envelopes with real keypairs, so these tests exercise the wire format the
// Rust half speaks — never a plaintext stub that could hide a framing bug.
// ---------------------------------------------------------------------------

const PHONE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PINNED_DESKTOP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PULL_PAIRING = "pair-1";

function pullUid(index: number): string {
  return `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`;
}

function snapshotRow(
  index: number,
  extras: Record<string, unknown> = {},
  table = "notes",
): Record<string, unknown> {
  return {
    table,
    uid: pullUid(index),
    stamp: {
      counter: index + 1,
      deviceId: PINNED_DESKTOP,
      opId: `op-${index}`,
    },
    fields: {
      title: `pull note ${index}`,
      content: "",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      ...extras,
    },
  };
}

/**
 * A desktop that answers in sealed envelopes, and a phone that opens them the
 * way the app does. `calls` is the order the pull used, which is the point of
 * several tests below.
 */
function sealedPull(
  batches: Record<string, unknown>[][],
  options: { failAdopted?: string } = {},
): { transport: SnapshotPullTransport; calls: string[] } {
  const desktop = generateKeyPair();
  const phone = generateKeyPair();
  const calls: string[] = [];
  let sent = 0;
  let accepted = 0;
  const documents = batches.map((ops, index) => ({
    kind: "snapshot",
    pairingId: PULL_PAIRING,
    batch: index,
    total: batches.length,
    ops,
    tombstones: [],
  }));
  return {
    calls,
    transport: {
      async request(_input, batch) {
        calls.push(`request:${batch}`);
        sent += 1;
        const wire = seal({
          secretKey: desktop.secretKey,
          peerPublicKey: phone.publicKey,
          from: PINNED_DESKTOP,
          to: PHONE_ID,
          messageId: `snapshot:${batch}:${sent}`,
          counter: sent,
          message: documents[batch],
          pairingId: PULL_PAIRING,
        });
        const opened = open({
          secretKey: phone.secretKey,
          peerPublicKey: desktop.publicKey,
          localDeviceId: PHONE_ID,
          expectedFrom: PINNED_DESKTOP,
          lastCounter: accepted,
          pairingId: PULL_PAIRING,
          raw: wire,
        });
        assert.ok(opened.ok, "the batch must open as a real envelope");
        accepted = opened.opened.header.counter;
        const document = opened.opened.message as SnapshotBatchResult;
        return {
          pairingId: document.pairingId,
          batch: document.batch,
          total: document.total,
          ops: document.ops,
          tombstones: document.tombstones,
        };
      },
      async applied(_input, batch) {
        calls.push(`applied:${batch}`);
      },
      async adopted(_input, rows, tombstones) {
        calls.push(`adopted:${rows}:${tombstones}`);
        if (options.failAdopted !== undefined)
          throw new Error(options.failAdopted);
      },
      async batch(statements) {
        calls.push(`batch:${statements.length}`);
      },
      async peers() {
        return [];
      },
    },
  };
}

const PULL_INPUT = {
  endpoint: "192.168.1.20:47820",
  desktopDeviceId: PINNED_DESKTOP,
};

test("a pull stages every batch, applies them in ONE transaction, then adopts", async () => {
  const { transport, calls } = sealedPull([
    [snapshotRow(1), snapshotRow(2)],
    [snapshotRow(3)],
    [snapshotRow(4)],
  ]);
  const progress: string[] = [];
  const outcome = await pullSnapshot(transport, PULL_INPUT, {
    pairingId: PULL_PAIRING,
    onProgress: (next) => progress.push(`${next.batch}/${next.total}`),
  });

  assert.equal(outcome.applied, true);
  assert.equal(outcome.batches, 3);
  assert.equal(outcome.rows, 4);
  assert.equal(outcome.tombstones, 0);
  assert.equal(outcome.refusal, null);
  assert.deepEqual(progress, ["1/3", "2/3", "3/3"]);
  // §8.4: three requests, three acks, ONE write, then the adoption.
  assert.deepEqual(
    calls.map((call) => call.split(":")[0]),
    [
      "request",
      "applied",
      "request",
      "applied",
      "request",
      "applied",
      "batch",
      "adopted",
    ],
  );
  assert.equal(
    calls.filter((call) => call.startsWith("batch:")).length,
    1,
    "the whole snapshot is one transaction",
  );
  assert.ok(calls.includes("adopted:4:0"), "the adoption carries the counts");
  assert.deepEqual(resumeAdoption(outcome.checkpoint, PULL_PAIRING), {
    action: "complete",
  });
});

test("an interrupted pull applies nothing and is re-taken from the start", async () => {
  const { transport, calls } = sealedPull([
    [snapshotRow(1)],
    // An excluded table in the SECOND batch: §2.2 says it may never arrive.
    [{ ...snapshotRow(2), table: "settings" }],
  ]);
  const outcome = await pullSnapshot(transport, PULL_INPUT, {
    pairingId: PULL_PAIRING,
  });

  assert.equal(outcome.applied, false);
  assert.equal(outcome.rows, 0);
  assert.equal(outcome.refusal?.code, "malformed");
  assert.match(outcome.refusal?.message ?? "", /allowlist/);
  assert.deepEqual(outcome.summary, []);
  assert.ok(
    !calls.some((call) => call.startsWith("batch:")),
    "nothing was written, so there is nothing to undo",
  );
  assert.ok(!calls.some((call) => call.startsWith("adopted:")));
  // The checkpoint says 0 applied of 2, which is the restart verdict, not a
  // resume from batch 1.
  assert.deepEqual(outcome.checkpoint, {
    pairingId: PULL_PAIRING,
    appliedBatches: 0,
    totalBatches: 2,
  });
  assert.deepEqual(resumeAdoption(outcome.checkpoint, PULL_PAIRING), {
    action: "restart",
    reason:
      "an interrupted snapshot applies nothing, so it is re-taken (§8.4).",
  });
});

test("a batch naming an unusable uid, stamp or pairing is refused", async () => {
  const broken: Record<string, unknown>[] = [
    { ...snapshotRow(1), uid: "not-a-uid" },
    { ...snapshotRow(2), stamp: { counter: 1 } },
    { ...snapshotRow(3), pairingId: "pair-2" },
  ];
  for (const entry of broken) {
    const read = readSnapshotBatch(
      {
        kind: "snapshot",
        pairingId: entry.pairingId ?? PULL_PAIRING,
        batch: 0,
        total: 1,
        ops: [entry],
        tombstones: [],
      },
      { batch: 0, pairingId: PULL_PAIRING },
    );
    assert.equal(read.ok, false, JSON.stringify(entry).slice(0, 80));
  }
});

test("a batch over the sealed frame budget is refused before anything is staged", async () => {
  const read = readSnapshotBatch(
    {
      kind: "snapshot",
      pairingId: PULL_PAIRING,
      batch: 0,
      total: 1,
      ops: [snapshotRow(1, { content: "x".repeat(32 * 1024) })],
      tombstones: [],
    },
    { batch: 0, pairingId: PULL_PAIRING },
  );
  assert.equal(read.ok, false);
  if (!read.ok) assert.match(read.refusal.message, /30|bytes/);
});

/**
 * §8.3's budget is UTF-8 BYTES, and `.length` is not: "\u{1019}\u{103c}" is 8
 * characters and 24 bytes. This batch is 20,000 characters — under the 30,720
 * the budget names — and 60,000 bytes, which is the real cost. A budget measured
 * with `.length` would accept it and seal a frame the desktop never sent.
 */
test("the byte budget counts UTF-8 bytes, not UTF-16 characters", () => {
  const burmese =
    "\u{1019}\u{103c}\u{1014}\u{103a}\u{1019}\u{102c}\u{1005}\u{102c}".repeat(
      2500,
    );
  assert.equal(burmese.length, 20_000);
  assert.equal(new TextEncoder().encode(burmese).length, 60_000);
  const read = readSnapshotBatch(
    {
      kind: "snapshot",
      pairingId: PULL_PAIRING,
      batch: 0,
      total: 1,
      ops: [snapshotRow(1, { content: burmese })],
      tombstones: [],
    },
    { batch: 0, pairingId: PULL_PAIRING },
  );
  assert.equal(
    read.ok,
    false,
    "under the budget in characters, over it in bytes",
  );
});

test("a child row lands after its parent, resolved by uid in the same batch", () => {
  const parent: SnapshotOp = {
    table: "collections",
    uid: pullUid(9),
    stamp: { counter: 1, deviceId: PINNED_DESKTOP, opId: "op-9" },
    fields: { name: "Pull cash", created_at: "2026-01-01T00:00:00.000Z" },
  };
  const child: SnapshotOp = {
    table: "notes",
    uid: pullUid(10),
    stamp: { counter: 2, deviceId: PINNED_DESKTOP, opId: "op-10" },
    fields: {
      title: "child note",
      content: "",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      collection_uid: pullUid(9),
    },
  };
  // Given child-first, the statements must still be parents-first.
  const statements = snapshotStatements([child, parent]);
  assert.match(statements[0]?.sql ?? "", /INSERT INTO "collections"/);
  const noteStatement = statements.find((statement) =>
    statement.sql.includes('INSERT INTO "notes"'),
  );
  assert.ok(noteStatement, "the note is written");
  assert.match(
    noteStatement.sql,
    /\(SELECT id FROM "collections" WHERE uid = \?\)/,
    "the parent is resolved by uid inside the transaction",
  );
  assert.match(noteStatement.sql, /collection_id/);
  assert.equal(
    noteStatement.params?.[noteStatement.params.length - 1],
    pullUid(9),
    "the subselect is given the parent's uid",
  );
});

test("a replayed tombstone is written forward only", () => {
  const statements = snapshotStatements(
    [],
    [
      {
        table: "notes",
        uid: pullUid(4),
        stamp: { counter: 7, deviceId: PINNED_DESKTOP, opId: "op-4" },
      },
    ],
  );
  assert.equal(
    statements.length,
    2,
    "the tombstone is recorded and the row it outranks is deleted",
  );
  assert.match(
    statements[0]?.sql ?? "",
    /WHERE excluded\.counter > sync_tombstones\.counter/,
    "an older delete can never replace a newer one",
  );
  assert.match(
    statements[0]?.sql ?? "",
    /LEFT JOIN sync_row_stamps/,
    "and a delete the live row outranks is not recorded at all",
  );
  assert.match(
    statements[1]?.sql ?? "",
    /DELETE FROM "notes" WHERE uid = \?/,
    "§5: the row itself is deleted, not merely marked",
  );
});

test("the summary names the pull and what is still missing", () => {
  const summary = snapshotSummary(4, 1);
  assert.match(summary[0] ?? "", /4 record\(s\) arrived/);
  assert.match(summary[1] ?? "", /1 deletion\(s\)/);
  assert.match(summary[2] ?? "", /Nothing was deleted/);
  assert.equal(summary[3], SNAPSHOT_PULL_MISSING);
  assert.match(SNAPSHOT_PULL_MISSING, /not sent to the desktop yet/);
});

test("a committed snapshot whose adoption reply fails is still reported as applied", async () => {
  const { transport } = sealedPull([[snapshotRow(1)]], {
    failAdopted: "replayed: this snapshot was already adopted.",
  });
  const outcome = await pullSnapshot(transport, PULL_INPUT, {
    pairingId: PULL_PAIRING,
  });
  assert.equal(outcome.applied, true, "the rows ARE committed");
  assert.equal(outcome.rows, 1);
  assert.equal(outcome.refusal?.code, "replayed");
  assert.ok(outcome.summary.length > 0);
});
