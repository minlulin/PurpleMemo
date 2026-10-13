// P3e Gallery page (§2.7): photo storage via the driver's content-addressed
// photo commands (§4); the page adds pick-to-save, thumbnails (object URLs
// from photo bytes), per-photo note/taken-date, links to notes/memories/jobs
// (photo_refs) and delete. Talks only to the gallery + picker repos.

import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState } from "../components/EmptyState.tsx";
import { IconCalendar, IconGallery, IconPlus } from "../components/icons.tsx";
import {
  businessRepo,
  galleryRepo,
  memoriesRepo,
  notesRepo,
} from "../data/app.ts";
import { errText } from "../lib/errors.ts";
import { photoExtFromName } from "../lib/gallery.ts";
import type {
  JobRow,
  MemoryRow,
  NoteRow,
  PhotoRefEntity,
  PhotoRefRow,
  PhotoRow,
} from "../lib/types.ts";

const ENTITY_LABELS: { key: PhotoRefEntity; label: string }[] = [
  { key: "note", label: "Note" },
  { key: "memory", label: "Memory" },
  { key: "job", label: "Job" },
];

function bytesUrl(bytes: number[]): string {
  return URL.createObjectURL(new Blob([new Uint8Array(bytes) as BlobPart]));
}

export default function GalleryPage() {
  const [photos, setPhotos] = useState<PhotoRow[]>([]);
  const [urls, setUrls] = useState<Map<number, string>>(new Map());
  const urlsRef = useRef<Map<number, string>>(new Map());
  const [selected, setSelected] = useState<PhotoRow | null>(null);
  const [selectedRefs, setSelectedRefs] = useState<PhotoRefRow[]>([]);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [memories, setMemories] = useState<MemoryRow[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [linkDraft, setLinkDraft] = useState<{
    type: PhotoRefEntity;
    id: number | "";
  }>({ type: "note", id: "" });
  const [edit, setEdit] = useState({ note: "", takenDate: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await galleryRepo.listPhotos();
      setPhotos(list);
      setError(null);
      return list;
    } catch (e) {
      setError(errText(e));
      return [];
    }
  }, []);

  const loadThumbnails = useCallback(
    async (list: PhotoRow[], isCancelled?: () => boolean) => {
      const next = new Map<number, string>();
      for (const photo of list) {
        if (isCancelled?.()) {
          for (const url of next.values()) URL.revokeObjectURL(url);
          return;
        }
        try {
          const bytes = await galleryRepo.readPhotoBytes(photo.id);
          if (bytes) next.set(photo.id, bytesUrl(bytes));
        } catch {
          // A missing file shows as a placeholder — never break the grid.
        }
      }
      if (isCancelled?.()) {
        for (const url of next.values()) URL.revokeObjectURL(url);
        return;
      }
      for (const [id, url] of urlsRef.current) {
        if (!next.has(id)) URL.revokeObjectURL(url);
      }
      urlsRef.current = next;
      setUrls(next);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await reload();
      if (cancelled) return;
      await loadThumbnails(list, () => cancelled);
      if (cancelled) return;
      try {
        const [ns, ms, js] = await Promise.all([
          notesRepo.listNotes(),
          memoriesRepo.listMemories(),
          businessRepo.listJobs(),
        ]);
        if (cancelled) return;
        setNotes(ns);
        setMemories(ms);
        setJobs(js);
      } catch (e) {
        if (!cancelled) setError(errText(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      for (const url of urlsRef.current.values()) URL.revokeObjectURL(url);
      urlsRef.current = new Map();
    };
  }, [reload, loadThumbnails]);

  const pickFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setSaving(true);
    try {
      for (const file of Array.from(fileList)) {
        const buffer = await file.arrayBuffer();
        const bytes = Array.from(new Uint8Array(buffer));
        const id = await galleryRepo.savePhoto({
          bytes,
          ext: photoExtFromName(file.name),
        });
        const photo = await galleryRepo.getPhoto(id);
        if (photo && !urlsRef.current.has(id)) {
          const next = new Map(urlsRef.current);
          next.set(id, bytesUrl(bytes));
          urlsRef.current = next;
          setUrls(next);
        }
      }
      await reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const select = async (photo: PhotoRow) => {
    setSelected(photo);
    setEdit({ note: photo.note, takenDate: photo.taken_date ?? "" });
    setLinkDraft({ type: "note", id: "" });
    try {
      setSelectedRefs(await galleryRepo.listRefsForPhoto(photo.id));
    } catch (e) {
      setError(errText(e));
    }
  };

  const saveMeta = async () => {
    if (!selected) return;
    try {
      await galleryRepo.updatePhoto(selected.id, {
        note: edit.note,
        takenDate: edit.takenDate.length > 0 ? edit.takenDate : null,
      });
      const updated = await galleryRepo.getPhoto(selected.id);
      if (updated) setSelected(updated);
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  const removePhoto = async (photo: PhotoRow) => {
    try {
      await galleryRepo.deletePhoto(photo.id);
      const url = urlsRef.current.get(photo.id);
      if (url) URL.revokeObjectURL(url);
      const next = new Map(urlsRef.current);
      next.delete(photo.id);
      urlsRef.current = next;
      setUrls(next);
      if (selected?.id === photo.id) {
        setSelected(null);
        setSelectedRefs([]);
      }
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  const titleOf = (type: PhotoRefEntity, id: number): string => {
    if (type === "note")
      return notes.find((n) => n.id === id)?.title ?? `Note #${id}`;
    if (type === "memory")
      return memories.find((m) => m.id === id)?.title ?? `Memory #${id}`;
    return jobs.find((j) => j.id === id)?.title ?? `Job #${id}`;
  };

  const addLink = async () => {
    if (!selected || linkDraft.id === "") return;
    const id = linkDraft.id;
    if (
      selectedRefs.some(
        (r) => r.entity_type === linkDraft.type && r.entity_id === id,
      )
    )
      return;
    try {
      await galleryRepo.addRef(selected.id, linkDraft.type, id);
      setSelectedRefs(await galleryRepo.listRefsForPhoto(selected.id));
      setLinkDraft({ type: linkDraft.type, id: "" });
    } catch (e) {
      setError(errText(e));
    }
  };

  const removeLink = async (ref: PhotoRefRow) => {
    try {
      await galleryRepo.removeRef(ref.id);
      if (selected)
        setSelectedRefs(await galleryRepo.listRefsForPhoto(selected.id));
    } catch (e) {
      setError(errText(e));
    }
  };

  const pickerRows = (): {
    key: PhotoRefEntity;
    label: string;
    rows: { id: number; title: string }[];
  }[] => [
    {
      key: "note",
      label: "Note",
      rows: notes.map((n) => ({ id: n.id, title: n.title })),
    },
    {
      key: "memory",
      label: "Memory",
      rows: memories.map((m) => ({ id: m.id, title: m.title })),
    },
    {
      key: "job",
      label: "Job",
      rows: jobs.map((j) => ({ id: j.id, title: j.title })),
    },
  ];

  return (
    <div className="budget-page">
      <header className="page-header">
        <div className="page-header-main">
          <div className="page-title-row">
            <span className="page-icon-badge">
              <IconGallery className="icon" />
            </span>
            <div>
              <h2 className="editor-title">Photo Gallery</h2>
              <p className="page-subtitle">
                Content-addressed local photo library linked to notes, memories
                &amp; jobs
              </p>
            </div>
          </div>
        </div>
        <div className="page-actions">
          <label className="btn btn-primary">
            <IconPlus className="icon" />
            {saving ? "Saving…" : "Add photos"}
            <input
              className="visually-hidden"
              type="file"
              accept="image/*"
              multiple
              disabled={saving}
              onChange={(e) => {
                void pickFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        </div>
      </header>

      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      <section className="settings-section">
        <div className="dash-card-head">
          <h3 className="side-heading">Stored Photos</h3>
          <span className="badge">{photos.length}</span>
        </div>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : photos.length === 0 ? (
          <EmptyState>
            No photos yet — use “Add photos” to store one.
          </EmptyState>
        ) : (
          <div className="photo-grid">
            {photos.map((photo) => {
              const url = urls.get(photo.id);
              return (
                <button
                  key={photo.id}
                  type="button"
                  className={
                    selected?.id === photo.id
                      ? "photo-thumb is-active"
                      : "photo-thumb"
                  }
                  onClick={() => void select(photo)}
                >
                  {url ? (
                    <img src={url} alt={photo.note || `Photo ${photo.id}`} />
                  ) : (
                    <span className="muted">…</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </section>

      {selected ? (
        <section className="settings-section">
          <div className="dash-card-head">
            <h3 className="side-heading">Photo Inspector</h3>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void removePhoto(selected)}
            >
              Delete photo
            </button>
          </div>
          {urls.get(selected.id) ? (
            <img
              className="photo-full"
              src={urls.get(selected.id)}
              alt={selected.note || `Photo ${selected.id}`}
            />
          ) : null}
          <div className="inline-form">
            <input
              className="input"
              placeholder="Caption or note…"
              aria-label="Photo note"
              value={edit.note}
              onChange={(e) => setEdit({ ...edit, note: e.target.value })}
            />
            <span className="input-icon-wrap">
              <input
                className="input"
                type="date"
                aria-label="Taken date"
                value={edit.takenDate}
                onChange={(e) =>
                  setEdit({ ...edit, takenDate: e.target.value })
                }
              />
              <IconCalendar className="icon input-icon is-end" />
            </span>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void saveMeta()}
            >
              Save
            </button>
          </div>

          <div className="contact-section">
            <h3 className="side-heading">Linked to</h3>
            {selectedRefs.length === 0 ? (
              <p className="muted">Not linked to anything yet.</p>
            ) : (
              <ul className="budget-list">
                {selectedRefs.map((ref) => (
                  <li key={ref.id} className="budget-row">
                    <span>
                      <span className="chip">
                        {ENTITY_LABELS.find((l) => l.key === ref.entity_type)
                          ?.label ?? ref.entity_type}
                      </span>{" "}
                      <b>{titleOf(ref.entity_type, ref.entity_id)}</b>
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => void removeLink(ref)}
                    >
                      Unlink
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void addLink();
              }}
            >
              <select
                className="select"
                aria-label="Link type"
                value={linkDraft.type}
                onChange={(e) =>
                  setLinkDraft({
                    type: e.target.value as PhotoRefEntity,
                    id: "",
                  })
                }
              >
                {ENTITY_LABELS.map((l) => (
                  <option key={l.key} value={l.key}>
                    {l.label}
                  </option>
                ))}
              </select>
              <select
                className="select"
                aria-label="Link target"
                value={linkDraft.id === "" ? "" : String(linkDraft.id)}
                onChange={(e) =>
                  setLinkDraft({
                    ...linkDraft,
                    id: e.target.value === "" ? "" : Number(e.target.value),
                  })
                }
              >
                <option value="">Choose…</option>
                {pickerRows()
                  .find((p) => p.key === linkDraft.type)
                  ?.rows.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.title || `#${r.id}`}
                    </option>
                  ))}
              </select>
              <button
                type="submit"
                className="btn"
                disabled={linkDraft.id === ""}
              >
                Link
              </button>
            </form>
          </div>
        </section>
      ) : null}
    </div>
  );
}
