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
 *   after the code dies" are one step, not two — and the attempts, redemption
 *   and port state come from the listener, which is the only place that knows
 *   them (N3);
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
  PairingIdentityStatus,
  PairingListenerInfo,
  PairingLocalInfo,
  PairingOpenInput,
  UploadOutcomeInput,
  UploadTakeResult,
} from "../../data/driver.ts";
import { readUploadOps } from "./mobilePairing.ts";
import {
  createPairingSession,
  encodeOffer,
  keyFingerprint,
  PAIRING_MAX_ATTEMPTS,
  type PairingOffer,
  type PairingSession,
  type PairingSessionState,
  pairingState,
  pairingStateMessage,
  pinStatements,
  rePairStatements,
} from "./pairing.ts";
import type { SyncTable } from "./protocol.ts";
import {
  assertSyncTable,
  type PeerRow,
  readPeers,
  uploadStatements,
} from "./store.ts";

/** The driver surface the panel uses — one method per real IPC command. */
export interface PairingTransport {
  pairingLocal(): Promise<PairingLocalInfo>;
  pairingOpen(input: PairingOpenInput): Promise<PairingListenerInfo>;
  pairingClose(): Promise<PairingListenerInfo>;
  pairingStatus(): Promise<PairingListenerInfo>;
  batch(statements: BatchStatement[]): Promise<void>;
  peers(): Promise<PeerRow[]>;
  /** Take the staged §9.1 upload for the apply; `null` when none is ready. */
  pairingUploadTake(): Promise<UploadTakeResult | null>;
  /** Report the apply's verdict, for the listener to seal to the phone. */
  pairingUploadOutcome(input: UploadOutcomeInput): Promise<void>;
  /**
   * Of `uids` in `table`, the ones this device already holds — the §9.1
   * classification the apply counts by. The table is an allowlisted name
   * from a validated op, never free text.
   */
  existingUids(table: SyncTable, uids: readonly string[]): Promise<string[]>;
}

export interface PairingPanelState {
  /** This device's facts as the listener reported them — never re-derived. */
  local: PairingLocalInfo;
  session: PairingSession;
  /** The offer with the endpoint the live listener bound (§11.1). */
  offer: PairingOffer;
  listener: PairingListenerInfo;
}

/**
 * What the panel may say about the code. `closed` is the state `pairing.ts`
 * does not have: the session is still live, but the listener has stopped, so
 * there is nothing reachable to show (N3).
 */
export type PanelPhase = PairingSessionState | "closed";

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
  const endpoint = listener.endpoint;
  if (endpoint === null || endpoint === "") {
    // A code with no address is a QR nobody can dial (N7). Close the window
    // rather than draw a dead code: leaving it bound would serve a port whose
    // code is not on screen.
    await transport.pairingClose().catch(() => undefined);
    throw new Error(
      "this desktop has no local network address to pair on — connect it to the same network as the phone, then show a fresh code.",
    );
  }
  return {
    local,
    session,
    listener,
    offer: { ...session.offer, endpoint },
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
  // While the listener is up it is the authority: its wrong-guess count and its
  // redemption decide the phase, not a local session Rust never updates (N3).
  // A stopped listener reports zeros, so the session settle recorded is kept.
  const session = state.listener.running
    ? projectSession(state.session, state.listener, now)
    : state.session;
  const phase = pairingState(session, now);
  // The listener closing while the code is still live is its own state (N3):
  // the digits are not expired, they are unreachable — saying "expired" over
  // "95 s left" was the contradiction this state removes.
  if (phase === "active" && !state.listener.running) return "closed";
  return phase;
}

/** The one word the code cell shows when there is no live code to show. */
export function panelPhaseLabel(phase: PanelPhase): string {
  switch (phase) {
    case "active":
      return "";
    case "expired":
      return "expired";
    case "used":
      return "used";
    case "locked":
      return "locked";
    case "closed":
      return "closed";
  }
}

/**
 * The reason a phase shows. `closed` is the panel's own state; the rest are
 * `pairing.ts`'s words, so a refusal never grows a second wording here.
 */
export function panelPhaseMessage(phase: PanelPhase): string | null {
  if (phase === "closed") {
    return "the pairing listener closed — show a fresh code on the desktop.";
  }
  return pairingStateMessage(phase);
}

export function remainingSeconds(
  state: PairingPanelState,
  now: number = Date.now(),
): number {
  return Math.max(0, Math.ceil((state.offer.expiresAt - now) / 1000));
}

/** What the panel may say about the §9.1 upload in this window. */
export interface PanelUploadView {
  state: string;
  ops: number;
  inserted: number | null;
  alreadyKnown: number | null;
  note: string | null;
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
  /** True when no code is live: the panel offers a fresh one instead (N3). */
  freshCode: boolean;
  /** The upload's state, once the phone sends one (§9.1). */
  upload: PanelUploadView | null;
}

