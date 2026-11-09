/**
 * The phone's pairing entry (Q.2), proven through the same paths the app uses.
 *
 * The camera path is proven against a QR this codebase rendered: pixels →
 * `jsqr` → `parseOffer` → the offer that went in. The camera itself is not a
 * fixture, so "built and proven on a rendered image" is the honest claim; the
 * device proof waits for a real camera.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PhonePairResult } from "../../data/driver.ts";
import {
  confirmTypedCode,
  desktopPin,
  isCompleteCode,
  offerFromFrame,
  type PairingPhoneTransport,
  pairWithDesktop,
} from "./mobilePairing.ts";
import {
  createPairingSession,
  encodeOffer,
  type PairingOffer,
  type PairingSession,
  pinFromDesktop,
} from "./pairing.ts";
import { qrMatrix, qrPixels } from "./qr.ts";
import type { PeerRow } from "./store.ts";

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
