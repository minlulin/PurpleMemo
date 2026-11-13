/**
 * The phone's pairing block (Phase C Session 6 Q.2; Session 7 T2).
 *
 * Two entries, one set of values: a camera frame goes through `qr.ts`'s decode
 * and `parseOffer`; a typed code goes through `redeemCode`, so every refusal
 * the protocol names is the one the tested module returns.
 *
 * Confirming runs `mobilePairing.ts`'s order: the code is redeemed, the sealed
 * request → ack → hello happens in Rust, and only then is the pin written. The
 * card words a success as a pairing only because that command resolved.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { mobilePairingRepo, syncRepo } from "../data/app.ts";
import type { PhonePairResult } from "../data/driver.ts";
import {
  isBareCode,
  isCompleteCode,
  offerFromFrame,
  scannedSession,
} from "../lib/sync/mobilePairing.ts";
import {
  keyFingerprint,
  type PairingOffer,
  type PairingSession,
  parseOffer,
} from "../lib/sync/pairing.ts";
import type { PeerRow, SnapshotOp } from "../lib/sync/store.ts";
import type { SyncOutcome } from "../lib/sync/syncSession.ts";
import { useT } from "./useTranslation.ts";

type Scanning = "idle" | "scanning" | "unavailable";

export function MobilePairingCard() {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const runningRef = useRef(false);
  const [scanning, setScanning] = useState<Scanning>("idle");
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [session, setSession] = useState<PairingSession | null>(null);
  const [typed, setTyped] = useState("");
  // §11.1: the camera-less entry. The desktop's offer is a URI a person can
  // copy, and it is the same proof a scan is — `parseOffer` decides.
  const [pasted, setPasted] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // §8.4's pull, offered only once a desktop acknowledged this phone (§11.2).
  const [paired, setPaired] = useState<PhonePairResult | null>(null);
  const [progress, setProgress] = useState<{
    batch: number;
    total: number;
  } | null>(null);
  const [pulled, setPulled] = useState<{
    rows: number;
    tombstones: number;
    stagedOps: SnapshotOp[];
  } | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);
  // §9.1's upload, offered only after a pull in this same session: the plan
  // is computed against the snapshot that pull just took.
  const [uploadProgress, setUploadProgress] = useState<{
    batch: number;
    total: number;
  } | null>(null);
  const [uploaded, setUploaded] = useState<{
    offered: number;
    inserted: number;
    alreadyKnown: number;
  } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // §6's ongoing sync: offered whenever this phone holds a desktop pin, not
  // only inside a fresh pairing session.
  const [pins, setPins] = useState<PeerRow[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState<SyncOutcome | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const stopCamera = useCallback(() => {
    runningRef.current = false;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    if (videoRef.current !== null) videoRef.current.srcObject = null;
  }, []);

  /** False once the card unmounts, so a late `getUserMedia` is released (N6). */
  const mountedRef = useRef(true);

  // A pin is what makes a sync possible at all (§11.2), so the card reads them
  // rather than inferring one from this session's pairing.
  useEffect(() => {
    let live = true;
    void mobilePairingRepo
      .peers()
      .then((rows) => {
        if (live) setPins(rows);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  // A camera left running behind a tab change is a light and a battery, and it
  // would keep decoding frames nobody is reading.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopCamera();
    };
  }, [stopCamera]);

  // A hidden document must not keep the camera lit or keep decoding frames
  // nobody sees — the mobile lock grace keeps the app alive in the background
  // after its screen is gone (N6).
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState !== "hidden") return;
      stopCamera();
      setScanning((current) => (current === "scanning" ? "idle" : current));
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  }, [stopCamera]);

  const scan = useCallback(async () => {
    setError(null);
    setNotice(null);
    const video = videoRef.current;
    if (video === null || navigator.mediaDevices?.getUserMedia === undefined) {
      setScanning("unavailable");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      // The permission prompt can outlive the card. If it unmounted, or the app
      // went to the background while the prompt was open, the cleanup already
      // ran while `streamRef` was still null — so the hardware is released here
      // rather than running on behind another screen (N6).
      if (!mountedRef.current || document.visibilityState === "hidden") {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;
      video.srcObject = stream;
      await video.play();
      runningRef.current = true;
      setScanning("scanning");
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", {
        willReadFrequently: true,
      });
      if (context === null) {
        stopCamera();
        setScanning("unavailable");
        return;
      }
      const step = () => {
        if (!runningRef.current) return;
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          context.drawImage(video, 0, 0);
          const frame = context.getImageData(0, 0, canvas.width, canvas.height);
          const result = offerFromFrame(frame);
          if (result.ok) {
            setOffer(result.offer);
            // Local expiry runs on this phone's clock from the scan (N6).
            setSession(scannedSession(result.offer));
            setTyped("");
            setScanning("idle");
            stopCamera();
            return;
          }
          if (result.kind === "invalid-qr") {
            // A readable QR this phone refuses. Looping would keep the camera
            // on forever and never surface the reason (N6), so stop and say it.
            setError(result.reason);
            setScanning("idle");
            stopCamera();
            return;
          }
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    } catch {
      stopCamera();
      if (mountedRef.current) setScanning("unavailable");
    }
  }, [stopCamera]);

  /**
   * Pair without a camera (§11.1: "manual entry must remain first-class"):
   * paste the desktop's pairing string, which `parseOffer` validates exactly as
   * it validates a scanned one.
   */
  const usePastedOffer = () => {
    setError(null);
    setNotice(null);
    const entry = pasted.trim();
    // The digits are the code of a window, not a desktop: they carry no
    // endpoint and no key, so say what is missing instead of letting
    // `parseOffer` call them "not a Purple Memo pairing code".
    if (isBareCode(entry)) {
      setError(t("mobile.settings.pairDigitsOnly"));
      return;
    }
    const parsed = parseOffer(entry);
    if (!parsed.ok) {
      setError(parsed.reason);
      return;
    }
    setOffer(parsed.offer);
    setSession(scannedSession(parsed.offer));
    setTyped("");
    setScanning("idle");
  };

  // A used code is spent: the button stops offering a second attempt that can
  // only come back "used".
  const spent = session !== null && session.usedAt !== null;

  const confirm = async () => {
    if (session === null || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await mobilePairingRepo.pairWithDesktop(session, typed);
      setSession(result.session);
      if (result.paired) {
        setPaired(result.desktop);
        // A pairing that just landed writes the pin, so the §6 surface appears
        // without waiting for a remount.
        void mobilePairingRepo
          .peers()
          .then(setPins)
          .catch(() => undefined);
        setNotice(t("mobile.settings.pairConfirmed"));
      } else {
        // The protocol's own words: the desktop's refusal when it refused, and
        // `redeemCode`'s when the code was wrong here.
        setError(result.refusal?.message ?? result.verdict.message);
      }
    } finally {
      setBusy(false);
    }
  };

  /**
   * Copy the desktop's records (§8.4). The whole snapshot is one transaction,
   * so either everything arrives or the message says nothing was copied —
   * never a half-adopted state the person would have to guess at.
   */
  const copyFromDesktop = async () => {
    if (paired === null || offer === null || progress !== null) return;
    setPullError(null);
    setPulled(null);
    setUploaded(null);
    setUploadError(null);
    setProgress({ batch: 0, total: 0 });
    try {
      const outcome = await mobilePairingRepo.pullSnapshot(
        { endpoint: offer.endpoint, desktopDeviceId: paired.desktopDeviceId },
        paired.pairingId,
        (next) => setProgress(next),
      );
      if (outcome.applied) {
        setPulled({
          rows: outcome.rows,
          tombstones: outcome.tombstones,
          stagedOps: outcome.stagedOps,
        });
      } else {
        setPullError(
          outcome.refusal === null
            ? t("mobile.settings.pullFailed")
            : `${t("mobile.settings.pullFailed")} ${outcome.refusal.message}`,
        );
      }
    } finally {
      setProgress(null);
    }
  };

  /**
   * Send this phone's own records (§9.1). The desktop stages them unapplied
   * and its panel applies them in one transaction; this card believes the
   * upload only when the desktop's sealed verdict says so — never because
   * the batches were sent.
   */
  const sendToDesktop = async () => {
    if (
      paired === null ||
      offer === null ||
      pulled === null ||
      uploadProgress !== null
    ) {
      return;
    }
    setUploadError(null);
    setUploaded(null);
    setUploadProgress({ batch: 0, total: 0 });
    try {
      const outcome = await mobilePairingRepo.pushUpload(
        { endpoint: offer.endpoint, desktopDeviceId: paired.desktopDeviceId },
        pulled.stagedOps,
        (next) => setUploadProgress(next),
      );
      if (outcome.uploaded) {
        setUploaded({
          offered: outcome.offered,
          inserted: outcome.inserted,
          alreadyKnown: outcome.alreadyKnown,
        });
      } else {
        setUploadError(
          outcome.refusal === null
            ? t("mobile.settings.uploadFailed")
            : `${t("mobile.settings.uploadFailed")} ${outcome.refusal.message}`,
        );
      }
    } finally {
      setUploadProgress(null);
    }
  };

  /**
   * One §6 session with the pinned desktop. The address comes from the code
   * this session scanned; the key, the pairing id and the data line are the
   * pin, read in Rust — the card never names a key.
   */
  const syncNow = async () => {
    const endpoint = offer?.endpoint;
    const pin =
      pins.find((row) => row.device_id === paired?.desktopDeviceId) ?? pins[0];
    if (endpoint === undefined || pin === undefined || syncing) return;
    setSyncing(true);
    setSyncError(null);
    setSynced(null);
    try {
      const outcome = await syncRepo.run({
        endpoint,
        desktopDeviceId: pin.device_id,
      });
      setSynced(outcome);
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="mobile-card">
      <p className="mobile-note">{t("mobile.settings.pairBody")}</p>
      <video
        ref={videoRef}
        className="mobile-pair-preview"
        muted
        playsInline
        hidden={scanning !== "scanning"}
      />
      <div className="mobile-pair-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={scanning === "scanning"}
          onClick={() => void scan()}
        >
          {scanning === "scanning"
            ? t("mobile.settings.pairScanning")
            : offer === null
              ? t("mobile.settings.pairScan")
              : t("mobile.settings.pairRefresh")}
        </button>
      </div>
      {/* The two notes never stack: "type the code" and "scan first" side by
          side, with no field, was the dead end this replaces (N6). */}
      {scanning === "unavailable" && offer === null ? (
        <p className="mobile-note">{t("mobile.settings.pairCameraOff")}</p>
      ) : null}
      {offer === null ? (
        <>
          <p className="mobile-note">{t("mobile.settings.pairNoOffer")}</p>
          <label className="mobile-field">
            <span>{t("mobile.settings.pairPasteLabel")}</span>
            <input
              className="input"
              autoComplete="off"
              spellCheck={false}
              placeholder="purplememo-pair://v1?…"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn"
            disabled={pasted.trim().length === 0}
            onClick={usePastedOffer}
          >
            {t("mobile.settings.pairPasteAction")}
          </button>
        </>
      ) : (
        <>
          <p className="mobile-row-text">
            {t("mobile.settings.pairEndpoint", { endpoint: offer.endpoint })}
          </p>
          <p className="mobile-row-text">
            {t("mobile.settings.pairDesktopKey", {
              fingerprint: keyFingerprint(offer.publicKey),
            })}
          </p>
          <label className="mobile-field">
            <span>{t("mobile.settings.pairTypeLabel")}</span>
            <input
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              // Spaced and dashed codes are supported ("12 34 56", "123 - 456"):
              // 7 truncated them mid-code and disabled Confirm silently (N6).
              maxLength={12}
              placeholder="000000"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn"
            disabled={!isCompleteCode(typed) || busy || spent}
            onClick={() => void confirm()}
          >
            {t("mobile.settings.pairConfirm")}
          </button>
        </>
      )}
      {error !== null ? (
        <p className="mobile-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice !== null ? (
        <p className="alert alert-note" role="status">
          {notice}
        </p>
      ) : null}
      {paired === null ? null : (
        <section className="mobile-section">
          <h3 className="mobile-section-heading">
            {t("mobile.settings.pullHeading")}
          </h3>
          <p className="mobile-note">{t("mobile.settings.pullBody")}</p>
          <p className="mobile-note">{t("mobile.settings.pullMissing")}</p>
          <button
            type="button"
            className="btn"
            disabled={progress !== null}
            onClick={() => void copyFromDesktop()}
          >
            {progress === null
              ? t("mobile.settings.pullStart")
              : t("mobile.settings.pullProgress", {
                  batch: progress.batch,
                  total: progress.total,
                })}
          </button>
          {pulled !== null ? (
            <p className="alert alert-note" role="status">
              {t("mobile.settings.pullDone", {
                rows: pulled.rows,
                tombstones: pulled.tombstones,
              })}
            </p>
          ) : null}
          {pullError !== null ? (
            <p className="mobile-error" role="alert">
              {pullError}
            </p>
          ) : null}
          {pulled !== null ? (
            <>
              <h3 className="mobile-section-heading">
                {t("mobile.settings.uploadHeading")}
              </h3>
              <p className="mobile-note">{t("mobile.settings.uploadBody")}</p>
              <button
                type="button"
                className="btn"
                disabled={uploadProgress !== null || progress !== null}
                onClick={() => void sendToDesktop()}
              >
                {uploadProgress === null
                  ? t("mobile.settings.uploadStart")
                  : t("mobile.settings.uploadProgress", {
                      batch: uploadProgress.batch,
                      total: uploadProgress.total,
                    })}
              </button>
              {uploaded !== null ? (
                <p className="alert alert-note" role="status">
                  {uploaded.offered === 0
                    ? t("mobile.settings.uploadNothing")
                    : t("mobile.settings.uploadDone", {
                        inserted: uploaded.inserted,
                        alreadyKnown: uploaded.alreadyKnown,
                      })}
                </p>
              ) : null}
              {uploadError !== null ? (
                <p className="mobile-error" role="alert">
                  {uploadError}
                </p>
              ) : null}
            </>
          ) : null}
        </section>
      )}
      {/* §6: the ongoing exchange. Offered on the pin, not on this session's
          pairing — a phone that was paired last week can still sync, and one
          that has never paired has nothing to sync with. */}
      {pins.length === 0 ? null : (
        <section className="mobile-section">
          <h3 className="mobile-section-heading">
            {t("mobile.settings.syncHeading")}
          </h3>
          <p className="mobile-note">{t("mobile.settings.syncBody")}</p>
          {offer === null ? (
            <p className="mobile-note">{t("mobile.settings.syncNeedsCode")}</p>
          ) : (
            <>
              <button
                type="button"
                className="btn"
                disabled={syncing}
                onClick={() => void syncNow()}
              >
                {syncing
                  ? t("mobile.settings.syncProgress")
                  : t("mobile.settings.syncStart")}
              </button>
              {synced?.confirmed ? (
                <p className="alert alert-note" role="status">
                  {synced.pushed === 0 && synced.pulled === 0
                    ? t("mobile.settings.syncNothing")
                    : t("mobile.settings.syncDone", {
                        pushed: synced.pushed,
                        pulled: synced.pulled,
                      })}
                </p>
              ) : null}
              {synced !== null && !synced.confirmed ? (
                <p className="mobile-error" role="alert">
                  {synced.state === "pending"
                    ? t("mobile.settings.syncUnconfirmed")
                    : `${t("mobile.settings.syncFailed")} ${synced.refusal?.message ?? ""}`}
                </p>
              ) : null}
              {syncError !== null ? (
                <p className="mobile-error" role="alert">
                  {syncError}
                </p>
              ) : null}
            </>
          )}
        </section>
      )}
    </div>
  );
}
