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
import { ensurePairedPhoneReachableNow, pairingRepo } from "../data/app.ts";
import type { PairingIdentityStatus } from "../data/driver.ts";
import { errText } from "../lib/errors.ts";
import type { MessageKey } from "../lib/i18n.ts";
import {
  clockStillMatters,
  formatPairingCode,
  formatShortFp,
  identityRecovery,
  type PairingPanelState,
  type PanelPhase,
  type PinWrite,
  panelPhase,
  panelView,
  pendingConfirmation,
} from "../lib/sync/pairingPanel.ts";
import { QR_QUIET_ZONE, qrMatrix } from "../lib/sync/qr.ts";
import type { PeerRow } from "../lib/sync/store.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { useT } from "./useTranslation.ts";

/**
 * The panel's own words for a phase. The protocol's `panelPhaseLabel` and
 * `panelPhaseMessage` stay English for the protocol and its tests; this is
 * the screen's translation of exactly the same states.
 */
/**
 * Durable pairing at rest: after the offer window goes down, the resting
 * state is the pinned-only window — otherwise the remembered phone is
 * unreachable until the next unlock (§11.5). Only the pin-gated window is
 * re-opened here, never another offer.
 */
function closePaneToRestingState(): void {
  void pairingRepo
    .close()
    .catch(() => {})
    .then(() => ensurePairedPhoneReachableNow())
    .catch(() => {});
}

const PHASE_LABEL_KEYS: Record<Exclude<PanelPhase, "active">, MessageKey> = {
  expired: "pairing.phase.expired",
  used: "pairing.phase.used",
  locked: "pairing.phase.locked",
  closed: "pairing.phase.closed",
};

const PHASE_MESSAGE_KEYS: Record<Exclude<PanelPhase, "active">, MessageKey> = {
  expired: "pairing.reason.expired",
  used: "pairing.reason.used",
  locked: "pairing.reason.locked",
  closed: "pairing.reason.closed",
};

