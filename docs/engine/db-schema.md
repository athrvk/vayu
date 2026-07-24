# Engine Database Schema

Vayu uses SQLite via `sqlite_orm`. The schema is defined in `engine/src/db/database.cpp` and the
struct definitions live in `engine/include/vayu/types.hpp`. `sync_schema()` adds new columns
automatically on startup - no migration scripts are needed for additive changes.

> **Breaking changes**: because Vayu is pre-release, destructive schema changes (column removal,
> type changes) wipe the database rather than migrating it. The `PRAGMA user_version` is
> not currently managed; wipe is done by deleting the `.db` file.

---

## Tables

**ID format.** Row IDs are `<prefix>_` + a random UUIDv4 (lowercase `8-4-4-4-12`
hex, e.g. `col_3f2b1c9a-...`), the same shape whether a row is created by the app
or the engine. The engine generates them with `vayu::utils::generate_id("col_")`
(see `engine/src/utils/id.cpp`); the app's import pipeline uses
`col_${crypto.randomUUID()}`. The engine formerly built IDs from a millisecond
timestamp, so two rows created in the same millisecond collided and - because
persistence upserts (`storage.replace()`) - silently merged; the random UUID
removes that. `globals.id` is the one exception: a fixed literal `"globals"`.

### `collections`

Stores folder/group hierarchy for requests.

| Column               | Type    | Notes                                        |
|----------------------|---------|----------------------------------------------|
| `id`                 | TEXT PK | `col_` + UUID                                |
| `parent_id`          | TEXT    | NULL for root collections                    |
| `name`               | TEXT    |                                              |
| `description`        | TEXT    | Default `""`                                 |
| `variables`          | TEXT    | JSON: `Record<string, VariableValue>`        |
| `auth`               | TEXT    | JSON: `RequestAuth` (never `inherit`)        |
| `pre_request_script` | TEXT    | Default `""`                                 |
| `post_request_script`| TEXT    | Default `""`                                 |
| `order`              | INTEGER | Sort order within parent; default 0          |
| `created_at`         | INTEGER | Unix ms                                      |
| `updated_at`         | INTEGER | Unix ms                                      |

