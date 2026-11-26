// The phone's Vault screen: unlock, look up, and copy a secret out with the
// clipboard's own timeout.

import { useEffect, useState } from "react";
import { vaultRepo } from "../../data/app.ts";
import {
  copySensitive,
  isAndroidPlatform,
} from "../../lib/android-reminders.ts";
import type { VaultItemRow } from "../../lib/types.ts";
import { EmptyState } from "../EmptyState.tsx";
import { useT } from "../useTranslation.ts";
import { LoadMessage } from "./common.tsx";

type VaultPhase = "loading" | "error" | "unset" | "locked" | "open";

/** Seconds the sensitive clipboard holds the value (the bridge reports it). */
const VAULT_CLIPBOARD_SECONDS = 30;

/**
 * The Vault: titles only until the vault password is entered, then reveal +
 * copy per item.
 *
 * Decision 2: lookup and copy only. There is no add, edit, delete or
 * change-password control on this surface, and no setup form — a phone whose
 * vault was never set up says so and points at the desktop. Decrypted values
 * live only in this component's state, are dropped when the app goes to the
 * background or the screen closes, and the vault's key cache is locked with
 * them.
 */
export function VaultScreen() {
  const t = useT();
  const [phase, setPhase] = useState<VaultPhase>("loading");
  const [items, setItems] = useState<
    Omit<VaultItemRow, "ciphertext" | "salt" | "iv">[]
  >([]);
  const [password, setPassword] = useState<string | null>(null);
  const [unlockPwd, setUnlockPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealedId, setRevealedId] = useState<number | null>(null);
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Metadata only: the list never carries a ciphertext, let alone a secret.
  useEffect(() => {
    void reloadKey; // the counter is the reason this effect re-runs
    let cancelled = false;
    setPhase("loading");
    (async () => {
      const setUp = await vaultRepo.isSetUp();
      if (cancelled) return;
      if (!setUp) {
        setItems([]);
        setPhase("unset");
        return;
      }
      const rows = await vaultRepo.listItems();
      if (cancelled) return;
      setItems(rows);
      setPhase("locked");
    })().catch(() => {
      if (!cancelled) setPhase("error");
    });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // A backgrounded app must not keep a decrypted secret (or a decrypting key)
  // in memory. The shell's one-minute grace applies to the notebook; the vault
  // re-locks the moment it leaves the foreground.
  useEffect(() => {
    const onHidden = () => {
      if (!document.hidden) return;
      vaultRepo.lockVault();
      setPassword(null);
      setRevealedId(null);
      setRevealedValue(null);
      setCopyNotice(null);
      setUnlockPwd("");
      setPhase((current) => (current === "open" ? "locked" : current));
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      vaultRepo.lockVault();
    };
  }, []);

  const unlock = async () => {
    if (unlockPwd === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await vaultRepo.unlock(unlockPwd);
      setPassword(unlockPwd);
      setItems(await vaultRepo.listItems());
      setUnlockPwd("");
      setPhase("open");
    } catch (e) {
      setError(
        e instanceof Error && e.name === "WrongPasswordError"
          ? t("vault.error.wrongPassword")
          : t("mobile.loadFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  const toggleReveal = async (id: number) => {
    if (revealedId === id) {
      setRevealedId(null);
      setRevealedValue(null);
      setCopyNotice(null);
      return;
    }
    if (password === null) return;
    setError(null);
    setCopyNotice(null);
    try {
      const got = await vaultRepo.getItem(id, password);
      if (!got) {
        setError(t("mobile.vault.missing"));
        return;
      }
      setRevealedId(id);
      setRevealedValue(got.plaintext);
    } catch {
      setRevealedId(null);
      setRevealedValue(null);
      setError(t("mobile.vault.decryptFailed"));
    }
  };

  const copy = async (value: string) => {
    setError(null);
    try {
      if (isAndroidPlatform()) {
        // The one proven sensitive path: IS_SENSITIVE-marked, cleared by the
        // native timer. The notice repeats that the clear is best effort.
        const delay = await copySensitive(value);
        setCopyNotice(
          t("notes.copyBestEffort", {
            seconds: String(Math.round(delay / 1000)),
          }),
        );
      } else {
        await navigator.clipboard.writeText(value);
        setCopyNotice(t("notes.copied"));
      }
    } catch {
      setError(t("common.tryAgain"));
    }
  };

  return (
    <section className="mobile-page">
      <p className="mobile-section-kicker">{t("nav.vault")}</p>
      <p className="muted">{t("mobile.vault.noCreate")}</p>

      {phase === "error" ? (
        <>
          <LoadMessage failed />
          <button
            type="button"
            className="mobile-link-btn"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            {t("common.tryAgain")}
          </button>
        </>
      ) : null}

      {phase === "unset" ? (
        <EmptyState>{t("mobile.vault.notSetUp")}</EmptyState>
      ) : null}

      {phase === "locked" ? (
        <>
          <p className="muted">{t("mobile.vault.lockedHint")}</p>
          {items.length === 0 ? (
            <EmptyState>{t("mobile.vault.empty")}</EmptyState>
          ) : (
            <ul className="mobile-list" aria-label={t("mobile.vault.listAria")}>
              {items.map((item) => (
                <li key={item.id} className="mobile-card">
                  <span className="mobile-card-title">{item.title}</span>
                  <span className="mobile-card-meta">{item.updated_at}</span>
                </li>
              ))}
            </ul>
          )}
          <form
            className="mobile-form"
            onSubmit={(event) => {
              event.preventDefault();
              void unlock();
            }}
          >
            <label className="mobile-field">
              <span>{t("vault.password")}</span>
              <input
                className="input"
                type="password"
                value={unlockPwd}
                autoComplete="current-password"
                onChange={(event) => setUnlockPwd(event.currentTarget.value)}
              />
            </label>
            {error !== null ? (
              <p className="mobile-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="mobile-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || unlockPwd === ""}
              >
                {busy ? t("vault.unlocking") : t("vault.unlock")}
              </button>
            </div>
          </form>
        </>
      ) : null}

      {phase === "open" ? (
        <>
          {items.length === 0 ? (
            <EmptyState>{t("mobile.vault.empty")}</EmptyState>
          ) : (
            <p className="muted">{t("mobile.vault.revealHint")}</p>
          )}
          <ul className="mobile-list" aria-label={t("mobile.vault.listAria")}>
            {items.map((item) => {
              const open = revealedId === item.id;
              return (
                <li key={item.id} className="mobile-card">
                  <button
                    type="button"
                    className="mobile-card-btn"
                    aria-expanded={open}
                    onClick={() => void toggleReveal(item.id)}
                  >
                    <span className="mobile-card-title">{item.title}</span>
                    <span className="mobile-card-meta">
                      {open ? t("vault.hide") : t("vault.reveal")}
                    </span>
                  </button>
                  {open && revealedValue !== null ? (
                    <>
                      <p className="mobile-secret">{revealedValue}</p>
                      <div className="mobile-actions">
                        <button
                          type="button"
                          className="btn"
                          onClick={() => void copy(revealedValue)}
                        >
                          {t("mobile.vault.copy")}
                        </button>
                      </div>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="muted">
            {t("mobile.vault.copyDisclosure", {
              seconds: String(VAULT_CLIPBOARD_SECONDS),
            })}
          </p>
          {copyNotice !== null ? (
            <p className="mobile-saved" role="status">
              {copyNotice}
            </p>
          ) : null}
          {error !== null ? (
            <p className="mobile-error" role="alert">
              {error}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
