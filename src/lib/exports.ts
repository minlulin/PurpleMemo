import { strToU8, zip, zipSync } from "fflate";
import type { DataDriver } from "../data/driver.ts";
import { outstandingCents } from "./money.ts";
import { parseTags } from "./notes.ts";
import type {
  CollectionRow,
  ContactChannelKind,
  ContactChannelRow,
  ContactRow,
  ExpenseCategoryRow,
  IncomeCategoryRow,
  JobRow,
  JournalEntryRow,
  LoanRow,
  NoteRow,
  PayableRow,
  ShopRow,
  WalletRow,
} from "./types.ts";

export type ExportGroup = "notes" | "journal" | "finance" | "contacts";

export interface ExportSelection {
  notes: boolean;
  journal: boolean;
  finance: boolean;
  contacts: boolean;
}

export const ALL_EXPORT_GROUPS: ExportSelection = {
  notes: true,
  journal: true,
  finance: true,
  contacts: true,
};

export interface ExportIncomeRow {
  id: number;
  amount_cents: number;
  category: string;
  wallet: string;
  entry_date: string;
  note: string;
  created_at: string;
}

export interface ExportExpenseRow {
  id: number;
  amount_cents: number;
  category: string;
  wallet: string;
  entry_date: string;
  note: string;
  created_at: string;
}

export interface ExportLoanRow extends LoanRow {
  state: string;
}

export interface ExportJobRow extends JobRow {
  shop: string | null;
}

export interface ExportPayableRow extends PayableRow {
  shop: string | null;
}

export interface ExportContact {
  contact: ContactRow;
  channels: ContactChannelRow[];
  tags: string[];
}

export interface ExportData {
  collections: CollectionRow[];
  notes: NoteRow[];
  noteAttachments: Map<number, string[]>;
  journal: JournalEntryRow[];
  income: ExportIncomeRow[];
  expenses: ExportExpenseRow[];
  loans: ExportLoanRow[];
  jobs: ExportJobRow[];
  payables: ExportPayableRow[];
  contacts: ExportContact[];
  today: string;
}

export interface ExportFile {
  path: string;
  text: string;
}

export interface ExportCounts {
  notes: number;
  journal: number;
  income: number;
  expenses: number;
  loans: number;
  jobs: number;
  payables: number;
  contacts: number;
}

export interface ExportBundle {
  files: ExportFile[];
  counts: ExportCounts;
}

export interface FieldMappingRow {
  source: string;
  fields: string;
  destination: string;
  notes: string;
}

