// P3f lock screens: first-run PIN setup (required — never
// skippable) and the lock screen with its security-question fallback.
// The PIN is stored only as a salted PBKDF2-SHA256 hash (600k iterations)
// in the settings table; the fallback stores the same kind of hash for the
// answer. There is NO online recovery and the UI says so plainly

import { useRef, useState } from "react";
import { settingsRepo } from "../data/app.ts";
import {
  LOCK_RETRY_DELAY_MS,
  lockRetryDelayMs,
  MIN_PIN_LENGTH,
  type PinResetBlock,
  type PinUnreadable,
  pinResetBlocked,
} from "../lib/appLock.ts";
import {
  hashAnswer,
  hashPin,
  type PinHash,
  verifyAnswer,
  verifyPin,
} from "../lib/crypto.ts";
import { errText } from "../lib/errors.ts";
import { SETTING_KEYS } from "../lib/settings.ts";
import { IconLock } from "./icons.tsx";
import { type Translate, useT } from "./useTranslation.ts";

/**
 * One sentence per refusal from `pinResetBlocked`, in the order that function
 * checks them. `unacknowledged` is the gate: the reset replaces the PIN
 * and the operator has not yet said they understand that.
 */
function resetProblemText(t: Translate, block: PinResetBlock): string {
  switch (block) {
    case "no-answer":
      return t("lock.reset.noAnswer");
    case "short-pin":
      return t("lock.reset.shortPin", { count: MIN_PIN_LENGTH });
    case "mismatch":
      return t("lock.error.pinMismatch");
    case "unacknowledged":
      return t("lock.reset.unacknowledged");
  }
}

/** Progress dots for PIN entry. Decorative — the input keeps the real value. */
function PinDots({ length }: { length: number }) {
  const slots = MIN_PIN_LENGTH;
  const filled = Math.min(length, slots);
  return (
    <div className="pin-dots" aria-hidden="true">
      {Array.from({ length: slots }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length progress
          key={`pin-dot-${i}`}
          className={`pin-dot${i < filled ? " is-filled" : ""}`}
        />
      ))}
      {length > slots ? (
        <span className="pin-dots-overflow">+{length - slots}</span>
      ) : null}
    </div>
  );
}

