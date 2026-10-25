// P3e Address book page: contacts with phone/email/other channels
// (primary flag + order), tags, addresses and birthdays (full date or
// month-day). Talks only to the contacts repo from the composition root

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { ImportDialog } from "../components/ImportDialog.tsx";
import {
  IconCalendar,
  IconContacts,
  IconEdit,
  IconSearch,
  IconTrash,
  IconUpload,
} from "../components/icons.tsx";
import { LinksSection } from "../components/LinksSection.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { useToast } from "../components/Toast.tsx";
import { usePlural, useT } from "../components/useTranslation.ts";
import { contactsRepo, insertImportedContacts } from "../data/app.ts";
import { mapContactRows } from "../lib/contactImport.ts";
import {
  birthdayLabel,
  normalizeMonthDay,
  searchContacts,
} from "../lib/contacts.ts";
import { parseCsv } from "../lib/csv.ts";
import { errText } from "../lib/errors.ts";
import { createLoadGuard } from "../lib/loads.ts";
import { missingRowMessage } from "../lib/navigation.ts";
import type {
  ContactChannelKind,
  ContactChannelRow,
  ContactRow,
  LinkableEntity,
} from "../lib/types.ts";

type BirthdayMode = "none" | "date" | "monthday";

/**
 * The template CSV the import dialog hands out: the exact header the mapper
 * reads, plus one example row whose quoted address shows how to keep a comma
 * inside a cell.
 */
const CONTACTS_TEMPLATE_CSV =
  "name,phones,emails,others,address,birthday,notes,tags\n" +
  'Mary Jones,+95 9 123 456;+95 9 777 888,mary@example.com,Telegram @mary,"12 Market Road, Yangon",1990-04-18,Met at the market,friends;supplier\n';

function modeOf(birthday: string | null): BirthdayMode {
  if (birthday === null || birthday.length === 0) return "none";
  return birthday.length >= 10 ? "date" : "monthday";
}

const CHANNEL_KINDS: { key: ContactChannelKind; label: string }[] = [
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "other", label: "Other" },
];

/**
 * Stable per-name avatar colour. FNV-ish over the characters, so the same
 * contact keeps the same swatch across sessions and machines.
 */
function avatarClass(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return `contact-avatar contact-avatar-gradient is-g${hash % 5}`;
}

interface ContactsPageProps {
  /**
   * The contact to open on arrival, from a relationship click.
   *
   * This page already loads its detail pane BY ID rather than from the loaded
   * list, so arriving at one contact needs no filter juggling — it works even
   * when the search box would have hidden that row.
   */
  focusId: number | null;
  focusToken?: number;
  onOpenEntity: (entity: LinkableEntity) => void;
}

