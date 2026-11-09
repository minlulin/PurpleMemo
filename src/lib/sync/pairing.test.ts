/**
 * Pairing tests — real codes, real pins, real databases.
 *
 * There is no stubbed "paired" flag anywhere: a pin is a row in `sync_peers`,
 * written by the same store statements the app will call, read back from a real
 * SQLite database built from the shipped DDL. An admission verdict is computed
 * from those rows, so a refused peer is refused because its row says so.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { BatchStatement, DataDriver } from "../../data/driver.ts";
import {
  admitPeer,
  canRePair,
  createPairingSession,
  encodeOffer,
  IDLE_LISTENER,
  keyFingerprint,
  PAIRING_CODE_LIFETIME_MS,
  PAIRING_MAX_ATTEMPTS,
  type PinnedPeer,
  pairingState,
  parseOffer,
  pinStatements,
  redeemCode,
  rePairStatements,
  revokePeerStatements,
  startPairingListener,
  stopPairingListener,
} from "./pairing.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { outboxStatements, readPeers, readState } from "./store.ts";

const SCHEMA_RS = readFileSync(
  new URL("../../../src-tauri/src/schema.rs", import.meta.url),
  "utf8",
);

function syncDdl(): string {
  const match = /pub const MIGRATION_7_8: &str = r#"([\s\S]*?)"#;/.exec(
    SCHEMA_RS,
  );
  assert.ok(match?.[1], "MIGRATION_7_8 not found in schema.rs");
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

const DESKTOP_KEY = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const PHONE_KEY = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const DESKTOP_DEVICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PHONE_DEVICE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SCHEMA_VERSION = 8;
const NOW = 1_760_000_000_000;

function openPeer(): { db: DatabaseSync; driver: DataDriver } {
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
        for (const statement of statements)
          run(statement.sql, statement.params ?? []);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as DataDriver;
  return { db, driver };
}

function count(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as { n: number } | undefined;
  return row?.n ?? 0;
}

function pinnedFrom(
  row: Awaited<ReturnType<typeof readPeers>>[number],
): PinnedPeer {
  return {
    deviceId: row.device_id,
    publicKey: row.public_key ?? "",
    generation: row.generation,
    pairingId: row.pairing_id,
    revoked: row.revoked_at !== null,
  };
}

function fixedCode(code: string) {
  return () => {
    const digits = Number(code);
    return new Uint8Array([
      (digits >>> 24) & 0xff,
      (digits >>> 16) & 0xff,
      (digits >>> 8) & 0xff,
      digits & 0xff,
    ]);
  };
}

function offerFor(desktop: string, code = "123456") {
  return createPairingSession({
    deviceId: desktop,
    endpoint: "192.168.1.20:47820",
    publicKey: DESKTOP_KEY,
    generation: 1,
    schemaVersion: SCHEMA_VERSION,
    now: NOW,
    random: fixedCode(code),
  });
}

test("a pairing code redeems once, pins both sides, and a later hello is admitted", async () => {
  const desktop = openPeer();
  const phone = openPeer();
  const session = offerFor(DESKTOP_DEVICE);
  assert.equal(session.offer.code, "123456");

  // The QR payload is the same offer, and it survives the round trip intact.
  const parsed = parseOffer(encodeOffer(session.offer));
  assert.ok(parsed.ok, "the encoded offer must parse");
  assert.deepEqual(parsed.offer, session.offer);

  // A wrong code costs an attempt; the right one spends the session.
  const wrong = redeemCode(session, "654321", NOW + 1_000);
  assert.equal(wrong.verdict.ok, false);
  assert.equal(wrong.verdict.attemptsLeft, PAIRING_MAX_ATTEMPTS - 1);
  const redeemed = redeemCode(wrong.session, "12 34 56", NOW + 2_000);
  assert.ok(redeemed.verdict.ok, "the code is accepted after one wrong guess");
  assert.equal(pairingState(redeemed.session, NOW + 2_000), "used");
  assert.equal(
    redeemCode(redeemed.session, "123456", NOW + 3_000).verdict.ok,
    false,
  );

  // Pairing stores each side's pin of the other (§11.2), on both devices.
  await desktop.driver.batch(
    pinStatements({
      deviceId: PHONE_DEVICE,
      generation: 1,
      pairingId: session.offer.pairingId,
      publicKey: PHONE_KEY,
      displayName: "Phone",
    }),
  );
  await phone.driver.batch(
    pinStatements({
      deviceId: DESKTOP_DEVICE,
      generation: 1,
      pairingId: session.offer.pairingId,
      publicKey: DESKTOP_KEY,
      displayName: "Desktop",
    }),
  );
  const desktopPin = pinnedFrom((await readPeers(desktop.driver))[0] as never);
  const phonePin = pinnedFrom((await readPeers(phone.driver))[0] as never);
  assert.equal(desktopPin.publicKey, PHONE_KEY);
  assert.equal(phonePin.publicKey, DESKTOP_KEY);
  assert.equal(desktopPin.pairingId, session.offer.pairingId);
  assert.equal(desktopPin.revoked, false);

  // A later hello under the pinned key is admitted — no trust on first use.
  const admitted = admitPeer({
    local: {
      deviceId: DESKTOP_DEVICE,
      protocolVersion: PROTOCOL_VERSION,
      dataSchemaVersion: SCHEMA_VERSION,
      generation: 1,
    },
    remote: {
      deviceId: PHONE_DEVICE,
      protocolVersion: PROTOCOL_VERSION,
      dataSchemaVersion: SCHEMA_VERSION,
      generation: 1,
    },
    remotePublicKey: PHONE_KEY,
    pinned: desktopPin,
    pairingId: session.offer.pairingId,
  });
  assert.deepEqual(admitted, { ok: true, message: "hello accepted." });

  // The fingerprints both screens show are derived from those same keys.
  assert.equal(keyFingerprint(PHONE_KEY), "0F1E 2D3C 4B5A 6978 8796 A5B4");
  assert.notEqual(keyFingerprint(PHONE_KEY), keyFingerprint(DESKTOP_KEY));
});

test("an expired, used or exhausted code is refused with a reason", () => {
  const session = offerFor(DESKTOP_DEVICE);

  const expired = redeemCode(
    session,
    "123456",
    NOW + PAIRING_CODE_LIFETIME_MS + 1,
  );
  assert.equal(expired.verdict.refusal, "expired");
  assert.equal(
    pairingState(session, NOW + PAIRING_CODE_LIFETIME_MS + 1),
    "expired",
  );

  const malformed = redeemCode(session, "12ab", NOW + 10);
  assert.equal(malformed.verdict.refusal, "malformed");
  assert.equal(
    malformed.session.failedAttempts.length,
    0,
    "a typo is not a guess and must not burn an attempt",
  );

  // Five wrong guesses lock the code; the sixth attempt cannot redeem it even
  // with the right digits.
  let locked = session;
  for (let attempt = 1; attempt <= PAIRING_MAX_ATTEMPTS; attempt += 1) {
    const result = redeemCode(locked, "000000", NOW + attempt * 100);
    locked = result.session;
    assert.equal(result.verdict.ok, false);
  }
  assert.equal(pairingState(locked, NOW + 1_000), "locked");
  const afterLock = redeemCode(locked, "123456", NOW + 1_100);
  assert.equal(afterLock.verdict.refusal, "locked");
  assert.equal(afterLock.verdict.ok, false);
});

test("a revoked peer is refused before any effect, before anything else is checked", async () => {
  const desktop = openPeer();
  await desktop.driver.batch(
    pinStatements({
      deviceId: PHONE_DEVICE,
      generation: 1,
      pairingId: "pairing-1",
      publicKey: PHONE_KEY,
    }),
  );
  await desktop.driver.batch(revokePeerStatements(PHONE_DEVICE));
  const pin = pinnedFrom((await readPeers(desktop.driver))[0] as never);
  assert.equal(pin.revoked, true);

  const local = {
    deviceId: DESKTOP_DEVICE,
    protocolVersion: PROTOCOL_VERSION,
    dataSchemaVersion: SCHEMA_VERSION,
    generation: 1,
  };
  const refused = admitPeer({
    local,
    remote: {
      deviceId: PHONE_DEVICE,
      protocolVersion: PROTOCOL_VERSION,
      dataSchemaVersion: SCHEMA_VERSION,
      generation: 1,
    },
    // Even a key that no longer matches is irrelevant: revocation is the wall.
    remotePublicKey: "ffffffffffffffffffffffffffffffff",
    pinned: pin,
    pairingId: "pairing-1",
  });
  assert.deepEqual(
    refused.ok === false ? refused.code : null,
    "revoked",
    "a revoked peer must be refused for being revoked, not for its key",
  );

  // Nothing flowed: no outbox row, no tombstone, no delivery, and the phone is
  // still the only pin.
  assert.equal(count(desktop.db, "SELECT count(*) AS n FROM sync_outbox"), 0);
  assert.equal(
    count(desktop.db, "SELECT count(*) AS n FROM sync_tombstones"),
    0,
  );
  assert.equal(
    count(desktop.db, "SELECT count(*) AS n FROM sync_outbox_delivery"),
    0,
  );
  assert.equal(count(desktop.db, "SELECT count(*) AS n FROM sync_peers"), 1);
});

test("a changed key, a foreign pairing, a new generation and a different build are refusals", () => {
  const pinned: PinnedPeer = {
    deviceId: PHONE_DEVICE,
    publicKey: PHONE_KEY,
    generation: 1,
    pairingId: "pairing-1",
    revoked: false,
  };
  const local = {
    deviceId: DESKTOP_DEVICE,
    protocolVersion: PROTOCOL_VERSION,
    dataSchemaVersion: SCHEMA_VERSION,
    generation: 1,
  };
  const hello = {
    deviceId: PHONE_DEVICE,
    protocolVersion: PROTOCOL_VERSION,
    dataSchemaVersion: SCHEMA_VERSION,
    generation: 1,
  };

  const keyMismatch = admitPeer({
    local,
    remote: hello,
    remotePublicKey: "ffffffffffffffffffffffffffffffff",
    pinned,
    pairingId: "pairing-1",
  });
  assert.equal(
    keyMismatch.ok === false ? keyMismatch.code : null,
    "key-mismatch",
  );

  const foreignPairing = admitPeer({
    local,
    remote: hello,
    remotePublicKey: PHONE_KEY,
    pinned,
    pairingId: "pairing-2",
  });
  assert.equal(
    foreignPairing.ok === false ? foreignPairing.code : null,
    "pairing-mismatch",
  );

  const mismatchedGeneration = admitPeer({
    local: { ...local, generation: 2 },
    remote: hello,
    remotePublicKey: PHONE_KEY,
    pinned,
    pairingId: "pairing-1",
  });
  assert.equal(
    mismatchedGeneration.ok === false ? mismatchedGeneration.code : null,
    "generation-mismatch",
    "the phone still believes in the old data line (§10.2)",
  );

  const stalePin = admitPeer({
    local: { ...local, generation: 2 },
    remote: { ...hello, generation: 2 },
    remotePublicKey: PHONE_KEY,
    pinned,
    pairingId: "pairing-1",
  });
  assert.equal(
    stalePin.ok === false ? stalePin.code : null,
    "needs-re-pair",
    "the pin remembers generation 1, so this pairing is stale (§10.5)",
  );

  const newerProtocol = admitPeer({
    local,
    remote: { ...hello, protocolVersion: PROTOCOL_VERSION + 1 },
    remotePublicKey: PHONE_KEY,
    pinned,
    pairingId: "pairing-1",
  });
  assert.equal(
    newerProtocol.ok === false ? newerProtocol.code : null,
    "protocol-unsupported",
  );

  const otherSchema = admitPeer({
    local,
    remote: { ...hello, dataSchemaVersion: SCHEMA_VERSION - 1 },
    remotePublicKey: PHONE_KEY,
    pinned,
    pairingId: "pairing-1",
  });
  assert.equal(
    otherSchema.ok === false ? otherSchema.code : null,
    "schema-mismatch",
  );

  // An unpinned device is told to pair, not merged.
  const unpaired = admitPeer({
    local,
    remote: hello,
    remotePublicKey: PHONE_KEY,
    pinned: null,
    pairingId: null,
  });
  assert.equal(unpaired.ok === false ? unpaired.code : null, "unpaired");
});

test("a pin without a pairing id is refused, not trusted (§11.6.1)", () => {
  const local = {
    deviceId: DESKTOP_DEVICE,
    protocolVersion: PROTOCOL_VERSION,
    dataSchemaVersion: SCHEMA_VERSION,
    generation: 1,
  };
  const refused = admitPeer({
    local,
    remote: { ...local, deviceId: PHONE_DEVICE },
    remotePublicKey: PHONE_KEY,
    pinned: {
      deviceId: PHONE_DEVICE,
      publicKey: PHONE_KEY,
      generation: 1,
      pairingId: null,
      revoked: false,
    },
    pairingId: null,
  });
  assert.equal(
    refused.ok === false ? refused.code : null,
    "unpaired",
    "a pairing id is the HKDF salt; a pin without one cannot be admitted",
  );
  assert.match(refused.ok === false ? refused.message : "", /pairing id/);
});

test("re-pair refuses while the outbox owes writes, and otherwise starts a new pairing", async () => {
  assert.equal(canRePair(0, false).ok, true);
  const refused = canRePair(3, false);
  assert.equal(refused.ok, false);
  assert.match(
    refused.ok === false ? refused.message : "",
    /not been delivered/,
  );
  assert.equal(
    canRePair(3, true).ok,
    true,
    "the user may discard deliberately",
  );

  const phone = openPeer();
  await phone.driver.batch(
    pinStatements({
      deviceId: DESKTOP_DEVICE,
      generation: 1,
      pairingId: "pairing-old",
      publicKey: DESKTOP_KEY,
    }),
  );
  // A delivered-then-acknowledged outbox leaves a delivery row and a cursor.
  await phone.driver.batch([
    ...outboxStatements([
      {
        table: "notes",
        uid: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a",
        kind: "create",
      },
    ]),
    {
      sql: "INSERT INTO sync_outbox_delivery (outbox_id, peer_id, acked_at) SELECT id, ?, 'now' FROM sync_outbox",
      params: [DESKTOP_DEVICE],
    },
    {
      sql: "UPDATE sync_peers SET cursor_in = 4, cursor_out = 7 WHERE device_id = ?",
      params: [DESKTOP_DEVICE],
    },
  ]);

  await phone.driver.batch(revokePeerStatements(DESKTOP_DEVICE));
  await phone.driver.batch(
    rePairStatements({
      deviceId: DESKTOP_DEVICE,
      generation: 2,
      pairingId: "pairing-new",
      publicKey: DESKTOP_KEY,
    }),
  );

  const peer = (await readPeers(phone.driver))[0];
  assert.equal(peer?.pairing_id, "pairing-new");
  assert.equal(peer?.generation, 2);
  assert.equal(peer?.cursor_in, 0, "a re-pair never resumes the old cursors");
  assert.equal(peer?.cursor_out, 0);
  assert.equal(peer?.revoked_at, null, "re-pairing clears the revocation");
  assert.equal(
    count(phone.db, "SELECT count(*) AS n FROM sync_outbox_delivery"),
    0,
    "acks from the old pairing are not evidence for the new one",
  );
  assert.equal((await readState(phone.driver)).rePairRequired, false);
});

test("the pairing listener exists only while pairing is on", () => {
  assert.deepEqual(IDLE_LISTENER, {
    active: false,
    purpose: null,
    startedAt: null,
  });
  const listening = startPairingListener(NOW);
  assert.deepEqual(listening, {
    active: true,
    purpose: "pairing",
    startedAt: NOW,
  });
  assert.deepEqual(stopPairingListener(), IDLE_LISTENER);
});

test("the fingerprint matches the Rust implementation's grouping", () => {
  // The public half of the fixed desktop vector the envelope fixtures use; the
  // Rust side asserts the same string in `src-tauri/src/pairing_key.rs`. If the
  // two ever format the key differently, the screens a human compares would
  // show different text for the same key.
  assert.equal(
    keyFingerprint(
      "7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13",
    ),
    "7B4E 909B BE7F FE44 C465 A220",
  );
});