export const EXPORT_FIELD_MAPPING: FieldMappingRow[] = [
  {
    source: "collections",
    fields: "id, name",
    destination: "notes/<id>-<slug>.md front matter",
    notes:
      "The collection name is written as text; collections with no notes export no file.",
  },
  {
    source: "notes",
    fields:
      "id, title, content, tags, collection_id, pinned, archived, created_at, updated_at",
    destination: "notes/<id>-<slug>.md",
    notes:
      "Every row in the table, archived rows included. Tags are an array. Trash rows are excluded.",
  },
  {
    source: "photo_refs + photos",
    fields: "rel_path",
    destination: "notes front matter attachments",
    notes:
      "Reference paths only. Photo bytes are not part of a readable export; they are only in a backup archive.",
  },
  {
    source: "journal_entries",
    fields: "id, entry_date, content, created_at, updated_at",
    destination: "journal/<yyyy>/<yyyy-mm-dd>.md",
    notes: "Every row; one file per calendar day.",
  },
  {
    source: "income_entries",
    fields:
      "id, entry_date, amount_cents, amount, category, wallet, note, created_at",
    destination: "finance/income.csv",
    notes: "amount is decimal major units; amount_cents is the stored integer.",
  },
  {
    source: "expense_entries",
    fields:
      "id, entry_date, amount_cents, amount, category, wallet, note, created_at",
    destination: "finance/expenses.csv",
    notes: "amount is decimal major units; amount_cents is the stored integer.",
  },
  {
    source: "loans",
    fields:
      "id, counterparty, direction, amount_cents, amount, repaid_cents, repaid, remaining_cents, remaining, due_date, state, note, created_at",
    destination: "finance/loans.csv",
    notes:
      "state is derived at export time from repaid_cents, amount_cents and due_date.",
  },
  {
    source: "jobs + shops",
    fields:
      "id, title, shop, total_cents, total, paid_cents, paid, remaining_cents, remaining, job_date, warranty_days, status, note, created_at",
    destination: "finance/jobs.csv",
    notes:
      "shop is the shop name, or empty when the job has none. Remaining never goes below zero.",
  },
  {
    source: "payables + shops",
    fields:
      "id, title, shop, amount_cents, amount, due_date, paid, note, created_at",
    destination: "finance/payables.csv",
    notes:
      "Paid and unpaid rows are both exported; paid stays the stored 0/1 flag.",
  },
  {
    source: "contacts, contact_channels, contact_tags",
    fields: "id, name, address, birthday, notes, created_at, channels, tags",
    destination: "contacts.vcf",
    notes:
      "One vCard 4.0 card per contact; channels keep their stored order and primary flag.",
  },
  {
    source: "wallets, income_categories, expense_categories, shops",
    fields: "id, name",
    destination: "referenced by name in finance CSVs",
    notes:
      "Reference tables are not separate files; a renamed row exports under its current name.",
  },
  {
    source: "trash_items",
    fields: "-",
    destination: "-",
    notes:
      "Deliberately excluded from readable exports. Trash stays recoverable in the app and is included in backup archives.",
  },
  {
    source: "vault_items",
    fields: "-",
    destination: "-",
    notes:
      "Deliberately excluded. Vault contents are ciphertext and are covered by backup archives instead.",
  },
  {
    source: "habits, tasks, shopping, memories, gallery",
    fields: "-",
    destination: "-",
    notes:
      "Not part of the readable export set; they remain available through backup archives.",
  },
  {
    source: "settings",
    fields: "-",
    destination: "-",
    notes:
      "Never exported: theme, PIN, security question and notification preferences are local app state.",
  },
];

const WINDOWS_RESERVED = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

export function sanitizeFilePart(raw: string, fallback: string): string {
  const cleaned = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what must be stripped here
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  const bounded = cleaned.slice(0, 80).trim();
  if (bounded.length === 0) return fallback;
  const upper = bounded.toUpperCase();
  if (WINDOWS_RESERVED.has(upper)) return `${bounded}-file`;
  return bounded;
}

export function noteExportPath(note: NoteRow): string {
  const slug = sanitizeFilePart(note.title, "note")
    .toLowerCase()
    .replace(/\s+/g, "-");
  return `notes/${note.id}-${slug}.md`;
}

export function journalExportPath(entry: JournalEntryRow): string {
  const year = entry.entry_date.slice(0, 4);
  return `journal/${year}/${entry.entry_date}.md`;
}

export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const units = Math.floor(absolute / 100);
  const fraction = absolute % 100;
  return `${sign}${units}.${String(fraction).padStart(2, "0")}`;
}

// Spreadsheets trim leading spaces and tabs before evaluating a cell, so a
// trigger character behind that whitespace is still a formula. The \t and \r
// first-character triggers keep their original behaviour.
function isFormulaPayload(text: string): boolean {
  return /^(?:[\t\r]|[ \t]*[=+\-@])/.test(text);
}

