---
description: >-
  The indexes the engine creates and the JSON shape a stored variable value takes.
---

# Indexes and the VariableValue shape

## Indexes

Declared alongside the tables in `make_vayu_storage()` (`engine/src/db/database_impl.hpp`).
`sqlite_orm` requires index arguments to precede the table arguments.
`sync_schema()` creates them on startup for fresh **and** pre-existing databases, so adding an index is additive and needs no migration step; it still counts as a mapping change for [the schema version](schema-versions.md#schema-versions).

| Index                        | Column                  | Query paths that rely on it                                                                                                                       |
|------------------------------|-------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------|
| `idx_metric_ticks_run_id`    | `metric_ticks.run_id`   | `get_metric_ticks_paginated` / `count_metric_ticks` (every `GET /runs/:id/metrics`), `get_metric_ticks_since` (the legacy SSE poll), and the `remove_all` in the run cascade |
| `idx_monitor_samples_run_id` | `monitor_samples.run_id`| `get_monitor_samples_paginated` / `count_monitor_samples` (every `GET /runs/:id/monitor`) and the `remove_all` in the run cascade                  |
| `idx_results_run_id`         | `results.run_id`        | `get_results` and the `remove_all` in `delete_run`                                                                                                |
| `idx_result_bodies_run_id`   | `result_bodies.run_id`  | `get_result_bodies_paginated` / `count_result_bodies` (every `GET /runs/:id/samples`) and the `remove_all` in the run cascade                     |
| `idx_body_blobs_run_id`      | `body_blobs.run_id`     | The `remove_all` in the run cascade                                                                                                               |
| `idx_requests_collection_id` | `requests.collection_id`| `get_requests_in_collection` (every sidebar load) and cascade delete                                                                              |
| `idx_collections_parent_id`  | `collections.parent_id` | The cascade-delete BFS in `Database::delete_collection`, which does one lookup per node in the subtree                                            |
| `idx_runs_start_time`        | `runs.start_time`       | `get_all_runs` and `get_runs_paginated`, which sort `start_time DESC` on every `GET /runs`... [Details](#idx_runs_start_time-in-full) |
| `idx_inbox_requests_inbox_id`| `inbox_requests.inbox_id`| Every inbox read - the capture page, the live poll, the per-insert retention trim and `DELETE /inbox/:id/requests`                |
| `idx_runs_request_id`        | `runs.request_id`       | `GET /runs?requestId=` and `useLastDesignRunQuery`'s single-run lookup (`get_runs_paginated` with a `request_id` filter)                          |
| `idx_request_examples_request_id` | `request_examples.request_id` | Every example read - `GET /requests/:id/examples`, the create path's append scan, and the `remove_all` in both the request and collection cascades |
| `idx_requests_deleted_at`    | `requests.deleted_at`   | `Database::get_trash`'s request listing (`GET /trash`)... [Details](#idx_requests_deleted_at-in-full) |

`metric_ticks` and `results` are the unbounded-growth tables - a load run writes one tick row per second (the retired EAV `metrics` table cost roughly 20 rows for the same second) - so without `run_id` indexes a lookup slows down with every run ever recorded, not just the current one.
`collections.parent_id` is a nullable column; `sqlite_orm` indexes it without special handling.

Guarded by `DatabaseTest.CreatesIndexesOnFreshDatabase` and `DatabaseTest.RecreatesIndexesOnExistingDatabase` in `engine/tests/db_test.cpp`, which read `sqlite_master` directly rather than trusting what `sqlite_orm` reports about itself.

### `idx_runs_start_time` in full

...and `get_runs_before`, which seeks it to a `before` cursor (#2978).
The `id` tiebreak needs no second column: the plan sorts only the rows sharing one `start_time`, which the `LIMIT` bounds

### `idx_requests_deleted_at` in full

...which otherwise scans every request row and walks the overflow pages of a large body to reach the stamp (#3006).
**Partial:** `WHERE deleted_at IS NOT NULL`, so it holds only the trashed rows and a live write never touches it; a query reaches it only by filtering `deleted_at IS NOT NULL`, which is what the listing does

---

## VariableValue shape

Used in `collections.variables`, `environments.variables`, and `globals.variables`:

```json
{
  "value": "https://api.example.com",
  "enabled": true,
  "secret": false,
  "type": "string",
  "createdAt": 1784967810149
}
```

`secret` is a UI masking hint only - values are not encrypted at rest.
`type` is a UI/script conversion hint, one of `"string"` (default), `"number"`, `"boolean"`, `"json"` - it controls how scripts read the variable via `pm.*.get(...)`.
A Postman import stores a variable's declared `string` / `number` / `boolean` type here, and on a collection or folder also an optional `description` - read by nothing but the Postman exporter, which writes it back; the app's variables editor does not show it.

`createdAt` (ms epoch) is the app's row-ordering key: the variables editor lists a scope oldest-first.
It is **optional** - a row written before the field existed, or stripped by an engine older than the fix for issue #135, simply has none, and the app sorts an absent value as older than everything.
Neither side may backfill it on an existing variable: stamping a legacy row at save time is what made it leapfrog the row the user had just added.
Only the three places that genuinely create a variable stamp it -
the app when the user types a new row, the engine's `pm.*.set()` when a script introduces a key that did not exist, and the Postman importer (`to_var_record`, #3252), which stamps each row of a collection's, folder's, environment's or globals' variable array with one clock reading per import plus the row's position, so the file's order survives the sorted blob.
A re-import into the globals scope through `POST /import` keeps a replaced global's stored `createdAt`, or its absence (`merge_globals_locked`).

The engine round-trips the whole shape through `vayu::json::parse_variables` / `serialize_variables` (`engine/src/utils/json.cpp`) when `POST /execute` persists script-set variables.
**A field added here must be added to both**, or a design run erases it from disk; `engine/tests/script_variables_test.cpp` pins the round trip field by field.
`POST /execute` also skips the write entirely for a scope no script changed, so sending a request no longer touches a collection's / environment's `updated_at`.
