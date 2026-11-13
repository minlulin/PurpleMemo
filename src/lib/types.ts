// Row/domain types for the 37-table schema — the 38th, `notes_fts`, is the
// trigger-maintained FTS index. The six device-local sync-storage tables added
// in SCHEMA_VERSION 8 (`sync_*`: outbox, tombstones, peers, device identity)
// are typed where they are read, in `sync/store.ts`, and are never in a backup
// payload. Every other table in that schema
// has a `*Row` here, including the two ledger tables, `settings` and
// `trash_items` (docs/AUDIT.md SCHEMA-02). Money is integer cents
// everywhere; dates are local `yyyy-mm-dd` strings unless the field says
// otherwise — `ReminderRow.remind_at` is `yyyy-mm-ddTHH:mm` and
// `ContactRow.birthday` is `yyyy-mm-dd` or yearless `mm-dd`. Domain objects
// mirror rows — major units appear only at display/parse edges.

/**
 * Cross-device identity (docs/ANDROID_DESIGN.md, "Cross-device UID contract").
 * Every synced table has this column and every creation path mints one; it is
 * optional on the row types because a projection with an explicit column list
 * (`listNotes`, the title picker) does not select it, and fixtures written
 * before schema v7 carry none.
 */
interface SyncedRow {
  uid?: string | null;
}

export interface CollectionRow extends SyncedRow {
  id: number;
  name: string;
  created_at: string;
}

export interface NoteRow extends SyncedRow {
  id: number;
  title: string;
  content: string;
  tags: string; // comma-separated
  collection_id: number | null;
  pinned: number; // 0 | 1
  archived: number; // 0 | 1
  created_at: string;
  updated_at: string;
}

/**
 * The `"title"` projection (`listNoteTitles`): SQL selects only `id, title`,
 * so the other seven `NoteRow` columns are ABSENT at runtime — reading
 * `row.content` off one is a `TypeError`. Typed separately so the compiler
 * refuses exactly that (J1).
 */
export type NoteTitleRow = Pick<NoteRow, "id" | "title">;

/**
 * The `"list"` projection (`listNotes`' default): every column, but `content`
 * is cut by SQL to a 200-character prefix — enough for the 140-char excerpt
 * every list view renders, never the stored body. Structurally a `NoteRow`
 * (the type system cannot express "truncated"), so this alias names the
 * contract instead: read a body through `getNote`, never off a list row (J1).
 */
export type NoteListRow = NoteRow;

export interface JournalEntryRow {
  id: number;
  entry_date: string; // yyyy-mm-dd, UNIQUE — one entry per calendar day
  content: string;
  created_at: string;
  updated_at: string;
}

export interface WalletRow {
  id: number;
  name: string;
  created_at: string;
}

export interface IncomeCategoryRow {
  id: number;
  name: string;
  created_at: string;
}

export interface ExpenseCategoryRow {
  id: number;
  name: string;
  created_at: string;
}

export interface ExpenseLimitRow {
  id: number;
  category_id: number;
  limit_cents: number;
}

export type RecurringFrequency = "weekly" | "monthly" | "quarterly" | "yearly";

export interface RecurringPaymentRow {
  id: number;
  title: string;
  amount_cents: number;
  category_id: number | null;
  wallet_id: number | null;
  frequency: RecurringFrequency;
  next_due_date: string;
  note: string;
  active: number; // 0 | 1
  created_at: string;
}

export interface ShopRow {
  id: number;
  /** Cross-device identity (§1.1); NULL only on a pre-v7 row. */
  uid: string | null;
  name: string;
  phone: string;
  address: string;
  notes: string;
  created_at: string;
}

export type JobStatus = "open" | "paid";

export interface JobRow {
  id: number;
  /** Cross-device identity (§1.1); NULL only on a pre-v7 row. */
  uid: string | null;
  title: string;
  shop_id: number | null;
  total_cents: number;
  paid_cents: number;
  job_date: string;
  warranty_days: number | null;
  status: JobStatus;
  note: string;
  created_at: string;
}

export interface PayableRow {
  id: number;
  title: string;
  amount_cents: number;
  shop_id: number | null;
  due_date: string | null;
  paid: number; // 0 | 1
  note: string;
  created_at: string;
}

export type LoanDirection = "lent" | "borrowed";
export type LoanState = "open" | "partial" | "overdue" | "closed";

export interface LoanRow {
  id: number;
  /** Cross-device identity (§1.1); NULL only on a pre-v7 row. */
  uid: string | null;
  counterparty: string;
  direction: LoanDirection;
  amount_cents: number;
  repaid_cents: number;
  due_date: string | null;
  note: string;
  created_at: string;
}

export interface ShoppingListRow extends SyncedRow {
  id: number;
  name: string;
  created_at: string;
}

export interface ShoppingItemRow extends SyncedRow {
  id: number;
  list_id: number;
  text: string;
  done: number; // 0 | 1
  sort_order: number;
}

export interface HabitRow extends SyncedRow {
  id: number;
  name: string;
  created_at: string;
}

export interface HabitLogRow extends SyncedRow {
  id: number;
  habit_id: number;
  log_date: string;
  done: number; // 0 | 1
}

