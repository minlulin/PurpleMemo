// Quick capture inbox.
//
// One action captures; the list is what is left to decide about. The shell can
// also capture from anywhere (Ctrl+Shift+M), and `capturesMade` is how that
// tells this page to re-read — the same channel the reminder poll uses.
//
// The idempotency of conversion lives in the data layer (`lib/inbox.ts`), not
// here: a second click finds the row already converted, receives the recorded
// target, and says so. The in-flight refs below are UX, so a double-click does
// not even reach the database twice.

import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { IconInbox, IconSpinner } from "../components/icons.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { useToast } from "../components/Toast.tsx";
import { useLocale, useT } from "../components/useTranslation.ts";
import { inboxRepo, journalRepo, settingsRepo } from "../data/app.ts";
import { todayLocal } from "../lib/dates.ts";
import {
  appendJournalBlock,
  draftBaseMatches,
  loadJournalDraft,
  saveJournalDraft,
} from "../lib/drafts.ts";
import { errText } from "../lib/errors.ts";
import { formatDateTime } from "../lib/format.ts";
import type { MessageKey } from "../lib/i18n.ts";
import { journalBlock, targetKey } from "../lib/inbox.ts";
import type { InboxRow, InboxTarget } from "../lib/types.ts";

interface InboxPageProps {
  /** Bumped by the shell whenever it captured something from anywhere. */
  capturesMade: number;
}

const TARGET_LABELS: Record<InboxTarget, MessageKey> = {
  note: "inbox.target.note",
  task: "inbox.target.task",
  journal: "inbox.target.journal",
};

/** One word on a button is the whole budget here — three targets, three verbs. */
const TARGET_BUTTONS: { target: InboxTarget; label: MessageKey }[] = [
  { target: "note", label: "inbox.makeNote" },
  { target: "task", label: "inbox.makeTask" },
  { target: "journal", label: "inbox.addToJournal" },
];

/**
 * Fold the just-appended block into the day's unsaved journal draft (D1).
 *
 * The journal target appends to today's SHARED entry from behind the journal
 * editor's back, and `loadEntry` restores a day draft over the row whenever its
 * base still matches. So the exact block the batch appended is folded into a
 * draft written against the PRE-append base — the settings-side twin of the
 * row's `ON CONFLICT ... DO UPDATE`, and the same fold `NotesPage.handleToJournal`
 * does for its own append. Without it, a same-day draft restores over the entry
 * that now holds the block (the block invisible, the next Save wiping it), or
 * the new base makes the draft look stale and drops the user's unsaved typing.
 * Any draft written against another base stays stale and is dropped on the next
 * load, never merged — drafts.ts's rule. Best-effort: the entry append has
 * already succeeded, so a failure here must not fail the conversion.
 */
async function foldJournalDraft(
  entryDate: string,
  baseBefore: string | null,
  body: string,
): Promise<void> {
  try {
    const draft = await loadJournalDraft(settingsRepo, entryDate);
    if (draft === null || !draftBaseMatches(draft.baseUpdatedAt, baseBefore)) {
      return;
    }
    await saveJournalDraft(settingsRepo, entryDate, {
      // The batch stamps the row's `updated_at` with today's date.
      baseUpdatedAt: todayLocal(),
      savedAt: Date.now(),
      // The same helper the batch's `excluded.content` goes through, so the
      // draft and the row can never disagree on what the block is.
      content: appendJournalBlock(draft.content, journalBlock(body)),
    });
  } catch {
    // Best-effort: the appended entry is already stored.
  }
}

