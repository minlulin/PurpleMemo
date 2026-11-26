// The phone's Notes screens: the list, the compose form, and the reader a
// Dashboard preview opens as its own route, so the Android back gesture
// closes it instead of leaving the app.

import { useCallback, useState } from "react";
import ReactMarkdown from "react-markdown";
import { notesRepo } from "../../data/app.ts";
import { EmptyState } from "../EmptyState.tsx";
import {
  MarkdownDocument,
  markdownComponents,
  markdownUrlTransform,
} from "../MarkdownLink.tsx";
import { useT } from "../useTranslation.ts";
import { LoadMessage, useLoad } from "./common.tsx";

// -- Notes -------------------------------------------------------------------

export function NotesScreen({ onCompose }: { onCompose: () => void }) {
  const t = useT();
  const load = useCallback(() => notesRepo.listNotes({ limit: 100 }), []);
  const { data, failed, reload } = useLoad(load);

  return (
    <section className="mobile-page">
      <p className="mobile-section-kicker">{t("nav.notes")}</p>
      <div className="mobile-actions">
        <button type="button" className="btn btn-primary" onClick={onCompose}>
          {t("notes.newNote")}
        </button>
      </div>
      <LoadMessage failed={failed} />
      {data !== null && data.length === 0 ? (
        <EmptyState>{t("notes.noNotes")}</EmptyState>
      ) : null}
      <ul className="mobile-list" aria-label={t("notes.notesAria")}>
        {(data ?? []).map((note) => (
          <li key={note.id} className="mobile-card">
            <p className="mobile-card-title">
              {note.title.trim() === "" ? t("notes.untitled") : note.title}
            </p>
            <p className="mobile-card-body">
              {note.content.trim() === "" ? t("notes.noExcerpt") : note.content}
            </p>
            <p className="mobile-card-meta">{note.updated_at}</p>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="mobile-link-btn"
        onClick={reload}
        hidden={!failed}
      >
        {t("common.tryAgain")}
      </button>
    </section>
  );
}

export function NoteCompose({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const empty = title.trim() === "" && content.trim() === "";

  const save = async () => {
    if (empty || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await notesRepo.createNote({ title: title.trim(), content });
      onDone();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mobile-page">
      <form
        className="mobile-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="mobile-field">
          <span>{t("notes.titleAria")}</span>
          <input
            className="input"
            type="text"
            value={title}
            placeholder={t("mobile.noteTitlePlaceholder")}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
        </label>
        <label className="mobile-field">
          <span>{t("notes.contentAria")}</span>
          <textarea
            className="input mobile-textarea"
            value={content}
            placeholder={t("notes.contentPlaceholder")}
            rows={6}
            onChange={(event) => setContent(event.currentTarget.value)}
          />
        </label>
        <LoadMessage failed={failed} />
        <div className="mobile-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || empty}
          >
            {busy ? t("notes.saving") : t("notes.save")}
          </button>
        </div>
      </form>
    </section>
  );
}

/**
 * A note opened from the Dashboard preview. Its own screen (a route, not a
 * dialog) so the Android back gesture closes it instead of leaving the app.
 */
export function NoteReaderScreen({ noteId }: { noteId: number }) {
  const t = useT();
  const load = useCallback(() => notesRepo.getNote(noteId), [noteId]);
  const { data, failed, reload } = useLoad(load);

  return (
    <section className="mobile-page">
      <LoadMessage failed={failed} />
      <button
        type="button"
        className="mobile-link-btn"
        onClick={reload}
        hidden={!failed}
      >
        {t("common.tryAgain")}
      </button>
      {data === null ? null : data === undefined ? (
        <EmptyState>{t("mobile.noteReader.notFound")}</EmptyState>
      ) : (
        <article className="mobile-reader">
          <h2 className="mobile-reader-title">
            {data.title.trim() === "" ? t("notes.untitled") : data.title}
          </h2>
          <p className="mobile-card-meta">{data.updated_at}</p>
          {data.content.trim() === "" ? (
            <EmptyState>{t("mobile.noteReader.empty")}</EmptyState>
          ) : (
            <div className="mobile-reader-body">
              {/* One heading-id scope per note, so each note's own
                  `#introduction` anchors resolve (audit A4). */}
              <MarkdownDocument documentKey={`note:${noteId}`}>
                <ReactMarkdown
                  components={markdownComponents}
                  urlTransform={markdownUrlTransform}
                >
                  {data.content}
                </ReactMarkdown>
              </MarkdownDocument>
            </div>
          )}
        </article>
      )}
    </section>
  );
}