/** What the panel may draw, for one instant. */
export function panelView(
  state: PairingPanelState,
  now: number = Date.now(),
): PairingPanelView {
  const phase = panelPhase(state, now);
  const live = phase === "active";
  return {
    phase,
    code: live ? state.offer.code : null,
    payload: live ? offerPayload(state) : null,
    remainingSeconds: remainingSeconds(state, now),
    reason: panelPhaseMessage(phase),
    endpoint: state.listener.endpoint,
    fingerprint: state.local.fingerprint,
    peerFingerprint: state.listener.peerFingerprint,
    listenerRunning: state.listener.running,
    freshCode: !live,
    upload:
      state.listener.uploadState === null
        ? null
        : {
            state: state.listener.uploadState,
            ops: state.listener.uploadOps,
            inserted: state.listener.uploadInserted,
            alreadyKnown: state.listener.uploadAlreadyKnown,
            note: state.listener.uploadNote,
          },
  };
}

/**
 * What the panel shows about this device's pairing identity (wave 1, N2).
 *
 * `needed` is deliberately narrower than `rePairRequired`: a key that is
 * present and readable is never replaced, even when a restore or a previous
 * replacement means every phone must pair again. Only a key that is gone or
 * can never be opened again asks for the confirmed replacement — the one path
 * that mints a new identity (§11.2, §11.4).
 */
export interface PairingIdentityRecovery {
  /** The key itself is unusable: offer the confirmed replacement. */
  needed: boolean;
  /** Why, in the backend's words — the same text the command returns. */
  note: string | null;
  /** Pairing again is required, whether or not the key was replaced. */
  rePairRequired: boolean;
  /** This device's key fingerprint, when it has a usable key. */
  fingerprint: string | null;
}

