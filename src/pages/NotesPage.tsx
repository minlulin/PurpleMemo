// P3a Notes page: markdown editor + live preview, collections, tags,
// pin/archive, FTS search, 140-char excerpts. Talks only to the notes repo
// from the composition root — never to the driver or IPC directly.

import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import {
  IconChevronLeft,
  IconChevronRight,
  IconEye,
  IconFolder,
  IconMarkdown,
  IconNotes,
  IconPin,
  IconPlus,
  IconSearch,
} from "../components/icons.tsx";
import { LinksSection } from "../components/LinksSection.tsx";
import { markdownComponents } from "../components/MarkdownLink.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { useToast } from "../components/Toast.tsx";
import { useLocale, usePlural, useT } from "../components/useTranslation.ts";
import { journalRepo, notesRepo, settingsRepo } from "../data/app.ts";
import { todayLocal } from "../lib/dates.ts";
import {
  appendJournalBlock,
  clearNoteDraft,
  draftBaseMatches,
  loadJournalDraft,
  loadNoteDraft,
  type NoteEditorFields,
  noteEditorDiffersFromRow,
  noteRowToEditor,
  saveJournalDraft,
  saveNoteDraft,
  storedNoteForm,
} from "../lib/drafts.ts";
import { errText } from "../lib/errors.ts";
import { formatDate } from "../lib/format.ts";
import { createLoadGuard } from "../lib/loads.ts";
import { noteExcerpt, parseTags } from "../lib/notes.ts";
import {
  DEFAULT_VIEW_MODE,
  type NotesViewMode,
  toggleViewMode,
} from "../lib/notesView.ts";
import type { CollectionRow, LinkableEntity, NoteRow } from "../lib/types.ts";

interface EditorProps {
  title: string;
  content: string;
  tags: string;
  collection: number | "none";
  saving: boolean;
  pinned: boolean;
  archived: boolean;
  /** Editor differs from the stored note (a draft exists or edits are live). */
  dirty: boolean;
  collections: CollectionRow[];
  onTitle: (v: string) => void;
  onContent: (v: string) => void;
  onTags: (v: string) => void;
  onCollection: (v: number | "none") => void;
  onSave: () => void;
  onPin: () => void;
  onArchive: () => void;
  onToJournal: () => void;
  /** The journal append is in flight (review P3-29) — disables its button. */
  sendingToJournal: boolean;
  onDelete: () => void;
  /** Discard the unsaved draft and reload the stored note. */
  onDiscard: () => void;
  /** Editor/preview split, owned by the page so it survives note switches. */
  splitRatio: number;
  onSplitRatio: (ratio: number) => void;
  /** Edit | Split | Read — page-owned too, persisted in settings. */
  viewMode: NotesViewMode;
  onViewMode: (mode: NotesViewMode) => void;
}

