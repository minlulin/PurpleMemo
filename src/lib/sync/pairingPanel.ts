/**
 * The desktop's pairing panel — protocol §11.1, §11.2 and §11.5 (Phase C
 * Session 6, Q.1).
 *
 * The panel is a *state*, not a promise in a comment. Everything it shows comes
 * from a value produced here:
 *
 * - the offer is minted by `pairing.ts` (120 s, single-use, 5 attempts) and its
 *   code is what the listener actually gates on — the panel does not draw a
 *   code nobody checks;
 * - the QR is rendered only while the listener is running and the code is
 *   live, and its `host:port` is the endpoint the listener really bound;
 * - expiry, use and lockout close the socket (`settlePairingPanel`) before the
 *   code disappears from the screen, so "no code after it expires" and "no port
 *   after the code dies" are one step, not two;
 * - a peer the listener's code-confirmed rendezvous pinned is written to
 *   `sync_peers` with the store's own statements, so the pin is a row (§11.2)
 *   and a re-pair is a re-pair (§11.4), never a silent overwrite.
 *
 * No socket and no SQL live here: the panel drives the `PairingTransport` the
 * composition root binds to the one driver, which is what lets the suite run
 * the whole flow against a mock and the pin against real SQLite.
 */
import type {
  BatchStatement,
  DataDriver,
  PairingDriver,
  PairingListenerInfo,
  PairingLocalInfo,
  PairingOpenInput,
} from "../../data/driver.ts";
import {
  createPairingSession,
  encodeOffer,
  keyFingerprint,
  type PairingOffer,
  type PairingSession,
  type PairingSessionState,
  pairingState,
  pairingStateMessage,
  pinStatements,
  rePairStatements,
} from "./pairing.ts";
import { type PeerRow, readPeers } from "./store.ts";

/** The driver surface the panel uses — one method per real IPC command. */
export interface PairingTransport {
  pairingLocal(): Promise<PairingLocalInfo>;
  pairingOpen(input: PairingOpenInput): Promise<PairingListenerInfo>;
  pairingClose(): Promise<PairingListenerInfo>;
  pairingStatus(): Promise<PairingListenerInfo>;
  batch(statements: BatchStatement[]): Promise<void>;
  peers(): Promise<PeerRow[]>;
}

export interface PairingPanelState {
  /** This device's facts as the listener reported them — never re-derived. */
  local: PairingLocalInfo;
  session: PairingSession;
  /** The offer with the endpoint the live listener bound (§11.1). */
  offer: PairingOffer;
  listener: PairingListenerInfo;
}

export type PanelPhase = PairingSessionState;

/**
 * Mint the offer and open the window. The listener comes up *before* any QR is
 * shown: a rendered code whose port nobody serves would advertise a pairing
 * that does not exist.
 */
export async function openPairingPanel(
  transport: PairingTransport,
  now: number = Date.now(),
): Promise<PairingPanelState> {
  const local = await transport.pairingLocal();
  const session = createPairingSession({
    deviceId: local.deviceId,
    // The real endpoint only exists once the listener binds; the offer is
    // completed from the listener's report below, before it is ever rendered.
    endpoint: "",
    publicKey: local.publicKey,
    generation: local.generation,
    schemaVersion: local.schemaVersion,
    protocolVersion: local.protocolVersion,
    now,
  });
  const listener = await transport.pairingOpen({
    pairingId: session.offer.pairingId,
    offerCode: session.offer.code,
    offerExpiresAt: session.offer.expiresAt,
    peer: null,
    lastCounter: 0,
  });
  if (!listener.running) {
    throw new Error(
      listener.note ?? "the pairing listener did not start; no code is shown.",
    );
  }
  return {
    local,
    session,
    listener,
    offer: { ...session.offer, endpoint: listener.endpoint ?? "" },
  };
}

/** The exact QR payload (§11.1). */
export function offerPayload(state: PairingPanelState): string {
  return encodeOffer(state.offer);
}

export function panelPhase(
  state: PairingPanelState,
  now: number = Date.now(),
): PanelPhase {
  return pairingState(state.session, now);
}

export function remainingSeconds(
  state: PairingPanelState,
  now: number = Date.now(),
): number {
  return Math.max(0, Math.ceil((state.offer.expiresAt - now) / 1000));
}

export interface PairingPanelView {
  phase: PanelPhase;
  /** `null` once the code is no longer live — no expired code is ever shown. */
  code: string | null;
  /** `null` with the code: the QR is only drawn for a live code. */
  payload: string | null;
  remainingSeconds: number;
  /** The named reason the state gives, in `pairing.ts`'s own words. */
  reason: string | null;
  endpoint: string | null;
  fingerprint: string;
  peerFingerprint: string | null;
  listenerRunning: boolean;
}

/** What the panel may draw, for one instant. */
export function panelView(
  state: PairingPanelState,
  now: number = Date.now(),
): PairingPanelView {
  const phase = panelPhase(state, now);
  const live = phase === "active" && state.listener.running;
  return {
    phase,
    code: live ? state.offer.code : null,
    payload: live ? offerPayload(state) : null,
    remainingSeconds: remainingSeconds(state, now),
    reason: pairingStateMessage(phase),
    endpoint: state.listener.endpoint,
    fingerprint: state.local.fingerprint,
    peerFingerprint: state.listener.peerFingerprint,
    listenerRunning: state.listener.running,
  };
}

