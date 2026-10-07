# Purple Memo

Personal offline notebook and life/money manager — desktop-only (Tauri),
fully offline, encrypted local database.

One person, by design — no accounts, no sync, no cloud.

The full build plan lives in [`docs/PLAN.md`](docs/PLAN.md) — main plan plus
a phase-by-phase build log. The coding agent works one phase at a time from
that plan.

## Local gate

No hosted CI is used. `npm run verify` must be green before every push
(enforced by the pre-push hook):

```
git config core.hooksPath .githooks   # once per clone
```
