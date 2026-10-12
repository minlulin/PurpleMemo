// Row/domain types for the 29-table baseline (§4). Money is integer cents
// everywhere (§4); dates are local `yyyy-mm-dd` strings. Domain objects mirror
// rows — major units appear only at display/parse edges.

export interface CollectionRow {
  id: number;
  name: string;
  created_at: string;
}

export interface NoteRow {
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

export interface JournalEntryRow {
  id: number;
  entry_date: string; // yyyy-mm-dd, UNIQUE — one entry per calendar day (§2.5)
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
  name: string;
  phone: string;
  address: string;
  notes: string;
  created_at: string;
}

export type JobStatus = "open" | "paid";

export interface JobRow {
  id: number;
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
  counterparty: string;
  direction: LoanDirection;
  amount_cents: number;
  repaid_cents: number;
  due_date: string | null;
  note: string;
  created_at: string;
}

export interface ShoppingListRow {
  id: number;
  name: string;
  created_at: string;
}

export interface ShoppingItemRow {
  id: number;
  list_id: number;
  text: string;
  done: number; // 0 | 1
  sort_order: number;
}

export interface HabitRow {
  id: number;
  name: string;
  created_at: string;
}

export interface HabitLogRow {
  id: number;
  habit_id: number;
  log_date: string;
  done: number; // 0 | 1
}

export interface TaskRow {
  id: number;
  title: string;
  due_date: string | null;
  done: number; // 0 | 1
  repeat: "none" | "daily" | "weekly" | "monthly";
  note: string;
  created_at: string;
}

export interface ReminderRow {
  id: number;
  title: string;
  remind_at: string;
  repeat: "none" | "daily" | "weekly" | "monthly";
  note: string;
  fired: number; // 0 | 1
  created_at: string;
}

export type ContactChannelKind = "phone" | "email" | "other";

export interface ContactRow {
  id: number;
  name: string;
  address: string;
  birthday: string | null; // full date or month-day (§2.7)
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
