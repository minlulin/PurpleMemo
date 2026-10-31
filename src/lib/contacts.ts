// Address book repository: contacts, phone/email channels (primary
// flag, order), tags, birthdays (full date or month-day).

import type { DataDriver } from "../data/driver.ts";
import { addDays, todayLocal } from "./dates.ts";
import { formatBirthday } from "./format.ts";
import type { Locale } from "./i18n.ts";
import { createTrashRepo } from "./trash.ts";
import type {
  ContactChannelKind,
  ContactChannelRow,
  ContactRow,
  ContactTagRow,
} from "./types.ts";

export interface ContactInput {
  name: string;
  address?: string;
  birthday?: string | null;
  notes?: string;
}

export interface ChannelInput {
  contactId: number;
  kind: ContactChannelKind;
  value: string;
  isPrimary?: boolean;
}

/**
 * Birthdays within `days` of today. The year wraps: near the end of
 * December, a January birthday counts as upcoming (its next occurrence is
 * next year), not as already passed.
 */
export function upcomingBirthday(
  birthday: string,
  today: string,
  days = 14,
): boolean {
  // Full date "yyyy-MM-dd" -> slice(5); month-day "MM-DD" -> the whole string.
  const mmdd = birthday.length >= 10 ? birthday.slice(5) : birthday;
  const todayMmdd = today.slice(5);
  const year = Number(today.slice(0, 4));
  const occursNextYear = mmdd < todayMmdd;
  const occurrence = `${occursNextYear ? year + 1 : year}-${mmdd}T00:00:00`;
  const diff = Math.round(
    (new Date(occurrence).getTime() - new Date(`${today}T00:00:00`).getTime()) /
      86_400_000,
  );
  return diff >= 0 && diff <= days;
}

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Display label for a birthday: "Oct 20, 1990" for a full date,
 * "Oct 20" for a month-day (localized when `locale` is non-English).
 *
 * `formatBirthday` (format.ts) is the ONE birthday formatter — the same rule
 * printed a different label in the Contacts list than in the Memories card,
 * because this file grew a second implementation (docs/AUDIT.md DUP-02). What
 * stays local is the fallback: `formatBirthday` echoes input it cannot parse,
 * and a list row wants a placeholder rather than a raw "13-40".
 */
export function birthdayLabel(birthday: string, locale: Locale = "en"): string {
  if (birthday.length === 0) return "";
  const formatted = formatBirthday(locale, birthday);
  if (formatted !== birthday) return formatted;
  return placeholderBirthday(birthday);
}

/** "?? 40" for an impossible month-day — degraded, never thrown. */
function placeholderBirthday(birthday: string): string {
  const mmdd = birthday.length >= 10 ? birthday.slice(5) : birthday;
  const month = Number(mmdd.slice(0, 2));
  const day = Number(mmdd.slice(3, 5));
  const monthLabel = MONTH_SHORT[month - 1] ?? "??";
  const dayLabel = Number.isFinite(day) ? day : "?";
  const base = `${monthLabel} ${dayLabel}`;
  return birthday.length >= 10 ? `${base}, ${birthday.slice(0, 4)}` : base;
}

/**
 * Normalize user input for a month-day birthday to strict "MM-DD".
 * Accepts "M-D", "MM-DD", "MM/DD" (pads zeros); returns null for
 * impossible dates (month 13, Feb 30) or malformed input.
 */
