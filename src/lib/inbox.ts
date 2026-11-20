// Quick capture inbox.
//
// Capture is one action: type, submit, done. The row stays `open` until the
// user decides what it is, and conversion then produces exactly one note, task
// or journal entry.
//
// The whole design rests on one property: **a conversion is idempotent in the
// database, not merely in the UI.** Every conversion is a single
// `driver.batch` in which the write to the target and the claim on the inbox
// row are the same transaction, and every statement is guarded by
// `status = 'open'`. So a double-click, a retry after a timeout, or a second
// window racing the first cannot produce a second target: the loser's inserts
// match no rows, and it reads back the target the winner recorded.
//
// `converted_type` / `converted_id` are therefore historical metadata rather
// than a live link. They stay after the target is deleted (the UI shows the
// target as unavailable), they round-trip through backup payloads, and a retry
// answers with them instead of converting again.

import type { BatchStatement, DataDriver } from "../data/driver.ts";
import { todayLocal } from "./dates.ts";
import { JOURNAL_BLOCK_SEPARATOR } from "./drafts.ts";
import { type MessageKey, type MessageParams, translate } from "./i18n.ts";
import { outboxStatements } from "./sync/store.ts";
import type { InboxRow, InboxStatus, InboxTarget } from "./types.ts";
import { newUid } from "./uid.ts";

/** What a capture can become. `journal` updates today's entry instead. */
export const INBOX_TARGETS: InboxTarget[] = ["note", "task", "journal"];

/**
 * A refused inbox action, carrying a translation key instead of a
 * pre-rendered sentence (D11). The inbox page is fully localized, and these
 * refusals are reached precisely on the stale-list and raced-click paths —
 * English thrown at a Burmese user is the failure being fixed. The page
 * renders the key through `isMessageKeyError`; `message` is the readable
 * fallback for logs, for `errText`, and for callers that only read
 * `Error.message` (the tests among them) — the `CsvImportError` shape, except
 * that the fallback is pinned to English rather than the active locale, so it
 * is deterministic wherever the code runs. The sentence the page shows comes
 * from the key anyway.
 */
export class InboxError extends Error {
  readonly messageKey: MessageKey;
  readonly params: MessageParams;

  constructor(messageKey: MessageKey, params: MessageParams = {}) {
    super(translate("en", messageKey, params));
    this.name = "InboxError";
    this.messageKey = messageKey;
    this.params = params;
  }
}

/** Characters a derived note title collapses to. */
const TITLE_MAX_CHARS = 60;

/** The tables a recorded target can live in — a closed, code-owned set. */
const TARGET_TABLES: Record<InboxTarget, string> = {
  note: "notes",
  task: "tasks",
  journal: "journal_entries",
};

/**
 * A conversion result: the target that exists afterwards.
 *
 * Deliberately carries no "did this call create it?" flag. A batch hands back
 * no row counts, so a caller that lost the race reads the same converted row
 * the winner wrote and cannot tell the difference — and a flag that says
 * "created" for both is a lie the UI would repeat to the user. The target id
 * is the answer; the row it names is the truth.
 */
export interface InboxConversion {
  type: InboxTarget;
  id: number;
}

/**
 * The display title for a note converted from a capture: the first line that
 * has content on it, whitespace collapsed, capped.
 *
 * Non-destructive by construction — the whole body stays the note's content,
 * so a title that cuts mid-sentence loses nothing that is not still stored.
 * Non-empty input always yields a non-empty title, because the caller has
 * already refused a blank body.
 */
export function inboxTitle(body: string): string {
  for (const line of body.split("\n")) {
    const collapsed = line.replace(/\s+/g, " ").trim();
    if (collapsed.length === 0) continue;
    return collapsed.length > TITLE_MAX_CHARS
      ? `${collapsed.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`
      : collapsed;
  }
  return "";
}

/** The block appended to today's journal entry, exactly as captured. */
export function journalBlock(body: string): string {
  return body;
}

/**
 * Claim guard shared by every conversion.
 *
 * `status = 'open'` is the whole mechanism: the target insert, the journal
 * upsert and the claim all match no rows for a row that is not open, so a lost
 * race writes nothing at all rather than a second target.
 */
const OPEN_CLAIM = "SELECT 1 FROM inbox_items WHERE id = ? AND status = 'open'";

/**
 * The claim, and the LAST statement of every conversion.
 *
 * `converted_id` is resolved from the target's own identity rather than from
 * `last_insert_rowid()`: the sync statements between the target insert and
 * this claim insert rows of their own, so "the last insert" would name an
 * outbox or stamp row. The uid (or the journal date) is the one thing in the
 * batch that names the target without depending on statement order.
 */