/** First-run flow: PIN + security question, both required. */
export function SetupScreen({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [draft, setDraft] = useState({
    pin: "",
    confirm: "",
    question: "",
    answer: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The pinned double-submit guard: hashing and writing
  // the first PIN is not idempotent from the user's side — a second click
  // before React re-renders would race the first write, and the screen that
  // follows unmounts this form anyway.
  const submittingRef = useRef(false);

  const submit = async () => {
    if (submittingRef.current) return;
    if (draft.pin.length < MIN_PIN_LENGTH) {
      setError(t("lock.error.pinShort", { count: MIN_PIN_LENGTH }));
      return;
    }
    if (draft.pin !== draft.confirm) {
      setError(t("lock.error.pinMismatch"));
      return;
    }
    if (draft.question.trim().length === 0) {
      setError(t("lock.error.questionRequired"));
      return;
    }
    if (draft.answer.trim().length === 0) {
      setError(t("lock.error.answerRequired"));
      return;
    }
    submittingRef.current = true;
    setBusy(true);
    try {
      const [pinHash, answerHash] = await Promise.all([
        hashPin(draft.pin),
        hashAnswer(draft.answer),
      ]);
      await settingsRepo.setManyJSON([
        { key: SETTING_KEYS.pinHash, value: pinHash },
        {
          key: SETTING_KEYS.securityQuestion,
          value: draft.question.trim(),
        },
        { key: SETTING_KEYS.securityAnswerHash, value: answerHash },
      ]);
      onDone();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    } finally {
      submittingRef.current = false;
    }
  };

  return (
    <div className="lock-wrap">
      <form
        className="entry-form vault-narrow"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="lock-brand-head">
          <img
            className="lock-brand-mark"
            src="/brand/purple-memo-mark.png"
            alt=""
          />
          <span className="badge badge-accent">
            <IconLock className="icon" /> {t("lock.setup.badge")}
          </span>
          <h2 className="editor-title">{t("lock.setup.title")}</h2>
          <p className="page-subtitle">{t("lock.setup.intro")}</p>
        </div>
        {error ? (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="setup-step">
          <div className="setup-step-head">
            <span className="setup-step-indicator" aria-hidden="true">
              1
            </span>
            <div>
              <div className="setup-step-title">
                {t("lock.setup.choosePin")}
              </div>
              <p className="setup-step-note">
                {t("lock.setup.pinNote", { count: MIN_PIN_LENGTH })}
              </p>
            </div>
          </div>
          <PinDots length={draft.pin.length} />
          <div className="form-grid">
            <label>
              {t("lock.setup.pinLabel", { count: MIN_PIN_LENGTH })}
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                placeholder="••••••"
                value={draft.pin}
                onChange={(e) => setDraft({ ...draft, pin: e.target.value })}
              />
            </label>
            <label>
              {t("lock.setup.confirmPin")}
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                placeholder="••••••"
                value={draft.confirm}
                onChange={(e) =>
                  setDraft({ ...draft, confirm: e.target.value })
                }
              />
            </label>
          </div>
        </div>
        <div className="setup-step">
          <div className="setup-step-head">
            <span className="setup-step-indicator" aria-hidden="true">
              2
            </span>
            <div>
              <div className="setup-step-title">
                {t("lock.setup.recoveryTitle")}
              </div>
              <p className="setup-step-note">{t("lock.setup.recoveryNote")}</p>
            </div>
          </div>
          <label>
            {t("lock.setup.question")}
            <input
              className="input"
              placeholder={t("lock.setup.questionPlaceholder")}
              value={draft.question}
              onChange={(e) => setDraft({ ...draft, question: e.target.value })}
            />
          </label>
          <label>
            {t("lock.setup.answer")}
            <input
              className="input"
              placeholder={t("lock.setup.answerPlaceholder")}
              value={draft.answer}
              onChange={(e) => setDraft({ ...draft, answer: e.target.value })}
            />
          </label>
        </div>
        <div className="editor-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? t("lock.setup.busy") : t("lock.setup.submit")}
          </button>
        </div>
      </form>
    </div>
  );
}

interface LockScreenProps {
  /**
   * `undefined` only when the shell could not classify a stored PIN — the
   * `locked` gate in `lockGate` normally routes that case to `LockedScreen`
   * instead. It stays optional so this screen fails closed on its own too: it
   * renders the unrecoverable notice and never calls `verifyPin`.
   */
  pinHash: PinHash | undefined;
  question: string;
  /**
   * May be null when the stored settings lost the answer hash (corrupt row or
   * an import that replaced settings). The screen then fails closed: the PIN
   * is still required and the recovery fallback is simply unavailable —
   * never a route back to first-run setup.
   */
  answerHash: PinHash | null;
  onUnlock: () => void;
}

/**
 * Shown when a PIN **is** stored but cannot be read or trusted.
 * Deliberately offers nothing: no setup (that would overwrite the existing
 * PIN without verifying anything) and no unlock (there is no hash to verify
 * against). Restoring the row by hand or re-importing a known-good backup are
 * the only ways forward, and the notice says so instead of guessing.
 */
export function LockedScreen({ reason }: { reason: PinUnreadable }) {
  const t = useT();
  const detail: Record<PinUnreadable, string> = {
    corrupt: t("lock.unreadable.corrupt"),
    malformed: t("lock.unreadable.malformed"),
    "weak-iterations": t("lock.unreadable.weakIterations"),
  };
  return (
    <div className="lock-wrap">
      <div className="entry-form vault-narrow">
        <div className="lock-brand-head">
          <img
            className="lock-brand-mark"
            src="/brand/purple-memo-mark.png"
            alt=""
            width={44}
            height={44}
          />
          <h1>{t("lock.unreadable.title")}</h1>
        </div>
        <p className="alert alert-error" role="alert">
          {t("lock.unreadable.body", { detail: detail[reason] })}
        </p>
      </div>
    </div>
  );
}

/** Lock screen + forgotten-PIN fallback via the security question. */
export function LockScreen(p: LockScreenProps) {
  const t = useT();
  const [mode, setMode] = useState<"pin" | "forgot">("pin");
  const [pin, setPin] = useState("");
  const [draft, setDraft] = useState({
    answer: "",
    pin: "",
    confirm: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shaking, setShaking] = useState(false);
  /**
   * The forgotten-PIN fallback replaces the PIN, so it is the one control on
   * this screen that a person who is not the owner can use against the owner.
   * The consequence is stated in the form and this tick is
   * required before anything is written — cleared every time the form is
   * entered, so it is an acknowledgement, not a stored preference.
   */
  const [ack, setAck] = useState(false);
  /** Consecutive failed attempts across both paths (PIN + answer). Resets on
   *  the first success; past the free attempts the screen pauses
   *  `LOCK_RETRY_DELAY_MS` before another try.
   *
   *  A ref, not state (review P3-12). It used to be `useState` read inside
   *  `noteFailure`, but state is a render-time snapshot: two attempts landing
   *  inside the same PBKDF2 verify window both read the same value and both
   *  computed the same "next", counting N wrong guesses as 1. Under-counting is
   *  the direction that matters — it hands an attacker extra free attempts
   *  against a security control. (The review called it negligible because
   *  PBKDF2 dominates; the real reason is the miscount, not the cost.) A ref
   *  is read and written synchronously, so each attempt increments exactly
   *  once. No companion state: nothing renders the count, and keeping one would
   *  only ever be a second copy to fall out of step. */
  const failuresRef = useRef(0);
  const [cooling, setCooling] = useState(false);

  const noteFailure = async () => {
    const next = failuresRef.current + 1;
    failuresRef.current = next;
    setShaking(true);
    const waitMs = lockRetryDelayMs(next);
    if (waitMs > 0) {
      setCooling(true);
      setError(
        t("lock.error.tooMany", { seconds: LOCK_RETRY_DELAY_MS / 1000 }),
      );
      await new Promise((r) => setTimeout(r, waitMs));
      // A success cannot land while cooling (both submitters return early),
      // so unconditionally clearing here never wipes a newer state.
      setCooling(false);
      setError(null);
    }
  };

  const unlockWithPin = async () => {
    if (cooling) return;
    setShaking(false);
    // Fail closed: with no hash to verify against there is no correct answer,
    // so no PIN may unlock.
    if (p.pinHash === undefined) {
      setError(t("lock.unreadable.corrupt"));
      return;
    }
    setBusy(true);
    try {
      if (await verifyPin(pin, p.pinHash)) {
        failuresRef.current = 0;
        p.onUnlock();
      } else {
        setError(t("lock.error.wrongPin"));
        setPin("");
        await noteFailure();
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const resetPin = async () => {
    if (cooling) return;
    setShaking(false);
    // Destructured so the verification below needs no cast. `pinResetBlocked`
    // re-checks it anyway — it fails closed for every caller — but the order
    // here keeps the rows below typesafe.
    const { answerHash } = p;
    if (answerHash === null) {
      setError(resetProblemText(t, "no-answer"));
      return;
    }
    // The whole rule lives in `pinResetBlocked` (pure, tested): a malformed
    // new PIN never reaches the write, and neither does an unacknowledged
    // reset — the answer alone must not replace the PIN.
    const blocked = pinResetBlocked({
      answerHash,
      acknowledged: ack,
      pin: draft.pin,
      confirm: draft.confirm,
    });
    if (blocked !== null) {
      setError(resetProblemText(t, blocked));
      return;
    }
    setBusy(true);
    try {
      if (!(await verifyAnswer(draft.answer, answerHash))) {
        setError(t("lock.error.wrongAnswer"));
        await noteFailure();
        return;
      }
      await settingsRepo.setManyJSON([
        { key: SETTING_KEYS.pinHash, value: await hashPin(draft.pin) },
      ]);
      failuresRef.current = 0;
      p.onUnlock();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (mode === "pin") {
    return (
      <div className="lock-wrap">
        <form
          className={`entry-form vault-narrow${shaking ? " is-shaking" : ""}`}
          onSubmit={(e) => {
            e.preventDefault();
            void unlockWithPin();
          }}
        >
          <div className="lock-brand-head">
            <img
              className="lock-brand-mark"
              src="/brand/purple-memo-mark.png"
              alt=""
            />
            <span className="badge badge-accent">
              <IconLock className="icon" /> {t("lock.badge")}
            </span>
            <h2 className="editor-title">{t("lock.title")}</h2>
            <p className="page-subtitle">{t("lock.intro")}</p>
          </div>
          {error ? (
            <p className="alert alert-error" role="alert">
              {error}
            </p>
          ) : null}
          <label>
            {t("lock.pinLabel")}
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              placeholder={t("lock.pinPlaceholder")}
              value={pin}
              onChange={(e) => {
                setPin(e.target.value);
                setShaking(false);
              }}
            />
          </label>
          <PinDots length={pin.length} />
          <div className="editor-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || cooling || pin.length === 0}
            >
              {busy
                ? t("common.checking")
                : cooling
                  ? t("common.wait")
                  : t("lock.unlock")}
            </button>
            <span className="toolbar-spacer" />
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                if (p.answerHash === null) {
                  setError(t("lock.error.noAnswer"));
                  return;
                }
                setMode("forgot");
                setError(null);
                setShaking(false);
                setAck(false);
              }}
            >
              {t("lock.forgot")}
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="lock-wrap">
      <form
        className={`entry-form vault-narrow${shaking ? " is-shaking" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          void resetPin();
        }}
      >
        <div className="lock-brand-head">
          <img
            className="lock-brand-mark"
            src="/brand/purple-memo-mark.png"
            alt=""
          />
          <h2 className="editor-title">{t("lock.reset.title")}</h2>
          <p className="page-subtitle">{t("lock.reset.intro")}</p>
        </div>
        {error ? (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        ) : null}{" "}
        {/* One child: `.alert` is a flex container, so the sentence (and its
         *  inline `<b>`) has to live inside a single element or every text run
         *  becomes its own flex item. */}
        <p className="alert alert-warn">
          <span>{t("lock.reset.warning")}</span>
        </p>
        <p className="alert alert-note">{p.question}</p>
        <label>
          {t("lock.reset.answer")}
          <input
            className="input"
            placeholder={t("lock.reset.answerPlaceholder")}
            value={draft.answer}
            onChange={(e) => setDraft({ ...draft, answer: e.target.value })}
          />
        </label>
        <div className="form-grid">
          <label>
            {t("lock.reset.newPin")}
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={draft.pin}
              onChange={(e) => {
                setDraft({ ...draft, pin: e.target.value });
                setShaking(false);
              }}
            />
          </label>
          <label>
            {t("lock.reset.confirmPin")}
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={draft.confirm}
              onChange={(e) => setDraft({ ...draft, confirm: e.target.value })}
            />
          </label>
        </div>
        <PinDots length={draft.pin.length} />
        <label className="lock-ack">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
          />
          {t("lock.reset.ack")}
        </label>
        <div className="editor-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || cooling}
          >
            {busy
              ? t("common.checking")
              : cooling
                ? t("common.wait")
                : t("lock.reset.submit")}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setMode("pin");
              setError(null);
              setShaking(false);
              setAck(false);
            }}
          >
            {t("common.back")}
          </button>
        </div>
      </form>
    </div>
  );
}