function NoteEditor(p: EditorProps) {
  const t = useT();
  const plural = usePlural();
  const splitRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (r: number) => Math.min(0.75, Math.max(0.25, r));

  /** Pointer-driven pane split; keeps both panes at least 25% wide. */
  const resizeTo = (clientX: number) => {
    const box = splitRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    p.onSplitRatio(clamp((clientX - box.left) / box.width));
  };

  const words =
    p.content.trim().length === 0 ? 0 : p.content.trim().split(/\s+/).length;

  return (
    <>
      <input
        className="input editor-title"
        value={p.title}
        onChange={(e) => p.onTitle(e.target.value)}
        placeholder={t("notes.untitled")}
        aria-label={t("notes.titleAria")}
      />
      <div className="editor-row">
        <input
          className="input"
          value={p.tags}
          onChange={(e) => p.onTags(e.target.value)}
          placeholder={t("notes.tagsPlaceholder")}
          aria-label={t("notes.tagsAria")}
        />
        <select
          className="select"
          value={p.collection}
          onChange={(e) =>
            p.onCollection(
              e.target.value === "none" ? "none" : Number(e.target.value),
            )
          }
          aria-label={t("notes.collectionAria")}
        >
          <option value="none">{t("notes.noCollection")}</option>
          {p.collections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="editor-viewbar">
        {/* A fieldset IS the ARIA `group` role (the spec's ask) and is what
            biome's useSemanticElements demands — same shape as the Settings
            theme switch. */}
        <fieldset className="editor-viewmodes">
          <legend className="visually-hidden">{t("notes.viewAria")}</legend>
          <button
            type="button"
            className={p.viewMode === "edit" ? "btn is-on" : "btn"}
            aria-pressed={p.viewMode === "edit"}
            onClick={() => p.onViewMode("edit")}
          >
            <IconMarkdown className="icon" /> {t("notes.viewEdit")}
          </button>
          <button
            type="button"
            className={p.viewMode === "split" ? "btn is-on" : "btn"}
            aria-pressed={p.viewMode === "split"}
            onClick={() => p.onViewMode("split")}
          >
            {t("notes.viewSplit")}
          </button>
          <button
            type="button"
            className={p.viewMode === "read" ? "btn is-on" : "btn"}
            aria-pressed={p.viewMode === "read"}
            onClick={() => p.onViewMode("read")}
          >
            <IconEye className="icon" /> {t("notes.viewRead")}
          </button>
        </fieldset>
      </div>
      {/* Draft safety: both panes stay MOUNTED in every mode — the mode is a
          CSS class below, never a conditional render, so the draft, undo
          history, cursor and scroll position survive a switch. */}
      <div
        className={`editor-split mode-${p.viewMode}`}
        ref={splitRef}
        style={
          { "--editor-split-ratio": `${p.splitRatio * 100}%` } as CSSProperties
        }
      >
        <div className="editor-pane-box">
          <span className="editor-pane-label">
            <IconMarkdown className="icon" /> {t("notes.markdown")}
          </span>
          <textarea
            className="textarea editor-input"
            value={p.content}
            onChange={(e) => p.onContent(e.target.value)}
            placeholder={t("notes.contentPlaceholder")}
            aria-label={t("notes.contentAria")}
          />
        </div>
        <hr
          className={`editor-resize-handle${dragging ? " is-dragging" : ""}`}
          aria-label={t("notes.resizeAria")}
          tabIndex={0}
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
            resizeTo(e.clientX);
          }}
          onPointerMove={(e) => {
            if (dragging) resizeTo(e.clientX);
          }}
          onPointerUp={(e) => {
            e.currentTarget.releasePointerCapture(e.pointerId);
            setDragging(false);
          }}
          onPointerCancel={() => setDragging(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              p.onSplitRatio(clamp(p.splitRatio - 0.05));
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              p.onSplitRatio(clamp(p.splitRatio + 0.05));
            }
          }}
        />
        <div className="editor-pane-box">
          <span className="editor-pane-label">
            <IconEye className="icon" /> {t("notes.livePreview")}
          </span>
          <div className="editor-preview markdown" aria-live="polite">
            {p.content.trim().length === 0 ? (
              <p className="empty-state">{t("notes.previewEmpty")}</p>
            ) : (
              <ReactMarkdown components={markdownComponents}>
                {p.content}
              </ReactMarkdown>
            )}
          </div>
        </div>
      </div>
      <div className="editor-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={p.saving}
          onClick={p.onSave}
        >
          {p.saving ? t("notes.saving") : t("notes.save")}
        </button>
        {p.dirty && (
          <span className="badge badge-warn" aria-live="polite">
            {t("notes.unsaved")}
          </span>
        )}
        {p.dirty && (
          <button
            type="button"
            className="btn"
            title={t("notes.discardTitle")}
            disabled={p.saving}
            onClick={p.onDiscard}
          >
            {t("notes.discard")}
          </button>
        )}
        <button
          type="button"
          className={p.pinned ? "btn is-on" : "btn"}
          onClick={p.onPin}
        >
          {p.pinned ? t("notes.unpin") : t("notes.pin")}
        </button>
        <button
          type="button"
          className={p.archived ? "btn is-on" : "btn"}
          onClick={p.onArchive}
        >
          {p.archived ? t("notes.unarchive") : t("notes.archive")}
        </button>
        <button
          type="button"
          className="btn"
          title={t("notes.toJournalTitle")}
          disabled={p.sendingToJournal}
          onClick={p.onToJournal}
        >
          {p.sendingToJournal ? t("notes.adding") : t("notes.sendToJournal")}
        </button>
        <span className="toolbar-spacer" />
        <span className="editor-word-count" aria-live="polite">
          {plural("notes.wordCount", words)}
        </span>
        <ConfirmButton
          className="btn btn-danger"
          what={t("notes.deleteWhat")}
          onConfirm={p.onDelete}
        >
          {t("notes.moveToTrash")}
        </ConfirmButton>
      </div>
    </>
  );
}

