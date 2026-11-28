import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  BatchStatement,
  PairingListenerInfo,
  PairingOpenInput,
} from "../../data/driver.ts";
import {
  type DurablePairingTransport,
  durablePin,
  ensurePairedPhoneReachable,
} from "./durablePairing.ts";
import { FLOOR_ROWS_DELETE_SQL, forgetPairingStatements } from "./forget.ts";
import type { PeerRow } from "./store.ts";

const PHONE = "phone-1";
const PAIRING_ID = "pairing-1";

function pin(overrides: Partial<PeerRow> = {}): PeerRow {
  return {
    device_id: PHONE,
    pairing_id: PAIRING_ID,
    display_name: "Phone",
    public_key: "phone-key",
    generation: 1,
    cursor_in: 0,
    cursor_out: 0,
    revoked_at: null,
    created_at: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

const RUNNING: PairingListenerInfo = {
  running: true,
  port: 48720,
  endpoint: "192.168.1.2:48720",
  publicKey: "desktop-key",
  fingerprint: "fp",
  peerDeviceId: PHONE,
  peerPublicKey: "phone-key",
  peerFingerprint: "peer-fp",
  peerHelloReceived: false,
  offerAttempts: 0,
  offerRedeemed: false,
  uploadState: null,
  uploadOps: 0,
  uploadInserted: null,
  uploadAlreadyKnown: null,
  uploadNote: null,
  syncState: null,
  syncOps: 0,
  syncApplied: null,
  syncNote: null,
  note: null,
};

/** Nothing bound: the state every caller but the panel is in. */
const STOPPED: PairingListenerInfo = {
  ...RUNNING,
  running: false,
  port: null,
  endpoint: null,
};

interface Fake extends DurablePairingTransport {
  opened: PairingOpenInput[];
  batches: BatchStatement[][];
}

function fakeTransport(
  pins: PeerRow[],
  listener: PairingListenerInfo = RUNNING,
  current: PairingListenerInfo = STOPPED,
): Fake {
  const fake: Fake = {
    opened: [],
    batches: [],
    async pairingOpen(input: PairingOpenInput) {
      fake.opened.push(input);
      return listener;
    },
    async pairingStatus() {
      return current;
    },
    async peers() {
      return pins;
    },
    async batch(statements: BatchStatement[]) {
      fake.batches.push(statements);
    },
  };
  return fake;
}

test("durablePin serves the oldest usable pin and skips revoked or keyless rows", () => {
  const older = pin({
    device_id: "older",
    created_at: "2026-10-01T00:00:00.000Z",
  });
  const newer = pin({
    device_id: "newer",
    created_at: "2026-11-01T00:00:00.000Z",
  });
  assert.equal(durablePin([newer, older])?.device_id, "older");
  assert.equal(
    durablePin([pin({ revoked_at: "2026-11-02T00:00:00.000Z" })]),
    null,
  );
  assert.equal(durablePin([pin({ public_key: null })]), null);
  assert.equal(durablePin([]), null);
});

test("the durable window opens offer-less under the pinned pairing id", async () => {
  const fake = fakeTransport([pin()]);
  const outcome = await ensurePairedPhoneReachable(fake, true, false);
  assert.equal(outcome, "opened");
  assert.equal(fake.opened.length, 1);
  const input = fake.opened[0] as PairingOpenInput;
  assert.equal(input.pairingId, PAIRING_ID);
  assert.equal(input.offerCode, null);
  assert.equal(input.offerExpiresAt, null);
  assert.equal(input.lastCounter, 0);
  assert.equal(input.peer?.deviceId, PHONE);
  assert.equal(fake.batches.length, 0);
});

test("toggle off, phone role, and no usable pin never open a window", async () => {
  const off = fakeTransport([pin()]);
  assert.equal(await ensurePairedPhoneReachable(off, false, false), "off");
  assert.equal(off.opened.length, 0);

  const mobile = fakeTransport([pin()]);
  assert.equal(await ensurePairedPhoneReachable(mobile, true, true), "mobile");
  assert.equal(mobile.opened.length, 0);

  const none = fakeTransport([]);
  assert.equal(await ensurePairedPhoneReachable(none, true, false), "no-pin");
  assert.equal(none.opened.length, 0);
});

test("a listener that does not bind is a failure, not a silent success", async () => {
  const fake = fakeTransport([pin()], { ...RUNNING, running: false });
  assert.equal(await ensurePairedPhoneReachable(fake, true, false), "failed");
});

// R6 (0.4.0 audit): the Settings toggle sits one screen from an open pairing
// panel, and `pairing_open` REPLACES a running window. Binding the resting
// window there reaped a live code the person could still see.
test("a window already up is left alone, never replaced", async () => {
  const running = fakeTransport([pin()], RUNNING, RUNNING);
  assert.equal(await ensurePairedPhoneReachable(running, true, false), "busy");
  assert.equal(
    running.opened.length,
    0,
    "pairing_open reaps the running window, so a live code window must survive",
  );

  // A status read that fails must not be read as "nothing is running": the
  // safe direction is to leave whatever is bound alone and try again later.
  const unknown = fakeTransport([pin()]);
  unknown.pairingStatus = async () => {
    throw new Error("ipc");
  };
  assert.equal(await ensurePairedPhoneReachable(unknown, true, false), "busy");
  assert.equal(unknown.opened.length, 0);
});

test("a legacy pin without a pairing id adopts one and binds under it", async () => {
  const legacy = pin({ pairing_id: null });
  const adopted: { value: string | null } = { value: null };
  const fake: Fake = {
    opened: [],
    batches: [],
    async pairingOpen(input: PairingOpenInput) {
      fake.opened.push(input);
      return RUNNING;
    },
    async pairingStatus() {
      return STOPPED;
    },
    async peers() {
      return [{ ...legacy, pairing_id: adopted.value }];
    },
    async batch(statements: BatchStatement[]) {
      fake.batches.push(statements);
      adopted.value = statements[0]?.params?.[0] as string;
    },
  };
  const outcome = await ensurePairedPhoneReachable(fake, true, false);
  assert.equal(outcome, "opened");
  assert.equal(fake.batches.length, 1);
  assert.ok(adopted.value !== null && adopted.value.length > 0);
  assert.equal(fake.opened[0]?.pairingId, adopted.value);
});

test("forgetting deletes the peer row and every floor row in one batch", () => {
  const statements = forgetPairingStatements(PHONE);
  assert.equal(statements.length, 2);
  assert.equal(
    statements[0]?.sql,
    "DELETE FROM sync_peers WHERE device_id = ?",
  );
  assert.deepEqual(statements[0]?.params, [PHONE]);
  assert.equal(statements[1]?.sql, FLOOR_ROWS_DELETE_SQL);
  // The underscore wildcard must stay escaped, or `pairingXcounter.` rows
  // would be deleted too.
  assert.ok(FLOOR_ROWS_DELETE_SQL.includes("pairing\\_counter."));
});