export default function InboxPage(p: InboxPageProps) {
  const toast = useToast();
  const t = useT();
  const locale = useLocale();
  const [items, setItems] = useState<InboxRow[]>([]);
  const [archived, setArchived] = useState<InboxRow[]>([]);
  const [converted, setConverted] = useState<InboxRow[]>([]);
  const [live, setLive] = useState<Map<string, boolean>>(new Map());
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  /**
   * In-flight capture guard. A ref, because the repository cannot tell a retry
   * from a second click, and a `useState` flag would be read as stale inside
   * the same tick the click was delivered (review P3-12).
   */
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  /**
   * Which row is converting — the LABEL is per row; the lock itself is
   * deliberately GLOBAL: one reload replaces every section at once, and two
   * concurrent journal conversions could interleave their draft folds (D10).
   * `disabled={convertingId !== null}` below is that global lock, made
   * visible, and `archive` raises the matching pair so a Convert click can
   * never race an Archive commit. The ref is authoritative, the state is what
   * the buttons read.
   */
  const convertingRef = useRef<number | null>(null);
  const [convertingId, setConvertingId] = useState<number | null>(null);
  /** Archive in flight (D10) — same shape, so its double-click never reaches
   *  the database twice and no Convert lands behind it. */
  const archivingRef = useRef<number | null>(null);
  const [archivingId, setArchivingId] = useState<number | null>(null);
  /** Sequence token: only the newest reload may install its snapshot (D6). */
  const reloadSeqRef = useRef(0);

  /**
   * Render a caught value: a keyed inbox refusal in the locale active right
   * now (D11 — `errText` resolves message keys itself, J6), anything else
   * through the shared raw-text helper.
   */
  const errMessage = (e: unknown): string => errText(e);

  const reload = useCallback(async () => {
    const seq = ++reloadSeqRef.current;
    // The list is knowingly pre-write while this runs: say so, instead of
    // leaving the old rows sitting there as if current (D6 — the B9 second
    // half). Two overlapping reloads (a row action and the capturesMade
    // signal, or an "Earlier" flip) used to let the older snapshot land last.
    setLoading(true);
    try {
      const open = await inboxRepo.listOpen();
      const done = await inboxRepo.listByStatus("converted");
      const away = showArchived ? await inboxRepo.listByStatus("archived") : [];
      const liveTargets = await inboxRepo.liveTargets(done);
      if (seq !== reloadSeqRef.current) return; // superseded — newest wins
      setLive(liveTargets);
      setItems(open);
      setConverted(done);
      setArchived(away);
      setError(null);
    } catch (e) {
      // Reload only reads: its failures are driver errors, never the keyed
      // conversion refusals — so no `t` is captured here and this callback
      // keeps its identity across renders.
      if (seq === reloadSeqRef.current) setError(errText(e));
    } finally {
      if (seq === reloadSeqRef.current) setLoading(false);
    }
  }, [showArchived]);

  // `capturesMade` is deliberately not read in the body: it is a signal, not
  // data, and its whole job is to change this effect's identity — the same
  // arrangement TasksPage uses for `refreshKey`. Keying the page on it would
  // remount and discard a half-typed memo, trading a stale list for lost
  // typing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: signal, not data
  useEffect(() => {
    void reload();
  }, [reload, p.capturesMade]);

  /**
   * Capture, then clear.
   *
   * There is no draft and no autosave: the row is written on submit, which is
   * the whole promise of quick capture. The residual window is the text between
   * the last keystroke and the submit — a crash there loses what was typed, and
   * it is not called crash-safe anywhere.
   */
  const capture = async () => {
    if (savingRef.current) return;
    if (text.trim().length === 0) {
      setError(t("capture.empty"));
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await inboxRepo.create(text);
      setText("");
      await reload();
      toast.success(t("capture.saved"));
    } catch (e) {
      setError(errMessage(e));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const convert = async (row: InboxRow, target: InboxTarget) => {
    if (convertingRef.current !== null) return;
    // An Archive commits status='archived', which this batch's `status =
    // 'open'` claim then refuses — a Convert landing behind an in-flight
    // Archive would file the user's convert intent as an archived capture
    // (D10), and archived rows can never be converted at all.
    if (archivingRef.current !== null) return;
    convertingRef.current = row.id;
    setConvertingId(row.id);
    setError(null);
    try {
      // D1: the journal target appends to today's SHARED entry. Read the
      // pre-append base FIRST (the batch rewrites `updated_at`) and only for a
      // row this call will actually append to — the repo refuses a row that is
      // not open, and an early return appends nothing to fold.
      const entryDate =
        target === "journal" && row.status === "open" ? todayLocal() : null;
      const baseBefore =
        entryDate === null
          ? null
          : ((await journalRepo.getEntry(entryDate))?.updated_at ?? null);
      const result = await inboxRepo.convert(row.id, target);
      if (entryDate !== null) {
        await foldJournalDraft(entryDate, baseBefore, row.body);
      }
      // Deliberately does not claim authorship: if another click won the race,
      // this is the target that other call created, and the message stays true.
      toast.success(
        t("inbox.convertedToast", {
          target: t(TARGET_LABELS[result.type]),
          id: result.id,
        }),
      );
      await reload();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      convertingRef.current = null;
      setConvertingId(null);
    }
  };

  const archive = async (row: InboxRow) => {
    // The mirror image of convert's check (D10): while a conversion is in
    // flight this row may be about to become `converted`, which the guarded
    // UPDATE (`WHERE status = 'open'`) would then undo by archiving it.
    if (convertingRef.current !== null) return;
    if (archivingRef.current !== null) return;
    archivingRef.current = row.id;
    setArchivingId(row.id);
    setError(null);
    try {
      await inboxRepo.archive(row.id);
      await reload();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      archivingRef.current = null;
      setArchivingId(null);
    }
  };

  /** Named, because a ConfirmButton's `onConfirm` may not do the write itself. */
  const removeCapture = async (row: InboxRow) => {
    setError(null);
    try {
      await inboxRepo.deleteItem(row.id);
      await reload();
    } catch (e) {
      setError(errMessage(e));
    }
  };

  return (
    <div className="budget-page">
      <header className="page-header">
        <div className="page-header-main">
          <div className="page-title-row">
            <span className="page-icon-badge">
              <IconInbox className="icon" />
            </span>
            <div>
              <h2 className="editor-title">{t("inbox.title")}</h2>
              <p className="page-subtitle">{t("inbox.subtitle")}</p>
            </div>
          </div>
        </div>
      </header>

      <form
        className="entry-form"
        onSubmit={(e) => {
          e.preventDefault();
          void capture();
        }}
      >
        <label>
          {t("inbox.newMemo")}
          <textarea
            className="input"
            rows={3}
            aria-label={t("inbox.newMemo")}
            placeholder={t("inbox.placeholder")}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void capture();
              }
            }}
          />
        </label>
        <div className="editor-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || text.trim().length === 0}
          >
            {saving && <IconSpinner className="icon" />}
            {saving ? t("inbox.capturing") : t("inbox.capture")}
          </button>
        </div>
      </form>

      {loading ? (
        <div className="dashboard-grid">
          {[0, 1].map((i) => (
            <Skeleton key={`inbox-${i}`} variant="card" />
          ))}
        </div>
      ) : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      {items.length === 0 && !loading ? (
        <section className="settings-section">
          <EmptyState>{t("inbox.empty")}</EmptyState>
        </section>
      ) : (
        <ul className="budget-list">
          {items.map((row) => (
            <li key={row.id} className="budget-row">
              <div className="row-main">
                <p className="row-title inbox-body">{row.body}</p>
                <span className="row-sub">
                  {t("inbox.capturedAt", {
                    date: formatDateTime(locale, row.created_at),
                  })}
                </span>
              </div>
              <span className="row-actions">
                {TARGET_BUTTONS.map(({ target, label }) => (
                  <button
                    key={target}
                    type="button"
                    className={target === "note" ? "btn btn-primary" : "btn"}
                    disabled={convertingId !== null || archivingId !== null}
                    onClick={() => void convert(row, target)}
                  >
                    {convertingId === row.id ? t("inbox.converting") : t(label)}
                  </button>
                ))}
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={convertingId !== null || archivingId !== null}
                  onClick={() => void archive(row)}
                >
                  {archivingId === row.id
                    ? t("inbox.archiving")
                    : t("inbox.archive")}
                </button>
                <ConfirmButton
                  className="btn btn-ghost"
                  what={t("inbox.what.capture")}
                  onConfirm={() => removeCapture(row)}
                >
                  {t("common.delete")}
                </ConfirmButton>
              </span>
            </li>
          ))}
        </ul>
      )}

      <section className="settings-section">
        <div className="dash-card-head">
          <h3 className="settings-heading">{t("inbox.earlier")}</h3>
          <span className="badge">{t("inbox.earlierBadge")}</span>
        </div>
        <p className="muted">{t("inbox.earlierNote")}</p>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setShowArchived(!showArchived)}
          aria-expanded={showArchived}
        >
          {showArchived ? t("inbox.hide") : t("inbox.show")}
        </button>
        {showArchived ? (
          <ul className="budget-list">
            {archived.length === 0 && converted.length === 0 && (
              <li className="budget-row">
                <span className="muted">{t("inbox.nothingEarlier")}</span>
              </li>
            )}
            {converted.map((row) => (
              <li key={`converted-${row.id}`} className="budget-row">
                <div className="row-main">
                  <p className="row-title inbox-body">{row.body}</p>
                  <span className="row-sub">
                    {row.converted_type !== null && row.converted_id !== null
                      ? isTargetLive(live, row)
                        ? t("inbox.convertedTo", {
                            target: t(TARGET_LABELS[row.converted_type]),
                            id: row.converted_id,
                          })
                        : t("inbox.convertedGone", {
                            target: t(TARGET_LABELS[row.converted_type]),
                            id: row.converted_id,
                          })
                      : t("inbox.convertedOnly")}
                  </span>
                </div>
                <ConfirmButton
                  className="btn btn-ghost"
                  what={t("inbox.what.convertedCapture")}
                  onConfirm={() => removeCapture(row)}
                >
                  {t("common.delete")}
                </ConfirmButton>
              </li>
            ))}
            {archived.map((row) => (
              <li key={`archived-${row.id}`} className="budget-row">
                <div className="row-main">
                  <p className="row-title inbox-body">{row.body}</p>
                  <span className="row-sub">
                    {t("inbox.archivedAt", {
                      date: formatDateTime(locale, row.created_at),
                    })}
                  </span>
                </div>
                <ConfirmButton
                  className="btn btn-ghost"
                  what={t("inbox.what.archivedCapture")}
                  onConfirm={() => removeCapture(row)}
                >
                  {t("common.delete")}
                </ConfirmButton>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

/**
 * Whether a recorded target still exists.
 *
 * False means "unavailable", which is shown rather than hidden: a capture whose
 * note was deleted afterwards still happened, and the row still says what it
 * became.
 */
function isTargetLive(live: Map<string, boolean>, row: InboxRow): boolean {
  if (row.converted_type === null || row.converted_id === null) return false;
  return live.get(targetKey(row.converted_type, row.converted_id)) ?? false;
}