/**
 * What the panel needs before it may offer Trust (§11.1, wave 1 N1). `null`
 * whenever no candidate is staged: then there is nothing to confirm and
 * nothing to pin — the panel never trusts on its own.
 */
export interface PendingConfirmation {
  /** The candidate the rendezvous staged, as the listener reports it. */
  peer: { deviceId: string; publicKey: string; fingerprint: string | null };
  /** This desktop's fingerprint — both screens show both (§11.1). */
  localFingerprint: string;
  /** A sealed hello from the candidate has been opened: key possession. */
  helloReceived: boolean;
  /** The row Trust would replace, when this `deviceId` already paired (§11.4). */
  existing: {
    deviceId: string;
    displayName: string;
    fingerprint: string | null;
  } | null;
}

/**
 * The confirmation the panel shows for a staged candidate. A `deviceId` that
 * already has a row is a re-pair, and says so: the existing phone's name and
 * pinned fingerprint sit next to the presented one, because Trust replaces
 * them (§11.4).
 */
export function pendingConfirmation(
  state: PairingPanelState,
  peers: readonly PeerRow[] = [],
): PendingConfirmation | null {
  const { peerDeviceId, peerPublicKey, peerFingerprint, peerHelloReceived } =
    state.listener;
  if (peerDeviceId === null || peerPublicKey === null) return null;
  const existing = peers.find((row) => row.device_id === peerDeviceId);
  return {
    peer: {
      deviceId: peerDeviceId,
      publicKey: peerPublicKey,
      fingerprint: peerFingerprint,
    },
    localFingerprint: state.local.fingerprint,
    helloReceived: peerHelloReceived,
    existing:
      existing === undefined
        ? null
        : {
            deviceId: existing.device_id,
            displayName: existing.display_name,
            fingerprint:
              existing.public_key === null
                ? null
                : keyFingerprint(existing.public_key),
          },
  };
}

/**
 * One poll of the window: a dead code closes the socket, and a live one reports
 * whatever the listener has learned. The listener's own close is proven by the
 * Rust suite (a connect is refused); here the state value and the socket are
 * kept in step. A tick never pins: the pin is the person's decision.
 */
export async function settlePairingPanel(
  transport: PairingTransport,
  state: PairingPanelState,
  now: number = Date.now(),
): Promise<PairingPanelState> {
  const current = await transport.pairingStatus();
  if (pairingState(state.session, now) !== "active" && current.running) {
    return { ...state, listener: await transport.pairingClose() };
  }
  return { ...state, listener: current };
}

/** Close the window for any reason — panel close, lock, app background. */
export function closePairingPanel(
  transport: PairingTransport,
): Promise<PairingListenerInfo> {
  return transport.pairingClose();
}

export interface PinWrite {
  peer: {
    deviceId: string;
    publicKey: string;
    fingerprint: string | null;
  };
  /** True when the peer had paired before and this is a §11.4 re-pair. */
  repinned: boolean;
}

/**
 * The Trust action: store the pin the window's code staged (§11.2). Returns
 * `null` while nobody has been staged.
 *
 * This is the only pairing write to `sync_peers`, and it runs only when the
 * person presses Trust — never from a poll tick (§11.1, wave 1 N1). It throws
 * while the candidate has not proved key possession with a sealed hello: until
 * then the key is only something a stranger presented, and the six-digit code
 * must never be the thing that grants trust.
 *
 * A peer that already has a row is re-paired through `rePairStatements` — new
 * pairing id, both cursors zeroed, old acks dropped (§11.4) — instead of a
 * silent update that would leave cursors pointing at another pairing's history.
 */
export async function pinAdmittedPeer(
  transport: PairingTransport,
  state: PairingPanelState,
): Promise<PinWrite | null> {
  const listener = await transport.pairingStatus();
  const deviceId = listener.peerDeviceId;
  const publicKey = listener.peerPublicKey;
  if (deviceId === null || publicKey === null) return null;
  if (!listener.peerHelloReceived) {
    throw new Error(
      "waiting for the phone's hello — key possession is not proven yet, so nothing is pinned.",
    );
  }
  const existing = (await transport.peers()).find(
    (row) => row.device_id === deviceId,
  );
  const peer = { deviceId, publicKey, generation: state.local.generation };
  const statements = existing
    ? rePairStatements({ ...peer, pairingId: state.offer.pairingId })
    : pinStatements({ ...peer, pairingId: state.offer.pairingId });
  await transport.batch(statements);
  return {
    peer: { deviceId, publicKey, fingerprint: listener.peerFingerprint },
    repinned: existing !== undefined,
  };
}

/** Bind the panel to the one production driver (`data/app.ts`). */
export function createPairingRepo(driver: DataDriver & PairingDriver) {
  const transport: PairingTransport = {
    pairingLocal: () => driver.pairingLocal(),
    pairingOpen: (input) => driver.pairingOpen(input),
    pairingClose: () => driver.pairingClose(),
    pairingStatus: () => driver.pairingStatus(),
    batch: (statements) => driver.batch(statements),
    peers: () => readPeers(driver),
  };
  return {
    open: (now?: number) => openPairingPanel(transport, now),
    close: () => closePairingPanel(transport),
    settle: (state: PairingPanelState, now?: number) =>
      settlePairingPanel(transport, state, now),
    pin: (state: PairingPanelState) => pinAdmittedPeer(transport, state),
    local: () => driver.pairingLocal(),
    status: () => driver.pairingStatus(),
    peers: () => readPeers(driver),
  };
}
