/**
 * The desktop pairing panel, tested where it is decided.
 *
 * No stubbed "paired" flag: the panel opens through the driver's real IPC
 * shape (the mock mirrors the Rust refusals), the QR is parsed back through
 * `parseOffer`, and the pin is written with the store's statements into a real
 * SQLite database built from the shipped v8 DDL.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type {
  BatchStatement,
  DataDriver,
  PairingListenerInfo,
  PairingLocalInfo,
  PairingOpenInput,
} from "../../data/driver.ts";
import { createMockDriver } from "../../data/mock-driver.ts";
import {
  keyFingerprint,
  PAIRING_CODE_LIFETIME_MS,
  type PairingOffer,
  parseOffer,
  pinStatements,
} from "./pairing.ts";
import {
  closePairingPanel,
  identityRecovery,
  openPairingPanel,
  type PairingPanelState,
  type PairingTransport,
  panelView,
  pendingConfirmation,
  pinAdmittedPeer,
  settlePairingPanel,
} from "./pairingPanel.ts";
import { readPeers } from "./store.ts";

const SCHEMA_RS = readFileSync(
  new URL("../../../src-tauri/src/schema.rs", import.meta.url),
  "utf8",
);

function syncDdl(): string {
  const match = /pub const MIGRATION_7_8: &str = r#"([\s\S]*?)"#;/.exec(
    SCHEMA_RS,
  );
  if (match?.[1] === undefined) {
    throw new Error("MIGRATION_7_8 not found in schema.rs");
  }
  return match[1];
}

const DDL = syncDdl();

/** Only the pre-v8 table the migration's ALTER touches. */
const REMINDERS = `
CREATE TABLE reminders (
  id INTEGER PRIMARY KEY, uid TEXT, title TEXT NOT NULL, remind_at TEXT NOT NULL,
  repeat TEXT NOT NULL DEFAULT 'none', note TEXT NOT NULL DEFAULT '',
  fired INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);`;

const DESKTOP_DEVICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PHONE_DEVICE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DESKTOP_KEY =
  "7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13";
const PHONE_KEY = "0f1e2d3c4b5a69788796a5b4c3d2e1f0".repeat(2);
/** A key presented for an already-pinned device id — the collision case. */
const OTHER_PHONE_KEY = "aa".repeat(32);
const PHONE_FINGERPRINT = "0F1E 2D3C 4B5A 6978 8796 A5B4";

const LOCAL: PairingLocalInfo = {
  deviceId: DESKTOP_DEVICE,
  generation: 1,
  schemaVersion: 8,
  protocolVersion: 1,
  publicKey: DESKTOP_KEY,
  fingerprint: "7B4E 909B BE7F FE44 C465 A220",
};

function listener(
  over: Partial<PairingListenerInfo> = {},
): PairingListenerInfo {
  return {
    running: true,
    port: 8788,
    endpoint: "192.168.1.5:8788",
    publicKey: DESKTOP_KEY,
    fingerprint: LOCAL.fingerprint,
    peerDeviceId: null,
    peerPublicKey: null,
    peerFingerprint: null,
    peerHelloReceived: false,
    note: null,
    ...over,
  };
}

function transportFor(
  driver: ReturnType<typeof createMockDriver>,
  peers: Awaited<ReturnType<typeof readPeers>> = [],
): PairingTransport {
  return {
    pairingLocal: () => driver.pairingLocal(),
    pairingOpen: (input) => driver.pairingOpen(input),
    pairingClose: () => driver.pairingClose(),
    pairingStatus: () => driver.pairingStatus(),
    batch: (statements) => driver.batch(statements),
    peers: async () => peers,
  };
}

test("the panel opens the real listener before it shows a code", async () => {
  const driver = createMockDriver();
  const transport = transportFor(driver);
  const now = Date.now();
  const state = await openPairingPanel(transport, now);

  assert.equal(state.listener.running, true);
  assert.equal(state.listener.fingerprint, LOCAL.fingerprint);
  assert.equal(state.offer.endpoint, "192.168.1.5:8788");
  assert.equal(state.offer.publicKey, DESKTOP_KEY);
  assert.equal(state.session.offer.expiresAt, now + PAIRING_CODE_LIFETIME_MS);

  // The code the listener gates on is the code in the QR — not a second one.
  const opened = driver.callsTo("pairingOpen")[0];
  assert.ok(opened !== undefined, "the window must be opened once");
  const [input] = opened.args as [PairingOpenInput];
  assert.equal(input.offerCode, state.offer.code);
  assert.equal(input.offerExpiresAt, state.offer.expiresAt);
  assert.equal(input.pairingId, state.offer.pairingId);

  const view = panelView(state, now);
  assert.equal(view.code, state.offer.code);
  assert.ok(view.payload !== null);
  const parsed = parseOffer(view.payload ?? "");
  assert.ok(parsed.ok);
  assert.equal(parsed.offer.pairingId, state.offer.pairingId);
  assert.equal(parsed.offer.code, state.offer.code);
  assert.equal(parsed.offer.endpoint, "192.168.1.5:8788");
});

