// P3e Vault page: password-protected secrets. The password is proven
// by decrypting items (AES-256-GCM) — there is NO recovery, and the UI says
// so before the password is set. The password lives in this page's memory
// only; P3f adds the app-wide auto-lock on top of the repo's lockVault.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { IconLock, IconVault } from "../components/icons.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { useT } from "../components/useTranslation.ts";
import { vaultRepo } from "../data/app.ts";
import { errText } from "../lib/errors.ts";
import { createLoadGuard } from "../lib/loads.ts";
import { WrongPasswordError } from "../lib/vault.ts";

/**
 * `unavailable` exists because of B12: a failed `isSetUp()` read used to fall
 * through to `setup`, so a locked database or a broken IPC call rendered
 * "Set a vault password" — a confident, wrong sentence next to the
 * no-recovery warning, inviting the user to type a NEW password over a vault
 * that is fine. A failure now has its own screen.
 */
type VaultPhase = "loading" | "unavailable" | "setup" | "unlock" | "open";

interface ItemMeta {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}

const MIN_PASSWORD = 6;

/**
 * The honest message for a failed vault operation. Only a
 * `WrongPasswordError` may claim the password was wrong: a locked database or
 * a failed write is a different problem, and telling the user "wrong password,
 * nothing was changed" about a write that actually committed left them unable
 * to open their own vault with no explanation.
 */
function vaultErrorText(e: unknown, wrongPassword: string): string {
  return e instanceof WrongPasswordError ? wrongPassword : errText(e);
}