export function normalizeMonthDay(raw: string): string | null {
  const m = /^(\d{1,2})[-/](\d{1,2})$/.exec(raw.trim());
  const month = m ? Number(m[1]) : NaN;
  const day = m ? Number(m[2]) : NaN;
  if (!Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  // Reject day numbers that don't exist in that month (Feb 30, Apr 31).
  const probe = new Date(2024, month - 1, day); // leap year — Feb 29 stays valid
  if (probe.getMonth() !== month - 1 || probe.getDate() !== day) return null;
  return `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

/**
 * First extended grapheme cluster of `name` for circular contact avatars.
 * Keeps Burmese consonant + medial/vowel clusters (`"သီတာ"` -> `"သီ"`,
 * `"မေ"` -> `"မေ"`) and surrogate-pair emojis (`"🏠 Home"` -> `"🏠"`) intact
 * instead of slicing raw UTF-16 code units.
 */
export function contactInitial(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "?";
  for (const part of graphemeSegmenter.segment(trimmed)) {
    return part.segment.toUpperCase();
  }
  return "?";
}

/**
 * Case-insensitive contact filter over name, address and notes (tags live in
 * their own table and are not loaded here — the search box filters the list
 * that is already on screen). A blank query returns everything unchanged.
 */
export function searchContacts(
  contacts: ContactRow[],
  query: string,
): ContactRow[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return contacts;
  return contacts.filter((c) =>
    [c.name, c.address, c.notes].some((field) =>
      field.toLowerCase().includes(q),
    ),
  );
}

export function createContactsRepo(
  driver: DataDriver,
  trash = createTrashRepo(driver),
) {
  return {
    // -- Contacts ------------------------------------------------------------------
    async listContacts(): Promise<ContactRow[]> {
      return driver.query<ContactRow>("SELECT * FROM contacts ORDER BY name");
    },

    async getContact(id: number): Promise<ContactRow | undefined> {
      const rows = await driver.query<ContactRow>(
        "SELECT * FROM contacts WHERE id = ?",
        [id],
      );
      return rows[0];
    },

    async createContact(input: ContactInput): Promise<number> {
      const r = await driver.execute(
        "INSERT INTO contacts (name, address, birthday, notes, created_at) VALUES (?, ?, ?, ?, ?)",
        [
          input.name,
          input.address ?? "",
          input.birthday ?? null,
          input.notes ?? "",
          todayLocal(),
        ],
      );
      return r.lastInsertRowid;
    },

    /**
     * Partial update: only the provided fields are written (`undefined`
     * leaves the column unchanged; explicit `null` clears a nullable one).
     */
    async updateContact(
      id: number,
      fields: Partial<ContactInput>,
    ): Promise<void> {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (fields.name !== undefined) {
        sets.push("name = ?");
        params.push(fields.name);
      }
      if (fields.address !== undefined) {
        sets.push("address = ?");
        params.push(fields.address);
      }
      if (fields.birthday !== undefined) {
        sets.push("birthday = ?");
        params.push(fields.birthday);
      }
      if (fields.notes !== undefined) {
        sets.push("notes = ?");
        params.push(fields.notes);
      }
      if (sets.length === 0) return;
      params.push(id);
      await driver.execute(
        `UPDATE contacts SET ${sets.join(", ")} WHERE id = ?`,
        params,
      );
    },

    /** Move the contact, channels, tags, and relationships into Trash. */
    async deleteContact(id: number): Promise<void> {
      await trash.trashEntity("contact", id);
    },

    // -- Channels (phone/email/other, primary flag, order) ---------------------
    async listChannels(contactId: number): Promise<ContactChannelRow[]> {
      return driver.query<ContactChannelRow>(
        "SELECT * FROM contact_channels WHERE contact_id = ? ORDER BY sort_order, id",
        [contactId],
      );
    },

    /**
     * Add a channel and return the new row's id.
     *
     * The id must come back from the same connection state that produced it
     * (J2). The old shape read `last_insert_rowid()` in a SECOND IPC call:
     * that value is per-connection and moves on every insert, so two
     * overlapping adds could hand each other's ids back — nothing scoped the
     * read to this insert.
     *
     * Non-primary: one `execute` whose `lastInsertRowid` IS the inserted row's
     * id, with `sort_order` computed inside the same statement so the whole
     * add is one IPC and one atomic write. Primary: demote-then-insert must
     * stay one batch (demoting after the insert would demote the new row), and
     * the id is then read back scoped to THIS contact with `MAX(id)` —
     * unambiguous for the same reason `contactImport` uses `MAX(id)`, and
     * never connection-global the way `last_insert_rowid()` was.
     */
    async addChannel(input: ChannelInput): Promise<number> {
      const values = [input.contactId, input.kind, input.value];
      if (!input.isPrimary) {
        const outcome = await driver.execute(
          `INSERT INTO contact_channels (contact_id, kind, value, is_primary, sort_order)
           SELECT ?, ?, ?, 0, IFNULL(MAX(sort_order), -1) + 1
           FROM contact_channels WHERE contact_id = ?`,
          [...values, input.contactId],
        );
        return outcome.lastInsertRowid;
      }
      await driver.batch([
        {
          sql: "UPDATE contact_channels SET is_primary = 0 WHERE contact_id = ?",
          params: [input.contactId],
        },
        {
          // The demote above never touches sort_order, so `MAX` here still
          // spans every existing channel of this contact.
          sql: `INSERT INTO contact_channels (contact_id, kind, value, is_primary, sort_order)
                SELECT ?, ?, ?, 1, IFNULL(MAX(sort_order), -1) + 1
                FROM contact_channels WHERE contact_id = ?`,
          params: [...values, input.contactId],
        },
      ]);
      const rows = await driver.query<{ id: number | null }>(
        "SELECT MAX(id) AS id FROM contact_channels WHERE contact_id = ?",
        [input.contactId],
      );
      return rows[0]?.id ?? 0;
    },

    async updateChannel(
      id: number,
      fields: Partial<ChannelInput>,
    ): Promise<void> {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (fields.kind !== undefined) {
        sets.push("kind = ?");
        params.push(fields.kind);
      }
      if (fields.value !== undefined) {
        sets.push("value = ?");
        params.push(fields.value);
      }
      if (sets.length === 0) return;
      params.push(id);
      await driver.execute(
        `UPDATE contact_channels SET ${sets.join(", ")} WHERE id = ?`,
        params,
      );
    },

    /**
     * Make a channel the primary one — the others are unset (one batch).
     * The channel must belong to the contact; otherwise the batch would
     * unset this contact's primary and flag another contact's channel.
     */
    async setPrimaryChannel(
      contactId: number,
      channelId: number,
    ): Promise<void> {
      const rows = await driver.query<{ id: number }>(
        "SELECT id FROM contact_channels WHERE id = ? AND contact_id = ?",
        [channelId, contactId],
      );
      if (!rows[0])
        throw new Error(
          `channel ${channelId} does not belong to contact ${contactId}`,
        );
      await driver.batch([
        {
          sql: "UPDATE contact_channels SET is_primary = 0 WHERE contact_id = ?",
          params: [contactId],
        },
        {
          sql: "UPDATE contact_channels SET is_primary = 1 WHERE id = ? AND contact_id = ?",
          params: [channelId, contactId],
        },
      ]);
    },

    async deleteChannel(id: number): Promise<void> {
      await driver.execute("DELETE FROM contact_channels WHERE id = ?", [id]);
    },

    // -- Tags --------------------------------------------------------------------------
    async listTags(contactId: number): Promise<string[]> {
      const rows = await driver.query<ContactTagRow>(
        "SELECT * FROM contact_tags WHERE contact_id = ? ORDER BY tag",
        [contactId],
      );
      return rows.map((r) => r.tag);
    },

    async addTag(contactId: number, tag: string): Promise<void> {
      await driver.execute(
        "INSERT OR IGNORE INTO contact_tags (contact_id, tag) VALUES (?, ?)",
        [contactId, tag],
      );
    },

    async removeTag(contactId: number, tag: string): Promise<void> {
      await driver.execute(
        "DELETE FROM contact_tags WHERE contact_id = ? AND tag = ?",
        [contactId, tag],
      );
    },

    // -- Birthdays -----------------------------------------------------------------
    /**
     * Contacts whose birthday falls within `days` of today.
     *
     * The month-day window is applied in SQL (I3): the share publisher asked
     * for this every 30 seconds and it used to read `SELECT * FROM contacts`
     * — the whole address book — to answer with at most twenty names.
     * `substr(birthday, -5)` normalises both stored shapes (`MM-DD` and
     * `yyyy-MM-dd`) to the month-day the range compares, and the range wraps
     * the year when the window reaches into next January.
     *
     * The window is a **superset** of {@link upcomingBirthday}: the exact,
     * year-aware predicate still runs here over the rows that come back, so a
     * leap-day or malformed date the calendar arithmetic cannot place is
     * dropped rather than published. `ORDER BY name` matches `listContacts`,
     * which is what kept this list's order stable before it had a query of its
     * own.
     */
    async upcomingBirthdays(
      days = 14,
      today = todayLocal(),
      limit?: number,
    ): Promise<ContactRow[]> {
      const startMmdd = today.slice(5);
      const endMmdd = addDays(today, days).slice(5);
      const mmdd = "substr(birthday, -5)";
      const window =
        startMmdd <= endMmdd
          ? `${mmdd} >= ? AND ${mmdd} <= ?`
          : `(${mmdd} >= ? OR ${mmdd} <= ?)`;
      const rows = await driver.query<ContactRow>(
        `SELECT * FROM contacts
          WHERE birthday IS NOT NULL AND ${window}
          ORDER BY name${limit !== undefined ? " LIMIT ?" : ""}`,
        limit !== undefined
          ? [startMmdd, endMmdd, limit]
          : [startMmdd, endMmdd],
      );
      return rows.filter(
        (c) => c.birthday !== null && upcomingBirthday(c.birthday, today, days),
      );
    },

    /** Birthdays on exactly today's month-day (surfaced in Memories). */
    async birthdaysOn(today = todayLocal()): Promise<ContactRow[]> {
      const mmdd = today.slice(5);
      // substr is 1-based: MM-DD of "yyyy-MM-dd" starts at position 6.
      return driver.query<ContactRow>(
        `SELECT * FROM contacts
         WHERE (length(birthday) = 5  AND birthday = ?)
            OR (length(birthday) = 10 AND substr(birthday, 6, 5) = ?)
         ORDER BY name`,
        [mmdd, mmdd],
      );
    },

    /** Contact with channels + tags — the contact detail view. */
    async getContactDetail(contactId: number): Promise<{
      contact: ContactRow | undefined;
      channels: ContactChannelRow[];
      tags: string[];
    }> {
      const [contact, channels, tags] = await Promise.all([
        this.getContact(contactId),
        this.listChannels(contactId),
        this.listTags(contactId),
      ]);
      return { contact, channels, tags };
    },
  };
}
