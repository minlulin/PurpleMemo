// Address book repository: contacts, phone/email channels (primary
// flag, order), tags, birthdays (full date or month-day).

import type { DataDriver } from "../data/driver.ts";
import { todayLocal } from "./dates.ts";
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
 * "Oct 20" for a month-day. Malformed input degrades to a
 * placeholder instead of throwing — the label sits in list rows.
 */
export function birthdayLabel(birthday: string): string {
  if (birthday.length === 0) return "";
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

    async addChannel(input: ChannelInput): Promise<number> {
      const maxRows = await driver.query<{ max_order: number | null }>(
        "SELECT MAX(sort_order) AS max_order FROM contact_channels WHERE contact_id = ?",
        [input.contactId],
      );
      const nextOrder = (maxRows[0]?.max_order ?? -1) + 1;
      const statements = [];
      if (input.isPrimary) {
        statements.push({
          sql: "UPDATE contact_channels SET is_primary = 0 WHERE contact_id = ?",
          params: [input.contactId],
        });
      }
      statements.push({
        sql: "INSERT INTO contact_channels (contact_id, kind, value, is_primary, sort_order) VALUES (?, ?, ?, ?, ?)",
        params: [
          input.contactId,
          input.kind,
          input.value,
          input.isPrimary ? 1 : 0,
          nextOrder,
        ],
      });
      await driver.batch(statements);
      const rows = await driver.query<{ id: number }>(
        "SELECT last_insert_rowid() AS id",
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
    /** Contacts whose birthday falls within `days` of today. */
    async upcomingBirthdays(
      days = 14,
      today = todayLocal(),
    ): Promise<ContactRow[]> {
      const all = await this.listContacts();
      return all.filter(
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
