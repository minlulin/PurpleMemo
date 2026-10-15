// P3f lock screens (§2.9): first-run PIN setup (required — never
// skippable) and the lock screen with its security-question fallback.
// The PIN is stored only as a salted PBKDF2-SHA256 hash (600k iterations)
// in the settings table; the fallback stores the same kind of hash for the
// answer. There is NO online recovery and the UI says so plainly (§2.9).

import { useState } from "react";
import { settingsRepo } from "../data/app.ts";
import {
  LOCK_RETRY_DELAY_MS,
  lockRetryDelayMs,
  MIN_PIN_LENGTH,
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

/** First-run flow (§2.9): PIN + security question, both required. */
export function SetupScreen({ onDone }: { onDone: () => void }) {
  const [draft, setDraft] = useState({
    pin: "",
    confirm: "",
    question: "",
    answer: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (draft.pin.length < MIN_PIN_LENGTH) {
      setError(`PIN must be at least ${MIN_PIN_LENGTH} characters.`);
      return;
    }
    if (draft.pin !== draft.confirm) {
      setError("PINs do not match.");
      return;
    }
    if (draft.question.trim().length === 0) {
      setError("A security question is required — it is your only recovery.");
      return;
    }
    if (draft.answer.trim().length === 0) {
      setError("The security answer is required.");
      return;
    }
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
            <IconLock className="icon" /> Offline Encrypted Workspace
          </span>
          <h2 className="editor-title">Welcome to Purple Memo</h2>
          <p className="page-subtitle">
            Set a local PIN to protect your workspace. The PIN is{" "}
            <b>required</b> — there is <b>no online recovery</b>. Your security
            question below is the only way back in if you forget your PIN.
          </p>
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
              <div className="setup-step-title">Choose a PIN</div>
              <p className="setup-step-note">
                At least {MIN_PIN_LENGTH} characters. Stored as a salted hash —
                it is never written in plain text.
              </p>
            </div>
          </div>
          <PinDots length={draft.pin.length} />
          <div className="form-grid">
            <label>
              PIN (at least {MIN_PIN_LENGTH} characters)
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
              Confirm PIN
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
              <div className="setup-step-title">Set your recovery question</div>
              <p className="setup-step-note">
                Your only way back in if you forget the PIN. Answer something
                only you know.
              </p>
            </div>
          </div>
          <label>
            Security question
            <input
              className="input"
              placeholder="e.g. What street did I grow up on?"
              value={draft.question}
              onChange={(e) => setDraft({ ...draft, question: e.target.value })}
            />
          </label>
          <label>
            Security answer
            <input
              className="input"
              placeholder="Memorable answer"
              value={draft.answer}
              onChange={(e) => setDraft({ ...draft, answer: e.target.value })}
            />
          </label>
        </div>
        <div className="editor-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Setting up…" : "Set PIN and continue"}
          </button>
        </div>
      </form>
    </div>
  );
}

interface LockScreenProps {
  pinHash: PinHash;
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

/** Lock screen (§2.9) + forgotten-PIN fallback via the security question. */
export function LockScreen(p: LockScreenProps) {
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
  /** Consecutive failed attempts across both paths (PIN + answer). Resets on
   *  the first success; past the free attempts the screen pauses
   *  `LOCK_RETRY_DELAY_MS` before another try (review L-02). */
  const [failures, setFailures] = useState(0);
  const [cooling, setCooling] = useState(false);

  const noteFailure = async () => {
    const next = failures + 1;
    setFailures(next);
    setShaking(true);
    const waitMs = lockRetryDelayMs(next);
    if (waitMs > 0) {
      setCooling(true);
      setError(
        `Too many wrong attempts — wait ${LOCK_RETRY_DELAY_MS / 1000} seconds before trying again.`,
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
    setBusy(true);
    try {
      if (await verifyPin(pin, p.pinHash)) {
        setFailures(0);
        p.onUnlock();
      } else {
        setError("Wrong PIN.");
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
    if (p.answerHash === null) {
      setError(
        "The recovery fallback is unavailable for this install — the stored PIN is the only way in.",
      );
      return;
    }
    if (draft.pin.length < MIN_PIN_LENGTH) {
      setError(`New PIN must be at least ${MIN_PIN_LENGTH} characters.`);
      return;
    }
    if (draft.pin !== draft.confirm) {
      setError("PINs do not match.");
      return;
    }
    setBusy(true);
    try {
      if (!(await verifyAnswer(draft.answer, p.answerHash))) {
        setError("Wrong answer.");
        await noteFailure();
        return;
      }
      await settingsRepo.setManyJSON([
        { key: SETTING_KEYS.pinHash, value: await hashPin(draft.pin) },
      ]);
      setFailures(0);
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
              <IconLock className="icon" /> Session Locked
            </span>
            <h2 className="editor-title">Purple Memo is locked</h2>
            <p className="page-subtitle">
              Enter your PIN to unlock your encrypted notebook and finance
              ledger.
            </p>
          </div>
          {error ? (
            <p className="alert alert-error" role="alert">
              {error}
            </p>
          ) : null}
          <label>
            PIN
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              placeholder="Enter PIN…"
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
              {busy ? "Checking…" : cooling ? "Wait…" : "Unlock"}
            </button>
            <span className="toolbar-spacer" />
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                if (p.answerHash === null) {
                  setError(
                    "No security answer is stored for this install — the PIN cannot be reset.",
                  );
                  return;
                }
                setMode("forgot");
                setError(null);
                setShaking(false);
              }}
            >
              Forgot PIN?
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
          <h2 className="editor-title">Reset your PIN</h2>
          <p className="page-subtitle">
            Answer your security question to set a new PIN. There is no other
            way to recover the PIN.
          </p>
        </div>
        {error ? (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="alert alert-note">{p.question}</p>
        <label>
          Answer
          <input
            className="input"
            placeholder="Your security answer"
            value={draft.answer}
            onChange={(e) => setDraft({ ...draft, answer: e.target.value })}
          />
        </label>
        <div className="form-grid">
          <label>
            New PIN
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
            Confirm new PIN
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
        <div className="editor-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || cooling}
          >
            {busy ? "Checking…" : cooling ? "Wait…" : "Set new PIN"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setMode("pin");
              setError(null);
              setShaking(false);
            }}
          >
            Back
          </button>
        </div>
      </form>
    </div>
  );
}
