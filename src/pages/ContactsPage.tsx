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
import { useLocale, usePlural, useT } from "../components/useTranslation.ts";
import { contactsRepo, insertImportedContacts } from "../data/app.ts";
import { CONTACT_CSV_ALIASES, mapContactRows } from "../lib/contactImport.ts";
import {
  birthdayLabel,
  contactInitial,
  normalizeMonthDay,
  searchContacts,
} from "../lib/contacts.ts";
import { parseCsv, readCsvFile } from "../lib/csv.ts";
import { isValidISODate } from "../lib/dates.ts";
import { errText } from "../lib/errors.ts";
import type { MessageKey } from "../lib/i18n.ts";
import { createLoadGuard } from "../lib/loads.ts";
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

const CHANNEL_KINDS: { key: ContactChannelKind; labelKey: MessageKey }[] = [
  { key: "phone", labelKey: "contacts.channelKind.phone" },
  { key: "email", labelKey: "contacts.channelKind.email" },
  { key: "other", labelKey: "contacts.channelKind.other" },
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
  const locale = useLocale();
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
          setError(t("contacts.missing"));
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
      if (!isValidISODate(raw))
        return { value: null, error: t("contacts.birthdayInvalidDate") };
      return { value: raw, error: null };
    }
    const normalized = normalizeMonthDay(raw);
    if (normalized === null)
      return {
        value: null,
        error: t("contacts.birthdayInvalidMonthDay"),
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

  const addingChannelRef = useRef(false);
  const [addingChannel, setAddingChannel] = useState(false);
  const addChannel = async () => {
    if (addingChannelRef.current) return;
    const value = channelDraft.value.trim();
    if (selectedId === null || value.length === 0) return;
    addingChannelRef.current = true;
    setAddingChannel(true);
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
    } finally {
      addingChannelRef.current = false;
      setAddingChannel(false);
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

  const addingTagRef = useRef(false);
  const [addingTag, setAddingTag] = useState(false);
  const addTag = async () => {
    if (addingTagRef.current) return;
    const tag = newTag.trim();
    if (selectedId === null || tag.length === 0) return;
    addingTagRef.current = true;
    setAddingTag(true);
    try {
      await contactsRepo.addTag(selectedId, tag);
      setNewTag("");
      await reloadDetail(selectedId, false);
    } catch (e) {
      setError(errText(e));
    } finally {
      addingTagRef.current = false;
      setAddingTag(false);
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

  const channelKindLabel = (kind: ContactChannelKind): string => {
    const entry = CHANNEL_KINDS.find((k) => k.key === kind);
    return entry ? t(entry.labelKey) : kind;
  };

  return (
    <div className="budget-page">
      <header className="page-header">
        <div className="page-header-main">
          <div className="page-title-row">
            <span className="page-icon-badge">
              <IconContacts className="icon" />
            </span>
            <div>
              <h2 className="editor-title">{t("contacts.title")}</h2>
              <p className="page-subtitle">{t("contacts.subtitle")}</p>
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
            <span className="side-heading">{t("contacts.directory")}</span>
            <span className="badge">{contacts.length}</span>
          </div>
          <span className="input-icon-wrap">
            <input
              className="input"
              type="search"
              placeholder={t("contacts.searchPlaceholder")}
              aria-label={t("contacts.searchAria")}
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
              aria-label={t("contacts.newNameAria")}
              placeholder={t("contacts.newNamePlaceholder")}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={saving || newName.trim().length === 0}
            >
              {t("contacts.add")}
            </button>
          </form>

          {loading ? (
            <Skeleton count={5} />
          ) : visible.length === 0 ? (
            <EmptyState>
              {contacts.length === 0
                ? t("contacts.emptyAll")
                : t("contacts.emptySearch")}
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
                        {contactInitial(c.name)}
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
                    {contactInitial(selectedContact.name)}
                  </span>
                  <h3 className="settings-heading">{selectedContact.name}</h3>
                  {selectedContact.birthday ? (
                    <span className="badge badge-accent">
                      {t("contacts.birthdayBadge", {
                        date: birthdayLabel(selectedContact.birthday, locale),
                      })}
                    </span>
                  ) : null}
                </div>
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void saveContact()}
                  >
                    <IconEdit className="icon" /> {t("contacts.save")}
                  </button>
                  <ConfirmButton
                    className="btn btn-danger"
                    what={t("contacts.deleteWhat")}
                    onConfirm={() => removeContact(selectedContact.id)}
                  >
                    <IconTrash className="icon" /> {t("contacts.moveToTrash")}
                  </ConfirmButton>
                </div>
              </div>

              <div className="entry-form contact-form">
                <div className="form-grid">
                  <label>
                    {t("contacts.nameLabel")}
                    <input
                      className="input"
                      value={edit.name}
                      onChange={(e) =>
                        setEdit({ ...edit, name: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    {t("contacts.addressLabel")}
                    <input
                      className="input"
                      value={edit.address}
                      placeholder={t("contacts.addressPlaceholder")}
                      onChange={(e) =>
                        setEdit({ ...edit, address: e.target.value })
                      }
                    />
                  </label>
                </div>
                <label>
                  {t("contacts.birthdayLabel")}
                  <span className="editor-row">
                    <select
                      className="select"
                      aria-label={t("contacts.birthdayTypeAria")}
                      value={edit.mode}
                      onChange={(e) =>
                        setEdit({
                          ...edit,
                          mode: e.target.value as BirthdayMode,
                          birthday: "",
                        })
                      }
                    >
                      <option value="none">{t("contacts.birthdayNone")}</option>
                      <option value="date">{t("contacts.birthdayFull")}</option>
                      <option value="monthday">
                        {t("contacts.birthdayMonthDay")}
                      </option>
                    </select>
                    {edit.mode === "date" ? (
                      <span className="input-icon-wrap">
                        <input
                          className="input"
                          type="date"
                          aria-label={t("contacts.birthdayDateAria")}
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
                        aria-label={t("contacts.birthdayMonthDayAria")}
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
                  {t("contacts.notesLabel")}
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
                <h3 className="side-heading">
                  {t("contacts.channelsHeading")}
                </h3>
                {detail.channels.length === 0 ? (
                  <p className="muted">{t("contacts.channelsEmpty")}</p>
                ) : (
                  <ul className="budget-list">
                    {detail.channels.map((ch) => (
                      <li key={ch.id} className="budget-row">
                        <span className="row-title">
                          <span className="chip">
                            {channelKindLabel(ch.kind)}
                          </span>{" "}
                          <b>{ch.value}</b>
                          {ch.is_primary === 1 ? (
                            <span className="chip chip-accent">
                              {t("contacts.primaryBadge")}
                            </span>
                          ) : null}
                        </span>
                        <span className="row-actions">
                          {ch.is_primary === 1 ? null : (
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() => void makePrimary(ch.id)}
                            >
                              {t("contacts.makePrimary")}
                            </button>
                          )}
                          <ConfirmButton
                            className="btn btn-ghost"
                            what={t("contacts.channelDeleteWhat", {
                              kind: channelKindLabel(ch.kind),
                            })}
                            onConfirm={() => removeChannel(ch.id)}
                          >
                            {t("common.delete")}
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
                    aria-label={t("contacts.channelKindAria")}
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
                        {t(k.labelKey)}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label={t("contacts.channelValueAria")}
                    placeholder={t("contacts.channelValuePlaceholder")}
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
                    {t("contacts.primaryBadge")}
                  </label>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={
                      channelDraft.value.trim().length === 0 || addingChannel
                    }
                  >
                    {t("contacts.addChannel")}
                  </button>
                </form>
              </section>

              <section className="contact-detail-section">
                <h3 className="side-heading">{t("contacts.tagsHeading")}</h3>
                {detail.tags.length === 0 ? (
                  <p className="muted">{t("contacts.tagsEmpty")}</p>
                ) : (
                  <div className="note-meta">
                    {detail.tags.map((tag) => (
                      <span key={tag} className="chip">
                        {tag}
                        <button
                          type="button"
                          className="side-remove"
                          aria-label={t("contacts.removeTagAria", { tag })}
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
                    aria-label={t("contacts.newTagAria")}
                    placeholder={t("contacts.newTagPlaceholder")}
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="btn"
                    disabled={newTag.trim().length === 0 || addingTag}
                  >
                    {t("contacts.addTag")}
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
                ? t("contacts.missing")
                : t("contacts.selectPrompt")}
            </EmptyState>
          )}
        </section>
      </div>

      {importOpen ? (
        <ImportDialog
          title={t("contacts.importTitle")}
          templateCsv={CONTACTS_TEMPLATE_CSV}
          templateName="purple-memo-contacts-template.csv"
          onPick={readCsvFile}
          parse={(text) =>
            mapContactRows(parseCsv(text, ["name"], CONTACT_CSV_ALIASES).rows)
          }
          columns={[
            { key: "name", label: t("contacts.nameLabel") },
            {
              key: "channels",
              label: t("contacts.channelsHeading"),
              render: (row) =>
                row.channels.length === 0
                  ? "—"
                  : row.channels
                      .map((ch) => `${channelKindLabel(ch.kind)}: ${ch.value}`)
                      .join("; "),
            },
            {
              key: "birthday",
              label: t("contacts.birthdayLabel"),
              render: (row) =>
                row.birthday === null
                  ? "—"
                  : birthdayLabel(row.birthday, locale),
            },
            {
              key: "address",
              label: t("contacts.addressLabel"),
              render: (row) => (row.address === "" ? "—" : row.address),
            },
            {
              key: "tags",
              label: t("contacts.tagsHeading"),
              render: (row) =>
                row.tags.length === 0 ? "—" : row.tags.join("; "),
            },
            {
              key: "notes",
              label: t("contacts.notesLabel"),
              render: (row) => (row.notes === "" ? "—" : row.notes),
            },
          ]}
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