export default function VaultPage() {
  const t = useT();
  const [phase, setPhase] = useState<VaultPhase>("loading");
  const [password, setPassword] = useState<string | null>(null);
  const [items, setItems] = useState<ItemMeta[]>([]);
  const [revealed, setRevealed] = useState<Map<number, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState({ pwd: "", confirm: "" });
  const [unlockPwd, setUnlockPwd] = useState("");
  const [draft, setDraft] = useState({ title: "", secret: "" });
  const [edit, setEdit] = useState<{
    id: number;
    title: string;
    secret: string;
  } | null>(null);
  const [change, setChange] = useState({
    open: false,
    old: "",
    next: "",
    confirm: "",
  });
  /** Guards the list against an out-of-order read (B6). */
  const listGuard = useMemo(() => createLoadGuard(), []);
  /** Guards the reveal map — and cancels in-flight reveals on lock (B6). */
  const revealGuard = useMemo(() => createLoadGuard(), []);
  /**
   * Guards the edit form against an out-of-order `getItem` (B6): a cold item
   * costs 600k PBKDF2 iterations before it decrypts, so clicking Edit on A and
   * then B could open A's secret if A resolved last — under B's title.
   */
  const editGuard = useMemo(() => createLoadGuard(), []);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * Read whether the vault exists yet — the one call that decides between the
   * setup and unlock screens. Its failure is B12: reported as `unavailable`
   * with the real error, never as "there is no vault yet".
   */
  const readSetUp = useCallback(async () => {
    setPhase("loading");
    setError(null);
    try {
      const setUp = await vaultRepo.isSetUp();
      if (mountedRef.current) setPhase(setUp ? "unlock" : "setup");
    } catch (e) {
      if (mountedRef.current) {
        setError(errText(e));
        setPhase("unavailable");
      }
    }
  }, []);

  useEffect(() => {
    void readSetUp();
  }, [readSetUp]);

  const loadItems = useCallback(async () => {
    const token = listGuard.begin();
    try {
      const rows = await vaultRepo.listItems();
      if (!listGuard.isCurrent(token)) return; // superseded by a newer read
      setItems(rows);
      setError(null);
    } catch (e) {
      if (listGuard.isCurrent(token)) setError(errText(e));
    }
  }, [listGuard]);

  const doSetup = async () => {
    // Refuses a second submit while one is in flight: the marker INSERT is
    // deliberately not an upsert, so two racing setups would make the second
    // one fail on a UNIQUE violation the user never caused.
    if (busy) return;
    if (setup.pwd.length < MIN_PASSWORD) {
      setError(t("vault.error.passwordShort", { min: MIN_PASSWORD }));
      return;
    }
    if (setup.pwd !== setup.confirm) {
      setError(t("vault.error.noMatch"));
      return;
    }
    setBusy(true);
    try {
      await vaultRepo.setupVault(setup.pwd);
      setPassword(setup.pwd);
      setSetup({ pwd: "", confirm: "" });
      setPhase("open");
      setError(null);
      await loadItems();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const doUnlock = async () => {
    setBusy(true);
    try {
      await vaultRepo.unlock(unlockPwd);
      setPassword(unlockPwd);
      setUnlockPwd("");
      setPhase("open");
      setError(null);
      await loadItems();
    } catch (e) {
      setError(vaultErrorText(e, t("vault.error.wrongPassword")));
    } finally {
      setBusy(false);
    }
  };

  const doLock = () => {
    vaultRepo.lockVault();
    // Nothing the in-flight loads write may land after the lock (B6): the repo
    // has already dropped its keys, so a reveal/edit/list read that was
    // mid-await must not repopulate the screen the lock just cleared.
    revealGuard.cancel();
    editGuard.cancel();
    listGuard.cancel();
    setPassword(null);
    setRevealed(new Map());
    setEdit(null);
    // Everything holding plaintext goes, not just what is on screen (B3):
    // `draft` is the new-secret title + secret in a plain textarea, and
    // `change` holds the typed passwords — `change.old` is a credential and
    // must not outlive the form, while `change.open` would otherwise bring the
    // half-filled form back after the next unlock. `error` belongs to the
    // session that just ended.
    setDraft({ title: "", secret: "" });
    setChange({ open: false, old: "", next: "", confirm: "" });
    setError(null);
    setItems([]);
    setPhase("unlock");
  };

  const addItem = async () => {
    // A second click before the re-render would insert the same secret twice.
    if (busy) return;
    if (password === null) return;
    const title = draft.title.trim();
    if (title.length === 0 || draft.secret.length === 0) return;
    setBusy(true);
    try {
      await vaultRepo.addItem(title, draft.secret, password);
      setDraft({ title: "", secret: "" });
      await loadItems();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleReveal = async (id: number) => {
    if (password === null) return;
    if (revealed.has(id)) {
      const next = new Map(revealed);
      next.delete(id);
      setRevealed(next);
      return;
    }
    const token = revealGuard.begin();
    try {
      const got = await vaultRepo.getItem(id, password);
      if (!revealGuard.isCurrent(token)) return; // superseded (or locked)
      if (got) {
        const next = new Map(revealed);
        next.set(id, got.plaintext);
        setRevealed(next);
      }
    } catch (e) {
      if (!revealGuard.isCurrent(token)) return;
      setError(vaultErrorText(e, t("vault.error.wrongItem")));
    }
  };

  const startEdit = async (item: ItemMeta) => {
    if (password === null) return;
    const token = editGuard.begin();
    try {
      const got = await vaultRepo.getItem(item.id, password);
      // A slower older getItem must not reopen the previously clicked item
      // (B6) — the last click decides which secret the form holds.
      if (!editGuard.isCurrent(token)) return;
      setEdit({ id: item.id, title: item.title, secret: got?.plaintext ?? "" });
    } catch (e) {
      if (!editGuard.isCurrent(token)) return;
      setError(vaultErrorText(e, t("vault.error.wrongItem")));
    }
  };

  const saveEdit = async () => {
    if (busy) return;
    if (password === null || edit === null) return;
    const title = edit.title.trim();
    if (title.length === 0 || edit.secret.length === 0) return;
    setBusy(true);
    try {
      await vaultRepo.updateItem(
        edit.id,
        { title, plaintext: edit.secret },
        password,
      );
      setEdit(null);
      const next = new Map(revealed);
      next.delete(edit.id);
      setRevealed(next);
      await loadItems();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const removeItem = async (id: number) => {
    try {
      await vaultRepo.deleteItem(id);
      const next = new Map(revealed);
      next.delete(id);
      setRevealed(next);
      if (edit?.id === id) setEdit(null);
      await loadItems();
    } catch (e) {
      setError(errText(e));
    }
  };

  const doChangePassword = async () => {
    // Two re-encryption batches must not overlap: the second would carry the
    // OLD `change.old` and report "wrong current password" over a change that
    // already landed.
    if (busy) return;
    if (change.old.length === 0) return;
    if (change.next.length < MIN_PASSWORD) {
      setError(t("vault.error.newPasswordShort", { min: MIN_PASSWORD }));
      return;
    }
    if (change.next !== change.confirm) {
      setError(t("vault.error.newNoMatch"));
      return;
    }
    setBusy(true);
    try {
      await vaultRepo.changePassword(change.old, change.next);
      setPassword(change.next);
      setChange({ open: false, old: "", next: "", confirm: "" });
      setError(null);
      // `changePassword` rewrites every row with a fresh salt, ciphertext AND
      // `updated_at` (B7) — the only vault write that did not refresh the list,
      // so every "updated" chip kept its old date until the page was revisited.
      await loadItems();
    } catch (e) {
      setError(vaultErrorText(e, t("vault.error.wrongCurrent")));
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <header className="page-header">
      <div className="page-header-main">
        <div className="page-title-row">
          <span className="page-icon-badge">
            <IconVault className="icon" />
          </span>
          <div>
            <h2 className="editor-title">{t("vault.title")}</h2>
            <p className="page-subtitle">{t("vault.subtitle")}</p>
          </div>
        </div>
      </div>
      {phase === "open" ? (
        <div className="page-actions">
          <button
            type="button"
            className={change.open ? "btn is-on" : "btn"}
            onClick={() => setChange({ ...change, open: !change.open })}
          >
            {t("vault.changePassword")}
          </button>
          <button type="button" className="btn" onClick={doLock}>
            <IconLock className="icon" /> {t("vault.lock")}
          </button>
        </div>
      ) : null}
    </header>
  );

  if (phase === "loading") {
    return (
      <div className="budget-page">
        {header}
        <Skeleton variant="card" />
      </div>
    );
  }

  // B12: the vault state could not be read, so we do not know whether there is
  // a vault. Saying so is the only honest rendering — and the retry button is
  // the way back, rather than a setup form the user must not fill in.
  if (phase === "unavailable") {
    return (
      <div className="budget-page">
        {header}
        {error ? (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        ) : null}
        <EmptyState>{t("vault.unavailable")}</EmptyState>
        <div className="editor-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void readSetUp()}
          >
            {t("common.tryAgain")}
          </button>
        </div>
      </div>
    );
  }

  if (phase === "setup") {
    return (
      <div className="budget-page">
        {header}
        {error ? (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        ) : null}
        <form
          className="entry-form vault-narrow"
          onSubmit={(e) => {
            e.preventDefault();
            void doSetup();
          }}
        >
          <div className="lock-brand-head">
            <span className="page-icon-badge">
              <IconVault className="icon" />
            </span>
            <h2 className="editor-title">{t("vault.setupHeading")}</h2>
          </div>
          <p className="alert alert-error" role="note">
            {t("vault.noRecovery")}
          </p>
          <label>
            {t("vault.passwordAtLeast", { min: MIN_PASSWORD })}
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={setup.pwd}
              onChange={(e) => setSetup({ ...setup, pwd: e.target.value })}
            />
          </label>
          <label>
            {t("vault.confirmPassword")}
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={setup.confirm}
              onChange={(e) => setSetup({ ...setup, confirm: e.target.value })}
            />
          </label>
          <div className="editor-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || setup.pwd.length === 0}
            >
              {busy ? t("vault.settingUp") : t("vault.setPassword")}
            </button>
          </div>
        </form>
      </div>
    );
  }

  if (phase === "unlock") {
    return (
      <div className="budget-page">
        {header}
        {error ? (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        ) : null}
        <form
          className="entry-form vault-narrow"
          onSubmit={(e) => {
            e.preventDefault();
            void doUnlock();
          }}
        >
          <div className="lock-brand-head">
            <span className="page-icon-badge">
              <IconLock className="icon" />
            </span>
            <h2 className="editor-title">{t("vault.lockedHeading")}</h2>
            <p className="page-subtitle">{t("vault.lockedSubtitle")}</p>
          </div>
          <label>
            {t("vault.password")}
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={unlockPwd}
              onChange={(e) => setUnlockPwd(e.target.value)}
            />
          </label>
          <div className="editor-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || unlockPwd.length === 0}
            >
              {busy ? t("vault.unlocking") : t("vault.unlock")}
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="budget-page">
      {header}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      {change.open ? (
        <form
          className="entry-form vault-narrow"
          onSubmit={(e) => {
            e.preventDefault();
            void doChangePassword();
          }}
        >
          <h3 className="side-heading">{t("vault.changeHeading")}</h3>
          <label>
            {t("vault.currentPassword")}
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={change.old}
              onChange={(e) => setChange({ ...change, old: e.target.value })}
            />
          </label>
          <label>
            {t("vault.newPassword")}
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={change.next}
              onChange={(e) => setChange({ ...change, next: e.target.value })}
            />
          </label>
          <label>
            {t("vault.confirmNewPassword")}
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={change.confirm}
              onChange={(e) =>
                setChange({ ...change, confirm: e.target.value })
              }
            />
          </label>
          <div className="editor-actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? t("vault.reencrypting") : t("vault.changePassword")}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() =>
                setChange({ open: false, old: "", next: "", confirm: "" })
              }
            >
              {t("common.cancel")}
            </button>
          </div>
        </form>
      ) : null}

      <div className="split-workspace-grid">
        <section className="settings-section" aria-label={t("vault.itemsAria")}>
          <div className="dash-card-head">
            <h3 className="side-heading">{t("vault.storedSecrets")}</h3>
            <span className="badge">{items.length}</span>
          </div>
          {items.length === 0 ? (
            <EmptyState>{t("vault.empty")}</EmptyState>
          ) : (
            <ul className="budget-list">
              {items.map((item) => (
                <li key={item.id} className="budget-row">
                  <div className="row-main">
                    <span className="row-title">
                      <b>{item.title}</b>
                      <span className="chip figure">
                        {t("vault.updated", { date: item.updated_at })}
                      </span>
                    </span>
                    {revealed.has(item.id) ? (
                      <span className="vault-secret">
                        {revealed.get(item.id)}
                      </span>
                    ) : null}
                  </div>
                  <span className="row-actions">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => void toggleReveal(item.id)}
                    >
                      {revealed.has(item.id)
                        ? t("vault.hide")
                        : t("vault.reveal")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => void startEdit(item)}
                    >
                      {t("vault.edit")}
                    </button>
                    <ConfirmButton
                      className="btn btn-ghost"
                      what={t("vault.deleteWhat")}
                      onConfirm={() => removeItem(item.id)}
                    >
                      {t("common.delete")}
                    </ConfirmButton>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {edit ? (
            <form
              className="entry-form"
              onSubmit={(e) => {
                e.preventDefault();
                void saveEdit();
              }}
            >
              <h3 className="side-heading">{t("vault.editHeading")}</h3>
              <label>
                {t("vault.titleField")}
                <input
                  className="input"
                  value={edit.title}
                  onChange={(e) => setEdit({ ...edit, title: e.target.value })}
                />
              </label>
              <label>
                {t("vault.secretField")}
                <textarea
                  className="textarea"
                  rows={3}
                  value={edit.secret}
                  onChange={(e) => setEdit({ ...edit, secret: e.target.value })}
                />
              </label>
              <div className="editor-actions">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={
                    busy ||
                    edit.title.trim().length === 0 ||
                    edit.secret.length === 0
                  }
                >
                  {t("vault.save")}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setEdit(null)}
                >
                  {t("common.cancel")}
                </button>
              </div>
            </form>
          ) : null}
        </section>

        <form
          className="entry-form"
          onSubmit={(e) => {
            e.preventDefault();
            void addItem();
          }}
        >
          <h3 className="side-heading">{t("vault.newHeading")}</h3>
          <label>
            {t("vault.titleField")}
            <input
              className="input"
              placeholder={t("vault.titlePlaceholder")}
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label>
            {t("vault.secretField")}
            <textarea
              className="textarea"
              rows={4}
              placeholder={t("vault.secretPlaceholder")}
              value={draft.secret}
              onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
            />
          </label>
          <div className="editor-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={
                busy ||
                draft.title.trim().length === 0 ||
                draft.secret.length === 0
              }
            >
              {t("vault.addSecret")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