**auth** is a JSON discriminated union: `{"mode":"none"}` | `{"mode":"bearer","token":"..."}` |
`{"mode":"basic","username":"...","password":"..."}` | `{"mode":"apikey","key":"...","value":"...","in":"header"|"query"}` |
`{"mode":"oauth2","config":{…}}` (see [`requests.auth`](#requests) and [`oauth_tokens`](#oauth_tokens)).
Collections are always auth sources - they never store `{"mode":"inherit"}`.

**Cascade delete**: deleting a collection performs BFS to collect all descendant IDs, then
deletes all their requests before deleting the collections deepest-first, wrapped in a single
transaction so a crash mid-cascade cannot leave a half-deleted subtree. See
`Database::delete_collection()`.

`parent_id` forms a tree, but SQLite enforces no such constraint, so the BFS carries a visited
set and is **cycle-safe**: a self-parent (`parent_id == id`) or an `A -> B -> A` loop terminates
instead of growing the work list forever under the global DB mutex (which would hang every
endpoint, including `/health`). `POST /collections` rejects the writes that would create such a
cycle (see [api-reference.md](api-reference.md) - POST /collections), so cycles only arise from
data written before that validation existed; the visited set is what lets deletion recover from it.

---

### `requests`

Stores individual HTTP request definitions.

| Column                | Type    | Notes                                                |
|-----------------------|---------|------------------------------------------------------|
| `id`                  | TEXT PK | `req_` + UUID                                        |
| `collection_id`       | TEXT    | FK → `collections.id` (not enforced by SQLite FK)   |
| `name`                | TEXT    |                                                      |
| `description`         | TEXT    | Default `""`                                         |
| `method`              | TEXT    | `GET` / `POST` / `PUT` / `PATCH` / `DELETE` / etc.  |
| `url`                 | TEXT    |                                                      |
| `params`              | TEXT    | JSON array of `KeyValueEntry[]`                      |
| `headers`             | TEXT    | JSON array of `KeyValueEntry[]`                      |
| `body`                | TEXT    | JSON discriminated union (see below)                 |
| `body_type`           | TEXT    | Denormalized mirror of `body.mode`; kept for queries |
| `auth`                | TEXT    | JSON discriminated union (see below)                 |
| `pre_request_script`  | TEXT    | Default `""`                                         |
| `post_request_script` | TEXT    | Default `""`                                         |
| `order`               | INTEGER | Sort order within collection; default 0              |
| `follow_redirects`    | INTEGER | Boolean; default 1 (follow)                          |
| `max_redirects`       | INTEGER | Hops allowed while following; default 10             |
| `created_at`          | INTEGER | Unix ms                                              |
| `updated_at`          | INTEGER | Unix ms                                              |

**params / headers** - stored as a JSON array of objects:
```json
[{"key":"Content-Type","value":"application/json","enabled":true,"description":""}]
```
Disabled rows (`"enabled":false`) are preserved in storage and filtered at HTTP-execution time only.
Duplicate keys are allowed.

**body** - discriminated union:
```json
{"mode":"none"}
{"mode":"json"|"text"|"graphql","content":"..."}
{"mode":"form-data"|"x-www-form-urlencoded","fields":[{"key":"...","value":"...","enabled":true}]}
```

**auth** - discriminated union (same shape as collection auth, plus `inherit`):
```json
{"mode":"none"}
{"mode":"inherit"}                                        // resolved at execution time
{"mode":"bearer","token":"..."}
{"mode":"basic","username":"...","password":"..."}
{"mode":"apikey","key":"...","value":"...","in":"header"|"query"}
{"mode":"oauth2","config":{ /* OAuth2Config */ }}
```

The `oauth2` `config` holds the grant type, endpoints, client id/secret,
placement options, etc. Secret fields (`clientSecret`, `password`) are stored
**in plaintext** here, same as bearer/basic credentials - the v1 posture. The
resolved access tokens live separately in [`oauth_tokens`](#oauth_tokens).

**follow_redirects / max_redirects** - the request's redirect policy, surfaced
in the request builder's **Settings** tab and serialized as `followRedirects` /
`maxRedirects`. They mirror the executable `vayu::Request` fields of the same
name, so the saved policy is what `POST /execute` and `POST /runs` apply.

Both columns are `NOT NULL` with a `DEFAULT`, which is what lets `sync_schema()`
add them to an existing, non-empty `requests` table - a `NOT NULL` column with
no default cannot be added by `ALTER TABLE ADD COLUMN`. Rows written before the
columns existed backfill to `1` / `10`, i.e. the behaviour they already had.
`max_redirects` is clamped to `0..100` on write.

---

### `environments`

Stores named variable sets.

| Column       | Type    | Notes                                 |
|--------------|---------|---------------------------------------|
| `id`         | TEXT PK | `env_` + UUID                         |
| `name`       | TEXT    |                                       |
| `description`| TEXT    | Default `""`                          |
| `variables`  | TEXT    | JSON: `Record<string, VariableValue>` |
| `is_active`  | INTEGER | Boolean; 0 or 1                       |
| `created_at` | INTEGER | Unix ms                               |
| `updated_at` | INTEGER | Unix ms                               |

---

### `globals`

Singleton table; always has exactly one row with `id = "globals"`.

| Column       | Type    | Notes                                 |
|--------------|---------|---------------------------------------|
| `id`         | TEXT PK | Always `"globals"`                    |
| `variables`  | TEXT    | JSON: `Record<string, VariableValue>` |
| `updated_at` | INTEGER | Unix ms                               |

---

### `runs`

Stores design-mode and load-test run records. Defined in `database.cpp` (`make_table("runs", …)`);
struct is `db::Run` in `engine/include/vayu/types.hpp`.

| Column            | Type    | Notes                                                       |
|-------------------|---------|-------------------------------------------------------------|
| `id`              | TEXT PK | `run_` + UUID                                               |
| `request_id`      | TEXT    | FK → `requests.id` (optional; set in design mode)           |
| `environment_id`  | TEXT    | FK → `environments.id` (optional)                           |
| `type`            | TEXT    | `"design"` or `"load"`                                      |
| `status`          | TEXT    | `"pending"` / `"running"` / `"completed"` / `"failed"` / `"stopped"` |
| `config_snapshot` | TEXT    | JSON snapshot of the request/env at run time                |
| `start_time`      | INTEGER | Unix ms                                                     |
| `end_time`        | INTEGER | Unix ms                                                     |

There is **no** `summary` column - aggregate metrics for a finished run are reconstructed at
read time from the `metrics` and `results` tables (see `GET /runs/:runId/report`).

**`config_snapshot` redaction** - the snapshot is the raw run payload, which can
carry auth credentials. Before persistence, its top-level `auth` object is
reduced to just `{"mode": "..."}` (via `sanitize_config_snapshot` in
`utils/json.cpp`) - an allowlist, so no current or future auth field
(`clientSecret`, `password`, tokens) leaks into a stored run.

---

### `oauth_tokens`

Cached OAuth 2.0 access/refresh tokens, keyed by config identity. Written by the
token client (`engine/src/http/oauth_client.cpp`); struct is `db::OAuthToken`.
Auto-created by `sync_schema()`.

| Column          | Type    | Notes                                                             |
|-----------------|---------|-------------------------------------------------------------------|
| `cache_key`     | TEXT PK | `accessTokenUrl \x1f clientId \x1f credentialsId \x1f username?` - byte-identical to the app's `computeOAuth2CacheKey` (omits scope/audience/resource) |
| `access_token`  | TEXT    | Bearer token (plaintext at rest)                                  |
| `token_type`    | TEXT    | Defaults to `"Bearer"` when the provider omits it                 |
| `refresh_token` | TEXT    | `""` when none                                                    |
| `scope`         | TEXT    | Granted scope, if returned                                        |
| `expires_in`    | INTEGER | Seconds; `0` = non-expiring                                       |
| `created_at`    | INTEGER | Unix ms                                                           |
| `raw_response`  | TEXT    | Provider JSON (truncated to 4 KB); debugging only, never logged   |

Expiry is `now > created_at + expires_in*1000 − 45s` (skew). On refresh the
`refresh_token` rotates when the provider issues a new one; a rejected refresh
token clears the row and falls back to a fresh grant. There is **no** mid-run
refresh. Tokens are plaintext at rest (v1 posture); the row is cleared via
`DELETE /oauth2/token`.

---

### `metrics`

Time-series metrics for a load test. One row per (`run_id`, `name`, `timestamp`) sample; the
metrics producer thread writes a batch each tick. Struct is `db::Metric`.

| Column      | Type            | Notes                                              |
|-------------|-----------------|----------------------------------------------------|
| `id`        | INTEGER PK      | Autoincrement                                      |
| `run_id`    | TEXT            | FK → `runs.id`                                     |
| `timestamp` | INTEGER         | Unix ms                                            |
| `name`      | TEXT            | `MetricName` (see below)                           |
| `value`     | REAL            | Numeric sample                                     |
| `labels`    | TEXT            | JSON for extra dimensions (e.g. the per-status map for `status_codes`) |

`name` is one of the `MetricName` enum values (`engine/include/vayu/types.hpp`), serialized via
`to_string`. Current set includes: `rps`, `latency_avg`, `latency_min`, `latency_max`,
`latency_p50/p75/p90/p95/p99/p999`, `error_rate`, `total_requests`, `completed`,
`connections_active`, `requests_sent`, `requests_expected`, `send_rate`, `throughput`,
`backpressure`, `dropped_requests`, `queue_wait_avg`, `bytes_sent`, `bytes_received`,
`peak_concurrency`, `status_codes`, `test_duration`, `setup_overhead`, and the
`tests_validating/passed/failed/sampled` script-validation metrics.

**Latency percentile rows come in two flavors, disambiguated by `labels`:**

- **Per-tick windowed rows** (`latency_p50/p95/p99`, empty `labels`): written ~1/s during
  the run. Each is a **rolling window** sampled from a phaser-based `hdr_interval_recorder`
  (sample-and-reset per tick), so the value reflects the *recent* interval, not the
  all-time distribution. These power the live/history "percentiles over time" chart, the
  response-time-vs-concurrency scatter, and the capacity-breakpoint / saturation
  derivations. `latency_p75/p90/p999/min/max` are **not** persisted per tick.
- **Final-summary rows** (`latency_p50/p75/p90/p95/p99/p999/min/max`, `labels` =
  `{"percentile":"p50"}` etc.): written once at completion from the cumulative-from-start
  HdrHistogram - the whole-run numbers the report surfaces. The `/runs/:id/report` reader
  keys on the non-empty label so the per-tick windowed rows never overwrite these.

---

### `results`

Individual request outcomes - all errors plus sampled successes (sampling is configurable in
`MetricsCollector`). Struct is `db::Result`.

| Column        | Type       | Notes                                                        |
|---------------|------------|--------------------------------------------------------------|
| `id`          | INTEGER PK | Autoincrement                                                |
| `run_id`      | TEXT       | FK → `runs.id`                                               |
| `timestamp`   | INTEGER    | Unix ms                                                      |
| `status_code` | INTEGER    | HTTP status, or **0 for transport errors** (so totals reconcile) |
| `status_text` | TEXT       | Wire reason phrase or canonical IANA text                    |
| `latency_ms`  | REAL       | **Perceived** latency (`completion − submitted_at`), not wire time |
| `error`       | TEXT       | Error message for failures; empty on success                 |
| `trace_data`  | TEXT       | JSON (headers/body/timing breakdown) - design mode + errors + slow samples |

`trace_data` timing keys are all in ms and carry the `Ms` suffix: `totalMs`, `wireMs`,
`queueWaitMs`, `dnsMs`, `connectMs`, `tlsMs`, `firstByteMs`, `downloadMs`. `totalMs` is perceived
latency; `wireMs` is libcurl's `CURLINFO_TOTAL_TIME`; `queueWaitMs = totalMs − wireMs` is time
spent queued inside the generator.

**The writers store different subsets, at different nesting**, so read the one you need rather
than assuming all eight are there and flat:

| Writer | What lands in `trace_data` |
|--------|----------------------------|
| Load run, success sample (`load_strategy.cpp`) | timing only, flat, all eight keys - and only when `save_timing_breakdown` is on or the sample crossed `slow_threshold_ms` (which also adds `isSlow` / `thresholdMs`) |
| Load run, error (`load_strategy.cpp`) | an error envelope (`error_type`, `message`, `request_number`) with the eight keys **nested under `timing`**, present whenever `totalMs > 0` |
| Design mode (`store_result` in `execution.cpp`) | all eight keys flat, unconditionally - the same set the live `/execute` response carries, so a restored response shows exactly what the live one did (a skipped phase is stored as `0`). Written on **every** single request, alongside a nested `request` object plus either `response` (success) or `error_type` / `error_message` (failure). Rows written by older engines omitted zero-valued phases and all of `totalMs`/`wireMs`/`queueWaitMs`, so readers must default missing keys (perceived total also lives in the `latency_ms` column). |

That design-mode subset is what rebuilds the request builder's response pane (Timing tab included)
after a restart - see `app/src/modules/request-builder/utils/restore-response.ts`.

A design run has exactly one `results` row. `GET /runs/:runId` serves it (as `result`)
alongside the run itself, in addition to `GET /runs/:runId/report`'s `results` array - the
same row, read by two routes for two different callers.

---

### `config_entries`

Engine configuration registry - each tunable setting with UI metadata. Read by `GET /config`,
written by `POST /config`. Struct is `db::ConfigEntry`.

| Column          | Type    | Notes                                                  |
|-----------------|---------|--------------------------------------------------------|
| `key`           | TEXT PK | e.g. `workers`, `maxConnections`, `liveTickIntervalMs` |
| `value`         | TEXT    | Current value (parsed per `type`)                      |
| `type`          | TEXT    | `"integer"` / `"string"` / `"boolean"` / `"number"`    |
| `label`         | TEXT    | Display label                                          |
| `description`   | TEXT    | Help text                                              |
| `category`      | TEXT    | Grouping (e.g. `server`, `network_performance`)        |
| `default_value` | TEXT    | Default as string                                      |
| `min_value`     | TEXT    | Optional minimum (numbers)                             |
| `max_value`     | TEXT    | Optional maximum (numbers)                             |
| `updated_at`    | INTEGER | Unix ms                                                |

---

## Indexes

Declared alongside the tables in `make_storage()` (`engine/src/db/database.cpp`). `sqlite_orm`
requires index arguments to precede the table arguments. `sync_schema()` creates them on startup
for fresh **and** pre-existing databases, so adding an index is additive and needs no migration.

| Index                        | Column                  | Query paths that rely on it                                                                                                                       |
|------------------------------|-------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------|
| `idx_metrics_run_id`         | `metrics.run_id`        | `get_metrics`, `get_metrics_since` (polled every 500ms by the legacy SSE loop in `http/routes/metrics.cpp`), `get_metrics_paginated`, `count_metrics`, and the `remove_all` in `delete_run` |
| `idx_results_run_id`         | `results.run_id`        | `get_results` and the `remove_all` in `delete_run`                                                                                                |
| `idx_requests_collection_id` | `requests.collection_id`| `get_requests_in_collection` (every sidebar load) and cascade delete                                                                              |
| `idx_collections_parent_id`  | `collections.parent_id` | The cascade-delete BFS in `Database::delete_collection`, which does one lookup per node in the subtree                                            |
| `idx_runs_start_time`        | `runs.start_time`       | `get_all_runs` and `get_runs_paginated`, which sort `start_time DESC` on every `GET /runs`                                                        |
| `idx_runs_request_id`        | `runs.request_id`       | `GET /runs?requestId=` and `useLastDesignRunQuery`'s single-run lookup (`get_runs_paginated` with a `request_id` filter)                          |

`metrics` and `results` are the unbounded-growth tables - a load run writes roughly 20 metric
rows per second - so without `run_id` indexes a lookup slows down with every run ever recorded,
not just the current one. `collections.parent_id` is a nullable column; `sqlite_orm` indexes it
without special handling.

Guarded by `DatabaseTest.CreatesIndexesOnFreshDatabase` and
`DatabaseTest.RecreatesIndexesOnExistingDatabase` in `engine/tests/db_test.cpp`, which read
`sqlite_master` directly rather than trusting what `sqlite_orm` reports about itself.

---

## VariableValue shape

Used in `collections.variables`, `environments.variables`, and `globals.variables`:

```json
{
  "value": "https://api.example.com",
  "enabled": true,
  "secret": false,
  "type": "string"
}
```

`secret` is a UI masking hint only - values are not encrypted at rest. `type` is a UI/script
conversion hint, one of `"string"` (default), `"number"`, `"boolean"`, `"json"` - it controls
how scripts read the variable via `pm.*.get(...)`.
