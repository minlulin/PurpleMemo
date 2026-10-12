// P3a Notes page (§2.4): markdown editor + live preview, collections, tags,
// pin/archive, FTS search, 140-char excerpts. Talks only to the notes repo
// from the composition root (§4) — never to the driver or IPC directly.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { EmptyState } from "../components/EmptyState.tsx";
import { journalRepo, notesRepo } from "../data/app.ts";
import { todayLocal } from "../lib/dates.ts";
import { errText } from "../lib/errors.ts";
import { noteExcerpt } from "../lib/notes.ts";
import type { CollectionRow, NoteRow } from "../lib/types.ts";

function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

interface EditorProps {
  title: string;
  content: string;
  tags: string;
  collection: number | "none";
  saving: boolean;
  pinned: boolean;
  archived: boolean;
  collections: CollectionRow[];
  onTitle: (v: string) => void;
  onContent: (v: string) => void;
  onTags: (v: string) => void;
  onCollection: (v: number | "none") => void;
  onSave: () => void;
  onPin: () => void;
  onArchive: () => void;
  onToJournal: () => void;
  onDelete: () => void;
}

function NoteEditor(p: EditorProps) {
  return (
    <>
      <input
        className="input editor-title"
        value={p.title}
        onChange={(e) => p.onTitle(e.target.value)}
        placeholder="Title"
        aria-label="Note title"
      />
      <div className="editor-row">
        <input
          className="input"
          value={p.tags}
          onChange={(e) => p.onTags(e.target.value)}
          placeholder="Tags (comma separated)"
          aria-label="Note tags"
        />
        <select
          className="select"
          value={p.collection}
          onChange={(e) =>
            p.onCollection(
              e.target.value === "none" ? "none" : Number(e.target.value),
            )
          }
          aria-label="Note collection"
        >
          <option value="none">No collection</option>
          {p.collections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="editor-split">
        <textarea
          className="textarea editor-input"
          value={p.content}
          onChange={(e) => p.onContent(e.target.value)}
          placeholder="Write markdown…"
          aria-label="Note content (markdown)"
        />
        <div className="editor-preview markdown" aria-live="polite">
          {p.content.trim().length === 0 ? (
            <p className="empty-state">Live preview appears here.</p>
          ) : (
            <ReactMarkdown>{p.content}</ReactMarkdown>
          )}
        </div>
      </div>
      <div className="editor-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={p.saving}
          onClick={p.onSave}
        >
          {p.saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className={p.pinned ? "btn is-on" : "btn"}
          onClick={p.onPin}
        >
          {p.pinned ? "Unpin" : "Pin"}
        </button>
        <button type="button" className="btn" onClick={p.onArchive}>
          {p.archived ? "Unarchive" : "Archive"}
        </button>
        <button
          type="button"
          className="btn"
          title="Append this note to today's journal entry"
          onClick={p.onToJournal}
        >
          Send to journal
        </button>
        <span className="toolbar-spacer" />
        <button type="button" className="btn btn-danger" onClick={p.onDelete}>
          Delete
        </button>
      </div>
    </>
  );
}

export default function NotesPage() {
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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cols = await notesRepo.listCollections();
      const list =
        search.trim().length > 0
          ? await notesRepo.search(search, { includeArchived: showArchived })
          : await notesRepo.listNotes({
              collectionId:
                activeCollection === "all" ? undefined : activeCollection,
              includeArchived: showArchived,
            });
      setCollections(cols);
      setNotes(list);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [activeCollection, search, showArchived]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = useMemo(
    () => notes.find((n) => n.id === selectedId) ?? null,
    [notes, selectedId],
  );

  useEffect(() => {
    if (selected && selected.id !== populatedIdRef.current) {
      populatedIdRef.current = selected.id;
      setTitle(selected.title);
      setContent(selected.content);
      setTags(selected.tags);
      setNoteCollection(selected.collection_id ?? "none");
    }
    if (!selected) populatedIdRef.current = null;
  }, [selected]);

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
    try {
      await notesRepo.updateNote(selectedId, {
        title: title.trim().length > 0 ? title : "Untitled",
        content,
        tags: parseTags(tags),
        collectionId: noteCollection === "none" ? null : noteCollection,
      });
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
   */
  async function handleToJournal(): Promise<void> {
    if (selectedId === null) return;
    setError(null);
    try {
      const today = todayLocal();
      const existing = await journalRepo.getEntry(today);
      const heading = title.trim().length > 0 ? title.trim() : "Untitled";
      const block = `# ${heading}\n\n${content}`.trim();
      await journalRepo.upsertEntry(
        today,
        existing && existing.content.length > 0
          ? `${existing.content}\n\n---\n\n${block}`
          : block,
      );
    } catch (e) {
      setError(errText(e));
    }
  }
  const listBody =
    notes.length === 0 ? (
      <li className="empty-state">
        {search.trim().length > 0
          ? "No notes match this search."
          : "No notes yet — create your first note."}
      </li>
    ) : (
      notes.map((note) => {
        const isActive = note.id === selectedId;
        return (
          <li key={note.id}>
            <button
              type="button"
              className={isActive ? "note-card is-active" : "note-card"}
              onClick={() => setSelectedId(note.id)}
            >
              <span className="note-card-title">
                {note.pinned === 1 && <span title="Pinned">📌</span>}
                <span className="title-text">
                  {note.title.length > 0 ? note.title : "Untitled"}
                </span>
              </span>
              <span className="note-excerpt">{noteExcerpt(note.content)}</span>
              <span className="note-meta">
                {note.tags.length > 0 && (
                  <span className="tag-row">{note.tags}</span>
                )}
                <span className="meta-date figure">{note.updated_at}</span>
              </span>
            </button>
          </li>
        );
      })
    );

  return (
    <div className="feature-split">
      <aside className="feature-side" aria-label="Collections">
        <h2 className="side-heading">Collections</h2>
        <ul className="side-list">
          <li>
            <button
              type="button"
              className={
                activeCollection === "all" ? "side-btn is-active" : "side-btn"
              }
              onClick={() => setActiveCollection("all")}
            >
              All notes
            </button>
          </li>
          {collections.map((c) => (
            <li className="side-item" key={c.id}>
              <button
                type="button"
                className={
                  activeCollection === c.id ? "side-btn is-active" : "side-btn"
                }
                onClick={() => setActiveCollection(c.id)}
              >
                {c.name}
              </button>
              <button
                type="button"
                className="side-remove"
                aria-label={`Delete collection ${c.name}`}
                onClick={() => void handleDeleteCollection(c.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className="side-form">
          <input
            className="input"
            value={newCollection}
            onChange={(e) => setNewCollection(e.target.value)}
            placeholder="New collection"
            aria-label="New collection name"
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleNewCollection();
            }}
          />
          <button
            type="button"
            className="btn"
            onClick={() => void handleNewCollection()}
          >
            Add
          </button>
        </div>
      </aside>
      <section className="notes-main" aria-label="Notes">
        <div className="notes-toolbar">
          <input
            className="input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search notes (full-text)…"
            aria-label="Search notes"
          />
          <label className="check-label">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Archived
          </label>
          <span className="toolbar-spacer" />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleNew()}
          >
            New note
          </button>
        </div>
        {error !== null && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}
        {loading ? (
          <p className="empty-state">Loading notes…</p>
        ) : (
          <div className="notes-body">
            <ul className="note-list" aria-label="Note list">
              {listBody}
            </ul>
            <section className="editor-pane" aria-label="Note editor">
              {selected === null ? (
                <EmptyState>
                  Select a note to edit, or create a new one.
                </EmptyState>
              ) : (
                <NoteEditor
                  key={selected.id}
                  title={title}
                  content={content}
                  tags={tags}
                  collection={noteCollection}
                  saving={saving}
                  pinned={selected.pinned === 1}
                  archived={selected.archived === 1}
                  collections={collections}
                  onTitle={setTitle}
                  onContent={setContent}
                  onTags={setTags}
                  onCollection={setNoteCollection}
                  onSave={() => void handleSave()}
                  onPin={() => void handlePin(selected)}
                  onArchive={() => void handleArchive(selected)}
                  onToJournal={() => void handleToJournal()}
                  onDelete={() => void handleDelete(selected.id)}
                />
              )}
            </section>
          </div>
        )}
      </section>
    </div>
  );
}