export function csvText(raw: string): string {
  const guarded = isFormulaPayload(raw) ? `'${raw}` : raw;
  if (/[",\r\n]/.test(guarded) || /^\s|\s$/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

export function csvRow(values: (string | number | null)[]): string {
  return `${values
    .map((value) =>
      value === null
        ? ""
        : typeof value === "number"
          ? String(value)
          : csvText(value),
    )
    .join(",")}\r\n`;
}

export function csvDocument(
  header: string[],
  rows: (string | number | null)[][],
) {
  return `${csvRow(header)}${rows.map(csvRow).join("")}`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function frontMatter(fields: [string, string][]): string {
  return [
    "---",
    ...fields.map(([key, value]) => `${key}: ${value}`),
    "---",
    "",
  ].join("\n");
}

export function noteMarkdown(
  note: NoteRow,
  collectionName: string | null,
  attachments: string[],
): string {
  const tags = parseTags(note.tags);
  const lines: [string, string][] = [
    ["id", String(note.id)],
    ["title", yamlString(note.title)],
    ["tags", `[${tags.map(yamlString).join(", ")}]`],
    [
      "collection",
      collectionName === null ? "null" : yamlString(collectionName),
    ],
    ["pinned", note.pinned === 1 ? "true" : "false"],
    ["archived", note.archived === 1 ? "true" : "false"],
    ["created_at", yamlString(note.created_at)],
    ["updated_at", yamlString(note.updated_at)],
  ];
  const attachmentBlock =
    attachments.length === 0
      ? []
      : [
          "attachments:",
          ...attachments.map((path) => `  - ${yamlString(path)}`),
        ];
  const bodyFront = [
    "---",
    ...lines.map(([key, value]) => `${key}: ${value}`),
    ...attachmentBlock,
    "---",
    "",
  ].join("\n");
  const heading = note.title.trim().length === 0 ? "Untitled note" : note.title;
  const body = `${bodyFront}# ${heading}\n\n${note.content}`.trimEnd();
  return `${body}\n`;
}

export function journalMarkdown(entry: JournalEntryRow): string {
  const front = frontMatter([
    ["id", String(entry.id)],
    ["date", yamlString(entry.entry_date)],
    ["created_at", yamlString(entry.created_at)],
    ["updated_at", yamlString(entry.updated_at)],
  ]);
  const body = `${front}# ${entry.entry_date}\n\n${entry.content}`.trimEnd();
  return `${body}\n`;
}

export function incomeCsv(rows: ExportIncomeRow[]): string {
  return csvDocument(
    [
      "id",
      "entry_date",
      "amount_cents",
      "amount",
      "category",
      "wallet",
      "note",
      "created_at",
    ],
    rows.map((row) => [
      row.id,
      row.entry_date,
      row.amount_cents,
      centsToDecimal(row.amount_cents),
      row.category,
      row.wallet,
      row.note,
      row.created_at,
    ]),
  );
}

export function expensesCsv(rows: ExportExpenseRow[]): string {
  return csvDocument(
    [
      "id",
      "entry_date",
      "amount_cents",
      "amount",
      "category",
      "wallet",
      "note",
      "created_at",
    ],
    rows.map((row) => [
      row.id,
      row.entry_date,
      row.amount_cents,
      centsToDecimal(row.amount_cents),
      row.category,
      row.wallet,
      row.note,
      row.created_at,
    ]),
  );
}

export function loansCsv(rows: ExportLoanRow[]): string {
  return csvDocument(
    [
      "id",
      "counterparty",
      "direction",
      "amount_cents",
      "amount",
      "repaid_cents",
      "repaid",
      "remaining_cents",
      "remaining",
      "due_date",
      "state",
      "note",
      "created_at",
    ],
    rows.map((row) => {
      const remaining = outstandingCents(row.amount_cents, row.repaid_cents);
      return [
        row.id,
        row.counterparty,
        row.direction,
        row.amount_cents,
        centsToDecimal(row.amount_cents),
        row.repaid_cents,
        centsToDecimal(row.repaid_cents),
        remaining,
        centsToDecimal(remaining),
        row.due_date,
        row.state,
        row.note,
        row.created_at,
      ];
    }),
  );
}

export function jobsCsv(rows: ExportJobRow[]): string {
  return csvDocument(
    [
      "id",
      "title",
      "shop",
      "total_cents",
      "total",
      "paid_cents",
      "paid",
      "remaining_cents",
      "remaining",
      "job_date",
      "warranty_days",
      "status",
      "note",
      "created_at",
    ],
    rows.map((row) => {
      const remaining = outstandingCents(row.total_cents, row.paid_cents);
      return [
        row.id,
        row.title,
        row.shop,
        row.total_cents,
        centsToDecimal(row.total_cents),
        row.paid_cents,
        centsToDecimal(row.paid_cents),
        remaining,
        centsToDecimal(remaining),
        row.job_date,
        row.warranty_days,
        row.status,
        row.note,
        row.created_at,
      ];
    }),
  );
}

export function payablesCsv(rows: ExportPayableRow[]): string {
  return csvDocument(
    [
      "id",
      "title",
      "shop",
      "amount_cents",
      "amount",
      "due_date",
      "paid",
      "note",
      "created_at",
    ],
    rows.map((row) => [
      row.id,
      row.title,
      row.shop,
      row.amount_cents,
      centsToDecimal(row.amount_cents),
      row.due_date,
      row.paid,
      row.note,
      row.created_at,
    ]),
  );
}

export function escapeVcardText(raw: string): string {
  return raw
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function foldVcardLine(line: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(line);
  if (bytes.length <= 75) return line;
  const pieces: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (currentBytes + size > 75) {
      pieces.push(current);
      current = ` ${char}`;
      currentBytes = 1 + size;
    } else {
      current += char;
      currentBytes += size;
    }
  }
  pieces.push(current);
  return pieces.join("\r\n");
}

export function contactVcard(entry: ExportContact): string {
  const { contact, channels, tags } = entry;
  const lines: string[] = [
    "BEGIN:VCARD",
    "VERSION:4.0",
    "PRODID:-//Purple Memo//Readable export//EN",
    `UID:urn:purple-memo:contact:${contact.id}`,
    `FN:${escapeVcardText(contact.name)}`,
    `N:${escapeVcardText(contact.name)};;;;`,
  ];
  if (contact.birthday !== null && contact.birthday.length > 0) {
    const value =
      contact.birthday.length >= 10
        ? contact.birthday.slice(0, 10)
        : `--${contact.birthday}`;
    lines.push(`BDAY:${value}`);
  }
  if (contact.address.trim().length > 0) {
    lines.push(`ADR;TYPE=home:;;${escapeVcardText(contact.address)};;;;`);
  }
  for (const channel of channels) {
    const preference = channel.is_primary === 1 ? ";PREF=1" : "";
    if (channel.kind === "email") {
      lines.push(`EMAIL${preference}:${escapeVcardText(channel.value)}`);
    } else if (channel.kind === "phone") {
      lines.push(
        `TEL;VALUE=text;TYPE=voice${preference}:${escapeVcardText(channel.value)}`,
      );
    } else {
      lines.push(
        `TEL;VALUE=text;TYPE=other${preference}:${escapeVcardText(channel.value)}`,
      );
    }
  }
  if (tags.length > 0) {
    // A list value is escaped exactly like text, then joined with the literal
    // commas that separate the values (RFC 6350 §3.3): an escaped `,` inside a
    // tag stays part of that tag. There used to be a separate
    // `escapeVcardList` for this line, and it was a byte-for-byte copy of the
    // text escaper — two functions to keep in step for one rule.
    lines.push(`CATEGORIES:${tags.map(escapeVcardText).join(",")}`);
  }
  if (contact.notes.trim().length > 0) {
    lines.push(`NOTE:${escapeVcardText(contact.notes)}`);
  }
  lines.push("END:VCARD");
  return `${lines.map(foldVcardLine).join("\r\n")}\r\n`;
}

export function contactsVcard(contacts: ExportContact[]): string {
  return contacts.map(contactVcard).join("");
}

export function fieldMappingMarkdown(): string {
  const header = "| Source | Fields | Destination | Notes |";
  const divider = "| --- | --- | --- | --- |";
  const rows = EXPORT_FIELD_MAPPING.map(
    (row) =>
      `| ${row.source} | ${row.fields} | ${row.destination} | ${row.notes} |`,
  );
  return [
    "# Purple Memo readable export - field mapping",
    "",
    "Every stored table is either mapped below or named as deliberately excluded.",
    "",
    header,
    divider,
    ...rows,
    "",
  ].join("\n");
}

export function readmeText(
  selection: ExportSelection,
  exportedAt: string,
): string {
  const groups: string[] = [];
  if (selection.notes)
    groups.push("notes/ - Markdown notes with YAML front matter");
  if (selection.journal) groups.push("journal/ - Markdown journal entries");
  if (selection.finance)
    groups.push("finance/ - income, expenses, loans, jobs, payables CSV");
  if (selection.contacts) groups.push("contacts.vcf - vCard 4.0 address book");
  return [
    "Purple Memo readable export",
    `Generated: ${exportedAt}`,
    "",
    "Contents:",
    ...groups.map((line) => `- ${line}`),
    "- EXPORT-FIELDS.md - field-by-field inclusion mapping",
    "",
    "Text is UTF-8. CSV files use RFC 4180 quoting with CRLF line endings.",
    "A CSV text value that starts with =, +, -, @, tab or carriage return is",
    "prefixed with an apostrophe so spreadsheets treat it as text, never a formula.",
    "Money appears twice: amount_cents is the stored integer, amount is decimal",
    "major units with a dot separator. Dates are ISO yyyy-mm-dd.",
    "",
    "Photo bytes, Vault ciphertext, settings and Trash are not in this export.",
    "Use a backup archive when you need a complete, restorable copy.",
    "",
  ].join("\n");
}

export function buildExportFiles(
  data: ExportData,
  selection: ExportSelection,
  exportedAt: string,
): ExportBundle {
  const collectionNames = new Map(
    data.collections.map((collection) => [collection.id, collection.name]),
  );
  const files: ExportFile[] = [];
  const counts: ExportCounts = {
    notes: 0,
    journal: 0,
    income: 0,
    expenses: 0,
    loans: 0,
    jobs: 0,
    payables: 0,
    contacts: 0,
  };
  if (selection.notes) {
    for (const note of data.notes) {
      const collectionName =
        note.collection_id === null
          ? null
          : (collectionNames.get(note.collection_id) ?? null);
      files.push({
        path: noteExportPath(note),
        text: noteMarkdown(
          note,
          collectionName,
          data.noteAttachments.get(note.id) ?? [],
        ),
      });
      counts.notes += 1;
    }
  }
  if (selection.journal) {
    for (const entry of data.journal) {
      files.push({
        path: journalExportPath(entry),
        text: journalMarkdown(entry),
      });
      counts.journal += 1;
    }
  }
  if (selection.finance) {
    files.push({ path: "finance/income.csv", text: incomeCsv(data.income) });
    files.push({
      path: "finance/expenses.csv",
      text: expensesCsv(data.expenses),
    });
    files.push({ path: "finance/loans.csv", text: loansCsv(data.loans) });
    files.push({ path: "finance/jobs.csv", text: jobsCsv(data.jobs) });
    files.push({
      path: "finance/payables.csv",
      text: payablesCsv(data.payables),
    });
    counts.income = data.income.length;
    counts.expenses = data.expenses.length;
    counts.loans = data.loans.length;
    counts.jobs = data.jobs.length;
    counts.payables = data.payables.length;
  }
  if (selection.contacts) {
    files.push({
      path: "contacts.vcf",
      text: contactsVcard(data.contacts),
    });
    counts.contacts = data.contacts.length;
  }
  files.push({
    path: "EXPORT-FIELDS.md",
    text: fieldMappingMarkdown(),
  });
  files.push({ path: "README.txt", text: readmeText(selection, exportedAt) });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, counts };
}

export async function buildExportArchive(
  files: ExportFile[],
): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  for (const file of files) entries[file.path] = strToU8(file.text);
  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      zip(entries, (error, data) =>
        error ? reject(error) : resolve(data as Uint8Array),
      );
    });
  } catch {
    return zipSync(entries);
  }
}