/** The QR's modules, drawn from the same matrix the round-trip test decodes. */
function QrCode({ payload }: { payload: string }) {
  const t = useT();
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
      aria-label={t("pairing.qrAria")}
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
  const t = useT();
  const [state, setState] = useState<PairingPanelState | null>(null);
  const [peers, setPeers] = useState<PeerRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pin, setPin] = useState<PinWrite | null>(null);
  const [identity, setIdentity] = useState<PairingIdentityStatus | null>(null);
  // §11.1: the offer is a string a person can carry to a phone with no camera.
  const [copied, setCopied] = useState(false);
  // Technical rows and the pastable offer are disclosure, not the main job.
  const [showOffer, setShowOffer] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  /**
   * §11.4: this desktop's own operations the staged phone has not received.
   * Read before Trust is offered, because a re-pair would strand them.
   */
  const [pendingChanges, setPendingChanges] = useState<number | null>(null);
  const [discardNote, setDiscardNote] = useState<string | null>(null);
  const offerTextRef = useRef<HTMLElement | null>(null);
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
      // The offer window is closed before anything else (N4); the resting
      // state behind it is the pinned-only window (durable pairing).
      closePaneToRestingState();
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
        // set after unmount, and the offer window must not keep serving a code
        // nobody can see (N4); the resting state behind it is the durable
        // pinned-only window.
        closePaneToRestingState();
        return;
      }
      stateRef.current = opened;
      setState(opened);
      setShowOffer(false);
      setShowDetails(false);
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
      // The user closed the pairing panel — the resting state behind it is
      // the durable pinned-only window, so the remembered phone stays
      // reachable while the app runs (toggle permitting).
      void ensurePairedPhoneReachableNow().catch(() => undefined);
    } catch (e) {
      setError(errText(e));
    } finally {
      stateRef.current = null;
      setState(null);
      setPin(null);
      setShowOffer(false);
      setShowDetails(false);
      setBusy(false);
    }
  }, []);

  const pairingId = state?.offer.pairingId ?? null;

  /**
   * Copy the offer, or — when the clipboard is refused — select it, so the
   * person can copy it by hand instead of being told "copied" over an empty
   * clipboard. The string is the same one the QR carries, not a second kind of
   * pairing: `parseOffer` validates it exactly as it validates a scan.
   */
  const copyOffer = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      const node = offerTextRef.current;
      if (node !== null) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setCopied(false);
    }
    window.setTimeout(() => setCopied(false), 2_000);
  }, []);

  // One tick a second: a dead code closes the socket before the code leaves the
  // screen, and a live one reports whatever the listener has learned. The tick
  // NEVER writes a pin — the pin is the person's decision, not the clock's
  // (§11.1, wave 1 N1).
  //
  // D5: self-scheduled rather than a fixed interval, so the settle that kills
  // the code is also the one that stops the polling — a fixed interval kept
  // issuing `pairing_status` (and taking the Rust listener lock) every second
  // for as long as Settings stayed open. Self-scheduling also serialises a slow
  // poll instead of stacking the next one on top of it.
  useEffect(() => {
    if (pairingId === null) return;
    let cancelled = false;
    let timer: number | null = null;
    const tick = async () => {
      const current = stateRef.current;
      if (current === null) return;
      const next = await pairingRepo
        .settle(current, Date.now())
        .catch(() => null);
      if (cancelled) return;
      if (next === null) {
        // A failed poll is transient — an IPC hiccup, a close that arrived mid
        // reset — so it is retried. Only a settle that comes back with a dead
        // code stops the clock.
        timer = window.setTimeout(() => void tick(), 1_000);
        return;
      }
      stateRef.current = next;
      setState(next);
      if (clockStillMatters(panelPhase(next))) {
        timer = window.setTimeout(() => void tick(), 1_000);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
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
  /**
   * The one screen this panel is showing. A lost key, a staged phone, a live
   * window and nothing-yet are four different jobs, so they never stack: the
   * person sees the next action and nothing else.
   */
  const screen: "recovery" | "confirm" | "session" | "idle" = recovery.needed
    ? "recovery"
    : pending !== null && pin === null
      ? "confirm"
      : view !== null
        ? "session"
        : "idle";
  const rePairingPeer = pending?.existing?.deviceId ?? null;
  const phaseLabel = (phase: PanelPhase): string =>
    phase === "active" ? "" : t(PHASE_LABEL_KEYS[phase]);
  const phaseReason = (phase: PanelPhase): string | null =>
    phase === "active" ? null : t(PHASE_MESSAGE_KEYS[phase]);
  const phaseNote = view === null ? null : phaseReason(view.phase);

  // The count belongs to the phone being staged, so it is read whenever a
  // different device is staged — never guessed from this window's own state.
  useEffect(() => {
    if (rePairingPeer === null) {
      setPendingChanges(null);
      return;
    }
    let live = true;
    void pairingRepo
      .pendingFor(rePairingPeer)
      .then((count) => {
        if (live) setPendingChanges(count);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [rePairingPeer]);

  /**
   * §11.4's discard act — the person's own, explicit choice. Separate from
   * Trust on purpose: trusting a phone never drops unsent work by itself.
   */
  const discardPending = useCallback(async () => {
    if (rePairingPeer === null) return;
    setBusy(true);
    setError(null);
    setDiscardNote(null);
    try {
      const dropped = await pairingRepo.discard(rePairingPeer);
      setPendingChanges(await pairingRepo.pendingFor(rePairingPeer));
      setDiscardNote(t("pairing.discarded", { count: dropped }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, [rePairingPeer, t]);

  return (
    <div className="pairing-panel">
      <p className="muted">{t("pairing.listenNotice")}</p>
      {error !== null ? (
        <p className="pairing-error" role="alert">
          {error}
        </p>
      ) : null}

      {/* Nothing is drawn while the status is unknown, and a key that works
          is never offered for replacement — only a key that is gone or can
          no longer be opened (§11.2, N2). */}
      {recovery.needed ? (
        <section aria-label={t("pairing.replaceSectionAria")}>
          <p>
            <strong>{t("pairing.keyGoneTitle")}</strong>
          </p>
          {recovery.note !== null ? (
            <p className="pairing-error" role="alert">
              {recovery.note}
            </p>
          ) : null}
          <p className="muted">{t("pairing.dataStays")}</p>
          <div className="pairing-actions">
            <ConfirmButton
              what={t("pairing.replaceWhat")}
              className="btn btn-danger"
              disabled={busy}
              onConfirm={replaceIdentity}
            >
              {t("pairing.replace")}
            </ConfirmButton>
          </div>
        </section>
      ) : null}
      {recovery.rePairRequired && !recovery.needed ? (
        <p className="muted" role="status">
          {t("pairing.rePairRequired")}
        </p>
      ) : null}

      {screen === "idle" ? (
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void open()}
        >
          {busy ? t("pairing.opening") : t("pairing.open")}
        </button>
      ) : screen === "confirm" && pending !== null ? (
        <>
          <p className="muted">{t("pairing.compare")}</p>
          {/* Nothing is pinned until this block is confirmed (§11.1, N1). */}
          <section aria-label={t("pairing.confirmSectionAria")}>
            <p>
              <strong>{t("pairing.confirmTitle")}</strong>
            </p>
            <dl className="pairing-facts">
              <div>
                <dt>{t("pairing.localFingerprint")}</dt>
                <dd className="pairing-fingerprint">
                  {formatShortFp(pending.localFingerprint)}
                </dd>
              </div>
              <div>
                <dt>{t("pairing.peerFingerprint")}</dt>
                <dd className="pairing-fingerprint">
                  {pending.peer.fingerprint !== null
                    ? formatShortFp(pending.peer.fingerprint)
                    : pending.peer.deviceId}
                </dd>
              </div>
              {pending.existing !== null ? (
                <div>
                  <dt>{t("pairing.alreadyPaired")}</dt>
                  <dd>
                    {t("pairing.rePairing", {
                      name:
                        pending.existing.displayName ||
                        pending.existing.deviceId,
                      current:
                        pending.existing.fingerprint !== null
                          ? t("pairing.currently", {
                              fingerprint: formatShortFp(
                                pending.existing.fingerprint,
                              ),
                            })
                          : "",
                    })}
                  </dd>
                </div>
              ) : null}
            </dl>
            {pending.helloReceived ? null : (
              <p className="muted" role="status">
                {t("pairing.waitingPhone")}
              </p>
            )}
            {/* §11.4: a re-pair zeroes the cursors, so anything this
                desktop still owes the phone would be stranded. Trust is
                disabled until it is synced or deliberately discarded, and
                the count is named rather than left to the person to guess. */}
            {pendingChanges !== null && pendingChanges > 0 ? (
              <div className="pairing-guard" role="alert">
                <p className="pairing-error">
                  {t("pairing.pendingChanges", { count: pendingChanges })}
                </p>
                <ConfirmButton
                  what={t("pairing.discardPendingWhat", {
                    count: pendingChanges,
                  })}
                  className="btn btn-danger"
                  disabled={busy}
                  onConfirm={discardPending}
                >
                  {t("pairing.discardPending")}
                </ConfirmButton>
              </div>
            ) : null}
            {discardNote !== null ? (
              <p className="muted" role="status">
                {discardNote}
              </p>
            ) : null}
            <div className="pairing-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  busy || !pending.helloReceived || (pendingChanges ?? 0) > 0
                }
                onClick={() => void trust()}
              >
                {t("pairing.trust")}
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void close()}
              >
                {t("pairing.reject")}
              </button>
            </div>
          </section>
        </>
      ) : view !== null ? (
        <>
          <div className="pairing-panel-body">
            {/* No QR without a live code and a bound port (§11.5). The
                pastable copy of the same string sits behind the disclosure
                below, so the code keeps the screen. */}
            {view.payload !== null ? (
              <figure className="pairing-offer">
                <QrCode payload={view.payload} />
              </figure>
            ) : null}
            <dl className="pairing-facts">
              <div>
                <dt>{t("pairing.code")}</dt>
                <dd className="pairing-code">
                  {/* The phase's own word, never a hardcoded "expired": a
                      locked, used or unreachable code says what it is (N3). */}
                  {formatPairingCode(view.code ?? phaseLabel(view.phase))}
                </dd>
              </div>
              <div>
                <dt>{t("pairing.lifetime")}</dt>
                <dd>
                  {view.phase === "active"
                    ? t("pairing.secondsLeft", {
                        seconds: view.remainingSeconds,
                      })
                    : phaseReason(view.phase)}
                </dd>
              </div>
              {/* §9.1: the phone's upload is staged by the listener and
                  applied by this panel — its state is the person's receipt. */}
              {view.upload !== null ? (
                <div>
                  <dt>{t("pairing.upload")}</dt>
                  <dd>
                    {view.upload.state === "receiving"
                      ? t("pairing.receivingRecords", {
                          count: view.upload.ops,
                        })
                      : view.upload.state === "staged"
                        ? t("pairing.recordsReceived", {
                            count: view.upload.ops,
                          })
                        : view.upload.state === "applying"
                          ? t("pairing.applying")
                          : view.upload.state === "applied"
                            ? t("pairing.uploadApplied", {
                                inserted: view.upload.inserted ?? 0,
                                alreadyKnown: view.upload.alreadyKnown ?? 0,
                              })
                            : t("pairing.failed", {
                                detail:
                                  view.upload.note ??
                                  t("pairing.applyNotCommitted"),
                              })}
                  </dd>
                </div>
              ) : null}
              {/* §6: one exchange, both directions — the phone pushes, this
                  panel's engine merges, and the phone's position comes back. */}
              {view.sync !== null ? (
                <div>
                  <dt>{t("pairing.sync")}</dt>
                  <dd>
                    {view.sync.state === "receiving"
                      ? t("pairing.receivingChanges", {
                          count: view.sync.ops,
                        })
                      : view.sync.state === "staged"
                        ? t("pairing.changesReceived", {
                            count: view.sync.ops,
                          })
                        : view.sync.state === "applying"
                          ? t("pairing.applying")
                          : view.sync.state === "applied"
                            ? `${t("pairing.changesApplied", { count: view.sync.ops })}${
                                view.sync.applied === null
                                  ? ""
                                  : t("pairing.phoneThrough", {
                                      applied: view.sync.applied,
                                    })
                              }`
                            : t("pairing.failed", {
                                detail:
                                  view.sync.note ??
                                  t("pairing.applyNotCommitted"),
                              })}
                  </dd>
                </div>
              ) : null}
              {/* §8.5: a record too large to copy is why adoption cannot
                  proceed — the reason, not a silent stall. */}
              {view.note !== null ? (
                <div>
                  <dt>{t("pairing.snapshot")}</dt>
                  <dd>{view.note}</dd>
                </div>
              ) : null}
            </dl>
          </div>

          {/* §11.1 manual entry: the same string the QR carries, for a phone
              with no camera. It is one disclosure, not a second screen. */}
          {view.payload !== null ? (
            <div className="pairing-disclosure">
              <button
                type="button"
                className="btn btn-ghost"
                aria-expanded={showOffer}
                onClick={() => setShowOffer((previous) => !previous)}
              >
                {t("pairing.noCamera")}
              </button>
              {showOffer ? (
                <div className="pairing-disclosure-body">
                  <code className="pairing-offer-text" ref={offerTextRef}>
                    {view.payload}
                  </code>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void copyOffer(view.payload ?? "")}
                  >
                    {copied ? t("pairing.copied") : t("pairing.copy")}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Plumbing sits behind its own disclosure: the address, this
              device's fingerprint and the phone already paired are facts to
              look up, not the next action. */}
          <div className="pairing-disclosure">
            <button
              type="button"
              className="btn btn-ghost"
              aria-expanded={showDetails}
              onClick={() => setShowDetails((previous) => !previous)}
            >
              {t("pairing.connectionDetails")}
            </button>
            {showDetails ? (
              <div className="pairing-disclosure-body">
                <dl className="pairing-facts">
                  <div>
                    <dt>{t("pairing.listeningOn")}</dt>
                    <dd>
                      {view.listenerRunning
                        ? (view.endpoint ?? t("pairing.localPort"))
                        : t("pairing.closed")}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("pairing.localFingerprint")}</dt>
                    <dd className="pairing-fingerprint">
                      {formatShortFp(view.fingerprint)}
                    </dd>
                  </div>
                  {pin !== null ? (
                    <div>
                      <dt>{t("pairing.pairedPhone")}</dt>
                      <dd className="pairing-fingerprint">
                        {pin.peer.fingerprint !== null
                          ? formatShortFp(pin.peer.fingerprint)
                          : pin.peer.deviceId}
                        {pin.repinned ? ` ${t("pairing.rePaired")}` : ""}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </div>
            ) : null}
          </div>
          {phaseNote !== null ? (
            <p className="pairing-error" role="alert">
              {phaseNote}
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
                  {t("pairing.freshCode")}
                </button>
              ) : null}
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void close()}
              >
                {t("pairing.stop")}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