function claimStatement(
  type: InboxTarget,
  idSelect: string,
  idSelectParams: readonly unknown[],
  inboxId: number,
): BatchStatement {
  return {
    sql: `UPDATE inbox_items
          SET status = 'converted', converted_type = ?, converted_id = ${idSelect}
          WHERE id = ? AND status = 'open'`,
    params: [type, ...idSelectParams, inboxId],
  };
}

/**
 * The batch for one conversion. Exported for tests: the SQL is the guarantee,
 * so it is asserted directly rather than through a mock's call log.
 */
export function convertStatements(
  id: number,
  target: InboxTarget,
  body: string,
  entryDate: string = todayLocal(),
): BatchStatement[] {
  const today = todayLocal();
  // A converted capture produces an ordinary record, so it carries the same
  // things every other create path gives one: a uid minted by the device that
  // creates it, a create op and the row stamp, all in this batch (§6.1).
  // Without them the note existed only on this machine — invisible to a
  // snapshot (`WHERE uid IS NOT NULL`), and unrecordable by any later edit.
  if (target === "note") {
    const uid = newUid();
    const title = inboxTitle(body);
    const fields = {
      title,
      content: body,
      tags: "",
      collection_uid: null,
      pinned: 0,
      archived: 0,
      created_at: today,
      updated_at: today,
    };
    return [
      {
        sql: `INSERT INTO notes (title, content, tags, collection_id, pinned, archived, created_at, updated_at, uid)
              SELECT ?, ?, '', NULL, 0, 0, ?, ?, ?
              WHERE EXISTS (${OPEN_CLAIM})`,
        params: [title, body, today, today, uid, id],
      },
      // The op and the stamp come BEFORE the claim, because both are gated on
      // the same "still open" condition the insert is (§6.1). Ordering is what
      // makes a lost race write nothing at all: a capture already converted by
      // another call inserts no row, records no op, stamps nothing, and the
      // claim itself matches no row.
      ...outboxStatements(
        [{ table: "notes", uid, kind: "create", fields }],
        undefined,
        { sql: OPEN_CLAIM, params: [id] },
      ),
      claimStatement("note", "(SELECT id FROM notes WHERE uid = ?)", [uid], id),
    ];
  }
  if (target === "task") {
    // No due date and no repeat are inferred from a capture — the plan's
    // decision: a task is just the captured text, and the user schedules it.
    const uid = newUid();
    const fields = {
      title: body,
      due_date: null,
      done: 0,
      repeat: "none" as const,
      note: "",
      created_at: today,
    };
    return [
      {
        sql: `INSERT INTO tasks (title, due_date, done, repeat, note, created_at, uid)
              SELECT ?, NULL, 0, 'none', '', ?, ?
              WHERE EXISTS (${OPEN_CLAIM})`,
        params: [body, today, uid, id],
      },
      ...outboxStatements(
        [{ table: "tasks", uid, kind: "create", fields }],
        undefined,
        { sql: OPEN_CLAIM, params: [id] },
      ),
      claimStatement("task", "(SELECT id FROM tasks WHERE uid = ?)", [uid], id),
    ];
  }
  if (target === "journal") {
    // One entry per calendar day (`entry_date` is UNIQUE), so today's entry is
    // SHARED: the block is appended to whatever is there, and a day that does
    // not exist yet is created holding just the block. Existing text is never
    // replaced — that is the whole point of the ON CONFLICT clause.
    return [
      {
        sql: `INSERT INTO journal_entries (entry_date, content, created_at, updated_at)
              SELECT ?, ?, ?, ?
              WHERE EXISTS (${OPEN_CLAIM})
              ON CONFLICT(entry_date) DO UPDATE SET
                content = journal_entries.content || ? || excluded.content,
                updated_at = excluded.updated_at`,
        params: [
          entryDate,
          journalBlock(body),
          today,
          today,
          id,
          JOURNAL_BLOCK_SEPARATOR,
        ],
      },
      claimStatement(
        "journal",
        "(SELECT id FROM journal_entries WHERE entry_date = ?)",
        [entryDate],
        id,
      ),
    ];
  }
  throw new Error(`Unknown capture target ${target}.`);
}

