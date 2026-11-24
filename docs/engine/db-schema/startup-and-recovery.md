---
description: >-
  How the engine validates, backs up and repairs its database at startup: the copy before a migration, the quarantine, the recovery marker and each repair pass.
---

# Startup validation, backup and recovery

`Database::Database` (`engine/src/db/database.cpp`) reads `PRAGMA user_version` before anything else - a version newer than this engine's throws immediately and the constructor fails outright (see [the script-to-elements migration](#the-script-to-elements-migration)); that is not corruption, and none of the recovery below applies to it.
Past that gate it probes the file - opens it and runs `sync_schema()` before anything else uses the database - and sorts the answer three ways (issue #2420):

- **Valid**: the probe finished.
- **Corrupt**: a file with no SQLite header (checked without opening it, see below), or a probe that failed with `SQLITE_CORRUPT` (11) or `SQLITE_NOTADB` (26).
  Only this answer reaches the recovery branch.
- **Unavailable**: any other failure - `SQLITE_BUSY` or `SQLITE_LOCKED` (another connection holds the file), `SQLITE_FULL`, `SQLITE_READONLY`, `SQLITE_IOERR`, `SQLITE_CANTOPEN`, a filesystem error, a migration step that failed.
  None of these says anything about the file, so none of them may quarantine it.

Every connection the constructor opens - the migration's, the probe's, the one it keeps - waits `BUSY_TIMEOUT_MS` (10 s) for another connection's lock before its first statement, the same wait `init()` applies from `dbBusyTimeout` afterwards, so a lock that is let go within that window costs a slower start rather than a refusal.
What happens next:

| Outcome | What happens to the files | What is recorded |
|---------|---------------------------|------------------|
| A newer `user_version` than this engine understands | Nothing - the constructor throws before the file is touched, and the daemon does not start | (the exception, naming both versions) |
| An older `user_version` | Before anything raises the version, a copy is saved to `backups/vayu-<stamp>-pre-v<N>.db` ([the copy before a migration](#the-copy-before-a-migration)). If it cannot be written, nothing is touched and the daemon does not start | (the exception, naming the path and why the copy failed) |
| Cannot be examined (locked, disk full, read-only, I/O error) | Nothing is touched, the daemon does not start, the reason is named | (the exception, naming the path, the SQLite code and message, and what to do) |
| Opens cleanly | Once the engine is listening, `<db>.bak` is replaced by a `VACUUM INTO` snapshot of it, validated by the same probe, flushed to disk and renamed into place - so the backup is only ever taken from a database that validated, and is never a partial copy. A clean shutdown after a session that wrote anything takes the same snapshot again (#2421), so the backup holds that session's work | Nothing |
| Corrupt, `<db>.bak` passes the same validation | The corrupt file set is quarantined and the backup copied back over it | `restored_from_backup` |
| Corrupt, `<db>.bak` is corrupt too | The backup is left untouched as evidence, the corrupt file set is quarantined, and a fresh empty database is created | `backup_also_corrupt` |
| Corrupt, `<db>.bak` cannot be examined | Nothing is touched and the daemon does not start, naming the backup: whether it would restore is unknown | (the exception, naming the backup) |
| Corrupt, there is no backup | The corrupt file set is quarantined and a fresh empty database is created | `started_fresh_quarantined` |
| Corrupt, and the quarantine rename fails too | `<db>`, `<db>-wal` and `<db>-shm` are **deleted** so the daemon can still start | `deleted_corrupt` |

The refusal reaches the daemon's `main`, which prints it on stderr and exits 1 - the same path the newer-schema refusal takes.
A snapshot the backup refresh cannot examine is discarded with a reason that says so (`the snapshot could not be examined: ...`), and the previous `<db>.bak` stands, as it does for one that did not validate.

The shutdown refresh (`Database::refresh_recovery_backup_on_shutdown`) runs after the run drain, while the engine still holds its lock.
It is skipped when `sqlite3_total_changes64` on the shared connection has not moved since `init()` (a write through any other connection is not counted), checkpoints the WAL (`TRUNCATE`, a reader another process holds tolerated), and is bounded by the smaller of `SHUTDOWN_BACKUP_DEADLINE_MS` (2 s) and what is left of the app's 5 s shutdown window:
the copy is interrupted at the deadline and one that finishes after it is discarded unvalidated.
Validation, the flush and the rename that follow an in-time copy run to completion.
Every way it stops leaves the previous `<db>.bak` and logs a `db` warning saying so.

Starting fresh is deliberate - the alternative is a daemon that fails to start on every launch forever - but it is total: collections, requests, environments, saved examples, spec documents and run history are all gone, and the app comes up looking like a fresh install.

> **`<db>.bak` is not a user backup.** It is rewritten once the engine listens
> and again at a clean shutdown, so it exists to give a corrupt file something
> to restore *from*, not to let anyone go back to last week. Work written after
> the last refresh (a session that ended in a crash or a power cut rather than
> a clean shutdown) is not in it - and the row above where it is the only copy
> left is the one that ends in an empty workspace. The snapshot a user owns is
> `POST /workspace/backup` / `vayu-cli backup`, described in
> [architecture.md](../architecture.md#workspace-backups).

> **The copy taken before a rewrite is in `backups/`, not beside the
> database.** `<db>.bak` is refreshed, once the engine listens, from a file the
> migration or repair has already rewritten, so it cannot be the way back.
> [The copy before a migration](#the-copy-before-a-migration) is.

## The copy before a migration

Before `migrate_before_sync` raises `user_version` - on the stamp-only path as well as before the transaction of a step that rewrites rows - the constructor's call writes a `VACUUM INTO` snapshot of the file to `backups/vayu-<stamp>-pre-v<N>.db` beside it, where `N` is the version the file had (#2426).
It is the copy an engine at version `N` opens, and the only one: the `<db>.bak` refresh that follows replaces the backup from the migrated file.

- **No copy, no migration.**
  When the snapshot cannot be written (the folder cannot be created, the disk is full) the constructor throws `Vayu could not migrate the database at <path> to schema version <V>: no copy of it could be saved first (...)`, the daemon does not start, and the file is left byte for byte as it was.
  A file that holds no table yet is not copied.
- **The same retention as a workspace backup.**
  It is pruned with `maxBackupsRetained` (default 5, `0` = unlimited), counted together with the snapshots `POST /workspace/backup` writes, the setting read from the file before any `Database` exists.
  It is the newest file when it is written, so the start that writes it never prunes it; five later backups do.
  Exempting it from the count was weighed and declined: a full copy of every stored credential that nothing ever removes is what this replaced.
- **Only the constructor's own call takes it.**
  `probe_database` runs the same migration on a candidate it is about to judge (a `.bak` recovery may restore, the refresh's own snapshot), which is not the workspace a person goes back to, and takes none.
- **The header-strip pass takes one too**, labelled `pre-repair` ([below](#the-header-strip-pass)).

Engines before this wrote `<db>.pre-migration.bak` and `<db>.pre-upgrade.bak` (with their `-wal` and `-shm`) beside the database and never removed them.
They are removed on a later start than the one that migrated: one that validated, found the file already at `SCHEMA_VERSION` before writing anything, and has refreshed `<db>.bak`.
A file modified since that start began is left alone.

## The quarantine

A database that is corrupt is **moved, not deleted**: `<db>` becomes `<db>.corrupt-<epoch-ms>` with its `-wal` and `-shm` sidecars renamed alongside (#984).
SQLite's own tooling can usually pull most rows back out of a damaged file, and only while the file exists:

```
sqlite3 /path/to/vayu.db.corrupt-1755870000000 .recover > salvage.sql
```

Two rules bound it:

- **At most two sets are kept.**
  These are full-size copies written unattended into the user's data directory; the newest two survive each recovery and older ones are pruned.
  Two, not one, because the set before the current one is what says this has happened before.
- **The backup is validated before it is trusted.**
  It gets the same open plus `sync_schema()` probe the main file gets - which also migrates a backup taken by an older build before it is committed to.
  A corrupt backup is left exactly where it is rather than written over the original, which is what `backup_also_corrupt` records; one that cannot be examined stops the start before the original is moved.

A quarantined set is the whole file as it was, so when the file was in fact healthy, putting it back by hand undoes the recovery: see [architecture.md](../architecture.md#restoring).

One implementation detail worth knowing before changing the order of that code: the validation probe cannot be the first thing to touch the file.
SQLite **deletes the `-wal` and `-shm`** when it opens a file whose header is not a database's, and a `-wal` holds committed transactions the main file does not, so the sidecars would be gone before the quarantine could move them.
The constructor reads the 16-byte SQLite header itself first and only opens a file that could plausibly be a database.

## The recovery marker

The record of that cannot live in the database, because the database is the thing that just went away, so it is a small JSON file beside it, `<db>.recovery` (#922), written by `engine/src/db/recovery.cpp`:

```json
{
  "outcome": "started_fresh_quarantined",
  "at": 1755870000000,
  "quarantinedPath": "/home/someone/.local/share/vayu/vayu.db.corrupt-1755870000000"
}
```

`at` is epoch milliseconds, as every other engine timestamp is.
`quarantinedPath` is present only when a set went to the quarantine - absent for `deleted_corrupt` and for a marker an engine without the quarantine wrote (#984) - so a reader tests for it rather than deriving it from `outcome`.
Two rules the readers depend on:

- **A clean start writes no marker.**
  The file's presence alone is what distinguishes a wiped database from a genuine first run, which produces an empty database too.
  There is deliberately no `ok` outcome.
- **A marker is never cleared by the engine.**
  The engine can be restarted, or crash, before any client has polled it; clearing it on the next clean start would lose exactly the case the file exists for.
  Showing a notice about it once is the *reader's* job - the app remembers the `at` it has acknowledged (`app/src/stores/recovery-notice-store.ts`).

`Database` reads the marker once at construction and exposes it as `Database::recovery()`, so the polled `GET /health` costs no file access.
That endpoint reports it as a `recovery` node, absent on a clean start - see [api-reference/health-config.md](../api-reference/health-config.md#get-health) - and the app renders it as a dismissible banner naming the database path and, when there is one, the quarantined file, how to copy it back to undo the recovery and the `.recover` command that reads it.

## Reclaiming freed pages

Deleting rows - a prune, a trash purge, the `metrics` drop - moves their pages to SQLite's freelist, where the engine reuses them and the filesystem never sees them again, so a workspace that once held weeks of heavy runs keeps that high-water mark forever.
`Database::init()` ends with a guarded `VACUUM` that gives them back (issue #990).

Guarded, because a `VACUUM` rewrites the whole database: it runs only when **both** thresholds are crossed - at least **25%** of the file's pages are free **and** they hold at least **10 MiB** (`VACUUM_MIN_FREELIST_PERCENT` / `VACUUM_MIN_RECLAIMABLE_BYTES`, compile-time, deliberately not configurable).
The fraction alone would rewrite a nearly-empty workspace on every start; the byte floor alone would rewrite four gigabytes to win back eleven megabytes.
Neither threshold crossed means the pass reads three PRAGMAs and returns.

Three things worth knowing about where it sits:

- **Last in `init()`**, after the run prune and the trash purge, so it sees the pages every sweep freed rather than only the first one's.
- **On the storage's own held connection** (`open_forever`), under the DB mutex, never on a second one.
  The truncating checkpoint below needs the file unmapped, because Windows refuses to truncate a file any connection has mapped (`mmap_size`) - with a mapping the rewrite committed and the file stayed its old size.
  No connection maps it ([Connection settings](index.md#connection-settings)).
  (`POST /workspace/backup`'s `VACUUM INTO` runs on its own separate connection, since it writes a different file, and so does the [run-row reader](runs.md#runs), which maps nothing and opens only after `init`.)
  Nothing contends for it: `init` runs before the HTTP listener starts, and the instance lock has already refused a second engine.
- **The `VACUUM` is followed by a `wal_checkpoint(TRUNCATE)`.**
  Under WAL the rewritten image lands in the `-wal` file and the database is not resized until a checkpoint copies it back, so without it the pass would free every page it set out to and leave the file exactly as large as it found it.

The outcome is logged at info level (`Reclaimed N KB of freed database pages`), because the cost is paid on the startup path - `db.init()` returns before `/health` answers, and the app's readiness poll budgets 45 seconds against it before handing the engine to the renderer's own health poll.
A rewrite slow enough to matter is one this line explains.
Best-effort like the sweeps before it: a failure is a warning, never a daemon that will not start.
`auto_vacuum` was rejected as the alternative - switching an existing database's mode requires a full `VACUUM` anyway, and it changes page bookkeeping for every write thereafter.

## The header-strip pass

`Database::strip_stored_managed_headers()` (#1487, #1491), called from `init()`, disables the `X-Vayu-Version`, `X-Request-ID` and `User-Agent` rows a pre-#1229 renderer wrote into a saved request's `headers` column on the app's own behalf - default headers are applied per transfer now and never stored.
Like the passes above it runs before `/health` can answer, but it is scoped so a workspace with nothing left to touch pays close to nothing for it:

- **A SQL `LIKE` over `headers` first, on undeleted rows only.**
  Only rows whose header text could contain one of the three names, and whose `deleted_at` is `NULL`, are loaded into a `Request` and JSON-parsed; `LIKE` is ASCII case-insensitive by default, the same fold the exact predicate applies to a matched key.
  A workspace already handled costs one scan of the column, not a materialisation of every request's body and script.
  A request in the trash is left byte-identical - see below.
- **A row is matched by value shape, not by name or header family alone** (issue #1491):
  a `X-Vayu-Version` only when its value is a plain `MAJOR.MINOR.PATCH` version, an `X-Request-ID` only when its value is the exact lowercase RFC 4122 v4 UUID `generateUUID()` produced, and a `User-Agent` only when its value is `Vayu/` followed by that same plain version - never a name or family match broad enough to catch a value the user typed on purpose.
- **A match is disabled and marked, never deleted** (issue #1491): the row's `enabled` is set to `false` (so it is never sent - the wire is exactly as clean as deleting it would have been) and its `source` is set to `"legacy-default"`, the app-readable marker `KeyValueEntry.source` already carries for an app-written row (issue #1481).
  The row survives for a user to find in the editor and re-enable, in case a match turns out to be wrong.
- **One transaction for the rewrite**, not one implicit commit per candidate row - the same shape `seed_default_config` uses.
- **A one-time marker.**
  Once a pass finds nothing left to change, it records a `managedHeadersStripped` config entry (`advanced`, no everyday user story) and every later start skips the scan outright rather than re-running it to confirm nothing changed. #1492 will give this kind of migration bookkeeping a proper home; until then a config entry is where this file's other internal-only flags already live.
- **A `backups/vayu-<stamp>-pre-repair.db` snapshot** is written immediately before the first row this pass ever rewrites, under the same retention as [the copy before a migration](#the-copy-before-a-migration).
  When it cannot be written the pass rewrites nothing and leaves its marker unset, so the next start tries again.
- **Trash is caught up on restore, not on the startup scan.**
  A request already in the trash when this pass runs is skipped, so it stays byte-identical for as long as it sits there; restoring it (`restore_request_locked` / `restore_collection_locked`) runs the same disable-and-mark step on its way back, which is a no-op if the pass already handled it before the request was deleted.

## The empty-parent pass

`Database::clear_empty_parent_ids()`, called from `init()`, rewrites every collection stored with `parent_id = ''` to `NULL`, trashed rows included.
A `parentId: ""` kept as written is a second spelling of the tree root that the change feed and `get_requests_in_subtree` read as root while the append scan, the root `normalize` of `POST /reorder` and a restore did not, so such a row tied with the first root, and a delete and restore of it came back with `reparentedToRoot: true`, as if its parent were gone (#3451).
The write paths store `""` as `NULL` (`read_parent_id_field`, see [Accepted field shapes](../api-reference/resource-writes.md#accepted-field-shapes)); this pass is for the rows written before that.

- **No done marker and no schema bump.**
  Both statements, the count and the `UPDATE`, are served by [`idx_collections_parent_id`](indexes.md#indexes), so a workspace with nothing to rewrite pays one index probe per start, not the scan the [header-strip pass](#the-header-strip-pass) marks itself done to avoid.
  Running every start also catches a `''` an older engine writes after a downgrade.
  An older engine reads `NULL` as the root, as it always did, so the rewrite is nothing it must be stopped from reading past, which is what a bump is for ([Schema versions](schema-versions.md#schema-versions)).
- **One statement**, so one commit.
  `updated_at` is left alone: the row meant the root all along.
- **A `backups/vayu-<stamp>-pre-repair.db` snapshot** is written immediately before the first rewrite, as the header-strip pass does.
  When it cannot be written the pass rewrites nothing, logs a warning, and the next start tries again.

## The script-to-elements migration

Issue #1513 landed `elements` additively, beside the two script columns, with a startup repair pass (`fold_scripts_into_elements`) that gave a 0.26-shaped row an `elements` entry without touching `pre_request_script` / `post_request_script` - nothing ran an *element* yet, so the columns had to keep driving execution.
Issue #1514 lands the pipeline that runs one, which is what makes the two columns dead data and the cut a real migration rather than another additive pass.
The repair pass, its `scriptsFoldedIntoElements` marker and its `.pre-elements-fold.bak` snapshot are gone; `PRAGMA user_version` is the marker now.

`migrate_before_sync (path, busy_timeout)` (`engine/src/db/db_maintenance.cpp`, declared in `database_impl.hpp` so `Database::Database`'s constructor - `engine/src/db/database.cpp` - can call it before *any* `sync_schema ()`, including the constructor's own validation probe) opens `path` with a raw `sqlite3` connection, independent of `sqlite_orm`:

1. **Read `PRAGMA user_version`.**
   Newer than this engine's `SCHEMA_VERSION` (currently `11`, see [Schema versions](schema-versions.md#schema-versions)) throws `std::runtime_error` naming both versions - not inside the constructor's probe/recovery try-catch, so the exception reaches the daemon's own startup failure path, naming both versions, rather than surfacing from the probe as a generic refusal to examine the file.
   Equal to `SCHEMA_VERSION` is a fast no-op.
   Anything older is copied first ([the copy before a migration](#the-copy-before-a-migration)).
   `0` (every database written before this issue, folded by #1513's pass or not) proceeds to fold.
   `1` and `2` have no script column left, so they skip the fold and are only stamped.
2. **Fold, if either table still has a script column.**
   For each of `requests` and `collections` that does (either `pre_request_script` or `post_request_script` alone is enough - a table needs folding for), in one transaction, per table:
   read its actual column set fresh (`PRAGMA table_info`), `ALTER TABLE ... ADD COLUMN elements TEXT NOT NULL DEFAULT '[]'` when the column is not there yet - a genuinely pre-cutover database (older than #1513) never ran the additive pass that would have added it, so this migration is the first thing that does -
   and select `''` for whichever script column the table does not carry, rather than a `SELECT` that names a column absent from this row's table and fails to prepare.
   Then, per row: parse `elements`, append a `{"id": "el_...", "kind": "script.pre" | "script.post", "enabled": true, "config": {"script": "..."}}` for each non-blank script column *not already represented* in `elements` (the check that makes a database #1513's additive pass already folded safe to re-run through this migration without a duplicate), and write the row back.
   A database neither table needs folding for (a fresh install, or one some other path already brought to this shape) skips the transaction.
   A fold failure rolls the transaction back and throws, naming the SQLite message that caused it.
   A refused `BEGIN IMMEDIATE` (another writer holds the lock), a refused stamp and a failed `COMMIT` are treated the same way: each throws that message through the same `exec_or_throw` helper (a failed `COMMIT` is rolled back first), and the stamp-only path throws on a failed stamp too.
   The file is left as it was, scripts still in their columns and `user_version` unmoved, so the next start runs the migration again.
   The constructor's first call is unguarded and the probe's call classifies the throw as unavailable, never corrupt, so neither path quarantines the file.
3. **Stamp `user_version = SCHEMA_VERSION`.**
   Both writes (the no-fold path and the fold's commit) go through one helper, `stamp_schema_version`, so a bump of the constant is a bump of every stamp.
   Only after this returns does `sync_schema ()` see a mapping with no `pre_request_script` / `post_request_script` columns and `ALTER TABLE ... DROP COLUMN` them - the ordering this migration exists to guarantee, per `engine/CLAUDE.md`'s "Removing a column" rule.

`GET /elements/kinds`'s `script.pre` / `script.post` entries gained `apply` in the same issue, so a row this migration folds is not just storage-compatible but immediately runnable.

## The file-trust restatement (schema version 4)

Version `4` stated an explicit `unresolved` on every stored file reference (absent written as `false`: the editor was the one writer that left the key out) and removed the allowed folders the root rule refuses.
The restatement is superseded by [the file-grants migration](#the-file-grants-migration-schema-version-6), which now runs in its place for every older database and reads an absent key the way version `4` did when the database predates it.
The folder removal still runs, in the same step:

- **Removes the allowed folders the root rule refuses.**
  A [`file_roots`](credentials-and-files.md#file_roots) row whose path `refused_root_reason` rejects - a filesystem or drive root, the home folder, or a folder containing it - is deleted and logged at warning level with the reason, so a user can see why Settings > Files no longer lists it.
  `FileAccessPolicy::from_database` therefore reads only rows the route would accept, and carries no second check.

## The file-grants migration (schema version 6)

From version `6` the engine derives a file reference's trust from the allowed folders and the picked files ([`file_grants`](credentials-and-files.md#file_grants)) and never reads it from a body (#2356).
Stored bodies still carry the old `unresolved` key, so the same `migrate_before_sync` transaction, for any database below version `6`, after the fold:

- **Grants every file a person chose.**
  A file reference stored as chosen - `unresolved: false`, or, on a database below version `4`, no key at all - whose `src` is an absolute path holding no `{{` and still resolves to a regular file becomes one `file_grants` row, its canonical path, deduplicated (`vayu::http::grantable_file_path`).
  A path that is gone, a templated one, `true`, a non-boolean, and (from version `4` on) an absent key grant nothing.
  A chosen concrete path that is gone (deleted, or on a drive or share not mounted at upgrade time) is the one of those a person loses, so each is logged at warning level once the step has run, with its `table`, row `id` and `path`, followed by one warning carrying the `count`; this happens on the stamp-only path too, where a pre-version-`4` body without the key leaves nothing to rewrite.
  The step runs once, so such a file reads as not chosen even after the drive returns, until it is picked again.
- **Removes the key from every stored body.**
  The two places a body `FilePlan` sends is stored: `requests.body` (trash included) and the top-level `body` of `runs.config_snapshot` (the payload a history entry is re-opened from), a binary `file` and every `type: "file"` form part.
  Only values whose text contains `"file"` are parsed; one that is not JSON is left byte-identical and logged at warning level, never dropped.
  `request_examples.body` is a response's text and `inbox_requests.body` the bytes a listener received: neither is ever parsed as a request body, so neither is visited (both are stored and read back byte-exact, a zero byte included, see [`request_examples`](collections-and-requests.md#request_examples) and [`inbox_requests`](run-artifacts.md#inbox_requests)).
  `collections` and the other tables store no request body.
- **Removes the allowed folders the root rule refuses**, as version `4` did.

`file_grants` is created by this step (`CREATE TABLE IF NOT EXISTS`, `FILE_GRANTS_DDL` in `db_maintenance.cpp`) because it runs before `sync_schema ()`; the statement is exactly what the mapping generates, or `sync_schema ()` would rebuild the table empty.
All of it is planned before anything is written, so a database with nothing to change is only stamped; either way the [copy before a migration](#the-copy-before-a-migration) is written first.
A second run finds nothing to change and grants nothing twice.
A database already at `6` does not run it on its way to a later version (`plan_file_trust_migration` plans nothing from `6` on), so a root rule that has since moved never removes a folder allowed under the rule it was written with.
**The cost**: a body a non-editor caller managed to store as `unresolved: false` before the upgrade is granted once, like a pick.

## The sibling-order migration (schema version 7)

From version `7` a collection's sub-folders and its requests share one `order` space (#2535): siblings sort by `(order, kind, createdAt, id)` with a sub-folder before a request on a tie, so an imported Postman collection can keep a request above or between its folders.
Before it, each kind was numbered from `0` and displayed as two blocks, folders first; read with the merged comparator, those numbers would interleave (`f0 r0 f1 r1`).
So the same `migrate_before_sync` transaction, for any database below version `7`, after the file-grants step:

- **Moves every request past its collection's sub-folders.**
  For each collection with at least one sub-folder, every request whose `collection_id` it is gains one more than the highest `order` among the collections whose `parent_id` it is -
  trashed folders included, so a folder restored from the trash cannot land on a request - and, when the collection's lowest request `order` is negative, that much again, so every request sorts strictly after every folder.
  Trashed requests move with the rest.
  Relative order within each kind is unchanged, so the merged comparator lists each parent exactly as the two blocks did.
  A collection with no sub-folder, trashed or live, is untouched.

`plan_sibling_order_shift` (`db_maintenance.cpp`) reads one shift per collection before anything is written, so a database with no request beside a sub-folder is only stamped; either way the [copy before a migration](#the-copy-before-a-migration) is written first.
A plan read SQLite refuses throws rather than reading as "nothing to shift", and a refused shift rolls the whole transaction back with `user_version` unmoved.
The step is not idempotent on its own - run twice, it would shift twice - so the version stamp, written in the same transaction, is its only done-marker.
