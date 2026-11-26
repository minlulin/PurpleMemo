import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseRememberedEndpoints,
  rememberedEndpointFor,
  resolveSyncEndpoint,
  withRememberedEndpoint,
} from "./rememberedEndpoint.ts";

const PEER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

test("a fresh offer wins over a remembered address", () => {
  // Whoever just scanned a code is looking at a desktop that is open now.
  assert.deepEqual(
    resolveSyncEndpoint({
      offerEndpoint: "192.168.1.20:47100",
      rememberedEndpoint: "192.168.1.99:47100",
    }),
    { endpoint: "192.168.1.20:47100", remembered: false },
  );
});

test("with no offer the remembered address is used, and says so", () => {
  // The `remembered` flag is what makes a failure carry the "address may have
  // changed" sentence rather than a bare socket error.
  assert.deepEqual(
    resolveSyncEndpoint({
      offerEndpoint: null,
      rememberedEndpoint: "192.168.1.20:47100",
    }),
    { endpoint: "192.168.1.20:47100", remembered: true },
  );
});

test("neither an offer nor a remembered address resolves to nothing", () => {
  // Today's behaviour: the card asks for a code instead of dialling.
  assert.equal(
    resolveSyncEndpoint({ offerEndpoint: null, rememberedEndpoint: null }),
    null,
  );
  assert.equal(
    resolveSyncEndpoint({ offerEndpoint: "", rememberedEndpoint: "   " }),
    null,
  );
});

test("a blank remembered value never becomes an endpoint", () => {
  assert.deepEqual(parseRememberedEndpoints({ [PEER]: "  " }), {});
  assert.equal(rememberedEndpointFor({ [PEER]: "" }, PEER), null);
  assert.equal(rememberedEndpointFor({}, PEER), null);
});

test("a corrupt stored map reads as nothing remembered, never as a value", () => {
  // A hand-edited or truncated row must fall back to asking for a code.
  for (const raw of [null, undefined, "192.168.1.20:47100", 7, [PEER]]) {
    assert.deepEqual(parseRememberedEndpoints(raw), {});
  }
  assert.deepEqual(
    parseRememberedEndpoints({ [PEER]: "192.168.1.20:47100", [OTHER]: 42 }),
    { [PEER]: "192.168.1.20:47100" },
  );
});

test("remembering one peer keeps the other peers' addresses", () => {
  const first = withRememberedEndpoint({}, PEER, " 192.168.1.20:47100 ");
  assert.deepEqual(first, { [PEER]: "192.168.1.20:47100" });
  const both = withRememberedEndpoint(first, OTHER, "10.0.0.4:47100");
  assert.deepEqual(both, {
    [PEER]: "192.168.1.20:47100",
    [OTHER]: "10.0.0.4:47100",
  });
  assert.deepEqual(parseRememberedEndpoints(both), both);
});

test("a newer success overwrites the older address for the same peer", () => {
  // A desktop that moved is exactly why the newest working address wins.
  assert.deepEqual(
    withRememberedEndpoint(
      { [PEER]: "192.168.1.20:47100" },
      PEER,
      "192.168.1.21:47100",
    ),
    { [PEER]: "192.168.1.21:47100" },
  );
});
