// P3e Gallery page: photo storage via the driver's content-addressed
// photo commands; the page adds pick-to-save, thumbnails, per-photo
// note/taken-date, links to notes/memories/jobs (photo_refs) and delete.
// Talks only to the gallery + picker repos.
//
// Memory discipline: the grid holds one ~30 kB thumbnail per
// photo, and the full-resolution bytes of exactly ONE photo — the open
// inspector — are decoded at a time and their object URL released the moment
// the selection changes, closes, or the photo is deleted. Thumbnails are
// generated here (canvas) once per photo and stored beside it, so a grid visit
// only ever reads thumbs.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import {
  IconCalendar,
  IconClose,
  IconGallery,
  IconPlus,
  IconTrash,
} from "../components/icons.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import {
  businessRepo,
  galleryRepo,
  memoriesRepo,
  notesRepo,
} from "../data/app.ts";
import { errText } from "../lib/errors.ts";
import { createThumbUrlBook, photoExtFromName } from "../lib/gallery.ts";
import { createLoadGuard } from "../lib/loads.ts";
import { makeThumbnail } from "../lib/thumbs.ts";
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

function bytesUrl(bytes: Uint8Array): string {
  return URL.createObjectURL(new Blob([bytes as BlobPart]));
}

export default function GalleryPage() {
  const [photos, setPhotos] = useState<PhotoRow[]>([]);
  /** Grid object URLs — one small thumbnail per photo. */
  const [thumbs, setThumbs] = useState<Map<number, string>>(new Map());
  /**
   * Owns every grid object URL (review P2-4). The page used to keep a bare
   * `thumbsRef` and revoke inline, which leaked one URL per still-visible
   * photo on every reload — see `createThumbUrlBook`.
   */
  const thumbUrls = useMemo(
    () =>
      createThumbUrlBook({
        create: bytesUrl,
        revoke: (url) => URL.revokeObjectURL(url),
      }),
    [],
  );
  /** The ONE full-resolution image that is currently open, if any. */
  const [full, setFull] = useState<{ id: number; url: string } | null>(null);
  const fullRef = useRef<{ id: number; url: string } | null>(null);
  const fullReqRef = useRef(0);
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

  /**
   * Small bytes for a grid tile: the stored thumbnail, or one generated from
   * the full-res bytes and stored for next time. Photos saved before this
   * phase — and photos restored from a backup, which deliberately carry no
   * thumbnails — pay that cost once.
   */
  const thumbBytesFor = useCallback(async (photo: PhotoRow) => {
    const stored = await galleryRepo.readThumbBytes(photo.id).catch(() => null);
    if (stored && stored.length > 0) return stored;
    const bytes = await galleryRepo.readPhotoBytes(photo.id);
    if (!bytes) throw new Error(`Photo ${photo.id} could not be read.`);
    const thumb = await makeThumbnail(bytes);
    // Best effort: a failed write costs a regeneration later, never a tile.
    await galleryRepo.saveThumb(photo.id, thumb).catch(() => undefined);
    return thumb;
  }, []);

  const loadThumbs = useCallback(
    async (list: PhotoRow[], isCancelled?: () => boolean) => {
      const next = new Map<number, string>();
      for (const photo of list) {
        if (isCancelled?.()) break;
        try {
          next.set(photo.id, thumbUrls.create(await thumbBytesFor(photo)));
        } catch {
          // Missing or undecodable: a placeholder tile — never break the grid.
        }
      }
      if (isCancelled?.()) {
        // These URLs were never tracked, so the book cannot know about them.
        thumbUrls.revokeAll(next.values());
        return;
      }
      setThumbs(thumbUrls.swap(next));
    },
    [thumbBytesFor, thumbUrls],
  );

  /** Release the open full-resolution image (replacing one drops the old). */
  const dropFull = useCallback(() => {
    if (fullRef.current) URL.revokeObjectURL(fullRef.current.url);
    fullRef.current = null;
    fullReqRef.current += 1;
    setFull(null);
  }, []);

  /** Guards the link list against an out-of-order select. */
  const refsGuard = useMemo(() => createLoadGuard(), []);

  const loadFull = async (photo: PhotoRow) => {
    const req = ++fullReqRef.current;
    try {
      const bytes = await galleryRepo.readPhotoBytes(photo.id);
      if (!bytes || req !== fullReqRef.current) return;
      const url = bytesUrl(bytes);
      if (fullRef.current) URL.revokeObjectURL(fullRef.current.url);
      fullRef.current = { id: photo.id, url };
      setFull(fullRef.current);
    } catch (e) {
      if (req === fullReqRef.current) setError(errText(e));
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await reload();
      if (cancelled) return;
      await loadThumbs(list, () => cancelled);
      if (cancelled) return;
      try {
        const [ns, ms, js] = await Promise.all([
          // title-only query: notesRepo.listNotes({ projection: "title" })
          notesRepo.listNoteTitles(),
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
      thumbUrls.clear();
      if (fullRef.current) URL.revokeObjectURL(fullRef.current.url);
      fullRef.current = null;
    };
  }, [reload, loadThumbs, thumbUrls]);

  const pickFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setSaving(true);
    try {
      for (const file of Array.from(fileList)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const id = await galleryRepo.savePhoto({
          bytes,
          ext: photoExtFromName(file.name),
        });
        // Thumbnail right away: the grid then never reads these bytes again.
        // Undecodable in this webview means no tile image (the inspector could
        // not have shown it either) — the photo itself is saved either way.
        const thumb = await makeThumbnail(bytes).catch(() => null);
        if (thumb) {
          await galleryRepo.saveThumb(id, thumb).catch(() => undefined);
        }
      }
      // One reload path for both the list and the thumbnails: a just-saved
      // photo has a stored thumbnail, so this only reads small bytes.
      await loadThumbs(await reload());
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
    // Full resolution only for the photo that is actually open.
    void loadFull(photo);
    // Clicking photo A then photo B can resolve in the other order, which left
    // A's link list rendered under B.
    const token = refsGuard.begin();
    try {
      const refs = await galleryRepo.listRefsForPhoto(photo.id);
      if (refsGuard.isCurrent(token)) setSelectedRefs(refs);
    } catch (e) {
      if (refsGuard.isCurrent(token)) setError(errText(e));
    }
  };

  const closeInspector = useCallback(() => {
    dropFull();
    refsGuard.cancel();
    setSelected(null);
  }, [dropFull, refsGuard]);

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
      setThumbs(thumbUrls.drop(photo.id));
      if (selected?.id === photo.id) {
        if (fullRef.current?.id === photo.id) dropFull();
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

  const addingLinkRef = useRef(false);
  const [addingLink, setAddingLink] = useState(false);
  const addLink = async () => {
    if (addingLinkRef.current) return;
    if (!selected || linkDraft.id === "") return;
    const id = linkDraft.id;
    if (
      selectedRefs.some(
        (r) => r.entity_type === linkDraft.type && r.entity_id === id,
      )
    )
      return;
    addingLinkRef.current = true;
    setAddingLink(true);
    try {
      await galleryRepo.addRef(selected.id, linkDraft.type, id);
      setSelectedRefs(await galleryRepo.listRefsForPhoto(selected.id));
      setLinkDraft({ type: linkDraft.type, id: "" });
    } catch (e) {
      setError(errText(e));
    } finally {
      addingLinkRef.current = false;
      setAddingLink(false);
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
          <div className="skeleton-grid">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton
                key={`thumb-${i}`}
                variant="card"
                className="is-thumb"
              />
            ))}
          </div>
        ) : photos.length === 0 ? (
          <EmptyState>
            No photos yet — use “Add photos” to store one.
          </EmptyState>
        ) : (
          <div className="photo-grid">
            {photos.map((photo) => {
              const url = thumbs.get(photo.id);
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
                  {photo.note ? (
                    <span className="photo-thumb-overlay">{photo.note}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </section>

      {selected ? (
        <Dialog labelledBy="photo-inspector-title" onClose={closeInspector}>
          <div className="modal-head">
            <h3 className="side-heading" id="photo-inspector-title">
              Photo Inspector
            </h3>
            <div className="editor-row">
              <ConfirmButton
                className="btn btn-danger"
                what="photo"
                onConfirm={() => removePhoto(selected)}
              >
                <IconTrash className="icon" /> Delete photo
              </ConfirmButton>
              <button
                type="button"
                className="btn btn-icon"
                aria-label="Close photo inspector"
                title="Close"
                // biome-ignore lint/a11y/noAutofocus: the dialog's first stop
                autoFocus
                onClick={closeInspector}
              >
                <IconClose className="icon" />
              </button>
            </div>
          </div>
          {/* Full resolution once it arrives; the thumbnail — already in
           *  memory — stands in while the bytes are read. */}
          {full?.id === selected.id ? (
            <img
              className="photo-full"
              src={full.url}
              alt={selected.note || `Photo ${selected.id}`}
            />
          ) : thumbs.get(selected.id) ? (
            <img
              className="photo-full"
              src={thumbs.get(selected.id)}
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
                disabled={linkDraft.id === "" || addingLink}
              >
                Link
              </button>
            </form>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