export interface TaskRow extends SyncedRow {
  id: number;
  title: string;
  due_date: string | null;
  done: number; // 0 | 1
  repeat: "none" | "daily" | "weekly" | "monthly";
  note: string;
  created_at: string;
}

/** What a quick-capture row can become. */
export type InboxTarget = "note" | "task" | "journal";

export type InboxStatus = "open" | "converted" | "archived";

/**
 * One captured memo.
 *
 * `converted_type` / `converted_id` are HISTORICAL, not a live link: they
 * record which row this capture produced, so a retry answers with that row
 * instead of creating a second one, and an audit can trace the capture. They
 * survive the target being deleted, which is why the table carries no foreign
 * key — the page shows such a target as unavailable rather than reconverting.
 */
export interface InboxRow {
  id: number;
  body: string;
  status: InboxStatus;
  converted_type: InboxTarget | null;
  converted_id: number | null;
  created_at: string;
}

/**
 * What a relationship may connect.
 *
 * Deliberately NOT `PhotoRefEntity`: photos keep their own relationship system
 * (`photo_refs`, with real foreign keys and cascade), and a second, overlapping
 * representation for them is exactly what this phase must not create.
 */
export type LinkableEntityType = "note" | "task" | "contact";

/** One end of a relationship. Both ends are always full keys, never bare ids. */
export interface LinkableEntity {
  type: LinkableEntityType;
  id: number;
}

export interface LinkRow {
  id: number;
  kind: "related";
  type_a: LinkableEntityType;
  id_a: number;
  type_b: LinkableEntityType;
  id_b: number;
  created_at: string;
}

/**
 * What a page shows for one relationship: the other end, a label to click, and
 * enough state to disambiguate two rows with the same title.
 */
export interface RelatedItem {
  entity: LinkableEntity;
  label: string;
  /** "Archived", "Done", or null when the row is plainly live. */
  detail: string | null;
  /**
   * The other end no longer exists. The relationship stays — deleting a target
   * must not silently retarget or invent one — and the UI says so.
   */
  gone: boolean;
}

export interface ReminderRow extends SyncedRow {
  id: number;
  title: string;
  remind_at: string; // local `yyyy-mm-ddTHH:mm`, not a date-only day
  repeat: "none" | "daily" | "weekly" | "monthly";
  note: string;
  fired: number; // 0 | 1
  created_at: string;
  /**
   * §13.1 Option A: the device that created the reminder, and so the only one
   * that arms it, notifies it and settles it. NULL is a legacy-local row from
   * before the column existed, which reads as this device's.
   */
  created_by_device_id?: string | null;
}

export type ContactChannelKind = "phone" | "email" | "other";

export interface ContactRow {
  id: number;
  name: string;
  address: string;
  birthday: string | null; // full date or month-day
  notes: string;
  created_at: string;
}

export interface ContactChannelRow {
  id: number;
  contact_id: number;
  kind: ContactChannelKind;
  value: string;
  is_primary: number; // 0 | 1
  sort_order: number;
}

export interface ContactTagRow {
  id: number;
  contact_id: number;
  tag: string;
}

export interface MemoryRow {
  id: number;
  title: string;
  memory_date: string;
  note: string;
  created_at: string;
}

export interface PhotoRow {
  id: number;
  rel_path: string;
  sha256: string;
  ext: string;
  size_bytes: number;
  taken_date: string | null;
  note: string;
  created_at: string;
}

export type PhotoRefEntity = "note" | "memory" | "job";

export interface PhotoRefRow {
  id: number;
  photo_id: number;
  entity_type: PhotoRefEntity;
  entity_id: number;
}

export interface VaultItemRow {
  id: number;
  title: string;
  ciphertext: string; // base64 AES-256-GCM
  salt: string; // base64, vault-password salt
  iv: string; // base64, per-item IV
  created_at: string;
  updated_at: string;
}

/**
 * One `expense_entries` row. The two ledger tables (`income_entries` and
 * `expense_entries`) have identical columns by design; they are separate
 * tables so a category id can never be read against the wrong category list.
 */
export interface ExpenseEntryRow {
  id: number;
  amount_cents: number;
  category_id: number;
  wallet_id: number;
  entry_date: string; // yyyy-mm-dd
  note: string;
  created_at: string;
}

/** One `settings` row. `value` is TEXT NOT NULL — see the import canary. */
export interface SettingRow {
  key: string;
  value: string;
}

/**
 * Entity types Trash can hold — the `trash_items.entity_type` CHECK list.
 *
 * The two shopping types are schema v10's addition (§13.2): a conflict loser
 * from a mutable Shopping record archives like a note's or a task's. Ordinary
 * shopping deletes still do not go to Trash — no Shopping screen calls them.
 */
export type TrashEntityType =
  | "note"
  | "task"
  | "contact"
  | "memory"
  | "journal_entry"
  | "shopping_list"
  | "shopping_item";

/** One `trash_items` row. `snapshot` is JSON text. */
export interface TrashItemRow {
  id: number;
  entity_type: TrashEntityType;
  entity_id: number;
  snapshot: string;
  deleted_at: string;
  created_at: string;
}