export function identityRecovery(
  status: PairingIdentityStatus | null,
): PairingIdentityRecovery {
  if (status === null) {
    // Unknown is not lost: a status the backend could not report must not
    // invite a key replacement.
    return {
      needed: false,
      note: null,
      rePairRequired: false,
      fingerprint: null,
    };
  }
  return {
    needed: status.lost || !status.present,
    note: status.note,
    rePairRequired: status.needsRePair,
    fingerprint: status.fingerprint,
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
/**
 * The session the listener's own report implies (N3). Rust owns the code's live
 * state — it counts the wrong guesses and performs the single redemption — so
 * those two facts are projected into the session before `pairingState` reads
 * it. A local counter would have kept a locked-out code on screen forever.
 */
export function projectSession(
  session: PairingSession,
  listener: PairingListenerInfo,
  now: number = Date.now(),
): PairingSession {
  const attempts = Math.max(
    0,
    Math.min(PAIRING_MAX_ATTEMPTS, Math.trunc(listener.offerAttempts)),
  );
  return {
    ...session,
    failedAttempts: Array.from({ length: attempts }, () => now),
    // The listener is authoritative in both directions: a window whose code was
    // never redeemed has no `usedAt`, whatever this session once believed.
    usedAt: listener.offerRedeemed ? (session.usedAt ?? now) : session.usedAt,
  };
}

function uploadErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What one staged-upload apply did — a value, so the order can be tested. */
export interface UploadApplyOutcome {
  /** Records taken from the staging (0 when nothing was staged). */
  staged: number;
  /** Of them, inserted as new records. */
  inserted: number;
  /** Of them, already held here — §7.2 no-ops, counted, never rewritten. */
  alreadyKnown: number;
  /** The failure's reason, when the apply did not commit. */
  error: string | null;
}

/**
 * Apply the phone's staged upload (§9.1) — this panel's one writing duty
 * besides the pin.
 *
 * The order is the clause:
 *
 * 1. the staging is TAKEN first, so no second tick can start a second apply
 *    of the same records;
 * 2. every op is validated (§3.4) before a statement exists — a bad payload
 *    applies nothing and is reported by name;
 * 3. the ops whose uid this device already holds are classified
 *    `alreadyKnown` and never rewritten (§7.2: a repeated upload is a no-op,
 *    not an overwrite — the desktop's own row keeps its value and stamp);
 * 4. the rest are written in ONE `batch` — one transaction, parents first —
 *    with the stamps the phone sent;
 * 5. the outcome is reported either way, because the phone's verdict is this
 *    report: counts on success, the failure's own words on failure. An
 *    apply that threw is never reported as one that succeeded.
 *
 * The existence check and the insert are two steps, so a record the person
 * creates on this desktop in between can turn the insert into a refusal —
 * which rolls the whole upload back and is reported, never silently merged.
 * Returns `null` when nothing was staged.
 */
export async function applyStagedUpload(
  transport: PairingTransport,
): Promise<UploadApplyOutcome | null> {
  const taken = await transport.pairingUploadTake();
  if (taken === null) return null;
  try {
    const read = readUploadOps(taken.ops);
    if (!read.ok) throw new Error(read.reason);
    const byTable = new Map<SyncTable, string[]>();
    for (const op of read.ops) {
      const uids = byTable.get(op.table) ?? [];
      uids.push(op.uid);
      byTable.set(op.table, uids);
    }
    const known = new Set<string>();
    for (const [table, uids] of byTable) {
      const existing = await transport.existingUids(table, uids);
      for (const uid of existing) known.add(`${table}\u0000${uid}`);
    }
    const fresh = read.ops.filter(
      (op) => !known.has(`${op.table}\u0000${op.uid}`),
    );
    if (fresh.length > 0) {
      await transport.batch(uploadStatements(fresh));
    }
    const outcome: UploadApplyOutcome = {
      staged: read.ops.length,
      inserted: fresh.length,
      alreadyKnown: read.ops.length - fresh.length,
      error: null,
    };
    await transport.pairingUploadOutcome({
      inserted: outcome.inserted,
      alreadyKnown: outcome.alreadyKnown,
      error: null,
    });
    return outcome;
  } catch (error) {
    const message = uploadErrorText(error);
    await transport
      .pairingUploadOutcome({
        inserted: null,
        alreadyKnown: null,
        error: message,
      })
      .catch(() => undefined);
    return {
      staged: taken.ops.length,
      inserted: 0,
      alreadyKnown: 0,
      error: message,
    };
  }
}

export async function settlePairingPanel(
  transport: PairingTransport,
  state: PairingPanelState,
  now: number = Date.now(),
): Promise<PairingPanelState> {
  let current = await transport.pairingStatus();
  // §9.1: a committed upload is this panel's to apply, and the phone polls
  // for the verdict — so the apply runs on the tick that first sees the
  // staging complete, and the state this settle returns is read again after
  // it, carrying the terminal upload state the person should see.
  if (current.uploadState === "staged") {
    await applyStagedUpload(transport).catch(() => undefined);
    current = await transport.pairingStatus().catch(() => current);
  }
  // The listener's code state comes first: a lockout on the wire or a phone's
  // redemption must close the socket on this tick, not when the 120 s timer
  // happens to run out — and the panel must learn it on the same tick (N3).
  const session = projectSession(state.session, current, now);
  const next = { ...state, session, listener: current };
  const phase = pairingState(session, now);
  // §8.4: the phone can only dial the endpoint this window bound, and the
  // sealed hello, the person's Trust and the snapshot pull all need that same
  // port. A redeemed code therefore keeps the window open while a phone is
  // staged behind it — the code is spent, the channel is not. Its own lifetime
  // still ends it: an expired window closes even mid-pull, a locked one closes,
  // and so does a used one that staged nothing.
  const servingThePhone =
    phase === "used" &&
    current.peerDeviceId !== null &&
    now < session.offer.expiresAt;
  if (phase !== "active" && !servingThePhone && current.running) {
    return { ...next, listener: await transport.pairingClose() };
  }
  return next;
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
    ? // §11.4: a re-pair is a new pairing, not a new phone — the name the
      // person gave it is carried over, so re-pairing never erases a label.
      rePairStatements({
        ...peer,
        pairingId: state.offer.pairingId,
        displayName: existing.display_name,
      })
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
    pairingUploadTake: () => driver.pairingUploadTake(),
    pairingUploadOutcome: (input) => driver.pairingUploadOutcome(input),
    existingUids: async (table, uids) => {
      // The table is an allowlisted name from a validated op (§3.4 ran
      // first); the uids are bound parameters, chunked under SQLite's limit.
      assertSyncTable(table);
      const found: string[] = [];
      for (let at = 0; at < uids.length; at += 500) {
        const chunk = uids.slice(at, at + 500);
        const placeholders = chunk.map(() => "?").join(", ");
        const rows = await driver.query<{ uid: string }>(
          `SELECT uid FROM "${table}" WHERE uid IN (${placeholders})`,
          [...chunk],
        );
        for (const row of rows) found.push(row.uid);
      }
      return found;
    },
  };
  return {
    open: (now?: number) => openPairingPanel(transport, now),
    close: () => closePairingPanel(transport),
    settle: (state: PairingPanelState, now?: number) =>
      settlePairingPanel(transport, state, now),
    applyUpload: () => applyStagedUpload(transport),
    pin: (state: PairingPanelState) => pinAdmittedPeer(transport, state),
    local: () => driver.pairingLocal(),
    status: () => driver.pairingStatus(),
    peers: () => readPeers(driver),
    identity: () => driver.pairingIdentityStatus(),
    replaceIdentity: (confirm: boolean) =>
      driver.pairingIdentityReplace(confirm),
  };
}
