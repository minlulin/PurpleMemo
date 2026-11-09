/**
 * The desktop's pairing panel (Phase C Session 6, Q.1).
 *
 * Every value on this screen comes from `lib/sync/pairingPanel.ts`, which in
 * turn drives the real listener: the QR is only drawn while the port is bound
 * and the code is live, the endpoint is the one the listener reported, and the
 * code disappears the moment it expires (§11.1, §11.5). Closing the panel — or
 * the app locking, or going to the background — closes the socket; tonight's
 * cleanup call is the same `pairing_close` the shell's lock path uses.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { pairingRepo } from "../data/app.ts";
import { errText } from "../lib/errors.ts";
import {
  type PairingPanelState,
  type PinWrite,
  panelView,
} from "../lib/sync/pairingPanel.ts";
import { QR_QUIET_ZONE, qrMatrix } from "../lib/sync/qr.ts";

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pin, setPin] = useState<PinWrite | null>(null);
  const startingRef = useRef(false);
  const stateRef = useRef<PairingPanelState | null>(null);
  const pinRef = useRef<PinWrite | null>(null);
  stateRef.current = state;

  // §11.5: closing the panel closes the port. `pairing_close` resolves only
  // once the socket refuses a connect, so unmounting here is the whole closed
  // window — the listener state and the socket agree by construction.
  useEffect(
    () => () => {
      void pairingRepo.close().catch(() => {});
    },
    [],
  );

  const open = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    setBusy(true);
    setError(null);
    setPin(null);
    pinRef.current = null;
    try {
      const opened = await pairingRepo.open();
      stateRef.current = opened;
      setState(opened);
    } catch (e) {
      setError(errText(e));
    } finally {
      startingRef.current = false;
      setBusy(false);
    }
  }, []);

  const close = useCallback(async () => {
    setBusy(true);
    try {
      await pairingRepo.close();
    } catch (e) {
      setError(errText(e));
    } finally {
      stateRef.current = null;
      setState(null);
      pinRef.current = null;
      setPin(null);
      setBusy(false);
    }
  }, []);

  const pairingId = state?.offer.pairingId ?? null;

  // One tick a second: a dead code closes the socket before the code leaves the
  // screen, a live one picks up the peer its code just pinned, and the pin is
  // written once as a `sync_peers` row (§11.2).
  useEffect(() => {
    if (pairingId === null) return;
    let cancelled = false;
    const tick = async () => {
      const current = stateRef.current;
      if (current === null) return;
      const now = Date.now();
      const next = await pairingRepo.settle(current, now).catch(() => null);
      if (cancelled || next === null) return;
      stateRef.current = next;
      setState(next);
      if (pinRef.current === null && next.listener.peerPublicKey !== null) {
        const write = await pairingRepo.pin(next).catch(() => null);
        if (!cancelled && write !== null) {
          pinRef.current = write;
          setPin(write);
        }
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 1_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pairingId]);

  const view = state === null ? null : panelView(state);

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
                <dd className="pairing-code">{view.code ?? "expired"}</dd>
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
                <dt>This desktop's key</dt>
                <dd className="pairing-fingerprint">{view.fingerprint}</dd>
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
          <p className="muted">
            Compare that fingerprint with the one on the phone before you trust
            the pairing. A phone that has never paired sends its key once this
            code is accepted; a wrong code costs one of five attempts, and the
            code dies after two minutes.
          </p>
          {view.phase !== "active" && view.reason !== null ? (
            <p className="pairing-error" role="alert">
              {view.reason}
            </p>
          ) : null}
          <div className="pairing-actions">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void close()}
            >
              Stop pairing
            </button>
          </div>
        </>
      )}
    </div>
  );
}
