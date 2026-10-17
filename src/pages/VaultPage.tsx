// P3e Vault page (§5.3): password-protected secrets. The password is proven
// by decrypting items (AES-256-GCM) — there is NO recovery, and the UI says
// so before the password is set. The password lives in this page's memory
// only; P3f adds the app-wide auto-lock on top of the repo's lockVault.

import { useCallback, useEffect, useState } from "react";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { IconLock, IconVault } from "../components/icons.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { vaultRepo } from "../data/app.ts";
import { errText } from "../lib/errors.ts";
import { WrongPasswordError } from "../lib/vault.ts";

type VaultPhase = "loading" | "setup" | "unlock" | "open";

interface ItemMeta {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}

const MIN_PASSWORD = 6;

/**
 * The honest message for a failed vault operation (review C-1). Only a
 * `WrongPasswordError` may claim the password was wrong: a locked database or
 * a failed write is a different problem, and telling the user "wrong password,
 * nothing was changed" about a write that actually committed left them unable
 * to open their own vault with no explanation.
 */
function vaultErrorText(e: unknown, wrongPassword: string): string {
  return e instanceof WrongPasswordError ? wrongPassword : errText(e);
}

export default function VaultPage() {
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const setUp = await vaultRepo.isSetUp();
        if (!cancelled) setPhase(setUp ? "unlock" : "setup");
      } catch (e) {
        if (!cancelled) {
          setError(errText(e));
          setPhase("setup");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadItems = useCallback(async () => {
    try {
      setItems(await vaultRepo.listItems());
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  const doSetup = async () => {
    if (setup.pwd.length < MIN_PASSWORD) {
      setError(`Password must be at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (setup.pwd !== setup.confirm) {
      setError("Passwords do not match.");
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
      setError(vaultErrorText(e, "Wrong password — nothing was unlocked."));
    } finally {
      setBusy(false);
    }
  };

  const doLock = () => {
    vaultRepo.lockVault();
    setPassword(null);
    setRevealed(new Map());
    setEdit(null);
    setItems([]);
    setPhase("unlock");
  };

  const addItem = async () => {
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
    try {
      const got = await vaultRepo.getItem(id, password);
      if (got) {
        const next = new Map(revealed);
        next.set(id, got.plaintext);
        setRevealed(next);
      }
    } catch (e) {
      setError(
        vaultErrorText(e, "Could not decrypt this item — wrong password."),
      );
    }
  };

  const startEdit = async (item: ItemMeta) => {
    if (password === null) return;
    try {
      const got = await vaultRepo.getItem(item.id, password);
      setEdit({ id: item.id, title: item.title, secret: got?.plaintext ?? "" });
    } catch (e) {
      setError(
        vaultErrorText(e, "Could not decrypt this item — wrong password."),
      );
    }
  };

  const saveEdit = async () => {
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
    if (change.old.length === 0) return;
    if (change.next.length < MIN_PASSWORD) {
      setError(`New password must be at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (change.next !== change.confirm) {
      setError("New passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await vaultRepo.changePassword(change.old, change.next);
      setPassword(change.next);
      setChange({ open: false, old: "", next: "", confirm: "" });
      setError(null);
    } catch (e) {
      setError(
        vaultErrorText(e, "Wrong current password — nothing was changed."),
      );
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
            <h2 className="editor-title">Encrypted Vault</h2>
            <p className="page-subtitle">
              Per-item AES-256-GCM encrypted secrets derived via PBKDF2-SHA256
              (600k iterations)
            </p>
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
            Change password
          </button>
          <button type="button" className="btn" onClick={doLock}>
            <IconLock className="icon" /> Lock vault
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
            <h2 className="editor-title">Set a vault password</h2>
          </div>
          <p className="alert alert-error" role="note">
            There is NO recovery. If you forget this password, your secrets
            cannot be recovered by anyone — not even on this machine. Store it
            somewhere safe before you continue.
          </p>
          <label>
            Password (at least {MIN_PASSWORD} characters)
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={setup.pwd}
              onChange={(e) => setSetup({ ...setup, pwd: e.target.value })}
            />
          </label>
          <label>
            Confirm password
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
              {busy ? "Setting up…" : "Set password"}
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
            <h2 className="editor-title">Vault locked</h2>
            <p className="page-subtitle">
              Enter your vault password to decrypt and manage secrets.
            </p>
          </div>
          <label>
            Password
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
              {busy ? "Unlocking…" : "Unlock"}
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
          <h3 className="side-heading">Change vault password</h3>
          <label>
            Current password
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={change.old}
              onChange={(e) => setChange({ ...change, old: e.target.value })}
            />
          </label>
          <label>
            New password
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={change.next}
              onChange={(e) => setChange({ ...change, next: e.target.value })}
            />
          </label>
          <label>
            Confirm new password
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
              {busy ? "Re-encrypting…" : "Change password"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() =>
                setChange({ open: false, old: "", next: "", confirm: "" })
              }
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <div className="split-workspace-grid">
        <section className="settings-section" aria-label="Vault items">
          <div className="dash-card-head">
            <h3 className="side-heading">Stored Secrets</h3>
            <span className="badge">{items.length}</span>
          </div>
          {items.length === 0 ? (
            <EmptyState>The vault is empty — add a secret.</EmptyState>
          ) : (
            <ul className="budget-list">
              {items.map((item) => (
                <li key={item.id} className="budget-row">
                  <div className="row-main">
                    <span className="row-title">
                      <b>{item.title}</b>
                      <span className="chip figure">
                        updated {item.updated_at}
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
                      {revealed.has(item.id) ? "Hide" : "Reveal"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => void startEdit(item)}
                    >
                      Edit
                    </button>
                    <ConfirmButton
                      className="btn btn-ghost"
                      what="secret"
                      onConfirm={() => removeItem(item.id)}
                    >
                      Delete
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
              <h3 className="side-heading">Edit secret</h3>
              <label>
                Title
                <input
                  className="input"
                  value={edit.title}
                  onChange={(e) => setEdit({ ...edit, title: e.target.value })}
                />
              </label>
              <label>
                Secret
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
                  Save
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setEdit(null)}
                >
                  Cancel
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
          <h3 className="side-heading">New secret</h3>
          <label>
            Title
            <input
              className="input"
              placeholder="e.g. Email login, Recovery seed"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label>
            Secret
            <textarea
              className="textarea"
              rows={4}
              placeholder="Password, note, recovery code…"
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
              Add secret
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