export function createInboxRepo(driver: DataDriver) {
  async function get(id: number): Promise<InboxRow | undefined> {
    const rows = await driver.query<InboxRow>(
      "SELECT * FROM inbox_items WHERE id = ?",
      [id],
    );
    return rows[0];
  }

  return {
    get,

    /**
     * Capture one memo. Refuses blank input here rather than letting the table
     * reject it: an empty inbox row the user cannot see the reason for is worse
     * than a message.
     */
    async create(body: string): Promise<number> {
      const trimmed = body.trim();
      if (trimmed.length === 0) {
        // One sentence for both callers: the page's own pre-check renders the
        // same key, so the two can never drift apart.
        throw new InboxError("capture.empty");
      }
      const r = await driver.execute(
        "INSERT INTO inbox_items (body, created_at) VALUES (?, ?)",
        [trimmed, todayLocal()],
      );
      return r.lastInsertRowid;
    },

    /** Open captures, newest first — the only list the page needs. */
    async listOpen(): Promise<InboxRow[]> {
      return driver.query<InboxRow>(
        "SELECT * FROM inbox_items WHERE status = 'open' ORDER BY id DESC",
      );
    },

    /** Rows in a given status, newest first. Used for the archived view. */
    async listByStatus(status: InboxStatus): Promise<InboxRow[]> {
      return driver.query<InboxRow>(
        "SELECT * FROM inbox_items WHERE status = ? ORDER BY id DESC",
        [status],
      );
    },

    /**
     * Put a capture away without converting it. Guarded on `open`, so an
     * already-converted row is never silently un-linked from its target.
     */
    async archive(id: number): Promise<void> {
      await driver.execute(
        "UPDATE inbox_items SET status = 'archived' WHERE id = ? AND status = 'open'",
        [id],
      );
    },

    async deleteItem(id: number): Promise<void> {
      await driver.execute("DELETE FROM inbox_items WHERE id = ?", [id]);
    },

    /**
     * Turn a capture into one note, task, or today's journal entry.
     *
     * Returns the target that exists afterwards, whether this call created it
     * or a previous one already did. Refuses on a row that is not open, and
     * refuses if the batch left the row unconverted — which would mean the
     * guard and the write disagreed, and is reported rather than swallowed.
     */
    async convert(id: number, target: InboxTarget): Promise<InboxConversion> {
      const before = await get(id);
      if (!before) throw new InboxError("inbox.convertGone");
      if (before.status === "archived") {
        throw new InboxError("inbox.convertArchived");
      }
      if (before.status === "converted") {
        return {
          type: before.converted_type as InboxTarget,
          id: before.converted_id as number,
        };
      }
      await driver.batch(convertStatements(id, target, before.body));
      const after = await get(id);
      if (
        after?.status !== "converted" ||
        after.converted_type === null ||
        after.converted_id === null
      ) {
        throw new InboxError("inbox.convertFailed");
      }
      return { type: after.converted_type, id: after.converted_id };
    },

    /**
     * Which recorded targets still exist, keyed `"<type>:<id>"`.
     *
     * `converted_id` is historical, so a deleted target leaves a dangling
     * reference; the page shows that as "unavailable" instead of pretending the
     * capture never happened. Three queries regardless of row count: the table
     * names come from a code-owned map (never from the row's own
     * `converted_type`), and every value is bound.
     */
    async liveTargets(rows: InboxRow[]): Promise<Map<string, boolean>> {
      const live = new Map<string, boolean>();
      const idsByType: Record<InboxTarget, number[]> = {
        note: [],
        task: [],
        journal: [],
      };
      for (const row of rows) {
        // A `converted_type` this build does not know is ignored here and
        // reported as unavailable below, never interpolated into SQL.
        const type = row.converted_type;
        const id = row.converted_id;
        if (row.status !== "converted" || type === null || id === null)
          continue;
        if (!INBOX_TARGETS.includes(type)) {
          live.set(`${String(type)}:${id}`, false);
          continue;
        }
        idsByType[type].push(id);
      }
      for (const type of INBOX_TARGETS) {
        const ids = idsByType[type];
        if (ids.length === 0) continue;
        const placeholders = ids.map(() => "?").join(", ");
        const found = await driver.query<{ id: number }>(
          `SELECT id FROM ${TARGET_TABLES[type]} WHERE id IN (${placeholders})`,
          ids,
        );
        const set = new Set(found.map((row) => row.id));
        for (const id of ids) live.set(targetKey(type, id), set.has(id));
      }
      return live;
    },
  };
}

/** The key `liveTargets` answers with. */
export function targetKey(type: InboxTarget, id: number): string {
  return `${type}:${id}`;
}
