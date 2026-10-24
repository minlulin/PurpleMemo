// The phone page's decrypt path, executed.
//
// The page is served from the Rust binary and runs on a phone, so nothing in
// the repository used to execute it. Its decryption used to be inline in a
// classic `<script>`, which is unreachable from Node by construction. It now
// lives in `src-tauri/share/_snapshot.js` — the same module the page imports as
// `/_snapshot.js` — and this test runs that module against an envelope produced
// by the desktop's own `encryptSnapshot`.
//
// What this proves: the format the desktop writes is the format the phone
// reads, and a tampered envelope or a wrong key fails rather than rendering
// garbage. What it does not prove: DOM rendering, or the browser's module
// loading — both are covered only by the installed-acceptance step.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildShareSnapshot, encryptSnapshot } from "./share.ts";

/** The page module, imported by path so TypeScript does not type it as `any`. */
const phoneModulePath = new URL(
  "../../src-tauri/share/_snapshot.js",
  import.meta.url,
).href;

interface PhoneModule {
  decryptSnapshot: (envelope: unknown, keyHex: string) => unknown;
  keyBytes: (hex: string) => Uint8Array;
  base64Bytes: (value: string) => Uint8Array;
}

const phone = (await import(phoneModulePath)) as PhoneModule;

const KEY = "ab".repeat(32);

function sampleSnapshot() {
  return buildShareSnapshot({
    today: "2026-10-20",
    generatedAt: "2026-10-20T09:30",
    dayEntries: [],
    walletBalances: [{ name: "Cash", balanceCents: 12_345 }],
    receivableCents: 0,
    dueTasks: [],
    reminders: [],
    habits: [],
    upcoming: [],
    birthdays: [],
    warranties: [],
    notes: [
      {
        id: 1,
        title: "Plan",
        content: "**bold** text",
        tags: "",
        collection_id: null,
        pinned: 0,
        archived: 0,
        created_at: "2026-10-20T08:00",
        updated_at: "2026-10-20T08:00",
      },
    ],
  });
}

test("the phone decrypts exactly what the desktop published", () => {
  const snapshot = sampleSnapshot();
  const envelope = JSON.parse(encryptSnapshot(snapshot, KEY)) as unknown;
  assert.deepEqual(phone.decryptSnapshot(envelope, KEY), snapshot);
});

test("a wrong key fails instead of rendering garbage", () => {
  // GCM authenticates: a wrong key fails the tag check and throws, which is
  // what makes the "cannot decrypt" message on the page the honest one.
  const envelope = JSON.parse(encryptSnapshot(sampleSnapshot(), KEY)) as Record<
    string,
    unknown
  >;
  assert.throws(() => phone.decryptSnapshot(envelope, "cd".repeat(32)), /tag/i);
});

test("an envelope whose timestamp was edited on the wire is refused", () => {
  // `generatedAt` is authenticated as AAD. Without that, an attacker on the
  // path could relabel a stale snapshot as current — the page would show old
  // money as today's.
  const envelope = JSON.parse(encryptSnapshot(sampleSnapshot(), KEY)) as Record<
    string,
    unknown
  >;
  const tampered = { ...envelope, generatedAt: "2026-10-20T23:59" };
  assert.throws(() => phone.decryptSnapshot(tampered, KEY));
});

test("a malformed envelope is refused before any key work", () => {
  assert.throws(() => phone.decryptSnapshot({ version: 1 }, KEY));
  assert.throws(() => phone.decryptSnapshot(null, KEY));
  assert.throws(() => phone.decryptSnapshot({}, KEY));
});

test("the shared key helper refuses a key that is not 32 bytes of hex", () => {
  for (const bad of ["", "ab", "AB".repeat(32), "zz".repeat(32)]) {
    assert.throws(() => phone.keyBytes(bad), /Missing share key/);
  }
  assert.equal(phone.keyBytes(KEY).length, 32);
});

test("the vendored crypto is the installed package's bytes, when present", () => {
  // the three files under `src-tauri/share/_crypto/` are copies, and a
  // copy can drift. This catches a dependency bump that forgot to re-vendor.
  // Skipped when `node_modules` is absent — the point of vendoring is that the
  // build no longer needs it, so a missing install must not fail the suite.
  const names = ["aes.js", "_polyval.js", "utils.js"];
  let installed: string;
  try {
    installed = readFileSync(
      new URL("../../node_modules/@noble/ciphers/aes.js", import.meta.url),
      "utf8",
    );
  } catch {
    return;
  }
  assert.ok(installed.length > 0);
  for (const name of names) {
    const vendored = readFileSync(
      new URL(`../../src-tauri/share/_crypto/${name}`, import.meta.url),
      "utf8",
    );
    const packageFile = readFileSync(
      new URL(`../../node_modules/@noble/ciphers/${name}`, import.meta.url),
      "utf8",
    );
    assert.equal(vendored, packageFile, `${name} is out of date`);
  }
});
