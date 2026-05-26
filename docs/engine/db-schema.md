# Engine Database Schema

Vayu uses SQLite via `sqlite_orm`. The schema is defined in `engine/src/db/database.cpp` and the
struct definitions live in `engine/include/vayu/types.hpp`. `sync_schema()` adds new columns
automatically on startup — no migration scripts are needed for additive changes.

> **Breaking changes**: because Vayu is pre-release, destructive schema changes (column removal,
> type changes) wipe the database rather than migrating it. The `PRAGMA user_version` is
> not currently managed; wipe is done by deleting the `.db` file.

---

## Tables

### `collections`

Stores folder/group hierarchy for requests.

| Column               | Type    | Notes                                        |
|----------------------|---------|----------------------------------------------|
| `id`                 | TEXT PK | UUID                                         |
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
`{"mode":"basic","username":"...","password":"..."}` | `{"mode":"apikey","key":"...","value":"...","in":"header"|"query"}`.
Collections are always auth sources — they never store `{"mode":"inherit"}`.

**Cascade delete**: deleting a collection performs BFS to collect all descendant IDs, then
deletes all their requests before deleting the collections deepest-first. See `Database::delete_collection()`.

---

### `requests`

Stores individual HTTP request definitions.

| Column                | Type    | Notes                                                |
|-----------------------|---------|------------------------------------------------------|
| `id`                  | TEXT PK | UUID                                                 |
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
| `created_at`          | INTEGER | Unix ms                                              |
| `updated_at`          | INTEGER | Unix ms                                              |

**params / headers** — stored as a JSON array of objects:
```json
[{"key":"Content-Type","value":"application/json","enabled":true,"description":""}]
```
Disabled rows (`"enabled":false`) are preserved in storage and filtered at HTTP-execution time only.
Duplicate keys are allowed.

**body** — discriminated union:
```json
{"mode":"none"}
{"mode":"json"|"text"|"graphql","content":"..."}
{"mode":"form-data"|"x-www-form-urlencoded","fields":[{"key":"...","value":"...","enabled":true}]}
```

**auth** — discriminated union (same shape as collection auth, plus `inherit`):
```json
{"mode":"none"}
{"mode":"inherit"}                                        // resolved at execution time
{"mode":"bearer","token":"..."}
{"mode":"basic","username":"...","password":"..."}
{"mode":"apikey","key":"...","value":"...","in":"header"|"query"}
```

---

### `environments`

Stores named variable sets.

| Column       | Type    | Notes                                 |
|--------------|---------|---------------------------------------|
| `id`         | TEXT PK | UUID                                  |
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

Stores load-test and sanity-check run records.

See `engine/include/vayu/types.hpp` (`db::Run`) for the full column list. Key fields:

| Column       | Type    | Notes                                    |
|--------------|---------|------------------------------------------|
| `id`         | TEXT PK | UUID                                     |
| `request_id` | TEXT    | FK → `requests.id` (optional)            |
| `type`       | TEXT    | `"load"` or `"sanity"`                   |
| `status`     | TEXT    | `"running"` / `"completed"` / `"failed"` |
| `config`     | TEXT    | JSON snapshot of the run config          |
| `summary`    | TEXT    | JSON aggregate metrics                   |
| `created_at` | INTEGER | Unix ms                                  |
| `updated_at` | INTEGER | Unix ms                                  |

---

## VariableValue shape

Used in `collections.variables`, `environments.variables`, and `globals.variables`:

```json
{
  "value": "https://api.example.com",
  "enabled": true,
  "secret": false
}
```

`secret` is a UI masking hint only — values are not encrypted at rest.