export default function ContactsPage(p: ContactsPageProps) {
  const t = useT();
  const plural = usePlural();
  const toast = useToast();
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [focusMissing, setFocusMissing] = useState(false);
  const [detail, setDetail] = useState<{
    contact: ContactRow | undefined;
    channels: ContactChannelRow[];
    tags: string[];
  } | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  /**
   * `savingRef` is the authoritative add-contact guard and the state is what
   * the button reads — the pinned money-form shape (review P3-6): a double
   * submit would create two contacts, and no layer below the UI can tell a
   * retry from a second click.
   */
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [birthdayError, setBirthdayError] = useState<string | null>(null);
  const [edit, setEdit] = useState({
    name: "",
    address: "",
    mode: "none" as BirthdayMode,
    birthday: "",
    notes: "",
  });
  const [channelDraft, setChannelDraft] = useState({
    kind: "phone" as ContactChannelKind,
    value: "",
    primary: false,
  });
  const [newTag, setNewTag] = useState("");
  /** Guards the detail pane against an out-of-order select. */
  const detailGuard = useMemo(() => createLoadGuard(), []);

  const reload = useCallback(async () => {
    try {
      setContacts(await contactsRepo.listContacts());
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Refresh the open contact.
   *
   * `repopulateForm` is the whole point. The channel and tag
   * actions all refresh the detail, but the row they read back has the
   * *stored* name/address/birthday/notes — so repopulating the edit form from it
   * silently threw away whatever the user had typed. Only selecting a different
   * contact (or a save, where the form already holds what was written) may
   * overwrite the form.
   */
  const reloadDetail = useCallback(
    async (id: number | null, repopulateForm: boolean) => {
      if (id === null) {
        setDetail(null);
        return;
      }
      // Clicking contact A then B can resolve in the other order, which left A's
      // detail rendered under B.
      const token = detailGuard.begin();
      try {
        const d = await contactsRepo.getContactDetail(id);
        if (!detailGuard.isCurrent(token)) return;
        setDetail(d);
        if (d.contact && repopulateForm) {
          setEdit({
            name: d.contact.name,
            address: d.contact.address,
            mode: modeOf(d.contact.birthday),
            birthday: d.contact.birthday ?? "",
            notes: d.contact.notes,
          });
        }
        setError(null);
      } catch (e) {
        if (detailGuard.isCurrent(token)) setError(errText(e));
      }
    },
    [detailGuard],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  const select = async (id: number) => {
    setSelectedId(id);
    setBirthdayError(null);
    // A different contact: the old form's unsaved edits are deliberately gone.
    await reloadDetail(id, true);
  };

  /**
   * Arrive at one exact contact.
   *
   * The detail pane loads by id, so this is the same path a click in the list
   * takes — no filter or search is cleared, because neither of them keeps a row
   * out of the pane. A contact that is gone says so instead of rendering an
   * empty pane that looks like a broken link.
   *
   * `select` is deliberately not a dependency: it is re-created every render, so
   * including it would re-run this effect on every keystroke anywhere. The
   * focus token also makes a repeated jump to this same contact intentional.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: select is recreated per render
  useEffect(() => {
    const focusId = p.focusId;
    if (focusId === null) return;
    let cancelled = false;
    (async () => {
      try {
        const found = await contactsRepo.getContact(focusId);
        if (cancelled) return;
        if (!found) {
          setFocusMissing(true);
          setError(missingRowMessage("contact"));
          return;
        }
        setFocusMissing(false);
        if (selectedId === focusId) {
          await reloadDetail(focusId, false);
        } else {
          await select(focusId);
        }
      } catch (e) {
        if (!cancelled) setError(errText(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [p.focusId, p.focusToken, selectedId, reloadDetail]);

  const addContact = async () => {
    if (savingRef.current) return;
    const trimmed = newName.trim();
    if (trimmed.length === 0) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const id = await contactsRepo.createContact({ name: trimmed });
      setNewName("");
      await reload();
      await select(id);
    } catch (e) {
      setError(errText(e));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const removeContact = async (id: number) => {
    try {
      await contactsRepo.deleteContact(id);
      setSelectedId(null);
      setDetail(null);
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  /** Resolve the birthday field from the mode + raw input; null clears it. */
  const resolveBirthday = (): {
    value: string | null;
    error: string | null;
  } => {
    if (edit.mode === "none") return { value: null, error: null };
    const raw = edit.birthday.trim();
    if (raw.length === 0) return { value: null, error: null };
    if (edit.mode === "date") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw))
        return { value: null, error: "Birthday must be a valid date." };
      return { value: raw, error: null };
    }
    const normalized = normalizeMonthDay(raw);
    if (normalized === null)
      return {
        value: null,
        error: "Month-day must be between 01-01 and 12-31.",
      };
    return { value: normalized, error: null };
  };

  const saveContact = async () => {
    if (selectedId === null || edit.name.trim().length === 0) return;
    const birthday = resolveBirthday();
    setBirthdayError(birthday.error);
    if (birthday.error !== null) return;
    try {
      await contactsRepo.updateContact(selectedId, {
        name: edit.name.trim(),
        address: edit.address.trim(),
        birthday: birthday.value,
        notes: edit.notes,
      });
      await reload();
      // A save may repopulate: the form already holds exactly what was
      // written, so this only normalises the trimmed values back into it.
      await reloadDetail(selectedId, true);
    } catch (e) {
      setError(errText(e));
    }
  };

  const addChannel = async () => {
    const value = channelDraft.value.trim();
    if (selectedId === null || value.length === 0) return;
    try {
      await contactsRepo.addChannel({
        contactId: selectedId,
        kind: channelDraft.kind,
        value,
        isPrimary: channelDraft.primary,
      });
      setChannelDraft({ kind: "phone", value: "", primary: false });
      await reloadDetail(selectedId, false);
    } catch (e) {
      setError(errText(e));
    }
  };

  const makePrimary = async (channelId: number) => {
    if (selectedId === null) return;
    try {
      await contactsRepo.setPrimaryChannel(selectedId, channelId);
      await reloadDetail(selectedId, false);
    } catch (e) {
      setError(errText(e));
    }
  };

  const removeChannel = async (channelId: number) => {
    if (selectedId === null) return;
    try {
      await contactsRepo.deleteChannel(channelId);
      await reloadDetail(selectedId, false);
    } catch (e) {
      setError(errText(e));
    }
  };

  const addTag = async () => {
    const tag = newTag.trim();
    if (selectedId === null || tag.length === 0) return;
    try {
      await contactsRepo.addTag(selectedId, tag);
      setNewTag("");
      await reloadDetail(selectedId, false);
    } catch (e) {
      setError(errText(e));
    }
  };

  const removeTag = async (tag: string) => {
    if (selectedId === null) return;
    try {
      await contactsRepo.removeTag(selectedId, tag);
      await reloadDetail(selectedId, false);
    } catch (e) {
      setError(errText(e));
    }
  };

  const visible = searchContacts(contacts, search);
  const selectedContact = detail?.contact ?? null;

  return (
    <div className="budget-page">
      <header className="page-header">
        <div className="page-header-main">
          <div className="page-title-row">
            <span className="page-icon-badge">
              <IconContacts className="icon" />
            </span>
            <div>
              <h2 className="editor-title">Address Book</h2>
              <p className="page-subtitle">
                Personal &amp; business contacts, channels, tags &amp; birthdays
              </p>
            </div>
          </div>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setImportOpen(true)}
          >
            <IconUpload className="icon" />
            {t("contacts.importCsv")}
          </button>
        </div>
      </header>

      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="contacts-layout">
        <aside className="contacts-sidebar">
          <div className="dash-card-head">
            <span className="side-heading">Directory</span>
            <span className="badge">{contacts.length}</span>
          </div>
          <span className="input-icon-wrap">
            <input
              className="input"
              type="search"
              placeholder="Search contacts…"
              aria-label="Search contacts"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <IconSearch className="icon input-icon" />
          </span>

          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void addContact();
            }}
          >
            <input
              aria-label="New contact name"
              placeholder="New contact name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={saving || newName.trim().length === 0}
            >
              Add
            </button>
          </form>

          {loading ? (
            <Skeleton count={5} />
          ) : visible.length === 0 ? (
            <EmptyState>
              {contacts.length === 0
                ? "No contacts yet — add one above."
                : "No contact matches the search."}
            </EmptyState>
          ) : (
            <ul className="side-list">
              {visible.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className={
                      selectedId === c.id ? "side-btn is-active" : "side-btn"
                    }
                    onClick={() => void select(c.id)}
                  >
                    <span className="row-title">
                      <span className={avatarClass(c.name)}>
                        {c.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span>{c.name}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="contacts-detail">
          {detail && selectedContact ? (
            <>
              <div className="dash-card-head">
                <div className="row-title">
                  <span className={avatarClass(selectedContact.name)}>
                    {selectedContact.name.slice(0, 1).toUpperCase()}
                  </span>
                  <h3 className="settings-heading">{selectedContact.name}</h3>
                  {selectedContact.birthday ? (
                    <span className="badge badge-accent">
                      Birthday: {birthdayLabel(selectedContact.birthday)}
                    </span>
                  ) : null}
                </div>
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void saveContact()}
                  >
                    <IconEdit className="icon" /> Save
                  </button>
                  <ConfirmButton
                    className="btn btn-danger"
                    what="contact to Trash"
                    onConfirm={() => removeContact(selectedContact.id)}
                  >
                    <IconTrash className="icon" /> Move to Trash
                  </ConfirmButton>
                </div>
              </div>

              <div className="entry-form contact-form">
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      className="input"
                      value={edit.name}
                      onChange={(e) =>
                        setEdit({ ...edit, name: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Address
                    <input
                      className="input"
                      value={edit.address}
                      placeholder="Street, city…"
                      onChange={(e) =>
                        setEdit({ ...edit, address: e.target.value })
                      }
                    />
                  </label>
                </div>
                <label>
                  Birthday
                  <span className="editor-row">
                    <select
                      className="select"
                      aria-label="Birthday type"
                      value={edit.mode}
                      onChange={(e) =>
                        setEdit({
                          ...edit,
                          mode: e.target.value as BirthdayMode,
                          birthday: "",
                        })
                      }
                    >
                      <option value="none">No birthday</option>
                      <option value="date">Full date</option>
                      <option value="monthday">Month and day</option>
                    </select>
                    {edit.mode === "date" ? (
                      <span className="input-icon-wrap">
                        <input
                          className="input"
                          type="date"
                          aria-label="Birthday date"
                          value={
                            edit.birthday.length >= 10 ? edit.birthday : ""
                          }
                          onChange={(e) =>
                            setEdit({ ...edit, birthday: e.target.value })
                          }
                        />
                        <IconCalendar className="icon input-icon is-end" />
                      </span>
                    ) : null}
                    {edit.mode === "monthday" ? (
                      <input
                        className="input"
                        aria-label="Birthday month and day"
                        placeholder="MM-DD"
                        value={edit.birthday}
                        onChange={(e) =>
                          setEdit({ ...edit, birthday: e.target.value })
                        }
                      />
                    ) : null}
                  </span>
                </label>
                {birthdayError ? (
                  <p className="limit-warn" role="alert">
                    {birthdayError}
                  </p>
                ) : null}
                <label>
                  Notes
                  <textarea
                    className="textarea"
                    rows={3}
                    value={edit.notes}
                    onChange={(e) =>
                      setEdit({ ...edit, notes: e.target.value })
                    }
                  />
                </label>
              </div>

              <section className="contact-detail-section">
                <h3 className="side-heading">Channels</h3>
                {detail.channels.length === 0 ? (
                  <p className="muted">No channels yet.</p>
                ) : (
                  <ul className="budget-list">
                    {detail.channels.map((ch) => (
                      <li key={ch.id} className="budget-row">
                        <span className="row-title">
                          <span className="chip">
                            {CHANNEL_KINDS.find((k) => k.key === ch.kind)
                              ?.label ?? ch.kind}
                          </span>{" "}
                          <b>{ch.value}</b>
                          {ch.is_primary === 1 ? (
                            <span className="chip chip-accent">Primary</span>
                          ) : null}
                        </span>
                        <span className="row-actions">
                          {ch.is_primary === 1 ? null : (
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() => void makePrimary(ch.id)}
                            >
                              Make primary
                            </button>
                          )}
                          <ConfirmButton
                            className="btn btn-ghost"
                            what={`channel ${ch.kind}`}
                            onConfirm={() => removeChannel(ch.id)}
                          >
                            Delete
                          </ConfirmButton>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <form
                  className="inline-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void addChannel();
                  }}
                >
                  <select
                    className="select"
                    aria-label="Channel kind"
                    value={channelDraft.kind}
                    onChange={(e) =>
                      setChannelDraft({
                        ...channelDraft,
                        kind: e.target.value as ContactChannelKind,
                      })
                    }
                  >
                    {CHANNEL_KINDS.map((k) => (
                      <option key={k.key} value={k.key}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label="Channel value"
                    placeholder="09… or name@mail.com"
                    value={channelDraft.value}
                    onChange={(e) =>
                      setChannelDraft({
                        ...channelDraft,
                        value: e.target.value,
                      })
                    }
                  />
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={channelDraft.primary}
                      onChange={(e) =>
                        setChannelDraft({
                          ...channelDraft,
                          primary: e.target.checked,
                        })
                      }
                    />
                    Primary
                  </label>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={channelDraft.value.trim().length === 0}
                  >
                    Add channel
                  </button>
                </form>
              </section>

              <section className="contact-detail-section">
                <h3 className="side-heading">Tags</h3>
                {detail.tags.length === 0 ? (
                  <p className="muted">No tags yet.</p>
                ) : (
                  <div className="note-meta">
                    {detail.tags.map((tag) => (
                      <span key={tag} className="chip">
                        {tag}
                        <button
                          type="button"
                          className="side-remove"
                          aria-label={`Remove tag ${tag}`}
                          onClick={() => void removeTag(tag)}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <form
                  className="inline-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void addTag();
                  }}
                >
                  <input
                    aria-label="New tag"
                    placeholder="Tag (e.g. family, VIP)"
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="btn"
                    disabled={newTag.trim().length === 0}
                  >
                    Add tag
                  </button>
                </form>
              </section>
              {/* Relationships live with the contact they belong to. */}
              <LinksSection
                entity={{ type: "contact", id: selectedContact.id }}
                onOpenEntity={p.onOpenEntity}
              />
            </>
          ) : (
            <EmptyState>
              {focusMissing
                ? missingRowMessage("contact")
                : "Select a contact on the left, or add a new one."}
            </EmptyState>
          )}
        </section>
      </div>

      {importOpen ? (
        <ImportDialog
          title={t("contacts.importTitle")}
          templateCsv={CONTACTS_TEMPLATE_CSV}
          templateName="purple-memo-contacts-template.csv"
          onPick={async (file) => file.text()}
          parse={(text) => mapContactRows(parseCsv(text, ["name"]).rows)}
          onConfirm={async (rows) => {
            // One batch; a failure throws before the list refresh and the
            // toast, and the dialog keeps its preview for a retry.
            await insertImportedContacts(rows);
            await reload();
            toast.success(plural("contacts.imported", rows.length));
            return { imported: rows.length };
          }}
          onClose={() => setImportOpen(false)}
        />
      ) : null}
    </div>
  );
}
