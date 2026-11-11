/**
 * The desktop's pairing panel (Phase C Session 6, Q.1).
 *
 * Every value on this screen comes from `lib/sync/pairingPanel.ts`, which in
 * turn drives the real listener: the QR is only drawn while the port is bound
 * and the code is live, the endpoint is the one the listener reported, and the
 * code disappears the moment it expires (§11.1, §11.5). Closing the panel — or
 * the app locking, or going to the background — closes the socket; tonight's
 * cleanup call is the same `pairing_close` the shell's lock path uses.
 *
 * Trust is a human step (wave 1, N1). A rendezvous only *stages* a candidate:
 * this screen shows both fingerprints, waits until the phone's sealed hello has
 * proved it holds the key it presented, and writes the pin to `sync_peers`
 * only when the person presses Trust. Reject closes the window and writes
 * nothing — the six-digit code never grants trust on its own.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { pairingRepo } from "../data/app.ts";
import type { PairingIdentityStatus } from "../data/driver.ts";
import { errText } from "../lib/errors.ts";
import {
  identityRecovery,
  type PairingPanelState,
  type PinWrite,
  panelPhaseLabel,
  panelView,
  pendingConfirmation,
} from "../lib/sync/pairingPanel.ts";
import { QR_QUIET_ZONE, qrMatrix } from "../lib/sync/qr.ts";
import type { PeerRow } from "../lib/sync/store.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";

/** The QR's modules, drawn from the same matrix the round-trip test decodes. */
function QrCode({ payload }: { payload: string }) {
  const matrix = qrMatrix(payload);
  const side = matrix.size + QR_QUIET_ZONE * 2;
  const cells: { x: number; y: number }[] = [];
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (matrix.data[y * matrix.size + x] === 1) cells.push({ x, y });
    }
  }
  return (
    <svg
      className="pairing-qr"
      viewBox={`0 0 ${side} ${side}`}
      role="img"
      aria-label="Pairing QR code"
      shapeRendering="crispEdges"
    >
      {/* A QR is black on white by definition — modules are never a brand
          colour, and a tinted code is a scanner bug. */}
      <rect width={side} height={side} fill="white" />
      <g fill="black">
        {cells.map((cell) => (
          <rect
            key={`${cell.x}-${cell.y}`}
            x={cell.x + QR_QUIET_ZONE}
            y={cell.y + QR_QUIET_ZONE}
            width={1}
            height={1}
          />
        ))}
      </g>
    </svg>
  );
}

