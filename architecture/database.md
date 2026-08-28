# Database

Verified against `main` at 2026-08-27.

## Engine and connection

SQLite via **`modernc.org/sqlite`** — pure Go, no cgo. That is why `CGO_ENABLED=0` static builds
work and why the release binaries cross-compile for linux/amd64 and linux/arm64 without a toolchain.

Opened in `database/New` with three pragmas on the DSN:

```
?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)
```

- **`foreign_keys(1)`** — SQLite defaults FKs **off**. Without this every `ON DELETE CASCADE` in the
  schema silently no-ops. `database/migration_smoke_test.go` asserts the pragma is on for exactly
  this reason.
- **WAL** — concurrent readers with a writer.
- **`busy_timeout=5000`** — concurrent writers wait rather than returning `SQLITE_BUSY` immediately.

Pool: `MaxOpenConns(4)`, `MaxIdleConns(2)`, `ConnMaxLifetime(0)`. WAL serialises writes internally,
so a large pool buys nothing.

**This is a single-instance design.** The DB is a file, and the hub and voice state are in memory.
There is no horizontal scale story today.

## Migrations

`server/database/migrations/*.sql`, embedded via `fs.FS`, run at startup by `database.New`. **92
files** as of 092, sequential numeric prefix, applied in filename order. 65 `CREATE TABLE IF NOT
EXISTS` statements across them.

Tracking table:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, ...)
```

Applied filenames are recorded, so migrations are skipped once seen.

### How a migration is applied — `execMigrationInTx`

1. The file is split into statements (`splitStatements`).
2. **`PRAGMA` statements run outside the transaction** — SQLite cannot run them inside one. This is
   why `001_init.sql` can carry `PRAGMA foreign_keys=ON;` at the top.
3. Everything else runs inside a single `tx`.
4. The filename is inserted into `schema_migrations` **in the same tx**, so a partially applied
   migration cannot be recorded as done.
5. Certain statement errors are classified **recoverable** and skipped with a log line rather than
   failing the migration. Check that list before assuming a migration fully applied.

There is also a **bootstrap path**: if `schema_migrations` is empty but tables already exist, the
existing files are recorded as applied rather than re-run. That is what let an already-deployed
database adopt the migration system.

Every migration must be idempotent (`IF NOT EXISTS`) — this is a hard project rule, not a
convention.

## Core schema

`001_init.sql` creates: `server`, `users`, `roles`, `user_roles`, `categories`, `channels`,
`channel_permissions`, `messages`, `attachments`, `invites`, `sessions`.

Everything else grew from there. Notable later additions worth knowing exist:

| Area | Where |
|---|---|
| Full-text search | `006_fts5_search.sql`, `016_dm_features.sql`, `034_e2ee_messages.sql`, `057_fts5_trigram.sql`, `077_servers_fts.sql` |
| AFK timeout | `044_afk_timeout.sql` — `servers.afk_timeout_minutes`, default **60**, `0` disables |
| Channel↔LiveKit binding | `090_channel_voice_bindings.sql` |
| Instance region | `091_livekit_instance_region.sql` — `TEXT NOT NULL DEFAULT ''` |
| Servers index for instance load | `092_servers_livekit_instance_index.sql` |

### FTS5

Search uses FTS5 external-content tables, with a trigram variant added later (`057`). **External
content tables must be pruned with the `delete` command**, not by deleting rows — see
`fix(db): prune external-content FTS tables with the delete command` (07-10). Getting this wrong
leaves the index describing rows that no longer exist.

## Repository layer

103 `sqlite_*.go` files, one per entity, each behind an interface in `repository/`. Raw SQL, no ORM.

**Column lists are centralised per entity** for users, servers, roles and devices
(`refactor(repository): one column list per entity instead of seventeen copies`, 08-02). **Every
other repository still repeats its `SELECT` and `Scan` by hand.** When adding a column, check which
regime the entity is in.

### The miscount trap — this has shipped

A file with four SELECT lists and four Scans lets a miscount compile perfectly and fail at runtime:

```
sql: expected 9 destination arguments in Scan, not 10
```

`GetByServerID` in `sqlite_livekit.go` had `region` added to the Scan but not the SELECT. It is the
only way `pickInstance` reaches a server's own instance, so **every voice join on an unbound channel
failed** — deterministically, not intermittently. Service tests used a stub getter and the
repository test file did not cover that method. Count columns against destinations mechanically
whenever a SELECT list changes.

### Alias shadowing — the other one that has shipped

`livekit_instances` has a **stored** `server_count` column *and* queries that compute
`(SELECT COUNT(*) …) AS server_count`. Inside a SQL expression the real column **shadows the output
alias** — SQLite only prefers the alias for a bare `ORDER BY` term. So
`WHERE server_count < max_servers` compared against the stale stored value (0 for every row these
queries see) and the capacity test silently always passed.

Fixed by renaming the computed alias to `live_server_count`, which cannot be shadowed, and hoisting
the count expression into a named constant. The same trap was found loaded in three more queries
that did not use it in an expression yet. **Never give a computed alias the same name as a real
column.**

The stored `server_count` is still maintained by `Increment/DecrementServerCount` and is read by
nothing that decides anything — dead rather than dangerous.

### Transactions

Services use a `WithTx()` wrapper. A few repository methods need a real `*sql.DB` to start a
transaction and type-assert for it (`MigrateServers`, `MigrateOneServer` in `sqlite_livekit.go`),
returning an error when handed something else. That constraint is documented inline where it
appears; if a repository is ever wrapped in a `TxQuerier` that is not `*sql.DB`, those methods fail.

## Soft delete and cleanup

Accounts and servers use **soft delete with 30-day recovery**; a tombstone hard-delete preserves
message history (`05-08`). An **embedded daily cleanup worker** handles soft-delete TTL, orphan
files and disk-delete retries (`f2e56cc`).

The orphan file sweep had a bug worth remembering: it deleted files it had no source record for
(`fix(cleanup): stop the orphan sweep deleting files it has no source for`, 07-14). A sweep that
deletes on absence of evidence is the wrong default.

## Testing

- Repository tests run against the **real migrated schema** via `testutil/dbtest`, not a
  hand-written table definition (`test: run repository tests against the real schema`, 07-21).
- `testutil/dbtest/dbtest.go` toggles `PRAGMA foreign_keys` OFF/ON around fixture setup — expected,
  not a bug.
- `database/migration_smoke_test.go` runs every migration from empty and asserts FKs are on.
- `test: assert what the attachment writes actually persist` and `test: pin the writes that carry
  security state` exist because assigning a field to a struct does **not** mean the `UPDATE`
  includes that column. When changing a service, open the repository method and read the SQL.
