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
import { mobilePairingRepo } from "../data/app.ts";
import {
  isCompleteCode,
  offerFromFrame,
  type PairingOutcome,
} from "../lib/sync/mobilePairing.ts";
import {
  keyFingerprint,
  type PairingOffer,
  type PairingSession,
} from "../lib/sync/pairing.ts";
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
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<PairingOutcome | null>(null);

  const stopCamera = useCallback(() => {
    runningRef.current = false;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    if (videoRef.current !== null) videoRef.current.srcObject = null;
  }, []);

  // A camera left running behind a tab change is a light and a battery, and it
  // would keep decoding frames nobody is reading.
  useEffect(() => () => stopCamera(), [stopCamera]);

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
            setSession({
              offer: result.offer,
              failedAttempts: [],
              usedAt: null,
            });
            setTyped("");
            setOutcome(null);
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
      setScanning("unavailable");
    }
  }, [stopCamera]);

  const confirm = async () => {
    if (session === null || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await mobilePairingRepo.pairWithDesktop(session, typed);
      setSession(result.session);
      setOutcome(result);
      if (result.paired) {
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
      {scanning === "unavailable" ? (
        <p className="mobile-note">{t("mobile.settings.pairCameraOff")}</p>
      ) : null}
      {offer === null ? (
        <p className="mobile-note">{t("mobile.settings.pairNoOffer")}</p>
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
              maxLength={7}
              placeholder="000000"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn"
            disabled={!isCompleteCode(typed) || busy}
            onClick={() => void confirm()}
          >
            {t("mobile.settings.pairConfirm")}
          </button>
          {outcome?.paired && outcome.desktop !== null ? (
            <p className="mobile-row-text">
              {t("mobile.settings.pairDesktopKey", {
                fingerprint: keyFingerprint(outcome.desktop.desktopPublicKey),
              })}
            </p>
          ) : null}
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
    </div>
  );
}