function deriveLoanState(row: LoanRow, today: string): string {
  if (row.repaid_cents >= row.amount_cents) return "closed";
  if (row.due_date !== null && row.due_date < today) return "overdue";
  if (row.repaid_cents > 0) return "partial";
  return "open";
}

interface IncomeJoinedRow extends ExportIncomeRow {
  category_id: number;
  wallet_id: number;
}

interface ExpenseJoinedRow extends ExportExpenseRow {
  category_id: number;
  wallet_id: number;
}

interface JobJoinedRow extends JobRow {
  shop_name: string | null;
}

interface PayableJoinedRow extends PayableRow {
  shop_name: string | null;
}

interface AttachmentRow {
  entity_id: number;
  rel_path: string;
}

export function createExportsRepo(driver: DataDriver) {
  return {
    async save(path: string, bytes: Uint8Array): Promise<void> {
      await driver.saveExportFile(path, bytes);
    },

    async build(
      selection: ExportSelection,
      today: string,
      exportedAt: string,
    ): Promise<{ bytes: Uint8Array; counts: ExportCounts; fileCount: number }> {
      const data = await this.collect(today, selection);
      const bundle = buildExportFiles(data, selection, exportedAt);
      return {
        bytes: await buildExportArchive(bundle.files),
        counts: bundle.counts,
        fileCount: bundle.files.length,
      };
    },

    async collect(
      today: string,
      selection: ExportSelection,
    ): Promise<ExportData> {
      const none = <T>(): Promise<T[]> => Promise.resolve([]);
      const [
        collections,
        notes,
        journal,
        attachmentRows,
        income,
        expenses,
        loans,
        jobRows,
        payableRows,
        contacts,
        channels,
        tags,
      ] = await Promise.all([
        selection.notes
          ? driver.query<CollectionRow>(
              "SELECT * FROM collections ORDER BY name",
            )
          : none<CollectionRow>(),
        selection.notes
          ? driver.query<NoteRow>(
              "SELECT * FROM notes ORDER BY collection_id, updated_at DESC, id",
            )
          : none<NoteRow>(),
        selection.journal
          ? driver.query<JournalEntryRow>(
              "SELECT * FROM journal_entries ORDER BY entry_date",
            )
          : none<JournalEntryRow>(),
        selection.notes
          ? driver.query<AttachmentRow>(
              `SELECT photo_refs.entity_id AS entity_id, photos.rel_path AS rel_path
                 FROM photo_refs
                 JOIN photos ON photos.id = photo_refs.photo_id
                WHERE photo_refs.entity_type = 'note'
                ORDER BY photo_refs.entity_id, photo_refs.id`,
            )
          : none<AttachmentRow>(),
        selection.finance
          ? driver.query<IncomeJoinedRow>(
              `SELECT income_entries.id AS id, income_entries.amount_cents AS amount_cents,
                      income_categories.name AS category, wallets.name AS wallet,
                      income_entries.entry_date AS entry_date, income_entries.note AS note,
                      income_entries.created_at AS created_at,
                      income_entries.category_id AS category_id,
                      income_entries.wallet_id AS wallet_id
                 FROM income_entries
                 JOIN income_categories ON income_categories.id = income_entries.category_id
                 JOIN wallets ON wallets.id = income_entries.wallet_id
                ORDER BY income_entries.entry_date, income_entries.id`,
            )
          : none<IncomeJoinedRow>(),
        selection.finance
          ? driver.query<ExpenseJoinedRow>(
              `SELECT expense_entries.id AS id, expense_entries.amount_cents AS amount_cents,
                      expense_categories.name AS category, wallets.name AS wallet,
                      expense_entries.entry_date AS entry_date, expense_entries.note AS note,
                      expense_entries.created_at AS created_at,
                      expense_entries.category_id AS category_id,
                      expense_entries.wallet_id AS wallet_id
                 FROM expense_entries
                 JOIN expense_categories ON expense_categories.id = expense_entries.category_id
                 JOIN wallets ON wallets.id = expense_entries.wallet_id
                ORDER BY expense_entries.entry_date, expense_entries.id`,
            )
          : none<ExpenseJoinedRow>(),
        selection.finance
          ? driver.query<LoanRow>("SELECT * FROM loans ORDER BY id")
          : none<LoanRow>(),
        selection.finance
          ? driver.query<JobJoinedRow>(
              `SELECT jobs.*, shops.name AS shop_name
                 FROM jobs LEFT JOIN shops ON shops.id = jobs.shop_id
                ORDER BY jobs.job_date, jobs.id`,
            )
          : none<JobJoinedRow>(),
        selection.finance
          ? driver.query<PayableJoinedRow>(
              `SELECT payables.*, shops.name AS shop_name
                 FROM payables LEFT JOIN shops ON shops.id = payables.shop_id
                ORDER BY payables.id`,
            )
          : none<PayableJoinedRow>(),
        selection.contacts
          ? driver.query<ContactRow>("SELECT * FROM contacts ORDER BY name, id")
          : none<ContactRow>(),
        selection.contacts
          ? driver.query<ContactChannelRow>(
              "SELECT * FROM contact_channels ORDER BY contact_id, sort_order, id",
            )
          : none<ContactChannelRow>(),
        selection.contacts
          ? driver.query<{ contact_id: number; tag: string }>(
              "SELECT contact_id, tag FROM contact_tags ORDER BY contact_id, tag",
            )
          : none<{ contact_id: number; tag: string }>(),
      ]);

      const noteAttachments = new Map<number, string[]>();
      for (const row of attachmentRows) {
        const paths = noteAttachments.get(row.entity_id) ?? [];
        paths.push(row.rel_path);
        noteAttachments.set(row.entity_id, paths);
      }

      const channelsByContact = new Map<number, ContactChannelRow[]>();
      for (const channel of channels) {
        const list = channelsByContact.get(channel.contact_id) ?? [];
        list.push(channel);
        channelsByContact.set(channel.contact_id, list);
      }
      const tagsByContact = new Map<number, string[]>();
      for (const row of tags) {
        const list = tagsByContact.get(row.contact_id) ?? [];
        list.push(row.tag);
        tagsByContact.set(row.contact_id, list);
      }

      return {
        collections,
        notes,
        noteAttachments,
        journal,
        income: income.map(({ category_id, wallet_id, ...row }) => row),
        expenses: expenses.map(({ category_id, wallet_id, ...row }) => row),
        loans: loans.map((row) => ({
          ...row,
          state: deriveLoanState(row, today),
        })),
        jobs: jobRows.map(({ shop_name, ...row }) => ({
          ...row,
          shop: shop_name,
        })),
        payables: payableRows.map(({ shop_name, ...row }) => ({
          ...row,
          shop: shop_name,
        })),
        contacts: contacts.map((contact) => ({
          contact,
          channels: channelsByContact.get(contact.id) ?? [],
          tags: tagsByContact.get(contact.id) ?? [],
        })),
        today,
      };
    },
  };
}

export type {
  ContactChannelKind,
  ExpenseCategoryRow,
  IncomeCategoryRow,
  ShopRow,
  WalletRow,
};
