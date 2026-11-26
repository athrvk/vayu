---
description: >-
  The tables that hold environments and the global variables.
---

# Environments and globals

## `environments`

Stores named variable sets.

| Column       | Type    | Notes                                 |
|--------------|---------|---------------------------------------|
| `id`         | TEXT PK | `env_` + UUID                         |
| `name`       | TEXT    |                                       |
| `description`| TEXT    | Default `""`                          |
| `variables`  | TEXT    | JSON: `Record<string, VariableValue>` |
| `is_active`  | INTEGER | Boolean; 0 or 1. At most one row is 1 - see below |
| `created_at` | INTEGER | Unix ms                               |
| `updated_at` | INTEGER | Unix ms                               |
| `deleted_at` | INTEGER | Nullable, Unix ms. NULL while live; the delete's instant once it is in the trash (#2970) |

**`is_active` marks the environment clients resolve against by default, and at most one row carries it.**
The invariant is enforced in the DB layer, not the routes: every write path that can store an active environment calls `Database::deactivate_other_environments_locked` first, inside the same transaction, so activating one environment deactivates the previous one atomically - no reader can observe two actives, and none can observe an intermediate zero.
Three paths reach this table (`POST /environments`, `PUT /environments/:id`, and `POST /import/apply`); putting the rule in the handlers would mean repeating it in each, and a rule repeated in each handler ends up honoured on create but not on update.

**A trashed row is never active.**
`DELETE /environments/:id` stamps `deleted_at` and clears `is_active` in one write, and a restore clears the stamp alone, so the row comes back inactive.
Every read (`get_environments`, `get_environment`) filters `deleted_at IS NULL`, and so does `deactivate_other_environments_locked`: the rule above is about live rows, and a stamped one already holds `0`.
An environment owns no rows, so unlike [`collections`](collections-and-requests.md#collections) its stamp is no cohort key; it is always its own trash root, and a purge (`DELETE /trash/:id`, or retention) removes the row.

Writing `isActive: true` **is** the switch - there is no separate endpoint and no companion request to clear the old one.
Clearing entirely is spelled as writing `isActive: false` to the environment that holds the flag, since there is no "no environment" row to write `true` to.

Selecting is still a client action: the engine never *applies* an active environment to a request, which must always name its own `environmentId`.
What changed is where the choice lives.
Storing it here rather than in client-local state is what makes it survive a restart and a reinstall, and what lets two clients on the same database agree - the app mirrors it into `session-store.ts` for synchronous reads and reconciles on launch (`useActiveEnvironmentRestore`), treating the engine's value as the truth.

**Cap.**
(issue #1485) `variables` is refused at write time with a `413` naming the field, its size and the cap, when the serialized value is over `json::MAX_FIELD_SIZE` (10 MiB, `engine/include/vayu/core/constants.hpp`) - the same `apply_json_field` guard the [`requests`](collections-and-requests.md#requests) and [`collections`](collections-and-requests.md#collections) columns share.

---

## `globals`

Singleton table; always has exactly one row with `id = "globals"`.

| Column       | Type    | Notes                                 |
|--------------|---------|---------------------------------------|
| `id`         | TEXT PK | Always `"globals"`                    |
| `variables`  | TEXT    | JSON: `Record<string, VariableValue>` |
| `updated_at` | INTEGER | Unix ms                               |
