// The address a sync dials when nothing was scanned this session (F7).
//
// The pin already survives a restart — the desktop's identity and key live in
// `sync_peers` — but the endpoint did not, so a phone on the same network had
// to scan a fresh QR for every sync. This module holds the remembered address,
// one per pinned desktop, plus the two decisions around it: which endpoint a
// press may use, and how a write leaves the map.
//
// An endpoint is an ADDRESS HINT and nothing else. No trust decision reads it:
// the pinned key, unwrapped in Rust, is what proves the desktop, so a stale or
// wrong address can only fail to connect — it can never impersonate anyone.

/** `{ [desktopDeviceId]: endpoint }` — one entry per pinned desktop. */
export type RememberedEndpoints = Record<string, string>;

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The stored map, read defensively.
 *
 * Anything that is not an object is "nothing remembered" — a corrupt or
 * hand-edited row must fall back to today's behaviour (scan a code), never
 * make the Sync button dial something unreadable. Entries whose value is not
 * a usable string are dropped for the same reason.
 */
export function parseRememberedEndpoints(raw: unknown): RememberedEndpoints {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: RememberedEndpoints = {};
  for (const [deviceId, value] of Object.entries(raw)) {
    const endpoint = clean(value);
    if (endpoint !== null) out[deviceId] = endpoint;
  }
  return out;
}

/** The remembered address for one peer, or `null` when there is none. */
export function rememberedEndpointFor(
  map: RememberedEndpoints,
  desktopDeviceId: string,
): string | null {
  return clean(map[desktopDeviceId]);
}

/**
 * Remember one peer's address, keeping every other peer's.
 *
 * Overwrites — the newest address that worked is the one to dial next, and an
 * older one is exactly what a moved desktop leaves behind.
 */
export function withRememberedEndpoint(
  map: RememberedEndpoints,
  desktopDeviceId: string,
  endpoint: string,
): RememberedEndpoints {
  const cleaned = clean(endpoint);
  if (cleaned === null) return map;
  return { ...map, [desktopDeviceId]: cleaned };
}

/** The endpoint one press will use, and where it came from. */
export interface SyncEndpoint {
  endpoint: string;
  /**
   * True when this address was remembered rather than scanned this session —
   * the fact that decides whether a failure needs the "the desktop may be
   * closed, or its address may have changed" sentence.
   */
  remembered: boolean;
}

/**
 * Resolution order for a sync press: the offer scanned or pasted in THIS
 * session wins, then the address remembered for the pinned peer, then nothing
 * (today's behaviour: ask for a code).
 *
 * A fresh offer is preferred even when a remembered address exists — whoever
 * just scanned a code is looking at a desktop that is open right now.
 */
export function resolveSyncEndpoint(input: {
  offerEndpoint: string | null | undefined;
  rememberedEndpoint: string | null | undefined;
}): SyncEndpoint | null {
  const offer = clean(input.offerEndpoint);
  if (offer !== null) return { endpoint: offer, remembered: false };
  const remembered = clean(input.rememberedEndpoint);
  if (remembered !== null) return { endpoint: remembered, remembered: true };
  return null;
}
