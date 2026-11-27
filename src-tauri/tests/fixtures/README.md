# Frozen migration fixtures

Three SQLCipher databases written by released versions of Purple Memo. They
exist so the migration chain in `src-tauri/src/schema.rs` is tested against
databases that an old install really produced, instead of only against shapes
hand-built by a test in `src-tauri/src/db.rs`.

Each file is committed exactly as generated: a small, seeded, old-schema
database. Tests never open these files for writing — they copy the fixture to a
temp file, migrate the copy, and assert the copy still holds its rows and its
structure. The committed file stays an old-version database forever, which is
also what makes it a witness: a test asserts the file's `user_version` is still
the old value after the suite has run.

## Test key

Every fixture is encrypted with the same test key, in SQLCipher raw-key form as
the app opens a database (`PRAGMA key = "x'<hex>'"`):

```
5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed
```

It is a TEST constant. No real user database was ever created with it, and it
must never be used for one. The same value is the `FROZEN_FIXTURE_KEY`
constant in `src-tauri/src/db.rs`.

## What each fixture is

| File | Release tag | Tag commit | `user_version` | Tables at that version |
| --- | --- | --- | --- | --- |
| `schema5_v0.1.0.db` | `v0.1.0` | `f608e0234d64aa3b0e59b2c17aa3ac2791ae3d3c` | 5 | 31 regular + `notes_fts` |
| `schema6_v0.1.1.db` | `v0.1.1` | `2a373910eba8101d83ac227896e875592eea0019` | 6 | 31 regular + `notes_fts` |
| `schema12_v0.2.0.db` | `v0.2.0` | `40b724c8ecae25288d58f209afc0e8b3a7a5c2e3` | 12 | 40 regular + `notes_fts` |

The versions are the ones each tag's own `schema.rs` declares
(`pub const SCHEMA_VERSION`), not an assumption about what a release number
should mean.

**Deviation from the brief that commissioned these files:** the brief said
`v0.2.0` is `user_version = 10` and asked for `schema10_v0.2.0.db`. The tag
ships `SCHEMA_VERSION = 12` (the v11 alias table and the v12 GC log were in that
release), so the fixture is the v12 database the tag really produced and is
named `schema12_v0.2.0.db`. A v10 fixture was not manufactured from it: a
database that no released version wrote would be exactly the hand-invented
shape these files exist to replace. Nothing is lost by the gap — the v5 and v6
fixtures migrate through 10 → 11 and 11 → 12 on their way to the current
version, so those steps run against real old data too.

## How they were generated

Method 2 of the brief: the tag's own `BASELINE_SQL`, extracted verbatim from
`<tag>:src-tauri/src/schema.rs`, executed with the current
`rusqlite`/SQLCipher (`rusqlite 0.40.2`, `bundled-sqlcipher-vendored-openssl`),
then `PRAGMA user_version` stamped to the tag's version. Method 1 — checking
each tag out in a worktree and letting that version's own runner create the
file — would mean building each tag's whole Tauri app to obtain one schema, and
adds nothing the extracted DDL does not already prove.

No DDL in these files was retyped, reformatted, or adapted. The generator opens
the database without WAL and leaves `journal_mode = delete`, so each fixture is
one file with no `-wal`/`-shm` sibling.

Regenerate all three (needs the tags locally — `git fetch --tags` first):

```
cargo test --manifest-path src-tauri/Cargo.toml regenerate_frozen_migration_fixtures -- --ignored
```

The generator is the ignored test `regenerate_frozen_migration_fixtures` in
`src-tauri/src/db.rs`; it also prints the path and tag it wrote. Regeneration is
**not** byte-identical: the tagged baselines seed wallets and categories with
`strftime('%Y-%m-%d', 'now', 'localtime')`, and from v7 on the same seeds mint
`randomblob` uids. The sentinel rows below are literals and are identical on
every run; the assertions only depend on those.

## Seed rows

Inserted after the tagged baseline, so the seeded wallets and categories the
baseline creates are still present (5 wallets, 7 expense categories, 4 income
categories). `{V}` is the fixture's schema version — `5`, `6` or `12` — so the
titles differ per file.

At v5 and v6 the tables have no `uid` column yet:

```sql
INSERT INTO collections (id, name, created_at)
  VALUES (1, 'fixture-v{V} shelf', '2026-03-01');
INSERT INTO notes (id, title, content, tags, collection_id, pinned, archived, created_at, updated_at)
  VALUES (1, 'fixture-v{V} note', 'fixture-v{V} body', 'fixture,sentinel', 1, 0, 0, '2026-03-01', '2026-03-02');
INSERT INTO tasks (id, title, due_date, done, repeat, note, created_at)
  VALUES (1, 'fixture-v{V} task', '2026-03-05', 0, 'none', '', '2026-03-01');
INSERT INTO income_entries (id, amount_cents, category_id, wallet_id, entry_date, note, created_at)
  VALUES (1, 1234567, 1, 1, '2026-03-03', 'fixture-v{V} income', '2026-03-03');
```

At v12 the same four rows carry the fixed v4 uids the release's create paths
would have minted:

```sql
INSERT INTO collections (id, uid, name, created_at)
  VALUES (1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01', 'fixture-v12 shelf', '2026-03-01');
INSERT INTO notes (id, uid, title, content, tags, collection_id, pinned, archived, created_at, updated_at)
  VALUES (1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02', 'fixture-v12 note', 'fixture-v12 body', 'fixture,sentinel', 1, 0, 0, '2026-03-01', '2026-03-02');
INSERT INTO tasks (id, uid, title, due_date, done, repeat, note, created_at)
  VALUES (1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03', 'fixture-v12 task', '2026-03-05', 0, 'none', '', '2026-03-01');
INSERT INTO income_entries (id, uid, amount_cents, category_id, wallet_id, entry_date, note, created_at)
  VALUES (1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04', 1234567, 1, 1, '2026-03-03', 'fixture-v12 income', '2026-03-03');
```

Row ids are fixed (`1`), so the tests assert by id and title rather than by a
loose count. The note and task rows also exercise the FTS triggers of the
version that wrote them; the income row is the "money row where the schema has
one". No photos or blobs.

## Adding a fixture for a future release

1. Add `(file, tag, version)` to `FROZEN_FIXTURES` in `src-tauri/src/db.rs`.
2. Run the regeneration command above.
3. Extend the seed SQL if the new version has columns the current statement
   does not fill (the generator's `frozen_seed_sql`).
4. Record the tag, its commit and the seed rows in the table above.
