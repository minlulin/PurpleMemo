// Full-view pop-up note reader modal.
//
// Gives notes a dedicated, spacious reading canvas with rendered Markdown,
// metadata tags, word counts, copy affordances, and next/prev note navigation.
// Wrapped in the shared <Dialog> so keyboard focus trap, Esc, and backdrop
// dismissal behave consistently with the rest of the application.

import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { formatDate } from "../lib/format.ts";
import { parseTags } from "../lib/notes.ts";
import type { NoteRow } from "../lib/types.ts";
import { Dialog } from "./Dialog.tsx";
import {
  IconArrowLeft,
  IconArrowRight,
  IconClose,
  IconCopy,
  IconFolder,
  IconPin,
} from "./icons.tsx";
import { markdownComponents } from "./MarkdownLink.tsx";
import { useToast } from "./Toast.tsx";
import { useLocale, usePlural, useT } from "./useTranslation.ts";

interface NoteReaderDialogProps {
  note: NoteRow;
  collectionName?: string | null;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
}

export function NoteReaderDialog({
  note,
  collectionName,
  onClose,
  onPrev,
  onNext,
  hasPrev = false,
  hasNext = false,
}: NoteReaderDialogProps) {
  const t = useT();
  const locale = useLocale();
  const plural = usePlural();
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const tags = useMemo(() => parseTags(note.tags), [note.tags]);

  const words = useMemo(() => {
    const trimmed = note.content.trim();
    return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
  }, [note.content]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(note.content);
      setCopied(true);
      toast.success(t("notes.copied"));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback if clipboard API is not available
      toast.error(t("common.tryAgain"));
    }
  }, [note.content, t, toast]);

  // Arrow key navigation between notes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (e.key === "ArrowLeft" && hasPrev && onPrev) {
        e.preventDefault();
        onPrev();
      } else if (e.key === "ArrowRight" && hasNext && onNext) {
        e.preventDefault();
        onNext();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasPrev, hasNext, onPrev, onNext]);

  return (
    <Dialog
      labelledBy="note-reader-title"
      className="note-reader-modal"
      onClose={onClose}
    >
      <div className="note-reader-header">
        <div className="note-reader-heading-wrap">
          <h2 id="note-reader-title" className="note-reader-title">
            {note.title.trim().length > 0 ? note.title : t("notes.untitled")}
          </h2>
          <div className="note-reader-meta">
            {note.pinned === 1 && (
              <span className="badge badge-accent">
                <IconPin className="icon" /> {t("notes.pinned")}
              </span>
            )}
            {note.archived === 1 && (
              <span className="badge">{t("notes.archivedBadge")}</span>
            )}
            {collectionName ? (
              <span className="badge">
                <IconFolder className="icon" /> {collectionName}
              </span>
            ) : null}
            {tags.map((tag) => (
              <span key={tag} className="tag-row">
                #{tag}
              </span>
            ))}
            <span className="meta-date figure">
              {formatDate(locale, note.updated_at)}
            </span>
            <span>·</span>
            <span className="figure">{plural("notes.wordCount", words)}</span>
          </div>
        </div>
        <button
          type="button"
          className="btn btn-icon"
          aria-label={t("common.closeDialog")}
          title={t("common.close")}
          // biome-ignore lint/a11y/noAutofocus: first stop for the reader dialog
          autoFocus
          onClick={onClose}
        >
          <IconClose className="icon" />
        </button>
      </div>

      <div className="note-reader-body markdown">
        {note.content.trim().length === 0 ? (
          <p className="empty-state">{t("notes.previewEmpty")}</p>
        ) : (
          <ReactMarkdown components={markdownComponents}>
            {note.content}
          </ReactMarkdown>
        )}
      </div>

      <div className="note-reader-footer">
        <div className="note-reader-nav">
          <button
            type="button"
            className="btn"
            disabled={!hasPrev}
            onClick={onPrev}
            title={t("notes.prevNote")}
          >
            <IconArrowLeft className="icon" /> {t("notes.prevNote")}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!hasNext}
            onClick={onNext}
            title={t("notes.nextNote")}
          >
            {t("notes.nextNote")} <IconArrowRight className="icon" />
          </button>
        </div>
        <div className="note-reader-actions">
          <button
            type="button"
            className="btn"
            onClick={() => void handleCopy()}
          >
            <IconCopy className="icon" />{" "}
            {copied ? t("notes.copied") : t("notes.copyMarkdown")}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