export function PairingPanel() {
  const [state, setState] = useState<PairingPanelState | null>(null);
  const [peers, setPeers] = useState<PeerRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pin, setPin] = useState<PinWrite | null>(null);
  const [identity, setIdentity] = useState<PairingIdentityStatus | null>(null);
  const startingRef = useRef(false);
  const stateRef = useRef<PairingPanelState | null>(null);
  stateRef.current = state;
  /**
   * True once the panel is gone, so an `open()` that was awaiting the listener
   * cannot leave a bound `0.0.0.0` port behind a screen nobody can see (N4).
   */
  const unmountedRef = useRef(false);

  // §11.5: closing the panel closes the port. `pairing_close` resolves only
  // once the socket refuses a connect, so unmounting here is the whole closed
  // window — the listener state and the socket agree by construction.
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      void pairingRepo.close().catch(() => {});
    };
  }, []);

  /** The identity's state, so a lost key is visible before anything is opened. */
  const refreshIdentity = useCallback(async () => {
    const status = await pairingRepo.identity().catch(() => null);
    if (status !== null) setIdentity(status);
  }, []);

  useEffect(() => {
    void refreshIdentity();
  }, [refreshIdentity]);

  const open = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    setBusy(true);
    setError(null);
    setPin(null);
    try {
      const opened = await pairingRepo.open();
      if (unmountedRef.current) {
        // The panel went away while the listener was binding. Nothing may be
        // set after unmount, and nothing may keep serving: close it now (N4).
        void pairingRepo.close().catch(() => {});
        return;
      }
      stateRef.current = opened;
      setState(opened);
      // A staged candidate is compared against the rows already pinned, so a
      // re-pair can say whose key it replaces (§11.4).
      setPeers(await pairingRepo.peers().catch(() => []));
    } catch (e) {
      if (unmountedRef.current) return;
      setError(errText(e));
      // A missing or unopenable pairing key is *why* opening failed; show the
      // recovery beside the error instead of leaving a dead end (N2).
      await refreshIdentity();
    } finally {
      startingRef.current = false;
      if (!unmountedRef.current) setBusy(false);
    }
  }, [refreshIdentity]);

  const close = useCallback(async () => {
    setBusy(true);
    try {
      await pairingRepo.close();
    } catch (e) {
      setError(errText(e));
    } finally {
      stateRef.current = null;
      setState(null);
      setPin(null);
      setBusy(false);
    }
  }, []);

  const pairingId = state?.offer.pairingId ?? null;

  // One tick a second: a dead code closes the socket before the code leaves the
  // screen, and a live one reports whatever the listener has learned. The tick
  // NEVER writes a pin — the pin is the person's decision, not the clock's
  // (§11.1, wave 1 N1).
  useEffect(() => {
    if (pairingId === null) return;
    let cancelled = false;
    const tick = async () => {
      const current = stateRef.current;
      if (current === null) return;
      const next = await pairingRepo
        .settle(current, Date.now())
        .catch(() => null);
      if (cancelled || next === null) return;
      stateRef.current = next;
      setState(next);
    };
    void tick();
    const timer = setInterval(() => void tick(), 1_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pairingId]);

  /**
   * The one place a replacement identity is minted (§11.4, N2). It is reached
   * only through the two-step `ConfirmButton` below, which is the person's
   * explicit confirmation — there is no one-click path and no retry after an
   * error that leaves the button armed.
   */
  const replaceIdentity = useCallback(async () => {
    setError(null);
    try {
      setIdentity(await pairingRepo.replaceIdentity(true));
      // The pins on this device still name the old key; every phone re-pairs,
      // so the rows are read again rather than assumed unchanged.
      setPeers(await pairingRepo.peers().catch(() => []));
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  const trust = useCallback(async () => {
    const current = stateRef.current;
    if (current === null) return;
    setBusy(true);
    setError(null);
    try {
      const write = await pairingRepo.pin(current);
      if (write !== null) setPin(write);
      const refreshed = await pairingRepo.peers().catch(() => null);
      if (refreshed !== null) setPeers(refreshed);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const view = state === null ? null : panelView(state);
  const pending = state === null ? null : pendingConfirmation(state, peers);
  const recovery = identityRecovery(identity);

  return (
    <div className="pairing-panel">
      <p className="muted">
        Pairing listens on your local network only while this panel is open. The
        port closes on expiry, on lock, and when Purple Memo goes to the
        background.
      </p>
      {error !== null ? (
        <p className="pairing-error" role="alert">
          {error}
        </p>
      ) : null}

      {/* Nothing is drawn while the status is unknown, and a key that works
          is never offered for replacement — only a key that is gone or can
          no longer be opened (§11.2, N2). */}
      {recovery.needed ? (
        <section aria-label="Replace this device's pairing key">
          <p>
            <strong>This device's pairing key is gone or unreadable.</strong>
          </p>
          {recovery.note !== null ? (
            <p className="pairing-error" role="alert">
              {recovery.note}
            </p>
          ) : null}
          <p className="muted">
            Replacing it mints a new pairing key. Your notes, tasks and photos
            stay on this device; every paired phone has to pair again, with its
            fingerprints compared as before.
          </p>
          <div className="pairing-actions">
            <ConfirmButton
              what="this device's pairing key"
              className="btn btn-danger"
              disabled={busy}
              onConfirm={replaceIdentity}
            >
              Replace this device's pairing key
            </ConfirmButton>
          </div>
        </section>
      ) : null}
      {recovery.rePairRequired && !recovery.needed ? (
        <p className="muted" role="status">
          Pairing again is required: a phone that paired before must pair again
          with a fresh code on this desktop.
        </p>
      ) : null}

      {state === null || view === null ? (
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void open()}
        >
          {busy ? "Opening…" : "Show a pairing code"}
        </button>
      ) : (
        <>
          <div className="pairing-panel-body">
            {/* No QR without a live code and a bound port (§11.5). */}
            {view.payload !== null ? <QrCode payload={view.payload} /> : null}
            <dl className="pairing-facts">
              <div>
                <dt>Pairing code</dt>
                <dd className="pairing-code">
                  {/* The phase's own word, never a hardcoded "expired": a
                      locked, used or unreachable code says what it is (N3). */}
                  {view.code ?? panelPhaseLabel(view.phase)}
                </dd>
              </div>
              <div>
                <dt>Code lifetime</dt>
                <dd>
                  {view.phase === "active"
                    ? `${view.remainingSeconds} s left`
                    : (view.reason ?? "closed")}
                </dd>
              </div>
              <div>
                <dt>Listening on</dt>
                <dd>
                  {view.listenerRunning
                    ? (view.endpoint ?? "a local port")
                    : "closed"}
                </dd>
              </div>
              {pin !== null ? (
                <div>
                  <dt>Paired phone</dt>
                  <dd className="pairing-fingerprint">
                    {pin.peer.fingerprint ?? pin.peer.deviceId}
                    {pin.repinned ? " (re-paired)" : ""}
                  </dd>
                </div>
              ) : null}
            </dl>
          </div>

          {/* Nothing is pinned until this block is confirmed (§11.1, N1). */}
          {pending !== null && pin === null ? (
            <section aria-label="Confirm this phone">
              <p>
                <strong>Confirm this phone</strong>
              </p>
              <dl className="pairing-facts">
                <div>
                  <dt>This desktop's fingerprint</dt>
                  <dd className="pairing-fingerprint">
                    {pending.localFingerprint}
                  </dd>
                </div>
                <div>
                  <dt>The phone's fingerprint</dt>
                  <dd className="pairing-fingerprint">
                    {pending.peer.fingerprint ?? pending.peer.deviceId}
                  </dd>
                </div>
                {pending.existing !== null ? (
                  <div>
                    <dt>Already paired</dt>
                    <dd>
                      Re-pairing existing phone{" "}
                      {pending.existing.displayName ||
                        pending.existing.deviceId}{" "}
                      — this replaces its pinned key
                      {pending.existing.fingerprint !== null
                        ? ` (currently ${pending.existing.fingerprint})`
                        : ""}
                      .
                    </dd>
                  </div>
                ) : null}
              </dl>
              {pending.helloReceived ? null : (
                <p className="muted" role="status">
                  Waiting for the phone's hello — key possession not yet proven.
                </p>
              )}
              <div className="pairing-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || !pending.helloReceived}
                  onClick={() => void trust()}
                >
                  Trust matching fingerprint
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void close()}
                >
                  Reject
                </button>
              </div>
            </section>
          ) : null}

          <p className="muted">
            Compare these fingerprints with the ones on the phone before you
            trust the pairing. Nothing is paired until you press Trust; a wrong
            code costs one of five attempts, and the code dies after two
            minutes.
          </p>
          {view.phase !== "active" && view.reason !== null ? (
            <p className="pairing-error" role="alert">
              {view.reason}
            </p>
          ) : null}
          {pending === null || pin !== null ? (
            <div className="pairing-actions">
              {/* No live code: the honest action is a fresh one, not a
                  "Stop pairing" button beside a code that cannot pair (N3). */}
              {view.freshCode ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void open()}
                >
                  Show a fresh code
                </button>
              ) : null}
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void close()}
              >
                Stop pairing
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
