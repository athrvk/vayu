---
description: >-
  The SQLite schema Vayu stores locally - every table, its columns, and the JSON shapes kept inside them.
---

# Engine Database Schema

Vayu uses SQLite via `sqlite_orm`.
The schema is defined in `engine/src/db/database_impl.hpp` and the struct definitions live in `engine/include/vayu/types.hpp`.
`sync_schema()` adds new columns automatically on startup - no migration scripts are needed for additive changes.

`Database`'s own code is nine translation units under `engine/src/db/` (issue #1614), one per table family, over that shared internal header:
`database.cpp` (construction, locking, transactions), `db_collections.cpp`, `db_requests.cpp`, `db_environments.cpp`, `db_runs.cpp` (runs and every run-scoped artifact: metric ticks, monitor samples, results, the webhook inbox), `db_specs.cpp`, `db_credentials.cpp`, `db_config.cpp` and `db_maintenance.cpp` (schema migration, corruption recovery, `init()`'s startup repair passes, workspace backup).
`database.hpp`'s section comments name which file defines each member.

> **Breaking changes**: a destructive schema change is now a versioned migration, not a wipe.
> `PRAGMA user_version` is the marker: `Database::Database`'s `migrate_before_sync` (issue #1514)
> reads it before `sync_schema ()` ever runs, and a version behind the engine's own gets whatever
> data-preserving pass that version's cut-over needs, run against the raw file with its own
> `sqlite3` connection - ahead of `sync_schema ()`, because that call is what would `DROP COLUMN` a
> retiring column before a later pass could read it. A version *newer* than the engine's is refused
> outright, naming both versions, rather than opened and possibly written to with settings this
> build does not understand. The [script-to-elements migration](startup-and-recovery.md#the-script-to-elements-migration)
> below is the first of these; the same mechanism serves the next destructive change, not a new one
> invented per issue. An **additive** change - a new column, or existing data reshaped into a new
> one alongside the old - still gets a startup repair pass instead, the shape the header-strip pass
> uses.

---

## Pages

Each page holds one group of tables.

| Page | Holds |
|---|---|
| [Startup validation, backup and recovery](startup-and-recovery.md) | Startup validation, the copy before a migration, the quarantine, the recovery marker, reclaiming freed pages and each repair or migration pass |
| [Schema versions](schema-versions.md) | `SCHEMA_VERSION`, when a change bumps it and what each version changed |
| [Collections, requests and request examples](collections-and-requests.md) | `collections`, `requests`, `request_examples` |
| [Spec documents](specs.md) | `spec_documents`, `spec_declined_operations` |
| [Environments and globals](environments-and-globals.md) | `environments`, `globals` |
| [Certificates, file access and OAuth tokens](credentials-and-files.md) | `client_certificates`, `file_roots`, `file_grants`, `oauth_tokens` |
| [The runs table](runs.md) | `runs` |
| [Run samples, results and the inbox](run-artifacts.md) | `metric_ticks`, `monitor_samples`, `results`, `result_bodies`, `body_blobs`, `inbox_requests` |
| [The config_entries table](config.md) | `config_entries` |
| [Indexes and the VariableValue shape](indexes.md) | Every index, the `VariableValue` JSON shape |

## Connection settings

PRAGMAs are per-connection state, so the engine applies them when the storage opens its one long-lived connection (`Database::Impl` in `engine/src/db/database_impl.hpp`; the values are in `vayu::core::constants::database`).
The `config_entries` rows named below are re-applied by `init` once they can be read.

| PRAGMA | Value | Why |
|--------|-------|-----|
| `journal_mode` | `WAL` | Readers (the run-row reader, a report poll) do not wait on a writer |
| `synchronous` | `dbSynchronous`, default `1` (NORMAL) | See [`dbSynchronous`](config.md#config_entries) |
| `busy_timeout` | `dbBusyTimeout`, default 10 s | How long a statement waits on another connection's lock |
| `cache_size` | `dbCacheSize`, default 64 MB | |
| `temp_store` | `2` (memory) | |
| `mmap_size` | `0` (off) | An I/O error inside a mapped region is a signal (SIGBUS on POSIX), not `SQLITE_IOERR`, so a failing disk or a truncated file would kill the engine with no log line. Mapping 256 MB cut SQLite's read time by 5-55%, which is 1-6 ms per 1,000 result rows (about 50 ms at the default 10,000 stored errors), and Windows cannot truncate a mapped file, so the engine stays unmapped (#2433). Measured on Windows with a release SQLite and a warm OS cache, over a file of 2 KB result rows and 8 KB bodies, cache 64 MB, medians of 7 interleaved runs, mapped against unmapped, first pass then second pass in one connection. 185 MB file (fits the map): scan of 15,000 `results` rows 118 against 202 ms, then 67 against 146 ms; 7,500 random body reads 273 against 339 ms, then 252 against 341 ms. 560 MB file (the map covers part): scan of 50,000 rows 485 against 532 ms, then 336 against 544 ms; 7,500 body reads 326 against 344 ms, then 335 against 375 ms. Only Windows was measured |
| `wal_autocheckpoint` | `1000` pages | Passive: it copies frames back but never shrinks the `-wal` file |
| `journal_size_limit` | `64 MiB` | Once a checkpoint has emptied the log and the next write restarts it, the `-wal` file is cut back to this size. Without it one large transaction (a run prune, a big import) leaves a `-wal` of its own size beside the database for the rest of the session; only a clean shutdown (which checkpoints and deletes the `-wal`) or the startup `VACUUM` gives it back (#2433) |

The run-row reader (see [`runs`](runs.md#runs)) opens `query_only` with `mmap_size = 0` and sets none of the write-side settings.

---

## Tables

**ID format, and who owns it.**
Every row ID in the database is generated by the engine, with `vayu::utils::generate_id("col_")` (see `engine/src/utils/id.cpp`) - `<prefix>_` + a random UUIDv4 (lowercase `8-4-4-4-12` hex, e.g. `col_3f2b1c9a-...`).
No client can supply one: `POST /collections`, `/requests` and `/environments` reject a body carrying `id` with a `400`, and `POST /import/apply` rejects a per-item `id` the same way, taking opaque `tempId`s and returning the map of the real IDs it generated (issues #96, #97).
So the format is a property of the data rather than a convention clients are trusted to follow.
An ID built from a millisecond timestamp would collide for two rows created in the same millisecond and - because persistence upserts (`storage.replace()`) - silently merge them; the random UUID rules that out.
`globals.id` is the one exception: a fixed literal `"globals"`.
