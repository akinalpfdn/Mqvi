# Test harness

## Getting a database

```go
f := dbtest.New(t)          // every migration applied, torn down with the test
repo := NewSQLiteThingRepo(f.DB)
```

`dbtest.New` runs the same embedded migrations the server runs at boot, against a temp-dir database
with foreign keys on. There is no faster in-memory variant on purpose — the point is that a test
sees the schema production sees.

## Seeding

Seeders create whatever a row depends on, so a test names only what it cares about:

```go
id := f.Message(dbtest.MessageSeed{Content: dbtest.Ptr("hello")})   // channel, server and author invented
id := f.Message(dbtest.MessageSeed{ChannelID: ch, Content: ...})    // or pinned down
```

Available: `User`, `Server`, `Channel`, `Message`, `DMChannel`, `DMMessage`. Every one fails the test
on error, so a broken fixture points at itself instead of surfacing as a confusing assertion later.

## What NOT to hand-roll

**Do not write `CREATE TABLE` in a test.** That was the old pattern and it tested a schema that
existed only inside the test file: a column added, renamed or dropped by a migration left those
tests green against a table nothing else had. Nine files did this; none do now.

**Do not skip a foreign key by inventing ids.** If a test needs a server, seed one. The hand-written
schemas had no foreign keys, which is why converting them surfaced a dozen inserts referencing rows
that never existed.

The one exception is a state the schema forbids but older data may still contain — a dangling
reference, say. `f.ExecWithoutForeignKeys` exists for that, and every use should say in a comment why
the state is worth testing.

## Client side

`client/src/testing/fixtures.ts` does the same job for API envelopes, WS events, attachments and
streamed responses. Same rule: if a test is building a shape by hand, add a factory instead.
