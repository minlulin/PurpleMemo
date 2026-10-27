# Readable exports

Purple Memo exports a single UTF-8 ZIP archive. The archive is for reuse in
other applications; it is not a restorable backup. A backup archive remains the
complete copy (database tables and photo bytes), while a readable export holds
Markdown, CSV and vCard files plus `EXPORT-FIELDS.md` and `README.txt`.

## Destination model

One user-chosen `.zip` file. The native save dialog chooses the path, the
frontend builds the archive in memory, and Rust writes it atomically through
`export_save_file` (`file_write::save_export_file`). A failed write never leaves
a partial archive under the chosen name. This is a separate command and header
from `backup_save_file`; an export is never passed off as a backup.

## Formats

- Markdown is UTF-8 with LF line endings and YAML front matter.
- Notes are `notes/<id>-<slug>.md`. The id makes duplicate titles unique; the
  slug removes Windows-invalid characters and reserved device names.
- Journal entries are `journal/<yyyy>/<yyyy-mm-dd>.md`.
- CSV is UTF-8, comma-delimited, with RFC 4180 quoting and CRLF line endings.
  Money is written as both the stored integer (`amount_cents`) and decimal
  major units (`amount`, dot separator, two places).
- A CSV text value starting with `=`, `+`, `-`, `@`, tab or carriage return is
  prefixed with an apostrophe so spreadsheet software treats it as text.
- Tasks are written to `tasks.csv` with the same columns accepted by the Tasks
  CSV importer (`title`, `due_date`, `done`, `repeat`, `note`, plus `id` and
  `created_at`).
- Contacts are exported as both `contacts.vcf` (vCard 4.0 with CRLF line endings
  and UTF-8 line folding at 75 octets; month-day birthdays use `BDAY:--MM-DD`)
  and `contacts.csv` (semicolon-separated channels and tags matching the
  Contacts CSV importer).

## Field-by-field inclusion

| Source | Fields | Destination | Notes |
| --- | --- | --- | --- |
| collections | id, name | notes/<id>-<slug>.md front matter | The collection name is written as text; collections with no notes export no file. |
| notes | id, title, content, tags, collection_id, pinned, archived, created_at, updated_at | notes/<id>-<slug>.md | Every row in the table, archived rows included. Tags are an array. Trash rows are excluded. |
| photo_refs + photos | rel_path | notes front matter attachments | Reference paths only. Photo bytes are not part of a readable export; they are only in a backup archive. |
| journal_entries | id, entry_date, content, created_at, updated_at | journal/<yyyy>/<yyyy-mm-dd>.md | Every row; one file per calendar day. |
| income_entries | id, entry_date, amount_cents, amount, category, wallet, note, created_at | finance/income.csv | amount is decimal major units; amount_cents is the stored integer. |
| expense_entries | id, entry_date, amount_cents, amount, category, wallet, note, created_at | finance/expenses.csv | amount is decimal major units; amount_cents is the stored integer. |
| loans | id, counterparty, direction, amount_cents, amount, repaid_cents, repaid, remaining_cents, remaining, due_date, state, note, created_at | finance/loans.csv | state is derived at export time from repaid_cents, amount_cents and due_date. |
| jobs + shops | id, title, shop, total_cents, total, paid_cents, paid, remaining_cents, remaining, job_date, warranty_days, status, note, created_at | finance/jobs.csv | shop is the shop name, or empty when the job has none. Remaining never goes below zero. |
| payables + shops | id, title, shop, amount_cents, amount, due_date, paid, note, created_at | finance/payables.csv | Paid and unpaid rows are both exported; paid stays the stored 0/1 flag. |
| tasks | id, title, due_date, done, repeat, note, created_at | tasks.csv | Open and completed tasks are both exported; columns match the Tasks CSV importer. |
| contacts, contact_channels, contact_tags | id, name, address, birthday, notes, created_at, channels, tags | contacts.vcf, contacts.csv | vCard 4.0 cards plus a semicolon-joined CSV matching the Contacts CSV importer; channels keep primary order. |
| wallets, income_categories, expense_categories, shops | id, name | referenced by name in finance CSVs | Reference tables are not separate files; a renamed row exports under its current name. |
| trash_items | - | - | Deliberately excluded from readable exports. Trash stays recoverable in the app and is included in backup archives. |
| vault_items | - | - | Deliberately excluded. Vault contents are ciphertext and are covered by backup archives instead. |
| habits, reminders, shopping, memories, gallery | - | - | Not part of the readable export set; they remain available through backup archives. |
| settings | - | - | Never exported: theme, PIN, security question and notification preferences are local app state. |

## Deliberate limits

- Photo bytes and Vault plaintext/ciphertext are not in a readable export.
- Trash contents and settings are not in a readable export.
- Relationships (`links`) are not a separate file; they remain in backups.
- Habits, scheduled reminders, shopping lists, memories and gallery metadata are
  outside the export set and remain in backups.