test("expiry closes the socket before the code leaves the screen", async () => {
  const driver = createMockDriver();
  const transport = transportFor(driver);
  const now = Date.now();
  const state = await openPairingPanel(transport, now);

  // Live: nothing is closed.
  const live = await settlePairingPanel(transport, state, now + 1_000);
  assert.equal(live.listener.running, true);
  assert.equal(driver.callsTo("pairingClose").length, 0);

  const dead = panelView(state, state.offer.expiresAt);
  assert.equal(dead.code, null, "no code is shown after it expires");
  assert.equal(dead.payload, null, "and no QR either");
  assert.match(dead.reason ?? "", /expired/);

  const settled = await settlePairingPanel(
    transport,
    state,
    state.offer.expiresAt,
  );
  assert.equal(settled.listener.running, false);
  assert.equal(driver.callsTo("pairingClose").length, 1);
});

function openDb(): { db: DatabaseSync; driver: DataDriver } {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(REMINDERS);
  db.exec(DDL);
  const run = (sql: string, params: unknown[] = []): void => {
    db.prepare(sql).run(...(params as never[]));
  };
  const driver = {
    query: async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
      db.prepare(sql).all(...(params as never[])) as T[],
    execute: async (sql: string, params: unknown[] = []): Promise<void> => {
      run(sql, params);
    },
    async batch(statements: BatchStatement[]): Promise<void> {
      db.exec("BEGIN");
      try {
        for (const statement of statements) {
          run(statement.sql, statement.params ?? []);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as DataDriver;
  return { db, driver };
}

function panelState(pairingId: string): PairingPanelState {
  const now = Date.now();
  const offer: PairingOffer = {
    version: 1,
    pairingId,
    deviceId: DESKTOP_DEVICE,
    endpoint: "192.168.1.5:8788",
    publicKey: DESKTOP_KEY,
    generation: 1,
    protocolVersion: 1,
    schemaVersion: 8,
    code: "123456",
    createdAt: now,
    expiresAt: now + PAIRING_CODE_LIFETIME_MS,
  };
  return {
    local: LOCAL,
    session: { offer, failedAttempts: [], usedAt: null },
    offer,
    listener: listener(),
  };
}

test("the code's peer becomes one sync_peers row, and a re-pair resets cursors", async () => {
  const { db, driver } = openDb();
  const admitted = listener({
    peerDeviceId: PHONE_DEVICE,
    peerPublicKey: PHONE_KEY,
    peerFingerprint: PHONE_FINGERPRINT,
    // Trust is only offered after a sealed hello proved possession (N1).
    peerHelloReceived: true,
  });
  const transport: PairingTransport = {
    pairingLocal: async () => LOCAL,
    pairingOpen: async () => admitted,
    pairingClose: async () => listener({ running: false }),
    pairingStatus: async () => admitted,
    batch: (statements) => driver.batch(statements),
    peers: () => readPeers(driver),
  };

  const write = await pinAdmittedPeer(transport, panelState("pair-1"));
  assert.ok(write !== null);
  assert.equal(write.repinned, false);
  assert.equal(write.peer.fingerprint, "0F1E 2D3C 4B5A 6978 8796 A5B4");

  const first = db
    .prepare(
      "SELECT device_id, pairing_id, public_key, generation FROM sync_peers",
    )
    .get() as {
    device_id: string;
    pairing_id: string;
    public_key: string;
    generation: number;
  };
  assert.equal(first.device_id, PHONE_DEVICE);
  assert.equal(first.pairing_id, "pair-1");
  assert.equal(first.public_key, PHONE_KEY);
  assert.equal(first.generation, 1);

  db.prepare(
    "UPDATE sync_peers SET cursor_in = 7, cursor_out = 9, display_name = ?",
  ).run("Sam's phone");
  const again = await pinAdmittedPeer(transport, panelState("pair-2"));
  assert.ok(again?.repinned, "a peer that paired before is re-paired (§11.4)");
  const second = db
    .prepare(
      "SELECT pairing_id, cursor_in, cursor_out, display_name FROM sync_peers",
    )
    .get() as {
    pairing_id: string;
    cursor_in: number;
    cursor_out: number;
    display_name: string;
  };
  assert.equal(second.pairing_id, "pair-2");
  assert.equal(second.cursor_in, 0);
  assert.equal(second.cursor_out, 0);
  assert.equal(
    second.display_name,
    "Sam's phone",
    "re-pairing a known phone keeps the name it was given (N10)",
  );
});

test("nothing is pinned until the listener reports an admitted peer", async () => {
  const { db, driver } = openDb();
  const quiet: PairingTransport = {
    pairingLocal: async () => LOCAL,
    pairingOpen: async () => listener(),
    pairingClose: async () => listener({ running: false }),
    pairingStatus: async () => listener(),
    batch: (statements) => driver.batch(statements),
    peers: () => readPeers(driver),
  };
  assert.equal(await pinAdmittedPeer(quiet, panelState("pair-1")), null);
  const row = db.prepare("SELECT count(*) AS n FROM sync_peers").get() as {
    n: number;
  };
  assert.equal(row.n, 0);
});

test("the poll tick never pins a staged candidate", async () => {
  const { db, driver } = openDb();
  const staged = listener({
    peerDeviceId: PHONE_DEVICE,
    peerPublicKey: PHONE_KEY,
    peerFingerprint: PHONE_FINGERPRINT,
    peerHelloReceived: true,
  });
  let writes = 0;
  const transport: PairingTransport = {
    pairingLocal: async () => LOCAL,
    pairingOpen: async () => staged,
    pairingClose: async () => listener({ running: false }),
    pairingStatus: async () => staged,
    batch: async (statements) => {
      writes += 1;
      await driver.batch(statements);
    },
    peers: () => readPeers(driver),
  };

  const now = Date.now();
  const state = await openPairingPanel(transport, now);
  const settled = await settlePairingPanel(transport, state, now + 2_000);
  assert.equal(
    settled.listener.peerDeviceId,
    PHONE_DEVICE,
    "the panel sees the candidate",
  );
  assert.equal(writes, 0, "a tick is not a Trust");
  const row = db.prepare("SELECT count(*) AS n FROM sync_peers").get() as {
    n: number;
  };
  assert.equal(row.n, 0, "nothing was pinned by the clock");
});

test("Trust pins the staged peer once; Reject closes without pinning", async () => {
  const { db, driver } = openDb();
  const staged = listener({
    peerDeviceId: PHONE_DEVICE,
    peerPublicKey: PHONE_KEY,
    peerFingerprint: PHONE_FINGERPRINT,
    peerHelloReceived: true,
  });
  let writes = 0;
  const transport: PairingTransport = {
    pairingLocal: async () => LOCAL,
    pairingOpen: async () => staged,
    pairingClose: async () => listener({ running: false }),
    pairingStatus: async () => staged,
    batch: async (statements) => {
      writes += 1;
      await driver.batch(statements);
    },
    peers: () => readPeers(driver),
  };
  const state: PairingPanelState = {
    ...panelState("pair-1"),
    listener: staged,
  };

  const written = await pinAdmittedPeer(transport, state);
  assert.ok(written !== null);
  assert.equal(written.peer.deviceId, PHONE_DEVICE);
  assert.equal(writes, 1, "Trust writes the pin exactly once");

  // Reject is the window closing: no write at all, and no row for a peer the
  // person never trusted.
  const rejected = await closePairingPanel(transport);
  assert.equal(rejected.running, false);
  assert.equal(writes, 1);
  const row = db.prepare("SELECT count(*) AS n FROM sync_peers").get() as {
    n: number;
  };
  assert.equal(row.n, 1);
});

test("Trust is withheld until a sealed hello proves key possession", async () => {
  const { db, driver } = openDb();
  const staged = listener({
    peerDeviceId: PHONE_DEVICE,
    peerPublicKey: PHONE_KEY,
    peerFingerprint: PHONE_FINGERPRINT,
    peerHelloReceived: false,
  });
  const transport: PairingTransport = {
    pairingLocal: async () => LOCAL,
    pairingOpen: async () => staged,
    pairingClose: async () => listener({ running: false }),
    pairingStatus: async () => staged,
    batch: (statements) => driver.batch(statements),
    peers: () => readPeers(driver),
  };
  const state: PairingPanelState = {
    ...panelState("pair-1"),
    listener: staged,
  };

  const pending = pendingConfirmation(state);
  assert.ok(pending !== null);
  assert.equal(pending.helloReceived, false);

  await assert.rejects(() => pinAdmittedPeer(transport, state), /hello/);
  const row = db.prepare("SELECT count(*) AS n FROM sync_peers").get() as {
    n: number;
  };
  assert.equal(row.n, 0, "an unproven key is never pinned");
});

test("a lost key offers the confirmed replacement, a working key never does", () => {
  const base = {
    present: false,
    publicKey: null,
    fingerprint: null,
    needsRePair: true,
    lost: false,
    rePairRequired: true,
    note: "this device's pairing key is missing from the platform key store",
  } as const;

  const missing = identityRecovery({ ...base });
  assert.equal(missing.needed, true, "a missing key is why opening fails");
  assert.match(missing.note ?? "", /pairing key is missing/);

  const lost = identityRecovery({ ...base, lost: true });
  assert.equal(lost.needed, true, "an unopenable key is just as unusable");

  const healthy = identityRecovery({
    ...base,
    present: true,
    publicKey:
      "7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13",
    fingerprint: "7B4E 909B BE7F FE44 C465 A220",
    needsRePair: false,
    rePairRequired: false,
    note: null,
  });
  assert.equal(
    healthy.needed,
    false,
    "a readable key is never replaced behind the person's back (§11.2)",
  );
  assert.equal(healthy.fingerprint, "7B4E 909B BE7F FE44 C465 A220");

  const rePairOnly = identityRecovery({
    ...base,
    present: true,
    needsRePair: true,
    note: null,
  });
  assert.equal(
    rePairOnly.needed,
    false,
    "needing a re-pair is not a reason to replace the key",
  );
  assert.equal(rePairOnly.rePairRequired, true);

  assert.equal(
    identityRecovery(null).needed,
    false,
    "an unknown status invites nothing",
  );
});

test("the panel replaces the identity only through the two-step confirmation", () => {
  const panel = readFileSync(
    new URL("../../components/PairingPanel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(panel, /const recovery = identityRecovery\(identity\)/);
  assert.match(panel, /\{recovery\.needed \?/);
  assert.match(
    panel,
    /<ConfirmButton[\s\S]{0,300}?onConfirm=\{replaceIdentity\}/,
    "the replacement is behind the app's one confirmation pattern",
  );
  assert.equal(
    (panel.match(/pairingRepo\.replaceIdentity\(/g) ?? []).length,
    1,
    "one replacement call site",
  );
  assert.match(panel, /pairingRepo\.replaceIdentity\(true\)/);
  assert.doesNotMatch(
    panel,
    /onClick=\{\(\) => void replaceIdentity\(\)\}/,
    "no one-click replacement path",
  );
});

test("a deviceId collision shows the existing phone and its fingerprint", async () => {
  const { driver } = openDb();
  await driver.batch(
    pinStatements({
      deviceId: PHONE_DEVICE,
      generation: 1,
      pairingId: "pair-0",
      publicKey: PHONE_KEY,
      displayName: "Sam's phone",
    }),
  );
  const peers = await readPeers(driver);
  const staged = listener({
    peerDeviceId: PHONE_DEVICE,
    peerPublicKey: OTHER_PHONE_KEY,
    peerFingerprint: keyFingerprint(OTHER_PHONE_KEY),
    peerHelloReceived: false,
  });

  const pending = pendingConfirmation(
    { ...panelState("pair-1"), listener: staged },
    peers,
  );
  assert.ok(pending !== null);
  assert.equal(pending.localFingerprint, LOCAL.fingerprint);
  assert.equal(pending.peer.fingerprint, keyFingerprint(OTHER_PHONE_KEY));
  assert.equal(pending.existing?.displayName, "Sam's phone");
  assert.equal(pending.existing?.fingerprint, keyFingerprint(PHONE_KEY));
  assert.notEqual(
    pending.peer.fingerprint,
    pending.existing?.fingerprint,
    "the presented key and the pinned one are shown side by side",
  );
});
