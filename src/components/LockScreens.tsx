// P3f lock screens (§2.9): first-run PIN setup (required — never
// skippable) and the lock screen with its security-question fallback.
// The PIN is stored only as a salted PBKDF2-SHA256 hash (600k iterations)
// in the settings table; the fallback stores the same kind of hash for the
// answer. There is NO online recovery and the UI says so plainly (§2.9).

import { useState } from "react";
import { settingsRepo } from "../data/app.ts";
import { MIN_PIN_LENGTH } from "../lib/appLock.ts";
import {
  hashAnswer,
  hashPin,
  type PinHash,
  verifyAnswer,
  verifyPin,
} from "../lib/crypto.ts";
import { errText } from "../lib/errors.ts";
import { SETTING_KEYS } from "../lib/settings.ts";

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
        <h2 className="editor-title">Welcome to Purple Memo</h2>
        <p className="muted">
          Set a PIN to lock this app. The PIN is <b>required</b> — it cannot be
          skipped. There is <b>no online recovery</b>: if you forget the PIN,
          the security question below is the only way back in. Choose an answer
          you will never forget, and keep it somewhere safe.
        </p>
        {error ? (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        ) : null}
        <label>
          PIN (at least {MIN_PIN_LENGTH} characters)
          <input
            className="input"
            type="password"
            autoComplete="new-password"
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
            value={draft.confirm}
            onChange={(e) => setDraft({ ...draft, confirm: e.target.value })}
          />
        </label>
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
          Answer
          <input
            className="input"
            value={draft.answer}
            onChange={(e) => setDraft({ ...draft, answer: e.target.value })}
          />
        </label>
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
  answerHash: PinHash;
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

  const unlockWithPin = async () => {
    setBusy(true);
    try {
      if (await verifyPin(pin, p.pinHash)) {
        p.onUnlock();
      } else {
        setError("Wrong PIN.");
        setPin("");
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const resetPin = async () => {
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
        return;
      }
      await settingsRepo.setManyJSON([
        { key: SETTING_KEYS.pinHash, value: await hashPin(draft.pin) },
      ]);
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
          className="entry-form vault-narrow"
          onSubmit={(e) => {
            e.preventDefault();
            void unlockWithPin();
          }}
        >
          <h2 className="editor-title">Purple Memo is locked</h2>
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
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
          </label>
          <div className="editor-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || pin.length === 0}
            >
              {busy ? "Checking…" : "Unlock"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setMode("forgot");
                setError(null);
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
        className="entry-form vault-narrow"
        onSubmit={(e) => {
          e.preventDefault();
          void resetPin();
        }}
      >
        <h2 className="editor-title">Reset your PIN</h2>
        <p className="muted">
          Answer your security question to set a new PIN. There is no other way
          to recover the PIN.
        </p>
        {error ? (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="chip-accent">{p.question}</p>
        <label>
          Answer
          <input
            className="input"
            value={draft.answer}
            onChange={(e) => setDraft({ ...draft, answer: e.target.value })}
          />
        </label>
        <label>
          New PIN
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={draft.pin}
            onChange={(e) => setDraft({ ...draft, pin: e.target.value })}
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
        <div className="editor-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Checking…" : "Set new PIN"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setMode("pin");
              setError(null);
            }}
          >
            Back
          </button>
        </div>
      </form>
    </div>
  );
}