interface NotesPageProps {
  /**
   * The note to select on arrival, from a relationship click.
   *
   * Null on an ordinary visit. The note is fetched by id and the filters are
   * widened so it is actually in the list — this page selects by scanning the
   * loaded rows, so a note hidden by a collection filter or a search would
   * otherwise resolve to nothing and look like a broken link.
   */
  focusId: number | null;
  focusToken?: number;
  onOpenEntity: (entity: LinkableEntity) => void;
}

export default function NotesPage(p: NotesPageProps) {
  const t = useT();
  const locale = useLocale();
  const [collections, setCollections] = useState<CollectionRow[]>([]);
  const [activeCollection, setActiveCollection] = useState<number | "all">(
    "all",
  );
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [splitRatio, setSplitRatio] = useState(0.5);
  /** Edit | Split | Read — page-owned (survives note switches), persisted. */
  const [viewMode, setViewMode] = useState<NotesViewMode>(DEFAULT_VIEW_MODE);
  /** Collections sidebar collapsed — page preference, persisted. */
  const [collectionsCollapsed, setCollectionsCollapsed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newCollection, setNewCollection] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [noteCollection, setNoteCollection] = useState<number | "none">("none");
  /**
   * The note id the editor was last populated from. List refreshes (search,
   * filter, pin/archive) replace the `notes` array with new row objects —
   * repopulating on every refresh would wipe an unsaved draft, so the
   * editor only repopulates when the SELECTED NOTE changes.
   */
  const populatedIdRef = useRef<number | null>(null);
  /** Mirror of the editor fields for decisions made after an awaited save —
   *  closures over state cannot see keystrokes typed while a save is in
   *  flight (those keystrokes must keep their draft). */
  const editorRef = useRef<NoteEditorFields>({
    title: "",
    content: "",
    tags: "",
    collection: "none",
  });
  /** The row's `updated_at` the editor — and every draft written from it —
   *  is based on. Refreshed when the note is populated and after each save
   *  (updateNote stamps `updated_at = todayLocal()`). */
  const baseRef = useRef<string>("");
  /** Set by any keystroke; stops a slow draft read from clobbering typing. */
  const touchedRef = useRef(false);
  /** Bumped on populate and on discard: a stale draft read must never
   *  resurrect text over a discard that landed while it was in flight. */
  const draftSeqRef = useRef(0);
  /** Guards the list against an out-of-order search result. */
  const listGuard = useMemo(() => createLoadGuard(), []);
  /** Set when a relationship sent us to a note that is not there. */
  const [focusMissing, setFocusMissing] = useState(false);

  /**
   * Load the two Notes-page view preferences once on mount. A missing or
   * malformed stored value falls back inside `settingsRepo` (split /
   * expanded) — no error reaches the writer. Best-effort like drafts: a
   * failed read leaves the defaults rather than blocking the page.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [mode, collapsed] = await Promise.all([
          settingsRepo.getNotesViewMode(),
          settingsRepo.getNotesCollectionsCollapsed(),
        ]);
        if (cancelled) return;
        setViewMode(mode);
        setCollectionsCollapsed(collapsed);
      } catch {
        // Defaults (split / expanded) already stand.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Persist on every change; state already applied either way. */
  function changeViewMode(mode: NotesViewMode): void {
    setViewMode(mode);
    void settingsRepo.setNotesViewMode(mode).catch(() => undefined);
  }

  function changeCollectionsCollapsed(collapsed: boolean): void {
    setCollectionsCollapsed(collapsed);
    void settingsRepo
      .setNotesCollectionsCollapsed(collapsed)
      .catch(() => undefined);
  }

  /** The page root: scopes the Ctrl+E listener to keystrokes inside it. */
  const pageRootRef = useRef<HTMLDivElement>(null);

  /**
   * Ctrl/Cmd+E toggles the view mode while the editor is shown:
   * Read → Edit, Edit → Read, Split → Read (see `toggleViewMode`).
   *
   * Scoped three ways, matching how the shell treats global keys
   * (App.tsx `onKey`): only while this page is mounted and a note is open,
   * only when the keystroke lands inside the page root (so Ctrl+E stays
   * free everywhere else in the app), and never while an app dialog is
   * open. Unlike the shell's typing guard, typing is exactly when this
   * shortcut is wanted — it is bound INSIDE the root, where a keystroke
   * can only have come from this page's own controls.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "e") return;
      if (selectedId === null) return;
      const target = e.target as HTMLElement | null;
      if (target === null || !pageRootRef.current?.contains(target)) return;
      if (document.querySelector("[role=dialog]") !== null) return;
      e.preventDefault();
      const next = toggleViewMode(viewMode);
      setViewMode(next);
      void settingsRepo.setNotesViewMode(next).catch(() => undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, viewMode]);

  /**
   * Arrive at one exact note.
   *
   * Fetches the row by id, clears whatever could hide it, and puts it in the
   * list before selecting — `selected` below is derived from `notes`, so
   * selecting without the row would render the empty state and look like the
   * link was broken. The list guard is taken here too, so this load wins
   * against the page's own first refresh instead of racing it.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusToken retriggers a jump to the same note
  useEffect(() => {
    if (p.focusId === null) return;
    const token = listGuard.begin();
    let cancelled = false;
    (async () => {
      try {
        const note = await notesRepo.getNote(p.focusId as number);
        if (cancelled || !listGuard.isCurrent(token)) return;
        if (!note) {
          setFocusMissing(true);
          setError(t("notes.missing"));
          return;
        }
        setFocusMissing(false);
        setSearch("");
        setActiveCollection("all");
        setShowArchived(note.archived === 1);
        const list = await notesRepo.listNotes({ includeArchived: true });
        if (cancelled || !listGuard.isCurrent(token)) return;
        setNotes(list);
        setCollections(await notesRepo.listCollections());
        setSelectedId(note.id);
      } catch (e) {
        if (!cancelled && listGuard.isCurrent(token)) setError(errText(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [p.focusId, p.focusToken, listGuard]);

  const refresh = useCallback(async () => {
    // Every keystroke in the search box starts a load, so a slow query for
    // "a" could otherwise resolve after a fast one for "abc" and leave the
    // list showing the old result set.
    const token = listGuard.begin();
    setLoading(true);
    setError(null);
    try {
      const cols = await notesRepo.listCollections();
      // One filter for BOTH paths (review P2-13): the sidebar selection used to
      // be applied only when the search box was empty, so clicking a collection
      // during a search highlighted it and then showed matches from every
      // collection. Deriving it once keeps the two branches from disagreeing.
      const collectionId =
        activeCollection === "all" ? undefined : activeCollection;
      const list =
        search.trim().length > 0
          ? await notesRepo.search(search, {
              includeArchived: showArchived,
              collectionId,
            })
          : await notesRepo.listNotes({
              collectionId,
              includeArchived: showArchived,
            });
      if (!listGuard.isCurrent(token)) return; // superseded by a newer search
      setCollections(cols);
      setNotes(list);
    } catch (e) {
      if (listGuard.isCurrent(token)) setError(errText(e));
    } finally {
      if (listGuard.isCurrent(token)) setLoading(false);
    }
  }, [activeCollection, listGuard, search, showArchived]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = useMemo(
    () => notes.find((n) => n.id === selectedId) ?? null,
    [notes, selectedId],
  );
  const toast = useToast();

  useEffect(() => {
    if (selected && selected.id !== populatedIdRef.current) {
      populatedIdRef.current = selected.id;
      touchedRef.current = false;
      baseRef.current = selected.updated_at;
      const rowFields: NoteEditorFields = {
        title: selected.title,
        content: selected.content,
        tags: selected.tags,
        collection: selected.collection_id ?? "none",
      };
      editorRef.current = rowFields;
      setTitle(rowFields.title);
      setContent(rowFields.content);
      setTags(rowFields.tags);
      setNoteCollection(rowFields.collection);
      // Overlay an unsaved draft written before the last lock/navigation,
      // but only onto the exact row state it was written for. A
      // failed or stale draft read leaves the saved row in the editor.
      const noteId = selected.id;
      const rowBase = selected.updated_at;
      const seq = ++draftSeqRef.current;
      void loadNoteDraft(settingsRepo, noteId)
        .then((draft) => {
          if (draft === null) return;
          if (seq !== draftSeqRef.current) return;
          if (populatedIdRef.current !== noteId || touchedRef.current) return;
          if (!draftBaseMatches(draft.baseUpdatedAt, rowBase)) {
            // The row moved on since the draft was written — drop it rather
            // than resurrect stale text over newer content.
            void clearNoteDraft(settingsRepo, noteId).catch(() => undefined);
            return;
          }
          const draftFields: NoteEditorFields = {
            title: draft.title,
            content: draft.content,
            tags: draft.tags,
            collection: draft.collection,
          };
          editorRef.current = draftFields;
          setTitle(draftFields.title);
          setContent(draftFields.content);
          setTags(draftFields.tags);
          setNoteCollection(draftFields.collection);
        })
        .catch(() => undefined);
    }
    if (!selected) populatedIdRef.current = null;
  }, [selected]);

  /** True when the editor holds changes the stored note does not have. */
  const dirty =
    selected !== null &&
    noteEditorDiffersFromRow(
      { title, content, tags, collection: noteCollection },
      selected,
    );

  /**
   * The single path for every editor keystroke: update state, mirror it into
   * `editorRef`, and persist a draft against the row state the editor was
   * populated from. Draft persistence is best-effort — typing must
   * never wait on it, and the explicit Save still reports its own errors.
   */
  function editNote(patch: Partial<NoteEditorFields>): void {
    touchedRef.current = true;
    const next: NoteEditorFields = {
      title: patch.title ?? title,
      content: patch.content ?? content,
      tags: patch.tags ?? tags,
      collection: patch.collection ?? noteCollection,
    };
    if (patch.title !== undefined) setTitle(patch.title);
    if (patch.content !== undefined) setContent(patch.content);
    if (patch.tags !== undefined) setTags(patch.tags);
    if (patch.collection !== undefined) setNoteCollection(patch.collection);
    editorRef.current = next;
    if (selected === null) return;
    const op = noteEditorDiffersFromRow(next, selected)
      ? saveNoteDraft(settingsRepo, selected.id, {
          baseUpdatedAt: baseRef.current,
          savedAt: Date.now(),
          ...next,
        })
      : clearNoteDraft(settingsRepo, selected.id);
    void op.catch(() => undefined);
  }

  /** Explicit escape hatch for a restored draft: reload the saved note. */
  function handleDiscardDraft(): void {
    // Refused while a save is in flight (review P2-6). The interleaving was a
    // real bug, not a theoretical one: `handleSave` snapshots the editor, then
    // on resume compares the CURRENT editor against that snapshot to decide
    // whether to keep a draft. A discard in between puts the pre-save row text
    // in the editor, so the comparison says "the editor moved on" and the save
    // writes a draft — resurrecting, verbatim, the draft the user had just
    // explicitly thrown away, and leaving the editor showing it as unsaved
    // work. Refusing the two actions from overlapping is simpler than ordering
    // them, and a save that is already landing makes "discard" meaningless
    // anyway.
    if (saving || selected === null) return;
    touchedRef.current = false;
    draftSeqRef.current += 1;
    baseRef.current = selected.updated_at;
    const rowFields = noteRowToEditor(selected);
    editorRef.current = rowFields;
    setTitle(rowFields.title);
    setContent(rowFields.content);
    setTags(rowFields.tags);
    setNoteCollection(rowFields.collection);
    void clearNoteDraft(settingsRepo, selected.id).catch(() => undefined);
  }

  async function handleNew(): Promise<void> {
    setError(null);
    try {
      const id = await notesRepo.createNote({
        title: "Untitled",
        content: "",
        tags: [],
        collectionId: activeCollection === "all" ? null : activeCollection,
      });
      await refresh();
      setSelectedId(id);
    } catch (e) {
      setError(errText(e));
    }
  }

  async function handleSave(): Promise<void> {
    if (selectedId === null) return;
    setSaving(true);
    setError(null);
    // Snapshot what this save persists: closures may predate keystrokes
    // typed while the save is in flight (see editorRef).
    const savedFields: NoteEditorFields = {
      title,
      content,
      tags,
      collection: noteCollection,
    };
    try {
      await notesRepo.updateNote(selectedId, {
        title: title.trim().length > 0 ? title : "Untitled",
        content,
        tags: parseTags(tags),
        collectionId: noteCollection === "none" ? null : noteCollection,
      });
      // updateNote stamped updated_at = todayLocal(); rebase every later
      // draft onto the new row state.
      baseRef.current = todayLocal();
      const movedOn = noteEditorDiffersFromRow(
        editorRef.current,
        storedNoteForm(savedFields),
      );
      const op = movedOn
        ? // Keystrokes landed while the save was in flight: keep them as a
          // draft against the freshly saved row rather than losing them.
          saveNoteDraft(settingsRepo, selectedId, {
            baseUpdatedAt: baseRef.current,
            savedAt: Date.now(),
            ...editorRef.current,
          })
        : clearNoteDraft(settingsRepo, selectedId);
      // Draft bookkeeping is best-effort, exactly as `JournalPage` already
      // treats it (review P3-9). The note is already saved by this point, so a
      // failed draft write must not be reported as a failed save — it used to
      // land in this `catch` and show "could not save" over a note that was
      // saved perfectly well, which is the one message a writer must never get
      // wrong. The draft is reconstructed on the next keystroke regardless.
      await op.catch(() => undefined);
      await refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  }

  async function handlePin(note: NoteRow): Promise<void> {
    setError(null);
    try {
      await notesRepo.setPinned(note.id, note.pinned === 0);
      await refresh();
    } catch (e) {
      setError(errText(e));
    }
  }

  async function handleArchive(note: NoteRow): Promise<void> {
    setError(null);
    try {
      await notesRepo.setArchived(note.id, note.archived === 0);
      await refresh();
    } catch (e) {
      setError(errText(e));
    }
  }

  async function handleDelete(id: number): Promise<void> {
    setError(null);
    try {
      await notesRepo.deleteNote(id);
      // A deleted note's draft is meaningless — never let it reappear.
      await clearNoteDraft(settingsRepo, id).catch(() => undefined);
      setSelectedId(null);
      await refresh();
    } catch (e) {
      setError(errText(e));
    }
  }

  async function handleNewCollection(): Promise<void> {
    const name = newCollection.trim();
    if (name.length === 0) return;
    setError(null);
    try {
      await notesRepo.createCollection(name);
      setNewCollection("");
      await refresh();
    } catch (e) {
      setError(errText(e));
    }
  }

  async function handleDeleteCollection(id: number): Promise<void> {
    setError(null);
    try {
      await notesRepo.deleteCollection(id);
      if (activeCollection === id) setActiveCollection("all");
      await refresh();
    } catch (e) {
      setError(errText(e));
    }
  }

  /**
   * Append the note to today's journal entry. Uses the current editor draft
   * (what the user sees) — not the last saved row — so unsaved edits are
   * included.
   *
   * Guarded and confirmed (review P3-29). This appends to a day that is
   * *shared*: a second click before the first lands re-reads the pre-append
   * entry and appends the same block again, so today's reflection ends up
   * carrying the note twice, with nothing on screen to say so. Same in-flight
   * guard as the money forms (`savingRef`, the authoritative half), and a toast
   * on success — an action with no visible result and no confirmation is an
   * action people fire twice out of sheer uncertainty.
   */
  const toJournalRef = useRef(false);
  const [sendingToJournal, setSendingToJournal] = useState(false);

  async function handleToJournal(): Promise<void> {
    if (toJournalRef.current || selectedId === null) return;
    toJournalRef.current = true;
    setSendingToJournal(true);
    setError(null);
    try {
      const today = todayLocal();
      const existing = await journalRepo.getEntry(today);
      const baseBefore = existing?.updated_at ?? null;
      const heading = title.trim().length > 0 ? title.trim() : "Untitled";
      const block = `# ${heading}\n\n${content}`.trim();
      await journalRepo.upsertEntry(
        today,
        appendJournalBlock(existing?.content ?? "", block),
      );
      // The day's unsaved journal draft (if any) was written against the
      // pre-append entry — fold the same block into it so restoring the draft
      // keeps both the reflection and the appended note. Best-effort:
      // the entry append above already succeeded.
      try {
        const draft = await loadJournalDraft(settingsRepo, today);
        if (
          draft !== null &&
          draftBaseMatches(draft.baseUpdatedAt, baseBefore)
        ) {
          await saveJournalDraft(settingsRepo, today, {
            baseUpdatedAt: todayLocal(),
            savedAt: Date.now(),
            content: appendJournalBlock(draft.content, block),
          });
        }
      } catch {
        // Best-effort: the appended entry is already stored.
      }
      toast.success(t("notes.addedToJournal", { title: heading }));
    } catch (e) {
      setError(errText(e));
    } finally {
      toJournalRef.current = false;
      setSendingToJournal(false);
    }
  }

  const listBody =
    notes.length === 0 ? (
      <li className="note-list-empty">
        <IconNotes className="icon" />
        <span>
          {search.trim().length > 0 ? t("notes.noMatch") : t("notes.noNotes")}
        </span>
      </li>
    ) : (
      notes.map((note) => {
        const isActive = note.id === selectedId;
        const excerpt = noteExcerpt(note.content);
        return (
          <li key={note.id}>
            <button
              type="button"
              className={`note-card${note.pinned === 1 ? " note-card-pin-indicator" : ""}${isActive ? " is-active" : ""}`}
              onClick={() => setSelectedId(note.id)}
            >
              <span className="note-card-title">
                {note.pinned === 1 && (
                  <>
                    <IconPin className="icon note-pin" />
                    <span className="visually-hidden">{t("notes.pinned")}</span>
                  </>
                )}
                <span className="title-text">
                  {note.title.length > 0 ? note.title : t("notes.untitled")}
                </span>
                {note.archived === 1 && (
                  <span className="badge">{t("notes.archivedBadge")}</span>
                )}
              </span>
              <span className="note-excerpt">
                {excerpt.length > 0 ? excerpt : t("notes.noExcerpt")}
              </span>
              <span className="note-meta">
                {note.tags.length > 0 && (
                  <span className="tag-row">#{note.tags}</span>
                )}
                <span className="meta-date figure">
                  {formatDate(locale, note.updated_at)}
                </span>
              </span>
            </button>
          </li>
        );
      })
    );

  return (
    <div className="feature-split" ref={pageRootRef}>
      {collectionsCollapsed ? (
        // Slim expand affordance at the left edge: the sidebar can always
        // come back, even from a layout where the aside itself has no room.
        <button
          type="button"
          className="btn feature-side-expand"
          aria-label={t("notes.expandCollections")}
          aria-expanded={false}
          title={t("notes.expandCollections")}
          onClick={() => changeCollectionsCollapsed(false)}
        >
          <IconChevronRight className="icon" />
        </button>
      ) : (
        <aside className="feature-side" aria-label={t("notes.collections")}>
          <div className="dash-card-head">
            <div className="dash-card-title">
              <IconFolder className="icon" />
              <h2 className="side-heading">{t("notes.collections")}</h2>
            </div>
            <span className="side-head-actions">
              <span className="badge">{collections.length}</span>
              <button
                type="button"
                className="btn btn-icon"
                aria-label={t("notes.collapseCollections")}
                aria-expanded={true}
                title={t("notes.collapseCollections")}
                onClick={() => changeCollectionsCollapsed(true)}
              >
                <IconChevronLeft className="icon" />
              </button>
            </span>
          </div>
          <ul className="side-list">
            <li>
              <button
                type="button"
                className={
                  activeCollection === "all" ? "side-btn is-active" : "side-btn"
                }
                onClick={() => setActiveCollection("all")}
              >
                <span>{t("notes.allNotes")}</span>
              </button>
            </li>
            {collections.map((c) => (
              <li className="side-item" key={c.id}>
                <button
                  type="button"
                  className={
                    activeCollection === c.id
                      ? "side-btn is-active"
                      : "side-btn"
                  }
                  onClick={() => setActiveCollection(c.id)}
                >
                  <span>{c.name}</span>
                </button>
                <ConfirmButton
                  className="side-remove"
                  what={t("notes.deleteCollectionWhat", { name: c.name })}
                  aria-label={t("notes.deleteCollectionAria", { name: c.name })}
                  onConfirm={() => handleDeleteCollection(c.id)}
                >
                  ×
                </ConfirmButton>
              </li>
            ))}
          </ul>
          <div className="side-form">
            <input
              className="input"
              value={newCollection}
              onChange={(e) => setNewCollection(e.target.value)}
              placeholder={t("notes.newCollectionPlaceholder")}
              aria-label={t("notes.newCollectionAria")}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleNewCollection();
              }}
            />
            <button
              type="button"
              className="btn"
              onClick={() => void handleNewCollection()}
            >
              {t("notes.add")}
            </button>
          </div>
        </aside>
      )}
      <section className="notes-main" aria-label={t("notes.notesAria")}>
        <div className="notes-toolbar">
          <div className="dash-card-title">
            <IconNotes className="icon" />
            <strong>{t("notes.notesHeading")}</strong>
            <span className="badge">{notes.length}</span>
          </div>
          <span className="input-icon-wrap">
            <input
              className="input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("notes.searchPlaceholder")}
              aria-label={t("notes.searchAria")}
            />
            <IconSearch className="icon input-icon" />
          </span>
          <label className="check-label">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            {t("notes.showArchived")}
          </label>
          <span className="toolbar-spacer" />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleNew()}
          >
            <IconPlus className="icon" /> {t("notes.newNote")}
          </button>
        </div>
        {error !== null && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}
        {loading ? (
          <div className="notes-body">
            <ul className="note-list" aria-label={t("notes.noteListAria")}>
              <li>
                <Skeleton count={5} />
              </li>
            </ul>
            <section className="editor-pane" aria-label={t("notes.editorAria")}>
              <Skeleton variant="card" />
            </section>
          </div>
        ) : (
          <div className="notes-body">
            <ul className="note-list" aria-label={t("notes.noteListAria")}>
              {listBody}
            </ul>
            <section
              className="editor-pane animate-fade-in"
              aria-label={t("notes.editorAria")}
              key={selected?.id ?? "empty"}
            >
              {selected === null ? (
                focusMissing ? (
                  <EmptyState>{t("notes.missing")}</EmptyState>
                ) : (
                  <EmptyState>{t("notes.selectPrompt")}</EmptyState>
                )
              ) : (
                // No `key` here (review P3-22): the wrapping section is already
                // keyed by note id, so it remounts this subtree on every note
                // change. A second key on the child was a duplicate source of
                // truth for "which note is shown", and one that could only ever
                // agree with the outer one.
                <NoteEditor
                  title={title}
                  content={content}
                  tags={tags}
                  collection={noteCollection}
                  saving={saving}
                  pinned={selected.pinned === 1}
                  archived={selected.archived === 1}
                  dirty={dirty}
                  collections={collections}
                  onTitle={(v) => editNote({ title: v })}
                  onContent={(v) => editNote({ content: v })}
                  onTags={(v) => editNote({ tags: v })}
                  onCollection={(v) => editNote({ collection: v })}
                  onSave={() => void handleSave()}
                  onPin={() => void handlePin(selected)}
                  onArchive={() => void handleArchive(selected)}
                  onToJournal={() => void handleToJournal()}
                  sendingToJournal={sendingToJournal}
                  onDelete={() => void handleDelete(selected.id)}
                  onDiscard={handleDiscardDraft}
                  splitRatio={splitRatio}
                  onSplitRatio={setSplitRatio}
                  viewMode={viewMode}
                  onViewMode={changeViewMode}
                />
              )}
            </section>
            {selected === null ? null : (
              // Relationships belong to the note, not to the editor: this sits
              // below the editor pane so the layout above is untouched.
              <LinksSection
                entity={{ type: "note", id: selected.id }}
                onOpenEntity={p.onOpenEntity}
              />
            )}
          </div>
        )}
      </section>
    </div>
  );
}
